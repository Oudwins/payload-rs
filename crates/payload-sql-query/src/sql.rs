//! A minimal model of drizzle-orm's `SQL` objects for the SQLite dialect
//! (`drizzle-orm/sql/sql.js`, `sql/expressions/conditions.js`, `sqlite-core/dialect.js`).
//!
//! The query builder produces [`Sql`] trees with the same chunk structure drizzle would
//! build, and [`Sql::render`] turns them into SQLite text with `?` placeholders and bound
//! parameters exactly like `SQLiteDialect.sqlToQuery`, including drizzle's quirks:
//! `undefined` chunks render as an empty string, raw JS arrays render as `(?, ?)` lists,
//! column-bound params go through the column's `mapToDriverValue`.

use std::sync::atomic::{AtomicU64, Ordering};

use std::cell::Cell as StdCell;

use payload_engine::error::{EngineError, Result};
use payload_engine::host::Host;
use payload_engine::js::JsVal;

use crate::drizzle::Decoder;
use crate::js_ops::{js_string, json_stringify};

static ACCESS_ID: AtomicU64 = AtomicU64::new(1);

/// A drizzle table (`adapter.tables[name]`) or an alias of one (`alias(table, name)`).
#[derive(Clone, Debug, PartialEq)]
pub struct TableRef {
  /// Name of the underlying table (`table[OriginalName]`).
  pub name: String,
  /// Alias name when created with `alias()` / `aliasedTable()`.
  pub alias: Option<String>,
}

impl TableRef {
  /// `getTableName(table)` / `getNameFromDrizzleTable(table)`
  pub fn ref_name(&self) -> &str {
    self.alias.as_deref().unwrap_or(&self.name)
  }

  /// FROM / JOIN clause rendering: `"name"` or `"name" "alias"`.
  pub fn render_from(&self) -> String {
    match &self.alias {
      Some(alias) if alias != &self.name => format!("{} {}", quote(&self.name), quote(alias)),
      _ => quote(&self.name),
    }
  }
}

/// A column of a [`TableRef`], with the drizzle column class that selects its driver encoder.
#[derive(Clone, Debug)]
pub struct Column {
  pub table: TableRef,
  /// Property key on the drizzle table (`_parentID`).
  pub key: String,
  /// SQL column name (`_parent_id`).
  pub name: String,
  /// The drizzle column class (`mapToDriverValue` / `mapFromDriverValue`).
  pub decoder: Decoder,
  /// Function id of a custom column's `mapTo` (`toDriver`).
  pub to_driver: Option<u32>,
  pub primary: bool,
  /// Columns of aliased tables are new proxies on every property access in drizzle, so they
  /// are never `===` to each other. Non-zero for such accesses.
  pub access_id: u64,
}

impl Column {
  /// JS `===` between two column objects.
  pub fn same(&self, other: &Column) -> bool {
    self.access_id == 0
      && other.access_id == 0
      && self.table == other.table
      && self.key == other.key
  }

  pub(crate) fn next_access_id() -> u64 {
    ACCESS_ID.fetch_add(1, Ordering::Relaxed)
  }

  /// `"table"."column"`
  pub fn render(&self) -> String {
    format!("{}.{}", quote(self.table.ref_name()), quote(&self.name))
  }

