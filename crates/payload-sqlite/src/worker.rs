//! Connection registry and ordered execution queues.
//!
//! The `libsql` binding runs every statement synchronously on the JS thread,
//! so no two calls ever overlap: work on any connection of the process
//! happens strictly in call order. Reproducing that per connection or per
//! database file is not enough (two connections touching one file at the
//! same time produce `SQLITE_BUSY` where libsql cannot, and a file can be
//! reached by several queues through `ATTACH`), so the process has **one
//! FIFO queue** shared by all ids, drained by one worker thread.
//!
//! Ids ([`ConnId`]) address a [`Target`] on that queue:
//! - a **client** (`Sqlite3Client`): owns `#db`, opened lazily from its path
//!   (`#getDb()`) and detached by [`Session::begin_transaction`];
//! - a **transaction** (`Sqlite3Transaction`): owns `#database`.
//!
//! Rust engine code runs SQL on the same queue as a JS client through
//! [`submit`] / [`call`]: a job queued for any id runs after every job queued
//! before it for any id, and nothing else runs while the job runs. Jobs must not block on the JS thread (it may
//! itself be blocked in [`call`]).
//!
//! The worker thread exits when the queue is empty and no target holds an
//! open SQLite handle (closed clients, finished
//! transactions); the next message starts a new one.

use std::cell::Cell;
use std::collections::{HashMap, VecDeque};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard, mpsc};

use crate::client;
use crate::conn::{Conn, OpenOptions};
use crate::error::{ClientError, Result};
use crate::value::IntMode;

pub type ConnId = u32;

type Job = Box<dyn FnOnce(&mut Session<'_>) + Send>;

/// What an id addresses on its queue.
pub enum Target {
  /// `Sqlite3Client`: `#path`, `#options` and the lazily (re)opened `#db`.
  Client { path: String, options: OpenOptions, db: Option<Conn> },
  /// `Sqlite3Transaction`: `#database`.
  Transaction(Conn),
}

impl Target {
  fn has_open_handle(&self) -> bool {
    match self {
      Target::Client { db, .. } => db.as_ref().is_some_and(Conn::has_handle),
      Target::Transaction(conn) => conn.has_handle(),
    }
  }
}

enum Message {
  Adopt(ConnId, Target),
  Job(ConnId, Job),
  Drop(ConnId),
}

/// The process-wide ordered queue.
pub struct Queue {
  state: Mutex<QueueState>,
  wake: Condvar,
}

struct QueueState {
  messages: VecDeque<Message>,
  /// `None` while a worker owns the targets.
  targets: Option<HashMap<ConnId, Target>>,
  running: bool,
}

/// A job's view of its id: the connection it addresses, on the worker that
/// owns every connection.
pub struct Session<'a> {
  id: ConnId,
  queue: &'a Arc<Queue>,
  targets: &'a mut HashMap<ConnId, Target>,
}

impl Session<'_> {
  pub fn id(&self) -> ConnId {
    self.id
  }

  pub fn is_transaction(&self) -> bool {
    matches!(self.targets.get(&self.id), Some(Target::Transaction(_)))
  }

  /// `#getDb()` of a client (opens the connection if it was detached by a
  /// transaction) or `#database` of a transaction.
  pub fn conn(&mut self) -> Result<&mut Conn> {
    match self.targets.get_mut(&self.id) {
      Some(Target::Client { path, options, db }) => {
        if db.is_none() {
          *db = Some(Conn::open_with(path, options)?);
        }
        db.as_mut().ok_or_else(ClientError::connection_not_open)
      }
      Some(Target::Transaction(conn)) => Ok(conn),
      None => Err(ClientError::connection_not_open()),
    }
  }

  /// `Sqlite3Client.transaction(mode)`: `BEGIN` on `#getDb()`, then the
  /// connection moves to a new transaction id on this queue and the client
  /// opens a new one on next use. On error the client keeps its connection.
  pub fn begin_transaction(&mut self, mode: &str, int_mode: IntMode) -> Result<ConnId> {
    if self.is_transaction() {
      return Err(ClientError::Error { message: "Not a client connection".to_string(), code: None });
    }
    client::begin(self.conn()?, mode, int_mode)?;
    let Some(Target::Client { db, .. }) = self.targets.get_mut(&self.id) else {
      return Err(ClientError::connection_not_open());
    };
    let conn = db.take().ok_or_else(ClientError::connection_not_open)?;
    let tx_id = next_id();
    ids().insert(tx_id, self.queue.clone());
    self.targets.insert(tx_id, Target::Transaction(conn));
    Ok(tx_id)
  }

  /// Releases the SQLite handle of a transaction that is no longer inside a
  /// transaction (see [`Conn::retire`]). No-op for clients.
  pub fn retire_finished_transaction(&mut self) {
    if let Some(Target::Transaction(conn)) = self.targets.get_mut(&self.id) {
      conn.retire();
    }
  }

  /// `Sqlite3Client.close()`: closes `#db` if there is one (it stays in place,
  /// so later use fails with `The database connection is not open`).
  pub fn close_client(&mut self) {
    if let Some(Target::Client { db: Some(conn), .. }) = self.targets.get_mut(&self.id) {
      conn.close();
    }
  }
}

