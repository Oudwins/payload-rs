//! Ports of `packages/payload/src/collections/operations/count.ts` (`countOperation`) and
//! `countVersions.ts` (`countVersionsOperation`).

use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::common::{AccessArgs, at, build_after_operation, build_before_operation, db_call, execute_access};
use crate::host::{call, call_val, get, get_val, is_false, val};
use crate::query;
use crate::utilities::append_non_trashed_filter;

/// `countOperation(incomingArgs)`: returns its promise.
pub fn count(incoming_args: Local) -> JsResult<Local> {
  let incoming_args = val(incoming_args)?;
  spawn(run_count(incoming_args))
}

async fn run_count(incoming_args: Val) -> JsResult<Val> {
  let mut args = incoming_args;

  // beforeOperation - Collection
  let collection = get_val(get(args.get(), "collection")?, "config")?;
  let override_access = get_val(args.get(), "overrideAccess")?;
  args = await_js(build_before_operation(args, collection, "count", override_access)?).await?;

  let d = call("countArgs", &[args.get()])?;
  let collection_config = at(d, 0)?;
  let disable_errors = at(d, 1)?;
  let override_access = at(d, 2)?;
  let req = at(d, 3)?;
  let trash = at(d, 4)?;
  let where_ = at(d, 5)?;

  let payload = get_val(req.get(), "payload")?;

  // Access
  let mut access_result = Val::Undefined;
  if !js::truthy(override_access.get()) {
    let slug = get_val(collection_config.get(), "slug")?;
    let read = get_val(get(collection_config.get(), "access")?, "read")?;
    let p = execute_access(AccessArgs::new(slug, disable_errors.clone(), req.clone()), read)?;
    access_result = await_js(p).await?;
    if is_false(access_result.get()) {
      return call_val("emptyCountResult", &[]);
    }
  }

  let mut full_where = query::combine_queries(where_.get(), access_result.get())?;
  let flattened_fields = get(collection_config.get(), "flattenedFields")?;
  query::sanitize_where_query(flattened_fields, payload.get(), full_where.get())?;

  // Exclude trashed documents when trash: false
  let enable_trash = get(collection_config.get(), "trash")?;
  full_where = val(append_non_trashed_filter("deletedAt", enable_trash, trash.get(), full_where.get())?)?;

  let p = query::validate_query_paths(query::QueryPaths {
    collection_config: collection_config.clone(),
    override_access: override_access.clone(),
    req: req.clone(),
    show_hidden_fields: Val::Undefined,
    version_fields: Val::Undefined,
    where_: where_.clone(),
  })?;
  await_js(p).await?;

  let p = db_call(payload.get(), "count", || {
    call("countDbArgs", &[collection_config.get(), req.get(), full_where.get()])
  })?;
  let mut result = await_js(p).await?;

  // afterOperation - Collection
  let p = build_after_operation(args, collection_config, "count", override_access, result)?;
  result = await_js(p).await?;

  Ok(result)
}

/// `countVersionsOperation(incomingArgs)`: returns its promise.
pub fn count_versions(incoming_args: Local) -> JsResult<Local> {
  let incoming_args = val(incoming_args)?;
  spawn(run_count_versions(incoming_args))
}

async fn run_count_versions(incoming_args: Val) -> JsResult<Val> {
  let mut args = incoming_args;

  // beforeOperation - Collection
  let collection = get_val(get(args.get(), "collection")?, "config")?;
  let override_access = get_val(args.get(), "overrideAccess")?;
  args = await_js(build_before_operation(args, collection, "countVersions", override_access)?).await?;

  let d = call("countVersionsArgs", &[args.get()])?;
  let collection_config = at(d, 0)?;
  let disable_errors = at(d, 1)?;
  let override_access = at(d, 2)?;
  let req = at(d, 3)?;
  let where_ = at(d, 4)?;

  let locale = get_val(req.get(), "locale")?;
  let payload = get_val(req.get(), "payload")?;

  // Access
  let mut access_result = Val::Undefined;
  if !js::truthy(override_access.get()) {
    let slug = get_val(collection_config.get(), "slug")?;
    let read_versions = get_val(get(collection_config.get(), "access")?, "readVersions")?;
    let p = execute_access(AccessArgs::new(slug, disable_errors.clone(), req.clone()), read_versions)?;
    access_result = await_js(p).await?;
    if is_false(access_result.get()) {
      return call_val("emptyCountResult", &[]);
    }
  }

  let full_where = query::combine_queries(where_.get(), access_result.get())?;

  let version_fields = call_val("buildVersionFields", &[get(payload.get(), "config")?, collection_config.get()])?;

  query::sanitize_where_query(version_fields.get(), payload.get(), full_where.get())?;

  let p = query::validate_query_paths(query::QueryPaths {
    collection_config: collection_config.clone(),
    override_access: override_access.clone(),
    req: req.clone(),
    show_hidden_fields: Val::Undefined,
    version_fields: version_fields.clone(),
    where_: where_.clone(),
  })?;
  await_js(p).await?;

  let p = db_call(payload.get(), "countVersions", || {
    call("countVersionsDbArgs", &[collection_config.get(), locale.get(), req.get(), full_where.get()])
  })?;
  let mut result = await_js(p).await?;

  // afterOperation - Collection
  let p = build_after_operation(args, collection_config, "countVersions", override_access, result)?;
  result = await_js(p).await?;

  Ok(result)
}
