//! Port of `packages/payload/src/collections/operations/deleteByID.ts` (`deleteByIDOperation`).

use payload_core_ops::common::{
  AccessArgs, build_after_operation, build_before_operation, execute_access, has_hooks,
};
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::common::{
  await_helper, catch_kill, commit_and_complete, each_hook, init_transaction_unless_disabled, reduce_hooks,
  traverse, truthy_path,
};
use crate::host::{self, at, call, call_fn, call_val, get, get_val, val};

/// `deleteByIDOperation(incomingArgs)`: returns its promise.
pub fn delete_by_id(incoming_args: Local) -> JsResult<Local> {
  host::count_call();
  let incoming_args = val(incoming_args)?;
  spawn(run(incoming_args))
}

async fn run(incoming_args: Val) -> JsResult<Val> {
  let mut args = incoming_args;
  let has_file_operation_scope = truthy_path(get(args.get(), "collection")?, "config", "upload")?;
  let mut managed_delete_identity = Val::Undefined;

  if has_file_operation_scope {
    call("beginFileOperationScope", &[get(args.get(), "req")?])?;
  }

  call("assertNoValidationWrite", &[get(args.get(), "req")?])?;

  let outcome = match body(&mut args, &mut managed_delete_identity, has_file_operation_scope).await {
    Ok(v) => Ok(v),
    Err(error) => catch_kill(&args, has_file_operation_scope, error).await,
  };

  // finally
  if js::truthy(managed_delete_identity.get()) {
    call("clearManagedDeleteIdentity", &[args.get(), managed_delete_identity.get()])?;
  }
  outcome
}

