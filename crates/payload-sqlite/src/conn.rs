//! One SQLite connection with the exact statement semantics of the `libsql`
//! native binding (`libsql@0.4.7`, `index.js` `Database` / `Statement`) as
//! driven by `executeStmt` / `executeMultiple` of
//! `@libsql/client/lib-esm/sqlite3.js`.
//!
//! Statements are prepared and stepped through the raw SQLite C API (via
//! `rusqlite::ffi`) so that every quirk can be reproduced: only the first
//! statement of a multi-statement string runs, empty SQL fails with
//! `SQLITE_OK: not an error`, JS numbers bind as REAL, text is read up to the
//! first NUL, `rowsAffected` uses the `total_changes` delta, ...

use std::ffi::{CStr, c_char, c_int};
use std::ptr;

use rusqlite::ffi;
use rusqlite::{Connection, OpenFlags};

use crate::error::{ClientError, Result, code_name};
use crate::value::{Args, BindValue, IntMode, ResultSet, SqlValue, Statement, value_from_sql};

/// A database handle (`new Database(path)` of the `libsql` binding).
pub struct Conn {
  conn: Option<Connection>,
  path: String,
  /// The SQLite handle was released early because the JS side can no longer
  /// observe it (a finished transaction); the binding still reports it open.
  retired: bool,
}

fn cstr_lossy(p: *const c_char) -> Option<String> {
  if p.is_null() {
    None
  } else {
    // SAFETY: SQLite returns NUL terminated strings that live until the next
    // call on the same statement/connection; we copy immediately.
    Some(unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned())
  }
}

/// Error message normalization hook kept for engine crates that call it.
/// The runtime now links the reference SQLite build (libSQL 3.45.1, see
/// `lib.rs`), so messages are already identical and this is the identity.
pub fn compat_message(message: String) -> String {
  message
}

/// Options of `new Database(path, opts)` that reach SQLite.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OpenOptions {
  /// `opts.encryptionKey` (UTF-8 bytes of the JS string). Empty means no
  /// encryption, as in the binding.
  pub encryption_key: Vec<u8>,
}

// SQLite3 Multiple Ciphers API (linked through `libsql-ffi`), used by
// `libsql_sys::connection::set_encryption_cipher` / `set_encryption_key`.
unsafe extern "C" {
  fn sqlite3mc_cipher_index(cipher_name: *const c_char) -> c_int;
  fn sqlite3mc_config(db: *mut ffi::sqlite3, param_name: *const c_char, new_value: c_int) -> c_int;
  fn sqlite3_key(db: *mut ffi::sqlite3, key: *const std::ffi::c_void, key_len: c_int) -> c_int;
}

/// Runs `sqlite3_initialize` once, to completion, before the first open.
/// SQLite marks itself initialized before it runs `SQLITE_EXTRA_INIT`
/// (`sqlite3mc_initialize`, which installs the encrypting VFS as default), so
/// a connection opened concurrently with the very first initialization could
/// miss that VFS and silently ignore its encryption key.
fn initialize_sqlite() {
  static INIT: std::sync::Once = std::sync::Once::new();
  // SAFETY: plain library initialization; idempotent.
  INIT.call_once(|| unsafe {
    ffi::sqlite3_initialize();
  });
}

/// Statements started on connections opened while `PAYLOAD_SQLITE_TRACE=true`
/// was set: `(sql, bound parameter count)` in run order, recorded between
/// [`start_statement_trace`] and [`take_statement_trace`]. A diagnostic for
/// differential tests (`test/__rs/adapter`): it shows the SQL the engine runs
/// on the client's connections, which bypasses `client.execute`.
static STATEMENT_TRACE: std::sync::Mutex<Option<Vec<(String, i32)>>> = std::sync::Mutex::new(None);

/// Starts (or restarts) recording [`STATEMENT_TRACE`].
pub fn start_statement_trace() {
  *STATEMENT_TRACE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Vec::new());
}

/// Stops recording and returns the statements recorded since
/// [`start_statement_trace`] (empty when it was not started).
pub fn take_statement_trace() -> Vec<(String, i32)> {
  STATEMENT_TRACE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take().unwrap_or_default()
}

