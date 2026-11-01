//! A mutable JS value with reference semantics, for the in-place mutations of `transform`.
//!
//! `transform` mutates the documents it is given (deletes `_id` / `__v`, replaces relationship
//! values, moves `$push` / `$inc` operands into the update operators, clears emptied containers
//! by identity, expands dotted keys). [`JsVal`] is immutable (`Arc`), so the data is imported into
//! [`Val`] (`Rc<RefCell<..>>`) once, preserving object identity (a `$ref`-shared object stays one
//! object), transformed, and exported back preserving identity again.
//!
//! Property access follows JS: objects inherit `Object.prototype` (so `'toString' in {}` is true
//! and `{}.constructor` is a function), arrays expose `length` and `Array.prototype`, primitives
//! their prototypes. Values that are JS objects the engine does not model structurally (`Date`,
//! bson `ObjectId` / `Decimal128` / `Binary`, `Buffer`, `RegExp`, host objects, functions) are
//! [`Val::Leaf`]s holding the original [`JsVal`] (identity kept). Their own properties are
//! modelled where upstream data paths can observe them (`Date`, `RegExp`: none enumerable;
//! `ObjectId`: `i0`..`i3`, `_bsontype`); every other observation of their internals is an explicit
//! `unsupported` error, never a guess.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use indexmap::IndexMap;
use payload_engine::error::{EngineError, Result};
use payload_engine::js::{BsonValue, JsVal, Obj, TypedValue, num_to_js_string};

pub type ObjMap = IndexMap<String, Val>;
pub type ObjRef = Rc<RefCell<ObjMap>>;
pub type ArrRef = Rc<RefCell<Vec<Val>>>;
pub type OidRef = Rc<RefCell<OidCell>>;

/// A bson `ObjectId`. bson 7 keeps it in the own properties `i0`..`i3` (24 bits each), which
/// `delete` removes in place: `toHexString()` then reads `undefined >>> 16`, i.e. zeros.
#[derive(Debug)]
pub struct OidCell {
  /// The imported value (exported unchanged while no group was deleted).
  pub original: JsVal,
  bytes: [u8; 12],
  deleted: [bool; 4],
}

impl OidCell {
  /// `toHexString()`
  pub fn hex(&self) -> String {
    payload_engine::bson::object_id_to_hex(&self.current_bytes())
  }

  fn current_bytes(&self) -> [u8; 12] {
    let mut bytes = self.bytes;
    for (i, deleted) in self.deleted.iter().enumerate() {
      if *deleted {
        bytes[i * 3..i * 3 + 3].fill(0);
      }
    }
    bytes
  }

  fn group(&self, key: &str) -> Option<usize> {
    ["i0", "i1", "i2", "i3"].iter().position(|k| *k == key).filter(|i| !self.deleted[*i])
  }
}

