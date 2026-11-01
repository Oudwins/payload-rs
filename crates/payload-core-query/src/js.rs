//! JS semantics on mutable data values ([`Val`]): property access with the
//! TypeErrors V8 throws, `in`, `for...in` key snapshots, spreads,
//! `Object.entries` and the error type shared by every function of the crate.

use std::cell::RefCell;

use payload_engine::error::EngineError;
use payload_engine::js::JsVal;
use payload_sql_read::Val;
use payload_sql_read::jsstr::JsStr;
use payload_sql_read::props;
use payload_sql_read::value::{Builtin, JsObject};

/// A thrown JS value.
#[derive(Clone, Debug)]
pub enum JsError {
  /// An error constructed by the ported code (`TypeError`, `APIError`, ...).
  Engine(EngineError),
  /// A value thrown by host code (access functions), passed through as is.
  Thrown(Val),
}

pub type JsResult<T> = std::result::Result<T, JsError>;

impl JsError {
  pub fn type_error(message: impl Into<String>) -> Self {
    JsError::Engine(EngineError::new("TypeError", message))
  }

  pub fn api(message: impl Into<String>) -> Self {
    JsError::Engine(EngineError::api(message))
  }

  pub fn name(&self) -> String {
    match self {
      JsError::Engine(e) => e.name.clone(),
      JsError::Thrown(v) => get(v, "name").ok().and_then(|n| val_str(&n)).unwrap_or_default(),
    }
  }

  /// `error.data` as seen from JS: `null` for `APIError`s, `undefined` otherwise.
  pub fn data(&self) -> Val {
    match self {
      JsError::Engine(e) if e.name == "APIError" => Val::Null,
      JsError::Engine(_) => Val::Undefined,
      JsError::Thrown(v) => get_opt(v, "data"),
    }
  }

  pub fn message(&self) -> String {
    match self {
      JsError::Engine(e) => e.message.clone(),
      JsError::Thrown(v) => get(v, "message").ok().and_then(|n| val_str(&n)).unwrap_or_default(),
    }
  }
}

impl From<EngineError> for JsError {
  fn from(e: EngineError) -> Self {
    JsError::Engine(e)
  }
}

fn type_name(v: &Val) -> &'static str {
  match v {
    Val::Bool(_) => "boolean",
    Val::Num(_) => "number",
    Val::Str(_) => "string",
    _ => "object",
  }
}

/// A string value as a Rust string (lone surrogates become U+FFFD).
pub fn val_str(v: &Val) -> Option<String> {
  v.as_js_str().map(|s| s.to_lossy().into_owned())
}

pub fn utf16_units(s: &str) -> Vec<u16> {
  s.encode_utf16().collect()
}

fn index_key(key: &str) -> Option<usize> {
  if key.is_empty() || (key.len() > 1 && key.starts_with('0')) || !key.bytes().all(|b| b.is_ascii_digit()) {
    return None;
  }
  key.parse::<usize>().ok()
}

fn unit_str(u: u16) -> Val {
  Val::Str(JsStr::from_units(&[u]))
}

/// `value[key]`, throwing like V8 for nullish receivers.
pub fn get(v: &Val, key: &str) -> JsResult<Val> {
  if let Val::Str(s) = v
    && let Some(i) = index_key(key)
  {
    return Ok(s.units().get(i).map(|u| unit_str(*u)).unwrap_or_default());
  }
  Ok(props::get(v, key)?)
}

/// `value?.[key]`
pub fn get_opt(v: &Val, key: &str) -> Val {
  if v.is_nullish() { Val::Undefined } else { get(v, key).unwrap_or_default() }
}

/// `value[key] = next` in strict mode code.
pub fn set(v: &Val, key: &str, next: Val) -> JsResult<()> {
  match v {
    Val::Bool(_) | Val::Num(_) | Val::Str(_) => Err(JsError::type_error(format!(
      "Cannot create property '{key}' on {} '{}'",
      type_name(v),
      v.to_js_string()
    ))),
    _ => Ok(props::set(v, key, next)?),
  }
}

/// `delete value[key]`
pub fn delete(v: &Val, key: &str) -> JsResult<()> {
  Ok(props::delete(v, key)?)
}

/// `key in value`
pub fn has_in(v: &Val, key: &str) -> JsResult<bool> {
  Ok(props::has(v, key)?)
}

/// Own key of an object, used to emulate `for...in` skipping keys deleted
/// during the iteration.
pub fn has_own(v: &Val, key: &str) -> bool {
  match v {
    Val::Obj(o) => o.borrow().has_own(key),
    Val::Arr(a) => index_key(key).is_some_and(|i| i < a.borrow().len()),
    Val::Str(s) => index_key(key).is_some_and(|i| i < s.utf16_len()),
    _ => false,
  }
}

