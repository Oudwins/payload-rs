//! Executes the statements of the find module the way drizzle's libsql
//! session does (`libsql/session.js` `LibSQLPreparedQuery`) and maps the rows
//! like drizzle's `mapRelationalRow` (`relations.js`): nested relations are
//! `JSON.parse`d, every other value goes through drizzle's
//! `normalizeFieldValue` and its column's `mapFromDriverValue`.
//!
//! Statements run through an [`Executor`]. [`LibsqlConn`] (inside a
//! `payload-sqlite` worker job) and [`QueuedConn`] (one queued job per
//! statement, by `ConnId`) use `payload-sqlite`'s port of libsql's
//! `executeStmt`, so binding, value conversion and error shapes are libsql's,
//! and the statements share the connection (and transaction) of the TS client
//! that backs `payload.db.drizzle`. Driver errors are wrapped into
//! `DrizzleQueryError`s ([`drizzle_query_error`]) exactly where drizzle's
//! `queryWithCache` wraps them; row mapping errors are not wrapped.
//!
//! The `*_js` functions produce [`JsVal`]s (`undefined`, `Date`s and `bigint`s
//! keep their JS type). The older `Json` functions are kept as wrappers and
//! return what `JSON.stringify` would make of the JS value.

use payload_engine::error::{EngineError, Result};
use payload_engine::host::{Host, NoHost};
use payload_engine::js::{JsVal, Obj, TypedValue, encode_value, num_to_js_string, num_to_json};
use payload_sql_read::jsops::is_js_whitespace;
use payload_sqlite::client;
use payload_sqlite::error::code_name;
use payload_sqlite::worker::{self, ConnId, Session};
use payload_sqlite::{BindValue, Cell, ClientError, Conn, IntMode, Statement};
use rusqlite::types::{Value as SqlValue, ValueRef};
use serde_json::{Map, Value as Json, json};

use crate::relational::{BuiltRelationalQuery, Mode, SelectionItem, SelectionKind};
use crate::schema::Decoder;
use crate::sql::{Param, Sql};

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

/// What drizzle's libsql session runs a statement on (`this.tx ?? this.client`).
pub trait Executor {
  /// `(tx ?? client).execute({ sql, args: params })`: the rows of the
  /// statement, as libsql's `valueFromSql` produced them.
  fn query_cells(&self, sql: &Sql) -> std::result::Result<Vec<Vec<Cell>>, ClientError>;
}

impl<E: Executor + ?Sized> Executor for &E {
  fn query_cells(&self, sql: &Sql) -> std::result::Result<Vec<Vec<Cell>>, ClientError> {
    (**self).query_cells(sql)
  }
}

/// `valueToSql` of `@libsql/client` for the parameter values the find module
/// produces (JS numbers and booleans bind as REAL, objects cannot be bound).
pub fn bind_value(param: &Param) -> BindValue {
  match param {
    Json::Null => BindValue::Null,
    Json::Bool(b) => BindValue::Real(if *b { 1.0 } else { 0.0 }),
    Json::Number(n) => BindValue::Real(n.as_f64().unwrap_or(f64::NAN)),
    Json::String(s) => BindValue::Text(s.clone()),
    Json::Array(_) | Json::Object(_) => BindValue::Invalid,
  }
}

/// The libsql statement for `sql` (`{ sql, args: params }`).
pub fn statement(sql: &Sql) -> Statement {
  Statement::with_args(sql.sql.clone(), sql.params.iter().map(bind_value).collect())
}

fn run_on_conn(
  conn: &Conn,
  in_transaction: bool,
  stmt: &Statement,
  int_mode: IntMode,
) -> std::result::Result<Vec<Vec<Cell>>, ClientError> {
  let result = if in_transaction { client::tx_execute(conn, stmt, int_mode)? } else { conn.execute(stmt, int_mode)? };
  Ok(result.rows)
}

/// A `payload-sqlite` connection seen from inside a worker job: the client's
/// current connection (`client.execute`) or a transaction's connection
/// (`tx.execute`, which first checks that the transaction is still open).
pub struct LibsqlConn<'a> {
  pub conn: &'a Conn,
  pub in_transaction: bool,
  /// The client's `intMode` (Payload uses the default, `number`).
  pub int_mode: IntMode,
}