static IDS: LazyLock<Mutex<HashMap<ConnId, Arc<Queue>>>> = LazyLock::new(Default::default);
static QUEUE: LazyLock<Arc<Queue>> = LazyLock::new(|| {
  Arc::new(Queue {
    state: Mutex::new(QueueState { messages: VecDeque::new(), targets: Some(HashMap::new()), running: false }),
    wake: Condvar::new(),
  })
});
static NEXT_ID: AtomicU32 = AtomicU32::new(1);
static RUNNING_WORKERS: AtomicUsize = AtomicUsize::new(0);

thread_local! {
  static IN_WORKER: Cell<bool> = const { Cell::new(false) };
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
  m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn ids() -> MutexGuard<'static, HashMap<ConnId, Arc<Queue>>> {
  lock(&IDS)
}

fn next_id() -> ConnId {
  NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

fn push(queue: &Arc<Queue>, message: Message) {
  let mut state = lock(&queue.state);
  state.messages.push_back(message);
  if state.running {
    queue.wake.notify_one();
    return;
  }
  state.running = true;
  drop(state);
  RUNNING_WORKERS.fetch_add(1, Ordering::Relaxed);
  let worker_queue = queue.clone();
  let spawned = std::thread::Builder::new()
    .name("payload-sqlite".to_string())
    .stack_size(4 * 1024 * 1024)
    .spawn(move || run_worker(&worker_queue, true));
  if spawned.is_err() {
    // Could not start a thread: drain the queue on the calling thread.
    run_worker(queue, false);
  }
}

/// Runs queued messages. With `linger`, waits for more while a target holds
/// an open SQLite handle; otherwise returns once the queue is empty.
fn run_worker(queue: &Arc<Queue>, linger: bool) {
  let was_in_worker = IN_WORKER.with(|w| w.replace(true));
  let mut targets = lock(&queue.state).targets.take().unwrap_or_default();
  loop {
    let message = {
      let mut state = lock(&queue.state);
      loop {
        if let Some(message) = state.messages.pop_front() {
          break Some(message);
        }
        if !linger || !targets.values().any(Target::has_open_handle) {
          // Hand the targets back under the lock, so a message pushed later
          // sees `running == false` and starts a new worker.
          state.targets = Some(std::mem::take(&mut targets));
          state.running = false;
          break None;
        }
        state = queue.wake.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner());
      }
    };
    let Some(message) = message else { break };
    match message {
      Message::Adopt(id, target) => {
        targets.insert(id, target);
      }
      Message::Drop(id) => {
        targets.remove(&id);
      }
      Message::Job(id, job) => {
        let mut session = Session { id, queue, targets: &mut targets };
        // A panicking job must not take the queue (and every connection of the
        // file) down with it.
        let _ = catch_unwind(AssertUnwindSafe(|| job(&mut session)));
      }
    }
  }
  RUNNING_WORKERS.fetch_sub(1, Ordering::Relaxed);
  IN_WORKER.with(|w| w.set(was_in_worker));
}

fn register(target: Target) -> ConnId {
  let queue = QUEUE.clone();
  let id = next_id();
  ids().insert(id, queue.clone());
  push(&queue, Message::Adopt(id, target));
  id
}

/// Registers a client (`Sqlite3Client`) whose `#db` is `conn`, opened from
/// `path` without options.
pub fn register_client(path: &str, conn: Conn) -> ConnId {
  register_client_with(path, OpenOptions::default(), conn)
}

/// Registers a client whose `#db` is `conn`, opened from `path` with
/// `options` (also used to reopen `#db` after `transaction()`).
pub fn register_client_with(path: &str, options: OpenOptions, conn: Conn) -> ConnId {
  register(Target::Client { path: path.to_string(), options, db: Some(conn) })
}

/// [`open_client_with`] without options.
pub fn open_client(path: &str) -> Result<ConnId> {
  open_client_with(path, &OpenOptions::default())
}

/// `new Database(path, opts)`: opens synchronously on the calling thread (so
/// open errors surface synchronously, as in the binding) and registers a
/// client.
pub fn open_client_with(path: &str, options: &OpenOptions) -> Result<ConnId> {
  Ok(register_client_with(path, options.clone(), Conn::open_with(path, options)?))
}

