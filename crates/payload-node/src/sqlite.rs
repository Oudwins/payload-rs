//! napi bindings for the Rust SQLite runtime (`payload-sqlite`).
//!
//! Consumed by `packages/engine-rs/src/sqlite/native.ts`. Every function
//! returns (or resolves to) an envelope `{ ok: value }` / `{ error: {...} }` so
//! the TS glue can rebuild the exact error objects of `@libsql/client`.
//!
//! Database work runs on the per-database-file ordered queues of
//! `payload_sqlite::worker` (one worker thread per file) and settles a promise
//! through a napi deferred. Only `sqliteCreateClient` (synchronous in libsql
//! as well) and `sqliteInTransaction` (the synchronous `closed` getter) block
//! the JS thread until earlier queued work is done.
//!
//! Other napi modules run engine SQL on the same queue as a client or
//! transaction id through [`queue_job`].

use std::ffi::c_char;
use std::ptr;

use napi::bindgen_prelude::*;
use napi::sys;
use napi_derive::napi;

use payload_sqlite::client;
use payload_sqlite::config::{ClientConfig, resolve_config};
use payload_sqlite::{Args, BindValue, Cell, ClientError, ConnId, IntMode, ResultSet, Statement};
use payload_sqlite::worker::{self, Session};

// ---------------------------------------------------------------------------
// raw napi helpers

macro_rules! check {
  ($e:expr) => {{
    let status = $e;
    if status != sys::Status::napi_ok {
      return Err(Error::new(Status::from(status), "napi call failed in payload-sqlite".to_string()));
    }
  }};
}

unsafe fn js_string(env: sys::napi_env, s: &str) -> Result<sys::napi_value> {
  let mut out = ptr::null_mut();
  check!(unsafe { sys::napi_create_string_utf8(env, s.as_ptr().cast::<c_char>(), s.len() as isize, &mut out) });
  Ok(out)
}

unsafe fn js_number(env: sys::napi_env, n: f64) -> Result<sys::napi_value> {
  let mut out = ptr::null_mut();
  check!(unsafe { sys::napi_create_double(env, n, &mut out) });
  Ok(out)
}

unsafe fn js_bigint(env: sys::napi_env, n: i64) -> Result<sys::napi_value> {
  let mut out = ptr::null_mut();
  check!(unsafe { sys::napi_create_bigint_int64(env, n, &mut out) });
  Ok(out)
}

unsafe fn js_null(env: sys::napi_env) -> Result<sys::napi_value> {
  let mut out = ptr::null_mut();
  check!(unsafe { sys::napi_get_null(env, &mut out) });
  Ok(out)
}

unsafe fn js_undefined(env: sys::napi_env) -> Result<sys::napi_value> {
  let mut out = ptr::null_mut();
  check!(unsafe { sys::napi_get_undefined(env, &mut out) });
  Ok(out)
}

unsafe fn js_bool(env: sys::napi_env, b: bool) -> Result<sys::napi_value> {
  let mut out = ptr::null_mut();
  check!(unsafe { sys::napi_get_boolean(env, b, &mut out) });
  Ok(out)
}

unsafe fn js_array_buffer(env: sys::napi_env, bytes: &[u8]) -> Result<sys::napi_value> {
  let mut out = ptr::null_mut();
  let mut data: *mut std::ffi::c_void = ptr::null_mut();
  check!(unsafe { sys::napi_create_arraybuffer(env, bytes.len(), &mut data, &mut out) });
  if !bytes.is_empty() && !data.is_null() {
    // SAFETY: `data` points to a fresh buffer of `bytes.len()` bytes.
    unsafe { ptr::copy_nonoverlapping(bytes.as_ptr(), data.cast::<u8>(), bytes.len()) };
  }
  Ok(out)
}

unsafe fn js_object(env: sys::napi_env) -> Result<sys::napi_value> {
  let mut out = ptr::null_mut();
  check!(unsafe { sys::napi_create_object(env, &mut out) });
  Ok(out)
}

unsafe fn js_array(env: sys::napi_env, len: usize) -> Result<sys::napi_value> {
  let mut out = ptr::null_mut();
  check!(unsafe { sys::napi_create_array_with_length(env, len, &mut out) });
  Ok(out)
}

unsafe fn set(env: sys::napi_env, obj: sys::napi_value, key: &str, value: sys::napi_value) -> Result<()> {
  let key = unsafe { js_string(env, key)? };
  check!(unsafe { sys::napi_set_property(env, obj, key, value) });
  Ok(())
}