impl<'a> LibsqlConn<'a> {
  /// The connection a job for `session.id()` addresses (`#getDb()` of a
  /// client, or the transaction's connection).
  pub fn from_session(session: &'a mut Session<'_>, int_mode: IntMode) -> std::result::Result<Self, ClientError> {
    let in_transaction = session.is_transaction();
    let conn: &'a Conn = session.conn()?;
    Ok(Self { conn, in_transaction, int_mode })
  }
}

impl Executor for LibsqlConn<'_> {
  fn query_cells(&self, sql: &Sql) -> std::result::Result<Vec<Vec<Cell>>, ClientError> {
    run_on_conn(self.conn, self.in_transaction, &statement(sql), self.int_mode)
  }
}

/// A `payload-sqlite` client or transaction id used from outside the worker:
/// every statement is queued as its own job (in call order with everything
/// else queued for that database file, like separate `await`ed
/// `client.execute` calls) and waited for. Must not be used from inside a
/// worker job (`worker::call` returns an error there instead of deadlocking).
#[derive(Clone, Copy, Debug)]
pub struct QueuedConn {
  pub id: ConnId,
  pub int_mode: IntMode,
}

impl Executor for QueuedConn {
  fn query_cells(&self, sql: &Sql) -> std::result::Result<Vec<Vec<Cell>>, ClientError> {
    let stmt = statement(sql);
    let int_mode = self.int_mode;
    worker::call(self.id, move |session| {
      let in_transaction = session.is_transaction();
      let result = session.conn().and_then(|conn| run_on_conn(conn, in_transaction, &stmt, int_mode));
      if in_transaction {
        session.retire_finished_transaction();
      }
      result
    })?
  }
}