/// `sqlite3_trace_v2` callback (`SQLITE_TRACE_STMT`: `p` is the statement,
/// `x` its unexpanded SQL; trigger sub-statements start with `--`).
unsafe extern "C" fn record_statement(
  mask: std::ffi::c_uint,
  _context: *mut std::ffi::c_void,
  p: *mut std::ffi::c_void,
  x: *mut std::ffi::c_void,
) -> c_int {
  if mask != ffi::SQLITE_TRACE_STMT as std::ffi::c_uint {
    return 0;
  }
  let Some(sql) = cstr_lossy(x as *const c_char) else { return 0 };
  if sql.starts_with("--") {
    return 0;
  }
  let mut trace = STATEMENT_TRACE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  if let Some(statements) = trace.as_mut() {
    // SAFETY: SQLite passes the running statement.
    let count = unsafe { ffi::sqlite3_bind_parameter_count(p as *mut ffi::sqlite3_stmt) };
    statements.push((sql, count));
  }
  0
}

/// Finalizes a prepared statement on drop.
struct StmtGuard(*mut ffi::sqlite3_stmt);

impl Drop for StmtGuard {
  fn drop(&mut self) {
    // SAFETY: the pointer came from `sqlite3_prepare_v2` and is finalized once.
    unsafe {
      ffi::sqlite3_finalize(self.0);
    }
  }
}

impl Conn {
  /// [`Conn::open_with`] without options.
  pub fn open(path: &str) -> Result<Self> {
    Self::open_with(path, &OpenOptions::default())
  }

  /// Opens a database like `new Database(path, opts)` of the `libsql` binding
  /// (`libsql::Database::connect` for a local file): `sqlite3_open_v2` with
  /// read/write/create/URI flags, then, with an encryption key, the
  /// `aes256cbc` cipher and `sqlite3_key`. `rusqlite` installs a 5s busy
  /// timeout on open; libsql leaves SQLite's default of 0, so it is reset.
  pub fn open_with(path: &str, options: &OpenOptions) -> Result<Self> {
    let open_failed = |rc: i32| ClientError::Error {
      message: format!(
        "ConnectionFailed({:?})",
        format!("Unable to open connection to local database {path}: {rc}")
      ),
      code: Some(String::new()),
    };
    let misuse = |what: &str| ClientError::Error { message: format!("Misuse({what:?})"), code: Some(String::new()) };
    initialize_sqlite();
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_URI;
    let conn = Connection::open_with_flags(path, flags).map_err(|e| match e {
      rusqlite::Error::SqliteFailure(f, _) => open_failed(f.extended_code & 0xff),
      _ => open_failed(ffi::SQLITE_CANTOPEN),
    })?;
    conn.busy_timeout(std::time::Duration::ZERO).map_err(|_| open_failed(ffi::SQLITE_ERROR))?;
    if std::env::var("PAYLOAD_SQLITE_TRACE").is_ok_and(|v| v == "true") {
      // SAFETY: live connection handle; the callback only reads its arguments.
      unsafe {
        let mask = ffi::SQLITE_TRACE_STMT as std::ffi::c_uint;
        ffi::sqlite3_trace_v2(conn.handle(), mask, Some(record_statement), ptr::null_mut());
      }
    }
    // `Builder::new_local(":memory:")` builds a memory database, which never
    // applies the encryption config.
    if !options.encryption_key.is_empty() && path != ":memory:" {
      let key_len = c_int::try_from(options.encryption_key.len()).map_err(|_| misuse("failed to set encryption key"))?;
      // SAFETY: live connection handle, NUL terminated names, `key_len`
      // readable bytes at the key pointer.
      unsafe {
        let db = conn.handle();
        let cipher = sqlite3mc_cipher_index(c"aes256cbc".as_ptr());
        if sqlite3mc_config(db, c"default:cipher".as_ptr(), cipher) == -1 {
          return Err(misuse("failed to set encryption cipher"));
        }
        if sqlite3_key(db, options.encryption_key.as_ptr().cast(), key_len) != ffi::SQLITE_OK {
          return Err(misuse("failed to set encryption key"));
        }
      }
    }
    Ok(Self { conn: Some(conn), path: path.to_string(), retired: false })
  }

  pub fn path(&self) -> &str {
    &self.path
  }

  /// Whether a SQLite handle is open (not closed and not retired).
  pub fn has_handle(&self) -> bool {
    self.conn.is_some()
  }

  /// The underlying `rusqlite` connection, for engine code that runs its own
  /// statements on this connection (from a [`crate::worker`] job).
  pub fn connection(&self) -> Result<&Connection> {
    self.conn.as_ref().ok_or_else(ClientError::connection_not_open)
  }

  /// `db.open` of the binding.
  pub fn is_open(&self) -> bool {
    self.conn.is_some() || self.retired
  }

