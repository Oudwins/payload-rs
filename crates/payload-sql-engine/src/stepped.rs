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
//! Every statement, of the find path (payload-sql-find) and of the write path
//! (payload-sql-upsert's executor) alike, is its own job on the `payload-sqlite` queue of the
//! call's `ConnId` ([`worker::call`]), queued when the method reaches it and waited for. Like
//! `client.execute` / `tx.execute`, the job works on the connection the id addresses at that
//! moment: a client's `#getDb()` (re-opened after a transaction took the previous one) or the
//! transaction's connection. Nothing is held between statements, so a JS function the method
//! calls (custom column `fromDriver`, run on the driver's thread while the step waits) can use
//! the clients synchronously, and can start other engine calls.
//!
//! While a step runs, the driver is blocked in [`SteppedCall::resume`]; it serves host function
//! calls of the method meanwhile. A yield follows every statement (also a failed one: its
//! promise rejects), so every `await` of a statement in the TS method is a step boundary.
//!
//! Method threads are pooled (an idle thread is reused by the next call). If no thread can be
//! started, the call runs on the driver's thread on its first resume without yielding, as does a
//! call started with [`SteppedCall::start_atomic`].

use std::cell::{Cell as StdCell, RefCell};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use payload_engine::error::{EngineError, Result};
use payload_engine::host::Host;
use payload_engine::js::JsVal;
use payload_sql_find::exec::{Executor as FindExecutor, QueuedConn};
use payload_sql_find::sql::Sql;
use payload_sql_upsert::sql::{ExecError, ExecResult, RawRows, SqlFragment, Statements};
use payload_sqlite::worker::{self, ConnId, Session};
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

/// What one call runs.
struct Request {
  engine: Arc<SqliteEngine>,
  method: String,
  args_json: String,
  context_json: Option<String>,
  conn_id: ConnId,
}

/// One engine call running statement by statement. Created by [`SteppedCall::start`]; the method
/// does not run until the first [`SteppedCall::resume`].
pub struct SteppedCall {
  state: State,
}

enum State {
  /// On a method thread, stepped through the channels.
  Threaded { to_op: Sender<ToOp>, from_op: Receiver<FromOp>, done: StdCell<bool> },
  /// Runs to completion on the driver's thread on the first resume.
  Inline(RefCell<Option<Request>>),
}

impl SteppedCall {
  /// Starts the method's thread (parked until the first resume). When no thread can be started
  /// the call runs atomically on the driver's thread instead.
  pub fn start(
    engine: Arc<SqliteEngine>,
    method: String,
    args_json: String,
    context_json: Option<String>,
    conn_id: ConnId,
  ) -> Self {
    let request = Arc::new(Mutex::new(Some(Request { engine, method, args_json, context_json, conn_id })));
    let (to_op, op_inbox) = mpsc::channel::<ToOp>();
    let (op_outbox, from_op) = mpsc::channel::<FromOp>();
    let task_request = Arc::clone(&request);
    let task = Box::new(move || {
      let Some(request) = lock(&task_request).take() else { return };
      drop(task_request);
      run_threaded(request, op_inbox, op_outbox);
    });
    if pool::run(task).is_ok() {
      return Self { state: State::Threaded { to_op, from_op, done: StdCell::new(false) } };
    }
    Self { state: State::Inline(RefCell::new(lock(&request).take())) }
  }

  /// A call that runs as a whole on the driver's thread on its first resume (no yields).
  pub fn start_atomic(
    engine: Arc<SqliteEngine>,
    method: String,
    args_json: String,
    context_json: Option<String>,
    conn_id: ConnId,
  ) -> Self {
    let request = Request { engine, method, args_json, context_json, conn_id };
    Self { state: State::Inline(RefCell::new(Some(request))) }
  }

