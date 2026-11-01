//! The mutable JS object graph `transformForWrite` works on.
//!
//! The TS transform mutates its `data` argument (array/block row ids move to `_uuid`, groups get
//! `_uuid`, localized relationship objects are replaced by their ids, dotted keys are expanded).
//! A JS object reachable through several paths (`data.a === data.b`, which the engine decoder
//! keeps for `$ref`s) is one object: a mutation through one path is visible through every other.
//! [`JsVal`] objects are immutable `Arc`s, so the transform imports `data` into a [`Heap`] of
//! mutable nodes (one per JS object, cycles included), mutates the nodes and exports the result.
//!
//! Values the transform reads as plain data (leaf field values) are exported as snapshots at the
//! time TS reads them. TS keeps references to those objects in the `RowToInsert` it returns, so
//! later mutations of the same objects show up there too: [`Heap::fix_up`] replaces snapshots in
//! the output by the final state of their objects.
//!
//! A `Date` is a node (it is an object: own properties can be added to it) that exports as the
//! original typed `Date` value; a `bigint` is a primitive.

use std::collections::HashMap;
use std::sync::Arc;

use indexmap::IndexMap;
use payload_engine::error::{EngineError, Result};
use payload_engine::js::{Items, JsVal, Obj, Props, TypedValue};

use crate::js::{OBJECT_PROTOTYPE_KEYS, is_array_index, js_insert, to_js_string, type_error};

pub(crate) type NodeId = usize;

/// A JS value in the heap: a primitive (never a plain object or array, may be a `bigint` or a
/// function handle) or a reference to an object node.
#[derive(Clone, Debug)]
pub(crate) enum HVal {
  Prim(JsVal),
  Node(NodeId),
}

impl HVal {
  pub(crate) const UNDEFINED: HVal = HVal::Prim(JsVal::Undefined);

  pub(crate) fn is_undefined(&self) -> bool {
    matches!(self, HVal::Prim(JsVal::Undefined))
  }

  /// `typeof value === 'object' && value !== null`
  pub(crate) fn is_object(&self) -> bool {
    matches!(self, HVal::Node(_))
  }

  /// JS `ToBoolean` (every object is truthy).
  pub(crate) fn truthy(&self) -> bool {
    match self {
      HVal::Prim(v) => v.truthy(),
      HVal::Node(_) => true,
    }
  }
}

#[derive(Debug)]
struct Node {
  is_array: bool,
  /// Array elements.
  items: Vec<HVal>,
  /// Own properties in JS order (non-index properties for arrays).
  props: IndexMap<String, HVal>,
  /// The original typed value of a `Date` node (exported unchanged).
  date: Option<JsVal>,
}

#[derive(Default)]
pub(crate) struct Heap {
  nodes: Vec<Node>,
  /// Snapshot containers handed out by [`Heap::snapshot`], by `Arc` address. The `JsVal` keeps
  /// the allocation alive, so an address is never reused while it is in this table.
  snapshots: HashMap<usize, (NodeId, JsVal)>,
  /// Whether a node was mutated after the first snapshot was taken.
  mutated_after_snapshot: bool,
}

impl Heap {
  /// Imports a value, keeping object identity (every reference to the same `Arc` becomes the
  /// same node, including cycles).
  pub(crate) fn import(&mut self, v: &JsVal) -> HVal {
    let mut memo = HashMap::new();
    self.import_with(v, &mut memo)
  }