  /// `db.close()`.
  pub fn close(&mut self) {
    self.conn = None;
    self.retired = false;
  }

  /// Releases the SQLite handle of a transaction connection that is no
  /// longer inside a transaction. Every `Sqlite3Transaction` method checks
  /// `inTransaction` first, so such a handle can never be used again; the
  /// `libsql` binding only frees it on garbage collection.
  pub fn retire(&mut self) {
    if self.conn.is_some() && !self.in_transaction() {
      self.conn = None;
      self.retired = true;
    }
  }

  fn db(&self) -> Result<*mut ffi::sqlite3> {
    match &self.conn {
      // SAFETY: the handle stays valid while `self.conn` is alive.
      Some(c) => Ok(unsafe { c.handle() }),
      None => Err(ClientError::connection_not_open()),
    }
  }

  /// `db.inTransaction`.
  pub fn in_transaction(&self) -> bool {
    match &self.conn {
      Some(c) => !c.is_autocommit(),
      None => false,
    }
  }

  fn last_error(db: *mut ffi::sqlite3) -> (String, String, i32) {
    // SAFETY: `db` is a live connection handle.
    let (raw, msg) = unsafe { (ffi::sqlite3_extended_errcode(db), cstr_lossy(ffi::sqlite3_errmsg(db))) };
    (msg.unwrap_or_default(), code_name(raw), raw)
  }

  fn sqlite_error(db: *mut ffi::sqlite3) -> ClientError {
    let (message, code, raw_code) = Self::last_error(db);
    ClientError::Sqlite { message, code, raw_code }
  }

  fn native_error(db: *mut ffi::sqlite3) -> ClientError {
    let (message, code, raw_code) = Self::last_error(db);
    ClientError::Native { message, code, raw_code }
  }

  /// `db.prepare(sql)`: compiles the first statement of `sql`.
  fn prepare(&self, sql: &str) -> Result<(*mut ffi::sqlite3, StmtGuard)> {
    let db = self.db()?;
    let mut stmt = ptr::null_mut();
    let len = c_int::try_from(sql.len()).map_err(|_| ClientError::Sqlite {
      message: "string or blob too big".to_string(),
      code: code_name(ffi::SQLITE_TOOBIG),
      raw_code: ffi::SQLITE_TOOBIG,
    })?;
    // SAFETY: `sql` outlives the call; SQLite copies what it needs.
    let rc = unsafe { ffi::sqlite3_prepare_v2(db, sql.as_ptr().cast(), len, &mut stmt, ptr::null_mut()) };
    if rc != ffi::SQLITE_OK || stmt.is_null() {
      // Empty SQL leaves `stmt` NULL with SQLITE_OK -> "SQLITE_OK: not an error".
      let err = Self::sqlite_error(db);
      if !stmt.is_null() {
        drop(StmtGuard(stmt));
      }
      return Err(err);
    }
    Ok((db, StmtGuard(stmt)))
  }

  fn bind(stmt: *mut ffi::sqlite3_stmt, index: c_int, value: &BindValue) -> c_int {
    // SAFETY: `stmt` is a live prepared statement, `index` is in range and
    // SQLITE_TRANSIENT makes SQLite copy text/blob data.
    unsafe {
      match value {
        BindValue::Null | BindValue::Invalid => ffi::sqlite3_bind_null(stmt, index),
        BindValue::Real(f) => ffi::sqlite3_bind_double(stmt, index, *f),
        BindValue::Integer(i) => ffi::sqlite3_bind_int64(stmt, index, *i),
        BindValue::Text(s) => {
          ffi::sqlite3_bind_text64(stmt, index, s.as_ptr().cast(), s.len() as u64, ffi::SQLITE_TRANSIENT(), ffi::SQLITE_UTF8 as u8)
        }
        BindValue::Blob(b) => ffi::sqlite3_bind_blob64(stmt, index, b.as_ptr().cast(), b.len() as u64, ffi::SQLITE_TRANSIENT()),
      }
    }
  }

