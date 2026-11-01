//! A mutable JavaScript value with reference semantics.
//!
//! `transform/read` mutates the rows returned by drizzle in place and reuses
//! them as result objects (array rows and block rows become the documents'
//! array/block items, `_locales` rows are spread into copies, deletions run
//! after the traversal). Reproducing the exact output therefore needs shared,
//! mutable objects, which [`crate::js::JsVal`](payload_engine::js::JsVal)
//! (immutable, `Arc`) does not model. [`Val`] is `Rc<RefCell<..>>` based and
//! objects keep JS property order (array-index keys first, ascending, then
//! insertion order).
//!
//! Objects are ordinary JS objects: they inherit `Object.prototype` unless
//! their prototype was replaced through the `__proto__` accessor, so lookups
//! such as `map['constructor']` or `'toString' in map` behave like in JS (see
//! [`crate::props`]). Inherited built-ins are modelled as [`Builtin`] values.

use std::cell::RefCell;
use std::ops::{Deref, DerefMut};
use std::rc::Rc;

use indexmap::IndexMap;
use payload_engine::js::JsVal;

use crate::jsops::num_to_string;
use crate::jsstr::{JsStr, KeyRef};

pub type ObjRef = Rc<RefCell<JsObject>>;
pub type ArrRef = Rc<RefCell<JsArray>>;

/// The items of a JS array. Dropping it (like [`JsObject`]) frees nested values
/// iteratively, so deeply nested data cannot overflow the stack.
#[derive(Clone, Debug, Default)]
pub struct JsArray(pub Vec<Val>);

impl Deref for JsArray {
  type Target = Vec<Val>;
  fn deref(&self) -> &Vec<Val> {
    &self.0
  }
}

impl DerefMut for JsArray {
  fn deref_mut(&mut self) -> &mut Vec<Val> {
    &mut self.0
  }
}

impl Drop for JsArray {
  fn drop(&mut self) {
    drop_iteratively(std::mem::take(&mut self.0));
  }
}

impl Drop for JsObject {
  fn drop(&mut self) {
    let mut pending: Vec<Val> = self.map.drain(..).map(|(_, v)| v).collect();
    if let Proto::Val(p) = std::mem::take(&mut self.proto) {
      pending.push(p);
    }
    drop_iteratively(pending);
  }
}

/// Drops values without recursion: containers that are uniquely owned are emptied
/// into the work list before they are freed.
fn drop_iteratively(mut pending: Vec<Val>) {
  while let Some(value) = pending.pop() {
    match value {
      Val::Arr(rc) => {
        if let Ok(cell) = Rc::try_unwrap(rc) {
          pending.append(&mut cell.into_inner().0);
        }
      }
      Val::Obj(rc) => {
        if let Ok(cell) = Rc::try_unwrap(rc) {
          let mut obj = cell.into_inner();
          pending.extend(obj.map.drain(..).map(|(_, v)| v));
          if let Proto::Val(p) = std::mem::take(&mut obj.proto) {
            pending.push(p);
          }
        }
      }
      _ => {}
    }
  }
}

#[derive(Clone, Debug, Default)]
pub enum Val {
  #[default]
  Undefined,
  Null,
  Bool(bool),
  Num(f64),
  Str(JsStr),
  /// A `Date` instance, stored as its time value in milliseconds (NaN for invalid dates).
  Date(f64),
  /// A `bigint` primitive, as its decimal `toString()`.
  BigInt(std::sync::Arc<str>),
  Arr(ArrRef),
  Obj(ObjRef),
  /// A JS built-in reachable through `Object.prototype` (e.g. `{}.constructor`).
  Builtin(Builtin),
}

/// Built-ins inherited from `Object.prototype`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Builtin {
  /// `Object.prototype` itself (what `{}.__proto__` returns).
  ObjectPrototype,
  /// A built-in function, by name (`Object` for `constructor`, otherwise the method name).
  Function(&'static str),
}