#[derive(Clone, Debug, Default)]
pub enum Val {
  #[default]
  Undefined,
  /// An empty array slot (`delete array[i]`). Only stored in arrays: reading it gives `undefined`.
  Hole,
  Null,
  Bool(bool),
  Num(f64),
  Str(Arc<str>),
  /// A JS value kept as the original [`JsVal`]: `Date`, `bigint`, bson values, host objects,
  /// functions.
  Leaf(JsVal),
  /// A built-in function inherited from a prototype (e.g. `{}.toString`), by name.
  Builtin(&'static str),
  /// A bson `ObjectId` (see [`OidCell`]).
  Oid(OidRef),
  Arr(ArrRef),
  Obj(ObjRef),
}

/// `Object.getOwnPropertyNames(Object.prototype)` (Node 24).
pub const OBJECT_PROTO: [&str; 12] = [
  "constructor",
  "__defineGetter__",
  "__defineSetter__",
  "hasOwnProperty",
  "__lookupGetter__",
  "__lookupSetter__",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toString",
  "valueOf",
  "__proto__",
  "toLocaleString",
];

const ARRAY_PROTO: &[&str] = &[
  "constructor", "at", "concat", "copyWithin", "fill", "find", "findIndex", "findLast", "findLastIndex", "lastIndexOf", "pop",
  "push", "reverse", "shift", "unshift", "slice", "sort", "splice", "includes", "indexOf", "join", "keys", "entries", "values",
  "forEach", "filter", "flat", "flatMap", "map", "every", "some", "reduce", "reduceRight", "toReversed", "toSorted", "toSpliced",
  "with", "toLocaleString", "toString",
];

const STRING_PROTO: &[&str] = &[
  "constructor", "anchor", "at", "big", "blink", "bold", "charAt", "charCodeAt", "codePointAt", "concat", "endsWith", "fontcolor",
  "fontsize", "fixed", "includes", "indexOf", "isWellFormed", "italics", "lastIndexOf", "link", "localeCompare", "match", "matchAll",
  "normalize", "padEnd", "padStart", "repeat", "replace", "replaceAll", "search", "slice", "small", "split", "strike", "sub", "substr",
  "substring", "sup", "startsWith", "toString", "toWellFormed", "trim", "trimStart", "trimLeft", "trimEnd", "trimRight",
  "toLocaleLowerCase", "toLocaleUpperCase", "toLowerCase", "toUpperCase", "valueOf",
];

const NUMBER_PROTO: &[&str] = &["constructor", "toExponential", "toFixed", "toPrecision", "toString", "valueOf", "toLocaleString"];
const BOOLEAN_PROTO: &[&str] = &["constructor", "toString", "valueOf"];
const BIGINT_PROTO: &[&str] = &["constructor", "toLocaleString", "toString", "valueOf"];

const DATE_PROTO: &[&str] = &[
  "constructor", "toString", "toDateString", "toTimeString", "toISOString", "toUTCString", "toGMTString", "getDate", "setDate",
  "getDay", "getFullYear", "setFullYear", "getHours", "setHours", "getMilliseconds", "setMilliseconds", "getMinutes", "setMinutes",
  "getMonth", "setMonth", "getSeconds", "setSeconds", "getTime", "setTime", "getTimezoneOffset", "getUTCDate", "setUTCDate",
  "getUTCDay", "getUTCFullYear", "setUTCFullYear", "getUTCHours", "setUTCHours", "getUTCMilliseconds", "setUTCMilliseconds",
  "getUTCMinutes", "setUTCMinutes", "getUTCMonth", "setUTCMonth", "getUTCSeconds", "setUTCSeconds", "valueOf", "getYear",
  "setYear", "toJSON", "toLocaleString", "toLocaleDateString", "toLocaleTimeString", "toTemporalInstant",
];

/// Members of the other leaf kinds whose values are not modelled (reading them is `unsupported`).
const OBJECT_ID_PROTO: &[&str] = &[
  "setFromBytes", "setFromHex", "id", "toHexString", "toJSON", "equals", "getTimestamp", "serializeInto", "toExtendedJSON",
  "isCached", "inspect", "_id", "generationTime",
];
const REGEXP_MEMBERS: &[&str] = &[
  "lastIndex", "exec", "dotAll", "flags", "global", "hasIndices", "ignoreCase", "multiline", "source", "sticky", "unicode",
  "unicodeSets", "compile", "test",
];
const DECIMAL_PROTO: &[&str] = &["_bsontype", "bytes", "toJSON", "toExtendedJSON", "inspect"];
const BINARY_PROTO: &[&str] = &[
  "_bsontype", "buffer", "sub_type", "position", "put", "write", "read", "value", "length", "toJSON", "toExtendedJSON", "toUUID",
  "inspect", "toInt8Array", "toFloat32Array", "toPackedBits", "toBits",
];
const FUNCTION_PROTO: &[&str] = &["length", "name", "arguments", "caller", "apply", "bind", "call", "prototype"];

pub fn unsupported(what: impl std::fmt::Display) -> EngineError {
  EngineError::internal(format!("mongo transform: {what} is not supported by the engine"))
}

pub fn type_error(message: impl Into<String>) -> EngineError {
  EngineError::new("TypeError", message)
}

/// The kind of a [`Val::Leaf`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LeafKind {
  Date,
  BigInt,
  ObjectId,
  RegExp,
  Decimal,
  Binary,
  Buffer,
  Host,
  Function,
}

fn leaf_kind(v: &JsVal) -> LeafKind {
  if let JsVal::Fn(_) = v {
    return LeafKind::Function;
  }
  match v.typed() {
    Some(TypedValue::Date(_)) => return LeafKind::Date,
    Some(TypedValue::BigInt(_)) => return LeafKind::BigInt,
    None => {}
  }
  match v.bson() {
    Some(BsonValue::ObjectId(_)) => LeafKind::ObjectId,
    Some(BsonValue::RegExp { .. }) => LeafKind::RegExp,
    Some(BsonValue::Decimal128(_)) => LeafKind::Decimal,
    Some(BsonValue::Binary { .. }) => LeafKind::Binary,
    Some(BsonValue::Buffer(_)) => LeafKind::Buffer,
    None => LeafKind::Host,
  }
}

fn leaf_name(kind: LeafKind) -> &'static str {
  match kind {
    LeafKind::Date => "a Date",
    LeafKind::BigInt => "a bigint",
    LeafKind::ObjectId => "an ObjectId",
    LeafKind::RegExp => "a RegExp",
    LeafKind::Decimal => "a Decimal128",
    LeafKind::Binary => "a bson Binary",
    LeafKind::Buffer => "a Buffer",
    LeafKind::Host => "a host object",
    LeafKind::Function => "a function",
  }
}

/// Is `JsVal` a value that is imported as a [`Val::Leaf`]?
fn is_leaf(v: &JsVal) -> bool {
  match v {
    JsVal::Fn(_) => true,
    JsVal::Obj(o) => o.is_empty() && (v.typed().is_some() || v.bson().is_some() || v.as_host_object().is_some()),
    _ => false,
  }
}

/// Is `key` a canonical array index (`"0"`, `"12"`, not `"01"`)? JS orders such keys first.
pub fn is_array_index(key: &str) -> bool {
  if key.is_empty() || key.len() > 10 || !key.bytes().all(|b| b.is_ascii_digit()) {
    return false;
  }
  if key.len() > 1 && key.starts_with('0') {
    return false;
  }
  key.parse::<u64>().is_ok_and(|n| n < u32::MAX as u64)
}