/// A plain `rusqlite` connection. Kept for callers that predate the
/// `payload-sqlite` executors; it binds and converts values like libsql but
/// does not reproduce every libsql error shape (use [`LibsqlConn`] /
/// [`QueuedConn`] for engine work).
impl Executor for rusqlite::Connection {
  fn query_cells(&self, sql: &Sql) -> std::result::Result<Vec<Vec<Cell>>, ClientError> {
    let failure = |e: rusqlite::Error| match e {
      rusqlite::Error::SqliteFailure(f, message) => ClientError::Sqlite {
        message: payload_sqlite::conn::compat_message(message.unwrap_or_else(|| f.to_string())),
        code: code_name(f.extended_code),
        raw_code: f.extended_code,
      },
      other => ClientError::Error { message: other.to_string(), code: None },
    };
    let mut stmt = self.prepare(&sql.sql).map_err(failure)?;
    let params = sql.params.iter().map(to_sql_value).collect::<Result<Vec<_>>>().map_err(|_| ClientError::invalid_bind())?;
    let column_count = stmt.column_count();
    let mut rows = stmt.query(rusqlite::params_from_iter(params)).map_err(failure)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(failure)? {
      let mut values = Vec::with_capacity(column_count);
      for i in 0..column_count {
        let cell = match row.get_ref(i).map_err(failure)? {
          ValueRef::Null => payload_sqlite::SqlValue::Null,
          ValueRef::Integer(n) => payload_sqlite::SqlValue::Integer(n),
          ValueRef::Real(f) => payload_sqlite::SqlValue::Real(f),
          ValueRef::Text(t) => payload_sqlite::SqlValue::Text(String::from_utf8_lossy(t).into_owned()),
          ValueRef::Blob(b) => payload_sqlite::SqlValue::Blob(b.to_vec()),
        };
        values.push(payload_sqlite::value::value_from_sql(cell, IntMode::Number)?);
      }
      out.push(values);
    }
    Ok(out)
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// The `NativeError` JSON of a client error (`kind`, `message`, `code`,
/// `rawCode`), the shape `toJsError` in `packages/engine-rs/src/sqlite/errors.ts`
/// rebuilds the libsql error object from.
pub fn client_error_json(err: &ClientError) -> Json {
  let (kind, message, code, raw_code) = match err {
    ClientError::Sqlite { message, code, raw_code } => ("sqlite", message, Some(code.as_str()), Some(*raw_code)),
    ClientError::Native { message, code, raw_code } => ("native", message, Some(code.as_str()), Some(*raw_code)),
    ClientError::Libsql { message, code } => ("libsql", message, Some(code.as_str()), None),
    ClientError::UriMalformed { message } => ("libsqlUri", message, Some("URL_INVALID"), None),
    ClientError::Type(message) => ("TypeError", message, None, None),
    ClientError::Range(message) => ("RangeError", message, None, None),
    ClientError::Error { message, code } => ("Error", message, code.as_deref(), None),
  };
  let mut out = Map::new();
  out.insert("kind".into(), Json::String(kind.into()));
  out.insert("message".into(), Json::String(message.clone()));
  if let Some(code) = code {
    out.insert("code".into(), Json::String(code.into()));
  }
  if let Some(raw_code) = raw_code {
    out.insert("rawCode".into(), Json::from(raw_code));
  }
  Json::Object(out)
}

/// `new DrizzleQueryError(query, params, cause)` (drizzle `errors.js`), thrown
/// by `queryWithCache` for every error of the driver call.
///
/// `name` is the class to construct (`DrizzleQueryError`; the JS object's own
/// `name` is the inherited `"Error"`), `message` is drizzle's
/// `` `Failed query: ${query}\nparams: ${params}` `` and `data` carries
/// `{ query, params, cause }` with `cause` in [`client_error_json`] form.
pub fn drizzle_query_error(sql: &Sql, cause: &ClientError) -> EngineError {
  let params = JsVal::from_json(&Json::Array(sql.params.clone())).to_js_string();
  EngineError::new("DrizzleQueryError", format!("Failed query: {}\nparams: {params}", sql.sql)).with_data(json!({
    "query": sql.sql,
    "params": sql.params,
    "cause": client_error_json(cause),
  }))
}

/// Runs a statement and returns the driver rows, wrapping driver errors into
/// a [`drizzle_query_error`].
pub fn query_cells<C: Executor + ?Sized>(conn: &C, sql: &Sql) -> Result<Vec<Vec<Cell>>> {
  conn.query_cells(sql).map_err(|e| drizzle_query_error(sql, &e))
}

// ---------------------------------------------------------------------------
// Driver values
// ---------------------------------------------------------------------------

/// A value as `mapFromDriverValue` receives it: a JS value, or the bytes of a
/// BLOB (`normalizeFieldValue` turns libsql's `ArrayBuffer` into a `Buffer`).
#[derive(Clone, Debug)]
pub enum Driver {
  Js(JsVal),
  Blob(Vec<u8>),
}

impl Driver {
  pub fn from_cell(cell: &Cell) -> Self {
    match cell {
      Cell::Null => Driver::Js(JsVal::Null),
      Cell::Number(n) => Driver::Js(JsVal::Num(*n)),
      Cell::BigInt(i) => Driver::Js(JsVal::bigint(i.to_string())),
      Cell::String(s) => Driver::Js(JsVal::str(s.as_str())),
      Cell::Blob(b) => Driver::Blob(b.clone()),
    }
  }

  fn is_null(&self) -> bool {
    matches!(self, Driver::Js(JsVal::Null))
  }

  /// The value itself (a `Buffer` for BLOBs, see [`buffer_value`]).
  pub fn into_js(self) -> JsVal {
    match self {
      Driver::Js(v) => v,
      Driver::Blob(b) => buffer_value(&b),
    }
  }
}

/// A Node `Buffer`. `JsVal` has no `Buffer` type, so it is represented by what
/// `buffer.toJSON()` (and so `JSON.stringify`) produces: `{ type: 'Buffer', data: [...] }`.
pub fn buffer_value(bytes: &[u8]) -> JsVal {
  let mut obj = Obj::new();
  obj.insert("type".into(), JsVal::str("Buffer"));
  obj.insert("data".into(), JsVal::arr(bytes.iter().map(|b| JsVal::Num(f64::from(*b))).collect()));
  JsVal::obj(obj)
}

/// A driver row as JS values (`normalizeFieldValue` applied).
pub fn cells_to_js(row: &[Cell]) -> Vec<JsVal> {
  row.iter().map(|c| Driver::from_cell(c).into_js()).collect()
}

// ---------------------------------------------------------------------------
// Relational queries
// ---------------------------------------------------------------------------

/// Executes the relational query (`.all()` / `.get()` of the prepared
/// relational query): an array of rows for [`Mode::Many`]; for
/// [`Mode::First`] the first row, or `undefined` when there is none
/// (`mapGetResult`: `if (!row) return undefined`).
pub fn execute_js<C: Executor + ?Sized>(
  conn: &C,
  query: &BuiltRelationalQuery,
  mode: Mode,
  host: &dyn Host,
) -> Result<JsVal> {
  let rows = query_cells(conn, &query.sql)?;
  if mode == Mode::First && rows.is_empty() {
    return Ok(JsVal::Undefined);
  }
  let mut mapped = rows
    .iter()
    .map(|row| {
      let row: Vec<Driver> = row.iter().map(Driver::from_cell).collect();
      map_relational_row_js(&query.selection, &row, host)
    })
    .collect::<Result<Vec<_>>>()?;
  Ok(match mode {
    Mode::Many => JsVal::arr(mapped),
    Mode::First => mapped.swap_remove(0),
  })
}

/// [`execute_js`] as `JSON.stringify` would see it (`undefined` becomes `null`).
pub fn execute<C: Executor + ?Sized>(conn: &C, query: &BuiltRelationalQuery, mode: Mode) -> Result<Json> {
  Ok(execute_js(conn, query, mode, &NoHost)?.to_json())
}

/// Port of drizzle `mapRelationalRow`.
pub fn map_relational_row_js(selection: &[SelectionItem], row: &[Driver], host: &dyn Host) -> Result<JsVal> {
  let mut result = Obj::new();
  for (index, item) in selection.iter().enumerate() {
    let raw = row.get(index).cloned().unwrap_or(Driver::Js(JsVal::Undefined));
    let value = match &item.kind {
      SelectionKind::Relation { is_one, selection, .. } => {
        let sub_rows = match raw {
          Driver::Js(JsVal::Str(s)) => js_json_parse_js(&s)?,
          other => other.into_js(),
        };
        if *is_one {
          if sub_rows.truthy() { map_relational_row_js(selection, &as_row(&sub_rows)?, host)? } else { sub_rows }
        } else {
          let items = match &sub_rows {
            JsVal::Arr(items) => items.clone(),
            JsVal::Undefined | JsVal::Null => {
              return Err(EngineError::new(
                "TypeError",
                format!("Cannot read properties of {} (reading 'map')", sub_rows.to_js_string()),
              ));
            }
            _ => return Err(EngineError::new("TypeError", "subRows.map is not a function")),
          };
          JsVal::arr(items.iter().map(|sub| map_relational_row_js(selection, &as_row(sub)?, host)).collect::<Result<_>>()?)
        }
      }
      SelectionKind::Column { decoder, .. } => {
        if raw.is_null() {
          JsVal::Null
        } else {
          decode_js(*decoder, raw, host)?
        }
      }
      SelectionKind::Extra { .. } => {
        if raw.is_null() {
          JsVal::Null
        } else {
          raw.into_js()
        }
      }
    };
    result.insert(item.ts_key.clone(), value);
  }
  Ok(JsVal::obj(result))
}

/// [`map_relational_row_js`] on JSON driver values, as `JSON.stringify` would see the result.
pub fn map_relational_row(selection: &[SelectionItem], row: &[Json]) -> Result<Json> {
  let row: Vec<Driver> = row.iter().map(|v| Driver::Js(JsVal::from_json(v))).collect();
  Ok(map_relational_row_js(selection, &row, &NoHost)?.to_json())
}

fn as_row(value: &JsVal) -> Result<Vec<Driver>> {
  match value {
    JsVal::Arr(a) => Ok(a.iter().cloned().map(Driver::Js).collect()),
    _ => Err(EngineError::new("TypeError", "relational sub row is not an array")),
  }
}

// ---------------------------------------------------------------------------
// Plain statements (selectDistinct / countDistinct)
// ---------------------------------------------------------------------------

/// Runs a statement and returns the raw rows as arrays of JSON values.
pub fn query_rows<C: Executor + ?Sized>(conn: &C, sql: &Sql) -> Result<Vec<Vec<Json>>> {
  Ok(query_cells(conn, sql)?.iter().map(|row| cells_to_js(row).iter().map(JsVal::to_json).collect()).collect())
}

/// Converts a bound parameter the way the libsql client binds JS values:
/// every JS number (and boolean) is bound as REAL; objects can't be bound.
pub fn to_sql_value(param: &Json) -> Result<SqlValue> {
  Ok(match param {
    Json::Null => SqlValue::Null,
    Json::Bool(b) => SqlValue::Real(if *b { 1.0 } else { 0.0 }),
    Json::Number(n) => SqlValue::Real(n.as_f64().unwrap_or(f64::NAN)),
    Json::String(s) => SqlValue::Text(s.clone()),
    Json::Array(_) | Json::Object(_) => {
      return Err(EngineError::new("Error", "SQLite3 can only bind numbers, strings, bigints, buffers, and null"));
    }
  })
}

/// Converts a driver value to the JS value libsql hands to drizzle (as JSON).
pub fn from_sql_value(value: ValueRef<'_>) -> Json {
  match value {
    ValueRef::Null => Json::Null,
    ValueRef::Integer(i) => num_to_json(i as f64),
    ValueRef::Real(f) => num_to_json(f),
    ValueRef::Text(t) => Json::String(String::from_utf8_lossy(t).into_owned()),
    ValueRef::Blob(b) => buffer_value(b).to_json(),
  }
}

// ---------------------------------------------------------------------------
// JS builtins
// ---------------------------------------------------------------------------

/// `JSON.parse` with JS number semantics.
pub fn js_json_parse(text: &str) -> Result<Json> {
  let parsed: Json = serde_json::from_str(text)
    .map_err(|e| EngineError::new("SyntaxError", format!("{e} in JSON at {}", text.chars().take(40).collect::<String>())))?;
  Ok(normalize_numbers(parsed))
}

/// `JSON.parse` producing a JS value.
pub fn js_json_parse_js(text: &str) -> Result<JsVal> {
  Ok(JsVal::from_json(&js_json_parse(text)?))
}

/// Rounds every number to an IEEE double, as `JSON.parse` would.
pub fn normalize_numbers(value: Json) -> Json {
  match value {
    Json::Number(n) => num_to_json(n.as_f64().unwrap_or(f64::NAN)),
    Json::Array(a) => Json::Array(a.into_iter().map(normalize_numbers).collect()),
    Json::Object(o) => Json::Object(o.into_iter().map(|(k, v)| (k, normalize_numbers(v))).collect()),
    other => other,
  }
}

/// JS `String(value)`.
pub fn js_string_of(value: &JsVal) -> String {
  match value.typed() {
    Some(TypedValue::BigInt(s)) => s.to_string(),
    Some(TypedValue::Date(t)) => payload_sql_read::date::date_to_string(t),
    None => value.to_js_string(),
  }
}

fn driver_string(value: &Driver) -> String {
  match value {
    Driver::Js(v) => js_string_of(v),
    // `Buffer.prototype.toString()` (utf8)
    Driver::Blob(b) => String::from_utf8_lossy(b).into_owned(),
  }
}

/// JS `Number(value)`.
pub fn js_number_of(value: &JsVal) -> f64 {
  match value.typed() {
    Some(TypedValue::Date(t)) => return t,
    Some(TypedValue::BigInt(s)) => return s.parse::<f64>().unwrap_or(f64::NAN),
    None => {}
  }
  match value {
    JsVal::Undefined | JsVal::Fn(_) | JsVal::Obj(_) => f64::NAN,
    JsVal::Null => 0.0,
    JsVal::Bool(b) => f64::from(u8::from(*b)),
    JsVal::Num(n) => *n,
    JsVal::Str(s) => string_to_number(s),
    JsVal::Arr(_) => string_to_number(&value.to_js_string()),
  }
}

fn driver_number(value: &Driver) -> f64 {
  match value {
    Driver::Js(v) => js_number_of(v),
    // `ToPrimitive(buffer)`: `valueOf()` returns the object, so `toString()` (utf8) is used.
    Driver::Blob(b) => string_to_number(&String::from_utf8_lossy(b)),
  }
}

/// JS `Number(value)` for JSON values.
pub fn js_to_number(value: &Json) -> f64 {
  js_number_of(&JsVal::from_json(value))
}

/// ECMAScript `StringToNumber`.
pub fn string_to_number(s: &str) -> f64 {
  let t = s.trim_matches(is_js_whitespace);
  if t.is_empty() {
    return 0.0;
  }
  match t {
    "Infinity" | "+Infinity" => return f64::INFINITY,
    "-Infinity" => return f64::NEG_INFINITY,
    _ => {}
  }
  let radix = match t.get(..2) {
    Some("0x" | "0X") => Some(16),
    Some("0o" | "0O") => Some(8),
    Some("0b" | "0B") => Some(2),
    _ => None,
  };
  if let Some(radix) = radix {
    let digits = &t[2..];
    if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
      return f64::NAN;
    }
    return digits.chars().fold(0.0, |acc, c| acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0)));
  }
  if is_decimal_literal(t) { t.parse::<f64>().unwrap_or(f64::NAN) } else { f64::NAN }
}

