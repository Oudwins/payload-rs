//! JS values as the interpreter sees them: plain data only (what a document, `req.user` or a
//! where object holds), immutable and shareable across threads.
//!
//! Anything the interpreter cannot model exactly (functions it did not compile, class instances,
//! `Date`s, proxies, symbols, bigints, strings with lone surrogates) is [`Value::Opaque`]: it may be
//! passed around and compared by presence, but every operation that would look inside it bails.

use std::sync::Arc;

use indexmap::IndexMap;

use crate::FnId;

/// A JS value.
#[derive(Clone, Debug)]
pub enum Value {
  Undefined,
  Null,
  Bool(bool),
  Number(f64),
  String(Arc<str>),
  Array(Arc<Vec<Value>>),
  Object(Arc<Object>),
  /// A compiled function (a helper resolved from the function's scope, or a closure literal).
  Func(Callable),
  /// A regular expression created by a literal in the compiled code.
  RegExp(Arc<RegExpValue>),
  /// The promise an async compiled function returns (resolved with the value).
  Promise(Arc<Value>),
  /// Something the interpreter does not model. Reading it, calling it or converting it bails.
  Opaque(OpaqueKind),
}

/// What is known about an opaque value: enough for truthiness, `typeof` and strict comparisons
/// against primitives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpaqueKind {
  /// An object that is not a plain object or array (a `Date`, a class instance, a proxy, ...).
  Object,
  /// A function the interpreter did not compile.
  Function,
  /// A primitive the interpreter cannot represent (a bigint, a symbol, a string with lone
  /// surrogates).
  Primitive,
}

#[derive(Clone, Debug)]
pub enum Callable {
  /// A compiled top-level or helper function, called with a fresh frame.
  Fn(FnId),
  /// An arrow function literal of the running frame (shares that frame's slots).
  Closure { frame: u64, closure: u32 },
  /// An intrinsic usable as a callback (`arr.filter(Boolean)`).
  Builtin(crate::ir::Builtin),
}

#[derive(Debug)]
pub struct RegExpValue {
  pub source: Arc<str>,
  pub flags: Arc<str>,
  pub regex: regress::Regex,
}

/// A plain object (prototype `Object.prototype` or `null`).
#[derive(Clone, Debug, Default)]
pub struct Object {
  /// Own enumerable data properties in JS order (array-index keys first, ascending).
  pub props: IndexMap<Arc<str>, Value>,
  /// `false`: a partial snapshot (e.g. `req`): only the listed properties are known, reading any
  /// other one bails instead of answering `undefined`.
  pub closed: bool,
  pub null_proto: bool,
}

impl Object {
  pub fn closed() -> Self {
    Object { props: IndexMap::new(), closed: true, null_proto: false }
  }

  /// Sets `key` with JS ordering: array-index keys stay in ascending order before the others.
  pub fn set(&mut self, key: Arc<str>, value: Value) {
    if let Some(slot) = self.props.get_mut(&key) {
      *slot = value;
      return;
    }
    if let Some(index) = array_index(&key) {
      let position = self.props.keys().position(|k| array_index(k).is_none_or(|existing| existing > index));
      match position {
        Some(at) => {
          self.props.shift_insert(at, key, value);
        }
        None => {
          self.props.insert(key, value);
        }
      }
    } else {
      self.props.insert(key, value);
    }
  }
}

/// `key` as a canonical array index (`"0"`, `"12"`, not `"01"`), the keys JS orders first.
pub fn array_index(key: &str) -> Option<u32> {
  if key.is_empty() || key.len() > 10 || (key.len() > 1 && key.starts_with('0')) {
    return None;
  }
  if !key.bytes().all(|b| b.is_ascii_digit()) {
    return None;
  }
  let n: u64 = key.parse().ok()?;
  if n < u32::MAX as u64 { Some(n as u32) } else { None }
}

impl Value {
  pub fn str(s: &str) -> Value {
    Value::String(Arc::from(s))
  }