fn index_of(key: &str) -> Option<usize> {
  is_array_index(key).then(|| key.parse::<usize>().ok()).flatten()
}

/// `obj[key] = value` keeping JS property order (array-index keys first, ascending).
pub fn js_insert(map: &mut ObjMap, key: &str, value: Val) {
  if let Some(slot) = map.get_mut(key) {
    *slot = value;
    return;
  }
  let pos = match index_of(key) {
    None => map.len(),
    Some(n) => map.keys().position(|k| index_of(k).is_none_or(|m| m > n)).unwrap_or(map.len()),
  };
  map.shift_insert(pos, key.to_string(), value);
}

/// The 24-bit groups bson 7 keeps an `ObjectId` in (own enumerable `i0`..`i3`).
fn object_id_group(bytes: &[u8; 12], i: usize) -> f64 {
  let b = &bytes[i * 3..i * 3 + 3];
  f64::from((u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]))
}

fn utf16_units(s: &str) -> Vec<u16> {
  s.encode_utf16().collect()
}

impl Val {
  pub fn str(s: &str) -> Val {
    Val::Str(s.into())
  }

  pub fn new_obj() -> Val {
    Val::Obj(Rc::new(RefCell::new(ObjMap::new())))
  }

  pub fn obj_from(entries: Vec<(&str, Val)>) -> Val {
    let mut map = ObjMap::new();
    for (k, v) in entries {
      js_insert(&mut map, k, v);
    }
    Val::Obj(Rc::new(RefCell::new(map)))
  }

  pub fn new_arr(items: Vec<Val>) -> Val {
    Val::Arr(Rc::new(RefCell::new(items)))
  }

  /// An `ObjectId` value for an `ObjectId` [`JsVal`] (any other value becomes a [`Val::Leaf`]).
  pub fn object_id(v: JsVal) -> Val {
    match v.as_object_id() {
      Some(bytes) => Val::Oid(Rc::new(RefCell::new(OidCell { original: v, bytes, deleted: [false; 4] }))),
      None => Val::Leaf(v),
    }
  }

  /// `value.toHexString()` of an `ObjectId`.
  pub fn object_id_hex(&self) -> Option<String> {
    match self {
      Val::Oid(o) => Some(o.borrow().hex()),
      _ => None,
    }
  }

