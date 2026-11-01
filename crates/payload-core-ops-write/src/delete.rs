//! Port of `packages/payload/src/collections/operations/delete.ts` (`deleteOperation`, bulk).

use std::cell::Cell as StdCell;
use std::rc::Rc;

use payload_core_ops::common::{AccessArgs, build_after_operation, build_before_operation, db_call, execute_access, has_hooks};
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Thrown, Val};

use crate::common::{await_helper, each_hook, reduce_hooks, traverse, truthy_path};
use crate::host::{self, at, call, call_val, get, get_val, map_array, promise_all, val};

/// `deleteOperation(incomingArgs)`: returns its promise.
pub fn delete(incoming_args: Local) -> JsResult<Local> {
  host::count_call();
  let incoming_args = val(incoming_args)?;
  spawn(run(incoming_args))
}

fn single_transaction(req: Local) -> JsResult<bool> {
  Ok(js::truthy(get(get(get(req, "payload")?, "db")?, "bulkOperationsSingleTransaction")?))
}

async fn run(incoming_args: Val) -> JsResult<Val> {
  let mut args = incoming_args;

  call("assertNoValidationWrite", &[get(args.get(), "req")?])?;

  if truthy_path(get(args.get(), "collection")?, "config", "disableBulkDelete")?
    && !js::truthy(get(args.get(), "overrideAccess")?)
  {
    return Err(host::throw_from("bulkDeleteDisabled", &[args.get()]));
  }

  let has_file_operation_scope = truthy_path(get(args.get(), "collection")?, "config", "upload")?
    && !single_transaction(get(args.get(), "req")?)?;
  let marked_managed_deletes = call_val("newSet", &[])?;

  if has_file_operation_scope {
    call("beginFileOperationScope", &[get(args.get(), "req")?])?;
  }

  let outcome = match body(&mut args, &marked_managed_deletes, has_file_operation_scope).await {
    Ok(v) => Ok(v),
    Err(error) => {
      let caught: JsResult<()> = async {
        let req = get(args.get(), "req")?;
        await_helper("killTransaction", &[req]).await?;
        if has_file_operation_scope {
          let req = get(args.get(), "req")?;
          await_helper("abortFileOperationScope", &[req]).await?;
        }
        Ok(())
      }
      .await;
      match caught {
        Ok(()) => Err(error),
        Err(e) => Err(e),
      }
    }
  };

  // finally
  call("clearMarkedManagedDeletes", &[args.get(), marked_managed_deletes.get()])?;
  outcome
}

/// What the inner arrows of delete.ts close over.
struct Ctx {
  collection_config: Val,
  config: Val,
  depth: Val,
  fallback_locale: Val,
  locale: Val,
  override_access: Val,
  override_lock: Val,
  payload: Val,
  populate: Val,
  req: Val,
  select: Val,
  show_hidden_fields: Val,
  docs: Val,
  errors: Val,
  deleted_files_by_id: Val,
  managed_deleted_uploads: Val,
  marked_managed_deletes: Val,
  did_batch_delete_fail: StdCell<bool>,
  should_commit: bool,
}

impl Ctx {
  /// `pushError(id, error, message?)`
  fn push_error(&self, id: Local, error: Local, message: Local) -> JsResult<()> {
    call("pushError", &[self.errors.get(), id, error, self.config.get(), message]).map(|_| ())
  }
}

