//! A JavaScript value model for the sanitized Payload config.
//!
//! The config is produced by TypeScript code and the engine has to reproduce
//! TypeScript semantics exactly (`'key' in obj`, truthiness, object identity
//! for shared objects), so the config is kept as a dynamic value instead of
//! typed structs. JS functions are represented by a handle that can be called
//! through the [`crate::host::Host`].

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use indexmap::IndexMap;
use serde_json::Value as Json;

pub use crate::bson::BsonValue;
use crate::bson::{base64_decode, base64_encode, object_id_bytes_from_hex, object_id_to_hex};
use crate::error::{EngineError, Result};

pub type Obj = IndexMap<String, JsVal>;

/// The items of a [`JsVal::Arr`] (derefs to `Vec<JsVal>`). Dropping it frees nested containers
/// iteratively, so arbitrarily deep values (V8's `JSON.parse` has no depth limit) never overflow
/// the stack.
#[derive(Clone, Default)]
pub struct Items(Vec<JsVal>);

/// The properties of a [`JsVal::Obj`] (derefs to [`Obj`]); dropped iteratively like [`Items`].
#[derive(Clone, Default)]
pub struct Props(Obj);

impl Items {
  pub fn into_vec(mut self) -> Vec<JsVal> {
    std::mem::take(&mut self.0)
  }
}

impl Props {
  pub fn into_obj(mut self) -> Obj {
    std::mem::take(&mut self.0)
  }
}

impl From<Vec<JsVal>> for Items {
  fn from(items: Vec<JsVal>) -> Self {
    Items(items)
  }
}

impl From<Obj> for Props {
  fn from(props: Obj) -> Self {
    Props(props)
  }
}

impl std::ops::Deref for Items {
  type Target = Vec<JsVal>;
  fn deref(&self) -> &Vec<JsVal> {
    &self.0
  }
}

impl std::ops::DerefMut for Items {
  fn deref_mut(&mut self) -> &mut Vec<JsVal> {
    &mut self.0
  }
}

impl std::ops::Deref for Props {
  type Target = Obj;
  fn deref(&self) -> &Obj {
    &self.0
  }
}

impl std::ops::DerefMut for Props {
  fn deref_mut(&mut self) -> &mut Obj {
    &mut self.0
  }
}

impl Drop for Items {
  fn drop(&mut self) {
    if self.0.iter().any(owns_nested) {
      drop_iteratively(std::mem::take(&mut self.0));
    }
  }
}

impl Drop for Props {
  fn drop(&mut self) {
    if self.0.values().any(owns_nested) {
      drop_iteratively(self.0.drain(..).map(|(_, v)| v).collect());
    }
  }
}

/// Whether dropping `value` frees a container that holds containers (a drop that would recurse).
fn owns_nested(value: &JsVal) -> bool {
  match value {
    JsVal::Arr(a) => Arc::strong_count(a) == 1 && a.iter().any(|v| matches!(v, JsVal::Arr(_) | JsVal::Obj(_))),
    JsVal::Obj(o) => Arc::strong_count(o) == 1 && o.values().any(|v| matches!(v, JsVal::Arr(_) | JsVal::Obj(_))),
    _ => false,
  }
}

/// Drops values without recursion: the contents of containers this is the last owner of are moved
/// into the work list before the (then empty) container is freed.
fn drop_iteratively(mut pending: Vec<JsVal>) {
  while let Some(value) = pending.pop() {
    match value {
      JsVal::Arr(a) => {
        if let Some(mut items) = Arc::into_inner(a) {
          pending.append(&mut items.0);
        }
      }
      JsVal::Obj(o) => {
        if let Some(mut props) = Arc::into_inner(o) {
          pending.extend(props.0.drain(..).map(|(_, v)| v));
        }
      }
      _ => {}
    }
  }
}

/// A JS value.
///
/// Decoded config graphs keep JS object identity, including cycles (see [`decode_graph`]): code
/// that walks arbitrary values recursively must track the objects it is inside of (like
/// [`JsVal::to_json`] does), or it will not terminate on a cyclic graph.
#[derive(Clone, Default)]
pub enum JsVal {
  #[default]
  Undefined,
  Null,
  Bool(bool),
  Num(f64),
  Str(Arc<str>),
  Arr(Arc<Items>),
  Obj(Arc<Props>),
  Fn(u32),
}

static UNDEFINED: JsVal = JsVal::Undefined;

/// Like a derived `Debug`, but prints `Circular` for an object that contains itself.
impl std::fmt::Debug for JsVal {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    fn write(v: &JsVal, f: &mut std::fmt::Formatter<'_>, ancestors: &mut Vec<usize>) -> std::fmt::Result {
      if let Some(typed) = v.typed() {
        return write!(f, "{typed:?}");
      }
      if let Some(bson) = v.bson() {
        return write!(f, "{bson:?}");
      }
      if let Some(id) = v.as_host_object() {
        return write!(f, "HostObject({id})");
      }
      let id = v.identity();
      if id.is_some_and(|id| ancestors.contains(&id)) {
        return f.write_str("Circular");
      }
      match v {
        JsVal::Undefined => f.write_str("Undefined"),
        JsVal::Null => f.write_str("Null"),
        JsVal::Bool(b) => write!(f, "Bool({b:?})"),
        JsVal::Num(n) => write!(f, "Num({n:?})"),
        JsVal::Str(s) => write!(f, "Str({s:?})"),
        JsVal::Fn(id) => write!(f, "Fn({id})"),
        JsVal::Arr(a) => {
          ancestors.extend(id);
          f.write_str("Arr([")?;
          for (i, item) in a.iter().enumerate() {
            if i > 0 {
              f.write_str(", ")?;
            }
            write(item, f, ancestors)?;
          }
          ancestors.pop();
          f.write_str("])")
        }
        JsVal::Obj(o) => {
          ancestors.extend(id);
          f.write_str("Obj({")?;
          for (i, (k, item)) in o.iter().enumerate() {
            if i > 0 {
              f.write_str(", ")?;
            }
            write!(f, "{k:?}: ")?;
            write(item, f, ancestors)?;
          }
          ancestors.pop();
          f.write_str("})")
        }
      }
    }
    write(self, f, &mut Vec::new())
  }
}

/// A JS value that has no [`JsVal`] variant of its own.
///
/// Typed values are represented as an empty [`JsVal::Obj`] (a `Date` is an object without own
/// properties in JS) whose identity is registered in a process-wide side table, so they cannot be
/// forged by user data and keep working through every existing `JsVal` match. Copying the
/// object's entries into a new object drops the type, like spreading a `Date` in JS does.
#[derive(Clone, Debug, PartialEq)]
pub enum TypedValue {
  /// A `Date`: its time value in ms since the epoch (`NaN` for an invalid date).
  Date(f64),
  /// A `bigint`, as its decimal `toString()`.
  BigInt(Arc<str>),
}

/// What a registered typed object stands for.
#[derive(Clone)]
enum Registered {
  Typed(TypedValue),
  Bson(BsonValue),
  /// A JS object the host keeps for one call (a mongoose `ClientSession`, an error), by the id
  /// the host gave it; encoded `{ "$hostObject": id }`. Only the host that issued it reads it.
  HostObject(u32),
}

struct TypedRegistry {
  entries: HashMap<usize, (Weak<Props>, Registered)>,
  prune_at: usize,
}

static TYPED_IN_USE: AtomicBool = AtomicBool::new(false);

fn typed_registry() -> &'static Mutex<TypedRegistry> {
  static REGISTRY: OnceLock<Mutex<TypedRegistry>> = OnceLock::new();
  REGISTRY.get_or_init(|| Mutex::new(TypedRegistry { entries: HashMap::new(), prune_at: 1024 }))
}

impl JsVal {
  /// A new typed value (see [`TypedValue`]).
  pub fn typed_value(value: TypedValue) -> JsVal {
    JsVal::register(Registered::Typed(value))
  }

  /// A new BSON value (see [`BsonValue`]).
  pub fn bson_value(value: BsonValue) -> JsVal {
    JsVal::register(Registered::Bson(value))
  }

  /// A handle to a JS object the host keeps for the current call (see `Registered::HostObject`).
  pub fn host_object(id: u32) -> JsVal {
    JsVal::register(Registered::HostObject(id))
  }

