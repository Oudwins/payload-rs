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
use payload_engine::js::{JsVal, Obj, TypedValue};
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
pub fn map_to_driver(column_type: &str, value: &JsVal) -> Result<JsVal> {
  if value.is_null() {
    return Ok(JsVal::Null);
  }
  Ok(match column_type {
    // integer(name, { mode: 'boolean' }): `value ? 1 : 0`
    "boolean" => JsVal::Num(if value.truthy() { 1.0 } else { 0.0 }),
    // text(name, { mode: 'json' }): `JSON.stringify(value)`
    "jsonb" | "geometry" => json_stringify(value)?.map(JsVal::str).unwrap_or(JsVal::Undefined),
    // numeric(name, { mode: 'number' }): `String(value)`
    "numeric" => JsVal::str(to_js_string(value)),
    _ => value.clone(),
  })
}

/// An error of `valueToSql` (`RangeError` / `TypeError`) or of the binding (`Error`).
#[derive(Clone, Debug)]
pub struct BindError {
  /// The JS class: `RangeError`, `TypeError` or `Error`.
  pub kind: &'static str,
  pub message: String,
}

impl BindError {
  /// The binding's error for objects (raised once the statement is prepared).
  pub fn unbindable() -> Self {
    BindError { kind: "Error", message: "SQLite3 can only bind numbers, strings, bigints, buffers, and null".into() }
  }
}

/// `@libsql/client` `valueToSql` (intMode `number`) followed by libsql's native binding rules:
/// every JS number is bound as a double, booleans become numbers, a `bigint` a 64-bit integer, a
/// `Date` its time value. `Ok(None)` is a value the binding rejects (any other object).
pub fn value_to_sql(value: &JsVal) -> std::result::Result<Option<Value>, BindError> {
  match value.typed() {
    // `value.valueOf()`; an invalid date binds `NaN`, which SQLite stores as NULL
    Some(TypedValue::Date(ms)) => return Ok(Some(Value::Real(ms))),
    Some(TypedValue::BigInt(decimal)) => {
      return decimal.parse::<i64>().map(|n| Some(Value::Integer(n))).map_err(|_| BindError {
        kind: "RangeError",
        message: "bigint is too large to be represented as a 64-bit integer and passed as argument".into(),
      });
    }
    None => {}
  }
  Ok(Some(match value {
    JsVal::Null => Value::Null,
    JsVal::Bool(b) => Value::Real(if *b { 1.0 } else { 0.0 }),
    JsVal::Num(n) => {
      if !n.is_finite() {
        return Err(BindError {
          kind: "RangeError",
          message: "Only finite numbers (not Infinity or NaN) can be passed as arguments".into(),
        });
      }
      Value::Real(*n)
    }
    JsVal::Str(s) => Value::Text(s.to_string()),
    JsVal::Undefined => {
      return Err(BindError { kind: "TypeError", message: "undefined cannot be passed as argument to the database".into() });
    }
    JsVal::Arr(_) | JsVal::Obj(_) | JsVal::Fn(_) => return Ok(None),
  }))
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
    // `JSON.parse(value)` stringifies non-string driver values first (a blob is an `ArrayBuffer`)
    "jsonb" | "geometry" => match &value {
      JsVal::Str(s) => json_parse(s)?,
      JsVal::Arr(_) => json_parse("[object ArrayBuffer]")?,
      other => json_parse(&to_js_string(other))?,
    },
    "numeric" => match &value {
      JsVal::Num(_) => value,
      other => JsVal::Num(js_to_number(other)),
    },
    _ => value,
  })
}

/// `JSON.parse(text)` with JS object key order (integer-like keys first), any nesting depth,
/// V8's number rounding (`1e400` is `Infinity`) and V8's `SyntaxError` messages.
pub fn json_parse(text: &str) -> Result<JsVal> {
  payload_sql_read::json::parse_to_js(text)
}

/// JS `Number(value)` for driver values (a blob is an `ArrayBuffer`: `NaN`).
pub fn js_to_number(value: &JsVal) -> f64 {
  match value {
    JsVal::Null => 0.0,
    JsVal::Undefined => f64::NAN,
    JsVal::Bool(b) => f64::from(u8::from(*b)),
    JsVal::Num(n) => *n,
    JsVal::Str(s) => payload_sql_read::jsops::string_to_number(s),
    _ => f64::NAN,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// drizzle `numeric` / `boolean` decoders use `Number(value)`; jsonb columns `JSON.parse`.
  #[test]
  fn driver_values_decode_like_js() {
    let num = |s: &str| match map_from_driver("numeric", JsVal::str(s)).unwrap() {
      JsVal::Num(n) => n,
      other => panic!("{other:?}"),
    };
    assert_eq!(num("0x10"), 16.0);
    assert_eq!(num("0b101"), 5.0);
    assert_eq!(num(" \u{FEFF}12\n"), 12.0);
    assert_eq!(num(""), 0.0);
    assert!(num("inf").is_nan());
    assert!(num("\u{85}1").is_nan());
    assert_eq!(num("0x20000000000003"), 9007199254740996.0);
    assert!(matches!(map_from_driver("boolean", JsVal::str("0x1")).unwrap(), JsVal::Bool(true)));
    let err = map_from_driver("jsonb", JsVal::str("{\"a\" 1}")).unwrap_err();
    assert_eq!((err.name.as_str(), err.message.as_str()), ("SyntaxError", "Expected ':' after property name in JSON at position 5 (line 1 column 6)"));
    let err = map_from_driver("jsonb", JsVal::Num(f64::INFINITY)).unwrap_err();
    assert_eq!(err.message, "\"Infinity\" is not valid JSON");
    assert!(matches!(map_from_driver("jsonb", JsVal::Num(5.0)).unwrap(), JsVal::Num(n) if n == 5.0));
  }

  /// `JSON.parse` has no nesting limit and rounds out-of-range literals to infinities; keys come
  /// in JS order (integer-like keys first).
  #[test]
  fn json_parse_is_exact() {
    // engine calls run on threads with a 16 MB stack (payload-sql-engine `stepped`)
    let deep = std::thread::Builder::new()
      .stack_size(16 * 1024 * 1024)
      .spawn(|| {
        let deep = format!("{}1{}", "[".repeat(5000), "]".repeat(5000));
        let parsed = json_parse(&deep).unwrap();
        let mut value = parsed.clone();
        for _ in 0..5000 {
          value = value.as_arr().expect("array")[0].clone();
        }
        matches!(value, JsVal::Num(n) if n == 1.0)
      })
      .unwrap()
      .join()
      .unwrap();
    assert!(deep);
    assert!(matches!(json_parse("1e400").unwrap(), JsVal::Num(n) if n == f64::INFINITY));
    assert!(matches!(json_parse("-1e400").unwrap(), JsVal::Num(n) if n == f64::NEG_INFINITY));
    assert!(matches!(json_parse("-0").unwrap(), JsVal::Num(n) if n == 0.0 && n.is_sign_negative()));
    let keys: Vec<String> = json_parse(r#"{"b":1,"2":2,"a":3,"1":4}"#).unwrap().as_obj().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["1", "2", "b", "a"]);
  }
}