async fn body(args: &mut Val, marked_managed_deletes: &Val, has_file_operation_scope: bool) -> JsResult<Val> {
  let should_commit = if js::truthy(get(args.get(), "disableTransaction")?) || single_transaction(get(args.get(), "req")?)? {
    false
  } else {
    let r = await_helper("initTransaction", &[get(args.get(), "req")?]).await?;
    js::truthy(r.get())
  };

  // beforeOperation - Collection
  let collection = get_val(get(args.get(), "collection")?, "config")?;
  let override_access_arg = get_val(args.get(), "overrideAccess")?;
  *args = await_js(build_before_operation(args.clone(), collection, "delete", override_access_arg)?).await?;

  let d = call("deleteArgs", &[args.get()])?;
  let collection_config = at(d, 0)?;
  let depth = at(d, 1)?;
  let override_access = at(d, 2)?;
  let override_lock = at(d, 3)?;
  let populate = at(d, 4)?;
  let fallback_locale = at(d, 5)?;
  let locale = at(d, 6)?;
  let config = at(d, 7)?;
  let payload = at(d, 8)?;
  let req = at(d, 9)?;
  let incoming_select = at(d, 10)?;
  let show_hidden_fields = at(d, 11)?;
  let trash = at(d, 12)?;
  let where_ = at(d, 13)?;

  if !js::truthy(where_.get()) {
    return Err(host::throw_from("missingDeleteWhere", &[]));
  }

  // Access
  let mut access_result = Val::Undefined;
  if !js::truthy(override_access.get()) {
    let slug = get_val(collection_config.get(), "slug")?;
    let access = get_val(get(collection_config.get(), "access")?, "delete")?;
    let a = AccessArgs::new(slug, Val::Undefined, req.clone());
    access_result = await_js(execute_access(a, access)?).await?;
  }

  await_helper(
    "validateQueryPaths",
    &[collection_config.get(), override_access.get(), req.get(), where_.get()],
  )
  .await?;

  let mut full_where = call_val("combineQueries", &[where_.get(), access_result.get()])?;
  full_where = call_val(
    "appendNonTrashedFilter",
    &[get(collection_config.get(), "trash")?, trash.get(), full_where.get()],
  )?;
  call(
    "sanitizeWhereQuery",
    &[get(collection_config.get(), "flattenedFields")?, payload.get(), full_where.get()],
  )?;

  let select = call_val("writeSelect", &[collection_config.get(), js::string("delete"), req.get(), incoming_select.get()])?;

  // Retrieve documents
  let p = db_call(payload.get(), "find", || {
    call("bulkDeleteFindArgs", &[collection_config.get(), locale.get(), req.get(), select.get(), full_where.get()])
  })?;
  let found = await_js(p).await?;
  let docs = get_val(found.get(), "docs")?;

  let errors = val(js::array())?;
  let deleted_files_by_id = call_val("newMap", &[])?;
  let managed_deleted_uploads = call_val("managedDeletedUploadsOf", &[req.get()])?;

  let ctx = Rc::new(Ctx {
    collection_config: collection_config.clone(),
    config,
    depth,
    fallback_locale,
    locale,
    override_access: override_access.clone(),
    override_lock,
    payload: payload.clone(),
    populate,
    req: req.clone(),
    select,
    show_hidden_fields,
    docs: docs.clone(),
    errors: errors.clone(),
    deleted_files_by_id,
    managed_deleted_uploads,
    marked_managed_deletes: marked_managed_deletes.clone(),
    did_batch_delete_fail: StdCell::new(false),
    should_commit,
  });

  let awaited_docs = if single_transaction(req.get())? {
    // Process sequentially so that each document's transaction is isolated from the next
    let awaited = val(js::array())?;
    let docs_iter = host::iterable(docs.get())?;
    let mut i = 0;
    while i < js::array_length(docs_iter.get()) {
      let doc = val(host::element(docs_iter.get(), i)?)?;
      let r = await_js(spawn(delete_document_individually(ctx.clone(), doc))?).await?;
      js::push(awaited.get(), r.get())?;
      i += 1;
    }
    awaited
  } else {
    await_js(spawn(delete_documents_in_bulk(ctx.clone()))?).await?
  };

  // Delete Preferences
  if !ctx.did_batch_delete_fail.get() {
    await_helper("deleteUserPreferencesOfDocs", &[collection_config.get(), docs.get(), payload.get(), req.get()]).await?;
  }

  let mut result = call_val("bulkResult", &[awaited_docs.get(), errors.get()])?;

  // afterOperation - Collection
  let p = build_after_operation(args.clone(), collection_config.clone(), "delete", override_access.clone(), result)?;
  result = await_js(p).await?;

  if should_commit && !ctx.did_batch_delete_fail.get() {
    await_helper("commitTransaction", &[req.get()]).await?;
  }

  if has_file_operation_scope {
    await_helper("completeFileOperationScope", &[req.get()]).await?;
  }

  Ok(result)
}

/// `runBeforeDeleteWork(doc)`
async fn run_before_delete_work(ctx: Rc<Ctx>, doc: Val) -> JsResult<Val> {
  let cc = &ctx.collection_config;
  if has_hooks(cc.get(), "beforeDelete")? {
    each_hook(cc, "beforeDelete", || {
      call("beforeDeleteHookArgs", &[get(doc.get(), "id")?, cc.get(), ctx.req.get()])
    })
    .await?;
  }

  if js::truthy(get(cc.get(), "upload")?) {
    let stored = await_helper("collectStoredFiles", &[cc.get(), doc.get(), ctx.req.get()]).await?;
    let versions = if js::truthy(get(cc.get(), "versions")?) {
      await_helper("collectVersionFiles", &[cc.get(), get(doc.get(), "id")?, ctx.req.get()]).await?
    } else {
      val(js::array())?
    };
    call(
      "recordDeletedFiles",
      &[
        ctx.deleted_files_by_id.get(),
        doc.get(),
        stored.get(),
        versions.get(),
        cc.get(),
        ctx.managed_deleted_uploads.get(),
        ctx.marked_managed_deletes.get(),
      ],
    )?;
  }

  await_helper("deleteAssociatedFilesDelete", &[cc.get(), ctx.config.get(), doc.get(), ctx.req.get()]).await?;
  Ok(Val::Undefined)
}

