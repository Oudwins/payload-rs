//! Port of `packages/payload/src/collections/operations/findDistinct.ts`
//! (`findDistinctOperation`).

use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Type, Val};

use crate::common::{AccessArgs, at, build_after_operation, build_before_operation, db_call, execute_access};
use crate::host::{self, ForOf, call, call_fn, call_val, get, get_val, has, is_false, is_typeof_object, opt, val};
use crate::query;
use crate::utilities::append_non_trashed_filter;

/// `findDistinctOperation(incomingArgs)`: returns its promise.
pub fn find_distinct(incoming_args: Local) -> JsResult<Local> {
  let incoming_args = val(incoming_args)?;
  spawn(run(incoming_args))
}

fn empty_result(args: &Val) -> JsResult<Val> {
  // getEmptyResult({ limit: args.limit })
  let limit = get(args.get(), "limit")?;
  call_val("emptyDistinctResult", &[limit])
}

async fn run(incoming_args: Val) -> JsResult<Val> {
  let mut args = incoming_args;

  // beforeOperation - Collection
  let collection = get_val(get(args.get(), "collection")?, "config")?;
  let override_access = get_val(args.get(), "overrideAccess")?;
  args = await_js(build_before_operation(args, collection, "readDistinct", override_access)?).await?;

  let d = call("findDistinctArgs", &[args.get()])?;
  let collection_config = at(d, 0)?;
  let disable_errors = at(d, 1)?;
  let override_access = at(d, 2)?;
  let populate = at(d, 3)?;
  let show_hidden_fields = at(d, 4)?;
  let trash = at(d, 5)?;
  let where_ = at(d, 6)?;

  let req = get_val(args.get(), "req")?;
  let locale = get_val(req.get(), "locale")?;
  let payload = get_val(req.get(), "payload")?;

  // Access
  let mut access_result = Val::Undefined;
  if !js::truthy(override_access.get()) {
    let slug = get_val(collection_config.get(), "slug")?;
    let read = get_val(get(collection_config.get(), "access")?, "read")?;
    let p = execute_access(AccessArgs::new(slug, disable_errors.clone(), req.clone()), read)?;
    access_result = await_js(p).await?;
    if is_false(access_result.get()) {
      return empty_result(&args);
    }
  }

  // Find Distinct
  let mut full_where = query::combine_queries(where_.get(), access_result.get())?;
  let flattened_fields = get(collection_config.get(), "flattenedFields")?;
  query::sanitize_where_query(flattened_fields, payload.get(), full_where.get())?;

  // Exclude trashed documents when trash: false
  let enable_trash = get(collection_config.get(), "trash")?;
  full_where = val(append_non_trashed_filter("deletedAt", enable_trash, trash.get(), full_where.get())?)?;

  let related_access_by_path = val(js::object())?;

  // where: where ?? {}
  let p = query::validate_query_paths(query::QueryPaths {
    collection_config: collection_config.clone(),
    override_access: override_access.clone(),
    req: req.clone(),
    show_hidden_fields: Val::Undefined,
    version_fields: Val::Undefined,
    where_: if host::is_nullish(where_.get()) { val(js::object())? } else { where_.clone() },
  })?;
  await_js(p).await?;

  // getFieldByPath({ config: payload.config, fields: collectionConfig.flattenedFields,
  //   includeRelationships: true, path: args.field })
  let config = get(payload.get(), "config")?;
  let fields = get(collection_config.get(), "flattenedFields")?;
  let path = get(args.get(), "field")?;
  let Some(field_result) = query::get_field_by_path_with_relationships(config, fields, path)? else {
    let field = get(args.get(), "field")?;
    let slug = get(collection_config.get(), "slug")?;
    return Err(host::throw_from("distinctFieldNotFound", &[field, slug]));
  };
  let field = field_result.field;

  if js::truthy(get(field.get(), "hidden")?) && !js::truthy(show_hidden_fields.get()) {
    let t = get(req.get(), "t")?;
    return Err(host::throw_from("forbidden", &[t]));
  }

  // fieldResult.field.access?.read
  if js::truthy(opt(get(field.get(), "access")?, "read")?) {
    let access = get(field.get(), "access")?;
    let read = get(access, "read")?;
    let read_args = call("fieldReadAccessArgs", &[collection_config.get(), req.get()])?;
    let p = call_fn(read, access, &[read_args], "fieldResult.field.access.read")?;
    let has_access = await_js(p).await?;
    if !js::truthy(has_access.get()) {
      let t = get(req.get(), "t")?;
      return Err(host::throw_from("forbidden", &[t]));
    }
  }

  if !js::truthy(override_access.get()) {
    // getLocalizedPaths({ collectionSlug: collectionConfig.slug, fields: collectionConfig.flattenedFields,
    //   incomingPath: args.field, locale: req.locale!, overrideAccess: true, payload })
    let collection_slug = get(collection_config.get(), "slug")?;
    let fields = get(collection_config.get(), "flattenedFields")?;
    let incoming_path = get(args.get(), "field")?;
    let locale = get(req.get(), "locale")?;
    let mut paths = query::get_localized_paths_override_access(collection_slug, fields, incoming_path, locale, payload.get())?;

    // paths.at(-1)?.path === 'id'
    if paths.last().is_some_and(|p| p.path.iter().copied().eq("id".encode_utf16())) {
      // paths.at(-2)?.field
      let previous_field = if paths.len() >= 2 { paths[paths.len() - 2].field.get() } else { js::undefined() };
      if js::truthy(previous_field)
        && (js::str_equals(get(previous_field, "type")?, "relationship")
          || js::str_equals(get(previous_field, "type")?, "upload"))
        && host::is_string(get(previous_field, "relationTo")?)
      {
        paths.pop();
      }
    }

    // new Map<string, AccessResult>()
    let mut related_access_by_collection: Vec<(Val, Val)> = Vec::new();

    for path_index in 1..paths.len() {
      // paths[pathIndex]?.collectionSlug
      let collection_slug = paths[path_index].collection_slug.clone();

      if !js::truthy(collection_slug.get()) {
        continue;
      }

      let known = related_access_by_collection.iter().position(|(k, _)| same_value_zero(k.get(), collection_slug.get()));
      let related_access = match known {
        Some(i) => related_access_by_collection[i].1.clone(),
        None => {
          let collections = get(payload.get(), "collections")?;
          let related_collection_config = get_val(host::get_key(collections, collection_slug.get())?, "config")?;
          let read = get_val(get(related_collection_config.get(), "access")?, "read")?;
          let p = execute_access(AccessArgs::new(collection_slug.clone(), Val::Bool(true), req.clone()), read)?;
          let related_access = await_js(p).await?;

          if is_typeof_object(related_access.get()) {
            let fields = get(related_collection_config.get(), "flattenedFields")?;
            query::sanitize_where_query(fields, payload.get(), related_access.get())?;
          }

          related_access_by_collection.push((collection_slug.clone(), related_access.clone()));
          related_access
        }
      };

      if is_false(related_access.get()) {
        if js::truthy(disable_errors.get()) {
          return empty_result(&args);
        }
        let field = get(args.get(), "field")?;
        return Err(host::throw_from("queryError", &[field]));
      }

      if is_typeof_object(related_access.get()) {
        // paths.slice(0, pathIndex).map(({ path }) => path).join('.')
        let mut relationship_path: Vec<u16> = Vec::new();
        for (i, p) in paths[..path_index].iter().enumerate() {
          if i > 0 {
            relationship_path.push(u16::from(b'.'));
          }
          relationship_path.extend_from_slice(&p.path);
        }
        let relationship_path = host::string_utf16(&relationship_path);
        payload_core_runtime::host::set(related_access_by_path.get(), relationship_path, related_access.get())?;
        let prefixed = query::prefix_where_paths(relationship_path, related_access.get())?;
        full_where = query::combine_queries(full_where.get(), prefixed)?;
      }
    }

    // validateQueryPaths({ collectionConfig, overrideAccess: false, req, showHiddenFields,
    //   where: { [args.field]: { exists: true } } })
    let where_field = call_val("existsWhere", &[get(args.get(), "field")?])?;
    let p = query::validate_query_paths(query::QueryPaths {
      collection_config: collection_config.clone(),
      override_access: Val::Bool(false),
      req: req.clone(),
      show_hidden_fields: show_hidden_fields.clone(),
      version_fields: Val::Undefined,
      where_: where_field,
    })?;
    await_js(p).await?;

    let sort = get_val(args.get(), "sort")?;
    let p = query::validate_sort_query(collection_config.clone(), Val::Bool(false), req.clone(), sort, Val::Undefined)?;
    await_js(p).await?;
  }

  // 'virtual' in fieldResult.field && fieldResult.field.virtual
  if has(field.get(), "virtual")? && js::truthy(get(field.get(), "virtual")?) {
    if !host::is_string(get(field.get(), "virtual")?) {
      return Err(host::throw_from("distinctVirtualNotLinked", &[]));
    }

    let path = val(virtual_relation_path(collection_config.get(), field.get())?)?;

    let find_distinct = get(payload.get(), "findDistinct")?;
    let find_args = call(
      "virtualFindDistinctArgs",
      &[
        collection_config.get(),
        args.get(),
        disable_errors.get(),
        path.get(),
        locale.get(),
        override_access.get(),
        populate.get(),
        req.get(),
        show_hidden_fields.get(),
        trash.get(),
        where_.get(),
      ],
    )?;
    let p = call_fn(find_distinct, payload.get(), &[find_args], "payload.findDistinct")?;
    let result = await_js(p).await?;

    // for (const val of result.values) { val[args.field] = val[path]; delete val[path] }
    let mut values = ForOf::of(get(result.get(), "values")?, "result.values")?;
    while let Some(value) = values.next()? {
      let r = (|| {
        let key = get(args.get(), "field")?;
        let renamed = host::get_key(value, path.get())?;
        payload_core_runtime::host::set(value, key, renamed)?;
        payload_core_runtime::host::del(value, path.get())
      })();
      if r.is_err() {
        values.close();
        r?;
      }
    }

    return Ok(result);
  }

  let p = db_call(payload.get(), "findDistinct", || {
    call(
      "findDistinctDbArgs",
      &[collection_config.get(), args.get(), locale.get(), related_access_by_path.get(), req.get(), full_where.get()],
    )
  })?;
  let mut result = await_js(p).await?;

  // (type relationship || upload) && args.depth
  let is_relationship = js::str_equals(get(field.get(), "type")?, "relationship")
    || js::str_equals(get(field.get(), "type")?, "upload");
  if is_relationship && js::truthy(get(args.get(), "depth")?) {
    let population_promises = js::array();
    // const sanitizedField = { ...fieldResult.field }
    let sanitized_field = call("spreadObject", &[field.get()])?;
    if js::truthy(get(field.get(), "hasMany")?) {
      host::set(sanitized_field, "hasMany", js::boolean(false))?;
    }
    let mut values = ForOf::of(get(result.get(), "values")?, "result.values")?;
    while let Some(doc) = values.next()? {
      let r = call("distinctPopulation", &[sanitized_field, doc, args.get(), populate.get(), req.get()])
        .and_then(|p| js::push(population_promises, p));
      if r.is_err() {
        values.close();
        r?;
      }
    }
    await_js(host::promise_all(population_promises)?).await?;
  }

  // afterOperation - Collection
  let p = build_after_operation(args, collection_config, "findDistinct", override_access, result)?;
  result = await_js(p).await?;

  Ok(result)
}

