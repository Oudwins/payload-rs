//! Compiled user functions on the write path (FN_COMPILE_CONTRACT.md, FUSED_WRITES.md section
//! 12.7): the argument objects upstream builds for them, from the call's heap at the moment of
//! the call, and their evaluation in Rust. Anything the snapshot does not hold bails (the exact
//! lane calls the JS function).

use std::collections::HashMap;
use std::sync::Arc;

use payload_engine::js::{JsVal, Obj as JsObj};
use payload_fn_ir::{Object as FnObject, Value as FnValue, lanes};
use serde_json::Value as Json;

use super::Bail;
use super::heap::V;
use super::plan::UserFn;
use super::run::Run;

/// `req` for compiled functions from the dispatch's typed snapshot, without `context` (the
/// operation's own hooks write to it while it runs: reading it bails).
pub fn request_value(snapshot: &Json) -> Result<FnValue, Bail> {
  let value = lanes::from_typed(&JsVal::from_json(snapshot)).ok_or_else(|| Bail::new("request:req"))?;
  Ok(match value {
    FnValue::Object(o) if !o.closed => {
      let mut o = (*o).clone();
      o.props.shift_remove("context");
      FnValue::Object(Arc::new(o))
    }
    // not a partial snapshot of an object: nothing to read
    _ => return Err(Bail::new("request:req")),
  })
}

/// Where a field's function is called: its sibling data and doc, the enclosing block row
/// (`None`: not known at this call site, reading it bails), its name and path.
pub struct FieldCall<'a> {
  pub sibling_data: &'a V,
  pub sibling_doc: &'a V,
  pub block_data: Option<&'a V>,
  pub name: &'a str,
  pub path: &'a str,
}

/// A field hook's call: the field's place, the traversal's top-level `data` and `doc`
/// (`originalDoc`), beforeChange's `siblingDocWithLocales`, and the `value` it is given.
pub struct HookCall<'a> {
  pub field: FieldCall<'a>,
  pub data: &'a V,
  pub doc: &'a V,
  pub sibling_doc_with_locales: Option<&'a V>,
  pub value: &'a V,
}

/// One key of the argument object: a value exported from the heap (converted together, so
/// shared objects stay shared) or a value of its own.
enum Slot {
  Heap(usize),
  Own(FnValue),
}

/// The values of one call's arguments taken from the heap: exported with one memo and converted
/// together, so objects shared in JS are shared (`===`) for the compiled function too.
struct HeapArgs<'h> {
  heap: std::cell::Ref<'h, super::heap::Heap>,
  memo: HashMap<super::heap::Ref, JsVal>,
  values: Vec<JsVal>,
}

impl HeapArgs<'_> {
  fn export(&mut self, value: &V) -> JsVal {
    self.heap.export_shared(value, &mut self.memo)
  }

  fn push(&mut self, value: JsVal) -> Slot {
    self.values.push(value);
    Slot::Heap(self.values.len() - 1)
  }

  fn slot(&mut self, value: &V) -> Slot {
    let exported = self.export(value);
    self.push(exported)
  }

  /// `deepMergeWithSourceArrays(target, source)` of two heap values.
  fn merged(&mut self, target: &V, source: &V) -> Result<Slot, Bail> {
    let target = self.export(target);
    let source = self.export(source);
    Ok(self.push(deep_merge(&target, &source)?))
  }

  /// The converted values and the argument object of `slots` (only the keys the function reads
  /// are known: a partial object).
  fn finish(self, slots: Vec<(Arc<str>, Slot)>) -> Result<(Vec<FnValue>, FnValue), Bail> {
    drop(self.heap);
    let FnValue::Array(converted) = FnValue::from_js_val(&JsVal::arr(self.values)) else {
      return Err(Bail::new("fn:args"));
    };
    let mut object = FnObject::closed();
    object.closed = false;
    for (key, slot) in slots {
      object.set(key, match slot {
        Slot::Heap(index) => converted[index].clone(),
        Slot::Own(value) => value,
      });
    }
    Ok(((*converted).clone(), FnValue::Object(Arc::new(object))))
  }
}

/// The operation-wide keys both argument objects have; `None`: not one of them.
fn common_key(run: &Run<'_>, key: &str, call: &FieldCall<'_>) -> Result<Option<FnValue>, Bail> {
  Ok(Some(match key {
    "operation" => FnValue::str(run.operation.name()),
    "overrideAccess" => FnValue::Bool(run.override_access),
    "path" => path_segments(call.path),
    "req" => run.req.clone().ok_or_else(|| Bail::new("fn:req"))?,
    "skipCompilation" => lanes::skip_compilation(),
    _ => return Ok(None),
  }))
}

fn block_data<'a>(call: &FieldCall<'a>) -> Result<&'a V, Bail> {
  call.block_data.ok_or_else(|| Bail::new("fn:blockData"))
}

