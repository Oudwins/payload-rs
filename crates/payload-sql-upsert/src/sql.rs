//! SQL statement building and execution.
//!
//! Statements are rendered exactly like drizzle-orm's sqlite dialect renders
//! the query builder calls used by `@payloadcms/drizzle`
//! (`node_modules/drizzle-orm/sqlite-core/dialect.js`: `buildInsertQuery`,
//! `buildUpdateQuery`, `buildDeleteQuery`, `buildSelection`, and the
//! `eq`/`and`/`or`/`inArray`/`isNull` operators), so the executed SQL text and
//! params are identical to what the TS adapter sends to libsql.

use payload_engine::error::{EngineError, Result};
use payload_engine::js::{JsVal, Obj};
use payload_engine::sql::schema::{RawSchema, RawTable};
use payload_sql_write::js::{json_stringify, to_js_string};
use payload_sql_write::{Row, RowValue, SqlExpr, encode_value};
use rusqlite::Connection;
use serde_json::{Value as Json, json};

use crate::value::{bind_value, get_defined, map_from_driver, map_to_driver, value_from_sql};

/// A rendered SQL fragment with driver-level params (after
/// `mapToDriverValue`, before libsql binding). This is also the boundary type
/// for `where` clauses built by the query module (`dialect.sqlToQuery(where)`).
#[derive(Clone, Debug, Default)]
pub struct SqlFragment {
  pub sql: String,
  pub params: Vec<JsVal>,
}

impl SqlFragment {
  pub fn new(sql: impl Into<String>, params: Vec<JsVal>) -> Self {
    Self { sql: sql.into(), params }
  }

  pub fn raw(sql: impl Into<String>) -> Self {
    Self { sql: sql.into(), params: vec![] }
  }

  /// Parses `{ "sql": string, "params": [...] }` (drizzle `Query`) whose
  /// params are already decoded JS values.
  pub fn from_js(value: &JsVal) -> Result<Self> {
    let sql = value.get("sql").as_str().ok_or_else(|| EngineError::internal("SQL fragment is missing `sql`"))?;
    Ok(Self::new(sql, value.get("params").items().cloned().collect()))
  }

  /// `{ "sql", "params" }` with params in the engine JSON encoding.
  pub fn to_json(&self) -> Json {
    json!({ "sql": self.sql, "params": self.params.iter().map(encode_value).collect::<Vec<_>>() })
  }

  fn push(&mut self, other: SqlFragment) {
    self.sql.push_str(&other.sql);
    self.params.extend(other.params);
  }
}

/// A statement that was executed against the database.
#[derive(Clone, Debug)]
pub struct ExecutedStatement {
  pub sql: String,
  pub params: Vec<JsVal>,
}

impl ExecutedStatement {
  /// `{ "sql", "params" }` with params in the engine JSON encoding.
  pub fn to_json(&self) -> Json {
    json!({ "sql": self.sql, "params": self.params.iter().map(encode_value).collect::<Vec<_>>() })
  }
}

/// A database error as surfaced by `@libsql/client` (`LibsqlError`) wrapped by
/// drizzle (`DrizzleQueryError`, whose `cause` is the libsql error).
#[derive(Clone, Debug)]
pub struct DbError {
  /// libsql `code`, e.g. `SQLITE_CONSTRAINT_UNIQUE`.
  pub code: String,
  /// libsql message: `${code}: ${sqliteMessage}`.
  pub message: String,
  pub raw_code: Option<i32>,
  pub query: String,
  pub params: Vec<JsVal>,
}

impl DbError {
  /// The `DrizzleQueryError` thrown to the caller.
  pub fn to_engine_error(&self) -> EngineError {
    let params = self.params.iter().map(drizzle_param_to_string).collect::<Vec<_>>().join(",");
    EngineError::new("Error", format!("Failed query: {}\nparams: {}", self.query, params)).with_data(json!({
      "query": self.query,
      "params": self.params.iter().map(encode_value).collect::<Vec<_>>(),
      "cause": { "code": self.code, "message": self.message, "rawCode": self.raw_code },
    }))
  }
}