  pub fn object(props: Vec<(&str, Value)>) -> Value {
    let mut o = Object::closed();
    for (k, v) in props {
      o.set(Arc::from(k), v);
    }
    Value::Object(Arc::new(o))
  }

  /// A partial object: only `props` are known (see [`Object::closed`]).
  pub fn partial_object(props: Vec<(&str, Value)>) -> Value {
    let mut o = Object::closed();
    o.closed = false;
    for (k, v) in props {
      o.set(Arc::from(k), v);
    }
    Value::Object(Arc::new(o))
  }

  pub fn is_nullish(&self) -> bool {
    matches!(self, Value::Undefined | Value::Null)
  }

  /// ToBoolean.
  pub fn truthy(&self) -> Result<bool, crate::Bail> {
    Ok(match self {
      Value::Undefined | Value::Null => false,
      Value::Bool(b) => *b,
      Value::Number(n) => !(*n == 0.0 || n.is_nan()),
      Value::String(s) => !s.is_empty(),
      Value::Array(_) | Value::Object(_) | Value::Func(_) | Value::RegExp(_) | Value::Promise(_) => true,
      Value::Opaque(OpaqueKind::Object | OpaqueKind::Function) => true,
      Value::Opaque(OpaqueKind::Primitive) => return Err(crate::Bail::Opaque),
    })
  }

  /// `typeof`.
  pub fn type_of(&self) -> Result<&'static str, crate::Bail> {
    Ok(match self {
      Value::Undefined => "undefined",
      Value::Null => "object",
      Value::Bool(_) => "boolean",
      Value::Number(_) => "number",
      Value::String(_) => "string",
      Value::Array(_) | Value::Object(_) | Value::RegExp(_) | Value::Promise(_) => "object",
      Value::Func(_) | Value::Opaque(OpaqueKind::Function) => "function",
      Value::Opaque(OpaqueKind::Object) => "object",
      Value::Opaque(OpaqueKind::Primitive) => return Err(crate::Bail::Opaque),
    })
  }

  /// Converts JSON (as Payload documents and `req.user` snapshots arrive in Rust) to a value.
  /// Objects are closed.
  pub fn from_json(json: &serde_json::Value) -> Value {
    match json {
      serde_json::Value::Null => Value::Null,
      serde_json::Value::Bool(b) => Value::Bool(*b),
      serde_json::Value::Number(n) => match n.as_f64() {
        Some(f) => Value::Number(f),
        None => Value::Opaque(OpaqueKind::Primitive),
      },
      serde_json::Value::String(s) => Value::String(Arc::from(s.as_str())),
      serde_json::Value::Array(items) => Value::Array(Arc::new(items.iter().map(Value::from_json).collect())),
      serde_json::Value::Object(map) => {
        let mut o = Object::closed();
        for (k, v) in map {
          o.set(Arc::from(k.as_str()), Value::from_json(v));
        }
        Value::Object(Arc::new(o))
      }
    }
  }

  /// Converts a result to JSON. `None` when it holds something JSON cannot carry exactly
  /// (`undefined` inside arrays, non-finite numbers, functions, opaque values); `undefined`
  /// object properties make it `None` too.
  pub fn to_json(&self) -> Option<serde_json::Value> {
    Some(match self {
      Value::Null => serde_json::Value::Null,
      Value::Bool(b) => serde_json::Value::Bool(*b),
      Value::Number(n) => {
        if !n.is_finite() || (*n == 0.0 && n.is_sign_negative()) {
          return None;
        }
        serde_json::from_str(&number_to_string(*n)).ok()?
      }
      Value::String(s) => serde_json::Value::String(s.to_string()),
      Value::Array(items) => serde_json::Value::Array(items.iter().map(Value::to_json).collect::<Option<_>>()?),
      Value::Object(o) => {
        let mut map = serde_json::Map::new();
        for (k, v) in &o.props {
          if matches!(v, Value::Undefined) {
            return None;
          }
          map.insert(k.to_string(), v.to_json()?);
        }
        serde_json::Value::Object(map)
      }
      Value::Undefined | Value::Func(_) | Value::RegExp(_) | Value::Promise(_) | Value::Opaque(_) => return None,
    })
  }

  /// Structural equality used by guard mode: same types, numbers by SameValue (NaN equals NaN,
  /// `0` differs from `-0`), objects with the same keys in the same order. Opaque, functions and
  /// regular expressions never compare equal (the caller treats them as unverifiable).
  pub fn same_structure(&self, other: &Value) -> bool {
    match (self, other) {
      (Value::Undefined, Value::Undefined) | (Value::Null, Value::Null) => true,
      (Value::Bool(a), Value::Bool(b)) => a == b,
      (Value::Number(a), Value::Number(b)) => {
        (a.is_nan() && b.is_nan()) || (a == b && a.is_sign_negative() == b.is_sign_negative())
      }
      (Value::String(a), Value::String(b)) => a == b,
      (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| x.same_structure(y)),
      (Value::Object(a), Value::Object(b)) => {
        a.null_proto == b.null_proto
          && a.props.len() == b.props.len()
          && a.props.iter().zip(b.props.iter()).all(|((ka, va), (kb, vb))| ka == kb && va.same_structure(vb))
      }
      _ => false,
    }
  }
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
  let mut buffer = ryu_js::Buffer::new();
  buffer.format_finite(n).to_string()
}