  /// The column's `mapToDriverValue` (drizzle-orm `sqlite-core/columns/*.js`). A custom
  /// column's `mapTo` runs through the host installed with [`with_driver_host`].
  pub fn map_to_driver_value(&self, v: &JsVal) -> Result<JsVal> {
    Ok(match self.decoder {
      Decoder::Boolean => JsVal::Num(if v.truthy() { 1.0 } else { 0.0 }),
      Decoder::Json => json_stringify(v).map(JsVal::str).unwrap_or(JsVal::Undefined),
      // `mapToDriverValue = String`
      Decoder::Number | Decoder::NumericBigInt => JsVal::str(js_string(v)),
      // `const unix = value.getTime()`
      Decoder::Timestamp | Decoder::TimestampMs => {
        let unix = match (v.as_date(), v) {
          (Some(ms), _) => ms,
          (None, JsVal::Undefined) => {
            return Err(EngineError::new("TypeError", "Cannot read properties of undefined (reading 'getTime')"));
          }
          (None, _) => return Err(EngineError::new("TypeError", "value.getTime is not a function")),
        };
        JsVal::Num(if self.decoder == Decoder::Timestamp { (unix / 1e3).floor() } else { unix })
      }
      // `Buffer.from(...)`: no `Buffer` value exists on this side
      Decoder::BlobBuffer | Decoder::BlobJson | Decoder::BlobBigInt => {
        return Err(EngineError::internal(format!(
          "payload-sql-query: binding a value to the blob column \"{}\" is not supported",
          self.name
        )));
      }
      Decoder::Custom(_) => match self.to_driver {
        Some(id) => call_driver_host(id, v)?,
        None => v.clone(),
      },
      Decoder::Identity | Decoder::NumericString => v.clone(),
    })
  }
}

