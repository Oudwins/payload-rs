//! JS semantics of property reads, operators, conversions and the intrinsic methods the
//! interpreter implements. Strings are UTF-8 in Rust; every index, length and comparison follows
//! JS's UTF-16 code units.

use std::sync::Arc;

use crate::interp::{Interp, builtin_of, call_callback, index_key};
use crate::ir::{BinaryOp, Builtin};
use crate::value::{Object, OpaqueKind, RegExpValue, Value, number_to_string, string_to_number, trim_js, utf16_len};
use crate::{Bail, value};

type R<T> = Result<T, Bail>;

/// `Object.prototype`'s properties: reading a missing key that is one of these reaches the
/// prototype, which the interpreter does not model.
const OBJECT_PROTOTYPE: &[&str] = &[
  "constructor",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
];

fn s(v: &str) -> Value {
  Value::String(Arc::from(v))
}

/// `o[key]`.
pub fn get(o: &Value, key: &str) -> R<Value> {
  match o {
    Value::Undefined | Value::Null => Err(Bail::Throw),
    Value::Object(obj) => match obj.props.get(key) {
      Some(v) => Ok(v.clone()),
      None if !obj.closed => Err(Bail::Unknown),
      None if !obj.null_proto && OBJECT_PROTOTYPE.contains(&key) => Err(Bail::Unsupported("prototype property")),
      None => Ok(Value::Undefined),
    },
    Value::Array(a) => {
      if key == "length" {
        return Ok(Value::Number(a.len() as f64));
      }
      match index_key(key) {
        Some(i) => Ok(a.get(i).cloned().unwrap_or(Value::Undefined)),
        None => Err(Bail::Unsupported("array property")),
      }
    }
    Value::String(st) => {
      if key == "length" {
        return Ok(Value::Number(utf16_len(st) as f64));
      }
      match index_key(key) {
        Some(i) => char_at(st, i as f64).map(|c| c.unwrap_or(Value::Undefined)),
        None => Err(Bail::Unsupported("string property")),
      }
    }
    Value::Promise(_) | Value::Func(_) | Value::RegExp(_) | Value::Number(_) | Value::Bool(_) => {
      Err(Bail::Unsupported("property of a non-plain value"))
    }
    Value::Opaque(_) => Err(Bail::Opaque),
  }
}

/// Whether `receiver.name` is a callable the interpreter would call (for `receiver.name?.()`).
pub fn has_method(receiver: &Value, name: &str) -> R<bool> {
  match receiver {
    Value::Object(o) => match o.props.get(name) {
      Some(v) => Ok(!v.is_nullish()),
      None if !o.closed => Err(Bail::Unknown),
      None => Ok(OBJECT_PROTOTYPE.contains(&name) && !o.null_proto),
    },
    _ => Err(Bail::Unsupported("optional method call")),
  }
}

/// ToPropertyKey.
pub fn to_property_key(v: &Value) -> R<Arc<str>> {
  match v {
    Value::String(st) => Ok(st.clone()),
    Value::Number(_) | Value::Bool(_) | Value::Undefined | Value::Null => Ok(Arc::from(to_string(v)?.as_str())),
    _ => Err(Bail::Unsupported("object as property key")),
  }
}

/// ToString.
pub fn to_string(v: &Value) -> R<String> {
  Ok(match v {
    Value::Undefined => "undefined".into(),
    Value::Null => "null".into(),
    Value::Bool(b) => b.to_string(),
    Value::Number(n) => number_to_string(*n),
    Value::String(st) => st.to_string(),
    Value::Array(a) => join(a, ",")?,
    Value::Object(o) => {
      if !o.closed || o.null_proto || o.props.contains_key("toString") || o.props.contains_key("valueOf") {
        return Err(Bail::Unsupported("object to string"));
      }
      "[object Object]".into()
    }
    _ => return Err(Bail::Unsupported("to string")),
  })
}

fn join(a: &[Value], sep: &str) -> R<String> {
  let mut out = String::new();
  for (i, v) in a.iter().enumerate() {
    if i > 0 {
      out.push_str(sep);
    }
    if !v.is_nullish() {
      out.push_str(&to_string(v)?);
    }
  }
  Ok(out)
}

/// ToNumber.
pub fn to_number(v: &Value) -> R<f64> {
  Ok(match v {
    Value::Undefined => f64::NAN,
    Value::Null => 0.0,
    Value::Bool(b) => *b as u8 as f64,
    Value::Number(n) => *n,
    Value::String(st) => string_to_number(st),
    Value::Array(_) | Value::Object(_) => string_to_number(&to_string(v)?),
    _ => return Err(Bail::Unsupported("to number")),
  })
}