  /// JS `typeof`.
  pub fn type_of(&self) -> &'static str {
    match self {
      Val::Undefined | Val::Hole => "undefined",
      Val::Null | Val::Arr(_) | Val::Obj(_) | Val::Oid(_) => "object",
      Val::Bool(_) => "boolean",
      Val::Num(_) => "number",
      Val::Str(_) => "string",
      Val::Builtin(_) => "function",
      Val::Leaf(v) => match leaf_kind(v) {
        LeafKind::BigInt => "bigint",
        LeafKind::Function => "function",
        _ => "object",
      },
    }
  }

  /// `value && typeof value === 'object'`
  pub fn is_object(&self) -> bool {
    !matches!(self, Val::Null) && self.type_of() == "object"
  }

  /// JS `ToBoolean`.
  pub fn truthy(&self) -> bool {
    match self {
      Val::Undefined | Val::Hole | Val::Null => false,
      Val::Bool(b) => *b,
      Val::Num(n) => *n != 0.0 && !n.is_nan(),
      Val::Str(s) => !s.is_empty(),
      Val::Leaf(v) => v.truthy(),
      Val::Builtin(_) | Val::Arr(_) | Val::Obj(_) | Val::Oid(_) => true,
    }
  }

  pub fn is_undefined(&self) -> bool {
    matches!(self, Val::Undefined | Val::Hole)
  }

  pub fn is_nullish(&self) -> bool {
    matches!(self, Val::Undefined | Val::Hole | Val::Null)
  }

  pub fn is_hole(&self) -> bool {
    matches!(self, Val::Hole)
  }

  /// `Array.isArray`
  pub fn is_array(&self) -> bool {
    matches!(self, Val::Arr(_))
  }

  pub fn as_str(&self) -> Option<&str> {
    match self {
      Val::Str(s) => Some(s),
      _ => None,
    }
  }

  /// The JsVal of a leaf.
  pub fn as_leaf(&self) -> Option<&JsVal> {
    match self {
      Val::Leaf(v) => Some(v),
      _ => None,
    }
  }

  /// Object identity (containers and leaf objects), `None` for primitives.
  pub fn identity(&self) -> Option<usize> {
    match self {
      Val::Obj(o) => Some(Rc::as_ptr(o) as *const u8 as usize),
      Val::Arr(a) => Some(Rc::as_ptr(a) as *const u8 as usize),
      Val::Oid(o) => Some(Rc::as_ptr(o) as *const u8 as usize),
      Val::Leaf(v) if self.type_of() == "object" => v.identity(),
      _ => None,
    }
  }

  /// `===`
  pub fn strict_eq(&self, other: &Val) -> bool {
    match (self, other) {
      (Val::Undefined | Val::Hole, Val::Undefined | Val::Hole) | (Val::Null, Val::Null) => true,
      (Val::Bool(a), Val::Bool(b)) => a == b,
      (Val::Num(a), Val::Num(b)) => a == b,
      (Val::Str(a), Val::Str(b)) => a == b,
      (Val::Builtin(a), Val::Builtin(b)) => a == b,
      (Val::Leaf(a), Val::Leaf(b)) => a.strict_eq(b),
      (Val::Arr(a), Val::Arr(b)) => Rc::ptr_eq(a, b),
      (Val::Obj(a), Val::Obj(b)) => Rc::ptr_eq(a, b),
      (Val::Oid(a), Val::Oid(b)) => Rc::ptr_eq(a, b),
      _ => false,
    }
  }

  /// `this === other` for a config value `other` (config objects never equal data objects).
  pub fn strict_eq_js(&self, other: &JsVal) -> bool {
    match (self, other) {
      (Val::Undefined | Val::Hole, JsVal::Undefined) | (Val::Null, JsVal::Null) => true,
      (Val::Bool(a), JsVal::Bool(b)) => a == b,
      (Val::Num(a), JsVal::Num(b)) => a == b,
      (Val::Str(a), JsVal::Str(b)) => a == b,
      (Val::Leaf(a), b) => a.strict_eq(b),
      _ => false,
    }
  }

  /// `String(value)` for primitives (used for messages and property keys).
  pub fn to_js_string(&self) -> String {
    match self {
      Val::Undefined | Val::Hole => "undefined".into(),
      Val::Null => "null".into(),
      Val::Bool(b) => b.to_string(),
      Val::Num(n) => num_to_js_string(*n),
      Val::Str(s) => s.to_string(),
      Val::Leaf(v) => v.to_js_string(),
      Val::Oid(o) => o.borrow().hex(),
      Val::Builtin(name) => format!("function {name}() {{ [native code] }}"),
      Val::Arr(_) => "[array]".into(),
      Val::Obj(_) => "[object Object]".into(),
    }
  }

  /// `value[key]` (JS property access, prototype chain included).
  pub fn prop(&self, key: &str) -> Result<Val> {
    match self {
      Val::Undefined | Val::Hole | Val::Null => {
        Err(type_error(format!("Cannot read properties of {} (reading '{key}')", self.to_js_string())))
      }
      Val::Obj(o) => {
        if let Some(v) = o.borrow().get(key) {
          return Ok(v.clone());
        }
        inherited(key, &[])
      }
      Val::Arr(a) => {
        if let Some(i) = index_of(key) {
          return Ok(match a.borrow().get(i) {
            Some(Val::Hole) | None => Val::Undefined,
            Some(v) => v.clone(),
          });
        }
        if key == "length" {
          return Ok(Val::Num(a.borrow().len() as f64));
        }
        inherited(key, ARRAY_PROTO)
      }
      Val::Str(s) => {
        if key == "length" {
          return Ok(Val::Num(utf16_units(s).len() as f64));
        }
        if let Some(i) = index_of(key) {
          let units = utf16_units(s);
          return Ok(units.get(i).map(|u| Val::Str(String::from_utf16_lossy(&[*u]).into())).unwrap_or_default());
        }
        inherited(key, STRING_PROTO)
      }
      Val::Num(_) => inherited(key, NUMBER_PROTO),
      Val::Bool(_) => inherited(key, BOOLEAN_PROTO),
      Val::Builtin(name) => Err(unsupported(format!("reading '{key}' of the built-in {name}"))),
      Val::Leaf(v) => leaf_prop(v, key),
      Val::Oid(o) => {
        let cell = o.borrow();
        if let Some(i) = cell.group(key) {
          return Ok(Val::Num(object_id_group(&cell.bytes, i)));
        }
        if key == "_bsontype" {
          return Ok(Val::str("ObjectId"));
        }
        if OBJECT_ID_PROTO.contains(&key) {
          return Err(unsupported(format!("reading '{key}' of an ObjectId")));
        }
        inherited(key, &[])
      }
    }
  }

  /// `key in value`
  pub fn has(&self, key: &str) -> Result<bool> {
    match self {
      Val::Obj(o) => Ok(o.borrow().contains_key(key) || OBJECT_PROTO.contains(&key)),
      Val::Arr(a) => Ok(index_of(key).is_some_and(|i| a.borrow().get(i).is_some_and(|v| !v.is_hole()))
        || key == "length"
        || ARRAY_PROTO.contains(&key)
        || OBJECT_PROTO.contains(&key)),
      Val::Leaf(v) if self.type_of() == "object" => match leaf_kind(v) {
        LeafKind::Date => Ok(DATE_PROTO.contains(&key) || OBJECT_PROTO.contains(&key)),
        LeafKind::RegExp => Ok(REGEXP_MEMBERS.contains(&key) || OBJECT_PROTO.contains(&key)),
        LeafKind::Decimal => Ok(DECIMAL_PROTO.contains(&key) || OBJECT_PROTO.contains(&key)),
        LeafKind::Binary => Ok(BINARY_PROTO.contains(&key) || OBJECT_PROTO.contains(&key)),
        kind => Err(unsupported(format!("`'{key}' in` {}", leaf_name(kind)))),
      },
      Val::Oid(o) => Ok(o.borrow().group(key).is_some()
        || key == "_bsontype"
        || OBJECT_ID_PROTO.contains(&key)
        || OBJECT_PROTO.contains(&key)),
      Val::Builtin(name) => Err(unsupported(format!("`'{key}' in` the built-in {name}"))),
      Val::Leaf(v) if leaf_kind(v) == LeafKind::Function => Err(unsupported(format!("`'{key}' in` a function"))),
      _ => Err(type_error(format!("Cannot use 'in' operator to search for '{key}' in {}", self.to_js_string()))),
    }
  }

  /// `Object.hasOwn(value, key)` for object values.
  pub fn has_own(&self, key: &str) -> Result<bool> {
    match self {
      Val::Obj(o) => Ok(o.borrow().contains_key(key)),
      Val::Arr(a) => Ok(index_of(key).is_some_and(|i| a.borrow().get(i).is_some_and(|v| !v.is_hole())) || key == "length"),
      Val::Leaf(v) => match leaf_kind(v) {
        LeafKind::Date | LeafKind::BigInt => Ok(false),
        LeafKind::RegExp => Ok(key == "lastIndex"),
        kind => Err(unsupported(format!("Object.hasOwn on {}", leaf_name(kind)))),
      },
      Val::Oid(o) => Ok(o.borrow().group(key).is_some()),
      Val::Builtin(name) => Err(unsupported(format!("Object.hasOwn on the built-in {name}"))),
      Val::Undefined | Val::Hole | Val::Null => Err(type_error("Cannot convert undefined or null to object")),
      Val::Str(s) => Ok(key == "length" || index_of(key).is_some_and(|i| i < utf16_units(s).len())),
      Val::Num(_) | Val::Bool(_) => Ok(false),
    }
  }

  /// `Object.keys(value)`
  pub fn own_keys(&self) -> Result<Vec<String>> {
    match self {
      Val::Obj(o) => Ok(o.borrow().keys().cloned().collect()),
      Val::Arr(a) => Ok(a.borrow().iter().enumerate().filter(|(_, v)| !v.is_hole()).map(|(i, _)| i.to_string()).collect()),
      Val::Undefined | Val::Hole | Val::Null => Err(type_error("Cannot convert undefined or null to object")),
      Val::Str(s) => Ok((0..utf16_units(s).len()).map(|i| i.to_string()).collect()),
      Val::Num(_) | Val::Bool(_) => Ok(Vec::new()),
      Val::Leaf(v) => match leaf_kind(v) {
        LeafKind::Date | LeafKind::RegExp | LeafKind::BigInt => Ok(Vec::new()),
        kind => Err(unsupported(format!("enumerating the properties of {}", leaf_name(kind)))),
      },
      Val::Oid(o) => {
        let cell = o.borrow();
        Ok(["i0", "i1", "i2", "i3"].iter().filter(|k| cell.group(k).is_some()).map(|k| k.to_string()).collect())
      }
      Val::Builtin(name) => Err(unsupported(format!("enumerating the properties of the built-in {name}"))),
    }
  }

  /// The keys `for (const key in value)` visits (own enumerable, then enumerable inherited ones).
  pub fn for_in_keys(&self) -> Result<Vec<String>> {
    match self {
      Val::Oid(_) => {
        let mut keys = self.own_keys()?;
        // bson 7 defines `ObjectId.prototype.valueOf` as an enumerable property
        keys.push("valueOf".into());
        Ok(keys)
      }
      Val::Undefined | Val::Hole | Val::Null => Ok(Vec::new()),
      _ => self.own_keys(),
    }
  }

  /// Whether a `for...in` loop over `self` still visits `key` from its initial key list (keys
  /// deleted during the loop are skipped; inherited enumerable keys stay).
  pub fn for_in_still_visits(&self, key: &str) -> Result<bool> {
    Ok(self.has_own(key)? || (matches!(self, Val::Oid(_)) && key == "valueOf"))
  }

  /// `Object.entries(value)`
  pub fn entries(&self) -> Result<Vec<(String, Val)>> {
    let keys = self.own_keys()?;
    keys.into_iter().map(|k| self.prop(&k).map(|v| (k, v))).collect()
  }

  /// `value[key] = new` (strict mode).
  pub fn set(&self, key: &str, value: Val) -> Result<()> {
    match self {
      Val::Obj(o) => {
        if key == "__proto__" && !o.borrow().contains_key(key) {
          return Err(unsupported("assigning `__proto__`"));
        }
        js_insert(&mut o.borrow_mut(), key, value);
        Ok(())
      }
      Val::Arr(a) => {
        let mut items = a.borrow_mut();
        match index_of(key) {
          Some(i) if i < items.len() => items[i] = value,
          Some(i) if i == items.len() => items.push(value),
          Some(i) if i < items.len() + 1_000_000 => {
            items.resize(i, Val::Hole);
            items.push(value);
          }
          None if key == "length" => match value {
            Val::Num(n) if n >= 0.0 && n.fract() == 0.0 && n < 4294967296.0 => {
              let len = n as usize;
              if len > items.len() + 1_000_000 {
                return Err(unsupported("growing an array by more than 1e6 holes"));
              }
              items.resize(len, Val::Hole);
            }
            Val::Num(_) => return Err(EngineError::new("RangeError", "Invalid array length")),
            _ => return Err(unsupported("assigning a non-number `length` on an array")),
          },
          _ => return Err(unsupported(format!("assigning '{key}' on an array"))),
        }
        Ok(())
      }
      Val::Undefined | Val::Hole | Val::Null => {
        Err(type_error(format!("Cannot set properties of {} (setting '{key}')", self.to_js_string())))
      }
      Val::Str(_) | Val::Num(_) | Val::Bool(_) => Err(type_error(format!(
        "Cannot create property '{key}' on {} '{}'",
        self.type_of(),
        self.to_js_string()
      ))),
      Val::Leaf(v) if leaf_kind(v) == LeafKind::BigInt => {
        Err(type_error(format!("Cannot create property '{key}' on bigint '{}'", self.to_js_string())))
      }
      Val::Leaf(v) => Err(unsupported(format!("assigning '{key}' on {}", leaf_name(leaf_kind(v))))),
      Val::Oid(_) => Err(unsupported(format!("assigning '{key}' on an ObjectId"))),
      Val::Builtin(name) => Err(unsupported(format!("assigning '{key}' on the built-in {name}"))),
    }
  }

  /// `delete value[key]` (strict mode).
  pub fn delete(&self, key: &str) -> Result<()> {
    match self {
      Val::Obj(o) => {
        o.borrow_mut().shift_remove(key);
        Ok(())
      }
      Val::Arr(a) => {
        if key == "length" {
          return Err(type_error("Cannot delete property 'length' of [object Array]"));
        }
        if let Some(i) = index_of(key)
          && let Some(slot) = a.borrow_mut().get_mut(i)
        {
          *slot = Val::Hole;
        }
        Ok(())
      }
      Val::Undefined | Val::Hole | Val::Null => Err(type_error("Cannot convert undefined or null to object")),
      Val::Str(s) => {
        if key == "length" || index_of(key).is_some_and(|i| i < utf16_units(s).len()) {
          return Err(type_error(format!("Cannot delete property '{key}' of [object String]")));
        }
        Ok(())
      }
      Val::Num(_) | Val::Bool(_) => Ok(()),
      Val::Leaf(v) => {
        if self.has_own(key)? {
          return Err(unsupported(format!("deleting '{key}' of {}", leaf_name(leaf_kind(v)))));
        }
        Ok(())
      }
      Val::Oid(o) => {
        let mut cell = o.borrow_mut();
        if let Some(i) = cell.group(key) {
          cell.deleted[i] = true;
        }
        Ok(())
      }
      Val::Builtin(name) => Err(unsupported(format!("deleting '{key}' of the built-in {name}"))),
    }
  }

  /// The items of an array (a snapshot).
  pub fn items(&self) -> Vec<Val> {
    match self {
      Val::Arr(a) => a.borrow().clone(),
      _ => Vec::new(),
    }
  }

  pub fn len(&self) -> usize {
    match self {
      Val::Arr(a) => a.borrow().len(),
      _ => 0,
    }
  }

  pub fn is_empty(&self) -> bool {
    self.len() == 0
  }
}