  /// Runs the method until its next yield point or until it finishes, blocking the caller.
  /// Host functions the method calls meanwhile run on the caller's thread through `host`.
  pub fn resume(&self, host: &dyn Host) -> Step {
    match &self.state {
      State::Inline(request) => {
        let Some(request) = request.borrow_mut().take() else {
          return Step::Done(Err(EngineError::internal("engine call resumed after it finished")));
        };
        Step::Done(run_method(request, &InlineDriver { host }))
      }
      State::Threaded { to_op, from_op, done } => {
        if done.get() {
          return Step::Done(Err(EngineError::internal("engine call resumed after it finished")));
        }
        let finished = |result| {
          done.set(true);
          Step::Done(result)
        };
        if to_op.send(ToOp::Resume).is_err() {
          return finished(Err(EngineError::internal("engine call thread exited")));
        }
        loop {
          match from_op.recv() {
            Ok(FromOp::Yielded) => return Step::Yielded,
            Ok(FromOp::Done(result)) => return finished(result),
            Ok(FromOp::HostCall(id, arg)) => {
              let result = host.call(id, &arg);
              if to_op.send(ToOp::HostResult(result)).is_err() {
                return finished(Err(EngineError::internal("engine call thread exited")));
              }
            }
            Err(_) => return finished(Err(EngineError::internal("engine call thread exited"))),
          }
        }
      }
    }
  }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
  m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The method's side of the scheduling: where steps end and JS functions run.
trait Driver {
  /// Ends the step after a statement (waits to be resumed); a no-op for atomic calls.
  fn end_step(&self);
  fn host(&self) -> &dyn Host;
  /// The error a call aborted with [`AbortCall`] fails with.
  fn abort_error(&self) -> EngineError;
}

/// Atomic calls on the driver's thread.
struct InlineDriver<'h> {
  host: &'h dyn Host,
}

impl Driver for InlineDriver<'_> {
  fn end_step(&self) {}

  fn host(&self) -> &dyn Host {
    self.host
  }

  fn abort_error(&self) -> EngineError {
    EngineError::internal("engine call aborted")
  }
}

/// Unwind payload that ends a method whose driver went away between two steps (the call then
/// fails with the stored error). Raised with `resume_unwind`, so no panic hook runs.
struct AbortCall;

/// A method thread's side of the protocol.
struct ThreadDriver {
  outbox: Sender<FromOp>,
  inbox: Receiver<ToOp>,
  abort: RefCell<Option<EngineError>>,
}

impl ThreadDriver {
  fn fail(&self, error: EngineError) -> ! {
    *self.abort.borrow_mut() = Some(error);
    std::panic::resume_unwind(Box::new(AbortCall))
  }
}

impl Driver for ThreadDriver {
  fn end_step(&self) {
    let resumed = self.outbox.send(FromOp::Yielded).is_ok() && matches!(self.inbox.recv(), Ok(ToOp::Resume));
    if !resumed {
      self.fail(EngineError::internal("engine call driver went away"));
    }
  }

  fn host(&self) -> &dyn Host {
    self
  }

  fn abort_error(&self) -> EngineError {
    self.abort.borrow_mut().take().unwrap_or_else(|| EngineError::internal("engine call aborted"))
  }
}

/// Host function calls of a threaded call: served by the driver's thread.
impl Host for ThreadDriver {
  fn call(&self, id: u32, arg: &Json) -> Result<JsVal> {
    if self.outbox.send(FromOp::HostCall(id, arg.clone())).is_err() {
      self.fail(EngineError::internal("engine call driver went away"));
    }
    match self.inbox.recv() {
      Ok(ToOp::HostResult(result)) => result,
      _ => self.fail(EngineError::internal("engine call driver went away")),
    }
  }
}

fn run_threaded(request: Request, inbox: Receiver<ToOp>, outbox: Sender<FromOp>) {
  // parked until the driver resumes the call the first time
  if !matches!(inbox.recv(), Ok(ToOp::Resume)) {
    return;
  }
  let driver = ThreadDriver { outbox: outbox.clone(), inbox, abort: RefCell::new(None) };
  let result = run_method(request, &driver);
  let _ = outbox.send(FromOp::Done(result));
}

/// Runs the method; the engine reference ends before the result is returned (`setLiveSchema`
/// needs the only reference once every call settled).
fn run_method(request: Request, driver: &dyn Driver) -> std::result::Result<String, EngineError> {
  let Request { engine, method, args_json, context_json, conn_id } = request;
  let run = std::panic::AssertUnwindSafe(|| {
    let (args, options) = engine.decode_call(&args_json, context_json.as_deref())?;
    let find = QueuedFind { conn_id, driver };
    let write = QueuedWrite { conn_id, driver };
    let env = crate::CallEnv { conn: &find, statements: &write, host: driver.host() };
    let output = engine.call_in(&method, &args, &options, &env)?;
    engine.encode_result(output, context_json.as_deref())
  });
  let result = match std::panic::catch_unwind(run) {
    Ok(result) => result,
    Err(payload) if payload.is::<AbortCall>() => Err(driver.abort_error()),
    Err(payload) => Err(crate::panic_error(&method, payload)),
  };
  drop(engine);
  result
}

/// Find statements: each one a `client.execute` / `tx.execute` job on the call's queue, then the
/// end of the step.
struct QueuedFind<'d> {
  conn_id: ConnId,
  driver: &'d dyn Driver,
}

