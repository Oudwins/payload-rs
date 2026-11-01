//! Port of `packages/payload/src/collections/operations/findDistinct.ts`
//! (`findDistinctOperation`).

use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Type, Val};

use crate::common::{AccessArgs, at, build_after_operation, build_before_operation, db_call, execute_access};
use crate::host::{self, call, call_fn, call_val, get, get_val, has, is_false, is_typeof_object, opt, val};

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
  let mut full_where = call_val("combineQueries", &[where_.get(), access_result.get()])?;
  let flattened_fields = get(collection_config.get(), "flattenedFields")?;
  call("sanitizeWhereQuery", &[flattened_fields, payload.get(), full_where.get()])?;

  let enable_trash = get(collection_config.get(), "trash")?;
  full_where = call_val("appendNonTrashedFilter", &[enable_trash, trash.get(), full_where.get()])?;

  let related_access_by_path = val(js::object())?;

  // where: where ?? {}
  let p = call("validateQueryPathsOrEmpty", &[collection_config.get(), override_access.get(), req.get(), where_.get()])?;
  await_js(p).await?;

  let field_result = call_val("distinctFieldByPath", &[payload.get(), collection_config.get(), args.get()])?;

  if !js::truthy(field_result.get()) {
    let field = get(args.get(), "field")?;
    let slug = get(collection_config.get(), "slug")?;
    return Err(host::throw_from("distinctFieldNotFound", &[field, slug]));
  }

  let field = || get(field_result.get(), "field");
  if js::truthy(get(field()?, "hidden")?) && !js::truthy(show_hidden_fields.get()) {
    let t = get(req.get(), "t")?;
    return Err(host::throw_from("forbidden", &[t]));
  }

  // fieldResult.field.access?.read
  if js::truthy(opt(get(field()?, "access")?, "read")?) {
    let access = get(field()?, "access")?;
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
    let paths = call_val("distinctLocalizedPaths", &[collection_config.get(), args.get(), req.get(), payload.get()])?;

    call("distinctTrimIDPath", &[paths.get()])?;

    // new Map<string, AccessResult>()
    let mut related_access_by_collection: Vec<(Val, Val)> = Vec::new();

    let mut path_index: u32 = 1;
    loop {
      // pathIndex < paths.length
      let length = get(paths.get(), "length")?;
      if !js::truthy(call("lessThan", &[js::number(f64::from(path_index)), length])?) {
        break;
      }
      // paths[pathIndex]?.collectionSlug
      let entry = host::get_key(paths.get(), js::number(f64::from(path_index)))?;
      let collection_slug = val(opt(entry, "collectionSlug")?)?;

      if !js::truthy(collection_slug.get()) {
        path_index += 1;
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
            call("sanitizeWhereQuery", &[fields, payload.get(), related_access.get()])?;
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
        let relationship_path = call("relationshipPath", &[paths.get(), js::number(f64::from(path_index))])?;
        payload_core_runtime::host::set(related_access_by_path.get(), relationship_path, related_access.get())?;
        let prefixed = call("prefixWherePaths", &[relationship_path, related_access.get()])?;
        full_where = call_val("combineQueries", &[full_where.get(), prefixed])?;
      }
      path_index += 1;
    }

    let p = call("validateQueryPathsDistinctField", &[collection_config.get(), req.get(), show_hidden_fields.get(), args.get()])?;
    await_js(p).await?;

    let sort = get(args.get(), "sort")?;
    let p = call("validateSortQuery", &[collection_config.get(), js::boolean(false), req.get(), sort])?;
    await_js(p).await?;
  }

  // 'virtual' in fieldResult.field && fieldResult.field.virtual
  if has(field()?, "virtual")? && js::truthy(get(field()?, "virtual")?) {
    let virtual_path = get(field()?, "virtual")?;
    if js::type_of(virtual_path) != Type::String {
      return Err(host::throw_from("distinctVirtualNotLinked", &[]));
    }

    let path = call_val("distinctVirtualPath", &[collection_config.get(), field_result.get()])?;

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

    call("renameDistinctValues", &[result.get(), args.get(), path.get()])?;

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
  let is_relationship = js::str_equals(get(field()?, "type")?, "relationship")
    || js::str_equals(get(field()?, "type")?, "upload");
  if is_relationship && js::truthy(get(args.get(), "depth")?)
  {
    let p = call("distinctPopulate", &[field_result.get(), result.get(), args.get(), populate.get(), req.get()])?;
    await_js(p).await?;
  }

  // afterOperation - Collection
  let p = build_after_operation(args, collection_config, "findDistinct", override_access, result)?;
  result = await_js(p).await?;

  Ok(result)
}

/// `Map` key equality (SameValueZero): strict equality plus NaN.
fn same_value_zero(a: Local, b: Local) -> bool {
  if js::strict_equals(a, b) {
    return true;
  }
  js::type_of(a) == Type::Number && js::type_of(b) == Type::Number && js::get_f64(a).is_nan() && js::get_f64(b).is_nan()
}