  fn register(value: Registered) -> JsVal {
    let obj = Arc::new(Props::default());
    let mut registry = typed_registry().lock().unwrap_or_else(|e| e.into_inner());
    if registry.entries.len() >= registry.prune_at {
      // The `Weak` keeps the allocation (and so the address) reserved until the entry is pruned.
      registry.entries.retain(|_, (weak, _)| weak.strong_count() > 0);
      registry.prune_at = (registry.entries.len() * 2).max(1024);
    }
    registry.entries.insert(Arc::as_ptr(&obj) as usize, (Arc::downgrade(&obj), value));
    TYPED_IN_USE.store(true, Ordering::Release);
    JsVal::Obj(obj)
  }

  /// `new Date(ms)`
  pub fn date(ms: f64) -> JsVal {
    JsVal::typed_value(TypedValue::Date(ms))
  }

  /// A `bigint` from its decimal string.
  pub fn bigint(decimal: impl Into<Arc<str>>) -> JsVal {
    JsVal::typed_value(TypedValue::BigInt(decimal.into()))
  }

  /// The [`TypedValue`] this object stands for, if it was created by [`JsVal::typed_value`].
  pub fn typed(&self) -> Option<TypedValue> {
    match self.registered()? {
      Registered::Typed(value) => Some(value),
      Registered::Bson(_) | Registered::HostObject(_) => None,
    }
  }

  /// The [`BsonValue`] this object stands for, if it was created by [`JsVal::bson_value`].
  pub fn bson(&self) -> Option<BsonValue> {
    match self.registered()? {
      Registered::Bson(value) => Some(value),
      Registered::Typed(_) | Registered::HostObject(_) => None,
    }
  }

  /// The id of a host object handle ([`JsVal::host_object`]).
  pub fn as_host_object(&self) -> Option<u32> {
    match self.registered()? {
      Registered::HostObject(id) => Some(id),
      Registered::Typed(_) | Registered::Bson(_) => None,
    }
  }

  /// The boundary encoding of a BSON value or host object handle, `None` for anything else.
  fn bson_encoding(&self) -> Option<Json> {
    Some(match self.registered()? {
      Registered::Bson(value) => encode_bson(&value),
      Registered::HostObject(id) => serde_json::json!({ "$hostObject": id }),
      Registered::Typed(_) => return None,
    })
  }

  fn registered(&self) -> Option<Registered> {
    let JsVal::Obj(o) = self else { return None };
    if !o.is_empty() || !TYPED_IN_USE.load(Ordering::Acquire) {
      return None;
    }
    let registry = typed_registry().lock().unwrap_or_else(|e| e.into_inner());
    registry
      .entries
      .get(&(Arc::as_ptr(o) as usize))
      .filter(|(weak, _)| std::ptr::eq(weak.as_ptr(), Arc::as_ptr(o)))
      .map(|(_, value)| value.clone())
  }

  /// The time value of a `Date`.
  pub fn as_date(&self) -> Option<f64> {
    match self.typed() {
      Some(TypedValue::Date(ms)) => Some(ms),
      _ => None,
    }
  }
}

impl JsVal {
  pub fn str(s: impl Into<Arc<str>>) -> Self {
    JsVal::Str(s.into())
  }

  pub fn obj(o: Obj) -> Self {
    JsVal::Obj(Arc::new(Props(o)))
  }

  pub fn arr(a: Vec<JsVal>) -> Self {
    JsVal::Arr(Arc::new(Items(a)))
  }

  /// `value[key]`, `undefined` when missing or not an object.
  pub fn get(&self, key: &str) -> &JsVal {
    match self {
      JsVal::Obj(o) => o.get(key).unwrap_or(&UNDEFINED),
      _ => &UNDEFINED,
    }
  }

  /// `key in value`
  pub fn has(&self, key: &str) -> bool {
    matches!(self, JsVal::Obj(o) if o.contains_key(key))
  }

  pub fn path(&self, keys: &[&str]) -> &JsVal {
    keys.iter().fold(self, |v, k| v.get(k))
  }

  /// JS `ToBoolean` (`0n` is falsy, every object including an invalid `Date` is truthy).
  pub fn truthy(&self) -> bool {
    match self {
      JsVal::Undefined | JsVal::Null => false,
      JsVal::Bool(b) => *b,
      JsVal::Num(n) => *n != 0.0 && !n.is_nan(),
      JsVal::Str(s) => !s.is_empty(),
      JsVal::Obj(o) if o.is_empty() => !matches!(self.typed(), Some(TypedValue::BigInt(d)) if &*d == "0"),
      JsVal::Arr(_) | JsVal::Obj(_) | JsVal::Fn(_) => true,
    }
  }

