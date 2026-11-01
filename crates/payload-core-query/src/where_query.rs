//! Synchronous `where` utilities on decoded values: `appendNonTrashedFilter`,
//! `appendVersionToQueryKey`, `appendGlobalVersionToQueryKey`. `combineQueries`,
//! `prefixWherePaths` and `sanitizeWhereQuery` run on live values (`crate::live::where_query`).

use payload_sql_read::Val;

use crate::js::{JsResult, entries, get, is_and_or, new_obj, set, spread_entries, spread_iterable};

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