fn is_decimal_literal(t: &str) -> bool {
  let b = t.as_bytes();
  let mut i = 0;
  if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
    i += 1;
  }
  let int_start = i;
  while i < b.len() && b[i].is_ascii_digit() {
    i += 1;
  }
  let int_digits = i - int_start;
  let mut frac_digits = 0;
  if i < b.len() && b[i] == b'.' {
    i += 1;
    let s = i;
    while i < b.len() && b[i].is_ascii_digit() {
      i += 1;
    }
    frac_digits = i - s;
  }
  if int_digits + frac_digits == 0 {
    return false;
  }
  if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
    i += 1;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
      i += 1;
    }
    let s = i;
    while i < b.len() && b[i].is_ascii_digit() {
      i += 1;
    }
    if i == s {
      return false;
    }
  }
  i == b.len()
}

/// ECMAScript `StringToBigInt`: the decimal digits of the value, `None` when
/// the string is not a valid integer literal.
pub fn string_to_bigint(s: &str) -> Option<String> {
  let t = s.trim_matches(is_js_whitespace);
  if t.is_empty() {
    return Some("0".into());
  }
  let (radix, digits, negative) = match t.get(..2) {
    Some("0x" | "0X") => (16, &t[2..], false),
    Some("0o" | "0O") => (8, &t[2..], false),
    Some("0b" | "0B") => (2, &t[2..], false),
    _ => match t.as_bytes()[0] {
      b'-' => (10, &t[1..], true),
      b'+' => (10, &t[1..], false),
      _ => (10, t, false),
    },
  };
  if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
    return None;
  }
  // Base 1e9 limbs, least significant first.
  let mut limbs: Vec<u64> = vec![0];
  for c in digits.chars() {
    let mut carry = u64::from(c.to_digit(radix).unwrap_or(0));
    for limb in &mut limbs {
      let v = *limb * u64::from(radix) + carry;
      *limb = v % 1_000_000_000;
      carry = v / 1_000_000_000;
    }
    while carry > 0 {
      limbs.push(carry % 1_000_000_000);
      carry /= 1_000_000_000;
    }
  }
  let mut out = limbs.last().map(|l| l.to_string()).unwrap_or_default();
  for limb in limbs.iter().rev().skip(1) {
    out.push_str(&format!("{limb:09}"));
  }
  if negative && out != "0" {
    out.insert(0, '-');
  }
  Some(out)
}