/// IsStrictlyEqual.
pub fn strict_equals(a: &Value, b: &Value) -> R<bool> {
  Ok(match (a, b) {
    (Value::Undefined, Value::Undefined) | (Value::Null, Value::Null) => true,
    (Value::Bool(x), Value::Bool(y)) => x == y,
    (Value::Number(x), Value::Number(y)) => x == y,
    (Value::String(x), Value::String(y)) => x == y,
    (Value::Array(x), Value::Array(y)) => {
      if Arc::ptr_eq(x, y) {
        true
      } else {
        // Two snapshots of one JS array are different Rust values: identity is unknown.
        return Err(Bail::Unsupported("object identity"));
      }
    }
    (Value::Object(x), Value::Object(y)) => {
      if Arc::ptr_eq(x, y) {
        true
      } else {
        return Err(Bail::Unsupported("object identity"));
      }
    }
    (Value::Func(crate::value::Callable::Fn(x)), Value::Func(crate::value::Callable::Fn(y))) => x == y,
    (Value::Func(crate::value::Callable::Builtin(x)), Value::Func(crate::value::Callable::Builtin(y))) => x == y,
    (Value::Opaque(OpaqueKind::Primitive), _) | (_, Value::Opaque(OpaqueKind::Primitive)) => return Err(Bail::Opaque),
    (Value::Opaque(_), Value::Opaque(_)) => return Err(Bail::Opaque),
    (Value::Opaque(_) | Value::Func(_) | Value::Promise(_) | Value::RegExp(_), _)
    | (_, Value::Opaque(_) | Value::Func(_) | Value::Promise(_) | Value::RegExp(_)) => {
      if is_object_like(a) && is_object_like(b) {
        return Err(Bail::Unsupported("object identity"));
      }
      false
    }
    _ => false,
  })
}

fn is_object_like(v: &Value) -> bool {
  matches!(
    v,
    Value::Array(_)
      | Value::Object(_)
      | Value::Func(_)
      | Value::Promise(_)
      | Value::RegExp(_)
      | Value::Opaque(OpaqueKind::Object | OpaqueKind::Function)
  )
}

fn is_primitive(v: &Value) -> bool {
  matches!(v, Value::Undefined | Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_))
}

/// IsLooselyEqual.
pub fn loose_equals(a: &Value, b: &Value) -> R<bool> {
  if a.is_nullish() || b.is_nullish() {
    if matches!(a, Value::Opaque(OpaqueKind::Primitive)) || matches!(b, Value::Opaque(OpaqueKind::Primitive)) {
      return Err(Bail::Opaque);
    }
    // Objects are never loosely equal to null / undefined (no `document.all` here).
    return Ok(a.is_nullish() && b.is_nullish());
  }
  match (a, b) {
    (Value::Number(_), Value::String(_)) | (Value::String(_), Value::Number(_)) => {
      Ok(to_number(a)? == to_number(b)?)
    }
    (Value::Bool(_), _) => loose_equals(&Value::Number(to_number(a)?), b),
    (_, Value::Bool(_)) => loose_equals(a, &Value::Number(to_number(b)?)),
    _ if is_primitive(a) && is_primitive(b) => strict_equals(a, b),
    _ if is_object_like(a) && is_object_like(b) => strict_equals(a, b),
    _ => Err(Bail::Unsupported("loose equality with an object")),
  }
}

fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
  if a.is_ascii() && b.is_ascii() {
    return a.cmp(b);
  }
  a.encode_utf16().cmp(b.encode_utf16())
}

/// IsLessThan; `None` is undefined (a NaN operand).
fn less_than(a: &Value, b: &Value) -> R<Option<bool>> {
  if let (Value::String(x), Value::String(y)) = (a, b) {
    return Ok(Some(utf16_cmp(x, y) == std::cmp::Ordering::Less));
  }
  if !is_primitive(a) || !is_primitive(b) {
    return Err(Bail::Unsupported("relational comparison of an object"));
  }
  let (x, y) = (to_number(a)?, to_number(b)?);
  if x.is_nan() || y.is_nan() {
    return Ok(None);
  }
  Ok(Some(x < y))
}

