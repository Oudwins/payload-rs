//! `flattenAllFields` / `flattenBlock` (packages/payload/src/utilities/flattenAllFields.ts).
//!
//! Spreads are reproduced as JS does them: `{ ...field, flattenedFields }` copies the own keys in
//! order and appends `flattenedFields` (or overwrites it in place when the field has one).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use payload_engine::error::Result;
use payload_engine::fields::{field_affects_data, tab_has_name};
use payload_engine::js::{Items, JsVal, Obj};

use crate::value::type_error;

/// `{ ...value, [key]: item, ... }`
pub fn spread_with(value: &JsVal, extra: Vec<(&str, JsVal)>) -> JsVal {
  let mut out: Obj = value.as_obj().cloned().unwrap_or_default();
  for (k, v) in extra {
    out.insert(k.to_string(), v);
  }
  JsVal::obj(out)
}

fn iterate(fields: &JsVal) -> Result<&[JsVal]> {
  fields.as_arr().ok_or_else(|| type_error("fields is not iterable"))
}

/// `flattenBlock({ block })`
pub fn flatten_block(block: &JsVal) -> Result<JsVal> {
  Ok(spread_with(block, vec![("flattenedFields", flatten_all_fields(block.get("fields"))?)]))
}

/// `flattenAllFields({ fields })` (as an array value).
pub fn flatten_all_fields(fields: &JsVal) -> Result<JsVal> {
  let mut result = Vec::new();
  for field in iterate(fields)? {
    match field.get("type").as_str().unwrap_or("") {
      "array" | "group" => {
        if field_affects_data(field) {
          result.push(spread_with(field, vec![("flattenedFields", flatten_all_fields(field.get("fields"))?)]));
        } else {
          result.extend(flatten_all_fields(field.get("fields"))?.items().cloned());
        }
      }
      "blocks" => {
        let mut blocks = Vec::new();
        for block in iterate(field.get("blocks")).map_err(|_| type_error("field.blocks is not iterable"))? {
          if block.as_str().is_some() {
            blocks.push(block.clone());
            continue;
          }
          blocks.push(flatten_block(block)?);
        }
        result.push(spread_with(field, vec![("blocks", JsVal::arr(blocks))]));
      }
      "collapsible" | "row" => result.extend(flatten_all_fields(field.get("fields"))?.items().cloned()),
      "join" => result.push(field.clone()),
      "tabs" => {
        for tab in iterate(field.get("tabs")).map_err(|_| type_error("field.tabs is not iterable"))? {
          if !tab_has_name(tab) {
            result.extend(flatten_all_fields(tab.get("fields"))?.items().cloned());
          } else {
            result.push(spread_with(
              tab,
              vec![("type", JsVal::str("tab")), ("flattenedFields", flatten_all_fields(tab.get("fields"))?)],
            ));
          }
        }
      }
      "ui" => {}
      _ => result.push(field.clone()),
    }
  }
  Ok(JsVal::arr(result))
}

/// `flattenAllFields({ cache: true, fields })`: results cached by the identity of `fields`.
#[derive(Default)]
pub struct FlattenCache {
  entries: Mutex<HashMap<usize, (Weak<Items>, JsVal)>>,
}

impl FlattenCache {
  pub fn flatten(&self, fields: &JsVal) -> Result<JsVal> {
    let JsVal::Arr(items) = fields else {
      return flatten_all_fields(fields);
    };
    let key = Arc::as_ptr(items) as usize;
    if let Some((weak, flattened)) = self.lock().get(&key)
      && weak.strong_count() > 0
      && std::ptr::eq(weak.as_ptr(), Arc::as_ptr(items))
    {
      return Ok(flattened.clone());
    }
    let flattened = flatten_all_fields(fields)?;
    let mut entries = self.lock();
    if entries.len() > 4096 {
      entries.retain(|_, (weak, _)| weak.strong_count() > 0);
    }
    entries.insert(key, (Arc::downgrade(items), flattened.clone()));
    Ok(flattened)
  }

  fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<usize, (Weak<Items>, JsVal)>> {
    self.entries.lock().unwrap_or_else(|e| e.into_inner())
  }
}