/// JS `BigInt(value)`.
fn js_bigint_of(value: &Driver) -> Result<JsVal> {
  let from_string = |s: &str| {
    string_to_bigint(s)
      .map(JsVal::bigint)
      .ok_or_else(|| EngineError::new("SyntaxError", format!("Cannot convert {s} to a BigInt")))
  };
  match value {
    Driver::Blob(b) => from_string(&String::from_utf8_lossy(b)),
    Driver::Js(v) => {
      if let Some(TypedValue::BigInt(_)) = v.typed() {
        return Ok(v.clone());
      }
      if let Some(TypedValue::Date(t)) = v.typed() {
        return number_to_bigint(t);
      }
      match v {
        JsVal::Num(n) => number_to_bigint(*n),
        JsVal::Bool(b) => Ok(JsVal::bigint(if *b { "1" } else { "0" })),
        JsVal::Undefined | JsVal::Null => {
          Err(EngineError::new("TypeError", format!("Cannot convert {} to a BigInt", v.to_js_string())))
        }
        other => from_string(&js_string_of(other)),
      }
    }
  }
}

fn number_to_bigint(n: f64) -> Result<JsVal> {
  if !n.is_finite() || n.trunc() != n {
    return Err(EngineError::new(
      "RangeError",
      format!("The number {} cannot be converted to a BigInt because it is not an integer", num_to_js_string(n)),
    ));
  }
  let digits = format!("{:.0}", n.abs());
  Ok(JsVal::bigint(if n < 0.0 && digits != "0" { format!("-{digits}") } else { digits }))
}