  fn import_with(&mut self, v: &JsVal, memo: &mut HashMap<usize, NodeId>) -> HVal {
    let Some(identity) = v.identity() else { return HVal::Prim(v.clone()) };
    if let Some(id) = memo.get(&identity) {
      return HVal::Node(*id);
    }
    match v.typed() {
      Some(TypedValue::BigInt(_)) => return HVal::Prim(v.clone()),
      Some(TypedValue::Date(_)) => {
        let id = self.alloc(false, Vec::new(), IndexMap::new());
        self.nodes[id].date = Some(v.clone());
        memo.insert(identity, id);
        return HVal::Node(id);
      }
      None => {}
    }
    let id = self.alloc(matches!(v, JsVal::Arr(_)), Vec::new(), IndexMap::new());
    memo.insert(identity, id);
    match v {
      JsVal::Arr(a) => {
        let items = a.iter().map(|item| self.import_with(item, memo)).collect();
        self.nodes[id].items = items;
      }
      JsVal::Obj(o) => {
        let props = o.iter().map(|(k, item)| (k.clone(), self.import_with(item, memo))).collect();
        self.nodes[id].props = props;
      }
      _ => {}
    }
    HVal::Node(id)
  }

  fn alloc(&mut self, is_array: bool, items: Vec<HVal>, props: IndexMap<String, HVal>) -> NodeId {
    self.nodes.push(Node { is_array, items, props, date: None });
    self.nodes.len() - 1
  }

  /// A value the transform put into its output (e.g. `row._uuid`) as a heap value: the object a
  /// snapshot was taken of, or an import of a value from elsewhere.
  pub(crate) fn value_of(&mut self, v: &JsVal) -> HVal {
    match v.identity().and_then(|identity| self.snapshots.get(&identity)) {
      Some((id, _)) => HVal::Node(*id),
      None => self.import(v),
    }
  }

  /// A new plain object (`{}`).
  pub(crate) fn new_object(&mut self) -> HVal {
    HVal::Node(self.alloc(false, Vec::new(), IndexMap::new()))
  }

  /// A new array (`[...items]`).
  pub(crate) fn new_array(&mut self, items: Vec<HVal>) -> HVal {
    HVal::Node(self.alloc(true, items, IndexMap::new()))
  }

  /// `Array.isArray(value)`: the current length.
  pub(crate) fn array_len(&self, v: &HVal) -> Option<usize> {
    match v {
      HVal::Node(id) if self.nodes[*id].is_array => Some(self.nodes[*id].items.len()),
      _ => None,
    }
  }

  /// `array[i]` of an array node (`undefined` past the end).
  pub(crate) fn item(&self, v: &HVal, i: usize) -> HVal {
    match v {
      HVal::Node(id) => self.nodes[*id].items.get(i).cloned().unwrap_or(HVal::UNDEFINED),
      HVal::Prim(_) => HVal::UNDEFINED,
    }
  }

  /// `value[key]` (own properties; `TypeError` for `null` / `undefined`).
  pub(crate) fn get(&self, v: &HVal, key: &str) -> Result<HVal> {
    Ok(match v {
      HVal::Prim(p @ (JsVal::Null | JsVal::Undefined)) => {
        return Err(type_error(format!("Cannot read properties of {} (reading '{key}')", to_js_string(p))));
      }
      HVal::Prim(JsVal::Str(s)) => {
        let units: Vec<u16> = s.encode_utf16().collect();
        if key == "length" {
          HVal::Prim(JsVal::Num(units.len() as f64))
        } else if is_array_index(key) {
          match key.parse::<usize>().ok().and_then(|i| units.get(i)) {
            Some(unit) => HVal::Prim(JsVal::str(String::from_utf16_lossy(&[*unit]))),
            None => HVal::UNDEFINED,
          }
        } else {
          HVal::UNDEFINED
        }
      }
      HVal::Prim(_) => HVal::UNDEFINED,
      HVal::Node(id) => {
        let node = &self.nodes[*id];
        if node.is_array {
          if key == "length" {
            return Ok(HVal::Prim(JsVal::Num(node.items.len() as f64)));
          }
          if is_array_index(key) {
            return Ok(key.parse::<usize>().ok().and_then(|i| node.items.get(i)).cloned().unwrap_or(HVal::UNDEFINED));
          }
        }
        node.props.get(key).cloned().unwrap_or(HVal::UNDEFINED)
      }
    })
  }

