//! JS semantics needed by the write transform: property access on mutable
//! data (with the TypeErrors V8 throws), `Object.entries`, `JSON.stringify`,
//! `Number.prototype.toString`, `Date.prototype.toISOString` and JS object
//! key ordering (integer-like keys first).

use std::sync::Arc;

use indexmap::IndexMap;
use payload_engine::error::{EngineError, Result};
use payload_engine::js::{JsVal, Obj};

/// Properties every plain object inherits from `Object.prototype`, so
/// `obj[key]` is truthy for them even when `obj` has no own `key`.
pub const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
];

pub fn type_error(message: impl Into<String>) -> EngineError {
  EngineError::new("TypeError", message)
}

/// `String(value)` as used in V8 error messages and template literals.
pub fn to_js_string(v: &JsVal) -> String {
  match v {
    JsVal::Num(n) => number_to_string(*n),
    JsVal::Arr(a) => a
      .iter()
      .map(|v| if v.is_nullish() { String::new() } else { to_js_string(v) })
      .collect::<Vec<_>>()
      .join(","),
    other => other.to_js_string(),
  }
}

/// Is `key` a canonical array index (`"0"`, `"12"`, not `"01"`)? JS orders
/// such keys first, ascending, in every object.
pub fn is_array_index(key: &str) -> bool {
  if key.is_empty() || key.len() > 10 || !key.bytes().all(|b| b.is_ascii_digit()) {
    return false;
  }
  if key.len() > 1 && key.starts_with('0') {
    return false;
  }
  key.parse::<u64>().is_ok_and(|n| n < u32::MAX as u64)
}

fn insert_position<V>(map: &IndexMap<String, V>, key: &str) -> usize {
  if !is_array_index(key) {
    return map.len();
  }
  let n: u64 = key.parse().unwrap_or(0);
  map
    .keys()
    .position(|k| !is_array_index(k) || k.parse::<u64>().unwrap_or(0) > n)
    .unwrap_or(map.len())
}

/// `obj[key] = value` keeping JS property order.
pub fn js_insert<V>(map: &mut IndexMap<String, V>, key: impl Into<String>, value: V) {
  let key = key.into();
  if let Some(slot) = map.get_mut(&key) {
    *slot = value;
    return;
  }
  let pos = insert_position(map, &key);
  map.shift_insert(pos, key, value);
}

/// `if (!obj[key]) obj[key] = default` for container values, keeping JS order.
pub fn js_entry<'m, V: Default>(map: &'m mut IndexMap<String, V>, key: &str) -> &'m mut V {
  if !map.contains_key(key) {
    js_insert(map, key, V::default());
  }
  map.get_mut(key).expect("inserted above")
}

/// `value[key]` for a value that must not be nullish (V8 TypeError otherwise).
pub fn get<'a>(v: &'a JsVal, key: &str) -> Result<&'a JsVal> {
  match v {
    JsVal::Null | JsVal::Undefined => {
      Err(type_error(format!("Cannot read properties of {} (reading '{key}')", to_js_string(v))))
    }
    JsVal::Arr(a) if is_array_index(key) => Ok(a.get(key.parse::<usize>().unwrap_or(usize::MAX)).unwrap_or(&UNDEFINED)),
    other => Ok(other.get(key)),
  }
}

static UNDEFINED: JsVal = JsVal::Undefined;

/// `key in value` (only reached for object-like values in the TS code).
pub fn has(v: &JsVal, key: &str) -> Result<bool> {
  match v {
    JsVal::Obj(o) => Ok(o.contains_key(key)),
    JsVal::Arr(a) => Ok(key == "length" || (is_array_index(key) && key.parse::<usize>().is_ok_and(|i| i < a.len()))),
    JsVal::Fn(_) => Ok(false),
    other => Err(type_error(format!("Cannot use 'in' operator to search for '{key}' in {}", to_js_string(other)))),
  }
}

/// `Object.entries(value)` / `Object.keys(value)` (keys only).
pub fn keys(v: &JsVal) -> Result<Vec<String>> {
  match v {
    JsVal::Null | JsVal::Undefined => Err(type_error("Cannot convert undefined or null to object")),
    JsVal::Obj(o) => Ok(o.keys().cloned().collect()),
    JsVal::Arr(a) => Ok((0..a.len()).map(|i| i.to_string()).collect()),
    JsVal::Str(s) => Ok((0..s.encode_utf16().count()).map(|i| i.to_string()).collect()),
    _ => Ok(Vec::new()),
  }
}

