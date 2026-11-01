//! JS semantics the query builders rely on: property reads that throw like V8, `in`, `String()` /
//! `Number()` / `parseFloat()` of any value, `new Date(string)`, `escapeRegExp`, bson's
//! `new ObjectId(value)` / `ObjectId.isValid(value)` (bson 7, as `mongoose.Types.ObjectId`), and an
//! object builder that keeps JS property order.

use indexmap::IndexMap;
use payload_engine::bson::{BsonValue, object_id_bytes_from_hex};
use payload_engine::error::{EngineError, Result};
use payload_engine::js::{JsVal, TypedValue, date_to_js_string, num_to_js_string};
use payload_sql_query::js_ops::{js_number_checked, js_string_checked, string_to_number};

pub fn type_error(message: impl Into<String>) -> EngineError {
  EngineError::new("TypeError", message)
}

fn bson_error(message: &str) -> EngineError {
  EngineError::new("BSONError", message)
}

pub fn unsupported(what: &str) -> EngineError {
  EngineError::internal(format!("payload-mongo-query: {what} is not supported"))
}

/// How V8 prints a primitive receiver in `Cannot create property` / `in` messages.
fn describe(v: &JsVal) -> String {
  v.to_js_string()
}

/// Whether `key` is a canonical array index (`ToString(ToUint32(key)) === key`, below 2^32 - 1).
pub fn is_array_index(key: &str) -> bool {
  if key.is_empty() || key.len() > 10 || !key.bytes().all(|b| b.is_ascii_digit()) {
    return false;
  }
  if key.len() > 1 && key.starts_with('0') {
    return false;
  }
  key.parse::<u64>().is_ok_and(|n| n < 4_294_967_295)
}

/// `value[key]`: `TypeError` for `null` / `undefined` receivers; strings and arrays expose
/// `length` and their indices; every other object its own properties (config objects are
/// serialized with the inherited properties the engine reads).
pub fn get(v: &JsVal, key: &str) -> Result<JsVal> {
  match v {
    JsVal::Undefined | JsVal::Null => {
      Err(type_error(format!("Cannot read properties of {} (reading '{key}')", v.to_js_string())))
    }
    JsVal::Str(s) => {
      if key == "length" {
        return Ok(JsVal::Num(s.encode_utf16().count() as f64));
      }
      if is_array_index(key) {
        let i: usize = key.parse().unwrap_or(usize::MAX);
        let units: Vec<u16> = s.encode_utf16().collect();
        return Ok(units.get(i).map_or(JsVal::Undefined, |u| JsVal::str(String::from_utf16_lossy(&[*u]))));
      }
      Ok(JsVal::Undefined)
    }
    JsVal::Arr(a) => {
      if key == "length" {
        return Ok(JsVal::Num(a.len() as f64));
      }
      if is_array_index(key) {
        return Ok(key.parse::<usize>().ok().and_then(|i| a.get(i)).cloned().unwrap_or_default());
      }
      Ok(JsVal::Undefined)
    }
    JsVal::Obj(_) => match v.bson() {
      Some(BsonValue::Buffer(bytes)) if key == "length" => Ok(JsVal::Num(bytes.len() as f64)),
      _ => Ok(v.get(key).clone()),
    },
    _ => Ok(JsVal::Undefined),
  }
}

