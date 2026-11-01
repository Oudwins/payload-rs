//! Value conversion between JS values and SQLite, mirroring drizzle-orm's
//! sqlite-core column encoders (`mapToDriverValue` / `mapFromDriverValue`)
//! and the `@libsql/client` binding rules (`valueToSql` / `valueFromSql` in
//! `@libsql/client/lib-esm/sqlite3.js`).
//!
//! Values are [`JsVal`]s end to end: an own property set to `undefined` is
//! `JsVal::Undefined` and drizzle `SQL` values are typed
//! [`payload_sql_write::RowValue::Sql`] values, so user data can never be
//! mistaken for an internal marker.

use payload_engine::error::{EngineError, Result};
use payload_engine::js::{JsVal, Obj};
use payload_sql_write::js::{js_insert, json_stringify, to_js_string};
use payload_sql_write::{Row, RowValue};
use rusqlite::types::{Value, ValueRef};

/// `row[key]` with own `undefined` values mapped to `None` (SQL values are defined).
pub fn get_defined<'a>(row: &'a Row, key: &str) -> Option<&'a RowValue> {
  row.get(key).filter(|v| !matches!(v, RowValue::Value(JsVal::Undefined)))
}

/// `row[key]` as a plain value (`undefined` for missing keys and SQL values).
pub fn row_value<'a>(row: &'a Row, key: &str) -> &'a JsVal {
  static UNDEFINED: JsVal = JsVal::Undefined;
  match row.get(key) {
    Some(RowValue::Value(v)) => v,
    _ => &UNDEFINED,
  }
}

/// `row[key] = value` keeping JS key order.
pub fn row_set(row: &mut Row, key: &str, value: JsVal) {
  js_insert(row, key, RowValue::Value(value));
}

/// Plain object → row (all values are plain values).
pub fn obj_into_row(obj: Obj) -> Row {
  obj.into_iter().map(|(k, v)| (k, RowValue::Value(v))).collect()
}

/// drizzle sqlite column `mapToDriverValue` for the drizzle column built from
/// a RawColumn `type` (packages/drizzle/src/sqlite/schema/buildDrizzleTable.ts).
/// `null` bypasses the encoder (drizzle `Param` handling).
pub fn map_to_driver(column_type: &str, value: &JsVal) -> JsVal {
  if value.is_null() {
    return JsVal::Null;
  }
  match column_type {
    // integer(name, { mode: 'boolean' }): `value ? 1 : 0`
    "boolean" => JsVal::Num(if value.truthy() { 1.0 } else { 0.0 }),
    // text(name, { mode: 'json' }): `JSON.stringify(value)`
    "jsonb" | "geometry" => json_stringify(value).map(JsVal::str).unwrap_or(JsVal::Undefined),
    // numeric(name, { mode: 'number' }): `String(value)`
    "numeric" => JsVal::str(to_js_string(value)),
    _ => value.clone(),
  }
}

/// A bound SQLite value: `@libsql/client` `valueToSql` followed by libsql's
/// native binding (every JS number is bound as a double, booleans become numbers).
pub fn bind_value(value: &JsVal) -> Result<Value> {
  Ok(match value {
    JsVal::Null => Value::Null,
    JsVal::Bool(b) => Value::Real(if *b { 1.0 } else { 0.0 }),
    JsVal::Num(n) => {
      if !n.is_finite() {
        return Err(EngineError::new("RangeError", "Only finite numbers (not Infinity or NaN) can be passed as arguments"));
      }
      Value::Real(*n)
    }
    JsVal::Str(s) => Value::Text(s.to_string()),
    JsVal::Undefined => {
      return Err(EngineError::new("TypeError", "undefined cannot be passed as argument to the database"));
    }
    JsVal::Arr(_) | JsVal::Obj(_) | JsVal::Fn(_) => {
      return Err(EngineError::new("Error", "SQLite3 can only bind numbers, strings, bigints, buffers, and null"));
    }
  })
}

/// `@libsql/client` `valueFromSql` (intMode `number`).
pub fn value_from_sql(value: ValueRef<'_>) -> Result<JsVal> {
  Ok(match value {
    ValueRef::Null => JsVal::Null,
    ValueRef::Integer(i) => {
      if i.unsigned_abs() > 9_007_199_254_740_991 {
        return Err(EngineError::new("RangeError", "Received integer which cannot be safely represented as a JavaScript number"));
      }
      JsVal::Num(i as f64)
    }
    ValueRef::Real(f) => JsVal::Num(f),
    ValueRef::Text(t) => JsVal::str(String::from_utf8_lossy(t).as_ref()),
    ValueRef::Blob(b) => JsVal::arr(b.iter().map(|x| JsVal::Num(f64::from(*x))).collect()),
  })
}

/// drizzle sqlite column `mapFromDriverValue` (skipped for `null`).
pub fn map_from_driver(column_type: &str, value: JsVal) -> Result<JsVal> {
  if value.is_null() {
    return Ok(value);
  }
  Ok(match column_type {
    "boolean" => JsVal::Bool(js_to_number(&value) == 1.0),
    "jsonb" | "geometry" => match &value {
      JsVal::Str(s) => json_parse(s)?,
      other => other.clone(),
    },
    "numeric" => match &value {
      JsVal::Num(_) => value,
      other => JsVal::Num(js_to_number(other)),
    },
    _ => value,
  })
}

/// `JSON.parse(text)` with JS object key order (integer-like keys first).
pub fn json_parse(text: &str) -> Result<JsVal> {
  let json: serde_json::Value = serde_json::from_str(text)
    .map_err(|e| EngineError::new("SyntaxError", format!("JSON.parse failed: {e}")))?;
  Ok(from_json_js(&json))
}

fn from_json_js(json: &serde_json::Value) -> JsVal {
  match json {
    serde_json::Value::Array(a) => JsVal::arr(a.iter().map(from_json_js).collect()),
    serde_json::Value::Object(o) => {
      let mut out = Obj::new();
      for (k, v) in o {
        js_insert(&mut out, k.clone(), from_json_js(v));
      }
      JsVal::obj(out)
    }
    other => JsVal::from_json(other),
  }
}

/// JS `Number(value)` for primitives.
pub fn js_to_number(value: &JsVal) -> f64 {
  match value {
    JsVal::Null => 0.0,
    JsVal::Undefined => f64::NAN,
    JsVal::Bool(b) => f64::from(u8::from(*b)),
    JsVal::Num(n) => *n,
    JsVal::Str(s) => {
      let t = s.trim();
      if t.is_empty() {
        0.0
      } else {
        t.parse::<f64>().unwrap_or(f64::NAN)
      }
    }
    _ => f64::NAN,
  }
}
