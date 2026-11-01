//! napi bindings for the Rust SQLite runtime (`payload-sqlite`).
//!
//! Consumed by `packages/engine-rs/src/sqlite/native.ts`. Every function
//! returns (or resolves to) an envelope `{ ok: value }` / `{ error: {...} }` so
//! the TS glue can rebuild the exact error objects of `@libsql/client`.
//!
//! Database work runs on the process-wide ordered queue of
//! `payload_sqlite::worker` (one worker thread) and settles a promise through
//! a napi deferred. The `*Sync` functions (and `sqliteCreateClient`) block the
//! JS thread until earlier queued work and their own step are done, like the
//! synchronous `libsql` binding; the TS glue uses them where upstream
//! interleaves JS evaluation with statement execution (batches, named
//! parameter lookup, the `closed` getter).
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
use payload_sqlite::conn::OpenOptions;
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

/// `BigInt(n)` of a JS number `n` that holds an integer value.
unsafe fn js_bigint_from_integral_f64(env: sys::napi_env, n: f64) -> Result<sys::napi_value> {
  // Every integral f64 converted from an i64 lies in [-2^63, 2^63].
  let magnitude = n.abs() as u64 as u128 + u128::from(n.abs() >= 18_446_744_073_709_551_616.0);
  let words = [magnitude as u64, (magnitude >> 64) as u64];
  let count = if words[1] == 0 { 1 } else { 2 };
  let mut out = ptr::null_mut();
  check!(unsafe { sys::napi_create_bigint_words(env, i32::from(n < 0.0), count, words.as_ptr(), &mut out) });
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
      let bytes = |data: *mut std::ffi::c_void, len: usize| {
        if len == 0 || data.is_null() {
          Vec::new()
        } else {
          // SAFETY: napi reports `len` readable bytes at `data`.
          unsafe { std::slice::from_raw_parts(data.cast::<u8>(), len) }.to_vec()
        }
      };
      match kind {
        // neon's `JsUint8Array` (`Buffer`, `Uint8Array`, `Uint8ClampedArray`):
        // the viewed bytes.
        sys::TypedarrayType::uint8_array | sys::TypedarrayType::uint8_clamped_array => BindValue::Blob(bytes(data, len)),
        // `JsFloat32Array`: `v.buffer(cx).as_slice(cx)`, the whole underlying
        // ArrayBuffer regardless of the view's offset and length.
        sys::TypedarrayType::float32_array => {
          let mut ab_data: *mut std::ffi::c_void = ptr::null_mut();
          let mut ab_len = 0usize;
          check!(unsafe { sys::napi_get_arraybuffer_info(env, ab, &mut ab_data, &mut ab_len) });
          BindValue::Blob(bytes(ab_data, ab_len))
        }
        _ => BindValue::Invalid,
      }
    }
    _ => BindValue::Invalid,
  })
}

/// A normalized `InStatement` coming from `packages/engine-rs/src/sqlite`:
/// `{ sql, args?: unknown[], error?: [kind, message] }`. Named arguments are
/// resolved to positional values by the TS glue (see `executeConvertedSync`).
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
      Ok(JsStatement(Statement { sql, args: Args::Positional(values), error }))
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
  Names(Vec<Option<String>>),
}

/// `{ ok: value }` or `{ error: { kind, message, code?, rawCode? } }`.
/// A client call's result, plus the statements its failed steps left active (see
/// `payload_sqlite::conn::with_statement_retention`). Each is handed to JS as `retained[i]`, a
/// napi external whose native finalizer finalizes the statement: the same kind of object as the
/// binding's `Statement`, which `executeStmt` drops at once and V8 collects in its own time.
pub struct Outcome(std::result::Result<Value, ClientError>, Vec<u64>);

impl<T: Into<Value>> From<payload_sqlite::Result<T>> for Outcome {
  fn from(r: payload_sqlite::Result<T>) -> Self {
    Outcome(r.map(Into::into), Vec::new())
  }
}