/// `params.map(String).join(',')` of drizzle's `DrizzleQueryError` after
/// `Array.prototype.join` turned nullish entries into empty strings.
fn drizzle_param_to_string(p: &JsVal) -> String {
  if p.is_nullish() { String::new() } else { to_js_string(p) }
}

/// Errors produced while executing: either a database error or an engine
/// error raised before reaching the database.
#[derive(Clone, Debug)]
pub enum ExecError {
  Db(DbError),
  Engine(EngineError),
}

impl From<EngineError> for ExecError {
  fn from(e: EngineError) -> Self {
    ExecError::Engine(e)
  }
}

impl ExecError {
  pub fn into_engine_error(self) -> EngineError {
    match self {
      ExecError::Db(e) => e.to_engine_error(),
      ExecError::Engine(e) => e,
    }
  }
}

pub type ExecResult<T> = std::result::Result<T, ExecError>;

/// Maps a SQLite extended result code to the libsql error code name.
pub fn sqlite_code_name(extended: i32) -> String {
  let name = match extended {
    2067 => "SQLITE_CONSTRAINT_UNIQUE",
    1555 => "SQLITE_CONSTRAINT_PRIMARYKEY",
    787 => "SQLITE_CONSTRAINT_FOREIGNKEY",
    1299 => "SQLITE_CONSTRAINT_NOTNULL",
    275 => "SQLITE_CONSTRAINT_CHECK",
    19 => "SQLITE_CONSTRAINT",
    1 => "SQLITE_ERROR",
    5 => "SQLITE_BUSY",
    6 => "SQLITE_LOCKED",
    8 => "SQLITE_READONLY",
    11 => "SQLITE_CORRUPT",
    13 => "SQLITE_FULL",
    18 => "SQLITE_TOOBIG",
    20 => "SQLITE_MISMATCH",
    25 => "SQLITE_RANGE",
    _ => return format!("SQLITE_UNKNOWN_{extended}"),
  };
  name.to_string()
}

/// drizzle sqlite `escapeName`: `"name"` with embedded `"` doubled.
pub fn ident(name: &str) -> String {
  format!("\"{}\"", name.replace('"', "\"\""))
}

/// A drizzle table view over a [`RawTable`] from the raw schema.
#[derive(Clone, Copy, Debug)]
pub struct Table<'a> {
  pub raw: &'a RawTable,
}

impl<'a> Table<'a> {
  pub fn name(&self) -> &'a str {
    &self.raw.name
  }

  /// Columns in drizzle column order as `(key, rawColumn)`.
  pub fn columns(&self) -> impl Iterator<Item = (&'a String, &'a Json)> {
    self.raw.columns.iter()
  }

  pub fn column(&self, key: &str) -> Option<&'a Json> {
    self.raw.columns.get(key)
  }

  pub fn has_column(&self, key: &str) -> bool {
    self.raw.columns.contains_key(key)
  }

  pub fn column_name(&self, key: &str) -> Result<&'a str> {
    self
      .column(key)
      .and_then(|c| c.get("name"))
      .and_then(Json::as_str)
      .ok_or_else(|| {
        EngineError::new(
          "TypeError",
          format!("Cannot read properties of undefined (column `{key}` of table `{}`)", self.name()),
        )
      })
  }

  pub fn column_type(&self, key: &str) -> &'a str {
    self.column(key).and_then(|c| c.get("type")).and_then(Json::as_str).unwrap_or("")
  }

  /// `"table"."column"` (a drizzle `Column` chunk outside single-table selection).
  pub fn col_ref(&self, key: &str) -> Result<String> {
    Ok(format!("{}.{}", ident(self.name()), ident(self.column_name(key)?)))
  }
}

/// Looks up a table by name (`adapter.tables[tableName]`).
pub fn table<'a>(schema: &'a RawSchema, name: &str) -> Option<Table<'a>> {
  schema.raw_tables.get(name).and_then(|t| t.as_ref()).map(|raw| Table { raw })
}

pub fn require_table<'a>(schema: &'a RawSchema, name: &str) -> Result<Table<'a>> {
  table(schema, name).ok_or_else(|| {
    EngineError::new("TypeError", format!("Cannot read properties of undefined (table `{name}`)"))
  })
}

