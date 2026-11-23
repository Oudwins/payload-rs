//! The SQLite backend of the fused read lanes (packages/engine-rs/FUSE_CONTRACT.md section 6):
//! `payload.db.find` / `findOne` / `count` are the Rust SQLite engine's own methods
//! (`payload_sql_engine::SqliteEngine::call`, the code the engine-backed adapter methods run),
//! all statements of one fused operation inside one `payload-sqlite` queue job on the
//! connection's worker. `find` / `findOne` of collections in the [`fast`] subset decode the rows
//! directly into the document shape.

pub mod exec;
pub mod fast;
pub mod scan;
pub mod templates;
pub mod tplan;

use std::sync::Arc;

use payload_engine::host::NoHost;
use payload_engine::js::JsVal;
use payload_fuse::{Bail, DirectRead, FuseResult, FusedBackend, Job, ReadSession};
use payload_sql_engine::{EngineOptions, SqliteEngine};
use payload_sqlite::{Session, worker};

/// One adapter's engine with the call context of this call (adapter flags read at call time).
pub struct SqliteBackend {
  pub engine: Arc<SqliteEngine>,
  pub options: EngineOptions,
}

impl SqliteBackend {
  /// `context`: `{ blocksAsJSON?, limitedBoundParameters? }` (ENGINE_CONTRACT.md `contextJson`).
  pub fn new(engine: Arc<SqliteEngine>, context: &serde_json::Value) -> Self {
    let options = engine.options().at_call_time(context);
    Self { engine, options }
  }
}

impl FusedBackend for SqliteBackend {
  fn name(&self) -> &'static str {
    "sqlite"
  }

  fn run(&self, conn: u32, job: Job) -> FuseResult<String> {
    let engine = Arc::clone(&self.engine);
    let options = self.options.clone();
    worker::call(conn, move |session| {
      let mut read = SqliteRead { engine: &engine, options: &options, session };
      std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(&mut read))).unwrap_or_else(|_| Err(Bail::new("panic")))
    })
    .unwrap_or_else(|_| Err(Bail::new("sqlite:connection")))
  }
}

struct SqliteRead<'a, 's> {
  engine: &'a Arc<SqliteEngine>,
  options: &'a EngineOptions,
  session: &'a mut Session<'s>,
}

impl SqliteRead<'_, '_> {
  fn call(&mut self, method: &str, args: &JsVal) -> FuseResult<JsVal> {
    self
      .engine
      .call(&NoHost, method, args, self.options, self.session)
      .map_err(|error| Bail::new(format!("db:{}", error.name)))
  }
}

/// `PAYLOAD_RS_FUSE_SQLITE_FAST=off` (read once): always the engine's generic methods
/// (diagnostics and differential checks of the fast path).
static FAST_DISABLED: std::sync::LazyLock<bool> =
  std::sync::LazyLock::new(|| std::env::var("PAYLOAD_RS_FUSE_SQLITE_FAST").is_ok_and(|v| v == "off"));

impl ReadSession for SqliteRead<'_, '_> {
  fn find(&mut self, args: &JsVal) -> FuseResult<JsVal> {
    self.call("find", args)
  }

  fn find_one(&mut self, args: &JsVal) -> FuseResult<JsVal> {
    self.call("findOne", args)
  }

  fn find_json(&mut self, args: &JsVal, one: bool, read: &DirectRead<'_>) -> Option<FuseResult<String>> {
    if *FAST_DISABLED {
      return None;
    }
    let conn = match self.session.conn() {
      Ok(conn) => conn,
      Err(_) => return Some(Err(Bail::new("sqlite:connection"))),
    };
    let direct = fast::Direct { read: read.read, select: read.select, select_mode: read.select_mode, auth: read.auth };
    match fast::find(self.engine, self.options, conn, args, one, &direct) {
      Ok(fast::Fast::Done(json)) => Some(Ok(json)),
      Ok(fast::Fast::Unsupported) => None,
      Err(error) => Some(Err(Bail::new(format!("db:{}", error.name)))),
    }
  }

  fn count(&mut self, args: &JsVal) -> FuseResult<JsVal> {
    self.call("count", args)
  }
}
