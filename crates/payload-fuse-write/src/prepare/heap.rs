//! A small model of the JS heap the write-side steps run on: objects and arrays by reference
//! (upstream shares objects between `data`, `doc` and rows: `getExistingRowDoc` returns the stored
//! row itself, `cloneDataFromOriginalDoc` copies one level), property order as JS keeps it
//! (insertion order; integer-like keys are refused at the boundary), own `undefined` properties.

use indexmap::IndexMap;
use std::rc::Rc;

use payload_engine::js::{JsVal, Obj as JsObj};

use super::Bail;

pub type Ref = usize;

#[derive(Clone, Debug)]
pub enum V {
  Undef,
  Null,
  Bool(bool),
  Num(f64),
  Str(Rc<str>),
  /// An object or an array on the heap.
  Ref(Ref),
  /// A `Date` (its time value).
  Date(f64),
  /// A bson `ObjectId`.
  Oid([u8; 12]),
}

impl V {
  pub fn str(s: &str) -> V {
    V::Str(Rc::from(s))
  }

  pub fn is_undef(&self) -> bool {
    matches!(self, V::Undef)
  }

  pub fn is_nullish(&self) -> bool {
    matches!(self, V::Undef | V::Null)
  }

  /// JS `ToBoolean`.
  pub fn truthy(&self) -> bool {
    match self {
      V::Undef | V::Null => false,
      V::Bool(b) => *b,
      V::Num(n) => *n != 0.0 && !n.is_nan(),
      V::Str(s) => !s.is_empty(),
      V::Ref(_) | V::Date(_) | V::Oid(_) => true,
    }
  }

  pub fn as_str(&self) -> Option<&str> {
    match self {
      V::Str(s) => Some(s),
      _ => None,
    }
  }

  pub fn as_ref(&self) -> Option<Ref> {
    match self {
      V::Ref(r) => Some(*r),
      _ => None,
    }
  }
}

#[derive(Clone, Debug)]
pub enum Node {
  Obj(IndexMap<Rc<str>, V>),
  Arr(Vec<V>),
}

#[derive(Default)]
pub struct Heap {
  nodes: Vec<Node>,
}

/// Whether JS orders `key` as an array index (before every other key).
pub fn is_array_index(key: &str) -> bool {
  !key.is_empty()
    && key.bytes().all(|b| b.is_ascii_digit())
    && (key == "0" || !key.starts_with('0'))
    && key.parse::<u64>().is_ok_and(|n| n < u32::MAX as u64)
}

impl Heap {
  pub fn alloc(&mut self, node: Node) -> Ref {
    self.nodes.push(node);
    self.nodes.len() - 1
  }

  pub fn new_obj(&mut self) -> Ref {
    self.alloc(Node::Obj(IndexMap::new()))
  }

  pub fn node(&self, r: Ref) -> &Node {
    &self.nodes[r]
  }

  pub fn is_obj(&self, v: &V) -> bool {
    matches!(v, V::Ref(r) if matches!(self.nodes[*r], Node::Obj(_)))
  }

  pub fn is_arr(&self, v: &V) -> bool {
    matches!(v, V::Ref(r) if matches!(self.nodes[*r], Node::Arr(_)))
  }

  /// `typeof v === 'object'` (null, arrays, dates, ObjectIds included).
  pub fn is_object_like(v: &V) -> bool {
    matches!(v, V::Null | V::Ref(_) | V::Date(_) | V::Oid(_))
  }

  pub fn obj(&self, r: Ref) -> Option<&IndexMap<Rc<str>, V>> {
    match &self.nodes[r] {
      Node::Obj(o) => Some(o),
      Node::Arr(_) => None,
    }
  }


  pub fn arr(&self, r: Ref) -> Option<&Vec<V>> {
    match &self.nodes[r] {
      Node::Arr(a) => Some(a),
      Node::Obj(_) => None,
    }
  }

  pub fn arr_mut(&mut self, r: Ref) -> Option<&mut Vec<V>> {
    match &mut self.nodes[r] {
      Node::Arr(a) => Some(a),
      Node::Obj(_) => None,
    }
  }

  /// `obj[key]` (`undefined` for a missing key or a non-object).
  pub fn get(&self, obj: &V, key: &str) -> V {
    match obj {
      V::Ref(r) => match &self.nodes[*r] {
        Node::Obj(o) => o.get(key).cloned().unwrap_or(V::Undef),
        Node::Arr(a) => match key.parse::<usize>() {
          Ok(i) if is_array_index(key) => a.get(i).cloned().unwrap_or(V::Undef),
          _ => V::Undef,
        },
      },
      _ => V::Undef,
    }
  }

  /// `key in obj` for an object.
  pub fn has(&self, obj: &V, key: &str) -> bool {
    match obj {
      V::Ref(r) => matches!(&self.nodes[*r], Node::Obj(o) if o.contains_key(key)),
      _ => false,
    }
  }