pub fn binary(op: BinaryOp, l: &Value, r: &Value) -> R<Value> {
  Ok(match op {
    BinaryOp::StrictEq => Value::Bool(strict_equals(l, r)?),
    BinaryOp::StrictNe => Value::Bool(!strict_equals(l, r)?),
    BinaryOp::LooseEq => Value::Bool(loose_equals(l, r)?),
    BinaryOp::LooseNe => Value::Bool(!loose_equals(l, r)?),
    BinaryOp::Lt => Value::Bool(less_than(l, r)? == Some(true)),
    BinaryOp::Gt => Value::Bool(less_than(r, l)? == Some(true)),
    BinaryOp::Le => Value::Bool(less_than(r, l)? == Some(false)),
    BinaryOp::Ge => Value::Bool(less_than(l, r)? == Some(false)),
    BinaryOp::Add => {
      if !is_primitive(l) || !is_primitive(r) {
        // ToPrimitive of arrays / plain objects is their ToString.
        if matches!(l, Value::Array(_) | Value::Object(_)) || matches!(r, Value::Array(_) | Value::Object(_)) {
          let (ls, rs) = (prim_for_add(l)?, prim_for_add(r)?);
          return binary(BinaryOp::Add, &ls, &rs);
        }
        return Err(Bail::Unsupported("+ of a non-plain value"));
      }
      if matches!(l, Value::String(_)) || matches!(r, Value::String(_)) {
        let mut out = to_string(l)?;
        out.push_str(&to_string(r)?);
        s(&out)
      } else {
        Value::Number(to_number(l)? + to_number(r)?)
      }
    }
    BinaryOp::Sub => Value::Number(num(l)? - num(r)?),
    BinaryOp::Mul => Value::Number(num(l)? * num(r)?),
    BinaryOp::Div => Value::Number(num(l)? / num(r)?),
    BinaryOp::Rem => Value::Number(num(l)? % num(r)?),
    BinaryOp::In => {
      let key = to_property_key(l)?;
      Value::Bool(match r {
        Value::Object(o) => match o.props.contains_key(&key) {
          true => true,
          false if !o.closed => return Err(Bail::Unknown),
          false => !o.null_proto && OBJECT_PROTOTYPE.contains(&&*key),
        },
        Value::Array(a) => match index_key(&key) {
          Some(i) => i < a.len(),
          None if &*key == "length" => true,
          None => return Err(Bail::Unsupported("in on an array")),
        },
        Value::Opaque(_) => return Err(Bail::Opaque),
        _ if is_primitive(r) => return Err(Bail::Throw),
        _ => return Err(Bail::Unsupported("in")),
      })
    }
  })
}

fn prim_for_add(v: &Value) -> R<Value> {
  Ok(match v {
    Value::Array(_) | Value::Object(_) => s(&to_string(v)?),
    other if is_primitive(other) => other.clone(),
    _ => return Err(Bail::Unsupported("+ of a non-plain value")),
  })
}

/// ToNumber for the arithmetic operators (objects go through ToPrimitive = ToString here).
fn num(v: &Value) -> R<f64> {
  to_number(v)
}

pub fn spread_into_object(o: &mut Object, v: &Value) -> R<()> {
  match v {
    Value::Undefined | Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
    Value::Object(src) => {
      if !src.closed {
        return Err(Bail::Unknown);
      }
      for (k, v) in &src.props {
        o.set(k.clone(), v.clone());
      }
      Ok(())
    }
    Value::Array(a) => {
      for (i, v) in a.iter().enumerate() {
        o.set(Arc::from(i.to_string().as_str()), v.clone());
      }
      Ok(())
    }
    Value::String(st) if st.is_ascii() => {
      for (i, c) in st.chars().enumerate() {
        o.set(Arc::from(i.to_string().as_str()), s(&c.to_string()));
      }
      Ok(())
    }
    _ => Err(Bail::Unsupported("spread of a non-plain value")),
  }
}

pub fn spread_into_list(out: &mut Vec<Value>, v: &Value) -> R<()> {
  match v {
    Value::Array(a) => {
      out.extend(a.iter().cloned());
      Ok(())
    }
    Value::String(st) => {
      for c in st.chars() {
        out.push(s(&c.to_string()));
      }
      Ok(())
    }
    Value::Undefined | Value::Null | Value::Bool(_) | Value::Number(_) => Err(Bail::Throw),
    _ => Err(Bail::Unsupported("spread of a non-array")),
  }
}

pub fn regexp(source: &str, flags: &str) -> R<Value> {
  let regex = regress::Regex::with_flags(source, flags).map_err(|_| Bail::Unsupported("regexp"))?;
  Ok(Value::RegExp(Arc::new(RegExpValue { source: Arc::from(source), flags: Arc::from(flags), regex })))
}

fn arg(args: &[Value], i: usize) -> Value {
  args.get(i).cloned().unwrap_or(Value::Undefined)
}