  /// `Object.hasOwn(value, key)`
  pub(crate) fn has_own(&self, v: &HVal, key: &str) -> bool {
    match v {
      HVal::Prim(JsVal::Str(s)) => {
        key == "length" || (is_array_index(key) && key.parse::<usize>().is_ok_and(|i| i < s.encode_utf16().count()))
      }
      HVal::Prim(_) => false,
      HVal::Node(id) => {
        let node = &self.nodes[*id];
        (node.is_array
          && (key == "length" || (is_array_index(key) && key.parse::<usize>().is_ok_and(|i| i < node.items.len()))))
          || node.props.contains_key(key)
      }
    }
  }

  /// `key in value` (`TypeError` for primitives other than functions).
  pub(crate) fn has(&self, v: &HVal, key: &str) -> Result<bool> {
    match v {
      HVal::Node(_) => Ok(self.has_own(v, key) || OBJECT_PROTOTYPE_KEYS.contains(&key)),
      HVal::Prim(JsVal::Fn(_)) => Ok(false),
      HVal::Prim(p) => Err(in_operator_error(key, p)),
    }
  }

  /// `Object.keys(value)`
  pub(crate) fn keys(&self, v: &HVal) -> Result<Vec<String>> {
    Ok(self.entries(v)?.into_iter().map(|(k, _)| k).collect())
  }

  /// `Object.entries(value)`: a snapshot of the own enumerable properties.
  pub(crate) fn entries(&self, v: &HVal) -> Result<Vec<(String, HVal)>> {
    match v {
      HVal::Prim(JsVal::Null | JsVal::Undefined) => Err(type_error("Cannot convert undefined or null to object")),
      HVal::Prim(JsVal::Str(s)) => Ok(
        s.encode_utf16()
          .enumerate()
          .map(|(i, unit)| (i.to_string(), HVal::Prim(JsVal::str(String::from_utf16_lossy(&[unit])))))
          .collect(),
      ),
      HVal::Prim(_) => Ok(Vec::new()),
      HVal::Node(id) => {
        let node = &self.nodes[*id];
        let mut out: Vec<(String, HVal)> = node.items.iter().enumerate().map(|(i, item)| (i.to_string(), item.clone())).collect();
        out.extend(node.props.iter().map(|(k, item)| (k.clone(), item.clone())));
        Ok(out)
      }
    }
  }

  fn touch(&mut self) {
    if !self.snapshots.is_empty() {
      self.mutated_after_snapshot = true;
    }
  }

  /// `value[key] = item` in strict mode.
  pub(crate) fn set(&mut self, v: &HVal, key: &str, item: HVal) -> Result<()> {
    match v {
      HVal::Node(id) => {
        self.touch();
        let node = &mut self.nodes[*id];
        if node.is_array {
          if key == "length" {
            return set_array_length(&mut node.items, &item);
          }
          if is_array_index(key) {
            let i: usize = key.parse().unwrap_or(usize::MAX);
            if i < node.items.len() {
              node.items[i] = item;
            } else if i < node.items.len() + 1_000_000 {
              // holes are not representable; they read as `undefined` like holes do
              node.items.resize(i, HVal::UNDEFINED);
              node.items.push(item);
            } else {
              return Err(EngineError::internal("unsupported: sparse array write"));
            }
            return Ok(());
          }
        }
        js_insert(&mut node.props, key, item);
        Ok(())
      }
      HVal::Prim(p @ (JsVal::Null | JsVal::Undefined)) => {
        Err(type_error(format!("Cannot set properties of {} (setting '{key}')", to_js_string(p))))
      }
      // functions are objects; their properties are not modelled
      HVal::Prim(JsVal::Fn(_)) => Ok(()),
      HVal::Prim(p) => {
        let kind = match p {
          JsVal::Str(_) => "string",
          JsVal::Num(_) => "number",
          JsVal::Bool(_) => "boolean",
          _ => "bigint",
        };
        Err(type_error(format!("Cannot create property '{key}' on {kind} '{}'", to_js_string(p))))
      }
    }
  }