  /// `obj[key] = value` on a plain object (appends a new key, keeps the place of an existing one).
  pub fn set(&mut self, obj: Ref, key: &str, value: V) -> Result<(), Bail> {
    if is_array_index(key) {
      return Err(Bail::new("heap:indexKey"));
    }
    match &mut self.nodes[obj] {
      Node::Obj(o) => {
        match o.get_mut(key) {
          Some(slot) => *slot = value,
          None => {
            o.insert(Rc::from(key), value);
          }
        }
        Ok(())
      }
      Node::Arr(_) => Err(Bail::new("heap:setOnArray")),
    }
  }

  /// `delete obj[key]`.
  pub fn delete(&mut self, obj: Ref, key: &str) {
    if let Node::Obj(o) = &mut self.nodes[obj] {
      o.shift_remove(key);
    }
  }

  pub fn keys(&self, obj: Ref) -> Vec<Rc<str>> {
    match &self.nodes[obj] {
      Node::Obj(o) => o.keys().cloned().collect(),
      Node::Arr(_) => Vec::new(),
    }
  }

  /// `{ ...obj }` of a plain object.
  pub fn spread(&mut self, obj: Ref) -> Ref {
    let node = self.nodes[obj].clone();
    self.alloc(node)
  }

  /// `deepCopyObjectSimple(value)`: arrays and objects copied, `Date`s copied, ObjectIds to
  /// their hex string, own `undefined` properties kept.
  pub fn deep_copy(&mut self, value: &V) -> V {
    match value {
      V::Ref(r) => {
        let node = match &self.nodes[*r] {
          Node::Obj(o) => Node::Obj(o.clone()),
          Node::Arr(a) => Node::Arr(a.clone()),
        };
        let copied = match node {
          Node::Obj(o) => Node::Obj(o.into_iter().map(|(k, v)| (k, self.deep_copy(&v))).collect()),
          Node::Arr(a) => Node::Arr(a.into_iter().map(|v| self.deep_copy(&v)).collect()),
        };
        V::Ref(self.alloc(copied))
      }
      V::Oid(bytes) => V::str(&payload_engine::bson::object_id_to_hex(bytes)),
      other => other.clone(),
    }
  }

  /// A tree from the boundary value. `Date`s and ObjectIds become their own kinds; anything else
  /// typed (bigint, other BSON values, host objects), functions and integer-like keys bail.
  pub fn import(&mut self, value: &JsVal) -> Result<V, Bail> {
    Ok(match value {
      JsVal::Undefined => V::Undef,
      JsVal::Null => V::Null,
      JsVal::Bool(b) => V::Bool(*b),
      JsVal::Num(n) => V::Num(*n),
      JsVal::Str(s) => V::str(s),
      JsVal::Fn(_) => return Err(Bail::new("value:function")),
      JsVal::Arr(items) => {
        let mut out = Vec::with_capacity(items.len());
        for item in items.iter() {
          out.push(self.import(item)?);
        }
        V::Ref(self.alloc(Node::Arr(out)))
      }
      JsVal::Obj(props) => {
        if props.is_empty() {
          if let Some(ms) = value.as_date() {
            return Ok(V::Date(ms));
          }
          if let Some(bson) = value.bson() {
            return match bson {
              payload_engine::bson::BsonValue::ObjectId(bytes) => Ok(V::Oid(bytes)),
              _ => Err(Bail::new("value:bson")),
            };
          }
          if value.typed().is_some() || value.as_host_object().is_some() {
            return Err(Bail::new("value:typed"));
          }
        }
        let mut out = IndexMap::with_capacity(props.len());
        for (key, item) in props.iter() {
          if is_array_index(key) || key == "__proto__" {
            return Err(Bail::new("value:key"));
          }
          out.insert(Rc::from(key.as_str()), self.import(item)?);
        }
        V::Ref(self.alloc(Node::Obj(out)))
      }
    })
  }

  /// The boundary value of a tree (shared objects are written once per place).
  pub fn export(&self, value: &V) -> JsVal {
    match value {
      V::Undef => JsVal::Undefined,
      V::Null => JsVal::Null,
      V::Bool(b) => JsVal::Bool(*b),
      V::Num(n) => JsVal::Num(*n),
      V::Str(s) => JsVal::str(&**s),
      V::Date(ms) => JsVal::date(*ms),
      V::Oid(bytes) => JsVal::bson_value(payload_engine::bson::BsonValue::ObjectId(*bytes)),
      V::Ref(r) => match &self.nodes[*r] {
        Node::Arr(a) => JsVal::arr(a.iter().map(|v| self.export(v)).collect()),
        Node::Obj(o) => {
          let mut out = JsObj::with_capacity(o.len());
          for (k, v) in o {
            out.insert(k.to_string(), self.export(v));
          }
          JsVal::obj(out)
        }
      },
    }
  }
}