/// StringToNumber (`Number("…")`).
pub fn string_to_number(s: &str) -> f64 {
  let t = trim_js(s);
  if t.is_empty() {
    return 0.0;
  }
  let lower_prefix = |p: &str| t.len() > 2 && t[..2].eq_ignore_ascii_case(p);
  for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
    if lower_prefix(prefix) {
      let digits = &t[2..];
      if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
        return f64::NAN;
      }
      let mut value = 0f64;
      for c in digits.chars() {
        value = value * radix as f64 + c.to_digit(radix).unwrap() as f64;
      }
      return value;
    }
  }
  let (sign, rest) = match t.as_bytes()[0] {
    b'+' => (1.0, &t[1..]),
    b'-' => (-1.0, &t[1..]),
    _ => (1.0, t),
  };
  if rest == "Infinity" {
    return sign * f64::INFINITY;
  }
  if !is_str_unsigned_decimal_literal(rest) {
    return f64::NAN;
  }
  rest.parse::<f64>().map(|v| sign * v).unwrap_or(f64::NAN)
}

/// StrUnsignedDecimalLiteral without `Infinity`: `1`, `1.`, `.5`, `1.5e-3`.
fn is_str_unsigned_decimal_literal(s: &str) -> bool {
  let b = s.as_bytes();
  let mut i = 0;
  let int_start = i;
  while i < b.len() && b[i].is_ascii_digit() {
    i += 1;
  }
  let int_digits = i - int_start;
  let mut frac_digits = 0;
  if i < b.len() && b[i] == b'.' {
    i += 1;
    let s = i;
    while i < b.len() && b[i].is_ascii_digit() {
      i += 1;
    }
    frac_digits = i - s;
  }
  if int_digits == 0 && frac_digits == 0 {
    return false;
  }
  if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
    i += 1;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
      i += 1;
    }
    let s = i;
    while i < b.len() && b[i].is_ascii_digit() {
      i += 1;
    }
    if i == s {
      return false;
    }
  }
  i == b.len()
}

/// JS WhiteSpace and LineTerminator code points (what `String.prototype.trim` removes).
pub fn is_js_whitespace(c: char) -> bool {
  matches!(
    c,
    '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
      ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
  )
}

pub fn trim_js(s: &str) -> &str {
  s.trim_matches(is_js_whitespace)
}

/// Length in UTF-16 code units.
pub fn utf16_len(s: &str) -> usize {
  if s.is_ascii() { s.len() } else { s.encode_utf16().count() }
}