  /// `delete value[key]` in strict mode.
  pub(crate) fn delete(&mut self, v: &HVal, key: &str) -> Result<()> {
    match v {
      HVal::Node(id) => {
        let node = &self.nodes[*id];
        if node.is_array && key == "length" {
          return Err(type_error("Cannot delete property 'length' of [object Array]"));
        }
        if node.is_array && is_array_index(key) {
          // deleting an element leaves a hole, which reads as `undefined`
          let i: usize = key.parse().unwrap_or(usize::MAX);
          if i < node.items.len() {
            self.touch();
            self.nodes[*id].items[i] = HVal::UNDEFINED;
          }
          return Ok(());
        }
        if node.props.contains_key(key) {
          self.touch();
          self.nodes[*id].props.shift_remove(key);
        }
        Ok(())
      }
      HVal::Prim(JsVal::Null | JsVal::Undefined) => Err(type_error("Cannot convert undefined or null to object")),
      HVal::Prim(JsVal::Str(s)) => {
        if key == "length" || (is_array_index(key) && key.parse::<usize>().is_ok_and(|i| i < s.encode_utf16().count())) {
          Err(type_error(format!("Cannot delete property '{key}' of [object String]")))
        } else {
          Ok(())
        }
      }
      HVal::Prim(_) => Ok(()),
    }
  }

  /// The current value as plain data, registered so [`Heap::fix_up`] can bring it up to date.
  pub(crate) fn snapshot(&mut self, v: &HVal) -> JsVal {
    let mut memo = HashMap::new();
    let out = self.export_with(v, &mut memo);
    for (id, value) in memo {
      if self.nodes[id].date.is_none()
        && let Some(identity) = value.identity()
      {
        self.snapshots.insert(identity, (id, value));
      }
    }
    out
  }

  /// The final value (shares one export with [`Heap::fix_up`] through `memo`).
  pub(crate) fn export(&self, v: &HVal, memo: &mut HashMap<NodeId, JsVal>) -> JsVal {
    self.export_with(v, memo)
  }

  fn export_with(&self, v: &HVal, memo: &mut HashMap<NodeId, JsVal>) -> JsVal {
    let id = match v {
      HVal::Prim(p) => return p.clone(),
      HVal::Node(id) => *id,
    };
    if let Some(done) = memo.get(&id) {
      return done.clone();
    }
    let node = &self.nodes[id];
    if let Some(date) = &node.date {
      memo.insert(id, date.clone());
      return date.clone();
    }
    // Registered before the contents are exported, so references from inside (cycles) get the
    // same container.
    if node.is_array {
      let mut target = Arc::new(Items::default());
      memo.insert(id, JsVal::Arr(target.clone()));
      let items = Items::from(node.items.iter().map(|item| self.export_with(item, memo)).collect::<Vec<_>>());
      memo.remove(&id);
      match Arc::get_mut(&mut target) {
        Some(slot) => *slot = items,
        // SAFETY: see `fill`.
        None => unsafe { fill(&target, items) },
      }
      memo.insert(id, JsVal::Arr(target.clone()));
      JsVal::Arr(target)
    } else {
      let mut target = Arc::new(Props::default());
      memo.insert(id, JsVal::Obj(target.clone()));
      let props = Props::from(node.props.iter().map(|(k, item)| (k.clone(), self.export_with(item, memo))).collect::<Obj>());
      memo.remove(&id);
      match Arc::get_mut(&mut target) {
        Some(slot) => *slot = props,
        // SAFETY: see `fill`.
        None => unsafe { fill(&target, props) },
      }
      memo.insert(id, JsVal::Obj(target.clone()));
      JsVal::Obj(target)
    }
  }