unsafe fn set_index(env: sys::napi_env, arr: sys::napi_value, i: usize, value: sys::napi_value) -> Result<()> {
  check!(unsafe { sys::napi_set_element(env, arr, i as u32, value) });
  Ok(())
}

unsafe fn get(env: sys::napi_env, obj: sys::napi_value, key: &str) -> Result<sys::napi_value> {
  let key = unsafe { js_string(env, key)? };
  let mut out = ptr::null_mut();
  check!(unsafe { sys::napi_get_property(env, obj, key, &mut out) });
  Ok(out)
}

unsafe fn type_of(env: sys::napi_env, v: sys::napi_value) -> Result<sys::napi_valuetype> {
  let mut t = 0;
  check!(unsafe { sys::napi_typeof(env, v, &mut t) });
  Ok(t)
}

unsafe fn read_string(env: sys::napi_env, v: sys::napi_value) -> Result<String> {
  let mut len = 0usize;
  check!(unsafe { sys::napi_get_value_string_utf8(env, v, ptr::null_mut(), 0, &mut len) });
  let mut buf = vec![0u8; len + 1];
  let mut written = 0usize;
  check!(unsafe { sys::napi_get_value_string_utf8(env, v, buf.as_mut_ptr().cast::<c_char>(), len + 1, &mut written) });
  buf.truncate(written);
  Ok(String::from_utf8(buf).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
}

unsafe fn array_items(env: sys::napi_env, v: sys::napi_value) -> Result<Vec<sys::napi_value>> {
  let mut len = 0u32;
  check!(unsafe { sys::napi_get_array_length(env, v, &mut len) });
  let mut items = Vec::with_capacity(len as usize);
  for i in 0..len {
    let mut item = ptr::null_mut();
    check!(unsafe { sys::napi_get_element(env, v, i, &mut item) });
    items.push(item);
  }
  Ok(items)
}

/// What the `libsql` binding does with one JS argument value.
unsafe fn read_bind_value(env: sys::napi_env, v: sys::napi_value) -> Result<BindValue> {
  Ok(match unsafe { type_of(env, v)? } {
    sys::ValueType::napi_null | sys::ValueType::napi_undefined => BindValue::Null,
    sys::ValueType::napi_number => {
      let mut n = 0f64;
      check!(unsafe { sys::napi_get_value_double(env, v, &mut n) });
      BindValue::Real(n)
    }
    sys::ValueType::napi_bigint => {
      let mut n = 0i64;
      let mut lossless = false;
      check!(unsafe { sys::napi_get_value_bigint_int64(env, v, &mut n, &mut lossless) });
      BindValue::Integer(n)
    }
    sys::ValueType::napi_string => BindValue::Text(unsafe { read_string(env, v)? }),
    sys::ValueType::napi_object => {
      let mut is_typed = false;
      check!(unsafe { sys::napi_is_typedarray(env, v, &mut is_typed) });
      if !is_typed {
        return Ok(BindValue::Invalid);
      }
      let mut kind = 0;
      let mut len = 0usize;
      let mut data: *mut std::ffi::c_void = ptr::null_mut();
      let mut ab = ptr::null_mut();
      let mut offset = 0usize;
      check!(unsafe { sys::napi_get_typedarray_info(env, v, &mut kind, &mut len, &mut data, &mut ab, &mut offset) });
      if kind != sys::TypedarrayType::uint8_array {
        return Ok(BindValue::Invalid);
      }
      let bytes = if len == 0 || data.is_null() {
        Vec::new()
      } else {
        // SAFETY: napi reports `len` readable bytes at `data` (already offset).
        unsafe { std::slice::from_raw_parts(data.cast::<u8>(), len) }.to_vec()
      };
      BindValue::Blob(bytes)
    }
    _ => BindValue::Invalid,
  })
}

/// A normalized `InStatement` coming from `packages/engine-rs/src/sqlite`:
/// `{ sql, args?: unknown[], names?: string[], error?: [kind, message] }`.
pub struct JsStatement(Statement);

impl TypeName for JsStatement {
  fn type_name() -> &'static str {
    "SqliteStatement"
  }
  fn value_type() -> ValueType {
    ValueType::Object
  }
}

impl ValidateNapiValue for JsStatement {}