/// Own property names of `Object.prototype` (V8 / Node 24).
pub const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
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

/// The value of `Object.prototype[key]` for a data/method member (not `__proto__`).
pub fn object_prototype_member(key: KeyRef<'_>) -> Option<Builtin> {
  let KeyRef::Utf8(key) = key else { return None };
  if key == "__proto__" {
    return None;
  }
  OBJECT_PROTOTYPE_KEYS
    .iter()
    .find(|k| **k == key)
    .map(|k| Builtin::Function(if *k == "constructor" { "Object" } else { k }))
}

/// The `[[Prototype]]` of an ordinary object.
#[derive(Clone, Debug, Default)]
pub enum Proto {
  #[default]
  Object,
  Null,
  Val(Val),
}

/// A JS ordinary object's own enumerable string-keyed properties, in JS order, and its prototype.
#[derive(Clone, Debug, Default)]
pub struct JsObject {
  map: IndexMap<JsStr, Val>,
  pub proto: Proto,
}

/// `CanonicalNumericIndexString` restricted to array indices (what V8 orders first).
fn array_index(key: &JsStr) -> Option<u32> {
  let key = key.as_str()?;
  if key.is_empty() || key.len() > 10 || (key.len() > 1 && key.starts_with('0')) {
    return None;
  }
  if !key.bytes().all(|b| b.is_ascii_digit()) {
    return None;
  }
  let n: u64 = key.parse().ok()?;
  (n < u32::MAX as u64).then_some(n as u32)
}

impl JsObject {
  pub fn new() -> Self {
    Self::default()
  }

  /// Own property value.
  pub fn own<'k>(&self, key: impl Into<KeyRef<'k>>) -> Option<Val> {
    self.map.get(&key.into()).cloned()
  }

  pub fn has_own<'k>(&self, key: impl Into<KeyRef<'k>>) -> bool {
    self.map.contains_key(&key.into())
  }

  /// `CreateDataProperty(obj, key, value)` (object literals, spreads, `JSON.parse`,
  /// `Object.fromEntries`): always an own property, existing keys keep their position.
  pub fn define<'k>(&mut self, key: impl Into<KeyRef<'k>>, value: Val) {
    let key = key.into();
    if let Some(slot) = self.map.get_mut(&key) {
      *slot = value;
      return;
    }
    let key = key.to_js_str();
    match array_index(&key) {
      Some(idx) => {
        let pos = self
          .map
          .keys()
          .position(|k| array_index(k).is_none_or(|other| other > idx))
          .unwrap_or(self.map.len());
        self.map.shift_insert(pos, key, value);
      }
      None => {
        self.map.insert(key, value);
      }
    }
  }

  /// `delete obj[key]` (own properties only).
  pub fn delete<'k>(&mut self, key: impl Into<KeyRef<'k>>) {
    self.map.shift_remove(&key.into());
  }

  pub fn len(&self) -> usize {
    self.map.len()
  }

  pub fn is_empty(&self) -> bool {
    self.map.is_empty()
  }

  /// `Object.entries(obj)` (a snapshot).
  pub fn entries(&self) -> Vec<(JsStr, Val)> {
    self.map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
  }

  /// `Object.keys(obj)`
  pub fn keys(&self) -> Vec<JsStr> {
    self.map.keys().cloned().collect()
  }

  /// `{ ...self }`: a new ordinary object with copies of the own properties.
  pub fn spread(&self) -> JsObject {
    JsObject { map: self.map.clone(), proto: Proto::Object }
  }
}

impl Val {
  pub fn str(s: &str) -> Self {
    Val::Str(JsStr::from(s))
  }

  pub fn new_obj() -> Self {
    Val::Obj(Rc::new(RefCell::new(JsObject::new())))
  }

  pub fn new_arr(items: Vec<Val>) -> Self {
    Val::Arr(Rc::new(RefCell::new(JsArray(items))))
  }

