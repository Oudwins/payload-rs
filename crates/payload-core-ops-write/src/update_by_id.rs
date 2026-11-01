//! Port of `packages/payload/src/collections/operations/updateByID.ts` (`updateByIDOperation`).

use payload_core_ops::common::{AccessArgs, build_after_operation, build_before_operation, execute_access};
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::common::{
  await_helper, catch_with_unlink, commit_and_complete, init_transaction_unless_disabled, truthy_path,
};
use crate::host::{self, at, call, call_val, get, get_val, val};
use crate::update_document::update_document;

/// `updateByIDOperation(incomingArgs)`: returns its promise.
pub fn update_by_id(incoming_args: Local) -> JsResult<Local> {
  host::count_call();
  let incoming_args = val(incoming_args)?;
  spawn(run(incoming_args))
}

async fn run(incoming_args: Val) -> JsResult<Val> {
  let mut args = incoming_args;
  let has_file_operation_scope = truthy_path(get(args.get(), "collection")?, "config", "upload")?;

  if has_file_operation_scope {
    call("beginFileOperationScope", &[get(args.get(), "req")?])?;
  }

  call("assertNoValidationWrite", &[get(args.get(), "req")?])?;

  match body(&mut args, has_file_operation_scope).await {
    Ok(v) => Ok(v),
    Err(error) => catch_with_unlink(&args, has_file_operation_scope, error).await,
  }
}

