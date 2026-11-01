//! Port of `expandOwnDottedKey` / `setOwnProperty` from
//! `packages/payload/src/utilities/fieldPath.ts`, on the transform's [`Heap`].

use payload_engine::error::{EngineError, Result};
use payload_engine::js::JsVal;

use crate::heap::{HVal, Heap};
use crate::js::to_js_string;
use crate::js::type_error;

/// `setOwnProperty({ key, target, value })`
fn set_own_property(heap: &mut Heap, target: &HVal, key: &str, value: HVal) -> Result<()> {
  match target {
    // `Object.hasOwn(target, key) || !(key in target)` -> `Reflect.set`, otherwise
    // `Object.defineProperty`: both create / overwrite the own data property here.
    HVal::Node(_) => heap.set(target, key, value),
    HVal::Prim(JsVal::Null | JsVal::Undefined) => Err(type_error("Cannot convert undefined or null to object")),
    // functions are objects; their properties are not modelled
    HVal::Prim(JsVal::Fn(_)) => Ok(()),
    // an own index / `length` of a string: `Reflect.set` on a primitive
    HVal::Prim(JsVal::Str(_)) if heap.has_own(target, key) => {
      Err(EngineError::new("TypeError", "Reflect.set called on non-object"))
    }
    // `key in primitive` throws before anything is assigned
    HVal::Prim(other) => {
      Err(type_error(format!("Cannot use 'in' operator to search for '{key}' in {}", to_js_string(other))))
    }
  }
}

/// `expandOwnDottedKey({ key, target })`: moves `target['a.b']` to `target.a['b']`, returning
/// whether the key was expanded.
pub(crate) fn expand_own_dotted_key(heap: &mut Heap, key: &str, target: &HVal) -> Result<bool> {
  if !heap.has_own(target, key) || !key.contains('.') {
    return Ok(false);
  }

  if key.split('.').any(|segment| segment == "__proto__") {
    heap.delete(target, key)?;
    return Ok(false);
  }

  let (field_name, remaining_path) = key.split_once('.').unwrap_or((key, ""));

  if !heap.has_own(target, field_name) || !heap.get(target, field_name)?.truthy() {
    let empty = heap.new_object();
    set_own_property(heap, target, field_name, empty)?;
  }

  let nested_target = heap.get(target, field_name)?;
  let value = heap.get(target, key)?;
  set_own_property(heap, &nested_target, remaining_path, value)?;
  heap.delete(target, key)?;

  Ok(true)
}