impl FromNapiValue for JsStatement {
  unsafe fn from_napi_value(env: sys::napi_env, v: sys::napi_value) -> Result<Self> {
    unsafe {
      let sql = read_string(env, get(env, v, "sql")?)?;
      let error_v = get(env, v, "error")?;
      let error = if type_of(env, error_v)? == sys::ValueType::napi_undefined {
        None
      } else {
        let parts = array_items(env, error_v)?;
        let kind = read_string(env, parts[0])?;
        let message = read_string(env, parts[1])?;
        Some(match kind.as_str() {
          "TypeError" => ClientError::Type(message),
          "RangeError" => ClientError::Range(message),
          _ => ClientError::Error { message, code: None },
        })
      };
      let args_v = get(env, v, "args")?;
      let values = if type_of(env, args_v)? == sys::ValueType::napi_undefined {
        Vec::new()
      } else {
        array_items(env, args_v)?.into_iter().map(|item| read_bind_value(env, item)).collect::<Result<Vec<_>>>()?
      };
      let names_v = get(env, v, "names")?;
      let args = if type_of(env, names_v)? == sys::ValueType::napi_undefined {
        Args::Positional(values)
      } else {
        let names = array_items(env, names_v)?.into_iter().map(|n| read_string(env, n)).collect::<Result<Vec<_>>>()?;
        Args::Named(names.into_iter().zip(values).collect())
      };
      Ok(JsStatement(Statement { sql, args, error }))
    }
  }
}

// ---------------------------------------------------------------------------
// outcomes

enum Value {
  Unit,
  Id(ConnId),
  Bool(bool),
  Result(ResultSet),
  Results(Vec<ResultSet>),
}

/// `{ ok: value }` or `{ error: { kind, message, code?, rawCode? } }`.
pub struct Outcome(std::result::Result<Value, ClientError>);

impl<T: Into<Value>> From<payload_sqlite::Result<T>> for Outcome {
  fn from(r: payload_sqlite::Result<T>) -> Self {
    Outcome(r.map(Into::into))
  }
}

impl From<()> for Value {
  fn from(_: ()) -> Self {
    Value::Unit
  }
}
impl From<ConnId> for Value {
  fn from(id: ConnId) -> Self {
    Value::Id(id)
  }
}
impl From<bool> for Value {
  fn from(b: bool) -> Self {
    Value::Bool(b)
  }
}
impl From<ResultSet> for Value {
  fn from(r: ResultSet) -> Self {
    Value::Result(r)
  }
}
impl From<Vec<ResultSet>> for Value {
  fn from(r: Vec<ResultSet>) -> Self {
    Value::Results(r)
  }
}

unsafe fn result_set_to_js(env: sys::napi_env, rs: &ResultSet) -> Result<sys::napi_value> {
  unsafe {
    let obj = js_object(env)?;
    let columns = js_array(env, rs.columns.len())?;
    for (i, c) in rs.columns.iter().enumerate() {
      set_index(env, columns, i, js_string(env, c)?)?;
    }
    let types = js_array(env, rs.column_types.len())?;
    for (i, c) in rs.column_types.iter().enumerate() {
      set_index(env, types, i, js_string(env, c)?)?;
    }
    let rows = js_array(env, rs.rows.len())?;
    for (r, row) in rs.rows.iter().enumerate() {
      let arr = js_array(env, row.len())?;
      for (i, cell) in row.iter().enumerate() {
        let v = match cell {
          Cell::Null => js_null(env)?,
          Cell::Number(n) => js_number(env, *n)?,
          Cell::BigInt(n) => js_bigint(env, *n)?,
          Cell::String(s) => js_string(env, s)?,
          Cell::Blob(b) => js_array_buffer(env, b)?,
        };
        set_index(env, arr, i, v)?;
      }
      set_index(env, rows, r, arr)?;
    }
    set(env, obj, "columns", columns)?;
    set(env, obj, "columnTypes", types)?;
    set(env, obj, "rows", rows)?;
    set(env, obj, "rowsAffected", js_number(env, rs.rows_affected as f64)?)?;
    let rowid = match rs.last_insert_rowid {
      Some(id) => js_bigint(env, id)?,
      None => js_undefined(env)?,
    };
    set(env, obj, "lastInsertRowid", rowid)?;
    Ok(obj)
  }
}

