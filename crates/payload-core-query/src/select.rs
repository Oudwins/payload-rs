//! `getSelectMode`, `sanitizeSelect`, `resolveSelect`,
//! `stripUnselectedFields`, `getQueryDraftsSelect`.

use payload_engine::fields::field_affects_data;
use payload_engine::js::JsVal;
use payload_sql_read::Val;

use crate::js::{JsError, JsResult, for_in_keys, get, has_in, is_object_type, new_obj, set};
use crate::paths::find_field;

/// Calls an entity `select` function synchronously: `config({ operation, req, select })`.
pub trait SelectHost {
  fn call_select(&self, function: &JsVal, operation: &str, select: &Val) -> JsResult<Val>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectMode {
  Include,
  Exclude,
}

impl SelectMode {
  pub fn as_str(self) -> &'static str {
    match self {
      SelectMode::Include => "include",
      SelectMode::Exclude => "exclude",
    }
  }
}

/// `getSelectMode(select)`
pub fn get_select_mode(select: &Val) -> SelectMode {
  for key in for_in_keys(select) {
    let value = get(select, &key).unwrap_or_default();
    if matches!(value, Val::Bool(false)) {
      return SelectMode::Exclude;
    }
    if is_object_type(&value) {
      return get_select_mode(&value);
    }
  }
  SelectMode::Include
}

fn is_relationship_or_upload(field: &JsVal) -> bool {
  matches!(field.get("type").as_str(), Some("relationship" | "upload"))
}

fn virtual_path(field: &JsVal) -> Option<String> {
  match field.get("virtual") {
    JsVal::Str(s) if field.has("virtual") => Some(s.to_string()),
    _ => None,
  }
}

fn strip_virtual_path_to_current_collection(fields: &JsVal, path: &str, versions: bool) -> JsResult<String> {
  let mut result_segments: Vec<String> = Vec::new();
  let mut fields = fields.clone();
  if versions {
    result_segments.push("version".into());
    if let Some(version_field) = find_field(&fields, "version")?
      && version_field.get("type").as_str() == Some("group")
    {
      fields = version_field.get("flattenedFields").clone();
    }
  }
  for segment in path.split('.') {
    let Some(field) = find_field(&fields, segment)? else {
      continue;
    };
    result_segments.push(segment.to_string());
    if is_relationship_or_upload(&field) {
      return Ok(result_segments.join("."));
    }
  }
  Ok(result_segments.join("."))
}

fn get_all_virtual_relations(fields: &JsVal) -> JsResult<Vec<String>> {
  let mut result = Vec::new();
  if fields.is_nullish() {
    return Err(JsError::type_error(format!("{} is not iterable", fields.to_js_string())));
  }
  for field in fields.items() {
    if let Some(v) = virtual_path(field) {
      result.push(v);
    } else if matches!(field.get("type").as_str(), Some("group" | "tab")) {
      result.extend(get_all_virtual_relations(field.get("flattenedFields"))?);
    }
  }
  Ok(result)
}

fn resolve_virtual_relations_to_select(
  fields: &JsVal,
  select_value: &Val,
  top_level_fields: &JsVal,
  versions: bool,
) -> JsResult<Vec<String>> {
  let mut result = Vec::new();
  if matches!(select_value, Val::Bool(true)) {
    for item in get_all_virtual_relations(fields)? {
      result.push(strip_virtual_path_to_current_collection(top_level_fields, &item, versions)?);
    }
    return Ok(result);
  }
  for field_name in for_in_keys(select_value) {
    let Some(field) = find_field(fields, &field_name)? else {
      continue;
    };
    if let Some(v) = virtual_path(&field) {
      result.push(strip_virtual_path_to_current_collection(top_level_fields, &v, versions)?);
    } else if matches!(field.get("type").as_str(), Some("group" | "tab")) {
      let nested = get(select_value, &field_name)?;
      for item in resolve_virtual_relations_to_select(field.get("flattenedFields"), &nested, top_level_fields, versions)? {
        result.push(strip_virtual_path_to_current_collection(top_level_fields, &item, versions)?);
      }
    }
  }
  Ok(result)
}

/// `sanitizeSelect({ fields, select, versions })` (mutates and returns `select`).
pub fn sanitize_select(fields: &JsVal, select: &Val, versions: bool) -> JsResult<Val> {
  if !select.truthy() {
    return Ok(select.clone());
  }
  if get_select_mode(select) == SelectMode::Exclude {
    return Ok(select.clone());
  }
  let virtual_relations = resolve_virtual_relations_to_select(fields, select, fields, versions)?;
  for path in virtual_relations {
    let mut current = select.clone();
    let segments: Vec<&str> = path.split('.').collect();
    for (i, segment) in segments.iter().enumerate() {
      if i == segments.len() - 1 {
        set(&current, segment, Val::Bool(true))?;
      } else if !has_in(&current, segment)? {
        set(&current, segment, Val::new_obj())?;
        current = get(&current, segment)?;
      }
    }
  }
  Ok(select.clone())
}

/// `resolveSelect({ config, operation, req, select })`
pub fn resolve_select(host: &dyn SelectHost, config: &JsVal, operation: &str, select: &Val) -> JsResult<Val> {
  if !config.is_fn() {
    return Ok(select.clone());
  }
  let resolved = host.call_select(config, operation, select)?;
  Ok(if resolved.is_nullish() { select.clone() } else { resolved })
}

/// `stripUnselectedFields({ field, select, selectMode, siblingDoc })`
/// (mutates `siblingDoc`, returns whether the traversal should continue).
pub fn strip_unselected_fields(field: &JsVal, select: &Val, select_mode: Option<SelectMode>, sibling_doc: &Val) -> JsResult<bool> {
  let mut should_continue = true;
  let name = field.get("name");
  if field_affects_data(field) && select.truthy() && select_mode.is_some() && name.truthy() {
    let name = name.to_js_string();
    let selected = get(select, &name)?;
    match select_mode {
      Some(SelectMode::Include) if !selected.truthy() => {
        crate::js::delete(sibling_doc, &name)?;
        should_continue = false;
      }
      Some(SelectMode::Exclude) if matches!(selected, Val::Bool(false)) => {
        crate::js::delete(sibling_doc, &name)?;
        should_continue = false;
      }
      _ => {}
    }
  }
  Ok(should_continue)
}

/// `getQueryDraftsSelect({ select })`
pub fn get_query_drafts_select(select: &Val) -> Val {
  if !select.truthy() {
    return Val::Undefined;
  }
  match get_select_mode(select) {
    SelectMode::Include => {
      new_obj([("parent".to_string(), Val::Bool(true)), ("version".to_string(), select.clone())])
    }
    SelectMode::Exclude => new_obj([("version".to_string(), select.clone())]),
  }
}