async fn body(args: &mut Val, managed_delete_identity: &mut Val, has_file_operation_scope: bool) -> JsResult<Val> {
  let should_commit = init_transaction_unless_disabled(args).await?;

  // beforeOperation - Collection
  let collection = get_val(get(args.get(), "collection")?, "config")?;
  let override_access_arg = get_val(args.get(), "overrideAccess")?;
  *args = await_js(build_before_operation(args.clone(), collection, "delete", override_access_arg)?).await?;

  let d = call("deleteByIDArgs", &[args.get()])?;
  let id = at(d, 0)?;
  let collection_config = at(d, 1)?;
  let depth = at(d, 2)?;
  let override_access = at(d, 3)?;
  let override_lock = at(d, 4)?;
  let populate = at(d, 5)?;
  let fallback_locale = at(d, 6)?;
  let locale = at(d, 7)?;
  let config = at(d, 8)?;
  let payload = at(d, 9)?;
  let req = at(d, 10)?;
  let incoming_select = at(d, 11)?;
  let show_hidden_fields = at(d, 12)?;
  let trash = at(d, 13)?;

  // Access
  let access_results = if !js::truthy(override_access.get()) {
    let slug = get_val(collection_config.get(), "slug")?;
    let access = get_val(get(collection_config.get(), "access")?, "delete")?;
    let mut a = AccessArgs::new(slug, Val::Undefined, req.clone());
    a.id = id.clone();
    await_js(execute_access(a, access)?).await?
  } else {
    Val::Bool(true)
  };
  let has_where_access = js::truthy(call("hasWhereAccessResult", &[access_results.get()])?);

  // Retrieve document
  let where_ = call_val("idWhere", &[id.get()])?;
  let mut where_ = call_val("combineQueries", &[where_.get(), access_results.get()])?;
  where_ = call_val("appendNonTrashedFilter", &[get(collection_config.get(), "trash")?, trash.get(), where_.get()])?;

  let p = {
    let db = get(get(req.get(), "payload")?, "db")?;
    let f = get(db, "findOne")?;
    let a = call("findOneArgsOf", &[collection_config.get(), get(req.get(), "locale")?, req.get(), where_.get()])?;
    call_fn(f, db, &[a], "req.payload.db.findOne")?
  };
  let doc_to_delete = await_js(p).await?;

  if !js::truthy(doc_to_delete.get()) && !has_where_access {
    return Err(host::throw_from("notFound", &[get(req.get(), "t")?]));
  }
  if !js::truthy(doc_to_delete.get()) && has_where_access {
    return Err(host::throw_from("forbidden", &[get(req.get(), "t")?]));
  }

  // beforeDelete - Collection
  if has_hooks(collection_config.get(), "beforeDelete")? {
    each_hook(&collection_config, "beforeDelete", || {
      call("beforeDeleteHookArgs", &[id.get(), collection_config.get(), req.get()])
    })
    .await?;
  }

  // Handle potentially locked documents
  await_helper(
    "checkDocumentLockStatusDelete",
    &[id.get(), collection_config.get(), override_lock.get(), req.get()],
  )
  .await?;

  let deleted_files = if js::truthy(get(collection_config.get(), "upload")?) {
    let stored = await_helper("collectStoredFiles", &[collection_config.get(), doc_to_delete.get(), req.get()]).await?;
    let versions = if js::truthy(get(collection_config.get(), "versions")?) {
      await_helper("collectVersionFiles", &[collection_config.get(), id.get(), req.get()]).await?
    } else {
      val(js::array())?
    };
    call_val("concatSpread", &[stored.get(), versions.get()])?
  } else {
    val(js::array())?
  };

  if js::truthy(get(deleted_files.get(), "length")?) {
    *managed_delete_identity = call_val("markManagedDelete", &[collection_config.get(), id.get(), req.get()])?;
  }

  await_helper(
    "deleteAssociatedFilesDelete",
    &[collection_config.get(), config.get(), doc_to_delete.get(), req.get()],
  )
  .await?;

  // Delete versions
  if js::truthy(get(collection_config.get(), "versions")?) {
    await_helper("deleteCollectionVersionsByID", &[id.get(), collection_config.get(), payload.get(), req.get()]).await?;
  }

  // Delete scheduled posts
  if js::truthy(call("hasScheduledPublishEnabled", &[collection_config.get()])?) {
    await_helper("deleteScheduledPublishJobsByID", &[id.get(), collection_config.get(), payload.get(), req.get()])
      .await?;
  }

  let select = call_val("writeSelect", &[collection_config.get(), js::string("delete"), req.get(), incoming_select.get()])?;

  // Delete document
  let p = {
    let db = get(get(req.get(), "payload")?, "db")?;
    let f = get(db, "deleteOne")?;
    let a = call("deleteOneArgs", &[collection_config.get(), req.get(), select.get(), id.get()])?;
    call_fn(f, db, &[a], "req.payload.db.deleteOne")?
  };
  let mut result = await_js(p).await?;

  if js::truthy(get(collection_config.get(), "upload")?) {
    await_helper(
      "scheduleUnreferencedFileCleanup",
      &[deleted_files.get(), collection_config.get(), req.get()],
    )
    .await?;
  }

  // Add collection property for auth collections
  if js::truthy(get(collection_config.get(), "auth")?) {
    result = call_val("withCollection", &[result.get(), collection_config.get()])?;
  }

  // Delete Preferences
  await_helper("deleteUserPreferencesOfID", &[collection_config.get(), id.get(), payload.get(), req.get()]).await?;

  // afterRead - Fields
  let ar_args = call(
    "afterReadArgsWithoutDraft",
    &[
      collection_config.get(),
      req.get(),
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
  result = traverse("afterRead", ar_args).await?;

  // afterRead - Collection
  if has_hooks(collection_config.get(), "afterRead")? {
    result = reduce_hooks(&collection_config, "afterRead", result, |doc| {
      call("afterReadHookArgs", &[collection_config.get(), req.get(), doc, override_access.get()])
    })
    .await?;
  }

  // afterDelete - Collection
  if has_hooks(collection_config.get(), "afterDelete")? {
    result = reduce_hooks(&collection_config, "afterDelete", result, |doc| {
      call("afterDeleteHookArgs", &[id.get(), collection_config.get(), req.get(), doc])
    })
    .await?;
  }

  // afterOperation - Collection
  let p = build_after_operation(args.clone(), collection_config.clone(), "deleteByID", override_access.clone(), result)?;
  result = await_js(p).await?;

  commit_and_complete(&req, should_commit, has_file_operation_scope).await?;

  Ok(result)
}