unsafe fn error_to_js(env: sys::napi_env, err: &ClientError) -> Result<sys::napi_value> {
  unsafe {
    let obj = js_object(env)?;
    let (kind, message, code, raw) = match err {
      ClientError::Sqlite { message, code, raw_code } => ("sqlite", message, Some(code), Some(*raw_code)),
      ClientError::Native { message, code, raw_code } => ("native", message, Some(code), Some(*raw_code)),
      ClientError::Libsql { message, code } => ("libsql", message, Some(code), None),
      ClientError::UriMalformed { message } => ("libsqlUri", message, None, None),
      ClientError::Type(message) => ("TypeError", message, None, None),
      ClientError::Range(message) => ("RangeError", message, None, None),
      ClientError::Error { message, code } => ("Error", message, code.as_ref(), None),
    };
    set(env, obj, "kind", js_string(env, kind)?)?;
    set(env, obj, "message", js_string(env, message)?)?;
    if let Some(code) = code {
      set(env, obj, "code", js_string(env, code)?)?;
    } else if matches!(err, ClientError::UriMalformed { .. }) {
      set(env, obj, "code", js_string(env, "URL_INVALID")?)?;
    }
    if let Some(raw) = raw {
      set(env, obj, "rawCode", js_number(env, raw as f64)?)?;
    }
    Ok(obj)
  }
}

impl TypeName for Outcome {
  fn type_name() -> &'static str {
    "SqliteOutcome"
  }
  fn value_type() -> ValueType {
    ValueType::Object
  }
}

impl ToNapiValue for Outcome {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    unsafe {
      let obj = js_object(env)?;
      match &val.0 {
        Ok(value) => {
          let v = match value {
            Value::Unit => js_undefined(env)?,
            Value::Id(id) => js_number(env, *id as f64)?,
            Value::Bool(b) => js_bool(env, *b)?,
            Value::Result(rs) => result_set_to_js(env, rs)?,
            Value::Results(list) => {
              let arr = js_array(env, list.len())?;
              for (i, rs) in list.iter().enumerate() {
                set_index(env, arr, i, result_set_to_js(env, rs)?)?;
              }
              arr
            }
          };
          set(env, obj, "ok", v)?;
        }
        Err(err) => set(env, obj, "error", error_to_js(env, err)?)?,
      }
      Ok(obj)
    }
  }
}

fn int_mode(mode: &str) -> IntMode {
  IntMode::parse(mode).unwrap_or_default()
}

type Resolver<T> = Box<dyn FnOnce(Env) -> Result<T> + Send>;

/// Runs `job` on the ordered queue of connection `id` (see
/// `payload_sqlite::worker`) and returns a promise of its result; an `Err`
/// rejects the promise. The job runs after every job queued earlier for any
/// id of the same database file, and alone on that file, so Rust engine code
/// can interleave with `@libsql/client`-style calls exactly in call order.
pub fn queue_job<'env, T: ToNapiValue + Send + 'static>(
  env: &'env Env,
  id: ConnId,
  job: impl FnOnce(&mut Session<'_>) -> Result<T> + Send + 'static,
) -> Result<Object<'env>> {
  let (deferred, promise) = env.create_deferred::<T, Resolver<T>>()?;
  let pending = std::sync::Arc::new(std::sync::Mutex::new(Some(deferred)));
  let pending_job = pending.clone();
  let submitted = worker::submit(id, move |session| {
    let result = job(session);
    if let Some(d) = pending_job.lock().ok().and_then(|mut g| g.take()) {
      d.resolve(Box::new(move |_| result));
    }
  });
  if let Err(err) = submitted {
    if let Some(d) = pending.lock().ok().and_then(|mut g| g.take()) {
      let message = err.to_string();
      d.resolve(Box::new(move |_| Err(Error::new(Status::GenericFailure, message))));
    }
  }
  Ok(promise)
}

/// Queues a client-facing job whose outcome is an envelope (never rejects).
/// With `retire`, a transaction connection that left its transaction is
/// released afterwards (see `Conn::retire`).
fn spawn<'env>(
  env: &'env Env,
  id: ConnId,
  retire: bool,
  job: impl FnOnce(&mut Session<'_>) -> Outcome + Send + 'static,
) -> Result<Object<'env>> {
  let (deferred, promise) = env.create_deferred::<Outcome, Resolver<Outcome>>()?;
  let pending = std::sync::Arc::new(std::sync::Mutex::new(Some(deferred)));
  let pending_job = pending.clone();
  let submitted = worker::submit(id, move |session| {
    let outcome = job(session);
    if retire {
      session.retire_finished_transaction();
    }
    if let Some(d) = pending_job.lock().ok().and_then(|mut g| g.take()) {
      d.resolve(Box::new(move |_| Ok(outcome)));
    }
  });
  if let Err(err) = submitted {
    if let Some(d) = pending.lock().ok().and_then(|mut g| g.take()) {
      d.resolve(Box::new(move |_| Ok(Outcome(Err(err)))));
    }
  }
  Ok(promise)
}