/// A property found on a prototype (`proto` names, then `Object.prototype`), `undefined` otherwise.
fn inherited(key: &str, proto: &[&'static str]) -> Result<Val> {
  if key == "__proto__" {
    return Err(unsupported("reading `__proto__`"));
  }
  if let Some(name) = proto.iter().chain(OBJECT_PROTO.iter()).find(|k| **k == key) {
    return Ok(Val::Builtin(if *name == "constructor" { "Object" } else { name }));
  }
  Ok(Val::Undefined)
}

fn leaf_prop(v: &JsVal, key: &str) -> Result<Val> {
  let kind = leaf_kind(v);
  match kind {
    LeafKind::Date => inherited(key, DATE_PROTO),
    LeafKind::BigInt => inherited(key, BIGINT_PROTO),
    LeafKind::ObjectId => {
      if let (Some(i), Some(bytes)) = (["i0", "i1", "i2", "i3"].iter().position(|k| *k == key), v.as_object_id()) {
        return Ok(Val::Num(object_id_group(&bytes, i)));
      }
      if key == "_bsontype" {
        return Ok(Val::str("ObjectId"));
      }
      if OBJECT_ID_PROTO.contains(&key) {
        return Err(unsupported(format!("reading '{key}' of an ObjectId")));
      }
      inherited(key, &[])
    }
    LeafKind::RegExp | LeafKind::Decimal | LeafKind::Binary => {
      let members = match kind {
        LeafKind::RegExp => REGEXP_MEMBERS,
        LeafKind::Decimal => DECIMAL_PROTO,
        _ => BINARY_PROTO,
      };
      if members.contains(&key) {
        return Err(unsupported(format!("reading '{key}' of {}", leaf_name(kind))));
      }
      inherited(key, &[])
    }
    LeafKind::Function => {
      if FUNCTION_PROTO.contains(&key) {
        return Err(unsupported(format!("reading '{key}' of a function")));
      }
      inherited(key, &[])
    }
    LeafKind::Buffer | LeafKind::Host => Err(unsupported(format!("reading '{key}' of {}", leaf_name(kind)))),
  }
}

/// Imports [`JsVal`] graphs into [`Val`]s, preserving identity (one import per call, so values
/// shared between the roots stay shared). Records the objects in pre-order of first visit.
#[derive(Default)]
pub struct Importer {
  memo: HashMap<usize, Val>,
  /// Every object value (containers and leaf objects) in pre-order of first visit.
  pub order: Vec<Val>,
}

const MAX_DEPTH: usize = 3000;

impl Importer {
  pub fn import(&mut self, v: &JsVal) -> Result<Val> {
    self.import_at(v, 0)
  }

  fn import_at(&mut self, v: &JsVal, depth: usize) -> Result<Val> {
    if depth > MAX_DEPTH {
      return Err(unsupported(format!("data nested deeper than {MAX_DEPTH} levels")));
    }
    if let Some(id) = v.identity()
      && let Some(seen) = self.memo.get(&id)
    {
      return Ok(seen.clone());
    }
    Ok(match v {
      JsVal::Undefined => Val::Undefined,
      JsVal::Null => Val::Null,
      JsVal::Bool(b) => Val::Bool(*b),
      JsVal::Num(n) => Val::Num(*n),
      JsVal::Str(s) => Val::Str(s.clone()),
      JsVal::Fn(_) => Val::Leaf(v.clone()),
      JsVal::Arr(items) => {
        let arr: ArrRef = Rc::new(RefCell::new(Vec::with_capacity(items.len())));
        let out = Val::Arr(arr.clone());
        self.register(v, &out);
        for item in items.iter() {
          let item = self.import_at(item, depth + 1)?;
          arr.borrow_mut().push(item);
        }
        out
      }
      JsVal::Obj(props) => {
        if is_leaf(v) {
          let out = Val::object_id(v.clone());
          if out.type_of() == "object" {
            self.register(v, &out);
          }
          return Ok(out);
        }
        let obj: ObjRef = Rc::new(RefCell::new(ObjMap::with_capacity(props.len())));
        let out = Val::Obj(obj.clone());
        self.register(v, &out);
        for (k, item) in props.iter() {
          let item = self.import_at(item, depth + 1)?;
          obj.borrow_mut().insert(k.clone(), item);
        }
        out
      }
    })
  }

  fn register(&mut self, v: &JsVal, out: &Val) {
    if let Some(id) = v.identity() {
      self.memo.insert(id, out.clone());
    }
    self.order.push(out.clone());
  }
}

/// Exports [`Val`]s back to [`JsVal`]s, preserving identity (one export per call). Leaves are
/// returned as the original [`JsVal`]s.
#[derive(Default)]
pub struct Exporter {
  memo: HashMap<usize, JsVal>,
  in_progress: Vec<usize>,
}

impl Exporter {
  pub fn export(&mut self, v: &Val) -> Result<JsVal> {
    self.export_at(v, 0)
  }

  fn export_at(&mut self, v: &Val, depth: usize) -> Result<JsVal> {
    if depth > MAX_DEPTH {
      return Err(unsupported(format!("data nested deeper than {MAX_DEPTH} levels")));
    }
    let id = match v {
      Val::Obj(_) | Val::Arr(_) | Val::Oid(_) => v.identity(),
      _ => None,
    };
    if let Some(id) = id {
      if let Some(done) = self.memo.get(&id) {
        return Ok(done.clone());
      }
      if self.in_progress.contains(&id) {
        return Err(unsupported("a circular data structure"));
      }
      self.in_progress.push(id);
    }
    let out = match v {
      // `serializeForEngine` reads a hole as `undefined`
      Val::Undefined | Val::Hole => JsVal::Undefined,
      Val::Null => JsVal::Null,
      Val::Bool(b) => JsVal::Bool(*b),
      Val::Num(n) => JsVal::Num(*n),
      Val::Str(s) => JsVal::Str(s.clone()),
      Val::Leaf(l) => l.clone(),
      Val::Oid(o) => {
        let cell = o.borrow();
        if cell.deleted.iter().any(|d| *d) { JsVal::object_id(cell.current_bytes()) } else { cell.original.clone() }
      }
      Val::Builtin(name) => return Err(unsupported(format!("an inherited built-in ({name}) stored as data"))),
      Val::Arr(a) => {
        let items = a.borrow().clone();
        let mut out = Vec::with_capacity(items.len());
        for item in &items {
          out.push(self.export_at(item, depth + 1)?);
        }
        JsVal::arr(out)
      }
      Val::Obj(o) => {
        let entries: Vec<(String, Val)> = o.borrow().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let mut out = Obj::with_capacity(entries.len());
        for (k, item) in &entries {
          out.insert(k.clone(), self.export_at(item, depth + 1)?);
        }
        JsVal::obj(out)
      }
    };
    if let Some(id) = id {
      self.in_progress.pop();
      self.memo.insert(id, out.clone());
    }
    Ok(out)
  }
}

/// `JSON.parse(JSON.stringify(value))` (`toJSON` of `Date`s and bson values included). `None`
/// stands for `undefined` (what `JSON.stringify` returns for functions and `undefined`).
pub fn json_round_trip(v: &Val) -> Result<Val> {
  fn walk(v: &Val, ancestors: &mut Vec<usize>, depth: usize) -> Result<Option<Val>> {
    if depth > MAX_DEPTH {
      return Err(unsupported(format!("JSON.stringify of data nested deeper than {MAX_DEPTH} levels")));
    }
    Ok(Some(match v {
      Val::Undefined | Val::Hole | Val::Builtin(_) => return Ok(None),
      Val::Null => Val::Null,
      Val::Bool(b) => Val::Bool(*b),
      Val::Num(n) if n.is_finite() => Val::Num(if *n == 0.0 { 0.0 } else { *n }),
      Val::Num(_) => Val::Null,
      Val::Str(s) => Val::Str(s.clone()),
      Val::Oid(o) => Val::Str(o.borrow().hex().into()),
      Val::Leaf(l) => match leaf_kind(l) {
        LeafKind::Function => return Ok(None),
        LeafKind::BigInt => return Err(type_error("Do not know how to serialize a BigInt")),
        LeafKind::Date => match l.as_date().and_then(payload_engine::js::date_to_iso_string) {
          Some(iso) => Val::Str(iso.into()),
          None => Val::Null,
        },
        LeafKind::Host => return Err(unsupported("JSON.stringify of a host object")),
        _ => match l.bson() {
          Some(b) => Val::from_json(&b.to_json()),
          None => return Err(unsupported("JSON.stringify of an unknown value")),
        },
      },
      Val::Arr(_) | Val::Obj(_) => {
        let id = v.identity().unwrap_or(0);
        if ancestors.contains(&id) {
          return Err(type_error("Converting circular structure to JSON"));
        }
        ancestors.push(id);
        let out = if let Val::Arr(a) = v {
          let items = a.borrow().clone();
          let mut out = Vec::with_capacity(items.len());
          for item in &items {
            out.push(walk(item, ancestors, depth + 1)?.unwrap_or(Val::Null));
          }
          Val::new_arr(out)
        } else {
          let entries = v.entries()?;
          let out = Val::new_obj();
          for (k, item) in &entries {
            if let Some(item) = walk(item, ancestors, depth + 1)? {
              out.set(k, item)?;
            }
          }
          out
        };
        ancestors.pop();
        out
      }
    }))
  }
  Ok(walk(v, &mut Vec::new(), 0)?.unwrap_or(Val::Undefined))
}

impl Val {
  /// A plain JSON value (as `JSON.parse` builds it).
  pub fn from_json(json: &serde_json::Value) -> Val {
    match json {
      serde_json::Value::Null => Val::Null,
      serde_json::Value::Bool(b) => Val::Bool(*b),
      serde_json::Value::Number(n) => Val::Num(n.as_f64().unwrap_or(f64::NAN)),
      serde_json::Value::String(s) => Val::str(s),
      serde_json::Value::Array(items) => Val::new_arr(items.iter().map(Val::from_json).collect()),
      serde_json::Value::Object(map) => {
        let out = Val::new_obj();
        if let Val::Obj(o) = &out {
          let mut o = o.borrow_mut();
          for (k, v) in map {
            js_insert(&mut o, k, Val::from_json(v));
          }
        }
        out
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn js_key_order_and_identity() {
    let shared = JsVal::obj([("x".to_string(), JsVal::Num(1.0))].into_iter().collect());
    let root = JsVal::obj([("a".to_string(), shared.clone()), ("b".to_string(), shared)].into_iter().collect());
    let mut importer = Importer::default();
    let v = importer.import(&root).expect("import");
    assert!(v.prop("a").expect("a").strict_eq(&v.prop("b").expect("b")));
    assert_eq!(importer.order.len(), 2);
    v.set("2", Val::Num(2.0)).expect("set");
    v.set("1", Val::Num(1.0)).expect("set");
    assert_eq!(v.own_keys().expect("keys"), vec!["1", "2", "a", "b"]);
    let out = Exporter::default().export(&v).expect("export");
    assert!(out.get("a").strict_eq(out.get("b")));
    assert!(v.has("toString").expect("in"));
    assert!(matches!(v.prop("constructor").expect("get"), Val::Builtin("Object")));
    assert_eq!(Val::str("abc").set("id", Val::Null).expect_err("primitive").message, "Cannot create property 'id' on string 'abc'");
  }

  #[test]
  fn object_id_groups() {
    let id = Val::object_id(JsVal::object_id_from_hex("0123456789abcdef01234567").expect("hex"));
    assert_eq!(id.prop("i0").expect("i0").to_js_string(), "74565");
    assert_eq!(id.prop("i3").expect("i3").to_js_string(), "2311527");
    assert_eq!(id.for_in_keys().expect("keys"), vec!["i0", "i1", "i2", "i3", "valueOf"]);
    id.delete("i1").expect("delete");
    assert_eq!(id.object_id_hex().as_deref(), Some("012345000000cdef01234567"));
    assert_eq!(id.own_keys().expect("keys"), vec!["i0", "i2", "i3"]);
  }
}