/// `runAfterDeleteWork(doc)`
async fn run_after_delete_work(ctx: Rc<Ctx>, doc: Val) -> JsResult<Val> {
  let cc = &ctx.collection_config;
  let ar_args = call(
    "afterReadArgsWithoutDraft",
    &[
      cc.get(),
      ctx.req.get(),
      ctx.depth.get(),
      doc.get(),
      ctx.fallback_locale.get(),
      ctx.locale.get(),
      ctx.override_access.get(),
      ctx.populate.get(),
      ctx.select.get(),
      ctx.show_hidden_fields.get(),
    ],
  )?;
  let mut result = traverse("afterRead", ar_args).await?;

  // Add collection property for auth collections
  if js::truthy(get(cc.get(), "auth")?) {
    result = call_val("withCollection", &[result.get(), cc.get()])?;
  }

  if has_hooks(cc.get(), "afterRead")? {
    result = reduce_hooks(cc, "afterRead", result, |r| {
      let target = if js::truthy(r) { r } else { doc.get() };
      call("afterReadHookArgs", &[cc.get(), ctx.req.get(), target, ctx.override_access.get()])
    })
    .await?;
  }

  if has_hooks(cc.get(), "afterDelete")? {
    result = reduce_hooks(cc, "afterDelete", result, |r| {
      call("afterDeleteHookArgs", &[get(doc.get(), "id")?, cc.get(), ctx.req.get(), r])
    })
    .await?;
  }

  Ok(result)
}

/// `deleteDocumentIndividually(doc)`
async fn delete_document_individually(ctx: Rc<Ctx>, doc: Val) -> JsResult<Val> {
  let cc = ctx.collection_config.clone();
  let has_individual_file_scope = js::truthy(get(cc.get(), "upload")?);

  if has_individual_file_scope {
    call("beginFileOperationScope", &[ctx.req.get()])?;
  }

  let outcome: JsResult<Val> = async {
    let r = await_helper("initTransaction", &[ctx.req.get()]).await?;
    let doc_should_commit = js::truthy(r.get());

    await_helper(
      "checkDocumentLockStatusDelete",
      &[get(doc.get(), "id")?, cc.get(), ctx.override_lock.get(), ctx.req.get()],
    )
    .await?;

    await_js(spawn(run_before_delete_work(ctx.clone(), doc.clone()))?).await?;

    if js::truthy(get(cc.get(), "versions")?) {
      await_helper(
        "deleteCollectionVersionsByID",
        &[get(doc.get(), "id")?, cc.get(), ctx.payload.get(), ctx.req.get()],
      )
      .await?;
    }

    if js::truthy(call("hasScheduledPublishEnabled", &[cc.get()])?) {
      await_helper(
        "deleteScheduledPublishJobsByID",
        &[get(doc.get(), "id")?, cc.get(), ctx.payload.get(), ctx.req.get()],
      )
      .await?;
    }

    let p = db_call(ctx.payload.get(), "deleteOne", || {
      call("deleteOneNoReturnArgs", &[cc.get(), ctx.req.get(), get(doc.get(), "id")?])
    })?;
    await_js(p).await?;

    if js::truthy(get(cc.get(), "upload")?) {
      let candidates = call("deletedFilesOf", &[ctx.deleted_files_by_id.get(), doc.get()])?;
      await_helper("scheduleUnreferencedFileCleanup", &[candidates, cc.get(), ctx.req.get()]).await?;
    }

    let result = await_js(spawn(run_after_delete_work(ctx.clone(), doc.clone()))?).await?;

    if doc_should_commit {
      await_helper("commitTransaction", &[ctx.req.get()]).await?;
    }

    if has_individual_file_scope {
      await_helper("completeFileOperationScope", &[ctx.req.get()]).await?;
    }

    Ok(result)
  }
  .await;

  match outcome {
    Ok(v) => Ok(v),
    Err(Thrown(error)) => {
      await_helper("killTransaction", &[ctx.req.get()]).await?;
      if has_individual_file_scope {
        await_helper("abortFileOperationScope", &[ctx.req.get()]).await?;
      }
      ctx.push_error(get(doc.get(), "id")?, error.get(), js::undefined())?;
      Ok(Val::Null)
    }
  }
}