thread_local! {
  /// The host of the call rendering statements on this thread (see [`with_driver_host`]).
  static DRIVER_HOST: StdCell<Option<*const (dyn Host + 'static)>> = const { StdCell::new(None) };
}

/// Runs `f` with `host` as the host that runs custom columns' `mapTo` while statements are
/// rendered on this thread.
pub fn with_driver_host<R>(host: &dyn Host, f: impl FnOnce() -> R) -> R {
  struct Restore(Option<*const (dyn Host + 'static)>);
  impl Drop for Restore {
    fn drop(&mut self) {
      DRIVER_HOST.with(|h| h.set(self.0));
    }
  }
  // SAFETY: only the lifetime is erased; the pointer is removed again (`Restore`, also on unwind)
  // before `host` goes out of scope, and is only dereferenced on this thread meanwhile.
  let erased: &'static dyn Host = unsafe { std::mem::transmute::<&dyn Host, &'static dyn Host>(host) };
  let _restore = Restore(DRIVER_HOST.with(|h| h.replace(Some(erased as *const _))));
  f()
}

fn call_driver_host(id: u32, v: &JsVal) -> Result<JsVal> {
  let host = DRIVER_HOST.with(StdCell::get).ok_or_else(|| {
    EngineError::internal("payload-sql-query: a custom column's toDriver needs a host (with_driver_host)")
  })?;
  // SAFETY: see `with_driver_host`.
  unsafe { (*host).call(id, &payload_engine::js::encode_value(v)) }
}

/// A selectable / comparable expression: a column or a raw SQL expression.
#[derive(Clone, Debug)]
pub enum Expr {
  Col(Column),
  Sql(Sql),
}

impl Expr {
  pub fn as_col(&self) -> Option<&Column> {
    match self {
      Expr::Col(c) => Some(c),
      Expr::Sql(_) => None,
    }
  }

  fn chunk(&self) -> Chunk {
    match self {
      Expr::Col(c) => Chunk::Col(c.clone()),
      Expr::Sql(s) => Chunk::Sql(s.clone()),
    }
  }
}

/// An operand of a comparison: a JS value (bound as a parameter) or a SQL expression.
#[derive(Clone, Debug)]
pub enum Operand {
  Val(JsVal),
  Expr(Expr),
}

impl From<JsVal> for Operand {
  fn from(v: JsVal) -> Self {
    Operand::Val(v)
  }
}

impl From<Expr> for Operand {
  fn from(e: Expr) -> Self {
    Operand::Expr(e)
  }
}

impl From<Column> for Operand {
  fn from(c: Column) -> Self {
    Operand::Expr(Expr::Col(c))
  }
}

#[derive(Clone, Debug)]
pub enum Chunk {
  Str(String),
  Col(Column),
  /// `new Param(value, column)`: encoded with the column's `mapToDriverValue`.
  Param(JsVal, Column),
  /// A raw JS value interpolated into a `sql` template (no encoder).
  Value(JsVal),
  Sql(Sql),
  /// A subquery (`SQLWrapper`), rendered in parentheses.
  Select(Box<Select>),
  /// `undefined`, renders as nothing.
  Undefined,
}

/// A drizzle `SQL` object.
#[derive(Clone, Debug, Default)]
pub struct Sql {
  pub chunks: Vec<Chunk>,
}

/// A bound SQLite parameter, already converted by the libsql client.
#[derive(Clone, Debug, PartialEq)]
pub enum SqlValue {
  Null,
  Real(f64),
  /// A `bigint` (libsql binds it as a 64-bit integer).
  Integer(i64),
  Text(String),
}

impl SqlValue {
  pub fn to_json(&self) -> serde_json::Value {
    match self {
      SqlValue::Null => serde_json::Value::Null,
      SqlValue::Real(n) => payload_engine::js::num_to_json(*n),
      SqlValue::Integer(n) => serde_json::Value::from(*n),
      SqlValue::Text(s) => serde_json::Value::String(s.clone()),
    }
  }
}

/// Rendered SQL text and its parameters.
#[derive(Clone, Debug, Default)]
pub struct Query {
  pub sql: String,
  pub params: Vec<SqlValue>,
}

pub fn quote(name: &str) -> String {
  format!("\"{}\"", name.replace('"', "\"\""))
}

/// `@libsql/client` `valueToSql` + libsql binding rules.
fn bind_value(v: &JsVal) -> Result<SqlValue> {
  // `value.valueOf()`; an invalid date binds `NaN`, which SQLite stores as NULL
  if let Some(ms) = v.as_date() {
    return Ok(SqlValue::Real(ms));
  }
  if let Some(decimal) = v.as_bigint() {
    return decimal.parse::<i64>().map(SqlValue::Integer).map_err(|_| {
      EngineError::new("RangeError", "bigint is too large to be represented as a 64-bit integer and passed as argument")
    });
  }
  Ok(match v {
    JsVal::Null => SqlValue::Null,
    JsVal::Bool(b) => SqlValue::Real(if *b { 1.0 } else { 0.0 }),
    JsVal::Num(n) => {
      if !n.is_finite() {
        return Err(EngineError::new("RangeError", "Only finite numbers (not Infinity or NaN) can be passed as arguments"));
      }
      SqlValue::Real(*n)
    }
    JsVal::Str(s) => SqlValue::Text(s.to_string()),
    JsVal::Undefined => return Err(EngineError::new("TypeError", "undefined cannot be passed as argument to the database")),
    JsVal::Arr(_) | JsVal::Obj(_) | JsVal::Fn(_) => {
      return Err(EngineError::new("Error", "SQLite3 can only bind numbers, strings, bigints, buffers, and null"));
    }
  })
}

impl Sql {
  pub fn new(chunks: Vec<Chunk>) -> Self {
    Sql { chunks }
  }

  pub fn raw(text: impl Into<String>) -> Self {
    Sql { chunks: vec![Chunk::Str(text.into())] }
  }

  pub fn wrap(self) -> Chunk {
    Chunk::Sql(self)
  }

  /// Renders to SQLite text with `?` placeholders.
  pub fn render(&self) -> Result<Query> {
    let mut q = Query::default();
    self.render_into(&mut q)?;
    Ok(q)
  }

  pub(crate) fn render_into(&self, q: &mut Query) -> Result<()> {
    for chunk in &self.chunks {
      render_chunk(chunk, q)?;
    }
    Ok(())
  }
}

fn render_value(v: &JsVal, q: &mut Query) -> Result<()> {
  match v {
    JsVal::Undefined => {}
    JsVal::Arr(items) => {
      q.sql.push('(');
      for (i, item) in items.iter().enumerate() {
        if i > 0 {
          q.sql.push_str(", ");
        }
        render_value(item, q)?;
      }
      q.sql.push(')');
    }
    other => {
      q.sql.push('?');
      q.params.push(bind_value(other)?);
    }
  }
  Ok(())
}

fn render_chunk(chunk: &Chunk, q: &mut Query) -> Result<()> {
  match chunk {
    Chunk::Str(s) => q.sql.push_str(s),
    Chunk::Col(c) => q.sql.push_str(&c.render()),
    Chunk::Param(v, col) => {
      let mapped = if v.is_null() { JsVal::Null } else { col.map_to_driver_value(v)? };
      q.sql.push('?');
      q.params.push(bind_value(&mapped)?);
    }
    Chunk::Value(v) => render_value(v, q)?,
    Chunk::Sql(s) => s.render_into(q)?,
    Chunk::Select(s) => {
      q.sql.push('(');
      s.render_into(q)?;
      q.sql.push(')');
    }
    Chunk::Undefined => {}
  }
  Ok(())
}

fn opt_expr_chunk(e: Option<&Expr>) -> Chunk {
  e.map(Expr::chunk).unwrap_or(Chunk::Undefined)
}

/// drizzle `bindIfParam(value, column)`
fn bind_if_param(right: &Operand, left: Option<&Expr>) -> Chunk {
  match right {
    Operand::Expr(e) => e.chunk(),
    Operand::Val(v) => match left {
      Some(Expr::Col(c)) => Chunk::Param(v.clone(), c.clone()),
      _ => Chunk::Value(v.clone()),
    },
  }
}

fn operand_chunk(right: &Operand) -> Chunk {
  match right {
    Operand::Expr(e) => e.chunk(),
    Operand::Val(v) => Chunk::Value(v.clone()),
  }
}

fn binary(left: Option<&Expr>, op: &str, right: Chunk) -> Sql {
  Sql::new(vec![opt_expr_chunk(left), Chunk::Str(format!(" {op} ")), right])
}

pub fn eq(left: Option<&Expr>, right: impl Into<Operand>) -> Sql {
  let r = right.into();
  binary(left, "=", bind_if_param(&r, left))
}

pub fn ne(left: Option<&Expr>, right: impl Into<Operand>) -> Sql {
  let r = right.into();
  binary(left, "<>", bind_if_param(&r, left))
}

pub fn gt(left: Option<&Expr>, right: impl Into<Operand>) -> Sql {
  let r = right.into();
  binary(left, ">", bind_if_param(&r, left))
}

pub fn gte(left: Option<&Expr>, right: impl Into<Operand>) -> Sql {
  let r = right.into();
  binary(left, ">=", bind_if_param(&r, left))
}

pub fn lt(left: Option<&Expr>, right: impl Into<Operand>) -> Sql {
  let r = right.into();
  binary(left, "<", bind_if_param(&r, left))
}

pub fn lte(left: Option<&Expr>, right: impl Into<Operand>) -> Sql {
  let r = right.into();
  binary(left, "<=", bind_if_param(&r, left))
}

/// drizzle `like` (no driver encoding of the value).
pub fn like(left: Option<&Expr>, right: impl Into<Operand>) -> Sql {
  binary(left, "like", operand_chunk(&right.into()))
}

pub fn not_like(left: Option<&Expr>, right: impl Into<Operand>) -> Sql {
  binary(left, "not like", operand_chunk(&right.into()))
}

/// drizzle `inArray` / `notInArray`.
fn in_list(left: Option<&Expr>, values: &Operand, op: &str, empty: &str) -> Sql {
  match values {
    Operand::Val(JsVal::Arr(items)) => {
      if items.is_empty() {
        return Sql::raw(empty);
      }
      let mut chunks = vec![opt_expr_chunk(left), Chunk::Str(format!(" {op} ("))];
      for (i, item) in items.iter().enumerate() {
        if i > 0 {
          chunks.push(Chunk::Str(", ".into()));
        }
        chunks.push(bind_if_param(&Operand::Val(item.clone()), left));
      }
      chunks.push(Chunk::Str(")".into()));
      Sql::new(chunks)
    }
    other => binary(left, op, bind_if_param(other, left)),
  }
}

pub fn in_array(left: Option<&Expr>, values: impl Into<Operand>) -> Sql {
  in_list(left, &values.into(), "in", "false")
}

pub fn not_in_array(left: Option<&Expr>, values: impl Into<Operand>) -> Sql {
  in_list(left, &values.into(), "not in", "true")
}

pub fn is_null(e: Option<&Expr>) -> Sql {
  Sql::new(vec![opt_expr_chunk(e), Chunk::Str(" is null".into())])
}

pub fn is_not_null(e: Option<&Expr>) -> Sql {
  Sql::new(vec![opt_expr_chunk(e), Chunk::Str(" is not null".into())])
}

pub fn exists(sub: Select) -> Sql {
  Sql::new(vec![Chunk::Str("exists ".into()), Chunk::Select(Box::new(sub))])
}

pub fn not_exists(sub: Select) -> Sql {
  Sql::new(vec![Chunk::Str("not exists ".into()), Chunk::Select(Box::new(sub))])
}

fn join_conditions(conditions: Vec<Option<Sql>>, sep: &str) -> Option<Sql> {
  let conditions: Vec<Sql> = conditions.into_iter().flatten().collect();
  match conditions.len() {
    0 => None,
    1 => Some(Sql::new(conditions.into_iter().map(Chunk::Sql).collect())),
    _ => {
      let mut chunks = vec![Chunk::Str("(".into())];
      for (i, c) in conditions.into_iter().enumerate() {
        if i > 0 {
          chunks.push(Chunk::Str(sep.into()));
        }
        chunks.push(Chunk::Sql(c));
      }
      chunks.push(Chunk::Str(")".into()));
      Some(Sql::new(chunks))
    }
  }
}

/// drizzle `and(...conditions)`; `None` mirrors `undefined`.
pub fn and(conditions: Vec<Option<Sql>>) -> Option<Sql> {
  join_conditions(conditions, " and ")
}

/// drizzle `or(...conditions)`
pub fn or(conditions: Vec<Option<Sql>>) -> Option<Sql> {
  join_conditions(conditions, " or ")
}

pub fn asc(e: &Expr) -> Sql {
  Sql::new(vec![e.chunk(), Chunk::Str(" asc".into())])
}

pub fn desc(e: &Expr) -> Sql {
  Sql::new(vec![e.chunk(), Chunk::Str(" desc".into())])
}

/// `json_object('key', value, ...)` (`utilities/json.ts` `jsonBuildObject` for SQLite).
pub fn json_build_object(shape: &[(String, Sql)]) -> Result<Sql> {
  let mut chunks = vec![Chunk::Str("json_object(".into())];
  for (i, (key, value)) in shape.iter().enumerate() {
    if key.is_empty() || !key.chars().all(crate::js_ops::is_word_char) {
      return Err(EngineError::api(
        "Unsafe key passed to jsonBuildObject. Only alphanumeric characters and underscores are allowed.",
      )
      .with_data(serde_json::json!({ "status": 500 })));
    }
    if i > 0 {
      // `sql.join(chunks)` without a separator: the `,` chunk is followed directly.
      chunks.push(Chunk::Str(",".into()));
    }
    chunks.push(Chunk::Str(format!("'{key}',")));
    chunks.push(Chunk::Sql(value.clone()));
  }
  chunks.push(Chunk::Str(")".into()));
  Ok(Sql::new(chunks))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JoinType {
  Inner,
  Left,
  Right,
}

impl JoinType {
  pub fn as_str(self) -> &'static str {
    match self {
      JoinType::Inner => "inner",
      JoinType::Left => "left",
      JoinType::Right => "right",
    }
  }
}

/// An entry of `BuildQueryJoinAliases`.
#[derive(Clone, Debug)]
pub struct Join {
  pub condition: Option<Sql>,
  pub is_one_to_many: bool,
  pub query_path: Option<String>,
  pub table: TableRef,
  /// `undefined` means `leftJoin`.
  pub join_type: Option<JoinType>,
}

impl Join {
  pub fn render_into(&self, q: &mut Query) -> Result<()> {
    q.sql.push_str(&format!(" {} join {} on ", self.join_type.unwrap_or(JoinType::Left).as_str(), self.table.render_from()));
    if let Some(c) = &self.condition {
      c.render_into(q)?;
    }
    Ok(())
  }
}

/// drizzle's `createJoin` check, run while the select builder is assembled:
/// a table (or alias) may only be joined once.
pub fn check_join_aliases(joins: &[Join]) -> Result<()> {
  for (i, join) in joins.iter().enumerate() {
    let name = join.table.ref_name();
    if joins[..i].iter().any(|j| j.table.ref_name() == name) {
      return Err(EngineError::internal(format!("Alias \"{name}\" is already used in this query")));
    }
  }
  Ok(())
}

/// A SELECT statement (drizzle `db.select(...)` builder subset).
#[derive(Clone, Debug, Default)]
pub struct Select {
  pub distinct: bool,
  pub fields: Vec<Sql>,
  pub from: Option<TableRef>,
  pub joins: Vec<Join>,
  pub where_: Option<Sql>,
  pub group_by: Vec<Sql>,
  pub order_by: Vec<Sql>,
  pub limit: Option<Sql>,
  pub offset: Option<Sql>,
}

impl Select {
  pub fn render(&self) -> Result<Query> {
    let mut q = Query::default();
    self.render_into(&mut q)?;
    Ok(q)
  }

  pub(crate) fn render_into(&self, q: &mut Query) -> Result<()> {
    q.sql.push_str(if self.distinct { "select distinct " } else { "select " });
    // drizzle `buildSelection({ isSingleTable })`: without joins, the top-level column chunks of
    // each selected field render as bare column identifiers.
    let is_single_table = self.joins.is_empty();
    for (i, f) in self.fields.iter().enumerate() {
      if i > 0 {
        q.sql.push_str(", ");
      }
      if is_single_table {
        for chunk in &f.chunks {
          match chunk {
            Chunk::Col(c) => q.sql.push_str(&quote(&c.name)),
            other => render_chunk(other, q)?,
          }
        }
      } else {
        f.render_into(q)?;
      }
    }
    if let Some(from) = &self.from {
      q.sql.push_str(" from ");
      q.sql.push_str(&from.render_from());
    }
    for j in &self.joins {
      j.render_into(q)?;
    }
    if let Some(w) = &self.where_ {
      q.sql.push_str(" where ");
      w.render_into(q)?;
    }
    let list = |q: &mut Query, kw: &str, items: &[Sql]| -> Result<()> {
      if items.is_empty() {
        return Ok(());
      }
      q.sql.push_str(kw);
      for (i, item) in items.iter().enumerate() {
        if i > 0 {
          q.sql.push_str(", ");
        }
        item.render_into(q)?;
      }
      Ok(())
    };
    list(q, " group by ", &self.group_by)?;
    list(q, " order by ", &self.order_by)?;
    if let Some(l) = &self.limit {
      q.sql.push_str(" limit ");
      l.render_into(q)?;
    }
    if let Some(o) = &self.offset {
      q.sql.push_str(" offset ");
      o.render_into(q)?;
    }
    Ok(())
  }
}

pub fn expr_sql(e: &Expr) -> Sql {
  Sql::new(vec![e.chunk()])
}

/// An expression as a selected field (drizzle `buildSelection`): `SQLiteNumericBigInt` columns are
/// selected as `cast("table"."column" as text)`.
pub fn selection_sql(e: &Expr) -> Sql {
  match e {
    Expr::Col(c) if c.decoder == Decoder::NumericBigInt => {
      Sql::new(vec![Chunk::Str("cast(".into()), e.chunk(), Chunk::Str(" as text)".into())])
    }
    _ => expr_sql(e),
  }
}
