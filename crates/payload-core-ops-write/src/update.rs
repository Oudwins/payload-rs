//! Port of `packages/payload/src/collections/operations/update.ts` (`updateOperation`, bulk).

use std::rc::Rc;

use payload_core_ops::common::{
  AccessArgs, build_after_operation, build_before_operation, db_call, execute_access, has_drafts_enabled,
  sanitize_sort_query,
};
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Thrown, Val};

use crate::common::{
  await_helper, catch_with_unlink, commit_and_complete, init_transaction_unless_disabled, truthy_path,
};
use crate::host::{self, at, call, call_val, get, get_val, is_nullish, map_array, promise_all, val};
use crate::update_document::update_document;

/// `updateOperation(incomingArgs)`: returns its promise.
pub fn update(incoming_args: Local) -> JsResult<Local> {
  host::count_call();
  let incoming_args = val(incoming_args)?;
  spawn(run(incoming_args))
}

async fn run(incoming_args: Val) -> JsResult<Val> {
  let mut args = incoming_args;
  let has_file_operation_scope = truthy_path(get(args.get(), "collection")?, "config", "upload")?;

  call("assertNoValidationWrite", &[get(args.get(), "req")?])?;

  if truthy_path(get(args.get(), "collection")?, "config", "disableBulkEdit")?
    && !js::truthy(get(args.get(), "overrideAccess")?)
  {
    return Err(host::throw_from("bulkEditDisabled", &[args.get()]));
  }

  if has_file_operation_scope {
    call("beginFileOperationScope", &[get(args.get(), "req")?])?;
  }

  match body(&mut args, has_file_operation_scope).await {
    Ok(v) => Ok(v),
    Err(error) => catch_with_unlink(&args, has_file_operation_scope, error).await,
  }
}

/// What `processDocument` closes over.
struct Ctx {
  autosave: Val,
  collection_config: Val,
  collection: Val,
  config: Val,
  depth: Val,
  draft_arg: Val,
  fallback_locale: Val,
  locale: Val,
  override_access: Val,
  override_lock: Val,
  overwrite_existing_files: Val,
  payload: Val,
  populate: Val,
  publish_all_locales: Val,
  req: Val,
  incoming_select: Val,
  show_hidden_fields: Val,
  unpublish_all_locales: Val,
  bulk_update_data: Val,
  shared_generated_file_data: Val,
  errors: Val,
}

