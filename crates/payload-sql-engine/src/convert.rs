//! Conversions between the value types of the module crates.
//!
//! - [`JsVal`] (payload-engine): immutable values of the decoded config graph, the call
//!   arguments, the write path and the encoded results.
//! - [`Val`] (payload-sql-read): the mutable values the read transform works on.
//! - [`Json`] rows of payload-sql-find (plain JSON, no engine markers).
//! - Rendered SQL: payload-sql-query's [`Query`], payload-sql-upsert's [`SqlFragment`] and
//!   payload-sql-find's [`FindSql`], all with driver values as params (libsql's `valueToSql` runs
//!   when a statement is executed, so its errors are the statement's).
//!
//! Every conversion is structural: no conversion interprets user data as an internal marker.

use payload_engine::error::Result;
use payload_engine::js::JsVal;
use payload_sql_find::sql::Sql as FindSql;
use payload_sql_query::{Query, Sql as QuerySql};
use payload_sql_read::Val;
use payload_sql_upsert::SqlFragment;
use serde_json::Value as Json;

/// A read-transform result as an engine value ([`Val::to_js`]).
pub fn val_to_js(value: &Val) -> JsVal {
  value.to_js()
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

/// A rendered query-crate statement as an upsert-crate fragment (`dialect.sqlToQuery` output).
pub fn query_to_fragment(query: Query) -> SqlFragment {
  SqlFragment::new(query.sql, query.params)
}

/// Renders a query-crate SQL tree as an upsert-crate fragment.
pub fn render_fragment(sql: &QuerySql) -> Result<SqlFragment> {
  Ok(query_to_fragment(sql.render()?))
}

/// An upsert-crate fragment as a payload-sql-find SQL value (the same driver values).
pub fn fragment_to_find_sql(fragment: &SqlFragment) -> Result<FindSql> {
  Ok(FindSql { sql: fragment.sql.clone(), params: fragment.params.clone() })
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
    use payload_sql_find::exec::bind_value;
    use payload_sqlite::{BindValue, ClientError};
    let ok = fragment_to_find_sql(&SqlFragment::new("x = ?", vec![JsVal::Bool(true), JsVal::bigint("7")])).unwrap();
    let bound = ok.params.iter().map(|p| bind_value(p).unwrap()).collect::<Vec<_>>();
    assert_eq!(bound, vec![BindValue::Real(1.0), BindValue::Integer(7)]);
    let nan = fragment_to_find_sql(&SqlFragment::new("x = ?", vec![JsVal::Num(f64::NAN)])).unwrap();
    assert!(matches!(bind_value(&nan.params[0]), Err(ClientError::Range(_))));
    let big = JsVal::bigint("9223372036854775808");
    assert!(matches!(bind_value(&big), Err(ClientError::Range(_))));
  }
}