// ---------------------------------------------------------------------------
// exported functions

/// `createClient(config)`: resolves the URL, opens the database (on the
/// calling thread, as `new Database(path)` does) and runs
/// `SELECT 1 AS checkThatTheDatabaseCanBeOpened` in order on the file's queue.
/// Returns `{ ok: { id, path, intMode } }`; `id` addresses the client.
#[napi]
pub fn sqlite_create_client(
  url: String,
  int_mode_json: String,
  sync_url: bool,
  encryption_key: bool,
) -> Result<CreatedClient> {
  let config = ClientConfig { url, int_mode_json, sync_url, encryption_key };
  let created = (|| -> payload_sqlite::Result<CreatedClientData> {
    let target = resolve_config(&config)?;
    let id = worker::open_client(&target.path)?;
    let check_mode = target.int_mode;
    let checked = worker::call(id, move |session| {
      session.conn()?.execute_sql("SELECT 1 AS checkThatTheDatabaseCanBeOpened", check_mode).map(|_| ())
    })
    .and_then(|r| r);
    if let Err(err) = checked {
      worker::release(id);
      return Err(err);
    }
    let int_mode = match target.int_mode {
      IntMode::Number => "number",
      IntMode::Bigint => "bigint",
      IntMode::String => "string",
    };
    Ok(CreatedClientData { id, path: target.path, int_mode: int_mode.to_string() })
  })();
  Ok(CreatedClient(created))
}

struct CreatedClientData {
  id: ConnId,
  path: String,
  int_mode: String,
}

pub struct CreatedClient(payload_sqlite::Result<CreatedClientData>);

impl TypeName for CreatedClient {
  fn type_name() -> &'static str {
    "SqliteCreatedClient"
  }
  fn value_type() -> ValueType {
    ValueType::Object
  }
}

impl ToNapiValue for CreatedClient {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    unsafe {
      let obj = js_object(env)?;
      match &val.0 {
        Ok(data) => {
          let ok = js_object(env)?;
          set(env, ok, "id", js_number(env, data.id as f64)?)?;
          set(env, ok, "path", js_string(env, &data.path)?)?;
          set(env, ok, "intMode", js_string(env, &data.int_mode)?)?;
          set(env, obj, "ok", ok)?;
        }
        Err(err) => set(env, obj, "error", error_to_js(env, err)?)?,
      }
      Ok(obj)
    }
  }
}

/// `executeStmt` on the client's `#getDb()`, or `Sqlite3Transaction.execute`
/// when `in_transaction` is set (the `#checkNotClosed()` runs in order on the
/// queue).
#[napi]
pub fn sqlite_execute<'env>(
  env: &'env Env,
  id: u32,
  stmt: JsStatement,
  int_mode_name: String,
  in_transaction: bool,
) -> Result<Object<'env>> {
  let mode = int_mode(&int_mode_name);
  spawn(env, id, in_transaction, move |session| {
    session
      .conn()
      .and_then(|conn| if in_transaction { client::tx_execute(conn, &stmt.0, mode) } else { conn.execute(&stmt.0, mode) })
      .into()
  })
}

/// `Sqlite3Client.batch` (`kind = "batch"`, with `mode`), `Sqlite3Client.migrate`
/// (`kind = "migrate"`) or `Sqlite3Transaction.batch` (`kind = "transaction"`).
#[napi]
pub fn sqlite_batch<'env>(
  env: &'env Env,
  id: u32,
  stmts: Vec<JsStatement>,
  int_mode_name: String,
  kind: String,
  mode: String,
) -> Result<Object<'env>> {
  let int_mode = int_mode(&int_mode_name);
  let stmts: Vec<Statement> = stmts.into_iter().map(|s| s.0).collect();
  let in_transaction = kind == "transaction";
  spawn(env, id, in_transaction, move |session| {
    session
      .conn()
      .and_then(|conn| match kind.as_str() {
        "migrate" => client::migrate(conn, &stmts, int_mode),
        "transaction" => client::tx_batch(conn, &stmts, int_mode),
        _ => client::batch(conn, &stmts, &mode, int_mode),
      })
      .into()
  })
}