pub fn call_builtin(b: Builtin, args: &[Value]) -> R<Value> {
  let a0 = arg(args, 0);
  Ok(match b {
    Builtin::Boolean => Value::Bool(a0.truthy()?),
    Builtin::String => {
      if args.is_empty() {
        s("")
      } else {
        s(&to_string(&a0)?)
      }
    }
    Builtin::Number => {
      if args.is_empty() {
        Value::Number(0.0)
      } else {
        Value::Number(to_number(&a0)?)
      }
    }
    Builtin::ArrayIsArray => match a0 {
      Value::Array(_) => Value::Bool(true),
      Value::Opaque(OpaqueKind::Object) => return Err(Bail::Opaque),
      _ => Value::Bool(false),
    },
    Builtin::ObjectKeys | Builtin::ObjectValues | Builtin::ObjectEntries => {
      let entries = own_entries(&a0)?;
      Value::Array(Arc::new(
        entries
          .into_iter()
          .map(|(k, v)| match b {
            Builtin::ObjectKeys => Value::String(k),
            Builtin::ObjectValues => v,
            _ => Value::Array(Arc::new(vec![Value::String(k), v])),
          })
          .collect(),
      ))
    }
    Builtin::ObjectHasOwn => {
      let key = to_property_key(&arg(args, 1))?;
      match &a0 {
        Value::Object(o) => match o.props.contains_key(&key) {
          true => Value::Bool(true),
          false if !o.closed => return Err(Bail::Unknown),
          false => Value::Bool(false),
        },
        Value::Array(a) => Value::Bool(index_key(&key).is_some_and(|i| i < a.len()) || &*key == "length"),
        Value::Undefined | Value::Null => return Err(Bail::Throw),
        _ => return Err(Bail::Unsupported("hasOwn")),
      }
    }
    Builtin::ObjectFreeze => a0,
    Builtin::MathMax | Builtin::MathMin => {
      let is_max = b == Builtin::MathMax;
      let mut acc = if is_max { f64::NEG_INFINITY } else { f64::INFINITY };
      let mut nan = false;
      for a in args {
        let n = to_number(a)?;
        if n.is_nan() {
          nan = true;
          continue;
        }
        let better = if is_max {
          n > acc || (n == 0.0 && acc == 0.0 && !n.is_sign_negative())
        } else {
          n < acc || (n == 0.0 && acc == 0.0 && n.is_sign_negative())
        };
        if better {
          acc = n;
        }
      }
      Value::Number(if nan { f64::NAN } else { acc })
    }
    Builtin::MathFloor => Value::Number(to_number(&a0)?.floor()),
    Builtin::MathCeil => Value::Number(to_number(&a0)?.ceil()),
    Builtin::MathAbs => Value::Number(to_number(&a0)?.abs()),
    Builtin::MathRound => {
      let x = to_number(&a0)?;
      if !x.is_finite() || x == 0.0 {
        return Ok(Value::Number(x));
      }
      let f = x.floor();
      let r = if x - f >= 0.5 { f + 1.0 } else { f };
      Value::Number(if r == 0.0 && x < 0.0 { -0.0 } else { r })
    }
    Builtin::NumberIsInteger => Value::Bool(matches!(a0, Value::Number(n) if n.is_finite() && n.trunc() == n)),
    Builtin::NumberIsFinite => Value::Bool(matches!(a0, Value::Number(n) if n.is_finite())),
    Builtin::NumberIsNaN => Value::Bool(matches!(a0, Value::Number(n) if n.is_nan())),
    Builtin::IsNaN => Value::Bool(to_number(&a0)?.is_nan()),
  })
}