/// `eq(table[key], value)`
pub fn eq(t: Table<'_>, key: &str, value: &JsVal) -> Result<SqlFragment> {
  Ok(SqlFragment::new(format!("{} = ?", t.col_ref(key)?), vec![map_to_driver(t.column_type(key), value)?]))
}

/// `isNull(table[key])`
pub fn is_null(t: Table<'_>, key: &str) -> Result<SqlFragment> {
  Ok(SqlFragment::raw(format!("{} is null", t.col_ref(key)?)))
}

/// `inArray(table[key], values)`
pub fn in_array(t: Table<'_>, key: &str, values: &[JsVal]) -> Result<SqlFragment> {
  if values.is_empty() {
    return Ok(SqlFragment::raw("false"));
  }
  let ty = t.column_type(key);
  let placeholders = vec!["?"; values.len()].join(", ");
  Ok(SqlFragment::new(
    format!("{} in ({placeholders})", t.col_ref(key)?),
    values.iter().map(|v| map_to_driver(ty, v)).collect::<Result<Vec<_>>>()?,
  ))
}

fn join_conditions(conditions: Vec<SqlFragment>, op: &str) -> Option<SqlFragment> {
  match conditions.len() {
    0 => None,
    1 => conditions.into_iter().next(),
    _ => {
      let mut out = SqlFragment::raw("(");
      for (i, c) in conditions.into_iter().enumerate() {
        if i > 0 {
          out.sql.push_str(op);
        }
        out.push(c);
      }
      out.sql.push(')');
      Some(out)
    }
  }
}

/// `and(...conditions)`
pub fn and(conditions: Vec<SqlFragment>) -> Option<SqlFragment> {
  join_conditions(conditions, " and ")
}

/// `or(...conditions)`
pub fn or(conditions: Vec<SqlFragment>) -> Option<SqlFragment> {
  join_conditions(conditions, " or ")
}

/// Renders a value for a column: drizzle `SQL` values are inlined, plain
/// values become a `Param` encoded by the column.
fn value_chunk(t: Table<'_>, key: &str, value: &RowValue) -> Result<SqlFragment> {
  Ok(match value {
    RowValue::Sql(SqlExpr::Raw(raw)) => SqlFragment::raw(raw.as_str()),
    // sql`ST_GeomFromGeoJSON(${json})`: a plain interpolated value
    RowValue::Sql(SqlExpr::GeomFromGeoJson(json)) => {
      SqlFragment::new("ST_GeomFromGeoJSON(?)", vec![JsVal::str(json.as_str())])
    }
    RowValue::Value(v) => SqlFragment::new("?", vec![map_to_driver(t.column_type(key), v)?]),
  })
}

/// The insert value for an omitted column: drizzle `default` / `$defaultFn` / `null`.
fn default_chunk(column: &Json) -> Result<SqlFragment> {
  let ty = column.get("type").and_then(Json::as_str).unwrap_or("");
  if let Some(default) = column.get("default") {
    if !default.is_null() {
      let mut sanitized = JsVal::from_json(default);
      if ty == "geometry" {
        if let Json::Array(a) = default {
          let point = json!({ "type": "Point", "coordinates": [a.first().cloned().unwrap_or(Json::Null), a.get(1).cloned().unwrap_or(Json::Null)] });
          sanitized = json_stringify(&JsVal::from_json(&point))?.map(JsVal::str).unwrap_or_default();
        }
      }
      return Ok(SqlFragment::new("?", vec![map_to_driver(ty, &sanitized)?]));
    }
  }
  let truthy = |k: &str| column.get(k).map(|v| JsVal::from_json(v).truthy()).unwrap_or(false);
  if ty == "timestamp" && truthy("defaultNow") && column.get("default").is_none() {
    return Ok(SqlFragment::raw("(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"));
  }
  if ty == "uuid" {
    // `$defaultFn` (defaultV7 is applied after defaultRandom and wins)
    if truthy("defaultV7") {
      return Ok(SqlFragment::new("?", vec![JsVal::str(uuid::Uuid::now_v7().to_string())]));
    }
    if truthy("defaultRandom") {
      return Ok(SqlFragment::new("?", vec![JsVal::str(uuid::Uuid::new_v4().to_string())]));
    }
  }
  Ok(SqlFragment::raw("null"))
}

