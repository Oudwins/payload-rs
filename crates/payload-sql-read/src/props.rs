//! Property access on [`Val`] with JS semantics and JS `TypeError`s.
//!
//! Objects inherit `Object.prototype`: reading an inherited key such as
//! `constructor` or `toString` yields a [`Builtin`], `'toString' in obj` is
//! `true`, and `obj.__proto__ = value` goes through the `__proto__` accessor
//! (replacing the prototype) unless the object has an own `__proto__` property
//! (created by `JSON.parse`, spreads or object literals with computed keys).

use payload_engine::error::{EngineError, Result};

use crate::jsstr::KeyRef;
use crate::value::{Builtin, OBJECT_PROTOTYPE_KEYS, Proto, Val, object_prototype_member};

fn type_error(message: String) -> EngineError {
  EngineError::new("TypeError", message)
}

fn nullish_name(v: &Val) -> &'static str {
  if matches!(v, Val::Null) { "null" } else { "undefined" }
}

fn is_object_prototype_key(key: KeyRef<'_>) -> bool {
  matches!(key, KeyRef::Utf8(k) if OBJECT_PROTOTYPE_KEYS.contains(&k))
}

fn array_index(key: KeyRef<'_>) -> Option<usize> {
  match key {
    KeyRef::Utf8(k) if !k.is_empty() && (k == "0" || !k.starts_with('0')) && k.bytes().all(|b| b.is_ascii_digit()) => {
      k.parse::<usize>().ok()
    }
    _ => None,
  }
}

fn proto_value(proto: &Proto) -> Val {
  match proto {
    Proto::Object => Val::Builtin(Builtin::ObjectPrototype),
    Proto::Null => Val::Null,
    Proto::Val(v) => v.clone(),
  }
}

/// `Object.prototype[key]` as seen through an object whose prototype chain ends there.
fn inherited_from_object_prototype(key: KeyRef<'_>) -> Val {
  object_prototype_member(key).map(Val::Builtin).unwrap_or_default()
}

/// `value[key]`
pub fn get<'k>(v: &Val, key: impl Into<KeyRef<'k>>) -> Result<Val> {
  get_key(v, key.into())
}

fn get_key(v: &Val, key: KeyRef<'_>) -> Result<Val> {
  match v {
    Val::Obj(o) => {
      let (own, proto) = {
        let o = o.borrow();
        (o.own(key), o.proto.clone())
      };
      if let Some(value) = own {
        return Ok(value);
      }
      if key.is("__proto__") {
        return Ok(match &proto {
          Proto::Null => Val::Undefined,
          other => proto_value(other),
        });
      }
      match proto {
        Proto::Object => Ok(inherited_from_object_prototype(key)),
        Proto::Null => Ok(Val::Undefined),
        Proto::Val(p) => get_key(&p, key),
      }
    }
    Val::Arr(a) => {
      if key.is("length") {
        return Ok(Val::Num(a.borrow().len() as f64));
      }
      if let Some(i) = array_index(key) {
        return Ok(a.borrow().get(i).cloned().unwrap_or_default());
      }
      Ok(inherited_from_object_prototype(key))
    }
    Val::Str(s) if key.is("length") => Ok(Val::Num(s.utf16_len() as f64)),
    Val::Undefined | Val::Null => Err(type_error(format!(
      "Cannot read properties of {} (reading '{}')",
      nullish_name(v),
      key.to_lossy()
    ))),
    Val::Builtin(Builtin::ObjectPrototype) if key.is("__proto__") => Ok(Val::Null),
    Val::Builtin(_) | Val::Date(_) => Ok(inherited_from_object_prototype(key)),
    _ => Ok(Val::Undefined),
  }
}