async fn body(args: &mut Val, has_file_operation_scope: bool) -> JsResult<Val> {
  let should_commit = init_transaction_unless_disabled(args).await?;

  if truthy_path(get(args.get(), "collection")?, "config", "upload")?
    && !js::truthy(get(args.get(), "overrideAccess")?)
  {
    *args = call_val("sanitizeUploadArgs", &[args.get()])?;
  }

  call("validatePublicationFlagsOfArgs", &[args.get()])?;

  let initial_intent = call_val("updateInitialPublicationIntent", &[args.get()])?;

  // beforeOperation - Collection
  let collection = get_val(get(args.get(), "collection")?, "config")?;
  let override_access_arg = get_val(args.get(), "overrideAccess")?;
  *args = await_js(build_before_operation(args.clone(), collection, "update", override_access_arg)?).await?;

  let d = call("updateArgs", &[args.get()])?;
  let autosave = at(d, 0)?;
  let collection_config = at(d, 1)?;
  let collection = at(d, 2)?;
  let depth = at(d, 3)?;
  let draft_arg = at(d, 4)?;
  let limit = at(d, 5)?;
  let override_access = at(d, 6)?;
  let override_lock = at(d, 7)?;
  let overwrite_existing_files = at(d, 8)?;
  let populate = at(d, 9)?;
  let publish_all_locales_arg = at(d, 10)?;
  let fallback_locale = at(d, 11)?;
  let locale = at(d, 12)?;
  let config = at(d, 13)?;
  let payload = at(d, 14)?;
  let req = at(d, 15)?;
  let incoming_select = at(d, 16)?;
  let show_hidden_fields = at(d, 17)?;
  let incoming_sort = at(d, 18)?;
  let trash = at(d, 19)?;
  let unpublish_all_locales_arg = at(d, 20)?;
  let where_ = at(d, 21)?;

  if !js::truthy(where_.get()) {
    return Err(host::throw_from("missingUpdateWhere", &[]));
  }

  let bulk_update_data = get_val(args.get(), "data")?;

  let pb = call(
    "updatePublication",
    &[
      publish_all_locales_arg.get(),
      unpublish_all_locales_arg.get(),
      draft_arg.get(),
      collection_config.get(),
      config.get(),
      locale.get(),
      bulk_update_data.get(),
      initial_intent.get(),
    ],
  )?;
  let publish_all_locales = at(pb, 0)?;
  let unpublish_all_locales = at(pb, 1)?;

  let should_save_draft = js::truthy(draft_arg.get()) && has_drafts_enabled(collection_config.get())?;

  // Access
  let mut access_result = Val::Undefined;
  if !js::truthy(override_access.get()) {
    let slug = get_val(collection_config.get(), "slug")?;
    let access = get_val(get(collection_config.get(), "access")?, "update")?;
    let mut a = AccessArgs::new(slug, Val::Undefined, req.clone());
    a.data = bulk_update_data.clone();
    access_result = await_js(execute_access(a, access)?).await?;
  }

  await_helper(
    "validateQueryPaths",
    &[collection_config.get(), override_access.get(), req.get(), where_.get()],
  )
  .await?;

  // Retrieve documents
  let mut full_where = call_val("combineQueries", &[where_.get(), access_result.get()])?;

  let is_trash_attempt = js::truthy(call("isTrashAttempt", &[collection_config.get(), bulk_update_data.get()])?);

  if is_trash_attempt && !js::truthy(override_access.get()) {
    let slug = get_val(collection_config.get(), "slug")?;
    let access = get_val(get(collection_config.get(), "access")?, "delete")?;
    let mut a = AccessArgs::new(slug, Val::Undefined, req.clone());
    a.data = bulk_update_data.clone();
    let delete_access_result = await_js(execute_access(a, access)?).await?;
    full_where = call_val("combineQueries", &[full_where.get(), delete_access_result.get()])?;
  }

  full_where = call_val(
    "appendNonTrashedFilter",
    &[get(collection_config.get(), "trash")?, trash.get(), full_where.get()],
  )?;

  call(
    "sanitizeWhereQuery",
    &[get(collection_config.get(), "flattenedFields")?, payload.get(), full_where.get()],
  )?;

  // sanitizeSortQuery({ fields: collection.config.flattenedFields, sort: incomingSort || collectionConfig.defaultSort })
  let fields = get(get(collection.get(), "config")?, "flattenedFields")?;
  let sort_arg = if js::truthy(incoming_sort.get()) {
    incoming_sort.get()
  } else {
    get(collection_config.get(), "defaultSort")?
  };
  let sort = val(sanitize_sort_query(fields, sort_arg)?)?;

  await_helper("validateSortQuery", &[collection_config.get(), override_access.get(), req.get(), sort.get()]).await?;

  let docs = if has_drafts_enabled(collection_config.get())? && (should_save_draft || is_trash_attempt) {
    let versions_where = call_val("appendVersionToQueryKey", &[full_where.get()])?;

    await_helper(
      "validateVersionQueryPaths",
      &[collection.get(), override_access.get(), req.get(), payload.get(), where_.get()],
    )
    .await?;

    let p = db_call(payload.get(), "queryDrafts", || {
      call(
        "bulkQueryDraftsArgs",
        &[collection_config.get(), limit.get(), locale.get(), req.get(), sort.get(), versions_where.get()],
      )
    })?;
    let query = await_js(p).await?;
    get_val(query.get(), "docs")?
  } else {
    let p = db_call(payload.get(), "find", || {
      call(
        "bulkFindArgs",
        &[collection_config.get(), limit.get(), locale.get(), req.get(), sort.get(), full_where.get()],
      )
    })?;
    let query = await_js(p).await?;
    get_val(query.get(), "docs")?
  };

  let shared_generated_file_data = if !js::truthy(get(collection_config.get(), "upload")?) {
    await_helper(
      "bulkGenerateFileData",
      &[
        collection.get(),
        config.get(),
        bulk_update_data.get(),
        overwrite_existing_files.get(),
        req.get(),
      ],
    )
    .await?
  } else {
    Val::Null
  };

  let errors = val(js::array())?;

  let ctx = Rc::new(Ctx {
    autosave,
    collection_config: collection_config.clone(),
    collection,
    config: config.clone(),
    depth,
    draft_arg,
    fallback_locale,
    locale,
    override_access: override_access.clone(),
    override_lock,
    overwrite_existing_files,
    payload,
    populate,
    publish_all_locales,
    req: req.clone(),
    incoming_select,
    show_hidden_fields,
    unpublish_all_locales,
    bulk_update_data,
    shared_generated_file_data,
    errors: errors.clone(),
  });

  let process_sequentially = js::truthy(call("processSequentially", &[req.get(), collection_config.get()])?);
  let awaited_docs = if process_sequentially {
    let awaited = val(js::array())?;
    let docs_iter = host::iterable(docs.get())?;
    let mut i = 0;
    while i < js::array_length(docs_iter.get()) {
      let doc = val(host::element(docs_iter.get(), i)?)?;
      let p = spawn(process_document(ctx.clone(), doc))?;
      let r = await_js(p).await?;
      js::push(awaited.get(), r.get())?;
      i += 1;
    }
    awaited
  } else {
    let promises = map_array(docs.get(), "docs", |doc| {
      let doc = val(doc)?;
      spawn(process_document(ctx.clone(), doc))
    })?;
    await_js(promise_all(promises)?).await?
  };

  await_helper("unlinkTempFilesCaught", &[collection_config.get(), config.get(), req.get()]).await?;

  let mut result = call_val("bulkResult", &[awaited_docs.get(), errors.get()])?;

  // afterOperation - Collection
  let p = build_after_operation(args.clone(), collection_config.clone(), "update", override_access.clone(), result)?;
  result = await_js(p).await?;

  commit_and_complete(&req, should_commit, has_file_operation_scope).await?;

  Ok(result)
}

