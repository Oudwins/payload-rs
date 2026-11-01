//! A rendered SQL fragment: SQLite text with `?` placeholders plus the bound
//! parameter values, in the exact form drizzle's `dialect.sqlToQuery()`
//! produces (`{ sql, params }`).
//!
//! Composition mirrors drizzle's chunk rendering (`sql/sql.js`
//! `buildQueryFromSourceParams`) for the SQLite dialect: identifiers are
//! wrapped in double quotes, parameters render as `?`.

use payload_engine::js::JsVal;
use serde_json::{Value as Json, json};

/// A parameter value as drizzle hands it to the libsql client (after
/// `encoder.mapToDriverValue()`, before the client's `valueToSql`, which runs when the
/// statement is executed: [`crate::exec::bind_value`]).
pub type Param = JsVal;

#[derive(Clone, Debug, Default)]
pub struct Sql {
  pub sql: String,
  pub params: Vec<Param>,
}

/// Same text and params of the same encoded value.
impl PartialEq for Sql {
  fn eq(&self, other: &Sql) -> bool {
    self.sql == other.sql
      && self.params.len() == other.params.len()
      && self.params.iter().zip(&other.params).all(|(a, b)| {
        payload_engine::js::encode_value(a) == payload_engine::js::encode_value(b)
      })
  }
}

impl Sql {
  pub fn new() -> Self {
    Self::default()
  }

  /// `sql.raw(text)`
  pub fn raw(text: impl Into<String>) -> Self {
    Self { sql: text.into(), params: Vec::new() }
  }

  /// A single bound parameter (`?`).
  pub fn param(value: Param) -> Self {
    Self { sql: "?".into(), params: vec![value] }
  }

  /// `sql.identifier(name)` / `escapeName`
  pub fn ident(name: &str) -> Self {
    Self::raw(escape_name(name))
  }

  /// `"table"."column"`: a column rendered through a (possibly aliased) table.
  pub fn column(table: &str, column: &str) -> Self {
    Self::raw(format!("{}.{}", escape_name(table), escape_name(column)))
  }

  pub fn push_str(&mut self, text: &str) -> &mut Self {
    self.sql.push_str(text);
    self
  }

  pub fn push(&mut self, other: &Sql) -> &mut Self {
    self.sql.push_str(&other.sql);
    self.params.extend(other.params.iter().cloned());
    self
  }

  pub fn push_param(&mut self, value: Param) -> &mut Self {
    self.sql.push('?');
    self.params.push(value);
    self
  }

  /// `sql.join(chunks, separator)`
  pub fn join<'a>(items: impl IntoIterator<Item = &'a Sql>, separator: &str) -> Sql {
    let mut out = Sql::new();
    for (i, item) in items.into_iter().enumerate() {
      if i > 0 {
        out.push_str(separator);
      }
      out.push(item);
    }
    out
  }

  pub fn is_empty(&self) -> bool {
    self.sql.is_empty() && self.params.is_empty()
  }

  /// `{ sql, params }` with the params as `JSON.stringify` sees them.
  pub fn to_json(&self) -> Json {
    json!({ "sql": self.sql, "params": self.params.iter().map(JsVal::to_json).collect::<Vec<_>>() })
  }

  /// Reads `{ sql, params }` (the output of `dialect.sqlToQuery()`, plain JSON params).
  pub fn from_json(value: &Json) -> Option<Sql> {
    let sql = value.get("sql")?.as_str()?.to_string();
    let params = value.get("params").and_then(|p| p.as_array()).into_iter().flatten().map(JsVal::from_json).collect();
    Some(Sql { sql, params })
  }
}

/// `SQLiteDialect.escapeName`
pub fn escape_name(name: &str) -> String {
  format!("\"{}\"", name.replace('"', "\"\""))
}

/// drizzle `and(...conditions)`: drops `undefined`, a single condition is
/// returned as-is, several are wrapped in parentheses and joined by ` and `.
pub fn and(conditions: impl IntoIterator<Item = Option<Sql>>) -> Option<Sql> {
  combine(conditions, " and ")
}

/// drizzle `or(...conditions)`
pub fn or(conditions: impl IntoIterator<Item = Option<Sql>>) -> Option<Sql> {
  combine(conditions, " or ")
}

fn combine(conditions: impl IntoIterator<Item = Option<Sql>>, separator: &str) -> Option<Sql> {
  let conditions: Vec<Sql> = conditions.into_iter().flatten().collect();
  match conditions.len() {
    0 => None,
    1 => conditions.into_iter().next(),
    _ => {
      let mut out = Sql::raw("(");
      out.push(&Sql::join(conditions.iter(), separator));
      out.push_str(")");
      Some(out)
    }
  }
}

/// drizzle `eq(left, right)` for two SQL operands.
pub fn eq(left: &Sql, right: &Sql) -> Sql {
  let mut out = left.clone();
  out.push_str(" = ").push(right);
  out
}

/// drizzle `inArray(column, values)` with bound values.
pub fn in_array(column: &Sql, values: &[Param]) -> Sql {
  if values.is_empty() {
    return Sql::raw("false");
  }
  let mut out = column.clone();
  out.push_str(" in (");
  for (i, value) in values.iter().enumerate() {
    if i > 0 {
      out.push_str(", ");
    }
    out.push_param(value.clone());
  }
  out.push_str(")");
  out
}

/// drizzle `isNull(value)`
pub fn is_null(value: &Sql) -> Sql {
  let mut out = value.clone();
  out.push_str(" is null");
  out
}

/// drizzle `isNotNull(value)`
pub fn is_not_null(value: &Sql) -> Sql {
  let mut out = value.clone();
  out.push_str(" is not null");
  out
}
