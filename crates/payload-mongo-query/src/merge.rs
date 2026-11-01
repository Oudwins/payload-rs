//! `deepMergeWithCombinedArrays(target, source, { clone: false })` from payload
//! (`deepmerge` 4 with payload's `arrayMerge`), as `parseParams` uses it.
//!
//! `deepmerge`'s `isMergeableObject` accepts every non-null object except `RegExp`s and `Date`s,
//! so a bson `ObjectId` merged into another one becomes a plain object of its own enumerable
//! properties (`i0`..`i3`), like upstream.

use payload_engine::error::Result;
use payload_engine::js::JsVal;

use crate::js::{JsObj, OBJECT_PROTOTYPE_KEYS, is_array_index, object_id_own_entries, unsupported};
use payload_engine::bson::BsonValue;
use payload_engine::js::TypedValue;

/// `is-mergeable-object`: `!!value && typeof value === 'object'`, not a `RegExp` / `Date`.
fn is_mergeable(v: &JsVal) -> bool {
  match v {
    JsVal::Arr(_) => true,
    JsVal::Obj(_) => {
      if matches!(v.typed(), Some(TypedValue::Date(_)) | Some(TypedValue::BigInt(_))) {
        return false;
      }
      !matches!(v.bson(), Some(BsonValue::RegExp { .. }))
    }
    _ => false,
  }
}

/// `Object.keys(value)` + own enumerable symbols, as `deepmerge`'s `getKeys`.
fn own_entries(v: &JsVal) -> Result<Vec<(String, JsVal)>> {
  if let Some(bson) = v.bson() {
    return match bson {
      BsonValue::ObjectId(bytes) => Ok(object_id_own_entries(&bytes)),
      _ => Err(unsupported("deep merging a bson value other than ObjectId")),
    };
  }
  if v.as_host_object().is_some() {
    return Err(unsupported("deep merging a host object"));
  }
  match v {
    JsVal::Obj(o) => Ok(o.iter().map(|(k, item)| (k.clone(), item.clone())).collect()),
    JsVal::Arr(a) => Ok(a.iter().enumerate().map(|(i, item)| (i.to_string(), item.clone())).collect()),
    _ => Ok(Vec::new()),
  }
}

/// `propertyIsOnObject(object, key)`: `key in object`, `false` where `in` throws.
fn property_is_on_object(v: &JsVal, key: &str) -> Result<bool> {
  match v {
    JsVal::Obj(o) => {
      if let Some(BsonValue::ObjectId(_)) = v.bson() {
        return Ok(matches!(key, "i0" | "i1" | "i2" | "i3") || OBJECT_PROTOTYPE_KEYS.contains(&key));
      }
      if v.typed().is_some() || v.bson().is_some() || v.as_host_object().is_some() {
        return Err(unsupported("deep merging into a typed value"));
      }
      Ok(o.contains_key(key) || OBJECT_PROTOTYPE_KEYS.contains(&key))
    }
    JsVal::Arr(_) => crate::js::js_in(key, v),
    JsVal::Fn(_) => Err(unsupported("deep merging into a function")),
    _ => Ok(false),
  }
}

fn has_own_enumerable(v: &JsVal, key: &str) -> bool {
  match v {
    JsVal::Obj(o) => match v.bson() {
      Some(BsonValue::ObjectId(_)) => matches!(key, "i0" | "i1" | "i2" | "i3"),
      _ => o.contains_key(key),
    },
    JsVal::Arr(a) => is_array_index(key) && key.parse::<usize>().is_ok_and(|i| i < a.len()),
    _ => false,
  }
}

/// `propertyIsUnsafe`: on the object (own or inherited) but not an own enumerable property.
fn property_is_unsafe(target: &JsVal, key: &str) -> Result<bool> {
  Ok(property_is_on_object(target, key)? && !has_own_enumerable(target, key))
}

/// `target[key]` for the merge (own properties; inherited ones are skipped as unsafe before).
fn read(v: &JsVal, key: &str) -> JsVal {
  match v {
    JsVal::Arr(a) => key.parse::<usize>().ok().and_then(|i| a.get(i)).cloned().unwrap_or_default(),
    JsVal::Obj(_) => match v.bson() {
      Some(BsonValue::ObjectId(bytes)) => {
        object_id_own_entries(&bytes).into_iter().find(|(k, _)| k == key).map(|(_, v)| v).unwrap_or_default()
      }
      _ => v.get(key).clone(),
    },
    _ => JsVal::Undefined,
  }
}

/// `deepMergeWithCombinedArrays(target, source, { clone: false })`
pub fn deep_merge_with_combined_arrays(target: &JsVal, source: &JsVal) -> Result<JsVal> {
  deepmerge(target, source)
}

fn deepmerge(target: &JsVal, source: &JsVal) -> Result<JsVal> {
  let source_is_array = matches!(source, JsVal::Arr(_));
  let target_is_array = matches!(target, JsVal::Arr(_));
  if source_is_array != target_is_array {
    // cloneUnlessOtherwiseSpecified with `clone: false`
    Ok(source.clone())
  } else if source_is_array {
    array_merge(target, source)
  } else {
    merge_object(target, source)
  }
}

fn merge_object(target: &JsVal, source: &JsVal) -> Result<JsVal> {
  let mut destination = JsObj::new();
  if is_mergeable(target) {
    for (key, value) in own_entries(target)? {
      destination.set(key, value);
    }
  }
  for (key, value) in own_entries(source)? {
    if property_is_unsafe(target, &key)? {
      continue;
    }
    if property_is_on_object(target, &key)? && is_mergeable(&value) {
      let merged = deepmerge(&read(target, &key), &value)?;
      destination.set(key, merged);
    } else {
      destination.set(key, value);
    }
  }
  Ok(destination.into_val())
}

/// payload's `arrayMerge` of `deepMergeWithCombinedArrays`.
fn array_merge(target: &JsVal, source: &JsVal) -> Result<JsVal> {
  let target_items = target.as_arr().unwrap_or(&[]);
  let mut destination: Vec<JsVal> = target_items.to_vec();
  for (index, item) in source.items().enumerate() {
    if destination.get(index).is_none_or(JsVal::is_undefined) {
      set_index(&mut destination, index, item.clone());
    } else if is_mergeable(item) {
      let merged = deepmerge(target_items.get(index).unwrap_or(&JsVal::Undefined), item)?;
      set_index(&mut destination, index, merged);
    } else if !target_items.iter().any(|t| t.strict_eq(item)) {
      destination.push(item.clone());
    }
  }
  Ok(JsVal::arr(destination))
}

fn set_index(items: &mut Vec<JsVal>, index: usize, value: JsVal) {
  if index < items.len() {
    items[index] = value;
  } else {
    // `forEach` visits indices in order, so a gap can only be the slots the pushes left.
    items.resize(index, JsVal::Undefined);
    items.push(value);
  }
}