impl FindExecutor for QueuedFind<'_> {
  fn query_cells(&self, sql: &Sql) -> std::result::Result<Vec<Vec<Cell>>, ClientError> {
    let result = QueuedConn { id: self.conn_id, int_mode: IntMode::Number }.query_cells(sql);
    self.driver.end_step();
    result
  }
}

/// Write-path statements: each one a job on the call's queue, on the connection the id
/// addresses when it runs, then the end of the step.
struct QueuedWrite<'d> {
  conn_id: ConnId,
  driver: &'d dyn Driver,
}

impl Statements for QueuedWrite<'_> {
  fn run(&self, q: &SqlFragment) -> ExecResult<RawRows> {
    let statement = q.clone();
    let result = worker::call(self.conn_id, move |session| run_write_statement(session, &statement))
      .map_err(|e| ExecError::Engine(statement_client_error(q, &e)))
      .and_then(|r| r);
    self.driver.end_step();
    result
  }
}

/// A write-path statement on the connection `session` addresses (`tx.execute` first checks that
/// the transaction is still open).
pub(crate) fn run_write_statement(session: &mut Session<'_>, q: &SqlFragment) -> ExecResult<RawRows> {
  let in_transaction = session.is_transaction();
  let conn = session.conn().map_err(|e| ExecError::Engine(statement_client_error(q, &e)))?;
  if in_transaction {
    payload_sqlite::client::check_transaction_open(conn).map_err(|e| ExecError::Engine(statement_client_error(q, &e)))?;
  }
  let raw = conn.connection().map_err(|e| ExecError::Engine(statement_client_error(q, &e)))?;
  payload_sql_upsert::sql::run_statement(raw, q)
}

/// A client error of a write-path statement (closed connection or transaction): drizzle wraps it
/// in a `DrizzleQueryError` like any other driver error.
fn statement_client_error(q: &SqlFragment, error: &ClientError) -> EngineError {
  let params = q.params.iter().map(payload_engine::js::encode_value).collect::<Vec<_>>();
  payload_sql_find::exec::drizzle_query_error(&Sql { sql: q.sql.clone(), params }, error)
}

/// Reusable method threads.
mod pool {
  use std::sync::Mutex;
  use std::sync::atomic::{AtomicU64, Ordering};
  use std::sync::mpsc::{self, RecvTimeoutError, Sender};
  use std::time::Duration;

  pub(super) type Task = Box<dyn FnOnce() + Send>;

  /// Deep `where` trees and documents recurse deeply.
  const STACK_SIZE: usize = 16 * 1024 * 1024;
  /// How long an idle thread waits for the next call.
  const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
  /// Idle threads kept at most.
  const MAX_IDLE: usize = 64;

  static IDLE: Mutex<Vec<(u64, Sender<Task>)>> = Mutex::new(Vec::new());
  static NEXT_ID: AtomicU64 = AtomicU64::new(1);

  fn idle() -> std::sync::MutexGuard<'static, Vec<(u64, Sender<Task>)>> {
    IDLE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
  }

  /// Runs `task` on an idle pool thread or a new one; `Err` when no thread could be started.
  pub(super) fn run(mut task: Task) -> std::result::Result<(), ()> {
    loop {
      let Some((_, thread)) = idle().pop() else { break };
      match thread.send(task) {
        Ok(()) => return Ok(()),
        Err(mpsc::SendError(back)) => task = back,
      }
    }
    std::thread::Builder::new()
      .name("payload-sql-engine-call".into())
      .stack_size(STACK_SIZE)
      .spawn(move || serve(task))
      .map(|_| ())
      .map_err(|_| ())
  }

  fn serve(first: Task) {
    let mut task = first;
    loop {
      let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(task));
      let (sender, inbox) = mpsc::channel::<Task>();
      let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
      {
        let mut idle = idle();
        if idle.len() >= MAX_IDLE {
          return;
        }
        idle.push((id, sender));
      }
      task = match inbox.recv_timeout(IDLE_TIMEOUT) {
        Ok(next) => next,
        Err(RecvTimeoutError::Disconnected) => return,
        Err(RecvTimeoutError::Timeout) => {
          let mut idle = idle();
          match idle.iter().position(|(other, _)| *other == id) {
            Some(index) => {
              idle.remove(index);
              return;
            }
            // taken by a caller meanwhile: its task is on the way
            None => {
              drop(idle);
              match inbox.recv() {
                Ok(next) => next,
                Err(_) => return,
              }
            }
          }
        }
      };
    }
  }
}