/// `Object.entries(value)` for object-like values.
pub fn entries(v: &JsVal) -> Result<Vec<(String, JsVal)>> {
  match v {
    JsVal::Null | JsVal::Undefined => Err(type_error("Cannot convert undefined or null to object")),
    JsVal::Obj(o) => Ok(o.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
    JsVal::Arr(a) => Ok(a.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect()),
    _ => Ok(Vec::new()),
  }
}

/// Mutable access to an own property / array element.
pub fn get_mut<'a>(v: &'a mut JsVal, key: &str) -> Option<&'a mut JsVal> {
  match v {
    JsVal::Obj(o) => Arc::make_mut(o).get_mut(key),
    JsVal::Arr(a) if is_array_index(key) => Arc::make_mut(a).get_mut(key.parse::<usize>().ok()?),
    _ => None,
  }
}

/// `value[key] = new` in strict mode.
pub fn set(v: &mut JsVal, key: &str, value: JsVal) -> Result<()> {
  match v {
    JsVal::Obj(o) => {
      js_insert(Arc::make_mut(o), key, value);
      Ok(())
    }
    JsVal::Arr(a) => {
      // Non-index properties on arrays cannot be represented; JSON drops them too.
      if is_array_index(key) {
        let a = Arc::make_mut(a);
        let i: usize = key.parse().unwrap_or(usize::MAX);
        if i < a.len() {
          a[i] = value;
        } else if i < a.len() + 1_000_000 {
          a.resize(i, JsVal::Undefined);
          a.push(value);
        }
      }
      Ok(())
    }
    JsVal::Null | JsVal::Undefined => {
      Err(type_error(format!("Cannot set properties of {} (setting '{key}')", to_js_string(v))))
    }
    JsVal::Fn(_) => Ok(()),
    other => {
      let kind = match other {
        JsVal::Str(_) => "string",
        JsVal::Num(_) => "number",
        _ => "boolean",
      };
      Err(type_error(format!("Cannot create property '{key}' on {kind} '{}'", to_js_string(other))))
    }
  }
}

/// `delete value[key]` in strict mode.
pub fn delete(v: &mut JsVal, key: &str) -> Result<()> {
  match v {
    JsVal::Obj(o) => {
      if o.contains_key(key) {
        Arc::make_mut(o).shift_remove(key);
      }
      Ok(())
    }
    JsVal::Null | JsVal::Undefined => Err(type_error("Cannot convert undefined or null to object")),
    _ => Ok(()),
  }
}

/// Runs `f` on `[value]` when `value` is not an array, writing the (possibly
/// mutated) element back, so mutations through `[x]` reach the original `x`
/// like they do in JS.
pub fn with_wrapped<R>(value: &mut JsVal, f: impl FnOnce(&mut JsVal) -> R) -> R {
  if matches!(value, JsVal::Arr(_)) {
    return f(value);
  }
  let mut wrapped = JsVal::arr(vec![std::mem::take(value)]);
  let result = f(&mut wrapped);
  if let JsVal::Arr(a) = wrapped {
    *value = Arc::try_unwrap(a).map(|v| v.into_iter().next().unwrap_or_default()).unwrap_or_else(|a| a[0].clone());
  }
  result
}

/// `Number.prototype.toString()` (radix 10).
pub fn number_to_string(n: f64) -> String {
  if n.is_nan() {
    return "NaN".into();
  }
  if n == 0.0 {
    return "0".into();
  }
  if n.is_infinite() {
    return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() };
  }
  let sign = if n < 0.0 { "-" } else { "" };
  // `{:e}` yields the shortest round-tripping digits, like V8.
  let formatted = format!("{:e}", n.abs());
  let (mantissa, exp) = formatted.split_once('e').unwrap_or((&formatted, "0"));
  let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
  let k = digits.len() as i64;
  let point = exp.parse::<i64>().unwrap_or(0) + 1;
  let body = if k <= point && point <= 21 {
    format!("{digits}{}", "0".repeat((point - k) as usize))
  } else if 0 < point && point <= 21 {
    format!("{}.{}", &digits[..point as usize], &digits[point as usize..])
  } else if -6 < point && point <= 0 {
    format!("0.{}{digits}", "0".repeat((-point) as usize))
  } else {
    let e = point - 1;
    let e = if e >= 0 { format!("+{e}") } else { e.to_string() };
    if k == 1 { format!("{digits}e{e}") } else { format!("{}.{}e{e}", &digits[..1], &digits[1..]) }
  };
  format!("{sign}{body}")
}

fn quote(s: &str, out: &mut String) {
  out.push('"');
  for c in s.chars() {
    match c {
      '"' => out.push_str("\\\""),
      '\\' => out.push_str("\\\\"),
      '\u{8}' => out.push_str("\\b"),
      '\u{c}' => out.push_str("\\f"),
      '\n' => out.push_str("\\n"),
      '\r' => out.push_str("\\r"),
      '\t' => out.push_str("\\t"),
      c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
      c => out.push(c),
    }
  }
  out.push('"');
}