fn own_entries(v: &Value) -> R<Vec<(Arc<str>, Value)>> {
  match v {
    Value::Object(o) => {
      if !o.closed {
        return Err(Bail::Unknown);
      }
      Ok(o.props.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
    }
    Value::Array(a) => Ok(a.iter().enumerate().map(|(i, v)| (Arc::from(i.to_string().as_str()), v.clone())).collect()),
    Value::String(st) if st.is_ascii() => {
      Ok(st.chars().enumerate().map(|(i, c)| (Arc::from(i.to_string().as_str()), s(&c.to_string()))).collect())
    }
    Value::Bool(_) | Value::Number(_) => Ok(vec![]),
    Value::Undefined | Value::Null => Err(Bail::Throw),
    _ => Err(Bail::Unsupported("own keys of a non-plain value")),
  }
}

/// ToIntegerOrInfinity.
fn to_integer(v: &Value) -> R<f64> {
  let n = to_number(v)?;
  Ok(if n.is_nan() { 0.0 } else { n.trunc() })
}

/// A relative index (`slice`'s start / end) clamped to `0..=len`.
fn relative_index(v: &Value, len: usize, default: usize) -> R<usize> {
  if matches!(v, Value::Undefined) {
    return Ok(default);
  }
  let n = to_integer(v)?;
  let len_f = len as f64;
  Ok(if n < 0.0 { (len_f + n).max(0.0) as usize } else { n.min(len_f) as usize })
}

fn clamp_index(v: &Value, len: usize, default: usize) -> R<usize> {
  if matches!(v, Value::Undefined) {
    return Ok(default);
  }
  let n = to_integer(v)?;
  Ok(n.max(0.0).min(len as f64) as usize)
}

/// The string from UTF-16 code units; a lone surrogate bails.
fn from_units(units: &[u16]) -> R<Value> {
  String::from_utf16(units).map(|st| s(&st)).map_err(|_| Bail::Unsupported("lone surrogate"))
}

fn char_at(st: &str, pos: f64) -> R<Option<Value>> {
  if pos < 0.0 || pos.is_nan() {
    return Ok(None);
  }
  let i = pos as usize;
  if st.is_ascii() {
    return Ok(st.get(i..i + 1).map(s));
  }
  let units: Vec<u16> = st.encode_utf16().collect();
  match units.get(i) {
    Some(u) => from_units(&[*u]).map(Some),
    None => Ok(None),
  }
}

fn search_string(v: &Value) -> R<String> {
  match v {
    Value::RegExp(_) => Err(Bail::Throw),
    other => to_string(other),
  }
}

/// `(utf16 index of needle in hay at or after from)`.
fn index_of(hay: &str, needle: &str, from: usize) -> Option<usize> {
  if hay.is_ascii() && needle.is_ascii() {
    if from > hay.len() {
      return if needle.is_empty() { Some(hay.len()) } else { None };
    }
    return hay[from..].find(needle).map(|i| i + from);
  }
  let h: Vec<u16> = hay.encode_utf16().collect();
  let n: Vec<u16> = needle.encode_utf16().collect();
  let from = from.min(h.len());
  if n.is_empty() {
    return Some(from);
  }
  (from..=h.len().saturating_sub(n.len())).find(|&i| h.len() >= n.len() && h[i..i + n.len()] == n[..])
}

pub(crate) fn method(interp: &mut Interp, receiver: &Value, name: &str, args: &[Value]) -> R<Value> {
  match receiver {
    Value::Array(a) => array_method(interp, a, name, args),
    Value::String(st) => string_method(interp, st, name, args),
    Value::Number(n) => match name {
      "toString" if args.is_empty() || matches!(arg(args, 0), Value::Number(r) if r == 10.0) || matches!(arg(args, 0), Value::Undefined) => {
        Ok(s(&number_to_string(*n)))
      }
      _ => Err(Bail::Unsupported("number method")),
    },
    Value::RegExp(re) => match name {
      "test" => {
        if re.flags.contains('g') || re.flags.contains('y') {
          // `lastIndex` state: a literal is a fresh object per evaluation, so its first `test`
          // starts at 0; only that is modelled.
          return Err(Bail::Unsupported("global regexp test"));
        }
        let st = to_string(&arg(args, 0))?;
        Ok(Value::Bool(regex_find(re, &st, 0)?.is_some()))
      }
      _ => Err(Bail::Unsupported("regexp method")),
    },
    Value::Object(o) => match name {
      "hasOwnProperty" if !o.null_proto => {
        let key = to_property_key(&arg(args, 0))?;
        match o.props.contains_key(&key) {
          true => Ok(Value::Bool(true)),
          false if !o.closed => Err(Bail::Unknown),
          false => Ok(Value::Bool(false)),
        }
      }
      _ if !o.closed => Err(Bail::Unknown),
      _ if OBJECT_PROTOTYPE.contains(&name) && !o.null_proto => Err(Bail::Unsupported("Object.prototype method")),
      // Calling `undefined`.
      _ => Err(Bail::Throw),
    },
    Value::Undefined | Value::Null => Err(Bail::Throw),
    Value::Opaque(_) => Err(Bail::Opaque),
    _ => Err(Bail::Unsupported("method of a non-plain value")),
  }
}

fn callback_arg(args: &[Value]) -> R<Value> {
  let cb = arg(args, 0);
  match &cb {
    Value::Func(_) => Ok(cb),
    Value::Opaque(_) => Err(Bail::Opaque),
    // `TypeError: x is not a function`.
    _ => Err(Bail::Throw),
  }
}

fn array_method(interp: &mut Interp, a: &Arc<Vec<Value>>, name: &str, args: &[Value]) -> R<Value> {
  let array = Value::Array(a.clone());
  let len = a.len();
  match name {
    "some" | "every" | "find" | "findIndex" | "filter" | "map" => {
      let cb = callback_arg(args)?;
      if args.len() > 1 {
        return Err(Bail::Unsupported("thisArg"));
      }
      let mut mapped = vec![];
      for (i, el) in a.iter().enumerate() {
        let r = if let Some(b) = builtin_of(&cb) {
          call_builtin(b, &[el.clone(), Value::Number(i as f64), array.clone()])?
        } else {
          call_callback(interp, &cb, &[el.clone(), Value::Number(i as f64), array.clone()])?
        };
        match name {
          "some" if r.truthy()? => return Ok(Value::Bool(true)),
          "every" if !r.truthy()? => return Ok(Value::Bool(false)),
          "find" if r.truthy()? => return Ok(el.clone()),
          "findIndex" if r.truthy()? => return Ok(Value::Number(i as f64)),
          "filter" if r.truthy()? => mapped.push(el.clone()),
          "map" => mapped.push(r),
          _ => {}
        }
      }
      Ok(match name {
        "some" => Value::Bool(false),
        "every" => Value::Bool(true),
        "find" => Value::Undefined,
        "findIndex" => Value::Number(-1.0),
        _ => Value::Array(Arc::new(mapped)),
      })
    }
    "includes" | "indexOf" => {
      let needle = arg(args, 0);
      let from = relative_index(&arg(args, 1), len, 0)?;
      for (i, el) in a.iter().enumerate().skip(from) {
        let eq = if name == "includes" { same_value_zero(el, &needle)? } else { strict_equals(el, &needle)? };
        if eq {
          return Ok(if name == "includes" { Value::Bool(true) } else { Value::Number(i as f64) });
        }
      }
      Ok(if name == "includes" { Value::Bool(false) } else { Value::Number(-1.0) })
    }
    "join" => {
      let sep = match arg(args, 0) {
        Value::Undefined => ",".to_string(),
        other => to_string(&other)?,
      };
      Ok(s(&join(a, &sep)?))
    }
    "slice" => {
      let start = relative_index(&arg(args, 0), len, 0)?;
      let end = relative_index(&arg(args, 1), len, len)?;
      Ok(Value::Array(Arc::new(if start < end { a[start..end].to_vec() } else { vec![] })))
    }
    "at" => {
      let n = to_integer(&arg(args, 0))?;
      let i = if n < 0.0 { len as f64 + n } else { n };
      Ok(if i < 0.0 || i >= len as f64 { Value::Undefined } else { a[i as usize].clone() })
    }
    "concat" => {
      let mut out = a.to_vec();
      for v in args {
        match v {
          Value::Array(b) => out.extend(b.iter().cloned()),
          Value::Opaque(_) => return Err(Bail::Opaque),
          other => out.push(other.clone()),
        }
      }
      Ok(Value::Array(Arc::new(out)))
    }
    "flat" => {
      if !matches!(arg(args, 0), Value::Undefined) && !matches!(arg(args, 0), Value::Number(n) if n == 1.0) {
        return Err(Bail::Unsupported("flat depth"));
      }
      let mut out = vec![];
      for v in a.iter() {
        match v {
          Value::Array(b) => out.extend(b.iter().cloned()),
          Value::Opaque(OpaqueKind::Object) => return Err(Bail::Opaque),
          other => out.push(other.clone()),
        }
      }
      Ok(Value::Array(Arc::new(out)))
    }
    _ => Err(Bail::Unsupported("array method")),
  }
}

fn same_value_zero(a: &Value, b: &Value) -> R<bool> {
  if let (Value::Number(x), Value::Number(y)) = (a, b)
    && x.is_nan()
    && y.is_nan()
  {
    return Ok(true);
  }
  strict_equals(a, b)
}

fn ascii_only(st: &str) -> R<()> {
  if st.is_ascii() { Ok(()) } else { Err(Bail::Unsupported("non-ASCII case mapping")) }
}

fn string_method(interp: &mut Interp, st: &Arc<str>, name: &str, args: &[Value]) -> R<Value> {
  let len = utf16_len(st);
  match name {
    "trim" => Ok(s(trim_js(st))),
    "trimStart" => Ok(s(st.trim_start_matches(value::is_js_whitespace))),
    "trimEnd" => Ok(s(st.trim_end_matches(value::is_js_whitespace))),
    "toLowerCase" => {
      ascii_only(st)?;
      Ok(s(&st.to_ascii_lowercase()))
    }
    "toUpperCase" => {
      ascii_only(st)?;
      Ok(s(&st.to_ascii_uppercase()))
    }
    "toString" => Ok(Value::String(st.clone())),
    "slice" | "substring" => {
      let (start, end) = if name == "slice" {
        (relative_index(&arg(args, 0), len, 0)?, relative_index(&arg(args, 1), len, len)?)
      } else {
        let a = clamp_index(&arg(args, 0), len, 0)?;
        let b = clamp_index(&arg(args, 1), len, len)?;
        (a.min(b), a.max(b))
      };
      if start >= end {
        return Ok(s(""));
      }
      if st.is_ascii() {
        return Ok(s(&st[start..end]));
      }
      let units: Vec<u16> = st.encode_utf16().collect();
      from_units(&units[start..end])
    }
    "charAt" => {
      let pos = to_integer(&arg(args, 0))?;
      Ok(char_at(st, pos)?.unwrap_or_else(|| s("")))
    }
    "at" => {
      let n = to_integer(&arg(args, 0))?;
      let i = if n < 0.0 { len as f64 + n } else { n };
      if i < 0.0 || i >= len as f64 {
        return Ok(Value::Undefined);
      }
      Ok(char_at(st, i)?.unwrap_or(Value::Undefined))
    }
    "startsWith" | "endsWith" | "includes" | "indexOf" => {
      let needle = search_string(&arg(args, 0))?;
      let pos = arg(args, 1);
      match name {
        "startsWith" => {
          let start = clamp_index(&pos, len, 0)?;
          Ok(Value::Bool(index_of(st, &needle, start) == Some(start)))
        }
        "endsWith" => {
          let end = clamp_index(&pos, len, len)?;
          let n = utf16_len(&needle);
          if n > end {
            return Ok(Value::Bool(false));
          }
          let units: Vec<u16> = st.encode_utf16().collect();
          let needle_units: Vec<u16> = needle.encode_utf16().collect();
          Ok(Value::Bool(units[end - n..end] == needle_units[..]))
        }
        "includes" => {
          let start = clamp_index(&pos, len, 0)?;
          Ok(Value::Bool(index_of(st, &needle, start).is_some()))
        }
        _ => {
          let start = clamp_index(&pos, len, 0)?;
          Ok(Value::Number(index_of(st, &needle, start).map(|i| i as f64).unwrap_or(-1.0)))
        }
      }
    }
    "replace" | "replaceAll" => replace(interp, st, name == "replaceAll", args),
    "split" => {
      let sep = arg(args, 0);
      if !matches!(arg(args, 1), Value::Undefined) {
        return Err(Bail::Unsupported("split limit"));
      }
      match sep {
        Value::Undefined => Ok(Value::Array(Arc::new(vec![Value::String(st.clone())]))),
        Value::RegExp(_) => Err(Bail::Unsupported("split by regexp")),
        other => {
          let sep = to_string(&other)?;
          if sep.is_empty() {
            ascii_only(st)?;
            return Ok(Value::Array(Arc::new(st.chars().map(|c| s(&c.to_string())).collect())));
          }
          Ok(Value::Array(Arc::new(st.split(sep.as_str()).map(s).collect())))
        }
      }
    }
    "padStart" | "padEnd" => {
      let target = to_integer(&arg(args, 0))?;
      let fill = match arg(args, 1) {
        Value::Undefined => " ".to_string(),
        other => to_string(&other)?,
      };
      ascii_only(st)?;
      ascii_only(&fill)?;
      let target = if target.is_finite() { target.max(0.0) as usize } else { return Err(Bail::Limit) };
      if target <= st.len() || fill.is_empty() {
        return Ok(Value::String(st.clone()));
      }
      if target > 1 << 20 {
        return Err(Bail::Limit);
      }
      let pad: String = fill.chars().cycle().take(target - st.len()).collect();
      Ok(s(&if name == "padStart" { format!("{pad}{st}") } else { format!("{st}{pad}") }))
    }
    "concat" => {
      let mut out = st.to_string();
      for a in args {
        out.push_str(&to_string(a)?);
      }
      Ok(s(&out))
    }
    "repeat" => {
      let n = to_integer(&arg(args, 0))?;
      if n < 0.0 || n.is_infinite() {
        return Err(Bail::Throw);
      }
      if n * st.len() as f64 > (1 << 20) as f64 {
        return Err(Bail::Limit);
      }
      Ok(s(&st.repeat(n as usize)))
    }
    _ => Err(Bail::Unsupported("string method")),
  }
}

/// A match as UTF-16 ranges: the whole match and the capture groups.
struct Found {
  start: usize,
  end: usize,
  groups: Vec<Option<(usize, usize)>>,
}

fn regex_find(re: &RegExpValue, st: &str, from: usize) -> R<Option<Found>> {
  let units: Vec<u16> = st.encode_utf16().collect();
  regex_find_units(re, &units, from)
}

fn regex_find_units(re: &RegExpValue, units: &[u16], from: usize) -> R<Option<Found>> {
  if from > units.len() {
    return Ok(None);
  }
  let unicode = re.flags.contains('u') || re.flags.contains('v');
  let m = if unicode {
    re.regex.find_from_utf16(units, from).next()
  } else {
    re.regex.find_from_ucs2(units, from).next()
  };
  Ok(m.map(|m| Found {
    start: m.range().start,
    end: m.range().end,
    groups: (1..m.captures.len() + 1).map(|i| m.group(i).map(|r| (r.start, r.end))).collect(),
  }))
}

fn replace(interp: &mut Interp, st: &Arc<str>, all: bool, args: &[Value]) -> R<Value> {
  let pattern = arg(args, 0);
  let replacement = arg(args, 1);
  let units: Vec<u16> = st.encode_utf16().collect();
  let mut matches = vec![];
  match &pattern {
    Value::RegExp(re) => {
      let global = re.flags.contains('g');
      if all && !global {
        return Err(Bail::Throw);
      }
      if re.flags.contains('y') {
        return Err(Bail::Unsupported("sticky regexp"));
      }
      let mut from = 0;
      while let Some(f) = regex_find_units(re, &units, from)? {
        from = if f.end == f.start { f.end + 1 } else { f.end };
        matches.push(f);
        if !global || from > units.len() {
          break;
        }
      }
    }
    Value::Opaque(_) => return Err(Bail::Opaque),
    other => {
      let needle: Vec<u16> = to_string(other)?.encode_utf16().collect();
      let mut from = 0;
      loop {
        let found = if needle.is_empty() {
          if from <= units.len() { Some(from) } else { None }
        } else {
          (from..=units.len().saturating_sub(needle.len()))
            .find(|&i| units.len() >= needle.len() && units[i..i + needle.len()] == needle[..])
        };
        let Some(i) = found else { break };
        matches.push(Found { start: i, end: i + needle.len(), groups: vec![] });
        if !all {
          break;
        }
        from = if needle.is_empty() { i + 1 } else { i + needle.len() };
      }
    }
  }
  let mut out: Vec<u16> = vec![];
  let mut last = 0;
  for m in &matches {
    out.extend_from_slice(&units[last..m.start]);
    match &replacement {
      Value::Func(_) => {
        let mut cb_args = vec![from_units(&units[m.start..m.end])?];
        for g in &m.groups {
          cb_args.push(match g {
            Some((a, b)) => from_units(&units[*a..*b])?,
            None => Value::Undefined,
          });
        }
        cb_args.push(Value::Number(m.start as f64));
        cb_args.push(Value::String(st.clone()));
        let r = call_callback(interp, &replacement, &cb_args)?;
        out.extend(to_string(&r)?.encode_utf16());
      }
      Value::Opaque(_) => return Err(Bail::Opaque),
      other => {
        let template: Vec<u16> = to_string(other)?.encode_utf16().collect();
        substitute(&mut out, &template, &units, m);
      }
    }
    last = m.end;
  }
  out.extend_from_slice(&units[last..]);
  from_units(&out)
}

/// GetSubstitution (without named groups: `$<` is copied literally, like JS without groups).
fn substitute(out: &mut Vec<u16>, template: &[u16], units: &[u16], m: &Found) {
  let dollar = b'$' as u16;
  let mut i = 0;
  while i < template.len() {
    let c = template[i];
    if c != dollar || i + 1 >= template.len() {
      out.push(c);
      i += 1;
      continue;
    }
    let next = template[i + 1];
    match next {
      n if n == dollar => {
        out.push(dollar);
        i += 2;
      }
      n if n == b'&' as u16 => {
        out.extend_from_slice(&units[m.start..m.end]);
        i += 2;
      }
      n if n == b'`' as u16 => {
        out.extend_from_slice(&units[..m.start]);
        i += 2;
      }
      n if n == b'\'' as u16 => {
        out.extend_from_slice(&units[m.end..]);
        i += 2;
      }
      n if (b'0' as u16..=b'9' as u16).contains(&n) => {
        let d1 = (n - b'0' as u16) as usize;
        let two = template.get(i + 2).filter(|c| (b'0' as u16..=b'9' as u16).contains(c)).map(|c| (*c - b'0' as u16) as usize);
        let groups = m.groups.len();
        if let Some(d2) = two
          && (1..=groups).contains(&(d1 * 10 + d2))
        {
          if let Some((a, b)) = m.groups[d1 * 10 + d2 - 1] {
            out.extend_from_slice(&units[a..b]);
          }
          i += 3;
        } else if (1..=groups).contains(&d1) {
          if let Some((a, b)) = m.groups[d1 - 1] {
            out.extend_from_slice(&units[a..b]);
          }
          i += 2;
        } else {
          out.push(dollar);
          i += 1;
        }
      }
      _ => {
        out.push(dollar);
        i += 1;
      }
    }
  }
}