/// `deleteDocumentsInBulk()`
async fn delete_documents_in_bulk(ctx: Rc<Ctx>) -> JsResult<Val> {
  let cc = ctx.collection_config.clone();
  let results = call_val("nullFilledArray", &[ctx.docs.get()])?;

  // Handle potentially locked documents
  let locked_ids = await_helper(
    "getLockedDocumentIds",
    &[cc.get(), ctx.docs.get(), ctx.override_lock.get(), ctx.req.get()],
  )
  .await?;

  let unlocked = call_val("partitionLocked", &[ctx.docs.get(), locked_ids.get(), ctx.errors.get(), ctx.config.get()])?;

  await_helper("deleteDocumentLocks", &[cc.get(), unlocked.get(), ctx.req.get()]).await?;

  let deletable = val(js::array())?;

  let promises = map_array(unlocked.get(), "unlocked", |entry| {
    let entry = val(entry)?;
    let ctx = ctx.clone();
    let deletable = deletable.clone();
    spawn(async move {
      let r: JsResult<Val> = async {
        let doc = get_val(entry.get(), "doc")?;
        await_js(spawn(run_before_delete_work(ctx.clone(), doc))?).await?;
        js::push(deletable.get(), entry.get())?;
        Ok(Val::Undefined)
      }
      .await;
      if let Err(Thrown(error)) = r {
        ctx.push_error(get(get(entry.get(), "doc")?, "id")?, error.get(), js::undefined())?;
      }
      Ok(Val::Undefined)
    })
  })?;
  await_js(promise_all(promises)?).await?;

  if !js::truthy(get(deletable.get(), "length")?) {
    return Ok(results);
  }

  let ids = call_val("entryIds", &[deletable.get()])?;

  // Delete versions
  if js::truthy(get(cc.get(), "versions")?) {
    await_helper("deleteCollectionVersionsByIDs", &[cc.get(), ids.get(), ctx.payload.get(), ctx.req.get()]).await?;
  }

  // Delete scheduled posts
  if js::truthy(call("hasScheduledPublishEnabled", &[cc.get()])?) {
    await_helper("deleteScheduledPublishJobsByIDs", &[cc.get(), ids.get(), ctx.payload.get(), ctx.req.get()]).await?;
  }

  // Delete documents
  let deleted: JsResult<Val> = async {
    let p = db_call(ctx.payload.get(), "deleteMany", || {
      call("deleteManyArgs", &[cc.get(), ctx.req.get(), ids.get()])
    })?;
    await_js(p).await
  }
  .await;
  if let Err(Thrown(error)) = deleted {
    ctx.did_batch_delete_fail.set(true);

    if ctx.should_commit {
      await_helper("killTransaction", &[ctx.req.get()]).await?;
    }

    let message = call("bulkDeleteFailedMessage", &[deletable.get(), error.get()])?;
    let message = val(message)?;

    let entries = host::iterable(deletable.get())?;
    let mut i = 0;
    while i < js::array_length(entries.get()) {
      let entry = host::element(entries.get(), i)?;
      let doc_id = get(get(entry, "doc")?, "id")?;
      ctx.push_error(doc_id, error.get(), message.get())?;
      i += 1;
    }

    return Ok(results);
  }

  if js::truthy(get(cc.get(), "upload")?) {
    let candidates = call("deletableFiles", &[deletable.get(), ctx.deleted_files_by_id.get()])?;
    await_helper("scheduleUnreferencedFileCleanup", &[candidates, cc.get(), ctx.req.get()]).await?;
  }

  let promises = map_array(deletable.get(), "deletable", |entry| {
    let entry = val(entry)?;
    let ctx = ctx.clone();
    let results = results.clone();
    spawn(async move {
      let r: JsResult<Val> = async {
        let doc = get_val(entry.get(), "doc")?;
        let index = get_val(entry.get(), "index")?;
        let result = await_js(spawn(run_after_delete_work(ctx.clone(), doc))?).await?;
        host::set_key(results.get(), index.get(), result.get())?;
        Ok(Val::Undefined)
      }
      .await;
      if let Err(Thrown(error)) = r {
        ctx.push_error(get(get(entry.get(), "doc")?, "id")?, error.get(), js::undefined())?;
      }
      Ok(Val::Undefined)
    })
  })?;
  await_js(promise_all(promises)?).await?;

  Ok(results)
}