fn stringify_into(v: &JsVal, out: &mut String) {
  match v {
    JsVal::Undefined | JsVal::Fn(_) | JsVal::Null => out.push_str("null"),
    JsVal::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
    JsVal::Num(n) => {
      if n.is_finite() {
        out.push_str(&number_to_string(*n))
      } else {
        out.push_str("null")
      }
    }
    JsVal::Str(s) => quote(s, out),
    JsVal::Arr(a) => {
      out.push('[');
      for (i, item) in a.iter().enumerate() {
        if i > 0 {
          out.push(',');
        }
        stringify_into(item, out);
      }
      out.push(']');
    }
    JsVal::Obj(o) => {
      out.push('{');
      let mut first = true;
      for (k, item) in o.iter() {
        if matches!(item, JsVal::Undefined | JsVal::Fn(_)) {
          continue;
        }
        if !first {
          out.push(',');
        }
        first = false;
        quote(k, out);
        out.push(':');
        stringify_into(item, out);
      }
      out.push('}');
    }
  }
}

/// `JSON.stringify(value)`; `None` where JS returns `undefined`.
pub fn json_stringify(v: &JsVal) -> Option<String> {
  if matches!(v, JsVal::Undefined | JsVal::Fn(_)) {
    return None;
  }
  let mut out = String::new();
  stringify_into(v, &mut out);
  Some(out)
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
  let z = z + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z.rem_euclid(146_097);
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = if mp < 10 { mp + 3 } else { mp - 9 };
  (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `new Date(ms).toISOString()`.
pub fn iso_string(ms: f64) -> Result<String> {
  if !ms.is_finite() || ms.abs() > 8.64e15 {
    return Err(EngineError::new("RangeError", "Invalid time value"));
  }
  let t = ms.trunc() as i64;
  let days = t.div_euclid(86_400_000);
  let rem = t.rem_euclid(86_400_000);
  let (y, mo, d) = civil_from_days(days);
  let year = if (0..=9999).contains(&y) {
    format!("{y:04}")
  } else if y < 0 {
    format!("-{:06}", -y)
  } else {
    format!("+{y:06}")
  };
  Ok(format!(
    "{year}-{mo:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
    rem / 3_600_000,
    rem / 60_000 % 60,
    rem / 1000 % 60,
    rem % 1000
  ))
}

/// Current time in ms, like `Date.now()`.
pub fn now_ms() -> f64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as f64)
    .unwrap_or(0.0)
}

/// Builds an object literal, keeping JS key order.
pub fn obj<const N: usize>(entries: [(&str, JsVal); N]) -> Obj {
  let mut o = Obj::new();
  for (k, v) in entries {
    js_insert(&mut o, k, v);
  }
  o
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn numbers_format_like_v8() {
    let cases = [
      (1.0, "1"),
      (-1.5, "-1.5"),
      (0.1, "0.1"),
      (1e21, "1e+21"),
      (1e20, "100000000000000000000"),
      (1.5e-7, "1.5e-7"),
      (0.000001, "0.000001"),
      (123456.789, "123456.789"),
      (-0.0, "0"),
      (2.5e-10, "2.5e-10"),
      (1.7976931348623157e308, "1.7976931348623157e+308"),
      (5e-324, "5e-324"),
    ];
    for (n, s) in cases {
      assert_eq!(number_to_string(n), s, "{n}");
    }
  }

  #[test]
  fn iso_strings() {
    assert_eq!(iso_string(0.0).unwrap(), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_string(1_700_000_000_123.0).unwrap(), "2023-11-14T22:13:20.123Z");
    assert_eq!(iso_string(-1.0).unwrap(), "1969-12-31T23:59:59.999Z");
    assert_eq!(iso_string(-62_198_755_200_000.0).unwrap(), "-000001-01-01T00:00:00.000Z");
    assert_eq!(iso_string(253_402_300_800_000.0).unwrap(), "+010000-01-01T00:00:00.000Z");
    assert!(iso_string(8.64e15 + 1.0).is_err());
  }

  #[test]
  fn key_order() {
    let mut m: IndexMap<String, i32> = IndexMap::new();
    js_insert(&mut m, "b", 1);
    js_insert(&mut m, "2", 2);
    js_insert(&mut m, "a", 3);
    js_insert(&mut m, "1", 4);
    js_insert(&mut m, "01", 5);
    assert_eq!(m.keys().collect::<Vec<_>>(), ["1", "2", "b", "a", "01"]);
  }

  #[test]
  fn stringify() {
    let v = JsVal::obj(obj([
      ("a", JsVal::Num(1.5)),
      ("b", JsVal::Undefined),
      ("c", JsVal::arr(vec![JsVal::Undefined, JsVal::str("x\n\u{1}\"")])),
    ]));
    assert_eq!(json_stringify(&v).unwrap(), r#"{"a":1.5,"c":[null,"x\n\u0001\""]}"#);
  }
}