  pub fn from_obj(obj: JsObject) -> Self {
    Val::Obj(Rc::new(RefCell::new(obj)))
  }

  pub fn truthy(&self) -> bool {
    match self {
      Val::Undefined | Val::Null => false,
      Val::Bool(b) => *b,
      Val::Num(n) => *n != 0.0 && !n.is_nan(),
      Val::Str(s) => !s.is_empty(),
      Val::BigInt(d) => &**d != "0",
      Val::Date(_) | Val::Arr(_) | Val::Obj(_) | Val::Builtin(_) => true,
    }
  }

  pub fn is_undefined(&self) -> bool {
    matches!(self, Val::Undefined)
  }

  pub fn is_nullish(&self) -> bool {
    matches!(self, Val::Undefined | Val::Null)
  }

  /// `typeof value === 'object' || typeof value === 'function'` (excluding `null`).
  pub fn is_object_like(&self) -> bool {
    matches!(self, Val::Date(_) | Val::Arr(_) | Val::Obj(_) | Val::Builtin(_))
  }

  pub fn as_js_str(&self) -> Option<&JsStr> {
    match self {
      Val::Str(s) => Some(s),
      _ => None,
    }
  }

  pub fn as_obj(&self) -> Option<&ObjRef> {
    match self {
      Val::Obj(o) => Some(o),
      _ => None,
    }
  }

  pub fn as_arr(&self) -> Option<&ArrRef> {
    match self {
      Val::Arr(a) => Some(a),
      _ => None,
    }
  }

  /// `===`
  pub fn strict_eq(&self, other: &Val) -> bool {
    match (self, other) {
      (Val::Undefined, Val::Undefined) | (Val::Null, Val::Null) => true,
      (Val::Bool(a), Val::Bool(b)) => a == b,
      (Val::Num(a), Val::Num(b)) => a == b,
      (Val::Str(a), Val::Str(b)) => a == b,
      (Val::BigInt(a), Val::BigInt(b)) => a == b,
      (Val::Arr(a), Val::Arr(b)) => Rc::ptr_eq(a, b),
      (Val::Obj(a), Val::Obj(b)) => Rc::ptr_eq(a, b),
      (Val::Builtin(a), Val::Builtin(b)) => a == b,
      // Dates are objects: identity only, and two `Val::Date` never share identity.
      _ => false,
    }
  }

  /// `===` against a config value (only primitives can be equal).
  pub fn strict_eq_js(&self, other: &JsVal) -> bool {
    match (self, other) {
      (Val::Undefined, JsVal::Undefined) | (Val::Null, JsVal::Null) => true,
      (Val::Bool(a), JsVal::Bool(b)) => a == b,
      (Val::Num(a), JsVal::Num(b)) => a == b,
      (Val::Str(a), JsVal::Str(b)) => a.as_str() == Some(&**b),
      (Val::BigInt(a), b) => b.as_bigint().is_some_and(|b| *a == b),
      _ => false,
    }
  }

  /// `typeof value === 'string'`
  pub fn is_string(&self) -> bool {
    matches!(self, Val::Str(_))
  }

  /// `typeof value === 'number'`
  pub fn is_number(&self) -> bool {
    matches!(self, Val::Num(_))
  }

  /// `String(value)` / template literal interpolation / `ToPropertyKey`.
  pub fn to_js_str(&self) -> JsStr {
    match self {
      Val::Str(s) => s.clone(),
      Val::Arr(a) => {
        let parts: Vec<JsStr> =
          a.borrow().iter().map(|v| if v.is_nullish() { JsStr::default() } else { v.to_js_str() }).collect();
        let comma = JsStr::from(",");
        let mut joined: Vec<&JsStr> = Vec::with_capacity(parts.len() * 2);
        for (i, p) in parts.iter().enumerate() {
          if i > 0 {
            joined.push(&comma);
          }
          joined.push(p);
        }
        JsStr::concat(joined)
      }
      other => JsStr::from(other.to_js_string()),
    }
  }