/// The `returning` selection of a statement.
#[derive(Clone, Debug)]
pub enum Returning {
  None,
  /// `.returning()`: every column.
  All,
  /// `.returning({ key: table.key, ... })`
  Columns(Vec<String>),
}

impl Returning {
  fn keys<'a>(&'a self, t: Table<'a>) -> Vec<&'a str> {
    match self {
      Returning::None => vec![],
      Returning::All => t.columns().map(|(k, _)| k.as_str()).collect(),
      Returning::Columns(cols) => cols.iter().map(String::as_str).collect(),
    }
  }

  fn render(&self, t: Table<'_>) -> Result<String> {
    let keys = self.keys(t);
    if keys.is_empty() {
      return Ok(String::new());
    }
    let cols = keys.iter().map(|k| t.column_name(k).map(ident)).collect::<Result<Vec<_>>>()?;
    Ok(format!(" returning {}", cols.join(", ")))
  }
}

/// `onConflictDoUpdate({ target, set, where })`
#[derive(Clone, Debug)]
pub struct OnConflictDoUpdate {
  /// Column key of the conflict target.
  pub target: String,
  pub set: Row,
  pub where_: Option<SqlFragment>,
}

/// drizzle `buildUpdateSet(table, mapUpdateSet(table, set))`.
fn update_set(t: Table<'_>, set: &Row) -> Result<SqlFragment> {
  // mapUpdateSet throws when nothing is left after dropping undefined values
  if set.values().all(|v| matches!(v, RowValue::Value(JsVal::Undefined))) {
    return Err(EngineError::new("Error", "No values to set"));
  }
  let mut out = SqlFragment::default();
  let mut first = true;
  for (key, column) in t.columns() {
    let Some(value) = get_defined(set, key) else { continue };
    let name = column.get("name").and_then(Json::as_str).unwrap_or(key);
    if !first {
      out.sql.push_str(", ");
    }
    first = false;
    out.sql.push_str(&format!("{} = ", ident(name)));
    out.push(value_chunk(t, key, value)?);
  }
  Ok(out)
}

/// `db.insert(table).values(rows)[.onConflictDoUpdate(...)].returning(...)`
pub fn build_insert(
  t: Table<'_>,
  rows: &[Row],
  on_conflict: Option<&OnConflictDoUpdate>,
  returning: &Returning,
) -> Result<SqlFragment> {
  let columns = t.columns().collect::<Vec<_>>();
  let mut out = SqlFragment::raw(format!(
    "insert into {} ({}) values ",
    ident(t.name()),
    columns
      .iter()
      .map(|(k, c)| ident(c.get("name").and_then(Json::as_str).unwrap_or(k)))
      .collect::<Vec<_>>()
      .join(", ")
  ));
  for (i, row) in rows.iter().enumerate() {
    if i > 0 {
      out.sql.push_str(", ");
    }
    out.sql.push('(');
    for (j, (key, column)) in columns.iter().enumerate() {
      if j > 0 {
        out.sql.push_str(", ");
      }
      match get_defined(row, key) {
        Some(value) => out.push(value_chunk(t, key, value)?),
        None => out.push(default_chunk(column)?),
      }
    }
    out.sql.push(')');
  }
  if let Some(conflict) = on_conflict {
    out.sql.push_str(&format!(" on conflict ({}) do update set ", t.col_ref(&conflict.target)?));
    out.push(update_set(t, &conflict.set)?);
    if let Some(w) = &conflict.where_ {
      out.sql.push_str(" where ");
      out.push(w.clone());
    }
  }
  out.sql.push_str(&returning.render(t)?);
  Ok(out)
}

/// `db.update(table).set(set).where(where).returning(...)`
pub fn build_update(t: Table<'_>, set: &Row, where_: Option<&SqlFragment>, returning: &Returning) -> Result<SqlFragment> {
  let mut out = SqlFragment::raw(format!("update {} set ", ident(t.name())));
  out.push(update_set(t, set)?);
  if let Some(w) = where_ {
    out.sql.push_str(" where ");
    out.push(w.clone());
  }
  out.sql.push_str(&returning.render(t)?);
  Ok(out)
}

