//! Port of `expandOwnDottedKey` / `setOwnProperty` from
//! `packages/payload/src/utilities/fieldPath.ts`.

use payload_engine::error::Result;
use payload_engine::js::{JsVal, Obj};

use crate::js::{self, is_array_index, to_js_string, type_error};

/// `Object.hasOwn(target, key)`
fn has_own(target: &JsVal, key: &str) -> bool {
  match target {
    JsVal::Obj(o) => o.contains_key(key),
    JsVal::Arr(a) => key == "length" || (is_array_index(key) && key.parse::<usize>().is_ok_and(|i| i < a.len())),
    JsVal::Str(s) => {
      key == "length" || (is_array_index(key) && key.parse::<usize>().is_ok_and(|i| i < s.encode_utf16().count()))
    }
    _ => false,
  }
}

/// `setOwnProperty({ key, target, value })` for the targets reachable here.
fn set_own_property(target: &mut JsVal, key: &str, value: JsVal) -> Result<()> {
  match target {
    JsVal::Obj(_) | JsVal::Arr(_) | JsVal::Null | JsVal::Undefined => js::set(target, key, value),
    JsVal::Fn(_) => Ok(()),
    // `key in primitive` throws before anything is assigned.
    other => Err(type_error(format!("Cannot use 'in' operator to search for '{key}' in {}", to_js_string(other)))),
  }
}

/// `expandOwnDottedKey({ key, target })`: moves `target['a.b']` to
/// `target.a['b']`, returning whether the key was expanded.
pub fn expand_own_dotted_key(key: &str, target: &mut JsVal) -> Result<bool> {
  if !has_own(target, key) || !key.contains('.') {
    return Ok(false);
  }

  if key.split('.').any(|segment| segment == "__proto__") {
    js::delete(target, key)?;
    return Ok(false);
  }

  let (field_name, remaining_path) = key.split_once('.').unwrap_or((key, ""));

  if !has_own(target, field_name) || !target.get(field_name).truthy() {
    set_own_property(target, field_name, JsVal::obj(Obj::new()))?;
  }

  let value = js::get(target, key)?.clone();
  if let Some(nested_target) = js::get_mut(target, field_name) {
    set_own_property(nested_target, remaining_path, value)?;
  }
  js::delete(target, key)?;

  Ok(true)
}
