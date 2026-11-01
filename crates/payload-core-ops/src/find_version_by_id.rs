//! Port of `packages/payload/src/collections/operations/findVersionByID.ts`
//! (`findVersionByIDOperation`).
//!
//! Upstream quirk kept: the args are destructured before `beforeOperation`, so args returned by a
//! `beforeOperation` hook only reach `checkFileAccess` (`args.collection`) and `afterOperation`.

use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::common::{
  AccessArgs, HookTarget, ReadHooks, at, build_after_operation, build_before_operation, db_call, execute_access,
  has_hooks, has_versions_enabled,
};
use crate::host::{self, call, call_val, get, get_val, is_false, is_typeof_object, opt, val};

/// `findVersionByIDOperation(args)`: returns its promise.
pub fn find_version_by_id(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run(args))
}

async fn run(args: Val) -> JsResult<Val> {
  let mut args = args;

  let d = call("findVersionByIDArgs", &[args.get()])?;
  let id = at(d, 0)?;
  let collection_config = at(d, 1)?;
  let current_depth = at(d, 2)?;
  let depth = at(d, 3)?;
  let disable_errors = at(d, 4)?;
  let override_access = at(d, 5)?;
  let populate = at(d, 6)?;
  let fallback_locale = at(d, 7)?;
  let locale = at(d, 8)?;
  let payload = at(d, 9)?;
  let req = at(d, 10)?;
  let incoming_select = at(d, 11)?;
  let show_hidden_fields = at(d, 12)?;
  let trash = at(d, 13)?;

  if !js::truthy(id.get()) {
    return Err(host::throw_from("missingVersionID", &[]));
  }

  if !has_versions_enabled(collection_config.get())? {
    if js::truthy(disable_errors.get()) {
      return Ok(Val::Null);
    }
    let t = get(req.get(), "t")?;
    return Err(host::throw_from("notFound", &[t]));
  }

  // beforeOperation - Collection
  let p = build_before_operation(args, collection_config.clone(), "findVersionByID", override_access.clone())?;
  args = await_js(p).await?;

  let where_ = call_val("idWhere", &[id.get()])?;
  let version_fields = call_val("versionFields", &[payload.get(), collection_config.get()])?;
  let select =
    call_val("selectVersions", &[version_fields.get(), collection_config.get(), req.get(), incoming_select.get()])?;

  let read_versions = get(get(collection_config.get(), "access")?, "readVersions")?;
  let inherits_read_access = js::truthy(call("isInheritedReadVersionsAccess", &[read_versions])?);
  let should_prefetch_version = !js::truthy(override_access.get()) && inherits_read_access;
  let prefetched = if should_prefetch_version {
    let p = call(
      "prefetchVersion",
      &[id.get(), collection_config.get(), locale.get(), req.get(), select.get(), trash.get()],
    )?;
    await_js(p).await?
  } else {
    Val::Undefined
  };

  // Access
  let access_results = if !js::truthy(override_access.get()) {
    let slug = get_val(collection_config.get(), "slug")?;
    let mut access_args = AccessArgs::new(slug, disable_errors.clone(), req.clone());
    access_args.id = id.clone();
    let access = if inherits_read_access {
      call_val("inheritedReadVersionsAccess", &[collection_config.get(), prefetched.get()])?
    } else {
      get_val(get(collection_config.get(), "access")?, "readVersions")?
    };
    await_js(execute_access(access_args, access)?).await?
  } else {
    Val::Bool(true)
  };

  // If errors are disabled, and access returns false, return null
  if is_false(access_results.get()) {
    return Ok(Val::Null);
  }

  let has_where_access = is_typeof_object(access_results.get());

  let mut full_where = call_val("combineQueries", &[where_.get(), access_results.get()])?;

  let enable_trash = get(collection_config.get(), "trash")?;
  full_where = call_val("appendNonTrashedVersionFilter", &[enable_trash, trash.get(), full_where.get()])?;

  call("sanitizeWhereQuery", &[version_fields.get(), payload.get(), full_where.get()])?;

  // Find by ID
  let mut result = val(opt(prefetched.get(), "version")?)?;

  if !should_prefetch_version || has_where_access {
    let p = db_call(payload.get(), "findVersions", || {
      call("findVersionByIDDbArgs", &[collection_config.get(), locale.get(), req.get(), select.get(), full_where.get()])
    })?;
    let versions_query = await_js(p).await?;
    let docs = get(versions_query.get(), "docs")?;
    result = val(host::get_key(docs, js::number(0.0))?)?;
  }

  if !js::truthy(result.get()) {
    if !js::truthy(disable_errors.get()) {
      if !has_where_access {
        let t = get(req.get(), "t")?;
        return Err(host::throw_from("notFound", &[t]));
      }
      let t = get(req.get(), "t")?;
      return Err(host::throw_from("forbidden", &[t]));
    }
    return Ok(Val::Null);
  }

  if js::truthy(get(collection_config.get(), "upload")?) && !js::truthy(override_access.get()) {
    let p = call("checkFileAccessVersion", &[args.get(), result.get(), req.get()])?;
    await_js(p).await?;
  }

  if !js::truthy(get(result.get(), "version")?) {
    // Fallback if not selected
    host::set(result.get(), "version", js::object())?;
  }

  let hooks = |hook_name| ReadHooks {
    collection_config: collection_config.clone(),
    hook_name,
    find_many: false,
    override_access: override_access.clone(),
    query: full_where.clone(),
    req: req.clone(),
  };

  // beforeRead - Collection
  if has_hooks(collection_config.get(), "beforeRead")? {
    hooks("beforeRead").run(HookTarget::Version(result.clone())).await?;
  }

  // afterRead - Fields
  let after_read_args = call(
    "findVersionByIDAfterReadArgs",
    &[
      collection_config.get(),
      req.get(),
      current_depth.get(),
      depth.get(),
      result.get(),
      fallback_locale.get(),
      locale.get(),
      override_access.get(),
      populate.get(),
      select.get(),
      show_hidden_fields.get(),
    ],
  )?;
  let version = await_js(host::after_read(after_read_args)?).await?;
  host::set(result.get(), "version", version.get())?;

  // afterRead - Collection
  if has_hooks(collection_config.get(), "afterRead")? {
    hooks("afterRead").run(HookTarget::Version(result.clone())).await?;
  }

  if js::truthy(get(collection_config.get(), "upload")?) {
    call("markHistoricalVersion", &[result.get(), collection_config.get(), req.get()])?;
  }

  // afterOperation - Collection
  let p = build_after_operation(args, collection_config.clone(), "findVersionByID", override_access.clone(), result)?;
  let result = await_js(p).await?;

  Ok(result)
}