/// Enumerable properties inherited from the built-in prototypes of the JS
/// realm. Normally empty, but libraries can add enumerable members (e.g. to
/// `String.prototype`), and `for...in` then visits them after the own keys.
#[derive(Clone, Debug, Default)]
pub struct InheritedEnumerables {
  pub object: Vec<String>,
  pub array: Vec<String>,
  pub string: Vec<String>,
}

thread_local! {
  static INHERITED: RefCell<InheritedEnumerables> = RefCell::new(InheritedEnumerables::default());
}

/// Sets the realm's inherited enumerable keys (`for (k in {})`, `for (k in [])`,
/// `for (k in '')` in the JS process the engine serves).
pub fn set_inherited_enumerables(inherited: InheritedEnumerables) {
  INHERITED.with(|i| *i.borrow_mut() = inherited);
}

fn inherited_keys(v: &Val) -> Vec<String> {
  INHERITED.with(|i| {
    let i = i.borrow();
    match v {
      Val::Obj(_) | Val::Date(_) => i.object.clone(),
      Val::Arr(_) => i.array.clone(),
      Val::Str(_) => i.string.clone(),
      _ => Vec::new(),
    }
  })
}

/// Keys visited by `for (const key in value)`, snapshotted at loop start:
/// own enumerable keys, then enumerable inherited keys not shadowed by them.
/// Callers must skip keys for which [`for_in_present`] became false (V8
/// re-checks deleted keys, and never visits keys added during the loop).
pub fn for_in_keys(v: &Val) -> Vec<String> {
  let mut keys: Vec<String> = match v {
    Val::Obj(o) => o.borrow().keys().iter().map(|k| k.to_lossy().into_owned()).collect(),
    Val::Arr(a) => (0..a.borrow().len()).map(|i| i.to_string()).collect(),
    Val::Str(s) => (0..s.utf16_len()).map(|i| i.to_string()).collect(),
    _ => Vec::new(),
  };
  for k in inherited_keys(v) {
    if !keys.contains(&k) {
      keys.push(k);
    }
  }
  keys
}

/// Whether a key snapshotted by [`for_in_keys`] is still visited.
pub fn for_in_present(v: &Val, key: &str) -> bool {
  has_own(v, key) || inherited_keys(v).iter().any(|k| k == key)
}

/// `Object.entries(value)`
pub fn entries(v: &Val) -> JsResult<Vec<(String, Val)>> {
  match v {
    Val::Undefined | Val::Null => Err(JsError::type_error("Cannot convert undefined or null to object")),
    Val::Obj(o) => Ok(o.borrow().entries().into_iter().map(|(k, v)| (k.to_lossy().into_owned(), v)).collect()),
    Val::Arr(a) => Ok(a.borrow().iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect()),
    Val::Str(s) => Ok(s.units().iter().enumerate().map(|(i, u)| (i.to_string(), unit_str(*u))).collect()),
    _ => Ok(Vec::new()),
  }
}

/// `{ ...value }` entries (nothing for nullish and non-string primitives).
pub fn spread_entries(v: &Val) -> Vec<(String, Val)> {
  entries(v).unwrap_or_default()
}

/// `[...value]`; `source` is the expression text V8 puts in the message.
pub fn spread_iterable(v: &Val, source: &str) -> JsResult<Vec<Val>> {
  match v {
    Val::Arr(a) => Ok(a.borrow().to_vec()),
    Val::Str(s) => {
      // the string iterator yields code points (lone surrogates on their own)
      let units = s.units();
      let mut out = Vec::new();
      let mut i = 0;
      while i < units.len() {
        let u = units[i];
        let pair = (0xD800..0xDC00).contains(&u) && units.get(i + 1).is_some_and(|n| (0xDC00..0xE000).contains(n));
        let len = if pair { 2 } else { 1 };
        out.push(Val::Str(JsStr::from_units(&units[i..i + len])));
        i += len;
      }
      Ok(out)
    }
    _ => Err(JsError::type_error(format!("{source} is not iterable"))),
  }
}

pub fn is_array(v: &Val) -> bool {
  matches!(v, Val::Arr(_))
}

/// `typeof value === 'object'`
pub fn is_object_type(v: &Val) -> bool {
  matches!(v, Val::Null | Val::Obj(_) | Val::Arr(_) | Val::Date(_) | Val::Builtin(Builtin::ObjectPrototype))
}

pub fn new_obj(entries: impl IntoIterator<Item = (String, Val)>) -> Val {
  let mut o = JsObject::new();
  for (k, v) in entries {
    o.define(k.as_str(), v);
  }
  Val::from_obj(o)
}

/// `['and', 'or'].includes(key.toLowerCase())`
pub fn is_and_or(key: &str) -> bool {
  let lower = key.to_lowercase();
  lower == "and" || lower == "or"
}

/// `value === string`
pub fn is_str(v: &Val, s: &str) -> bool {
  v.as_js_str().is_some_and(|v| v.key().is(s))
}

/// `value === string` for config values.
pub fn js_is_str(v: &JsVal, s: &str) -> bool {
  v.as_str() == Some(s)
}