/// `TimeClip`
fn time_clip(t: f64) -> f64 {
  if !t.is_finite() || t.abs() > 8.64e15 { f64::NAN } else { t.trunc() + 0.0 }
}

/// `new Date(value)` for a single argument.
fn js_new_date(value: &Driver) -> Result<JsVal> {
  let t = match value {
    Driver::Blob(b) => payload_sql_read::date::parse(&String::from_utf8_lossy(b)),
    Driver::Js(v) => match v.typed() {
      Some(TypedValue::Date(t)) => t,
      Some(TypedValue::BigInt(_)) => return Err(EngineError::new("TypeError", "Cannot convert a BigInt value to a number")),
      None => match v {
        JsVal::Str(s) => payload_sql_read::date::parse(s),
        JsVal::Obj(_) | JsVal::Arr(_) | JsVal::Fn(_) => payload_sql_read::date::parse(&js_string_of(v)),
        other => js_number_of(other),
      },
    },
  };
  Ok(JsVal::date(time_clip(t)))
}

/// The bytes of `Buffer.isBuffer(value) ? value : ... : Buffer.from(value)`
/// (`SQLiteBlobBuffer` / `SQLiteBlobJson` / `SQLiteBigInt`).
fn buffer_from(value: &Driver) -> Result<Vec<u8>> {
  match value {
    Driver::Blob(b) => Ok(b.clone()),
    Driver::Js(JsVal::Str(s)) => Ok(s.as_bytes().to_vec()),
    Driver::Js(JsVal::Arr(items)) => {
      Ok(items.iter().map(|v| (js_number_of(v).trunc().rem_euclid(256.0)) as u8).collect())
    }
    Driver::Js(v) => {
      let received = match v.typed() {
        Some(TypedValue::BigInt(s)) => format!("type bigint ({s}n)"),
        Some(TypedValue::Date(_)) => "an instance of Date".into(),
        None => match v {
          JsVal::Num(n) => format!("type number ({})", num_to_js_string(*n)),
          JsVal::Bool(b) => format!("type boolean ({b})"),
          JsVal::Undefined => "undefined".into(),
          JsVal::Null => "null".into(),
          JsVal::Fn(_) => "function".into(),
          _ => "an instance of Object".into(),
        },
      };
      Err(EngineError::new(
        "TypeError",
        format!(
          "The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received {received}"
        ),
      ))
    }
  }
}