async fn body(args: &mut Val, has_file_operation_scope: bool) -> JsResult<Val> {
  let should_commit = init_transaction_unless_disabled(args).await?;

  if truthy_path(get(args.get(), "collection")?, "config", "upload")?
    && !js::truthy(get(args.get(), "overrideAccess")?)
  {
    *args = call_val("sanitizeUploadArgs", &[args.get()])?;
  }

  call("validatePublicationFlagsOfArgs", &[args.get()])?;

  let initial_intent = call_val("updateByIDInitialPublicationIntent", &[args.get()])?;

  // beforeOperation - Collection
  let collection = get_val(get(args.get(), "collection")?, "config")?;
  let override_access_arg = get_val(args.get(), "overrideAccess")?;
  *args = await_js(build_before_operation(args.clone(), collection, "update", override_access_arg)?).await?;

  let d = call("updateByIDArgs", &[args.get()])?;
  let id = at(d, 0)?;
  let autosave = at(d, 1)?;
  let collection_config = at(d, 2)?;
  let collection = at(d, 3)?;
  let depth = at(d, 4)?;
  let draft_arg = at(d, 5)?;
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
  let trash = at(d, 18)?;
  let unpublish_all_locales_arg = at(d, 19)?;

  if !js::truthy(id.get()) {
    return Err(host::throw_from("missingUpdateID", &[]));
  }

  let mut data = get_val(args.get(), "data")?;

  let pb = call(
    "updatePublication",
    &[
      publish_all_locales_arg.get(),
      unpublish_all_locales_arg.get(),
      draft_arg.get(),
      collection_config.get(),
      config.get(),
      locale.get(),
      data.get(),
      initial_intent.get(),
    ],
  )?;
  let publish_all_locales = at(pb, 0)?;
  let unpublish_all_locales = at(pb, 1)?;

  // Access
  let access_results = if !js::truthy(override_access.get()) {
    let slug = get_val(collection_config.get(), "slug")?;
    let access = get_val(get(collection_config.get(), "access")?, "update")?;
    let mut a = AccessArgs::new(slug, Val::Undefined, req.clone());
    a.id = id.clone();
    a.data = data.clone();
    await_js(execute_access(a, access)?).await?
  } else {
    Val::Bool(true)
  };
  let has_where_policy = js::truthy(call("hasWhereAccessResult", &[access_results.get()])?);

  // Retrieve document
  let where_ = call_val("idWhere", &[id.get()])?;
  let mut full_where = call_val("combineQueries", &[where_.get(), access_results.get()])?;

  let is_trash_attempt = js::truthy(call("isTrashAttempt", &[collection_config.get(), data.get()])?);

  if is_trash_attempt && !js::truthy(override_access.get()) {
    let slug = get_val(collection_config.get(), "slug")?;
    let access = get_val(get(collection_config.get(), "access")?, "delete")?;
    let mut a = AccessArgs::new(slug, Val::Undefined, req.clone());
    a.id = id.clone();
    a.data = data.clone();
    let delete_access_result = await_js(execute_access(a, access)?).await?;
    full_where = call_val("combineQueries", &[full_where.get(), delete_access_result.get()])?;
  }

  full_where = call_val(
    "appendNonTrashedFilter",
    &[get(collection_config.get(), "trash")?, trash.get(), full_where.get()],
  )?;

  let find_one_args = call_val("findOneArgsOf", &[collection_config.get(), locale.get(), req.get(), full_where.get()])?;

  let mut doc_with_locales = await_helper(
    "getLatestCollectionVersion",
    &[id.get(), collection_config.get(), payload.get(), find_one_args.get(), req.get()],
  )
  .await?;

  if !js::truthy(doc_with_locales.get()) && !has_where_policy {
    return Err(host::throw_from("notFound", &[get(req.get(), "t")?]));
  }
  if !js::truthy(doc_with_locales.get()) && has_where_policy {
    return Err(host::throw_from("forbidden", &[get(req.get(), "t")?]));
  }
  if !js::truthy(doc_with_locales.get()) {
    return Err(host::throw_from("notFound", &[get(req.get(), "t")?]));
  }

  let stored_doc_with_locales = doc_with_locales.clone();
  if truthy_path(collection_config.get(), "upload", "fileOperations")? {
    doc_with_locales = await_helper(
      "withLegacyCloudUploadFileData",
      &[collection_config.get(), doc_with_locales.get(), req.get()],
    )
    .await?;
  }

  if js::truthy(get(collection_config.get(), "upload")?) && !js::truthy(override_access.get()) {
    data = call_val(
      "mergeUploadDataWithDocument",
      &[data.get(), doc_with_locales.get(), locale.get(), config.get(), collection_config.get()],
    )?;
  }

  // Generate data for all files and sizes
  let r = await_helper(
    "updateGenerateFileData",
    &[
      collection.get(),
      config.get(),
      data.get(),
      doc_with_locales.get(),
      overwrite_existing_files.get(),
      req.get(),
    ],
  )
  .await?;
  let df = call("dataAndFiles", &[r.get()])?;
  let new_file_data = at(df, 0)?;
  let files_to_upload = at(df, 1)?;

  let select = call_val("writeSelect", &[collection_config.get(), js::string("update"), req.get(), incoming_select.get()])?;

  // Update document, runs all document level hooks
  let update_args = call_val(
    "updateByIDUpdateArgs",
    &[
      id.get(),
      autosave.get(),
      collection_config.get(),
      config.get(),
      new_file_data.get(),
      depth.get(),
      doc_with_locales.get(),
      draft_arg.get(),
      fallback_locale.get(),
      files_to_upload.get(),
      locale.get(),
      override_access.get(),
      override_lock.get(),
      payload.get(),
      populate.get(),
      publish_all_locales.get(),
      req.get(),
      select.get(),
      show_hidden_fields.get(),
      unpublish_all_locales.get(),
    ],
  )?;

  let mut result = if truthy_path(collection_config.get(), "upload", "fileOperations")? {
    let ua = update_args.clone();
    let write = host::closure("write", move |_| update_document(ua.get()))?;
    await_helper(
      "runCloudFileUpdate",
      &[
        id.get(),
        collection_config.get(),
        stored_doc_with_locales.get(),
        update_args.get(),
        files_to_upload.get(),
        req.get(),
        write,
      ],
    )
    .await?
  } else {
    await_js(update_document(update_args.get())?).await?
  };

  // Add collection property for auth collections
  if js::truthy(get(collection_config.get(), "auth")?) {
    result = call_val("withCollection", &[result.get(), collection_config.get()])?;
  }

  await_helper("unlinkTempFilesCaught", &[collection_config.get(), config.get(), req.get()]).await?;

  // afterOperation - Collection
  let p = build_after_operation(args.clone(), collection_config.clone(), "updateByID", override_access.clone(), result)?;
  result = await_js(p).await?;

  commit_and_complete(&req, should_commit, has_file_operation_scope).await?;

  Ok(result)
}
