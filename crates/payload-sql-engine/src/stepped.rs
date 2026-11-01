//! Statement-granular execution of engine calls.
//!
//! The TS drizzle methods `await` every statement. With the `libsql` binding a statement runs
//! synchronously when it is issued and its promise is already settled, so concurrent operations
//! interleave statement by statement in microtask order (under `Promise.all`, round-robin). A
//! [`SteppedCall`] reproduces that: the method runs on its own thread and stops after every
//! statement (a *yield*); the driver (the JS thread, see `crates/payload-node/src/engine.rs`)
//! resumes it from a microtask, so the statements of concurrent calls run in the order the
//! awaits of the TS methods would issue them.
//!
//! While a step runs, the driver is blocked in [`SteppedCall::resume`] (only host function calls
//! of the method are served on the driver's thread meanwhile) and the method holds a *lend* of
//! the connection: a job on the `payload-sqlite` queue of the call's `ConnId` that serves the
//! method's find statements on the worker and keeps every other job of that database file
//! waiting. Write-path statements (payload-sql-upsert) run on the method's thread through a
//! non-owning `rusqlite::Connection` of the same SQLite handle, only while the lend is held, so
//! the handle is never used by two threads at once. The lend is released at every yield and
//! taken again (queued in call order) when the method is resumed.
//!
//! Yield points: after every statement the engine runs itself (find statements and the
//! query-crate selects), and before a read the write path makes through a host callback when the
//! write executor ran statements since the last yield. Statements payload-sql-upsert runs back to
//! back without calling the host (e.g. the `update` and the array `insert`s of one `upsertRow`)
//! run in one step: the upsert executor has no per-statement hook (ENGINE_CONTRACT.md).

use std::cell::{Cell as StdCell, RefCell};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};

use payload_engine::error::{EngineError, Result};
use payload_engine::host::Host;
use payload_engine::js::JsVal;
use payload_sql_find::exec::{Executor, LibsqlConn};
use payload_sql_find::sql::Sql;
use payload_sqlite::rusqlite::Connection;
use payload_sqlite::worker::{self, ConnId};
use payload_sqlite::{Cell, ClientError, IntMode};
use serde_json::Value as Json;

use crate::SqliteEngine;

/// Where the method stands after [`SteppedCall::resume`].
#[derive(Debug)]
pub enum Step {
  /// Stopped after a statement; resume it again (from a later microtask).
  Yielded,
  /// Finished: the tree-encoded result JSON (as `SqliteEngine::call_json`) or the error.
  Done(std::result::Result<String, EngineError>),
}

enum FromOp {
  Yielded,
  HostCall(u32, Json),
  Done(std::result::Result<String, EngineError>),
}

enum ToOp {
  Resume,
  HostResult(Result<JsVal>),
}

/// One engine call running statement by statement. Created by [`SteppedCall::start`]; the method
/// does not run until the first [`SteppedCall::resume`].
pub struct SteppedCall {
  to_op: Sender<ToOp>,
  from_op: Receiver<FromOp>,
  done: StdCell<bool>,
}

impl SteppedCall {
  /// Starts the method's thread (parked until the first resume).
  pub fn start(
    engine: Arc<SqliteEngine>,
    method: String,
    args_json: String,
    context_json: Option<String>,
    conn_id: ConnId,
  ) -> Result<Self> {
    let (to_op, op_inbox) = mpsc::channel::<ToOp>();
    let (op_outbox, from_op) = mpsc::channel::<FromOp>();
    std::thread::Builder::new()
      .name("payload-sql-engine-call".into())
      .stack_size(16 * 1024 * 1024)
      .spawn(move || {
        // parked until the driver resumes the call the first time
        if !matches!(op_inbox.recv(), Ok(ToOp::Resume)) {
          return;
        }
        let scheduler = OpScheduler {
          conn_id,
          outbox: op_outbox.clone(),
          inbox: op_inbox,
          lend: RefCell::new(None),
          handle: StdCell::new(0),
          upsert_statements: StdCell::new(0),
          abort: RefCell::new(None),
        };
        let result = run_method(&engine, &scheduler, &method, &args_json, context_json.as_deref());
        // the final step's lend and the engine reference end before the driver sees the result
        // (`setLiveSchema` needs the only reference)
        scheduler.lend.borrow_mut().take();
        drop(engine);
        let _ = op_outbox.send(FromOp::Done(result));
      })
      .map_err(|e| EngineError::internal(format!("could not start an engine call thread: {e}")))?;
    Ok(Self { to_op, from_op, done: StdCell::new(false) })
  }