/// The `processDocument` async arrow of update.ts.
async fn process_document(ctx: Rc<Ctx>, incoming_doc: Val) -> JsResult<Val> {
  let mut doc_with_locales = incoming_doc.clone();
  let id = get_val(doc_with_locales.get(), "id")?;
  let mut document_temp_file_path = Val::Undefined;
  let mut document_req = ctx.req.clone();

  let outcome: JsResult<Val> = async {
    let mut doc_should_commit = false;
    if js::truthy(get(get(get(ctx.req.get(), "payload")?, "db")?, "bulkOperationsSingleTransaction")?) {
      let r = await_helper("initTransaction", &[ctx.req.get()]).await?;
      doc_should_commit = js::truthy(r.get());
    }

    let document_file = call_val("copyRequestFile", &[ctx.req.get()])?;
    let temp_path = call_val("documentTempFilePathFor", &[ctx.collection_config.get(), document_file.get()])?;
    if !temp_path.is_undefined() {
      document_temp_file_path = temp_path;
      await_helper("copyFile", &[get(document_file.get(), "tempFilePath")?, document_temp_file_path.get()]).await?;
      host::set(document_file.get(), "tempFilePath", document_temp_file_path.get())?;
    }

    if js::truthy(get(ctx.collection_config.get(), "upload")?) && matches!(ctx.shared_generated_file_data, Val::Null) {
      document_req = call_val("isolateUploadRequest", &[ctx.req.get()])?;
      if !doc_should_commit {
        call("shareFileOperationScope", &[ctx.req.get(), document_req.get()])?;
      }
      call("setDocumentRequestFile", &[document_req.get(), document_file.get()])?;
    }
    if js::truthy(host::opt(get(ctx.collection_config.get(), "upload")?, "fileOperations")?) {
      doc_with_locales = await_helper(
        "withLegacyCloudUploadFileData",
        &[ctx.collection_config.get(), doc_with_locales.get(), document_req.get()],
      )
      .await?;
    }
    let generated_file_data = if !is_nullish(ctx.shared_generated_file_data.get()) {
      ctx.shared_generated_file_data.clone()
    } else {
      await_helper(
        "bulkDocumentGenerateFileData",
        &[
          ctx.collection.get(),
          ctx.config.get(),
          ctx.bulk_update_data.get(),
          doc_with_locales.get(),
          ctx.locale.get(),
          ctx.collection_config.get(),
          ctx.overwrite_existing_files.get(),
          document_req.get(),
        ],
      )
      .await?
    };

    let select = call_val(
      "writeSelect",
      &[ctx.collection_config.get(), js::string("update"), ctx.req.get(), ctx.incoming_select.get()],
    )?;

    // Update document, runs all document level hooks
    let document_data = call_val(
      "copyDataWithFreshRowIDs",
      &[ctx.config.get(), generated_file_data.get(), doc_with_locales.get(), ctx.collection_config.get()],
    )?;
    let update_args = call_val(
      "bulkUpdateArgs",
      &[
        id.get(),
        ctx.autosave.get(),
        ctx.collection_config.get(),
        ctx.config.get(),
        document_data.get(),
        ctx.depth.get(),
        doc_with_locales.get(),
        ctx.draft_arg.get(),
        ctx.fallback_locale.get(),
        generated_file_data.get(),
        ctx.locale.get(),
        ctx.override_access.get(),
        ctx.override_lock.get(),
        ctx.payload.get(),
        ctx.populate.get(),
        ctx.publish_all_locales.get(),
        document_req.get(),
        select.get(),
        ctx.show_hidden_fields.get(),
        ctx.unpublish_all_locales.get(),
      ],
    )?;
    let mut updated_doc = if truthy_path(ctx.collection_config.get(), "upload", "fileOperations")? {
      let ua = update_args.clone();
      let write = host::closure("write", move |_| update_document(ua.get()))?;
      await_helper(
        "runCloudFileUpdate",
        &[
          id.get(),
          ctx.collection_config.get(),
          incoming_doc.get(),
          update_args.get(),
          get(generated_file_data.get(), "files")?,
          document_req.get(),
          write,
        ],
      )
      .await?
    } else {
      await_js(update_document(update_args.get())?).await?
    };

    // Add collection property for auth collections
    if js::truthy(get(ctx.collection_config.get(), "auth")?) {
      updated_doc = call_val("withCollection", &[updated_doc.get(), ctx.collection_config.get()])?;
    }

    if doc_should_commit {
      await_helper("commitTransaction", &[document_req.get()]).await?;
    }

    Ok(updated_doc)
  }
  .await;

  let outcome = match outcome {
    Ok(v) => Ok(Some(v)),
    Err(Thrown(error)) => {
      let caught: JsResult<()> = async {
        let is_public = call_val("bulkErrorIsPublic", &[error.get(), ctx.config.get()])?;
        if js::truthy(get(get(get(ctx.req.get(), "payload")?, "db")?, "bulkOperationsSingleTransaction")?) {
          await_helper("killTransaction", &[document_req.get()]).await?;
        }
        call("pushBulkError", &[ctx.errors.get(), id.get(), is_public.get(), error.get()])?;
        Ok(())
      }
      .await;
      caught.map(|_| None)
    }
  };

  // finally
  if js::truthy(document_temp_file_path.get()) {
    await_helper("removeTempFileCopy", &[document_temp_file_path.get(), ctx.req.get()]).await?;
  }

  match outcome? {
    Some(v) => Ok(v),
    None => Ok(Val::Null),
  }
}