/// `Sqlite3Client.executeMultiple` / `Sqlite3Transaction.executeMultiple`.
#[napi]
pub fn sqlite_execute_multiple<'env>(
  env: &'env Env,
  id: u32,
  sql: String,
  int_mode_name: String,
  in_transaction: bool,
) -> Result<Object<'env>> {
  let mode = int_mode(&int_mode_name);
  spawn(env, id, in_transaction, move |session| {
    session
      .conn()
      .and_then(|conn| {
        if in_transaction { client::tx_execute_multiple(conn, &sql) } else { client::execute_multiple(conn, &sql, mode) }
      })
      .into()
  })
}

/// `Sqlite3Client.transaction(mode)`: `BEGIN` on the client's `#getDb()` in
/// queue order; resolves to `{ ok: transactionId }`. The connection then
/// belongs to the transaction and the client reopens lazily.
#[napi]
pub fn sqlite_transaction<'env>(env: &'env Env, id: u32, mode: String, int_mode_name: String) -> Result<Object<'env>> {
  let int_mode = int_mode(&int_mode_name);
  spawn(env, id, false, move |session| session.begin_transaction(&mode, int_mode).into())
}

/// `Sqlite3Transaction.commit()` / `.rollback()` (`action = "commit" | "rollback"`).
#[napi]
pub fn sqlite_transaction_end<'env>(env: &'env Env, id: u32, action: String, int_mode_name: String) -> Result<Object<'env>> {
  let mode = int_mode(&int_mode_name);
  spawn(env, id, true, move |session| {
    session
      .conn()
      .and_then(|conn| if action == "commit" { client::tx_commit(conn, mode) } else { client::tx_rollback(conn, mode) })
      .into()
  })
}

/// `db.inTransaction` (the `Sqlite3Transaction.closed` getter), evaluated
/// after all queued work on the database file. Blocks the JS thread.
#[napi]
pub fn sqlite_in_transaction(id: u32) -> Outcome {
  match worker::call(id, |session| session.conn().map(|conn| conn.in_transaction())) {
    Ok(r) => r.into(),
    Err(e) => Outcome(Err(e)),
  }
}

/// `Sqlite3Transaction.close()`: queues `ROLLBACK` if still in a transaction.
#[napi]
pub fn sqlite_transaction_close(id: u32, int_mode_name: String) {
  let mode = int_mode(&int_mode_name);
  let _ = worker::submit(id, move |session| {
    if let Ok(conn) = session.conn() {
      let _ = client::tx_close(conn, mode);
    }
    session.retire_finished_transaction();
  });
}

/// `Sqlite3Client.close()`: queues `#db.close()` (if the client has a
/// connection). The id stays registered: a later `transaction()` reaches the
/// closed connection (`The database connection is not open`) or, if the
/// connection was detached by a transaction, opens a new one, as upstream.
#[napi]
pub fn sqlite_client_close(id: u32) {
  let _ = worker::submit(id, |session| session.close_client());
}

/// Drops the id (GC of the JS owner); queued jobs still run, then its
/// connection is closed.
#[napi]
pub fn sqlite_release(id: u32) {
  worker::release(id);
}

/// `[registered ids, queues that currently own a worker thread]` (leak
/// diagnostics).
#[napi]
pub fn sqlite_stats() -> Vec<u32> {
  vec![worker::open_connections() as u32, worker::live_workers() as u32]
}

/// Runs `sql` through plain `rusqlite` on the connection of `id` via
/// [`queue_job`], the way engine code does, and resolves to the first column
/// of every row as text (`null` for NULL). Used by the ordering tests in
/// `test/__rs/sqlite` to check that engine SQL shares the client's queue and
/// transaction connections.
#[napi]
pub fn sqlite_engine_query<'env>(env: &'env Env, id: u32, sql: String) -> Result<Object<'env>> {
  queue_job(env, id, move |session| {
    let to_napi = |e: payload_sqlite::ClientError| Error::new(Status::GenericFailure, e.to_string());
    let conn = session.conn().map_err(to_napi)?;
    let raw = conn.connection().map_err(to_napi)?;
    let to_napi_sql = |e: payload_sqlite::rusqlite::Error| Error::new(Status::GenericFailure, e.to_string());
    let mut stmt = raw.prepare(&sql).map_err(to_napi_sql)?;
    let rows = stmt
      .query_map([], |row| row.get::<_, Option<String>>(0).or_else(|_| row.get::<_, Option<f64>>(0).map(|n| n.map(|n| n.to_string()))))
      .map_err(to_napi_sql)?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(to_napi_sql)
  })
}
