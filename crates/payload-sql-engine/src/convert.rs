//! Conversions between the value types of the module crates.
//!
//! - [`JsVal`] (payload-engine): immutable values of the decoded config graph, the call
//!   arguments, the write path and the encoded results.
//! - [`Val`] (payload-sql-read): the mutable values the read transform works on.
//! - [`Json`] rows of payload-sql-find (plain JSON, no engine markers).
//! - Rendered SQL: payload-sql-query's [`Query`] (bound [`SqlValue`]s), payload-sql-upsert's
//!   [`SqlFragment`] (driver values) and payload-sql-find's [`FindSql`] (JSON params).
//!
//! Every conversion is structural: no conversion interprets user data as an internal marker.

use payload_engine::error::{EngineError, Result};
use payload_engine::js::{JsVal, Obj};
use payload_sql_find::sql::Sql as FindSql;
use payload_sql_query::{Query, Sql as QuerySql, SqlValue};
use payload_sql_read::Val;
use payload_sql_read::value::Builtin;
use payload_sql_upsert::SqlFragment;
use serde_json::Value as Json;

/// A read-transform result as an engine value. `Date`s become typed [`JsVal::date`]s, inherited
/// built-in functions `undefined` (what `serializeForEngine` would send for them), and a reference
/// back to an ancestor (only possible through user mutation) `undefined`.
pub fn val_to_js(value: &Val) -> JsVal {
  let mut ancestors = Vec::new();
  val_to_js_inner(value, &mut ancestors)
}

fn val_to_js_inner(value: &Val, ancestors: &mut Vec<usize>) -> JsVal {
  match value {
    Val::Undefined | Val::Builtin(Builtin::Function(_)) => JsVal::Undefined,
    Val::Builtin(Builtin::ObjectPrototype) => JsVal::obj(Obj::new()),
    Val::Null => JsVal::Null,
    Val::Bool(b) => JsVal::Bool(*b),
    Val::Num(n) => JsVal::Num(*n),
    Val::Str(s) => JsVal::str(s.to_lossy().as_ref()),
    Val::Date(ms) => JsVal::date(*ms),
    Val::Arr(a) => {
      let id = std::rc::Rc::as_ptr(a) as usize;
      if ancestors.contains(&id) {
        return JsVal::Undefined;
      }
      ancestors.push(id);
      let items = a.borrow().iter().map(|v| val_to_js_inner(v, ancestors)).collect();
      ancestors.pop();
      JsVal::arr(items)
    }
    Val::Obj(o) => {
      let id = std::rc::Rc::as_ptr(o) as usize;
      if ancestors.contains(&id) {
        return JsVal::Undefined;
      }
      ancestors.push(id);
      let entries = o.borrow().entries();
      let mut out = Obj::with_capacity(entries.len());
      for (k, v) in entries {
        out.insert(k.to_lossy().into_owned(), val_to_js_inner(&v, ancestors));
      }
      ancestors.pop();
      JsVal::obj(out)
    }
  }
}

/// A raw drizzle row (payload-sql-find JSON) as a mutable read-transform input, with JS property
/// order (array-index keys first).
pub fn row_to_val(row: &Json) -> Val {
  Val::from_js(&JsVal::from_json(row))
}

/// A raw drizzle row as an engine value.
pub fn row_to_js(row: &Json) -> JsVal {
  JsVal::from_json(row)
}

/// A bound SQLite value as the driver value it was bound from.
pub fn sql_value_to_js(value: &SqlValue) -> JsVal {
  match value {
    SqlValue::Null => JsVal::Null,
    SqlValue::Real(n) => JsVal::Num(*n),
    SqlValue::Text(s) => JsVal::str(s.as_str()),
  }
}

/// A rendered query-crate statement as an upsert-crate fragment (`dialect.sqlToQuery` output).
pub fn query_to_fragment(query: Query) -> SqlFragment {
  SqlFragment::new(query.sql, query.params.iter().map(sql_value_to_js).collect())
}

/// Renders a query-crate SQL tree as an upsert-crate fragment.
pub fn render_fragment(sql: &QuerySql) -> Result<SqlFragment> {
  Ok(query_to_fragment(sql.render()?))
}

/// An upsert-crate fragment as a payload-sql-find SQL value. Driver values bind like libsql:
/// the same errors as `@libsql/client` for values it cannot bind.
pub fn fragment_to_find_sql(fragment: &SqlFragment) -> Result<FindSql> {
  let params = fragment.params.iter().map(driver_value_to_json).collect::<Result<Vec<_>>>()?;
  Ok(FindSql { sql: fragment.sql.clone(), params })
}

fn driver_value_to_json(value: &JsVal) -> Result<Json> {
  Ok(match value {
    JsVal::Null => Json::Null,
    JsVal::Bool(b) => Json::from(if *b { 1.0 } else { 0.0 }),
    JsVal::Num(n) if !n.is_finite() => {
      return Err(EngineError::new("RangeError", "Only finite numbers (not Infinity or NaN) can be passed as arguments"));
    }
    JsVal::Num(n) => payload_engine::js::num_to_json(*n),
    JsVal::Str(s) => Json::String(s.to_string()),
    JsVal::Undefined => {
      return Err(EngineError::new("TypeError", "undefined cannot be passed as argument to the database"));
    }
    JsVal::Arr(_) | JsVal::Obj(_) | JsVal::Fn(_) => {
      return Err(EngineError::new("Error", "SQLite3 can only bind numbers, strings, bigints, buffers, and null"));
    }
  })
}

/// Renders a query-crate SQL tree for payload-sql-find (params as JSON).
pub fn render_find_sql(sql: &QuerySql) -> Result<FindSql> {
  payload_sql_find::query::render(sql)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn rows_keep_user_marker_shapes_as_data() {
    let row = serde_json::json!({ "data": { "$undefined": true }, "b": 1, "2": "x", "1": "y" });
    let js = val_to_js(&row_to_val(&row));
    let encoded = payload_engine::js::encode_value(&js);
    // integer-like keys first, like JS; the marker-shaped user object is escaped, not decoded
    assert_eq!(encoded.to_string(), r#"{"1":"y","2":"x","data":{"$obj":{"$undefined":true}},"b":1}"#);
  }

  #[test]
  fn fragments_bind_like_libsql() {
    let ok = SqlFragment::new("x = ?", vec![JsVal::Bool(true)]);
    assert_eq!(fragment_to_find_sql(&ok).unwrap().params, vec![serde_json::json!(1.0)]);
    let nan = SqlFragment::new("x = ?", vec![JsVal::Num(f64::NAN)]);
    assert_eq!(fragment_to_find_sql(&nan).unwrap_err().name, "RangeError");
  }
}