/// Runs a client call's statements with the binding's statement lifetime.
fn retaining(f: impl FnOnce() -> Outcome) -> Outcome {
  let (mut outcome, retained) = payload_sqlite::conn::with_statement_retention(f);
  outcome.1.extend(retained);
  outcome
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
impl From<Vec<Option<String>>> for Value {
  fn from(names: Vec<Option<String>>) -> Self {
    Value::Names(names)
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
    // `BigInt(info.lastInsertRowid)`: the binding returns the rowid as a JS
    // number (`cx.number(last_insert_rowid as f64)`), so it is rounded.
    let rowid = match rs.last_insert_rowid {
      Some(id) => js_bigint_from_integral_f64(env, id as f64)?,
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
            Value::Names(names) => {
              let arr = js_array(env, names.len())?;
              for (i, name) in names.iter().enumerate() {
                let v = match name {
                  Some(name) => js_string(env, name)?,
                  None => js_null(env)?,
                };
                set_index(env, arr, i, v)?;
              }
              arr
            }
          };
          set(env, obj, "ok", v)?;
        }
        Err(err) => set(env, obj, "error", error_to_js(env, err)?)?,
      }
      if !val.1.is_empty() {
        let arr = js_array(env, val.1.len())?;
        for (i, id) in val.1.iter().enumerate() {
          set_index(env, arr, i, retained_statement_external(env, *id)?)?;
        }
        set(env, obj, "retained", arr)?;
      }
      Ok(obj)
    }
  }
}

/// A napi external owning kept statement `id`; its finalizer queues the statement's finalization.
unsafe fn retained_statement_external(env: sys::napi_env, id: u64) -> Result<sys::napi_value> {
  unsafe extern "C" fn finalize(_env: sys::napi_env, data: *mut std::ffi::c_void, _hint: *mut std::ffi::c_void) {
    // SAFETY: `data` is the `Box<u64>` leaked below, finalized once.
    let id = unsafe { Box::from_raw(data.cast::<u64>()) };
    worker::release_statement(*id);
  }
  let data = Box::into_raw(Box::new(id));
  let mut value = std::ptr::null_mut();
  // SAFETY: live env; on failure the box is reclaimed and the statement released at once.
  let status = unsafe { sys::napi_create_external(env, data.cast(), Some(finalize), std::ptr::null_mut(), &mut value) };
  if status != sys::Status::napi_ok {
    // SAFETY: not handed to napi.
    drop(unsafe { Box::from_raw(data) });
    worker::release_statement(id);
    return Err(Error::new(Status::GenericFailure, "could not create a statement handle"));
  }
  Ok(value)
}

fn int_mode(mode: &str) -> IntMode {
  IntMode::parse(mode).unwrap_or_default()
}

type Resolver<T> = Box<dyn FnOnce(Env) -> Result<T> + Send>;

/// Runs `job` on the ordered queue of connection `id` (see
/// `payload_sqlite::worker`) and returns a promise of its result; an `Err`
/// rejects the promise. The job runs after every job queued earlier for any
/// id, and alone, so Rust engine code
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
    let outcome = retaining(|| job(session));
    if retire {
      session.retire_finished_transaction();
    }
    if let Some(d) = pending_job.lock().ok().and_then(|mut g| g.take()) {
      d.resolve(Box::new(move |_| Ok(outcome)));
    }
  });
  if let Err(err) = submitted {
    if let Some(d) = pending.lock().ok().and_then(|mut g| g.take()) {
      d.resolve(Box::new(move |_| Ok(Outcome(Err(err), Vec::new()))));
    }
  }
  Ok(promise)
}

// ---------------------------------------------------------------------------
// exported functions