/// Queues `job` for `id`. It runs after every job queued earlier for any id,
/// and alone.
pub fn submit(id: ConnId, job: impl FnOnce(&mut Session<'_>) + Send + 'static) -> Result<()> {
  let queue = ids().get(&id).cloned().ok_or_else(ClientError::connection_not_open)?;
  push(&queue, Message::Job(id, Box::new(job)));
  Ok(())
}

/// Queues `f` and blocks until it ran. Must not be called from a job (that
/// would wait for itself); doing so returns an error instead of deadlocking.
pub fn call<T: Send + 'static>(id: ConnId, f: impl FnOnce(&mut Session<'_>) -> T + Send + 'static) -> Result<T> {
  if IN_WORKER.with(Cell::get) {
    return Err(ClientError::Error {
      message: "payload-sqlite: worker::call cannot be used from inside a queued job".to_string(),
      code: None,
    });
  }
  let (tx, rx) = mpsc::sync_channel(1);
  submit(id, move |session| {
    let _ = tx.send(f(session));
  })?;
  rx.recv().map_err(|_| ClientError::connection_not_open())
}

/// Forgets the id: jobs queued before still run, then its connection is
/// closed. Later [`submit`]s fail with `The database connection is not open`.
pub fn release(id: ConnId) {
  if let Some(queue) = ids().remove(&id) {
    push(&queue, Message::Drop(id));
  }
}

/// Whether two ids share a queue (always, for registered ids: there is one).
pub fn same_queue(a: ConnId, b: ConnId) -> bool {
  let ids = ids();
  match (ids.get(&a), ids.get(&b)) {
    (Some(x), Some(y)) => Arc::ptr_eq(x, y),
    _ => false,
  }
}

/// Number of registered ids (diagnostics / leak tests).
pub fn open_connections() -> usize {
  ids().len()
}