  /// JS `typeof value` (`'function'` for function handles, `'bigint'` / `'object'` for
  /// [`TypedValue`]s).
  pub fn type_of(&self) -> &'static str {
    match self {
      JsVal::Undefined => "undefined",
      JsVal::Null | JsVal::Arr(_) => "object",
      JsVal::Bool(_) => "boolean",
      JsVal::Num(_) => "number",
      JsVal::Str(_) => "string",
      JsVal::Fn(_) => "function",
      JsVal::Obj(_) if self.as_bigint().is_some() => "bigint",
      JsVal::Obj(_) => "object",
    }
  }

  /// The decimal `toString()` of a `bigint`.
  pub fn as_bigint(&self) -> Option<Arc<str>> {
    match self.typed() {
      Some(TypedValue::BigInt(d)) => Some(d),
      _ => None,
    }
  }

  pub fn is_undefined(&self) -> bool {
    matches!(self, JsVal::Undefined)
  }

  pub fn is_null(&self) -> bool {
    matches!(self, JsVal::Null)
  }

  pub fn is_nullish(&self) -> bool {
    matches!(self, JsVal::Undefined | JsVal::Null)
  }

  pub fn is_fn(&self) -> bool {
    matches!(self, JsVal::Fn(_))
  }

  pub fn is_true(&self) -> bool {
    matches!(self, JsVal::Bool(true))
  }

  /// `typeof value === 'object'` (includes `null` and arrays, like JS).
  pub fn is_object_like(&self) -> bool {
    match self {
      JsVal::Null | JsVal::Arr(_) => true,
      JsVal::Obj(o) => !o.is_empty() || self.as_bigint().is_none(),
      _ => false,
    }
  }

  pub fn as_str(&self) -> Option<&str> {
    match self {
      JsVal::Str(s) => Some(s),
      _ => None,
    }
  }

  pub fn as_num(&self) -> Option<f64> {
    match self {
      JsVal::Num(n) => Some(*n),
      _ => None,
    }
  }

  pub fn as_arr(&self) -> Option<&[JsVal]> {
    match self {
      JsVal::Arr(a) => Some(a),
      _ => None,
    }
  }

  pub fn as_obj(&self) -> Option<&Obj> {
    match self {
      JsVal::Obj(o) => Some(o),
      _ => None,
    }
  }

  /// Iterates array items, empty for non-arrays.
  pub fn items(&self) -> std::slice::Iter<'_, JsVal> {
    self.as_arr().unwrap_or(&[]).iter()
  }

  /// `===`: value equality for primitives (including `bigint`s), identity for objects.
  pub fn strict_eq(&self, other: &JsVal) -> bool {
    match (self, other) {
      (JsVal::Obj(a), JsVal::Obj(b)) if !Arc::ptr_eq(a, b) && a.is_empty() && b.is_empty() => {
        matches!((self.as_bigint(), other.as_bigint()), (Some(x), Some(y)) if x == y)
      }
      (JsVal::Undefined, JsVal::Undefined) | (JsVal::Null, JsVal::Null) => true,
      (JsVal::Bool(a), JsVal::Bool(b)) => a == b,
      (JsVal::Num(a), JsVal::Num(b)) => a == b,
      (JsVal::Str(a), JsVal::Str(b)) => a == b,
      (JsVal::Arr(a), JsVal::Arr(b)) => Arc::ptr_eq(a, b),
      (JsVal::Obj(a), JsVal::Obj(b)) => Arc::ptr_eq(a, b),
      (JsVal::Fn(a), JsVal::Fn(b)) => a == b,
      _ => false,
    }
  }

  /// Whether an object or array reachable from this value contains itself (directly or through
  /// other objects), so a naive recursive walk would not terminate.
  pub fn is_circular(&self) -> bool {
    fn walk(v: &JsVal, ancestors: &mut Vec<usize>, done: &mut std::collections::HashSet<usize>) -> bool {
      let Some(id) = v.identity() else { return false };
      if ancestors.contains(&id) {
        return true;
      }
      if done.contains(&id) {
        return false;
      }
      ancestors.push(id);
      let circular = match v {
        JsVal::Arr(a) => a.iter().any(|item| walk(item, ancestors, done)),
        JsVal::Obj(o) => o.values().any(|item| walk(item, ancestors, done)),
        _ => false,
      };
      ancestors.pop();
      done.insert(id);
      circular
    }
    walk(self, &mut Vec::new(), &mut std::collections::HashSet::new())
  }

  /// Stable identity of an object value, used for per-object side tables
  /// that mirror JS mutations of shared config objects.
  pub fn identity(&self) -> Option<usize> {
    match self {
      JsVal::Obj(o) => Some(Arc::as_ptr(o) as usize),
      JsVal::Arr(a) => Some(Arc::as_ptr(a) as usize),
      _ => None,
    }
  }

  /// JS `String(value)`: `bigint`s print their digits, `Date`s use `Date.prototype.toString`
  /// (see [`date_to_js_string`]), arrays join their items like `Array.prototype.join` (a nested
  /// reference to an array that is being joined prints as `''`, like V8). Objects print
  /// `[object Object]` (own `toString` methods are not called) and functions `function`.
  pub fn to_js_string(&self) -> String {
    fn write(v: &JsVal, ancestors: &mut Vec<usize>) -> String {
      match v {
        JsVal::Undefined => "undefined".into(),
        JsVal::Null => "null".into(),
        JsVal::Bool(b) => b.to_string(),
        JsVal::Num(n) => num_to_js_string(*n),
        JsVal::Str(s) => s.to_string(),
        JsVal::Arr(a) => {
          let id = Arc::as_ptr(a) as usize;
          if ancestors.contains(&id) {
            return String::new();
          }
          ancestors.push(id);
          let out = a
            .iter()
            .map(|item| if item.is_nullish() { String::new() } else { write(item, ancestors) })
            .collect::<Vec<_>>()
            .join(",");
          ancestors.pop();
          out
        }
        JsVal::Obj(_) => match v.typed() {
          Some(TypedValue::BigInt(d)) => d.to_string(),
          Some(TypedValue::Date(ms)) => date_to_js_string(ms),
          None => match v.bson() {
            Some(bson) => bson.to_js_string(),
            None => "[object Object]".into(),
          },
        },
        JsVal::Fn(_) => "function".into(),
      }
    }
    write(self, &mut Vec::new())
  }

  /// Converts to JSON the way `JSON.stringify` would (drops undefined and
  /// functions inside objects, `Date` becomes its ISO string). Where `JSON.stringify` throws, this
  /// stays lenient: a `bigint` becomes a number and a circular reference becomes `null`. Use
  /// [`JsVal::try_to_json`] for the throwing behaviour.
  pub fn to_json(&self) -> Json {
    self.json_with(&mut Vec::new(), false).unwrap_or(Json::Null)
  }

  /// `JSON.parse(JSON.stringify(value))` including its `TypeError`s for `bigint`s and circular
  /// structures (`undefined` and functions at the top level become `null`).
  pub fn try_to_json(&self) -> Result<Json> {
    self.json_with(&mut Vec::new(), true)
  }

  fn json_with(&self, ancestors: &mut Vec<usize>, strict: bool) -> Result<Json> {
    if let Some(typed) = self.typed() {
      return Ok(match typed {
        TypedValue::Date(ms) => date_to_iso_string(ms).map(Json::String).unwrap_or(Json::Null),
        TypedValue::BigInt(_) if strict => {
          return Err(EngineError::new("TypeError", "Do not know how to serialize a BigInt"));
        }
        TypedValue::BigInt(s) => num_to_json(s.parse::<f64>().unwrap_or(f64::NAN)),
      });
    }
    if let Some(bson) = self.bson() {
      return Ok(bson.to_json());
    }
    let id = self.identity();
    if let Some(id) = id {
      if ancestors.contains(&id) {
        if strict {
          return Err(EngineError::new("TypeError", "Converting circular structure to JSON"));
        }
        return Ok(Json::Null);
      }
      ancestors.push(id);
    }
    let out = match self {
      JsVal::Undefined | JsVal::Null | JsVal::Fn(_) => Json::Null,
      JsVal::Bool(b) => Json::Bool(*b),
      JsVal::Num(n) => num_to_json(*n),
      JsVal::Str(s) => Json::String(s.to_string()),
      JsVal::Arr(a) => Json::Array(a.iter().map(|v| v.json_with(ancestors, strict)).collect::<Result<_>>()?),
      JsVal::Obj(o) => Json::Object(
        o.iter()
          .filter(|(_, v)| !matches!(v, JsVal::Undefined | JsVal::Fn(_)))
          .map(|(k, v)| Ok((k.clone(), v.json_with(ancestors, strict)?)))
          .collect::<Result<_>>()?,
      ),
    };
    if id.is_some() {
      ancestors.pop();
    }
    Ok(out)
  }

  pub fn from_json(json: &Json) -> JsVal {
    match json {
      Json::Null => JsVal::Null,
      Json::Bool(b) => JsVal::Bool(*b),
      Json::Number(n) => JsVal::Num(n.as_f64().unwrap_or(f64::NAN)),
      Json::String(s) => JsVal::str(s.as_str()),
      Json::Array(a) => JsVal::arr(a.iter().map(JsVal::from_json).collect()),
      Json::Object(o) => JsVal::obj(o.iter().map(|(k, v)| (k.clone(), JsVal::from_json(v))).collect()),
    }
  }
}

pub fn num_to_json(n: f64) -> Json {
  if n.is_finite() && n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
    Json::from(n as i64)
  } else {
    serde_json::Number::from_f64(n).map(Json::Number).unwrap_or(Json::Null)
  }
}

/// ECMAScript `Number::toString(n)` (radix 10): the shortest digits that round-trip, in fixed
/// notation for exponents from -7 to 20 and `d.ddde±x` otherwise, `-0` prints `0`.
pub fn num_to_js_string(n: f64) -> String {
  if n.is_nan() {
    return "NaN".into();
  }
  if n == 0.0 {
    return "0".into();
  }
  if n.is_infinite() {
    return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() };
  }
  let (digits, point) = shortest_digits(n.abs());
  let k = digits.len() as i64;
  let mut out = String::with_capacity(k as usize + 8);
  if n < 0.0 {
    out.push('-');
  }
  if k <= point && point <= 21 {
    out.push_str(&digits);
    out.extend(std::iter::repeat_n('0', (point - k) as usize));
  } else if 0 < point && point <= 21 {
    out.push_str(&digits[..point as usize]);
    out.push('.');
    out.push_str(&digits[point as usize..]);
  } else if -6 < point && point <= 0 {
    out.push_str("0.");
    out.extend(std::iter::repeat_n('0', (-point) as usize));
    out.push_str(&digits);
  } else {
    out.push_str(&digits[..1]);
    if k > 1 {
      out.push('.');
      out.push_str(&digits[1..]);
    }
    let e = point - 1;
    out.push_str(&format!("e{}{}", if e < 0 { '-' } else { '+' }, e.abs()));
  }
  out
}

/// Splits `{:e}` output (`d.ddde<exp>`) into its digits and the decimal exponent of `0.digits`.
fn split_scientific(scientific: &str) -> (String, i64) {
  let (mantissa, exponent) = scientific.split_once('e').unwrap_or((scientific, "0"));
  let digits = mantissa.chars().filter(|c| *c != '.').collect();
  (digits, exponent.parse::<i64>().unwrap_or(0) + 1)
}