/// `createClient(config)`: resolves the URL, then opens the database
/// (`new Database(path, opts)`: open, cipher, key) and runs
/// `SELECT 1 AS checkThatTheDatabaseCanBeOpened` as one job on the queue,
/// blocking the JS thread: like the synchronous binding, both run after every
/// earlier call (e.g. an un-awaited `commit()`) and errors surface
/// synchronously.
/// Returns `{ ok: { id, path, intMode } }`; `id` addresses the client.
/// `encryption_key` is `config.encryptionKey ?? ""` when that is a string;
/// the `is_*_valid` flags tell whether `authToken` / `encryptionKey` are
/// strings or nullish (see `ClientConfig`).
#[napi]
pub fn sqlite_create_client(
  url: String,
  int_mode_json: String,
  sync_url: bool,
  is_auth_token_valid: bool,
  encryption_key: String,
  is_encryption_key_valid: bool,
) -> Result<CreatedClient> {
  let config =
    ClientConfig { url, int_mode_json, sync_url, is_auth_token_valid, encryption_key, is_encryption_key_valid };
  let created = (|| -> payload_sqlite::Result<CreatedClientData> {
    let target = resolve_config(&config)?;
    let options: OpenOptions = target.options.clone();
    let id = worker::register_unopened_client(&target.path, options);
    let check_mode = target.int_mode;
    // `conn()` opens the unopened client's `#db`
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

/// Runs `f` on the queue after all earlier work and blocks the JS thread
/// until it is done; transaction connections that left their transaction
/// are released afterwards.
fn call_sync<T: Into<Value>>(
  id: ConnId,
  f: impl FnOnce(&mut Session<'_>) -> payload_sqlite::Result<T> + Send + 'static,
) -> Outcome
where
  T: Send + 'static,
{
  let result = worker::call(id, move |session| {
    let outcome = retaining(|| f(session).into());
    session.retire_finished_transaction();
    outcome
  });
  match result {
    Ok(outcome) => outcome,
    Err(e) => Outcome(Err(e), Vec::new()),
  }
}

/// `executeStmt(db, stmt)` on the client's `#getDb()` / the transaction's
/// `#database`, synchronously (one step of a batch or migration).
#[napi]
pub fn sqlite_execute_sync(id: u32, stmt: JsStatement, int_mode_name: String) -> Outcome {
  let mode = int_mode(&int_mode_name);
  call_sync(id, move |session| session.conn()?.execute(&stmt.0, mode))
}

/// `db.prepare(sql)` followed by the parameter names the binding looks up in
/// a named-arguments object (`null` for nameless parameters), synchronously.
#[napi]
pub fn sqlite_parameter_names_sync(id: u32, sql: String) -> Outcome {
  call_sync(id, move |session| session.conn()?.parameter_names(&sql))
}

/// `#getDb()` of a client (opens `#db` if a transaction detached it),
/// synchronously.
#[napi]
pub fn sqlite_get_db_sync(id: u32) -> Outcome {
  call_sync(id, |session| session.conn().map(|_| ()))
}

/// `db.inTransaction` (the `Sqlite3Transaction.closed` getter), evaluated
/// after all queued work. Blocks the JS thread.
#[napi]
pub fn sqlite_in_transaction(id: u32) -> Outcome {
  match worker::call(id, |session| session.conn().map(|conn| conn.in_transaction())) {
    Ok(r) => r.into(),
    Err(e) => Outcome(Err(e), Vec::new()),
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

/// Starts recording the statements of connections opened with
/// `PAYLOAD_SQLITE_TRACE=true` (`payload_sqlite::conn::start_statement_trace`).
#[napi]
pub fn sqlite_start_statement_trace() {
  payload_sqlite::conn::start_statement_trace();
}

/// The `[sql, bound parameter count]` of every statement recorded since
/// `sqliteStartStatementTrace`, in run order; stops recording.
#[napi]
pub fn sqlite_take_statement_trace() -> Vec<(String, i32)> {
  payload_sqlite::conn::take_statement_trace()
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
