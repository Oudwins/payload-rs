//! Synchronous `where` utilities: `combineQueries`, `sanitizeWhereQuery`,
//! `prefixWherePaths`, `appendNonTrashedFilter`, `appendVersionToQueryKey`.

use payload_engine::js::JsVal;
use payload_sql_read::Val;

use crate::config::QueryConfig;
use crate::js::{
  JsResult, delete, entries, for_in_keys, get, for_in_present, has_where_access_result, is_and_or, is_nested_relationship_query,
  new_obj, set, spread_entries, spread_iterable,
};
use crate::paths::find_field;

/// `hasManyRelationshipOperators`
pub const HAS_MANY_RELATIONSHIP_OPERATORS: [&str; 3] = ["contains", "not_equals", "equals"];

/// `combineQueries(where, access)`
pub fn combine_queries(where_: &Val, access: &Val) -> Val {
  if !where_.truthy() && !access.truthy() {
    return Val::new_obj();
  }
  let mut and = Vec::new();
  if where_.truthy() {
    and.push(where_.clone());
  }
  if has_where_access_result(access) {
    and.push(access.clone());
  }
  new_obj([("and".to_string(), Val::new_arr(and))])
}

/// `sanitizeWhereQuery({ fields, payload, where })` (mutates `where`).
pub fn sanitize_where_query(payload: &QueryConfig, fields: &JsVal, where_: &Val) -> JsResult<()> {
  for key in for_in_keys(where_) {
    if !for_in_present(where_, &key) {
      continue;
    }
    let value = get(where_, &key)?;

    if is_and_or(&key)
      && let Val::Arr(items) = &value
    {
      let items = items.borrow().to_vec();
      for item in &items {
        sanitize_where_query(payload, fields, item)?;
      }
      continue;
    }

    let mut paths: Vec<String> = key.split('.').map(str::to_string).collect();
    let mut path_has_changed = false;
    let mut current_fields = fields.clone();
    let mut final_field: Option<JsVal> = None;

    for i in 0..paths.len() {
      let Some(field) = find_field(&current_fields, &paths[i])? else {
        break;
      };
      final_field = Some(field.clone());

      if field.has("virtual")
        && let JsVal::Str(virtual_path) = field.get("virtual")
        && !virtual_path.is_empty()
      {
        paths[i] = virtual_path.to_string();
        path_has_changed = true;
      }

      if field.has("flattenedFields") {
        current_fields = field.get("flattenedFields").clone();
      }

      if matches!(field.get("type").as_str(), Some("relationship" | "upload"))
        && let JsVal::Str(relation_to) = field.get("relationTo")
        && let Some(related) = payload.collection(relation_to)
      {
        current_fields = related.get("flattenedFields").clone();
      }
    }

    sanitize_nested_has_many_relationship_queries(payload, final_field.as_ref(), &value)?;

    if path_has_changed {
      let current = get(where_, &key)?;
      set(where_, &paths.join("."), current)?;
      delete(where_, &key)?;
    }
  }
  Ok(())
}

fn sanitize_nested_has_many_relationship_queries(
  payload: &QueryConfig,
  field: Option<&JsVal>,
  value: &Val,
) -> JsResult<()> {
  let Some(field) = field else { return Ok(()) };
  if !matches!(field.get("type").as_str(), Some("relationship" | "upload"))
    || !field.get("hasMany").truthy()
    || !matches!(value, Val::Obj(_))
  {
    return Ok(());
  }
  let JsVal::Str(relation_to) = field.get("relationTo") else { return Ok(()) };
  let Some(related_fields) = payload.collection(relation_to).map(|c| c.get("flattenedFields")).filter(|f| f.truthy())
  else {
    return Ok(());
  };
  for operator in HAS_MANY_RELATIONSHIP_OPERATORS {
    let nested = get(value, operator)?;
    if is_nested_relationship_query(&nested) {
      sanitize_where_query(payload, related_fields, &nested)?;
    }
  }
  Ok(())
}

/// `prefixWherePaths({ prefix, where })`
pub fn prefix_where_paths(prefix: &str, where_: &Val) -> JsResult<Val> {
  let out = Val::new_obj();
  for (key, value) in entries(where_)? {
    if is_and_or(&key)
      && let Val::Arr(items) = &value
    {
      let items = items.borrow().to_vec();
      let mapped = items.iter().map(|w| prefix_where_paths(prefix, w)).collect::<JsResult<Vec<_>>>()?;
      set(&out, &key, Val::new_arr(mapped))?;
    } else {
      set(&out, &format!("{prefix}.{key}"), value)?;
    }
  }
  Ok(out)
}

/// `appendNonTrashedFilter({ deletedAtPath = 'deletedAt', enableTrash, trash, where })`
pub fn append_non_trashed_filter(deleted_at_path: Option<&str>, enable_trash: &Val, trash: &Val, where_: &Val) -> JsResult<Val> {
  if !enable_trash.truthy() || trash.truthy() {
    return Ok(where_.clone());
  }
  let not_trashed = new_obj([(
    deleted_at_path.unwrap_or("deletedAt").to_string(),
    new_obj([("exists".to_string(), Val::Bool(false))]),
  )]);

  let and = if where_.is_nullish() { Val::Undefined } else { get(where_, "and")? };
  if and.truthy() {
    let mut items = spread_iterable(&and, "where.and")?;
    items.push(not_trashed);
    let out = new_obj(spread_entries(where_));
    set(&out, "and", Val::new_arr(items))?;
    return Ok(out);
  }

  let mut items = vec![not_trashed];
  if where_.truthy() {
    items.push(where_.clone());
  }
  Ok(new_obj([("and".to_string(), Val::new_arr(items))]))
}

fn append_version_to_query_key_with_id_path(query: &Val, id_path: Option<&str>) -> JsResult<Val> {
  let res = Val::new_obj();
  for (key, val) in entries(query)? {
    if is_and_or(&key)
      && let Val::Arr(items) = &val
    {
      let items = items.borrow().to_vec();
      let mapped = items
        .iter()
        .map(|sub| append_version_to_query_key_with_id_path(sub, id_path))
        .collect::<JsResult<Vec<_>>>()?;
      set(&res, &key.to_lowercase(), Val::new_arr(mapped))?;
      continue;
    }
    let new_key = match id_path {
      Some(id_path) if key == "id" => id_path.to_string(),
      _ => format!("version.{key}"),
    };
    set(&res, &new_key, val)?;
  }
  Ok(res)
}

/// `appendGlobalVersionToQueryKey(query = {})`
pub fn append_global_version_to_query_key(query: &Val) -> JsResult<Val> {
  let query = if query.is_undefined() { Val::new_obj() } else { query.clone() };
  append_version_to_query_key_with_id_path(&query, None)
}

/// `appendVersionToQueryKey(query = {})`
pub fn append_version_to_query_key(query: &Val) -> JsResult<Val> {
  let query = if query.is_undefined() { Val::new_obj() } else { query.clone() };
  append_version_to_query_key_with_id_path(&query, Some("parent"))
}