  fn bind_args(db: *mut ffi::sqlite3, stmt: *mut ffi::sqlite3_stmt, args: &Args, native: bool) -> Result<()> {
    if args.values().any(|v| matches!(v, BindValue::Invalid)) {
      return Err(ClientError::invalid_bind());
    }
    // SAFETY: live statement.
    let count = unsafe { ffi::sqlite3_bind_parameter_count(stmt) };
    let fail = || if native { Self::native_error(db) } else { Self::sqlite_error(db) };
    match args {
      Args::Positional(values) => {
        for (i, value) in values.iter().enumerate().take(count as usize) {
          let rc = Self::bind(stmt, i as c_int + 1, value);
          if rc != ffi::SQLITE_OK {
            return Err(fail());
          }
        }
      }
      Args::Named(values) => {
        for index in 1..=count {
          // SAFETY: live statement, index in range.
          let Some(name) = cstr_lossy(unsafe { ffi::sqlite3_bind_parameter_name(stmt, index) }) else {
            continue;
          };
          let key: String = name.chars().skip(1).collect();
          if let Some((_, value)) = values.iter().rev().find(|(k, _)| *k == key) {
            let rc = Self::bind(stmt, index, value);
            if rc != ffi::SQLITE_OK {
              return Err(fail());
            }
          }
        }
      }
    }
    Ok(())
  }

  fn read_column(stmt: *mut ffi::sqlite3_stmt, i: c_int) -> SqlValue {
    // SAFETY: `stmt` has a current row and `i` is a valid column index; the
    // returned pointers are valid until the next step and are copied.
    unsafe {
      match ffi::sqlite3_column_type(stmt, i) {
        ffi::SQLITE_INTEGER => SqlValue::Integer(ffi::sqlite3_column_int64(stmt, i)),
        ffi::SQLITE_FLOAT => SqlValue::Real(ffi::sqlite3_column_double(stmt, i)),
        ffi::SQLITE_TEXT => {
          let p = ffi::sqlite3_column_text(stmt, i);
          let n = ffi::sqlite3_column_bytes(stmt, i) as usize;
          let bytes = if p.is_null() { &[][..] } else { std::slice::from_raw_parts(p, n) };
          // The binding reads text as a C string: stop at the first NUL.
          let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
          SqlValue::Text(String::from_utf8_lossy(&bytes[..end]).into_owned())
        }
        ffi::SQLITE_BLOB => {
          let p = ffi::sqlite3_column_blob(stmt, i);
          let n = ffi::sqlite3_column_bytes(stmt, i) as usize;
          SqlValue::Blob(if p.is_null() { Vec::new() } else { std::slice::from_raw_parts(p.cast::<u8>(), n).to_vec() })
        }
        _ => SqlValue::Null,
      }
    }
  }

  /// `sqlite3_bind_parameter_name` of every parameter of the first statement
  /// of `sql` (`None` for nameless `?` parameters), as read by the binding's
  /// `convert_params_object` after `db.prepare(sql)`. Prepare errors are the
  /// ones `executeStmt` reports.
  pub fn parameter_names(&self, sql: &str) -> Result<Vec<Option<String>>> {
    let (_, guard) = self.prepare(sql)?;
    // SAFETY: live statement; indexes are in range.
    let count = unsafe { ffi::sqlite3_bind_parameter_count(guard.0) };
    Ok((1..=count).map(|i| cstr_lossy(unsafe { ffi::sqlite3_bind_parameter_name(guard.0, i) })).collect())
  }