/// `column.mapFromDriverValue(value)` for non-null values.
pub fn decode_js(decoder: Decoder, value: Driver, host: &dyn Host) -> Result<JsVal> {
  Ok(match decoder {
    Decoder::Identity | Decoder::Custom(None) => value.into_js(),
    Decoder::Boolean => JsVal::Bool(driver_number(&value) == 1.0),
    Decoder::Json => js_json_parse_js(&driver_string(&value))?,
    Decoder::Number => match value {
      Driver::Js(JsVal::Num(n)) => JsVal::Num(n),
      other => JsVal::Num(driver_number(&other)),
    },
    Decoder::NumericString => match value {
      Driver::Js(JsVal::Str(s)) => JsVal::Str(s),
      other => JsVal::str(driver_string(&other)),
    },
    Decoder::NumericBigInt => js_bigint_of(&value)?,
    Decoder::Timestamp => {
      // `value * 1e3`
      if let Driver::Js(v) = &value
        && let Some(TypedValue::BigInt(_)) = v.typed()
      {
        return Err(EngineError::new("TypeError", "Cannot mix BigInt and other types, use explicit conversions"));
      }
      JsVal::date(time_clip(driver_number(&value) * 1e3))
    }
    Decoder::TimestampMs => js_new_date(&value)?,
    Decoder::BlobBuffer => buffer_value(&buffer_from(&value)?),
    Decoder::BlobJson => js_json_parse_js(&String::from_utf8_lossy(&buffer_from(&value)?))?,
    Decoder::BlobBigInt => js_bigint_of(&Driver::Blob(buffer_from(&value)?))?,
    Decoder::Custom(Some(id)) => host.call(id, &encode_value(&value.into_js()))?,
  })
}

/// `column.mapFromDriverValue(value)` for non-null JSON values, as
/// `JSON.stringify` would see the result. Custom columns with a `fromDriver`
/// function fail here (no host); use [`decode_js`].
pub fn decode(decoder: Decoder, value: &Json) -> Result<Json> {
  Ok(decode_js(decoder, Driver::Js(JsVal::from_json(value)), &NoHost)?.to_json())
}