/// Number of queues that currently own a worker thread (0 or 1).
pub fn live_workers() -> usize {
  RUNNING_WORKERS.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::value::{Cell as SqlCell, IntMode, Statement};

  /// The queue is process-wide: tests that observe it run one at a time.
  static SERIAL: Mutex<()> = Mutex::new(());

  fn serial() -> MutexGuard<'static, ()> {
    lock(&SERIAL)
  }

  fn temp_db(name: &str) -> String {
    let path = std::env::temp_dir().join(format!("payload-sqlite-worker-{name}-{}.db", std::process::id()));
    for suffix in ["", "-journal", "-wal", "-shm"] {
      let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
    path.to_string_lossy().into_owned()
  }

  fn cleanup(path: &str) {
    for suffix in ["", "-journal", "-wal", "-shm"] {
      let _ = std::fs::remove_file(format!("{path}{suffix}"));
    }
  }

  fn exec(id: ConnId, sql: &'static str) -> Result<crate::ResultSet> {
    call(id, move |s| s.conn()?.execute_sql(sql, IntMode::Number)).and_then(|r| r)
  }

  #[test]
  fn jobs_run_in_order() {
    let _serial = serial();
    let id = open_client("file::memory:").unwrap();
    submit(id, |s| {
      s.conn().unwrap().execute_sql("create table t(a)", IntMode::Number).unwrap();
    })
    .unwrap();
    for i in 0..50 {
      submit(id, move |s| {
        s.conn().unwrap().execute_sql(&format!("insert into t values ({i})"), IntMode::Number).unwrap();
      })
      .unwrap();
    }
    let rows = exec(id, "select group_concat(a) from t").unwrap().rows;
    let expected = (0..50).map(|i| i.to_string()).collect::<Vec<_>>().join(",");
    assert_eq!(rows[0][0], SqlCell::String(expected));
    release(id);
    assert!(submit(id, |_| {}).is_err());
  }

  #[test]
  fn all_clients_share_one_queue() {
    let _serial = serial();
    let path = temp_db("share");
    let a = open_client(&path).unwrap();
    let b = open_client(&path).unwrap();
    let m = open_client("file::memory:").unwrap();
    assert!(same_queue(a, b));
    assert!(same_queue(a, m));
    let tx = call(a, |s| s.begin_transaction("write", IntMode::Number)).unwrap().unwrap();
    assert!(same_queue(a, tx));
    for id in [a, b, m, tx] {
      release(id);
    }
    cleanup(&path);
  }

  /// The reviewer's probe: a commit queued before a read on the client's new
  /// connection must have finished when the read runs (no SQLITE_BUSY).
  #[test]
  fn commit_then_read_across_connections() {
    let _serial = serial();
    let path = temp_db("commit-read");
    let client_id = open_client(&path).unwrap();
    exec(client_id, "create table u(a)").unwrap();
    let tx = call(client_id, |s| s.begin_transaction("write", IntMode::Number)).unwrap().unwrap();
    call(tx, |s| client::tx_execute(s.conn()?, &Statement::sql("insert into u values (1)"), IntMode::Number))
      .unwrap()
      .unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let commit_done = done_tx.clone();
    submit(tx, move |s| {
      let r = s.conn().and_then(|c| client::tx_commit(c, IntMode::Number));
      s.retire_finished_transaction();
      let _ = commit_done.send(("commit", r.map(|_| SqlCell::Null)));
    })
    .unwrap();
    submit(client_id, move |s| {
      let r = s.conn().and_then(|c| c.execute_sql("select count(*) from u", IntMode::Number));
      let _ = done_tx.send(("read", r.map(|rs| rs.rows[0][0].clone())));
    })
    .unwrap();
    let first = done_rx.recv().unwrap();
    let second = done_rx.recv().unwrap();
    assert_eq!(first, ("commit", Ok(SqlCell::Null)));
    assert_eq!(second, ("read", Ok(SqlCell::Number(1.0))));
    release(tx);
    release(client_id);
    cleanup(&path);
  }

  /// A file reached through `ATTACH` from another main database: the commit
  /// on the attaching transaction is done before the other client reads.
  #[test]
  fn attached_files_are_ordered_with_their_own_clients() {
    let _serial = serial();
    let main_path = temp_db("attach-main");
    let other_path = temp_db("attach-other");
    let other = open_client(&other_path).unwrap();
    exec(other, "create table o(a)").unwrap();
    let main = open_client(&main_path).unwrap();
    let attach = format!("attach database '{other_path}' as x");
    call(main, move |s| s.conn()?.execute_sql(&attach, IntMode::Number)).unwrap().unwrap();
    let tx = call(main, |s| s.begin_transaction("write", IntMode::Number)).unwrap().unwrap();
    call(tx, |s| client::tx_execute(s.conn()?, &Statement::sql("insert into x.o values (1)"), IntMode::Number))
      .unwrap()
      .unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    let commit_done = done_tx.clone();
    submit(tx, move |s| {
      let r = s.conn().and_then(|c| client::tx_commit(c, IntMode::Number));
      let _ = commit_done.send(r.map(|_| SqlCell::Null));
    })
    .unwrap();
    submit(other, move |s| {
      let r = s.conn().and_then(|c| c.execute_sql("select count(*) from o", IntMode::Number));
      let _ = done_tx.send(r.map(|rs| rs.rows[0][0].clone()));
    })
    .unwrap();
    assert_eq!(done_rx.recv().unwrap(), Ok(SqlCell::Null));
    assert_eq!(done_rx.recv().unwrap(), Ok(SqlCell::Number(1.0)));
    for id in [tx, main, other] {
      release(id);
    }
    cleanup(&main_path);
    cleanup(&other_path);
  }

  #[test]
  fn finished_transactions_answer_without_sqlite() {
    let _serial = serial();
    let id = open_client("file::memory:").unwrap();
    let tx = call(id, |s| s.begin_transaction("write", IntMode::Number)).unwrap().unwrap();
    call(tx, |s| {
      let r = client::tx_commit(s.conn()?, IntMode::Number);
      s.retire_finished_transaction();
      r
    })
    .unwrap()
    .unwrap();
    let err = call(tx, |s| client::tx_execute(s.conn()?, &Statement::sql("select 1"), IntMode::Number))
      .unwrap()
      .unwrap_err();
    assert_eq!(err, ClientError::transaction_closed());
    assert!(call(tx, |s| client::tx_rollback(s.conn()?, IntMode::Number)).unwrap().is_err());
    release(tx);
    release(id);
  }

  #[test]
  fn call_from_a_job_errors_instead_of_deadlocking() {
    let _serial = serial();
    let id = open_client("file::memory:").unwrap();
    let nested = call(id, move |_| call(id, |_| ()).is_err()).unwrap();
    assert!(nested);
    release(id);
  }

  #[test]
  fn worker_stops_when_no_handle_is_open() {
    let _serial = serial();
    let path = temp_db("stop");
    let id = open_client(&path).unwrap();
    let queue = ids().get(&id).cloned().unwrap();
    call(id, |s| s.close_client()).unwrap();
    for _ in 0..1000 {
      if !lock(&queue.state).running {
        break;
      }
      std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert!(!lock(&queue.state).running);
    // The next job starts a worker again; the closed connection stays closed.
    let err = exec(id, "select 1").unwrap_err();
    assert_eq!(err, ClientError::connection_not_open());
    release(id);
    cleanup(&path);
  }
}