/// `db.delete(table).where(where)`
pub fn build_delete(t: Table<'_>, where_: Option<&SqlFragment>) -> SqlFragment {
  let mut out = SqlFragment::raw(format!("delete from {}", ident(t.name())));
  if let Some(w) = where_ {
    out.sql.push_str(" where ");
    out.push(w.clone());
  }
  out
}

/// Executes statements on a rusqlite connection and records them.
pub struct Executor<'c> {
  pub conn: &'c Connection,
  pub statements: Vec<ExecutedStatement>,
  /// `adapter.limitedBoundParameters` (D1): batch multi-row inserts.
  pub limited_bound_parameters: bool,
}

impl<'c> Executor<'c> {
  pub fn new(conn: &'c Connection) -> Self {
    Self { conn, statements: vec![], limited_bound_parameters: false }
  }

  fn db_error(&self, e: rusqlite::Error, q: &SqlFragment) -> ExecError {
    let (code, raw_code, msg) = match &e {
      rusqlite::Error::SqliteFailure(f, m) => {
        let base = rusqlite::ffi::code_to_str(f.extended_code).to_string();
        (sqlite_code_name(f.extended_code), Some(f.extended_code), m.clone().unwrap_or(base))
      }
      other => ("SQLITE_ERROR".to_string(), None, other.to_string()),
    };
    ExecError::Db(DbError {
      message: format!("{code}: {msg}"),
      code,
      raw_code,
      query: q.sql.clone(),
      params: q.params.clone(),
    })
  }

  /// Runs a statement and returns raw rows as `(columnName, value)` lists.
  pub fn query_raw(&mut self, q: &SqlFragment) -> ExecResult<Vec<Vec<(String, JsVal)>>> {
    self.statements.push(ExecutedStatement { sql: q.sql.clone(), params: q.params.clone() });
    let params = q.params.iter().map(bind_value).collect::<Result<Vec<_>>>()?;
    let mut stmt = self.conn.prepare(&q.sql).map_err(|e| self.db_error(e, q))?;
    let names = stmt.column_names().iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let mut rows = stmt.query(rusqlite::params_from_iter(params.iter())).map_err(|e| self.db_error(e, q))?;
    let mut out = vec![];
    loop {
      match rows.next() {
        Ok(Some(row)) => {
          let mut cells = Vec::with_capacity(names.len());
          for (i, name) in names.iter().enumerate() {
            let v = row.get_ref(i).map_err(|e| self.db_error(e, q))?;
            cells.push((name.clone(), value_from_sql(v)?));
          }
          out.push(cells);
        }
        Ok(None) => break,
        Err(e) => return Err(self.db_error(e, q)),
      }
    }
    Ok(out)
  }

  /// Runs a statement whose result rows map onto `keys` of `t` (drizzle maps
  /// selected fields positionally and applies `mapFromDriverValue`).
  pub fn query_columns(&mut self, t: Table<'_>, keys: &[&str], q: &SqlFragment) -> ExecResult<Vec<Obj>> {
    let rows = self.query_raw(q)?;
    rows
      .into_iter()
      .map(|cells| {
        let mut m = Obj::new();
        for (key, (_, v)) in keys.iter().zip(cells) {
          m.insert((*key).to_string(), map_from_driver(t.column_type(key), v)?);
        }
        Ok(m)
      })
      .collect()
  }

  /// `adapter.insert({ tableName, values, onConflictDoUpdate })` returning all
  /// columns (packages/drizzle/src/sqlite/insert.ts).
  pub fn insert(
    &mut self,
    t: Table<'_>,
    rows: &[Row],
    on_conflict: Option<&OnConflictDoUpdate>,
  ) -> ExecResult<Vec<Obj>> {
    let keys: Vec<&str> = t.columns().map(|(k, _)| k.as_str()).collect();
    if self.limited_bound_parameters && rows.len() > 1 {
      let cols_per_row = keys.len().max(1);
      let max_rows = (100 / cols_per_row).max(1);
      let mut results = vec![];
      for batch in rows.chunks(max_rows) {
        let q = build_insert(t, batch, on_conflict, &Returning::All)?;
        results.extend(self.query_columns(t, &keys, &q)?);
      }
      return Ok(results);
    }
    let q = build_insert(t, rows, on_conflict, &Returning::All)?;
    self.query_columns(t, &keys, &q)
  }