  /// Runs the method until its next yield point or until it finishes, blocking the caller.
  /// Host functions the method calls meanwhile run on the caller's thread through `host`.
  pub fn resume(&self, host: &dyn Host) -> Step {
    if self.done.get() {
      return Step::Done(Err(EngineError::internal("engine call resumed after it finished")));
    }
    let finished = |result| {
      self.done.set(true);
      Step::Done(result)
    };
    if self.to_op.send(ToOp::Resume).is_err() {
      return finished(Err(EngineError::internal("engine call thread exited")));
    }
    loop {
      match self.from_op.recv() {
        Ok(FromOp::Yielded) => return Step::Yielded,
        Ok(FromOp::Done(result)) => return finished(result),
        Ok(FromOp::HostCall(id, arg)) => {
          let result = host.call(id, &arg);
          if self.to_op.send(ToOp::HostResult(result)).is_err() {
            return finished(Err(EngineError::internal("engine call thread exited")));
          }
        }
        Err(_) => return finished(Err(EngineError::internal("engine call thread exited"))),
      }
    }
  }
}

/// The write path's per-call hooks into the scheduling (no-ops for single-job calls).
pub(crate) trait Steps {
  /// After a statement the engine ran on the write executor itself (`select_rows`); `executed`
  /// is the executor's statement count afterwards.
  fn after_write_statement(&self, executed: usize);
  /// Before a read made through a write-path host callback: yields when the write executor ran
  /// statements (`executed` so far) since the last yield.
  fn before_read(&self, executed: usize);
}

/// Single-job calls (`SqliteEngine::call_json`): the method runs atomically.
pub(crate) struct NoSteps;

impl Steps for NoSteps {
  fn after_write_statement(&self, _executed: usize) {}
  fn before_read(&self, _executed: usize) {}
}

/// Unwind payload that ends a method whose connection went away between two steps (the call
/// then fails with the stored error). Raised with `resume_unwind`, so no panic hook runs.
struct AbortCall;

/// The method thread's side of the protocol.
pub(crate) struct OpScheduler {
  conn_id: ConnId,
  outbox: Sender<FromOp>,
  inbox: Receiver<ToOp>,
  lend: RefCell<Option<Lend>>,
  /// The SQLite handle the method's write connection wraps.
  handle: StdCell<usize>,
  /// Write executor statements already followed by a yield.
  upsert_statements: StdCell<usize>,
  abort: RefCell<Option<EngineError>>,
}

impl OpScheduler {
  /// Takes the lend (in queue order) and returns the connection's SQLite handle.
  fn acquire(&self) -> std::result::Result<usize, ClientError> {
    let (lend, handle) = Lend::acquire(self.conn_id)?;
    *self.lend.borrow_mut() = Some(lend);
    Ok(handle)
  }

  /// Ends the step: releases the lend, reports the yield and waits to be resumed, then takes the
  /// lend again. A connection that is gone or was replaced (a transaction took the client's
  /// connection meanwhile) ends the method with the connection error.
  fn yield_now(&self) {
    self.lend.borrow_mut().take();
    let resumed = self.outbox.send(FromOp::Yielded).is_ok() && matches!(self.inbox.recv(), Ok(ToOp::Resume));
    if !resumed {
      self.fail(EngineError::internal("engine call driver went away"));
    }
    match self.acquire() {
      Ok(handle) if handle == self.handle.get() => {}
      Ok(_) => self.fail(crate::client_error(&ClientError::Error {
        message: "payload-sql-engine: the client's connection changed while the call was in progress (a transaction took it)"
          .to_string(),
        code: None,
      })),
      Err(error) => self.fail(crate::client_error(&error)),
    }
  }

  fn fail(&self, error: EngineError) -> ! {
    self.lend.borrow_mut().take();
    *self.abort.borrow_mut() = Some(error);
    std::panic::resume_unwind(Box::new(AbortCall))
  }

  fn lend_query(&self, sql: &Sql) -> std::result::Result<Vec<Vec<Cell>>, ClientError> {
    let lend = self.lend.borrow();
    let lend = lend.as_ref().ok_or_else(ClientError::connection_not_open)?;
    lend.query(sql)
  }
}

impl Steps for OpScheduler {
  fn after_write_statement(&self, executed: usize) {
    self.upsert_statements.set(executed);
    self.yield_now();
  }

  fn before_read(&self, executed: usize) {
    if executed > self.upsert_statements.get() {
      self.upsert_statements.set(executed);
      self.yield_now();
    }
  }
}

/// Find statements of a stepped call: run on the worker through the lend
/// (`tx.execute` / `client.execute` semantics), then yield.
pub(crate) struct SteppedFind<'a> {
  pub scheduler: &'a OpScheduler,
}

