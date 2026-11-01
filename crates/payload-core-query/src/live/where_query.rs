//! `combineQueries`, `prefixWherePaths` and `sanitizeWhereQuery` on live `where` objects.

use payload_core_runtime::js::{self, JsResult, Local};

use super::host::{
  Loop, Units, call, del, dot, get, get_named, host, in_op, is_and_or, is_array, is_string,
  is_typeof_object, join_dot, set, split_dot, str_eq, string, to_string, truthy, units_of,
};

/// `hasManyRelationshipOperators`
pub const HAS_MANY_RELATIONSHIP_OPERATORS: [&str; 3] = ["contains", "not_equals", "equals"];

/// `combineQueries(where, access)`
pub fn combine_queries(where_: Local, access: Local) -> JsResult<Local> {
  if !truthy(where_) && !truthy(access) {
    return Ok(js::object());
  }
  let and = js::array();
  if truthy(where_) {
    js::set_element(and, 0, where_)?;
  }
  if truthy(call(&host()?.has_where_access_result, &[access])?) {
    js::push(and, access)?;
  }
  call(&host()?.and_of, &[and])
}

/// `prefixWherePaths({ prefix, where })`
pub fn prefix_where_paths(prefix: Local, where_: Local) -> JsResult<Local> {
  let h = host()?;
  let prefixed_where = js::object();
  let entries = call(&h.object_entries, &[where_])?;
  for i in 0..js::array_length(entries) {
    let entry = js::get_element(entries, i)?;
    let key = js::get_element(entry, 0)?;
    let value = js::get_element(entry, 1)?;
    let key_units = units_of(key).unwrap_or_default();
    if is_and_or(&key_units) && is_array(value)? {
      let mapped = call(&h.prefix_map, &[value, prefix])?;
      set(prefixed_where, key, mapped)?;
    } else {
      // `${prefix}.${key}`
      set(prefixed_where, string(&dot(&to_string(prefix)?, &key_units)), value)?;
    }
  }
  Ok(prefixed_where)
}

fn type_is(field: Local, t: &str) -> JsResult<bool> {
  Ok(str_eq(get_named(field, "type")?, t))
}

/// `sanitizeWhereQuery({ fields, payload, where })` (mutates `where`).
pub fn sanitize_where_query(fields: Local, payload: Local, where_: Local) -> JsResult<()> {
  let h = host()?;
  let keys = Loop::for_in(where_)?;
  while let Some(key) = keys.next()? {
    let value = get(where_, key)?;
    let key_units = units_of(key).unwrap_or_default();

    if is_and_or(&key_units) && is_array(value)? {
      let items = Loop::for_of(value)?;
      while let Some(nested) = items.next()? {
        sanitize_where_query(fields, payload, nested)?;
      }
      continue;
    }

    let mut paths: Vec<Units> = split_dot(&key_units);
    let mut path_has_changed = false;
    let mut current_fields = fields;
    let mut final_field: Option<Local> = None;

    for i in 0..paths.len() {
      let field = call(&h.find_current, &[current_fields, string(&paths[i])])?;
      if !truthy(field) {
        break;
      }
      final_field = Some(field);

      // 'virtual' in field && field.virtual && typeof field.virtual === 'string'
      if in_op("virtual", field)? && truthy(get_named(field, "virtual")?) && is_string(get_named(field, "virtual")?) {
        paths[i] = units_of(get_named(field, "virtual")?).unwrap_or_default();
        path_has_changed = true;
      }

      if in_op("flattenedFields", field)? {
        current_fields = get_named(field, "flattenedFields")?;
      }

      if (type_is(field, "relationship")? || type_is(field, "upload")?) && is_string(get_named(field, "relationTo")?) {
        let collections = get_named(payload, "collections")?;
        let related_collection = get(collections, get_named(field, "relationTo")?)?;
        if truthy(related_collection) {
          current_fields = get_named(get_named(related_collection, "config")?, "flattenedFields")?;
        }
      }
    }

    sanitize_nested_has_many_relationship_queries(final_field.unwrap_or_else(js::undefined), payload, value)?;

    if path_has_changed {
      let new_key = string(&join_dot(&paths));
      let current = get(where_, key)?;
      set(where_, new_key, current)?;
      del(where_, key)?;
    }
  }
  Ok(())
}

fn sanitize_nested_has_many_relationship_queries(field: Local, payload: Local, value: Local) -> JsResult<()> {
  if !truthy(field)
    || (!type_is(field, "relationship")? && !type_is(field, "upload")?)
    || !truthy(get_named(field, "hasMany")?)
    || !is_string(get_named(field, "relationTo")?)
    || js::type_of(value) == js::Type::Null
    || !is_typeof_object(value)
    || is_array(value)?
  {
    return Ok(());
  }

  // payload.collections[field.relationTo]?.config.flattenedFields
  let collections = get_named(payload, "collections")?;
  let related_collection = get(collections, get_named(field, "relationTo")?)?;
  let related_fields = match js::type_of(related_collection) {
    js::Type::Undefined | js::Type::Null => js::undefined(),
    _ => get_named(get_named(related_collection, "config")?, "flattenedFields")?,
  };
  if !truthy(related_fields) {
    return Ok(());
  }

  let h = host()?;
  for operator in HAS_MANY_RELATIONSHIP_OPERATORS {
    let nested_where = get_named(value, operator)?;
    if truthy(call(&h.is_nested_relationship_query, &[nested_where])?) {
      sanitize_where_query(related_fields, payload, nested_where)?;
    }
  }
  Ok(())
}