  /// Port of `executeStmt(db, stmt, intMode)` (libsql-client `sqlite3.ts`).
  pub fn execute(&self, stmt: &Statement, int_mode: IntMode) -> Result<ResultSet> {
    if let Some(err) = &stmt.error {
      return Err(err.clone());
    }
    let (db, guard) = self.prepare(&stmt.sql)?;
    let raw = guard.0;
    // SAFETY: live statement.
    let column_count = unsafe { ffi::sqlite3_column_count(raw) };
    if column_count > 0 {
      // `sqlStmt.raw(true)` succeeded: the statement returns data.
      let mut columns = Vec::with_capacity(column_count as usize);
      let mut column_types = Vec::with_capacity(column_count as usize);
      for i in 0..column_count {
        // SAFETY: valid column index of a live statement.
        unsafe {
          columns.push(cstr_lossy(ffi::sqlite3_column_name(raw, i)).unwrap_or_default());
          column_types.push(cstr_lossy(ffi::sqlite3_column_decltype(raw, i)).unwrap_or_default());
        }
      }
      // `sqlStmt.all(args)`: errors here are not converted by the binding.
      Self::bind_args(db, raw, &stmt.args, true)?;
      let mut raw_rows = Vec::new();
      loop {
        // SAFETY: live statement.
        match unsafe { ffi::sqlite3_step(raw) } {
          ffi::SQLITE_ROW => {
            raw_rows.push((0..column_count).map(|i| Self::read_column(raw, i)).collect::<Vec<_>>());
          }
          ffi::SQLITE_DONE => break,
          _ => return Err(Self::native_error(db)),
        }
      }
      drop(guard);
      let rows = raw_rows
        .into_iter()
        .map(|row| row.into_iter().map(|v| value_from_sql(v, int_mode)).collect::<Result<Vec<_>>>())
        .collect::<Result<Vec<_>>>()?;
      Ok(ResultSet { columns, column_types, rows, rows_affected: 0, last_insert_rowid: None })
    } else {
      // `sqlStmt.run(args)`: errors are converted to `SqliteError`.
      Self::bind_args(db, raw, &stmt.args, false)?;
      // SAFETY: live connection/statement.
      let before = unsafe { ffi::sqlite3_total_changes64(db) };
      loop {
        // SAFETY: live statement.
        match unsafe { ffi::sqlite3_step(raw) } {
          ffi::SQLITE_ROW => continue,
          ffi::SQLITE_DONE => break,
          _ => return Err(Self::sqlite_error(db)),
        }
      }
      drop(guard);
      // SAFETY: live connection.
      let (after, changes, rowid) =
        unsafe { (ffi::sqlite3_total_changes64(db), ffi::sqlite3_changes64(db), ffi::sqlite3_last_insert_rowid(db)) };
      let rows_affected = if after == before { 0 } else { changes };
      Ok(ResultSet {
        columns: Vec::new(),
        column_types: Vec::new(),
        rows: Vec::new(),
        rows_affected,
        last_insert_rowid: Some(rowid),
      })
    }
  }

  /// `executeStmt(db, sql)` for a plain SQL string.
  pub fn execute_sql(&self, sql: &str, int_mode: IntMode) -> Result<ResultSet> {
    self.execute(&Statement::sql(sql), int_mode)
  }