  /// `String(value)` as UTF-8 (lone surrogates replaced by U+FFFD).
  pub fn to_js_string(&self) -> String {
    match self {
      Val::Undefined => "undefined".into(),
      Val::Null => "null".into(),
      Val::Bool(b) => b.to_string(),
      Val::Num(n) => num_to_string(*n),
      Val::Str(s) => s.to_lossy().into_owned(),
      Val::Date(t) => crate::date::date_to_string(*t),
      Val::BigInt(d) => d.to_string(),
      Val::Arr(_) => self.to_js_str().to_lossy().into_owned(),
      Val::Obj(_) | Val::Builtin(Builtin::ObjectPrototype) => "[object Object]".into(),
      Val::Builtin(Builtin::Function(name)) => format!("function {name}() {{ [native code] }}"),
    }
  }

  /// This value as an engine value. `Date`s become typed [`JsVal::date`]s, inherited built-in
  /// functions `undefined` (what `serializeForEngine` would send for them), `Object.prototype` an
  /// empty object, and a reference back to an ancestor (only possible through mutation)
  /// `undefined`. Lone surrogates in strings become U+FFFD.
  ///
  /// Iterative: values of any depth convert without growing the stack.
  pub fn to_js(&self) -> JsVal {
    enum Children {
      Arr(Vec<Val>, Vec<JsVal>),
      Obj(Vec<(JsStr, Val)>, payload_engine::js::Obj),
    }
    struct Frame {
      id: usize,
      next: usize,
      children: Children,
    }
    let mut ancestors = std::collections::HashSet::new();
    let mut stack: Vec<Frame> = Vec::new();
    let mut current = self.clone();
    loop {
      let mut finished = match &current {
        Val::Undefined | Val::Builtin(Builtin::Function(_)) => Some(JsVal::Undefined),
        Val::Builtin(Builtin::ObjectPrototype) => Some(JsVal::obj(payload_engine::js::Obj::new())),
        Val::Null => Some(JsVal::Null),
        Val::Bool(b) => Some(JsVal::Bool(*b)),
        Val::Num(n) => Some(JsVal::Num(*n)),
        Val::Str(s) => Some(JsVal::str(s.to_lossy().as_ref())),
        Val::Date(ms) => Some(JsVal::date(*ms)),
        Val::BigInt(d) => Some(JsVal::bigint(d.clone())),
        Val::Arr(a) => {
          let id = Rc::as_ptr(a) as usize;
          if ancestors.insert(id) {
            let items = a.borrow().to_vec();
            let out = Vec::with_capacity(items.len());
            stack.push(Frame { id, next: 0, children: Children::Arr(items, out) });
            None
          } else {
            Some(JsVal::Undefined)
          }
        }
        Val::Obj(o) => {
          let id = Rc::as_ptr(o) as usize;
          if ancestors.insert(id) {
            let entries = o.borrow().entries();
            let out = payload_engine::js::Obj::with_capacity(entries.len());
            stack.push(Frame { id, next: 0, children: Children::Obj(entries, out) });
            None
          } else {
            Some(JsVal::Undefined)
          }
        }
      };
      loop {
        if let Some(value) = finished.take() {
          let Some(frame) = stack.last_mut() else { return value };
          match &mut frame.children {
            Children::Arr(_, out) => out.push(value),
            Children::Obj(entries, out) => {
              out.insert(entries[frame.next].0.to_lossy().into_owned(), value);
            }
          }
          frame.next += 1;
        }
        let Some(frame) = stack.last_mut() else { unreachable!("a finished root returns above") };
        let child = match &frame.children {
          Children::Arr(items, _) => items.get(frame.next).cloned(),
          Children::Obj(entries, _) => entries.get(frame.next).map(|(_, v)| v.clone()),
        };
        if let Some(child) = child {
          current = child;
          break;
        }
        let Some(frame) = stack.pop() else { unreachable!() };
        ancestors.remove(&frame.id);
        finished = Some(match frame.children {
          Children::Arr(_, out) => JsVal::arr(out),
          Children::Obj(_, out) => JsVal::obj(out),
        });
      }
    }
  }