/// The digits `s` (no trailing zeros) and exponent `n` of Number::toString step 5: the fewest
/// digits for which `0.s * 10^n` round-trips to `v`, and of those the closest to `v` (the even
/// one on a tie). `v` is finite and positive.
fn shortest_digits(v: f64) -> (String, i64) {
  if v.fract() == 0.0 && v < 9.007_199_254_740_992e15 {
    // an exact integer: its digits are the shortest, closest representation
    let integer = (v as u64).to_string();
    let point = integer.len() as i64;
    return (integer.trim_end_matches('0').to_string(), point);
  }
  // `{:e}` prints the fewest round-trip digits, closest to `v`, but on a tie between two
  // candidates it does not always pick the even one
  let (digits, point) = split_scientific(&format!("{v:e}"));
  let k = digits.len();
  // `v = m * 2^-q` with `m` odd has the exact decimal `m * 5^q / 10^q`, whose `len(m * 5^q)`
  // significant digits exceed the 18 a tie between 17 digit candidates needs once `q > 25`
  let bits = v.to_bits();
  let exponent = ((bits >> 52) & 0x7ff) as i64;
  let mantissa = if exponent == 0 { bits & ((1 << 52) - 1) } else { (bits & ((1 << 52) - 1)) | (1 << 52) };
  let q = 1075 - exponent.max(1) - mantissa.trailing_zeros() as i64;
  if q > 25 {
    return (digits, point);
  }
  // the exact decimal value of `v` (len(m * 5^q) <= 34 digits for q <= 25, at most 309 for
  // integers) rounded half-even to `k` digits
  let (exact, exact_point) = split_scientific(&format!("{v:.400e}"));
  let exact = exact.as_bytes();
  let mut rounded: Vec<u8> = exact[..k].to_vec();
  let rest = &exact[k..];
  let round_up = match rest.first() {
    Some(b'5') if rest[1..].iter().all(|d| *d == b'0') => (rounded[k - 1] - b'0') % 2 == 1,
    Some(d) => *d >= b'5',
    None => false,
  };
  let mut rounded_point = exact_point;
  if round_up {
    let mut i = k;
    loop {
      if i == 0 {
        rounded.insert(0, b'1');
        rounded.pop();
        rounded_point += 1;
        break;
      }
      i -= 1;
      if rounded[i] == b'9' {
        rounded[i] = b'0';
      } else {
        rounded[i] += 1;
        break;
      }
    }
  }
  let rounded = String::from_utf8(rounded).unwrap_or_default();
  let rounded = rounded.trim_end_matches('0');
  if (rounded, rounded_point) != (digits.as_str(), point)
    && format!("0.{rounded}e{rounded_point}").parse::<f64>().is_ok_and(|parsed| parsed == v)
  {
    return (rounded.to_string(), rounded_point);
  }
  (digits, point)
}

/// `Date.prototype.toString` in the process time zone (libc `localtime_r`, i.e. `TZ`), e.g.
/// `Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)`; `Invalid Date` for `NaN`.
///
/// The date, time and `GMT±hhmm` offset match V8 wherever libc and ICU agree on the offset. The
/// parenthesized zone name comes from ICU in V8; it is reproduced for UTC / GMT and the common
/// abbreviations in [`zone_long_name`], other zones print `GMT±hh:mm` there (what V8 prints for
/// zones without a name).
pub fn date_to_js_string(ms: f64) -> String {
  if !ms.is_finite() || ms.abs() > 8.64e15 {
    return "Invalid Date".into();
  }
  let t = ms.trunc();
  let (offset_seconds, abbreviation) = local_time_zone(t);
  // the local time uses the exact offset, the printed offset is truncated to minutes
  let offset_minutes = offset_seconds / 60;
  let local = t as i64 + offset_seconds * 1000;
  let days = local.div_euclid(MS_PER_DAY);
  let time = local.rem_euclid(MS_PER_DAY);
  let (year, month, day) = civil_from_days(days);
  const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
  const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let year = if year < 0 { format!("-{:04}", -year) } else { format!("{year:04}") };
  let sign = if offset_minutes < 0 { '-' } else { '+' };
  let (oh, om) = (offset_minutes.abs() / 60, offset_minutes.abs() % 60);
  let name = zone_long_name(&abbreviation, offset_minutes).unwrap_or_else(|| format!("GMT{sign}{oh:02}:{om:02}"));
  format!(
    "{} {} {day:02} {year} {:02}:{:02}:{:02} GMT{sign}{oh:02}{om:02} ({name})",
    WEEKDAYS[days.rem_euclid(7) as usize],
    MONTHS[(month - 1).clamp(0, 11) as usize],
    time / 3_600_000,
    time / 60_000 % 60,
    time / 1000 % 60,
  )
}

/// ICU long names (en-US) for common zone abbreviations, as V8 prints them in `Date.prototype.toString`.
fn zone_long_name(abbreviation: &str, offset_minutes: i64) -> Option<String> {
  if std::env::var_os("TZ").is_some_and(|tz| tz.is_empty()) {
    return None;
  }
  Some(
    match (abbreviation, offset_minutes) {
      ("UTC" | "UCT" | "Z", 0) => "Coordinated Universal Time",
      ("GMT", 0) => "Greenwich Mean Time",
      ("BST", 60) => "British Summer Time",
      ("CET", 60) => "Central European Standard Time",
      ("CEST", 120) => "Central European Summer Time",
      ("EET", 120) => "Eastern European Standard Time",
      ("EEST", 180) => "Eastern European Summer Time",
      ("WET", 0) => "Western European Standard Time",
      ("WEST", 60) => "Western European Summer Time",
      ("EST", -300) => "Eastern Standard Time",
      ("EDT", -240) => "Eastern Daylight Time",
      ("CST", -360) => "Central Standard Time",
      ("CDT", -300) => "Central Daylight Time",
      ("MST", -420) => "Mountain Standard Time",
      ("MDT", -360) => "Mountain Daylight Time",
      ("PST", -480) => "Pacific Standard Time",
      ("PDT", -420) => "Pacific Daylight Time",
      ("JST", 540) => "Japan Standard Time",
      ("AEST", 600) => "Australian Eastern Standard Time",
      ("AEDT", 660) => "Australian Eastern Daylight Time",
      _ => return None,
    }
    .to_string(),
  )
}

/// Offset from UTC in seconds and the zone abbreviation at UTC time `ms`, in the process time zone.
#[cfg(unix)]
fn local_time_zone(ms: f64) -> (i64, String) {
  let secs = (ms / 1000.0).floor() as libc::time_t;
  // SAFETY: `localtime_r` only writes into the provided `tm`; `tm_zone` points to static (or
  // `tm`-owned) NUL-terminated storage that stays valid while it is read here.
  unsafe {
    let mut tm: libc::tm = std::mem::zeroed();
    if libc::localtime_r(&secs, &mut tm).is_null() {
      return (0, String::new());
    }
    let zone = if tm.tm_zone.is_null() {
      String::new()
    } else {
      std::ffi::CStr::from_ptr(tm.tm_zone).to_string_lossy().into_owned()
    };
    (tm.tm_gmtoff as i64, zone)
  }
}

#[cfg(not(unix))]
fn local_time_zone(_ms: f64) -> (i64, String) {
  (0, "UTC".into())
}

/// Decodes the graph produced by `serializeForEngine` (packages/engine-rs).
///
/// Encoding:
/// - `{"$fn": id}`: a JS function registered on the TS side
/// - `{"$ref": id}`: a shared object, stored once in `objects[id]`
/// - `{"$undefined": true}`: an own property whose value is `undefined`
/// - `{"$num": "NaN" | "Infinity" | "-Infinity" | "-0"}`: non-JSON numbers (and `-0`, which
///   `JSON.stringify` writes as `0`)
/// - `{"$date": iso | null}`: a `Date` (`null` when invalid)
/// - `{"$bigint": "123"}`: a `bigint`
/// - `{"$obj": {...}}`: escape for plain objects that use one of the keys above
///
/// Every `$ref` to the same id decodes to the same object (same [`JsVal::identity`]), and
/// circular references become real cycles in the decoded graph, like the JS object graph (e.g.
/// `block.custom.owner = collection` resolves to the collection itself whichever side is reached
/// first). Use [`JsVal::is_circular`] before walking an arbitrary value recursively.
///
/// `Date`s decode to their ISO string (`null` when invalid) and `bigint`s to numbers, as before
/// the typed encoding existed. Use [`decode_graph_typed`] to keep them as [`TypedValue`]s.
pub fn decode_graph(json: &Json) -> Result<JsVal> {
  decode_graph_with(json, false, false)
}

/// [`decode_graph`], but `Date`s and `bigint`s decode to [`TypedValue`]s
/// ([`JsVal::date`] / [`JsVal::bigint`]), so their JS type survives the round trip.
pub fn decode_graph_typed(json: &Json) -> Result<JsVal> {
  decode_graph_with(json, true, false)
}

/// [`decode_graph_typed`] that also decodes the BSON markers of the MongoDB boundary
/// (`$oid`, `$regex`, `$decimal`, `$binary`, `$buffer`, `$hostObject`, see [`crate::bson`]) into
/// [`BsonValue`]s / host object handles. The other decoders keep those keys as plain data.
pub fn decode_graph_bson(json: &Json) -> Result<JsVal> {
  decode_graph_with(json, true, true)
}

/// Decodes a tree in the boundary encoding (no `objects` / `$ref`s, as `encode_value` writes it and
/// as host results are sent) with dates, bigints and BSON markers typed.
pub fn decode_value_bson(json: &Json) -> Result<JsVal> {
  let mut decoder = Decoder { objects: &[], refs: Vec::new(), typed: true, bson: true };
  decoder.decode(json)
}