/// Property names every plain object inherits from `Object.prototype`.
pub const OBJECT_PROTOTYPE_KEYS: &[&str] = &[
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

const ARRAY_PROTOTYPE_KEYS: &[&str] = &[
  "at", "concat", "copyWithin", "entries", "every", "fill", "filter", "find", "findIndex", "findLast",
  "findLastIndex", "flat", "flatMap", "forEach", "includes", "indexOf", "join", "keys", "lastIndexOf", "length",
  "map", "pop", "push", "reduce", "reduceRight", "reverse", "shift", "slice", "some", "sort", "splice",
  "toLocaleString", "toReversed", "toSorted", "toSpliced", "toString", "unshift", "values", "with",
];

/// `key in value` (`TypeError` for primitives). Plain objects and arrays include their prototype
/// chain; typed values (`Date`, bson classes) only `Object.prototype`.
pub fn js_in(key: &str, v: &JsVal) -> Result<bool> {
  match v {
    JsVal::Obj(o) => {
      if v.typed().is_some() || v.bson().is_some() || v.as_host_object().is_some() {
        return Ok(OBJECT_PROTOTYPE_KEYS.contains(&key));
      }
      Ok(o.contains_key(key) || OBJECT_PROTOTYPE_KEYS.contains(&key))
    }
    JsVal::Arr(a) => Ok(
      (is_array_index(key) && key.parse::<usize>().is_ok_and(|i| i < a.len()))
        || ARRAY_PROTOTYPE_KEYS.contains(&key)
        || OBJECT_PROTOTYPE_KEYS.contains(&key),
    ),
    JsVal::Fn(_) => Err(unsupported("`in` on a function")),
    _ => Err(type_error(format!("Cannot use 'in' operator to search for '{key}' in {}", describe(v)))),
  }
}

/// The `TypeError` of `receiver[key] = value` on a primitive (ES modules are strict).
pub fn set_on_primitive_error(receiver: &JsVal, key: &str) -> EngineError {
  match receiver {
    JsVal::Undefined | JsVal::Null => {
      type_error(format!("Cannot set properties of {} (setting '{key}')", receiver.to_js_string()))
    }
    _ => type_error(format!("Cannot create property '{key}' on {} '{}'", receiver.type_of(), describe(receiver))),
  }
}

/// `typeof value === 'object' && value !== null`, arrays included.
pub fn is_object(v: &JsVal) -> bool {
  matches!(v, JsVal::Arr(_)) || (matches!(v, JsVal::Obj(_)) && v.type_of() == "object")
}

/// `isNestedRelationshipQuery`: a plain object (prototype `Object.prototype` or `null`).
pub fn is_plain_object(v: &JsVal) -> bool {
  matches!(v, JsVal::Obj(_)) && v.typed().is_none() && v.bson().is_none() && v.as_host_object().is_none()
}

/// `String(value)` (bson values use their `toString()`), `TypeError` where JS throws.
pub fn js_string(v: &JsVal) -> Result<String> {
  js_string_checked(v)
}

/// `Number(value)`; bson values convert through their `toString()` (mongoose's `ObjectId`
/// `valueOf` returns the hex string).
pub fn js_number(v: &JsVal) -> Result<f64> {
  if let Some(bson) = v.bson() {
    return Ok(string_to_number(&bson.to_js_string()));
  }
  js_number_checked(v)
}

/// `parseFloat(value)`
pub fn parse_float(v: &JsVal) -> Result<f64> {
  js_string_checked(v)?;
  Ok(payload_sql_query::js_ops::parse_float(v))
}

/// `value.toString()` called as a method: `name` is the expression V8 names in its error.
pub fn to_string_method(v: &JsVal, name: &str) -> Result<String> {
  match v {
    JsVal::Undefined | JsVal::Null => {
      Err(type_error(format!("Cannot read properties of {} (reading 'toString')", v.to_js_string())))
    }
    JsVal::Obj(o) if is_plain_object(v) => match o.get("toString") {
      Some(JsVal::Fn(_)) => Err(unsupported("calling an own `toString` function")),
      Some(_) => Err(type_error(format!("{name}.toString is not a function"))),
      None => Ok("[object Object]".into()),
    },
    _ => js_string(v),
  }
}

/// `new Date(string)`
pub fn new_date_from_string(s: &str) -> JsVal {
  JsVal::date(payload_sql_read::date::parse(s))
}

/// `Date.parse(value)`: the string conversion of `value` parsed again.
pub fn date_parse(v: &JsVal) -> Result<f64> {
  let s = match v.typed() {
    Some(TypedValue::Date(ms)) => date_to_js_string(ms),
    _ => js_string(v)?,
  };
  Ok(payload_sql_read::date::parse(&s))
}

/// `escapeRegExp(string)` from payload: `string.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')`.
pub fn escape_reg_exp(v: &JsVal) -> Result<String> {
  match v {
    JsVal::Str(s) => {
      let mut out = String::with_capacity(s.len());
      for c in s.chars() {
        if matches!(c, '\\' | '^' | '$' | '*' | '+' | '?' | '.' | '(' | ')' | '|' | '[' | ']' | '{' | '}') {
          out.push('\\');
        }
        out.push(c);
      }
      Ok(out)
    }
    JsVal::Undefined | JsVal::Null => {
      Err(type_error(format!("Cannot read properties of {} (reading 'replace')", v.to_js_string())))
    }
    // (a user value, not config: its key is not one of serialize.ts's `engineReadKeys`)
    JsVal::Obj(o) if is_plain_object(v) && matches!(o.iter().find(|(k, _)| *k == "replace"), Some((_, JsVal::Fn(_)))) => {
      Err(unsupported("calling an own `replace` function"))
    }
    _ => Err(type_error("string.replace is not a function")),
  }
}

/// `createArrayFromCommaDelineated(input)`
pub fn create_array_from_comma_delineated(v: &JsVal) -> Result<JsVal> {
  match v {
    JsVal::Arr(_) => Ok(v.clone()),
    JsVal::Str(s) => Ok(JsVal::arr(s.split(',').map(JsVal::str).collect())),
    JsVal::Undefined | JsVal::Null => {
      Err(type_error(format!("Cannot read properties of {} (reading 'split')", v.to_js_string())))
    }
    _ => Err(type_error("input.split is not a function")),
  }
}

/// `new Types.ObjectId(value)` (bson 7), `BSONError` where the constructor throws.
pub fn new_object_id(v: &JsVal) -> Result<JsVal> {
  if let Some(bytes) = v.as_object_id() {
    return Ok(JsVal::object_id(bytes));
  }
  let mut working = v.clone();
  if is_plain_object(v) && v.has("id") {
    let id = v.get("id");
    let is_view = matches!(id.bson(), Some(BsonValue::Buffer(_)));
    if id.as_str().is_none() && !is_view {
      return Err(bson_error("Argument passed in must have an id that is of type string or Buffer"));
    }
    if v.get("toHexString").is_fn() {
      return Err(unsupported("`new ObjectId` of an object with a `toHexString` function"));
    }
    working = id.clone();
  }
  match &working {
    JsVal::Undefined | JsVal::Null => Err(unsupported("`new ObjectId()` without an id (random id)")),
    JsVal::Str(s) => object_id_bytes_from_hex(s)
      .map(JsVal::object_id)
      .ok_or_else(|| bson_error("input must be a 24 character hex string, 12 byte Uint8Array, or an integer")),
    _ => match working.bson() {
      Some(BsonValue::Buffer(bytes)) if bytes.len() == 12 => {
        let mut out = [0u8; 12];
        out.copy_from_slice(&bytes);
        Ok(JsVal::object_id(out))
      }
      _ => Err(bson_error("Argument passed in does not match the accepted types")),
    },
  }
}

/// `Types.ObjectId.isValid(value)` (bson 7).
pub fn object_id_is_valid(v: &JsVal) -> Result<bool> {
  match v {
    JsVal::Undefined | JsVal::Null => Ok(false),
    JsVal::Str(s) => Ok(object_id_bytes_from_hex(s).is_some()),
    _ => match new_object_id(v) {
      Ok(_) => Ok(true),
      Err(e) if e.name == "BSONError" => Ok(false),
      Err(e) => Err(e),
    },
  }
}

/// The own enumerable properties of a bson 7 `ObjectId` (`i0`..`i3`: the bytes packed by three).
pub fn object_id_own_entries(bytes: &[u8; 12]) -> Vec<(String, JsVal)> {
  (0..4)
    .map(|i| {
      let b = &bytes[i * 3..i * 3 + 3];
      let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
      (format!("i{i}"), JsVal::Num(f64::from(n)))
    })
    .collect()
}

/// `${value}` of a template literal (`String(value)` without the object conversion checks the
/// engine values here never need).
pub fn template(v: &JsVal) -> String {
  match v {
    JsVal::Num(n) => num_to_js_string(*n),
    other => other.to_js_string(),
  }
}

/// A JS object under construction: keys in JS property order (array-index keys ascending first,
/// then string keys in insertion order).
#[derive(Clone, Debug, Default)]
pub struct JsObj(IndexMap<String, JsVal>);

impl JsObj {
  pub fn new() -> Self {
    Self::default()
  }

  pub fn from_val(v: &JsVal) -> Self {
    let mut out = JsObj::new();
    if let Some(o) = v.as_obj() {
      for (k, item) in o.iter() {
        out.set(k.clone(), item.clone());
      }
    }
    out
  }

  pub fn with(mut self, key: impl Into<String>, value: JsVal) -> Self {
    self.set(key, value);
    self
  }

  pub fn set(&mut self, key: impl Into<String>, value: JsVal) {
    let key = key.into();
    if let Some(slot) = self.0.get_mut(&key) {
      *slot = value;
      return;
    }
    if is_array_index(&key) {
      let n: u64 = key.parse().unwrap_or(0);
      let at = self
        .0
        .keys()
        .position(|k| !is_array_index(k) || k.parse::<u64>().unwrap_or(0) > n)
        .unwrap_or(self.0.len());
      self.0.shift_insert(at, key, value);
    } else {
      self.0.insert(key, value);
    }
  }

  pub fn get(&self, key: &str) -> Option<&JsVal> {
    self.0.get(key)
  }

  /// `obj[key]` (`undefined` when missing).
  pub fn read(&self, key: &str) -> JsVal {
    self.0.get(key).cloned().unwrap_or_default()
  }

  pub fn contains(&self, key: &str) -> bool {
    self.0.contains_key(key)
  }

  pub fn remove(&mut self, key: &str) {
    self.0.shift_remove(key);
  }

  pub fn len(&self) -> usize {
    self.0.len()
  }

  pub fn is_empty(&self) -> bool {
    self.0.is_empty()
  }

  pub fn keys(&self) -> impl Iterator<Item = &String> {
    self.0.keys()
  }

  pub fn into_val(self) -> JsVal {
    JsVal::obj(self.0)
  }
}

/// `{ [key]: value }`
pub fn obj1(key: impl Into<String>, value: JsVal) -> JsVal {
  JsObj::new().with(key, value).into_val()
}

/// `Object.keys(value)` of a decoded value (`TypeError` for `null` / `undefined`).
pub fn object_keys(v: &JsVal) -> Result<Vec<String>> {
  match v {
    JsVal::Undefined | JsVal::Null => Err(type_error("Cannot convert undefined or null to object")),
    JsVal::Obj(o) => Ok(o.keys().cloned().collect()),
    JsVal::Arr(a) => Ok((0..a.len()).map(|i| i.to_string()).collect()),
    JsVal::Str(s) => Ok((0..s.encode_utf16().count()).map(|i| i.to_string()).collect()),
    _ => Ok(Vec::new()),
  }
}