  /// Whether output values may hold snapshots that are out of date.
  pub(crate) fn needs_fix_up(&self) -> bool {
    self.mutated_after_snapshot
  }

  /// `value` with every snapshot replaced by the final state of its object (`memo` from
  /// [`Heap::export`]). Containers built by the transform itself are rebuilt around the
  /// replacements.
  pub(crate) fn fix_up(&self, v: &JsVal, memo: &mut HashMap<NodeId, JsVal>) -> JsVal {
    let Some(identity) = v.identity() else { return v.clone() };
    if let Some((id, _)) = self.snapshots.get(&identity) {
      return self.export_with(&HVal::Node(*id), memo);
    }
    if v.typed().is_some() {
      return v.clone();
    }
    match v {
      JsVal::Arr(a) => JsVal::arr(a.iter().map(|item| self.fix_up(item, memo)).collect()),
      JsVal::Obj(o) => JsVal::obj(o.iter().map(|(k, item)| (k.clone(), self.fix_up(item, memo))).collect()),
      _ => v.clone(),
    }
  }
}

/// Writes the exported contents of a container that references from inside its own contents
/// (cycles) already point to.
///
/// SAFETY: the caller guarantees that no reference into `target`'s data exists while this runs:
/// the exporter only clones the `Arc`s of containers that are being exported (it never
/// dereferences them), and the exported graph is not visible to anyone else before the export
/// finishes. `Arc::as_ptr` derives the pointer from the allocation, so writing through it is what
/// the unstable `Arc::get_mut_unchecked` does (same as the engine decoder's `fill`).
unsafe fn fill<T>(target: &Arc<T>, value: T) {
  unsafe { *Arc::as_ptr(target).cast_mut() = value }
}

fn in_operator_error(key: &str, target: &JsVal) -> EngineError {
  type_error(format!("Cannot use 'in' operator to search for '{key}' in {}", to_js_string(target)))
}

/// `array.length = value` (`ArraySetLength`): `RangeError` unless `value` is a valid length.
fn set_array_length(items: &mut Vec<HVal>, value: &HVal) -> Result<()> {
  let n = match value {
    HVal::Prim(JsVal::Num(n)) => *n,
    HVal::Prim(JsVal::Bool(b)) => f64::from(u8::from(*b)),
    HVal::Prim(JsVal::Null) => 0.0,
    // `Number(string)` / `Number(object)` lengths are not modelled
    _ => return Err(EngineError::internal("unsupported: assigning a non-number array length")),
  };
  if !(n >= 0.0 && n.fract() == 0.0 && n <= f64::from(u32::MAX)) {
    return Err(EngineError::new("RangeError", "Invalid array length"));
  }
  let len = n as usize;
  if len > items.len() + 1_000_000 {
    return Err(EngineError::internal("unsupported: sparse array length"));
  }
  items.resize(len, HVal::UNDEFINED);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn shared_objects_stay_shared() {
    let shared = JsVal::obj(Obj::from([("id".to_string(), JsVal::str("row-1"))]));
    let root = JsVal::obj(Obj::from([("a".to_string(), shared.clone()), ("b".to_string(), shared)]));
    let mut heap = Heap::default();
    let h = heap.import(&root);
    let a = heap.get(&h, "a").unwrap();
    heap.delete(&a, "id").unwrap();
    let b = heap.get(&h, "b").unwrap();
    assert!(heap.get(&b, "id").unwrap().is_undefined());
    let out = heap.export(&h, &mut HashMap::new());
    assert!(out.get("a").strict_eq(out.get("b")));
    assert!(!out.get("a").has("id"));
  }

  #[test]
  fn cycles_round_trip() {
    let mut heap = Heap::default();
    let o = heap.new_object();
    heap.set(&o, "self", o.clone()).unwrap();
    let out = heap.export(&o, &mut HashMap::new());
    assert!(out.get("self").strict_eq(&out));
    assert!(out.is_circular());
  }
}