fn decode_graph_with(json: &Json, typed: bool, bson: bool) -> Result<JsVal> {
  let objects = json
    .get("objects")
    .and_then(|o| o.as_array())
    .ok_or_else(|| EngineError::internal("serialized graph is missing `objects`"))?;
  let root = json.get("root").ok_or_else(|| EngineError::internal("serialized graph is missing `root`"))?;

  let mut decoder = Decoder { objects, refs: vec![RefState::Pending; objects.len()], typed, bson };
  decoder.decode(root)
}

/// Decoding state of one `objects[id]` entry.
#[derive(Clone)]
enum RefState {
  Pending,
  /// Being decoded: the container its value will be written into, so references from inside
  /// (cycles) get the real object.
  InProgress(Option<JsVal>),
  Done(JsVal),
}

struct Decoder<'a> {
  objects: &'a [Json],
  refs: Vec<RefState>,
  typed: bool,
  /// Decode the BSON markers ([`BSON_KEYS`]); otherwise they are plain keys, as before they
  /// existed.
  bson: bool,
}

/// Keys of the BSON boundary encoding (see [`crate::bson`]), decoded by the bson decoders only.
const BSON_KEYS: [&str; 6] = ["$binary", "$buffer", "$decimal", "$hostObject", "$oid", "$regex"];

impl Decoder<'_> {
  /// The single key of a marker object (`{"$fn": 1}`, ...), `None` for a plain object.
  fn marker_key<'o>(&self, o: &'o serde_json::Map<String, Json>) -> Option<&'o str> {
    if o.len() != 1 {
      return None;
    }
    let key = o.keys().next()?.as_str();
    let is_marker = BASE_RESERVED_KEYS.contains(&key) || (self.bson && BSON_KEYS.contains(&key));
    is_marker.then_some(key)
  }
}

/// Encodes a [`BsonValue`] (see [`crate::bson`]).
fn encode_bson(value: &BsonValue) -> Json {
  match value {
    BsonValue::ObjectId(bytes) => serde_json::json!({ "$oid": object_id_to_hex(bytes) }),
    BsonValue::RegExp { source, flags } => serde_json::json!({ "$regex": { "source": &**source, "flags": &**flags } }),
    BsonValue::Decimal128(s) => serde_json::json!({ "$decimal": &**s }),
    BsonValue::Binary { sub_type, bytes } => {
      serde_json::json!({ "$binary": { "base64": base64_encode(bytes), "subType": sub_type } })
    }
    BsonValue::Buffer(bytes) => serde_json::json!({ "$buffer": base64_encode(bytes) }),
  }
}

/// Decodes the value `v` of the BSON marker `key`.
fn decode_bson(key: &str, v: &Json) -> Option<JsVal> {
  Some(match key {
    "$oid" => JsVal::object_id(object_id_bytes_from_hex(v.as_str()?)?),
    "$regex" => {
      let o = v.as_object()?;
      JsVal::regexp(o.get("source")?.as_str()?, o.get("flags")?.as_str()?)
    }
    "$decimal" => JsVal::decimal128(v.as_str()?),
    "$binary" => {
      let o = v.as_object()?;
      let sub_type = u8::try_from(o.get("subType")?.as_u64()?).ok()?;
      JsVal::binary(sub_type, base64_decode(o.get("base64")?.as_str()?)?)
    }
    "$buffer" => JsVal::buffer(base64_decode(v.as_str()?)?),
    "$hostObject" => JsVal::host_object(u32::try_from(v.as_u64()?).ok()?),
    _ => return None,
  })
}

/// Writes the decoded contents of a shared container into the allocation that references to it
/// (from inside its own contents, i.e. cycles) already point to.
///
/// SAFETY: the caller guarantees that no reference into `target`'s data exists while this runs.
/// The decoder only clones the `Arc`s of containers that are being decoded (it never dereferences
/// them) and the graph is not visible to anyone else before decoding finishes.
unsafe fn fill<T>(target: &Arc<T>, value: T) {
  // `Arc::as_ptr` derives the pointer from the allocation (not from a shared reference), so
  // writing through it is what the unstable `Arc::get_mut_unchecked` does.
  unsafe { *Arc::as_ptr(target).cast_mut() = value }
}

impl Decoder<'_> {
  fn decode(&mut self, json: &Json) -> Result<JsVal> {
    Ok(match json {
      Json::Null => JsVal::Null,
      Json::Bool(b) => JsVal::Bool(*b),
      Json::Number(n) => JsVal::Num(n.as_f64().unwrap_or(f64::NAN)),
      Json::String(s) => JsVal::str(s.as_str()),
      Json::Array(a) => JsVal::arr(self.decode_items(a)?),
      Json::Object(o) => match self.marker_key(o) {
        Some(key) => {
          let v = &o[key];
          match key {
            "$fn" => JsVal::Fn(v.as_u64().unwrap_or(0) as u32),
            "$undefined" => JsVal::Undefined,
            "$num" => JsVal::Num(match v.as_str() {
              Some("Infinity") => f64::INFINITY,
              Some("-Infinity") => f64::NEG_INFINITY,
              Some("-0") => -0.0,
              _ => f64::NAN,
            }),
            "$date" => {
              let iso = v.as_str();
              if self.typed {
                JsVal::date(iso.and_then(parse_iso_date).unwrap_or(f64::NAN))
              } else {
                iso.map(JsVal::str).unwrap_or(JsVal::Null)
              }
            }
            "$bigint" => {
              let decimal = v.as_str().unwrap_or("0");
              if self.typed {
                JsVal::bigint(decimal)
              } else {
                JsVal::Num(decimal.parse::<f64>().unwrap_or(f64::NAN))
              }
            }
            "$obj" => JsVal::obj(self.decode_entries(v.as_object().into_iter().flatten())?),
            key if BSON_KEYS.contains(&key) => {
              decode_bson(key, v).ok_or_else(|| EngineError::internal(format!("malformed {key} value: {v}")))?
            }
            _ => self.decode_ref(v.as_u64().unwrap_or(u64::MAX) as usize)?,
          }
        }
        None => JsVal::obj(self.decode_entries(o.iter())?),
      },
    })
  }

  fn decode_items(&mut self, items: &[Json]) -> Result<Vec<JsVal>> {
    items.iter().map(|v| self.decode(v)).collect()
  }

  fn decode_entries<'b>(&mut self, entries: impl Iterator<Item = (&'b String, &'b Json)>) -> Result<Obj> {
    let mut obj = Obj::new();
    for (k, v) in entries {
      obj.insert(k.clone(), self.decode(v)?);
    }
    Ok(obj)
  }

  /// `objects[id]`, decoded once: every reference shares the same `Arc` (JS identity), including
  /// references from inside the object itself, which form a real cycle. A cyclic graph is never
  /// freed (reference counting cannot collect it); decoded configs live as long as the engine.
  fn decode_ref(&mut self, id: usize) -> Result<JsVal> {
    let json = self.objects.get(id).ok_or_else(|| EngineError::internal(format!("dangling $ref {id}")))?;
    match &self.refs[id] {
      RefState::Done(v) => return Ok(v.clone()),
      RefState::InProgress(Some(v)) => return Ok(v.clone()),
      RefState::InProgress(None) => {
        return Err(EngineError::internal(format!("$ref {id} refers to itself without a container")));
      }
      RefState::Pending => {}
    }
    let value = match json {
      Json::Array(items) => {
        let target = Arc::new(Items::default());
        self.refs[id] = RefState::InProgress(Some(JsVal::Arr(target.clone())));
        let items = self.decode_items(items)?;
        // SAFETY: see `fill`.
        unsafe { fill(&target, Items(items)) };
        JsVal::Arr(target)
      }
      Json::Object(o) if self.marker_key(o).is_none_or(|key| key == "$obj") => {
        let target = Arc::new(Props::default());
        self.refs[id] = RefState::InProgress(Some(JsVal::Obj(target.clone())));
        let entries = match self.marker_key(o) {
          Some(_) => self.decode_entries(o["$obj"].as_object().into_iter().flatten())?,
          None => self.decode_entries(o.iter())?,
        };
        // SAFETY: see `fill`.
        unsafe { fill(&target, Props(entries)) };
        JsVal::Obj(target)
      }
      // typed values and other markers: nothing inside can refer back to them
      other => {
        self.refs[id] = RefState::InProgress(None);
        self.decode(other)?
      }
    };
    self.refs[id] = RefState::Done(value.clone());
    Ok(value)
  }
}