impl Executor for SteppedFind<'_> {
  fn query_cells(&self, sql: &Sql) -> std::result::Result<Vec<Vec<Cell>>, ClientError> {
    let result = self.scheduler.lend_query(sql);
    self.scheduler.yield_now();
    result
  }
}

/// Host function calls of a stepped call: served by the driver's thread.
pub(crate) struct SteppedHost<'a> {
  pub scheduler: &'a OpScheduler,
}

impl Host for SteppedHost<'_> {
  fn call(&self, id: u32, arg: &Json) -> Result<JsVal> {
    let s = self.scheduler;
    if s.outbox.send(FromOp::HostCall(id, arg.clone())).is_err() {
      s.fail(EngineError::internal("engine call driver went away"));
    }
    match s.inbox.recv() {
      Ok(ToOp::HostResult(result)) => result,
      _ => s.fail(EngineError::internal("engine call driver went away")),
    }
  }
}

fn run_method(
  engine: &SqliteEngine,
  scheduler: &OpScheduler,
  method: &str,
  args_json: &str,
  context_json: Option<&str>,
) -> std::result::Result<String, EngineError> {
  let (args, options) = engine.decode_call(args_json, context_json)?;
  let handle = scheduler.acquire().map_err(|e| crate::client_error(&e))?;
  scheduler.handle.set(handle);
  // SAFETY: the handle belongs to a connection of the call's queue that stays open while the
  // lend is held; the wrapper does not own it (never closes it), is only used on this thread
  // while the lend is held (every yield re-checks that the session still has this handle) and
  // has no cached statements to finalize when dropped.
  let raw = match unsafe { Connection::from_handle(handle as *mut payload_sqlite::rusqlite::ffi::sqlite3) } {
    Ok(raw) => raw,
    Err(e) => return Err(EngineError::internal(format!("could not wrap the connection: {e}"))),
  };
  let find = SteppedFind { scheduler };
  let host = SteppedHost { scheduler };
  let run = std::panic::AssertUnwindSafe(|| {
    let env = crate::CallEnv { conn: &find, raw: &raw, host: &host, steps: scheduler };
    engine.call_in(method, &args, &options, &env)
  });
  let outcome = std::panic::catch_unwind(run);
  let result = match outcome {
    Ok(result) => result.and_then(|out| engine.encode_result(out, context_json)),
    Err(payload) if payload.is::<AbortCall>() => {
      Err(scheduler.abort.borrow_mut().take().unwrap_or_else(|| EngineError::internal("engine call aborted")))
    }
    Err(payload) => Err(crate::panic_error(method, payload)),
  };
  // dropped while the final step's lend is still held
  drop(raw);
  result
}

// ---------------------------------------------------------------------------
// lend

enum LendRequest {
  Query { sql: Sql, reply: SyncSender<std::result::Result<Vec<Vec<Cell>>, ClientError>> },
}

/// A job on the call's queue that serves the method's find statements on the worker until it is
/// dropped (the job then returns and the queue moves on).
struct Lend {
  requests: Sender<LendRequest>,
}

impl Lend {
  fn acquire(conn_id: ConnId) -> std::result::Result<(Self, usize), ClientError> {
    let (ready_tx, ready_rx) = mpsc::sync_channel::<std::result::Result<usize, ClientError>>(1);
    let (requests, inbox) = mpsc::channel::<LendRequest>();
    worker::submit(conn_id, move |session| {
      // SAFETY: only the address is read here.
      let handle = session.conn().and_then(|conn| conn.connection().map(|raw| unsafe { raw.handle() } as usize));
      let is_open = handle.is_ok();
      if ready_tx.send(handle).is_err() || !is_open {
        return;
      }
      while let Ok(request) = inbox.recv() {
        match request {
          LendRequest::Query { sql, reply } => {
            let result = LibsqlConn::from_session(session, IntMode::Number).and_then(|conn| conn.query_cells(&sql));
            let _ = reply.send(result);
          }
        }
      }
    })?;
    let handle = ready_rx.recv().map_err(|_| ClientError::connection_not_open())??;
    Ok((Self { requests }, handle))
  }

  fn query(&self, sql: &Sql) -> std::result::Result<Vec<Vec<Cell>>, ClientError> {
    let (reply, result) = mpsc::sync_channel(1);
    self.requests.send(LendRequest::Query { sql: sql.clone(), reply }).map_err(|_| ClientError::connection_not_open())?;
    result.recv().map_err(|_| ClientError::connection_not_open())?
  }
}
