//! Port of packages/drizzle/src/upsertRow/shouldUseOptimizedUpsertRow.ts.

use payload_engine::error::{EngineError, Result};
use payload_engine::js::{JsVal, Obj};
use payload_sql_write::js::to_js_string;

/// Keys visited by `for (const key in value)` (no inherited enumerable keys
/// exist on plain data).
fn for_in_keys(value: &JsVal) -> Vec<String> {
  match value {
    JsVal::Obj(o) => o.keys().cloned().collect(),
    JsVal::Arr(a) => (0..a.len()).map(|i| i.to_string()).collect(),
    JsVal::Str(s) => (0..s.encode_utf16().count()).map(|i| i.to_string()).collect(),
    _ => vec![],
  }
}

/// `value[key]` for the keys produced by [`for_in_keys`].
fn member<'a>(value: &'a JsVal, key: &str) -> JsVal {
  match value {
    JsVal::Arr(a) => key.parse::<usize>().ok().and_then(|i| a.get(i).cloned()).unwrap_or_default(),
    JsVal::Str(s) => {
      let units: Vec<u16> = s.encode_utf16().collect();
      key.parse::<usize>().ok().and_then(|i| units.get(i)).map(|u| JsVal::str(String::from_utf16_lossy(&[*u]))).unwrap_or_default()
    }
    other => other.get(key).clone(),
  }
}

/// `fields.find((each) => each.name === key)`
fn find_field<'a>(fields: &'a JsVal, name: &str) -> Result<Option<&'a JsVal>> {
  match fields {
    JsVal::Arr(a) => Ok(a.iter().find(|f| f.get("name").as_str() == Some(name))),
    other => Err(EngineError::new(
      "TypeError",
      if other.is_nullish() {
        format!("Cannot read properties of {} (reading 'find')", to_js_string(other))
      } else {
        "fields.find is not a function".to_string()
      },
    )),
  }
}

/// `'$push' in value` for a `typeof value === 'object'` value.
fn has_in(value: &JsVal, key: &str) -> Result<bool> {
  match value {
    JsVal::Null => Err(EngineError::new("TypeError", format!("Cannot use 'in' operator to search for '{key}' in null"))),
    JsVal::Obj(o) => Ok(o.contains_key(key)),
    _ => Ok(false),
  }
}

/// `shouldUseOptimizedUpsertRow({ data, fields })`
pub fn should_use_optimized_upsert_row(data: &JsVal, fields: &JsVal) -> Result<bool> {
  let mut fields_matched = false;

  for key in for_in_keys(data) {
    let value = member(data, &key);
    let Some(field) = find_field(fields, &key)? else { continue };
    fields_matched = true;

    let ty = field.get("type").as_str().unwrap_or("");
    let has_many = field.get("hasMany").truthy();
    let is_rel = ty == "relationship" || ty == "upload";
    if ty == "blocks"
      || (matches!(ty, "text" | "relationship" | "upload" | "select" | "number") && has_many)
      || (is_rel && field.get("relationTo").as_arr().is_some())
      || field.get("localized").truthy()
    {
      return Ok(false);
    }

    if ty == "array" {
      if value.is_object_like() && has_in(&value, "$push")? && value.get("$push").truthy() {
        let push = value.get("$push");
        let first = match push {
          JsVal::Arr(a) => a.first().cloned().unwrap_or_default(),
          other => other.clone(),
        };
        return should_use_optimized_upsert_row(&first, field.get("flattenedFields"));
      }
      return Ok(false);
    }

    if is_rel && has_many && value.is_object_like() && (has_in(&value, "$push")? || has_in(&value, "$remove")?) {
      return Ok(false);
    }

    if (ty == "group" || ty == "tab")
      && value.truthy()
      && value.is_object_like()
      && !should_use_optimized_upsert_row(&value, field.get("flattenedFields"))?
    {
      return Ok(false);
    }
  }

  if !fields_matched {
    for key in for_in_keys(data) {
      if let Some(dot) = key.find('.') {
        let field_name = &key[..dot];
        let remaining = &key[dot + 1..];
        let mut inner = Obj::new();
        inner.insert(remaining.to_string(), member(data, &key));
        let mut nested = Obj::new();
        nested.insert(field_name.to_string(), JsVal::obj(inner));
        return should_use_optimized_upsert_row(&JsVal::obj(nested), fields);
      }
    }
  }

  Ok(true)
}