  /// Copies an immutable config value into a fresh mutable value (iterative: any depth). An
  /// object reached again from inside itself (a cycle) is the copy being built.
  pub fn from_js(value: &JsVal) -> Val {
    fn leaf(value: &JsVal) -> Option<Val> {
      if let Some(t) = value.as_date() {
        return Some(Val::Date(t));
      }
      if let Some(d) = value.as_bigint() {
        return Some(Val::BigInt(d));
      }
      Some(match value {
        JsVal::Undefined | JsVal::Fn(_) => Val::Undefined,
        JsVal::Null => Val::Null,
        JsVal::Bool(b) => Val::Bool(*b),
        JsVal::Num(n) => Val::Num(*n),
        JsVal::Str(s) => Val::str(s),
        JsVal::Arr(_) | JsVal::Obj(_) => return None,
      })
    }
    fn open(source: &JsVal) -> Val {
      match source {
        JsVal::Arr(a) => Val::new_arr(Vec::with_capacity(a.len())),
        _ => Val::new_obj(),
      }
    }
    /// A container being copied: its source, the copy, and how many children are copied.
    struct Frame<'a> {
      source: &'a JsVal,
      copy: Val,
      next: usize,
    }
    if let Some(v) = leaf(value) {
      return v;
    }
    let root = open(value);
    let mut ancestors: std::collections::HashMap<usize, Val> = std::collections::HashMap::new();
    ancestors.extend(value.identity().map(|id| (id, root.clone())));
    let mut stack = vec![Frame { source: value, copy: root.clone(), next: 0 }];
    while let Some(frame) = stack.last_mut() {
      let index = frame.next;
      let (key, item) = match frame.source {
        JsVal::Arr(a) => match a.get(index) {
          Some(v) => ("", v),
          None => {
            ancestors.remove(&frame.source.identity().unwrap_or(0));
            stack.pop();
            continue;
          }
        },
        JsVal::Obj(o) => match o.get_index(index) {
          Some((k, v)) => (k.as_str(), v),
          None => {
            ancestors.remove(&frame.source.identity().unwrap_or(0));
            stack.pop();
            continue;
          }
        },
        _ => {
          stack.pop();
          continue;
        }
      };
      frame.next += 1;
      let (value, opened) = match leaf(item) {
        Some(v) => (v, false),
        None => match item.identity().and_then(|id| ancestors.get(&id)) {
          Some(cycle) => (cycle.clone(), false),
          None => (open(item), true),
        },
      };
      match &frame.copy {
        Val::Arr(a) => a.borrow_mut().push(value.clone()),
        Val::Obj(o) => o.borrow_mut().define(key, value.clone()),
        _ => {}
      }
      if opened {
        ancestors.extend(item.identity().map(|id| (id, value.clone())));
        stack.push(Frame { source: item, copy: value, next: 0 });
      }
    }
    root
  }
}

/// JS `ToPropertyKey` for primitive config values used as object keys.
pub fn js_key(value: &JsVal) -> String {
  value.to_js_string()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn integer_keys_are_ordered_first() {
    let mut o = JsObject::new();
    o.define("b", Val::Null);
    o.define("2", Val::Null);
    o.define("a", Val::Null);
    o.define("1", Val::Null);
    o.define("01", Val::Null);
    let keys: Vec<String> = o.keys().iter().map(|k| k.to_string()).collect();
    assert_eq!(keys, vec!["1", "2", "b", "a", "01"]);
  }
}
