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
  payload_engine::js::num_to_js_string(n)
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

/// The key under which `JSON.stringify` reached a value (for the circular structure message).
enum StackKey {
  Index(usize),
  Prop(String),
}

impl StackKey {
  fn describe(&self) -> String {
    match self {
      StackKey::Index(i) => format!("index {i}"),
      StackKey::Prop(k) => format!("property '{k}'"),
    }
  }
}

fn constructor_name(v: &JsVal) -> &'static str {
  if matches!(v, JsVal::Arr(_)) { "Array" } else { "Object" }
}

/// V8's `TypeError` for a circular structure: the cycle from the object that is visited again,
/// with at most two lines after it, an ellipsis and the last line.
fn circular_error(stack: &[(StackKey, usize, &'static str)], start: usize, closing: &StackKey) -> EngineError {
  const PREFIX: usize = 2;
  const POSTFIX: usize = 1;
  let mut message = format!("Converting circular structure to JSON\n    --> starting at object with constructor '{}'", stack[start].2);
  let line = |(key, _, ctor): &(StackKey, usize, &'static str)| format!("\n    |     {} -> object with constructor '{ctor}'", key.describe());
  let prefix_end = stack.len().min(start + 1 + PREFIX);
  for entry in &stack[start + 1..prefix_end] {
    message.push_str(&line(entry));
  }
  if stack.len() > prefix_end + POSTFIX {
    message.push_str("\n    |     ...");
  }
  for entry in &stack[prefix_end.max(stack.len().saturating_sub(POSTFIX))..] {
    message.push_str(&line(entry));
  }
  message.push_str(&format!("\n    --- {} closes the circle", closing.describe()));
  type_error(message)
}

fn stringify_into(v: &JsVal, key: StackKey, out: &mut String, stack: &mut Vec<(StackKey, usize, &'static str)>) -> Result<()> {
  match v.typed() {
    // `Date.prototype.toJSON`: `null` for an invalid date
    Some(payload_engine::js::TypedValue::Date(ms)) => {
      match iso_string(ms) {
        Ok(iso) => quote(&iso, out),
        Err(_) => out.push_str("null"),
      }
      return Ok(());
    }
    Some(payload_engine::js::TypedValue::BigInt(_)) => return Err(type_error("Do not know how to serialize a BigInt")),
    None => {}
  }
  if let Some(id) = v.identity() {
    if let Some(start) = stack.iter().position(|(_, seen, _)| *seen == id) {
      return Err(circular_error(stack, start, &key));
    }
    stack.push((key, id, constructor_name(v)));
  }
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
        stringify_into(item, StackKey::Index(i), out, stack)?;
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
        stringify_into(item, StackKey::Prop(k.clone()), out, stack)?;
      }
      out.push('}');
    }
  }
  if v.identity().is_some() {
    stack.pop();
  }
  Ok(())
}

/// `JSON.stringify(value)`; `Ok(None)` where JS returns `undefined`. `Date`s serialize through
/// `toJSON`; `bigint`s and circular structures throw V8's `TypeError`s.
pub fn json_stringify(v: &JsVal) -> Result<Option<String>> {
  if matches!(v, JsVal::Undefined | JsVal::Fn(_)) {
    return Ok(None);
  }
  let mut out = String::new();
  stringify_into(v, StackKey::Prop(String::new()), &mut out, &mut Vec::new())?;
  Ok(Some(out))
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

  /// Messages recorded from Node 24 (`JSON.stringify` of the same structures).
  #[test]
  fn stringify_errors_match_v8() {
    // builds the structure with a "\0self" marker string, then points the markers at the root
    let cyclic = |build: &dyn Fn(JsVal) -> JsVal| {
      let mut heap = crate::heap::Heap::default();
      let tree = heap.import(&build(JsVal::str("\u{0}self")));
      // replace every "\0self" string by the root object
      fn patch(heap: &mut crate::heap::Heap, v: &crate::heap::HVal, root: &crate::heap::HVal) {
        for (k, item) in heap.entries(v).unwrap() {
          match &item {
            crate::heap::HVal::Prim(JsVal::Str(s)) if &**s == "\u{0}self" => heap.set(v, &k, root.clone()).unwrap(),
            crate::heap::HVal::Node(_) => patch(heap, &item, root),
            _ => {}
          }
        }
      }
      patch(&mut heap, &tree, &tree);
      heap.export(&tree, &mut Default::default())
    };
    let message = |v: &JsVal| json_stringify(v).unwrap_err().message;
    let obj1 = |k: &str, v: JsVal| JsVal::obj(Obj::from([(k.to_string(), v)]));

    let a = cyclic(&|s| obj1("self", s));
    assert_eq!(
      message(&a),
      "Converting circular structure to JSON\n    --> starting at object with constructor 'Object'\n    --- property 'self' closes the circle"
    );
    let b = cyclic(&|s| obj1("x", obj1("y", JsVal::arr(vec![JsVal::Num(1.0), obj1("z", s)]))));
    assert_eq!(
      message(&b),
      "Converting circular structure to JSON\n    --> starting at object with constructor 'Object'\n    |     property 'x' -> object with constructor 'Object'\n    |     property 'y' -> object with constructor 'Array'\n    |     index 1 -> object with constructor 'Object'\n    --- property 'z' closes the circle"
    );
    let c = cyclic(&|s| obj1("q", obj1("r", obj1("s", obj1("t", obj1("u", s))))));
    assert_eq!(
      message(&c),
      "Converting circular structure to JSON\n    --> starting at object with constructor 'Object'\n    |     property 'q' -> object with constructor 'Object'\n    |     property 'r' -> object with constructor 'Object'\n    |     ...\n    |     property 't' -> object with constructor 'Object'\n    --- property 'u' closes the circle"
    );
    let d = cyclic(&|s| JsVal::arr(vec![JsVal::Num(1.0), s]));
    assert_eq!(
      message(&d),
      "Converting circular structure to JSON\n    --> starting at object with constructor 'Array'\n    --- index 1 closes the circle"
    );
    let g = cyclic(&|s| obj1("c", obj1("d", obj1("e", obj1("f", s)))));
    assert_eq!(
      message(&g),
      "Converting circular structure to JSON\n    --> starting at object with constructor 'Object'\n    |     property 'c' -> object with constructor 'Object'\n    |     property 'd' -> object with constructor 'Object'\n    |     property 'e' -> object with constructor 'Object'\n    --- property 'f' closes the circle"
    );
    assert_eq!(message(&obj1("a", JsVal::bigint("1"))), "Do not know how to serialize a BigInt");
    let dates = JsVal::obj(Obj::from([("a".to_string(), JsVal::date(f64::NAN)), ("b".to_string(), JsVal::date(0.0))]));
    assert_eq!(json_stringify(&dates).unwrap().unwrap(), r#"{"a":null,"b":"1970-01-01T00:00:00.000Z"}"#);
  }

  #[test]
  fn stringify() {
    let v = JsVal::obj(obj([
      ("a", JsVal::Num(1.5)),
      ("b", JsVal::Undefined),
      ("c", JsVal::arr(vec![JsVal::Undefined, JsVal::str("x\n\u{1}\"")])),
    ]));
    assert_eq!(json_stringify(&v).unwrap().unwrap(), r#"{"a":1.5,"c":[null,"x\n\u0001\""]}"#);
  }
}
