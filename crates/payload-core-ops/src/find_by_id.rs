//! Port of `packages/payload/src/collections/operations/findByID.ts` (`findByIDOperation`).

use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Type, Val};

use crate::common::{
  AccessArgs, HookTarget, ReadHooks, at, build_after_operation, build_before_operation, db_call, execute_access,
  has_drafts_enabled, has_hooks, nullish_or,
};
use crate::find::LOCKED_DOCUMENTS_SLUG;
use crate::host::{self, call, call_fn, call_val, get, get_val, is_false, opt, val};

/// `findByIDOperation(incomingArgs)`: returns its promise.
pub fn find_by_id(incoming_args: Local) -> JsResult<Local> {
  let incoming_args = val(incoming_args)?;
  spawn(run(incoming_args))
}

async fn run(incoming_args: Val) -> JsResult<Val> {
  let mut args = incoming_args;

  // beforeOperation - Collection
  let collection = get_val(get(args.get(), "collection")?, "config")?;
  let override_access = get_val(args.get(), "overrideAccess")?;
  args = await_js(build_before_operation(args, collection, "read", override_access)?).await?;

  let d = call("findByIDArgs", &[args.get()])?;
  let id = at(d, 0)?;
  let collection_config = at(d, 1)?;
  let current_depth = at(d, 2)?;
  let depth = at(d, 3)?;
  let disable_errors = at(d, 4)?;
  let replace_with_version = at(d, 5)?;
  let flatten_locales = at(d, 6)?;
  let include_lock_status_from_args = at(d, 7)?;
  let joins = at(d, 8)?;
  let override_access = at(d, 9)?;
  let populate = at(d, 10)?;
  let fallback_locale = at(d, 11)?;
  let locale = at(d, 12)?;
  let t = at(d, 13)?;
  let req = at(d, 14)?;
  let incoming_select = at(d, 15)?;
  let show_hidden_fields = at(d, 16)?;
  let trash = at(d, 17)?;

  let include_lock_status = js::truthy(include_lock_status_from_args.get())
    && js::truthy(opt(get(get(req.get(), "payload")?, "collections")?, LOCKED_DOCUMENTS_SLUG)?);

  let select = call_val("selectRead", &[collection_config.get(), req.get(), incoming_select.get()])?;

  // Access
  let access_result = if !js::truthy(override_access.get()) {
    let slug = get_val(collection_config.get(), "slug")?;
    let read = get_val(get(collection_config.get(), "access")?, "read")?;
    let mut access_args = AccessArgs::new(slug, disable_errors.clone(), req.clone());
    access_args.id = id.clone();
    await_js(execute_access(access_args, read)?).await?
  } else {
    Val::Bool(true)
  };

  // If errors are disabled, and access returns false, return null
  if is_false(access_result.get()) {
    return Ok(Val::Null);
  }

  let is_valid_id = match js::type_of(id.get()) {
    Type::String => js::get_string_utf16(id.get()).is_some_and(|s| !s.is_empty()),
    Type::Number => js::get_f64(id.get()).is_finite(),
    _ => false,
  };
  if !is_valid_id {
    return Err(host::throw_from("notFound", &[t.get()]));
  }

  let where_ = call_val("idWhere", &[id.get()])?;

  let mut full_where = call_val("combineQueries", &[where_.get(), access_result.get()])?;

  let enable_trash = get(collection_config.get(), "trash")?;
  full_where = call_val("appendNonTrashedFilter", &[enable_trash, trash.get(), full_where.get()])?;

  let flattened_fields = get(collection_config.get(), "flattenedFields")?;
  let payload = get(get(args.get(), "req")?, "payload")?;
  call("sanitizeWhereQuery", &[flattened_fields, payload, full_where.get()])?;

  let p = call("sanitizeJoinQuery", &[collection_config.get(), joins.get(), override_access.get(), req.get()])?;
  let sanitized_joins = await_js(p).await?;

  // execute only if there's a custom ID and potentially overwriten access on id
  let collections = get(get(req.get(), "payload")?, "collections")?;
  let slug = get(collection_config.get(), "slug")?;
  if js::truthy(get(host::get_key(collections, slug)?, "customIDType")?) {
    let p = call("validateQueryPaths", &[collection_config.get(), override_access.get(), req.get(), where_.get()])?;
    await_js(p).await?;
  }

  // Find by ID
  // !args.data && replaceWithVersion && hasDraftsEnabled(collectionConfig)
  let should_query_drafts = !js::truthy(get(args.get(), "data")?)
    && js::truthy(replace_with_version.get())
    && has_drafts_enabled(collection_config.get())?;
  let mut doc_with_locales;
  let mut query = full_where.clone();

  let mut db_select = select.clone();

  // collectionConfig.versions?.drafts && replaceWithVersion && select && getSelectMode(select) === 'include'
  if js::truthy(opt(get(collection_config.get(), "versions")?, "drafts")?)
    && js::truthy(replace_with_version.get())
    && js::truthy(select.get())
    && js::str_equals(call("getSelectMode", &[select.get()])?, "include")
  {
    db_select = call_val("selectWithTimestamps", &[select.get()])?;
  }

  let find_one_args = call_val(
    "findOneArgs",
    &[
      collection_config.get(),
      replace_with_version.get(),
      req.get(),
      sanitized_joins.get(),
      locale.get(),
      db_select.get(),
      full_where.get(),
    ],
  )?;

  if should_query_drafts {
    query = call_val("appendVersionToQueryKey", &[full_where.get()])?;

    let p = call(
      "validateQueryPathsByIDDrafts",
      &[collection_config.get(), override_access.get(), req.get(), where_.get()],
    )?;
    await_js(p).await?;

    let p = db_call(get(req.get(), "payload")?, "queryDrafts", || {
      call(
        "findByIDQueryDraftsArgs",
        &[collection_config.get(), req.get(), sanitized_joins.get(), locale.get(), select.get(), query.get()],
      )
    })?;
    let drafts = await_js(p).await?;
    let docs = get(drafts.get(), "docs")?;
    doc_with_locales = val(host::get_key(docs, js::number(0.0))?)?;

    if !js::truthy(doc_with_locales.get()) {
      let p = db_call(get(req.get(), "payload")?, "queryDrafts", || {
        call("existingVersionsArgs", &[collection_config.get(), locale.get(), req.get(), where_.get()])
      })?;
      let existing = await_js(p).await?;
      let existing_versions = get(existing.get(), "docs")?;
      if !js::truthy(host::get_key(existing_versions, js::number(0.0))?) {
        query = full_where.clone();
        let p = db_call(get(req.get(), "payload")?, "findOne", || Ok(find_one_args.get()))?;
        doc_with_locales = await_js(p).await?;
      }
    }
  } else {
    let p = db_call(get(req.get(), "payload")?, "findOne", || Ok(find_one_args.get()))?;
    doc_with_locales = await_js(p).await?;
  }

  if !js::truthy(doc_with_locales.get()) && !js::truthy(get(args.get(), "data")?) {
    if !js::truthy(disable_errors.get()) {
      let t = get(req.get(), "t")?;
      return Err(host::throw_from("notFound", &[t]));
    }
    return Ok(Val::Null);
  }

  // (args.data as DataFromCollectionSlug<TSlug>) ?? docWithLocales!
  let mut result = nullish_or(get_val(args.get(), "data")?, || Ok(doc_with_locales.clone()))?;

  // Add collection property for auth collections
  if js::truthy(get(collection_config.get(), "auth")?) {
    result = call_val("spreadCollection", &[result.get(), collection_config.get()])?;
  }

  // Include Lock Status if required
  if include_lock_status && js::truthy(id.get()) {
    let mut lock_status = Val::Null;
    let locked: JsResult<Val> = async {
      let lock_ms = call_val("lockDurationMs", &[collection_config.get()])?;
      let payload = get(req.get(), "payload")?;
      let find = get(payload, "find")?;
      let find_args = call("findByIDLockArgs", &[collection_config.get(), id.get(), req.get(), lock_ms.get()])?;
      let p = call_fn(find, payload, &[find_args], "req.payload.find")?;
      let locked_document = await_js(p).await?;
      call_val("lockStatusOf", &[locked_document.get()])
    }
    .await;
    if let Ok(status) = locked {
      lock_status = status;
    }
    call("applyLockStatus", &[result.get(), lock_status.get()])?;
  }

  // Replace document with draft if available
  if !should_query_drafts && js::truthy(replace_with_version.get()) && has_drafts_enabled(collection_config.get())? {
    let p = call(
      "replaceWithDraftIfAvailable",
      &[access_result.get(), result.get(), collection_config.get(), override_access.get(), req.get(), select.get()],
    )?;
    result = await_js(p).await?;
  }

  let hooks = |hook_name| ReadHooks {
    collection_config: collection_config.clone(),
    hook_name,
    find_many: false,
    override_access: override_access.clone(),
    query: query.clone(),
    req: req.clone(),
  };

  // beforeRead - Collection
  if has_hooks(collection_config.get(), "beforeRead")? {
    result = hooks("beforeRead").run(HookTarget::Doc(result)).await?;
  }

  // afterRead - Fields
  let after_read_args = call(
    "findByIDAfterReadArgs",
    &[
      collection_config.get(),
      req.get(),
      current_depth.get(),
      depth.get(),
      result.get(),
      replace_with_version.get(),
      fallback_locale.get(),
      flatten_locales.get(),
      locale.get(),
      override_access.get(),
      populate.get(),
      select.get(),
      show_hidden_fields.get(),
    ],
  )?;
  result = await_js(host::after_read(after_read_args)?).await?;

  // afterRead - Collection
  if has_hooks(collection_config.get(), "afterRead")? {
    result = hooks("afterRead").run(HookTarget::Doc(result)).await?;
  }

  // afterOperation - Collection
  let p = build_after_operation(args, collection_config.clone(), "findByID", override_access.clone(), result)?;
  result = await_js(p).await?;

  Ok(result)
}