/// The virtual-field path of findDistinct.ts:
/// ```ts
/// let relationPath = ''
/// let currentFields = collectionConfig.flattenedFields
/// const fieldPathSegments = fieldResult.field.virtual.split('.')
/// for (const segment of fieldResult.field.virtual.split('.')) {
///   relationPath = `${relationPath}${segment}`
///   fieldPathSegments.shift()
///   const field = currentFields.find((e) => e.name === segment)!
///   if ((field.type === 'relationship' || field.type === 'upload') && typeof field.relationTo === 'string') break
///   if ('flattenedFields' in field) currentFields = field.flattenedFields
/// }
/// const path = `${relationPath}.${fieldPathSegments.join('.')}`
/// ```
/// (`relationPath` concatenates the segments without a separator, as upstream does.)
fn virtual_relation_path(collection_config: Local, field: Local) -> JsResult<Local> {
  let mut relation_path: Vec<u16> = Vec::new();
  let mut current_fields = get(collection_config, "flattenedFields")?;
  let virtual_path = js::get_string_utf16(get(field, "virtual")?).unwrap_or_default();
  let mut field_path_segments: Vec<&[u16]> = virtual_path.split(|u| *u == u16::from(b'.')).collect();
  let virtual_path2 = js::get_string_utf16(get(field, "virtual")?).unwrap_or_default();
  for segment in virtual_path2.split(|u| *u == u16::from(b'.')) {
    relation_path.extend_from_slice(segment);
    if !field_path_segments.is_empty() {
      field_path_segments.remove(0);
    }
    let field = call("findByName", &[current_fields, host::string_utf16(segment)])?;
    if (js::str_equals(get(field, "type")?, "relationship") || js::str_equals(get(field, "type")?, "upload"))
      && host::is_string(get(field, "relationTo")?)
    {
      break;
    }
    if has(field, "flattenedFields")? {
      current_fields = get(field, "flattenedFields")?;
    }
  }
  let mut path = relation_path;
  path.push(u16::from(b'.'));
  for (i, segment) in field_path_segments.iter().enumerate() {
    if i > 0 {
      path.push(u16::from(b'.'));
    }
    path.extend_from_slice(segment);
  }
  Ok(host::string_utf16(&path))
}

/// `Map` key equality (SameValueZero): strict equality plus NaN.
fn same_value_zero(a: Local, b: Local) -> bool {
  if js::strict_equals(a, b) {
    return true;
  }
  js::type_of(a) == Type::Number && js::type_of(b) == Type::Number && js::get_f64(a).is_nan() && js::get_f64(b).is_nan()
}