/// `await fn(...args)` resuming after one tick, or a bail.
fn evaluate(id: payload_fn_ir::FnId, args: &[FnValue]) -> Result<FnValue, Bail> {
  let (result, one_tick) = payload_fn_ir::evaluate_ticks(id, args).map_err(|bail| Bail::new(format!("fn:{}", bail.reason())))?;
  if !one_tick {
    // the awaiting traversal would resume later than one tick (the order of concurrent fields)
    return Err(Bail::new("fn:ticks"));
  }
  Ok(result)
}

/// `field.validate(value, { ...field, id, blockData, collectionSlug, data, event: 'submit',
/// jsonError, operation, overrideAccess, path, preferences: { fields: {} }, previousValue, req,
/// siblingData, skipCompilation })` (fields/hooks/beforeChange/promise.ts, one locale): the
/// error message, or `None` when valid (anything but a string). The caller awaits one tick.
pub fn validate(run: &Run<'_>, user: &UserFn, value: &V, call: &FieldCall<'_>) -> Result<Option<String>, Bail> {
  run.user_fn_lane_call(user.id)?;
  let mut heap = HeapArgs { heap: run.heap.borrow(), memo: HashMap::new(), values: Vec::new() };
  let value_slot = heap.slot(value);
  let mut slots = Vec::new();
  for key in user.keys.iter().flatten() {
    let slot = match &**key {
      "blockData" => heap.slot(block_data(call)?),
      "collectionSlug" => Slot::Own(FnValue::str(&run.plan.slug)),
      "data" => {
        let root_data = V::Ref(run.root_data.get().ok_or_else(|| Bail::new("fn:data"))?);
        heap.merged(&run.root_doc.borrow(), &root_data)?
      }
      "event" => Slot::Own(FnValue::str("submit")),
      "id" => Slot::Own(run.id.as_ref().map(FnValue::from_js_val).unwrap_or(FnValue::Undefined)),
      // set only for a json field holding a string, which bails before validation
      "jsonError" => Slot::Own(FnValue::Undefined),
      "preferences" => Slot::Own(FnValue::object(vec![("fields", FnValue::object(vec![]))])),
      "previousValue" => {
        let previous = heap.heap.get(call.sibling_doc, call.name);
        heap.slot(&previous)
      }
      "siblingData" => heap.merged(call.sibling_doc, call.sibling_data)?,
      other => Slot::Own(match common_key(run, other, call)? {
        Some(value) => value,
        None => field_prop(user, other)?,
      }),
    };
    slots.push((key.clone(), slot));
  }
  let (converted, options) = heap.finish(slots)?;
  let Slot::Heap(value_index) = value_slot else { return Err(Bail::new("fn:args")) };
  let mut args = vec![converted[value_index].clone()];
  if user.keys.is_some() {
    args.push(options);
  }
  Ok(match evaluate(user.id, &args)? {
    FnValue::String(message) => Some(message.to_string()),
    _ => None,
  })
}

/// A field `beforeValidate` / `beforeChange` hook: `hook({ blockData, collection, data, field,
/// global: null, operation, originalDoc, overrideAccess, path, previousSiblingDoc, previousValue,
/// req, siblingData, siblingDocWithLocales (beforeChange), skipCompilation, value, ... })`
/// (fields/hooks/{beforeValidate,beforeChange}/promise.ts; writePlan.ts refuses functions reading
/// the other keys). The value upstream assigns to `siblingData[field.name]` (`None`: the hook
/// returned `undefined`, nothing is assigned): a primitive, or `value` itself; any other object
/// bails (JS would assign that object, shared with whatever the hook took it from). The caller
/// awaits one tick.
pub fn field_hook(run: &Run<'_>, user: &UserFn, call: &HookCall<'_>) -> Result<Option<V>, Bail> {
  run.user_fn_lane_call(user.id)?;
  let field = &call.field;
  let mut heap = HeapArgs { heap: run.heap.borrow(), memo: HashMap::new(), values: Vec::new() };
  let value_slot = heap.slot(call.value);
  let mut slots = Vec::new();
  for key in user.keys.iter().flatten() {
    let slot = match &**key {
      "blockData" => heap.slot(block_data(field)?),
      "collection" => Slot::Own(FnValue::partial_object(vec![("slug", FnValue::str(&run.plan.slug))])),
      "data" => heap.slot(call.data),
      "global" => Slot::Own(FnValue::Null),
      "originalDoc" => heap.slot(call.doc),
      "previousSiblingDoc" => heap.slot(field.sibling_doc),
      "previousValue" => {
        let previous = heap.heap.get(field.sibling_doc, field.name);
        heap.slot(&previous)
      }
      "siblingData" => heap.slot(field.sibling_data),
      "siblingDocWithLocales" => heap.slot(call.sibling_doc_with_locales.ok_or_else(|| Bail::new("fn:key"))?),
      "value" => match value_slot {
        Slot::Heap(index) => Slot::Heap(index),
        Slot::Own(_) => return Err(Bail::new("fn:args")),
      },
      other => Slot::Own(match common_key(run, other, field)? {
        Some(value) => value,
        None => field_prop(user, other)?,
      }),
    };
    slots.push((key.clone(), slot));
  }
  let (converted, args) = heap.finish(slots)?;
  let Slot::Heap(value_index) = value_slot else { return Err(Bail::new("fn:args")) };
  let given = &converted[value_index];
  let args = if user.keys.is_some() { vec![args] } else { vec![] };
  Ok(match evaluate(user.id, &args)? {
    FnValue::Undefined => None,
    FnValue::Null => Some(V::Null),
    FnValue::Bool(b) => Some(V::Bool(b)),
    FnValue::Number(n) => Some(V::Num(n)),
    FnValue::String(s) => Some(V::str(&s)),
    result if is_same_object(&result, given) => Some(call.value.clone()),
    _ => return Err(Bail::new("fn:hook:result")),
  })
}