/// Keys of the boundary encoding every decoder reads.
const BASE_RESERVED_KEYS: [&str; 7] = ["$bigint", "$date", "$fn", "$num", "$obj", "$ref", "$undefined"];

/// Keys a user object whose only key is one of them is `$obj`-escaped for: the base keys and the
/// BSON keys (escaping is lossless, so this does not change what any decoder returns).
const RESERVED_KEYS: [&str; 13] = [
  "$bigint",
  "$binary",
  "$buffer",
  "$date",
  "$decimal",
  "$fn",
  "$hostObject",
  "$num",
  "$obj",
  "$oid",
  "$ref",
  "$regex",
  "$undefined",
];

/// Encodes a value in the `serializeForEngine` format (as a tree, without `$ref`s), for values
/// handed back to TS (decoded by `deserializeFromEngine` in packages/engine-rs).
///
/// A tree cannot share objects: an object reached twice is encoded twice, and a reference to an
/// object from inside itself (a cycle) is encoded as `undefined`.
pub fn encode_value(v: &JsVal) -> Json {
  encode_tree(v, &mut Vec::new())
}

fn encode_tree(v: &JsVal, ancestors: &mut Vec<usize>) -> Json {
  let id = v.identity();
  if id.is_some_and(|id| ancestors.contains(&id)) {
    return serde_json::json!({ "$undefined": true });
  }
  match v {
    JsVal::Undefined => serde_json::json!({ "$undefined": true }),
    JsVal::Null => Json::Null,
    JsVal::Bool(b) => Json::Bool(*b),
    JsVal::Num(n) if !n.is_finite() => serde_json::json!({ "$num": num_to_js_string(*n) }),
    JsVal::Num(n) => num_to_json(*n),
    JsVal::Str(s) => Json::String(s.to_string()),
    JsVal::Fn(id) => serde_json::json!({ "$fn": id }),
    JsVal::Arr(a) => {
      ancestors.extend(id);
      let out = Json::Array(a.iter().map(|item| encode_tree(item, ancestors)).collect());
      ancestors.pop();
      out
    }
    JsVal::Obj(o) => {
      if o.is_empty() {
        match v.typed() {
          Some(TypedValue::Date(ms)) => return serde_json::json!({ "$date": date_to_iso_string(ms) }),
          Some(TypedValue::BigInt(s)) => return serde_json::json!({ "$bigint": &*s }),
          None => {}
        }
        if let Some(encoded) = v.bson_encoding() {
          return encoded;
        }
      }
      ancestors.extend(id);
      let out: serde_json::Map<String, Json> = o.iter().map(|(k, item)| (k.clone(), encode_tree(item, ancestors))).collect();
      ancestors.pop();
      if out.len() == 1 && RESERVED_KEYS.contains(&out.keys().next().map(String::as_str).unwrap_or("")) {
        serde_json::json!({ "$obj": out })
      } else {
        Json::Object(out)
      }
    }
  }
}

/// [`encode_value`] as JSON text, built without recursion (values of any depth). A negative zero
/// is written as `-0`, so `JSON.parse` gives back `-0` exactly.
pub fn encode_value_text(v: &JsVal) -> String {
  let mut out = String::new();
  write_encoded(v, &mut out);
  out
}