  /// Port of `executeMultiple(db, sql)` (`db.exec(sql)` of the binding).
  pub fn exec(&self, sql: &str) -> Result<()> {
    let db = self.db()?;
    // The binding passes a C string: SQL after an embedded NUL is ignored.
    let end = sql.as_bytes().iter().position(|&b| b == 0).unwrap_or(sql.len());
    let csql = std::ffi::CString::new(&sql.as_bytes()[..end]).map_err(|_| Self::sqlite_error(db))?;
    let mut errmsg: *mut c_char = ptr::null_mut();
    // SAFETY: live connection, NUL terminated SQL, no callback.
    let rc = unsafe { ffi::sqlite3_exec(db, csql.as_ptr(), None, ptr::null_mut(), &mut errmsg) };
    if rc != ffi::SQLITE_OK {
      let message = cstr_lossy(errmsg);
      // SAFETY: `errmsg` was allocated by SQLite (or is NULL).
      unsafe { ffi::sqlite3_free(errmsg.cast()) };
      let (fallback, code, raw_code) = Self::last_error(db);
      return Err(ClientError::Sqlite { message: message.unwrap_or(fallback), code, raw_code });
    }
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::value::Cell;

  fn mem() -> Conn {
    Conn::open("file::memory:").unwrap()
  }

  #[test]
  fn statement_trace_records_traced_connections() {
    // SAFETY: tests only read this variable while opening, and a stray traced connection of
    // another test only adds entries the filter below drops.
    unsafe { std::env::set_var("PAYLOAD_SQLITE_TRACE", "true") };
    let traced = mem();
    unsafe { std::env::remove_var("PAYLOAD_SQLITE_TRACE") };
    let untraced = mem();
    start_statement_trace();
    traced
      .execute(&Statement::with_args("select ?, ? -- trace-test", vec![BindValue::Integer(1), BindValue::Null]), IntMode::Number)
      .unwrap();
    untraced.execute_sql("select 1 -- trace-test untraced", IntMode::Number).unwrap();
    let recorded: Vec<_> = take_statement_trace().into_iter().filter(|(sql, _)| sql.contains("trace-test")).collect();
    assert_eq!(recorded, vec![("select ?, ? -- trace-test".to_string(), 2)]);
    traced.execute_sql("select 2 -- trace-test after", IntMode::Number).unwrap();
    assert!(take_statement_trace().is_empty());
  }

  #[test]
  fn numbers_bind_as_real() {
    let c = mem();
    let r = c
      .execute(
        &Statement::with_args("select typeof(?), typeof(?)", vec![BindValue::Real(1.0), BindValue::Integer(1)]),
        IntMode::Number,
      )
      .unwrap();
    assert_eq!(r.rows[0], vec![Cell::String("real".into()), Cell::String("integer".into())]);
  }

  #[test]
  fn empty_sql_is_not_an_error_error() {
    let err = mem().execute_sql("  ", IntMode::Number).unwrap_err();
    assert_eq!(err, ClientError::Sqlite { message: "not an error".into(), code: "SQLITE_OK".into(), raw_code: 0 });
  }

  #[test]
  fn only_first_statement_runs() {
    let c = mem();
    c.execute_sql("create table a(x); create table b(x)", IntMode::Number).unwrap();
    let r = c.execute_sql("select name from sqlite_master", IntMode::Number).unwrap();
    assert_eq!(r.rows.len(), 1);
  }

  #[test]
  fn defaults_match_libsql() {
    let c = mem();
    let r = c.execute_sql("PRAGMA foreign_keys", IntMode::Number).unwrap();
    assert_eq!(r.rows[0][0], Cell::Number(1.0));
    let r = c.execute_sql("PRAGMA busy_timeout", IntMode::Number).unwrap();
    assert_eq!(r.rows[0][0], Cell::Number(0.0));
    let err = c.execute_sql("select \"nope\"", IntMode::Number).unwrap_err();
    assert_eq!(err.js_message(), "SQLITE_ERROR: no such column: nope");
  }

  /// The linked SQLite is the reference build (see lib.rs).
  #[test]
  fn links_the_libsql_build() {
    let r = mem()
      .execute_sql(
        "select sqlite_version(), sqlite_source_id(), sqlite3mc_version(), regexp('a', 'abc'), median(1)",
        IntMode::Number,
      )
      .unwrap();
    assert_eq!(
      r.rows[0],
      vec![
        Cell::String("3.45.1".into()),
        Cell::String("2024-01-30 16:01:20 e876e51a0ed5c5b3126f52e532044363a014bc594cfefa87ffb5b82257ccalt1".into()),
        Cell::String("SQLite3 Multiple Ciphers 1.8.1".into()),
        Cell::Number(1.0),
        Cell::Number(1.0),
      ]
    );
  }

  #[test]
  fn encryption_key_round_trip() {
    let path = std::env::temp_dir().join(format!("payload-sqlite-enc-{}.db", std::process::id()));
    let path = path.to_string_lossy().into_owned();
    let _ = std::fs::remove_file(&path);
    let key = OpenOptions { encryption_key: b"a\0b".to_vec() };
    let c = Conn::open_with(&path, &key).unwrap();
    c.execute_sql("create table t(a)", IntMode::Number).unwrap();
    drop(c);
    let header = std::fs::read(&path).unwrap();
    assert_ne!(&header[..16], b"SQLite format 3\0");
    let read = |options: &OpenOptions| {
      Conn::open_with(&path, options).unwrap().execute_sql("select count(*) from t", IntMode::Number)
    };
    assert_eq!(read(&key).unwrap().rows[0][0], Cell::Number(0.0));
    let wrong = OpenOptions { encryption_key: b"a".to_vec() };
    for options in [OpenOptions::default(), wrong] {
      let err = read(&options).unwrap_err();
      assert_eq!(err, ClientError::Sqlite { message: "file is not a database".into(), code: "SQLITE_NOTADB".into(), raw_code: 26 });
    }
    let _ = std::fs::remove_file(&path);
  }

  #[test]
  fn parameter_names_of_the_first_statement() {
    let names = mem().parameter_names("select :a, ?, @b, $c::d(e), ?5, :a; select :z").unwrap();
    let expected = [Some(":a"), None, Some("@b"), Some("$c::d(e)"), Some("?5")];
    assert_eq!(names, expected.map(|n| n.map(str::to_string)).to_vec());
    assert_eq!(mem().parameter_names("").unwrap_err().js_message(), "SQLITE_OK: not an error");
  }

  #[test]
  fn reader_step_errors_are_native() {
    let c = mem();
    c.execute_sql("create table t(a unique)", IntMode::Number).unwrap();
    c.execute_sql("insert into t values (1)", IntMode::Number).unwrap();
    let err = c.execute_sql("insert into t values (1) returning a", IntMode::Number).unwrap_err();
    assert!(matches!(err, ClientError::Native { raw_code: 2067, .. }));
    let err = c.execute_sql("insert into t values (1)", IntMode::Number).unwrap_err();
    assert!(matches!(err, ClientError::Sqlite { raw_code: 2067, .. }));
  }
}