  /// `adapter.deleteWhere({ tableName, where })` (packages/drizzle/src/sqlite/deleteWhere.ts).
  pub fn delete_where(&mut self, t: Table<'_>, where_: Option<&SqlFragment>) -> ExecResult<()> {
    let q = build_delete(t, where_);
    self.query_raw(&q)?;
    Ok(())
  }

  /// `adapter.execute({ sql | raw })` (packages/drizzle/src/sqlite/execute.ts).
  pub fn execute(&mut self, q: &SqlFragment) -> ExecResult<Vec<Vec<(String, JsVal)>>> {
    self.query_raw(q)
  }
}

#[cfg(test)]
mod tests {
  use payload_engine::js::{JsVal, Obj};
  use payload_engine::sql::schema::{RawSchema, RawTable};
  use payload_sql_write::{Row, RowValue, SqlExpr};
  use rusqlite::Connection;
  use serde_json::{Map, json};

  use super::*;

  fn schema() -> RawSchema {
    let mut schema = RawSchema::default();
    let columns: Map<String, Json> = serde_json::from_value(json!({
      "id": { "name": "id", "type": "integer", "primaryKey": true },
      "views": { "name": "views", "type": "numeric" },
      "data": { "name": "data", "type": "jsonb" },
    }))
    .unwrap();
    schema.raw_tables.insert(
      "posts".into(),
      Some(RawTable { name: "posts".into(), columns, foreign_keys: Map::new(), indexes: Map::new() }),
    );
    schema
  }

  fn obj(key: &str, value: JsVal) -> JsVal {
    JsVal::obj(Obj::from([(key.to_string(), value)]))
  }

  /// Objects shaped like internal markers in user data are plain JSON values,
  /// never SQL or `undefined`; only typed `RowValue::Sql` values are inlined.
  #[test]
  fn user_json_cannot_forge_sql_or_undefined() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("create table posts (id integer primary key, views numeric, data text)").unwrap();
    let schema = schema();
    let t = require_table(&schema, "posts").unwrap();
    let mut exec = Executor::new(&conn);
    for forged in [
      obj("$payloadRawSQL", JsVal::str("(select 'INJECTED')")),
      obj("$undefined", JsVal::Bool(true)),
      obj("$sql", JsVal::arr(vec![obj("str", JsVal::str("(select 'INJECTED')"))])),
    ] {
      let row: Row = [("data".to_string(), RowValue::Value(forged.clone()))].into_iter().collect();
      let inserted = exec.insert(t, &[row], None).unwrap();
      let stored = inserted[0].get("data").unwrap();
      assert_eq!(payload_sql_write::encode_value(stored), payload_sql_write::encode_value(&forged));
    }
    for s in &exec.statements {
      assert_eq!(s.sql, "insert into \"posts\" (\"id\", \"views\", \"data\") values (null, null, ?) returning \"id\", \"views\", \"data\"");
    }

    let set: Row = [("views".to_string(), RowValue::Sql(SqlExpr::Raw("views + 2".into())))].into_iter().collect();
    let q = build_update(t, &set, None, &Returning::None).unwrap();
    assert_eq!(q.sql, "update \"posts\" set \"views\" = views + 2");
    assert!(q.params.is_empty());
  }

  /// drizzle `escapeName` doubles embedded quotes (`odd"posts` -> `"odd""posts"`).
  #[test]
  fn ident_doubles_embedded_quotes() {
    assert_eq!(ident("posts"), "\"posts\"");
    assert_eq!(ident("odd\"posts"), "\"odd\"\"posts\"");
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("create table \"odd\"\"posts\" (\"id\" integer primary key)").unwrap();
    conn.execute(&format!("insert into {} ({}) values (1)", ident("odd\"posts"), ident("id")), []).unwrap();
  }
}