/// `a === b` for two objects / arrays.
fn is_same_object(a: &FnValue, b: &FnValue) -> bool {
  match (a, b) {
    (FnValue::Object(a), FnValue::Object(b)) => Arc::ptr_eq(a, b),
    (FnValue::Array(a), FnValue::Array(b)) => Arc::ptr_eq(a, b),
    _ => false,
  }
}

/// A key of `{ ...field }` the function reads (the plan's snapshot).
fn field_prop(user: &UserFn, key: &str) -> Result<FnValue, Bail> {
  user.props.iter().find(|(k, _)| &**k == key).map(|(_, v)| v.clone()).ok_or_else(|| Bail::new("fn:key"))
}

/// `path.split('.')`
fn path_segments(path: &str) -> FnValue {
  if path.is_empty() {
    return FnValue::Array(Arc::new(vec![]));
  }
  FnValue::Array(Arc::new(path.split('.').map(FnValue::str).collect()))
}

/// The properties `key in object` finds on `Object.prototype` (deepmerge's `propertyIsUnsafe`).
const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
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

/// deepmerge's `isMergeableObject` (is-mergeable-object): objects and arrays, not `Date`s.
/// Other typed values (ObjectIds, ...) bail: deepmerge would copy their own properties.
fn is_mergeable(value: &JsVal) -> Result<bool, Bail> {
  match value {
    JsVal::Arr(_) => Ok(true),
    JsVal::Obj(_) if value.as_date().is_some() => Ok(false),
    JsVal::Obj(_) if value.typed().is_some() || value.bson().is_some() || value.as_host_object().is_some() => {
      Err(Bail::new("fn:merge:typed"))
    }
    JsVal::Obj(_) => Ok(true),
    _ => Ok(false),
  }
}

/// `deepMergeWithSourceArrays(target, source)` (payload `utilities/deepMerge.ts`: deepmerge with
/// `arrayMerge: (_, source) => source`): objects copied, arrays of `source` kept as they are.
pub fn deep_merge(target: &JsVal, source: &JsVal) -> Result<JsVal, Bail> {
  let source_is_array = matches!(source, JsVal::Arr(_));
  if source_is_array != matches!(target, JsVal::Arr(_)) {
    return clone_unless_otherwise_specified(source);
  }
  if source_is_array {
    return Ok(source.clone());
  }
  merge_object(target, source)
}

fn clone_unless_otherwise_specified(value: &JsVal) -> Result<JsVal, Bail> {
  if !is_mergeable(value)? {
    return Ok(value.clone());
  }
  match value {
    // `deepmerge([], value)`: `arrayMerge` returns `value`
    JsVal::Arr(_) => Ok(value.clone()),
    _ => merge_object(&JsVal::obj(JsObj::new()), value),
  }
}

fn merge_object(target: &JsVal, source: &JsVal) -> Result<JsVal, Bail> {
  let mut destination = JsObj::new();
  // `propertyIsOnObject(target, key)` (`key in target`; a primitive throws, which is `false`)
  let target_props = match target {
    JsVal::Obj(_) if target.as_date().is_some() => {
      if source.as_obj().is_some_and(|o| !o.is_empty()) {
        // `key in date` also finds `Date.prototype`'s properties
        return Err(Bail::new("fn:merge:date"));
      }
      None
    }
    JsVal::Obj(_) => {
      let props = target.as_obj().ok_or_else(|| Bail::new("fn:merge"))?;
      if is_mergeable(target)? {
        for (key, value) in props.iter() {
          destination.insert(key.clone(), clone_unless_otherwise_specified(value)?);
        }
      }
      Some(props)
    }
    _ => None,
  };
  let Some(source_props) = source.as_obj() else {
    return Ok(JsVal::obj(destination));
  };
  for (key, value) in source_props.iter() {
    let own = target_props.and_then(|props| props.get(key));
    let on_target = target_props.is_some() && (own.is_some() || OBJECT_PROTOTYPE_KEYS.contains(&key.as_str()));
    if on_target && own.is_none() {
      // `propertyIsUnsafe`: inherited, skipped
      continue;
    }
    let merged = match own {
      Some(existing) if is_mergeable(value)? => deep_merge(existing, value)?,
      _ => clone_unless_otherwise_specified(value)?,
    };
    destination.insert(key.clone(), merged);
  }
  Ok(JsVal::obj(destination))
}