/// `value[key] = item` (strict mode assignment).
pub fn set<'k>(v: &Val, key: impl Into<KeyRef<'k>>, item: Val) -> Result<()> {
  let key = key.into();
  match v {
    Val::Obj(o) => {
      let mut o = o.borrow_mut();
      if !o.has_own(key) && key.is("__proto__") && !matches!(o.proto, Proto::Null) {
        // The `Object.prototype.__proto__` setter.
        match item {
          Val::Null => o.proto = Proto::Null,
          Val::Builtin(Builtin::ObjectPrototype) => o.proto = Proto::Object,
          other if other.is_object_like() => o.proto = Proto::Val(other),
          _ => {}
        }
        return Ok(());
      }
      o.define(key, item);
      Ok(())
    }
    Val::Arr(a) => {
      if let Some(i) = array_index(key) {
        let mut a = a.borrow_mut();
        if i < a.len() {
          a[i] = item;
        } else {
          a.resize(i, Val::Undefined);
          a.push(item);
        }
        Ok(())
      } else {
        Err(EngineError::internal(format!("unsupported: setting non-index property '{}' on an array", key.to_lossy())))
      }
    }
    Val::Undefined | Val::Null => Err(type_error(format!(
      "Cannot set properties of {} (setting '{}')",
      nullish_name(v),
      key.to_lossy()
    ))),
    Val::Builtin(_) | Val::Date(_) => Err(EngineError::internal(format!(
      "unsupported: setting property '{}' on a JS built-in or Date",
      key.to_lossy()
    ))),
    _ => Err(type_error(format!("Cannot create property '{}' on {}", key.to_lossy(), v.to_js_string()))),
  }
}

/// `CreateDataProperty(value, key, item)` (object literal with a computed key, `Object.fromEntries`).
pub fn define<'k>(v: &Val, key: impl Into<KeyRef<'k>>, item: Val) -> Result<()> {
  match v {
    Val::Obj(o) => {
      o.borrow_mut().define(key, item);
      Ok(())
    }
    other => set(other, key, item),
  }
}

/// `delete value[key]`
pub fn delete<'k>(v: &Val, key: impl Into<KeyRef<'k>>) -> Result<()> {
  let key = key.into();
  match v {
    Val::Obj(o) => {
      o.borrow_mut().delete(key);
      Ok(())
    }
    Val::Undefined | Val::Null => {
      Err(type_error(format!("Cannot convert undefined or null to object (deleting '{}')", key.to_lossy())))
    }
    _ => Ok(()),
  }
}

/// `key in value`
pub fn has<'k>(v: &Val, key: impl Into<KeyRef<'k>>) -> Result<bool> {
  has_key(v, key.into())
}

fn has_key(v: &Val, key: KeyRef<'_>) -> Result<bool> {
  match v {
    Val::Obj(o) => {
      let (own, proto) = {
        let o = o.borrow();
        (o.has_own(key), o.proto.clone())
      };
      if own {
        return Ok(true);
      }
      match proto {
        Proto::Object => Ok(is_object_prototype_key(key)),
        Proto::Null => Ok(false),
        Proto::Val(p) => has_key(&p, key),
      }
    }
    Val::Arr(a) => Ok(key.is("length")
      || array_index(key).is_some_and(|i| i < a.borrow().len())
      || is_object_prototype_key(key)),
    Val::Builtin(_) | Val::Date(_) => Ok(is_object_prototype_key(key)),
    _ => Err(type_error(format!("Cannot use 'in' operator to search for '{}' in {}", key.to_lossy(), v.to_js_string()))),
  }
}

/// `Array.isArray(value)` + snapshot of its items.
pub fn array_items(v: &Val) -> Option<Vec<Val>> {
  v.as_arr().map(|a| a.borrow().to_vec())
}

/// `array.push(item)`, TypeError when not an array.
pub fn push(v: &Val, item: Val) -> Result<()> {
  match v {
    Val::Arr(a) => {
      a.borrow_mut().push(item);
      Ok(())
    }
    Val::Undefined | Val::Null => Err(type_error(format!("Cannot read properties of {} (reading 'push')", nullish_name(v)))),
    _ => Err(type_error("push is not a function".into())),
  }
}

/// Items of `value` for a call to an array method (`value.forEach(...)`, `.map`,
/// `.reduce`, `.find`), with the TypeError JS throws when `value` is not an array.
pub fn array_method_items(v: &Val, method: &str) -> Result<Vec<Val>> {
  match v {
    Val::Arr(a) => Ok(a.borrow().to_vec()),
    Val::Undefined | Val::Null => {
      Err(type_error(format!("Cannot read properties of {} (reading '{method}')", nullish_name(v))))
    }
    _ => Err(type_error(format!("{method} is not a function"))),
  }
}

/// Destructuring `({ key }) => ...` of an array item.
pub fn destructure(v: &Val, key: &str) -> Result<Val> {
  match v {
    Val::Undefined | Val::Null => Err(type_error(format!(
      "Cannot destructure property '{key}' of '{}' as it is {}.",
      v.to_js_string(),
      nullish_name(v)
    ))),
    _ => get(v, key),
  }
}