/// Appends the [`encode_value_text`] of `v` to `out`.
pub fn write_encoded(v: &JsVal, out: &mut String) {
  enum Work<'a> {
    Value(&'a JsVal),
    Text(&'static str),
    Key(&'a str, bool),
    /// leaves the container whose identity was pushed onto `ancestors`
    Leave,
  }
  let mut ancestors: std::collections::HashSet<usize> = std::collections::HashSet::new();
  let mut path: Vec<usize> = Vec::new();
  let mut work = vec![Work::Value(v)];
  while let Some(item) = work.pop() {
    let value = match item {
      Work::Text(text) => {
        out.push_str(text);
        continue;
      }
      Work::Key(key, first) => {
        if !first {
          out.push(',');
        }
        write_json_string(key, out);
        out.push(':');
        continue;
      }
      Work::Leave => {
        if let Some(id) = path.pop() {
          ancestors.remove(&id);
        }
        continue;
      }
      Work::Value(value) => value,
    };
    let id = value.identity();
    if id.is_some_and(|id| ancestors.contains(&id)) {
      out.push_str(r#"{"$undefined":true}"#);
      continue;
    }
    match value {
      JsVal::Undefined => out.push_str(r#"{"$undefined":true}"#),
      JsVal::Null => out.push_str("null"),
      JsVal::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
      JsVal::Num(n) if !n.is_finite() => {
        out.push_str(r#"{"$num":""#);
        out.push_str(&num_to_js_string(*n));
        out.push_str(r#""}"#);
      }
      JsVal::Num(n) => write_json_number(*n, out),
      JsVal::Str(s) => write_json_string(s, out),
      JsVal::Fn(id) => {
        out.push_str(r#"{"$fn":"#);
        out.push_str(&id.to_string());
        out.push('}');
      }
      JsVal::Arr(a) => {
        if let Some(id) = id {
          ancestors.insert(id);
          path.push(id);
        }
        out.push('[');
        work.push(Work::Leave);
        work.push(Work::Text("]"));
        for (i, item) in a.iter().enumerate().rev() {
          work.push(Work::Value(item));
          if i > 0 {
            work.push(Work::Text(","));
          }
        }
      }
      JsVal::Obj(o) => {
        if o.is_empty() {
          match value.typed() {
            Some(TypedValue::Date(ms)) => {
              out.push_str(r#"{"$date":"#);
              match date_to_iso_string(ms) {
                Some(iso) => write_json_string(&iso, out),
                None => out.push_str("null"),
              }
              out.push('}');
              continue;
            }
            Some(TypedValue::BigInt(s)) => {
              out.push_str(r#"{"$bigint":"#);
              write_json_string(&s, out);
              out.push('}');
              continue;
            }
            None => {}
          }
          if let Some(encoded) = value.bson_encoding() {
            out.push_str(&encoded.to_string());
            continue;
          }
        }
        if let Some(id) = id {
          ancestors.insert(id);
          path.push(id);
        }
        let escaped = o.len() == 1 && o.keys().next().is_some_and(|k| RESERVED_KEYS.contains(&k.as_str()));
        out.push_str(if escaped { r#"{"$obj":{"# } else { "{" });
        work.push(Work::Leave);
        work.push(Work::Text(if escaped { "}}" } else { "}" }));
        for (i, (key, item)) in o.iter().enumerate().rev() {
          work.push(Work::Value(item));
          work.push(Work::Key(key, i == 0));
        }
      }
    }
  }
}

/// The value of [`write_encoded`] split in two, for decoding with one `JSON.parse` and no walk:
/// `out` gets plain JSON whose `JSON.parse` is the decoded value except at the values JSON cannot
/// hold (`undefined`, non-finite numbers, functions, `Date`s, `bigint`s, BSON values, and a
/// reference to an object from inside itself), which are written as `null`; `patches` gets one
/// `[path, tree]` entry per such value, comma-separated, in document order, where `path` lists
/// the object keys (strings) and array indexes (numbers) from the root (`[]`: the root itself)
/// and `tree` is the value's [`write_encoded`] text. Objects with a single reserved key are
/// written as they are (no `$obj` escape: plain JSON has no markers). Returns the number of
/// patches. Built without recursion (values of any depth).
///
/// `JSON.parse(out)`, then every patch's decoded tree assigned at its path, equals
/// `deserializeFromEngine` of the [`write_encoded`] text: key order, `__proto__` keys (an own data
/// property in both) and `-0` included.
pub fn write_patched(v: &JsVal, out: &mut String, patches: &mut String) -> usize {
  enum Segment<'a> {
    Key(&'a str),
    Index(usize),
  }
  enum Work<'a> {
    Value(&'a JsVal),
    Text(&'static str),
    Key(&'a str, bool),
    Enter(Segment<'a>),
    Exit,
    /// leaves the container whose identity was pushed onto `ancestors`
    Leave,
  }
  let mut count = 0;
  let mut ancestors: std::collections::HashSet<usize> = std::collections::HashSet::new();
  let mut containers: Vec<usize> = Vec::new();
  let mut path: Vec<Segment<'_>> = Vec::new();
  let mut work = vec![Work::Value(v)];
  let mut patch = |path: &[Segment<'_>], value: Option<&JsVal>, out: &mut String, patches: &mut String| {
    out.push_str("null");
    if count > 0 {
      patches.push(',');
    }
    count += 1;
    patches.push_str("[[");
    for (i, segment) in path.iter().enumerate() {
      if i > 0 {
        patches.push(',');
      }
      match segment {
        Segment::Key(key) => write_json_string(key, patches),
        Segment::Index(index) => patches.push_str(&index.to_string()),
      }
    }
    patches.push_str("],");
    match value {
      Some(value) => write_encoded(value, patches),
      None => patches.push_str(r#"{"$undefined":true}"#),
    }
    patches.push(']');
  };
  while let Some(item) = work.pop() {
    let value = match item {
      Work::Text(text) => {
        out.push_str(text);
        continue;
      }
      Work::Key(key, first) => {
        if !first {
          out.push(',');
        }
        write_json_string(key, out);
        out.push(':');
        continue;
      }
      Work::Enter(segment) => {
        path.push(segment);
        continue;
      }
      Work::Exit => {
        path.pop();
        continue;
      }
      Work::Leave => {
        if let Some(id) = containers.pop() {
          ancestors.remove(&id);
        }
        continue;
      }
      Work::Value(value) => value,
    };
    let id = value.identity();
    if id.is_some_and(|id| ancestors.contains(&id)) {
      patch(&path, None, out, patches);
      continue;
    }
    match value {
      JsVal::Undefined | JsVal::Fn(_) => patch(&path, Some(value), out, patches),
      JsVal::Num(n) if !n.is_finite() => patch(&path, Some(value), out, patches),
      JsVal::Null => out.push_str("null"),
      JsVal::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
      JsVal::Num(n) => write_json_number(*n, out),
      JsVal::Str(s) => write_json_string(s, out),
      JsVal::Arr(a) => {
        if let Some(id) = id {
          ancestors.insert(id);
          containers.push(id);
        }
        out.push('[');
        work.push(Work::Leave);
        work.push(Work::Text("]"));
        for (i, item) in a.iter().enumerate().rev() {
          work.push(Work::Exit);
          work.push(Work::Value(item));
          work.push(Work::Enter(Segment::Index(i)));
          if i > 0 {
            work.push(Work::Text(","));
          }
        }
      }
      JsVal::Obj(o) => {
        if o.is_empty() && (value.typed().is_some() || value.bson_encoding().is_some()) {
          patch(&path, Some(value), out, patches);
          continue;
        }
        if let Some(id) = id {
          ancestors.insert(id);
          containers.push(id);
        }
        out.push('{');
        work.push(Work::Leave);
        work.push(Work::Text("}"));
        for (i, (key, item)) in o.iter().enumerate().rev() {
          work.push(Work::Exit);
          work.push(Work::Value(item));
          work.push(Work::Enter(Segment::Key(key)));
          work.push(Work::Key(key, i == 0));
        }
      }
    }
  }
  count
}

/// A finite number as JSON text that `JSON.parse` reads back exactly (`-0` included).
fn write_json_number(n: f64, out: &mut String) {
  if n == 0.0 && n.is_sign_negative() {
    out.push_str("-0");
  } else {
    out.push_str(&num_to_js_string(n));
  }
}

/// `JSON.stringify(string)`
pub fn write_json_string(s: &str, out: &mut String) {
  out.push('"');
  let mut start = 0;
  for (i, b) in s.bytes().enumerate() {
    let escape = match b {
      b'"' => "\\\"",
      b'\\' => "\\\\",
      b'\n' => "\\n",
      b'\r' => "\\r",
      b'\t' => "\\t",
      0x08 => "\\b",
      0x0c => "\\f",
      0..=0x1f => "",
      _ => continue,
    };
    out.push_str(&s[start..i]);
    if escape.is_empty() {
      out.push_str(&format!("\\u{b:04x}"));
    } else {
      out.push_str(escape);
    }
    start = i + 1;
  }
  out.push_str(&s[start..]);
  out.push('"');
}

const MS_PER_DAY: i64 = 86_400_000;

/// `Date.prototype.toISOString`, `None` for an invalid date (where JS throws a `RangeError`).
pub fn date_to_iso_string(ms: f64) -> Option<String> {
  if !ms.is_finite() || ms.abs() > 8.64e15 {
    return None;
  }
  let ms = ms.trunc() as i64;
  let days = ms.div_euclid(MS_PER_DAY);
  let time = ms.rem_euclid(MS_PER_DAY);
  let (year, month, day) = civil_from_days(days);
  let year = if (0..=9999).contains(&year) {
    format!("{year:04}")
  } else if year < 0 {
    format!("-{:06}", -year)
  } else {
    format!("+{year:06}")
  };
  Some(format!(
    "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
    time / 3_600_000,
    time / 60_000 % 60,
    time / 1000 % 60,
    time % 1000
  ))
}

/// Parses the `Date.prototype.toISOString` format (`YYYY-MM-DDTHH:mm:ss.sssZ`, with a signed
/// six digit year outside 0..=9999) back into a time value.
pub fn parse_iso_date(s: &str) -> Option<f64> {
  let (sign, rest) = match s.as_bytes().first()? {
    b'+' => (1, &s[1..]),
    b'-' => (-1, &s[1..]),
    _ => (1, s),
  };
  let year_len = if s.len() == rest.len() { 4 } else { 6 };
  let num = |t: &str| -> Option<i64> {
    if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit()) {
      return None;
    }
    t.parse().ok()
  };
  let rest = rest.strip_suffix('Z')?;
  let (date, time) = rest.split_once('T')?;
  let mut date_parts = date.splitn(3, '-');
  let year_text = date_parts.next()?;
  if year_text.len() != year_len {
    return None;
  }
  let year = sign * num(year_text)?;
  let month = num(date_parts.next()?)?;
  let day = num(date_parts.next()?)?;
  let (hms, millis) = time.split_once('.')?;
  let mut time_parts = hms.splitn(3, ':');
  let hour = num(time_parts.next()?)?;
  let minute = num(time_parts.next()?)?;
  let second = num(time_parts.next()?)?;
  let millis = num(millis)?;
  if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 24 || minute > 59 || second > 59 {
    return None;
  }
  let ms = days_from_civil(year, month, day) * MS_PER_DAY + ((hour * 60 + minute) * 60 + second) * 1000 + millis;
  let ms = ms as f64;
  (ms.abs() <= 8.64e15).then_some(ms)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
  let y = if month <= 2 { year - 1 } else { year };
  let era = y.div_euclid(400);
  let yoe = y - era * 400;
  let mp = (month + 9) % 12;
  let doy = (153 * mp + 2) / 5 + day - 1;
  let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z - era * 146_097;
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let day = doy - (153 * mp + 2) / 5 + 1;
  let month = if mp < 10 { mp + 3 } else { mp - 9 };
  (if month <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 }, month, day)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn iso_dates_round_trip() {
    for (ms, iso) in [
      (0.0, "1970-01-01T00:00:00.000Z"),
      (-1.0, "1969-12-31T23:59:59.999Z"),
      (951_782_400_000.0, "2000-02-29T00:00:00.000Z"),
      (8.64e15, "+275760-09-13T00:00:00.000Z"),
      (-8.64e15, "-271821-04-20T00:00:00.000Z"),
      (-62_198_755_200_000.0, "-000001-01-01T00:00:00.000Z"),
      (253_402_300_800_000.0, "+010000-01-01T00:00:00.000Z"),
    ] {
      assert_eq!(date_to_iso_string(ms).as_deref(), Some(iso));
      assert_eq!(parse_iso_date(iso), Some(ms));
    }
    assert_eq!(date_to_iso_string(f64::NAN), None);
    assert_eq!(date_to_iso_string(8.64e15 + 1.0), None);
  }

  #[test]
  fn shared_and_circular_refs_keep_identity() {
    // objects[0] = collection, objects[1] = block; block.custom.owner points back to the collection
    // and is reached first (from `blocks`), which used to cut it to `undefined`
    let graph = serde_json::json!({
      "objects": [
        { "slug": "posts", "fields": [{ "type": "blocks", "blocks": [{ "$ref": 1 }] }] },
        { "slug": "hero", "custom": { "owner": { "$ref": 0 } } },
        [{ "$ref": 2 }],
      ],
      "root": { "blocks": { "hero": { "$ref": 1 } }, "collections": [{ "$ref": 0 }], "self": { "$ref": 2 } },
    });
    let root = decode_graph_typed(&graph).expect("decode");
    let block = root.path(&["blocks", "hero"]);
    let collection = root.get("collections").items().next().expect("collection");
    assert!(block.path(&["custom", "owner"]).strict_eq(collection));
    assert_eq!(block.path(&["custom", "owner", "slug"]).as_str(), Some("posts"));
    let nested_block = collection.get("fields").items().next().expect("field").get("blocks").items().next();
    assert!(nested_block.expect("block").strict_eq(block));
    assert!(root.is_circular());
    assert!(!collection.get("slug").is_circular());
    let array = root.get("self");
    assert!(array.items().next().expect("item").strict_eq(array));
    assert_eq!(array.to_js_string(), "");
    // walks stop at cycles
    assert_eq!(array.to_json(), serde_json::json!([null]));
    assert_eq!(array.try_to_json().expect_err("circular").message, "Converting circular structure to JSON");
    assert_eq!(encode_value(array), serde_json::json!([{ "$undefined": true }]));
    assert!(format!("{array:?}").contains("Circular"));
    // a `$ref` cycle without a container is invalid, not a hang
    let invalid = serde_json::json!({ "objects": [{ "$ref": 0 }], "root": { "$ref": 0 } });
    assert!(decode_graph(&invalid).is_err());
  }

  #[test]
  fn bigint_and_date_semantics() {
    let zero = JsVal::bigint("0");
    let one = JsVal::bigint("1");
    assert!(!zero.truthy());
    assert!(one.truthy());
    assert!(JsVal::date(f64::NAN).truthy());
    assert!(JsVal::obj(Obj::new()).truthy());
    assert!(one.strict_eq(&JsVal::bigint("1")));
    assert!(!one.strict_eq(&zero));
    assert!(!one.strict_eq(&JsVal::Num(1.0)));
    assert!(!JsVal::date(0.0).strict_eq(&JsVal::date(0.0)));
    assert!(!JsVal::obj(Obj::new()).strict_eq(&JsVal::obj(Obj::new())));
    assert_eq!(JsVal::bigint("-12345678901234567890").to_js_string(), "-12345678901234567890");
    assert_eq!(JsVal::arr(vec![one.clone(), JsVal::Null, JsVal::Num(2.5)]).to_js_string(), "1,,2.5");
    assert_eq!(JsVal::date(f64::NAN).to_js_string(), "Invalid Date");
    assert_eq!(one.type_of(), "bigint");
    assert_eq!(JsVal::date(0.0).type_of(), "object");
    assert!(!one.is_object_like());
    assert!(JsVal::date(0.0).is_object_like());
    assert_eq!(one.try_to_json().expect_err("bigint").name, "TypeError");
  }

  #[test]
  fn number_to_string() {
    for (n, s) in [
      (0.0, "0"),
      (-0.0, "0"),
      (1e21, "1e+21"),
      (1e20, "100000000000000000000"),
      (1e-7, "1e-7"),
      (1.5e-7, "1.5e-7"),
      (1e-6, "0.000001"),
      (123.456, "123.456"),
      (-1.5, "-1.5"),
      (2f64.powi(70), "1.1805916207174113e+21"),
      (712_807_912_106_912.2, "712807912106912.2"),
      (f64::MAX, "1.7976931348623157e+308"),
      (5e-324, "5e-324"),
    ] {
      assert_eq!(num_to_js_string(n), s, "{n:?}");
    }
  }

  #[test]
  fn typed_values_decode_and_encode() {
    let graph = serde_json::json!({
      "objects": [{ "$date": "2020-01-02T03:04:05.006Z" }],
      "root": {
        "a": { "$ref": 0 },
        "b": { "$ref": 0 },
        "big": { "$bigint": "12345678901234567890" },
        "bad": { "$date": null },
        "plain": { "$obj": { "$date": "x" } },
      },
    });
    let typed = decode_graph_typed(&graph).expect("decode");
    assert_eq!(typed.get("a").as_date(), Some(1_577_934_245_006.0));
    assert!(typed.get("a").strict_eq(typed.get("b")));
    assert!(typed.get("bad").as_date().is_some_and(f64::is_nan));
    assert_eq!(typed.get("big").typed(), Some(TypedValue::BigInt("12345678901234567890".into())));
    assert_eq!(typed.get("plain").typed(), None);
    assert_eq!(typed.get("a").to_json(), serde_json::json!("2020-01-02T03:04:05.006Z"));
    assert_eq!(typed.get("bad").to_json(), Json::Null);
    assert_eq!(encode_value(typed.get("a")), serde_json::json!({ "$date": "2020-01-02T03:04:05.006Z" }));
    assert_eq!(encode_value(typed.get("bad")), serde_json::json!({ "$date": null }));
    assert_eq!(encode_value(typed.get("big")), serde_json::json!({ "$bigint": "12345678901234567890" }));
    assert_eq!(encode_value(typed.get("plain")), serde_json::json!({ "$obj": { "$date": "x" } }));
    // a copy of a typed object is a plain empty object, like `{ ...date }`
    assert_eq!(JsVal::obj(typed.get("a").as_obj().cloned().unwrap_or_default()).typed(), None);

    let legacy = decode_graph(&graph).expect("decode");
    assert_eq!(legacy.get("a").as_str(), Some("2020-01-02T03:04:05.006Z"));
    assert!(legacy.get("bad").is_null());
    assert_eq!(legacy.get("big").as_num(), Some(12_345_678_901_234_567_890.0));
  }

  /// `write_patched` = `write_encoded` decoded: the plain JSON with every patch's tree at its path
  /// equals the tree encoding with `$obj` escapes removed and every typed value marked.
  #[test]
  fn patched_encoding_equals_the_tree_encoding() {
    let graph = serde_json::json!({
      "objects": [{ "name": "cyclic", "self": { "$ref": 0 }, "list": [1, { "$ref": 0 }] }],
      "root": {
        "docs": [
          { "id": 1, "title": "a", "missing": { "$undefined": true }, "negZero": -0.0, "big": { "$bigint": "9007199254740993" } },
          { "id": 2, "nan": { "$num": "NaN" }, "inf": { "$num": "-Infinity" }, "fn": { "$fn": 3 }, "at": { "$date": "2020-01-02T03:04:05.006Z" }, "bad": { "$date": null } },
          [{ "$undefined": true }, null, [{ "$undefined": true }]],
          { "$obj": { "$date": "not a marker" } },
          { "__proto__": { "$undefined": true }, "quote\"key": "line\nbreak" },
          {},
          [],
        ],
        "cyclic": { "$ref": 0 },
        "limit": { "$undefined": true },
      },
    });
    let value = decode_graph_typed(&graph).expect("decode");
    for v in [value.clone(), JsVal::Undefined, value.get("docs").items().nth(1).expect("doc").get("at").clone(), JsVal::Null] {
      let tree: Json = serde_json::from_str(&encode_value_text(&v)).expect("tree");
      let mut plain = String::new();
      let mut patches = String::new();
      let count = write_patched(&v, &mut plain, &mut patches);
      let mut plain: Json = serde_json::from_str(&plain).expect("plain");
      let patches: Vec<(Vec<Json>, Json)> = serde_json::from_str(&format!("[{patches}]")).expect("patches");
      assert_eq!(patches.len(), count);
      for (path, tree) in patches {
        let mut target = &mut plain;
        for segment in &path {
          target = match segment {
            Json::String(key) => target.get_mut(key.as_str()).expect("object key"),
            Json::Number(index) => target.get_mut(index.as_u64().expect("index") as usize).expect("array index"),
            _ => panic!("path segment {segment}"),
          };
        }
        assert!(target.is_null(), "a patched value is written as null");
        *target = serde_json::json!({ "special": tree });
      }
      assert_eq!(plain.to_string(), decoded_tree(&tree).to_string());
    }
  }

  /// A tree encoding as `deserializeFromEngine` reads it: `$obj` unescaped, typed values marked.
  fn decoded_tree(tree: &Json) -> Json {
    match tree {
      Json::Array(items) => Json::Array(items.iter().map(decoded_tree).collect()),
      Json::Object(o) if o.len() == 1 && o.contains_key("$obj") => {
        Json::Object(o["$obj"].as_object().expect("$obj").iter().map(|(k, v)| (k.clone(), decoded_tree(v))).collect())
      }
      Json::Object(o) if o.len() == 1 && RESERVED_KEYS.contains(&o.keys().next().expect("key").as_str()) => {
        serde_json::json!({ "special": tree })
      }
      Json::Object(o) => Json::Object(o.iter().map(|(k, v)| (k.clone(), decoded_tree(v))).collect()),
      _ => tree.clone(),
    }
  }
}
