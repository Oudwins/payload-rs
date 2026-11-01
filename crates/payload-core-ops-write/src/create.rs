//! Port of `packages/payload/src/collections/operations/create.ts` (`createOperation`).

use payload_core_ops::common::{AccessArgs, build_after_operation, build_before_operation, execute_access, has_hooks, has_hooks_strict};
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::common::{
  await_helper, catch_with_unlink, commit_and_complete, empty_object, init_transaction_unless_disabled,
  reduce_hooks, traverse, truthy_path,
};
use crate::host::{self, Cell, at, call, call_fn, call_val, get, get_val, is_nullish, val};

/// `createOperation(incomingArgs)`: returns its promise.
pub fn create(incoming_args: Local) -> JsResult<Local> {
  host::count_call();
  let incoming_args = val(incoming_args)?;
  spawn(run(incoming_args))
}

async fn run(incoming_args: Val) -> JsResult<Val> {
  let mut args = incoming_args;
  // let restoreCloudHookState: (() => void) | undefined
  let restore_cloud_hook_state = Cell::new(Val::Undefined);
  let has_file_operation_scope = truthy_path(get(args.get(), "collection")?, "config", "upload")?;

  if has_file_operation_scope {
    call("beginFileOperationScope", &[get(args.get(), "req")?])?;
  }

  call("assertNoValidationWrite", &[get(args.get(), "req")?])?;

  let outcome = match body(&mut args, &restore_cloud_hook_state, has_file_operation_scope).await {
    Ok(v) => Ok(v),
    Err(error) => catch_with_unlink(&args, has_file_operation_scope, error).await,
  };

  // finally { restoreCloudHookState?.() }
  let restore = restore_cloud_hook_state.local();
  if !is_nullish(restore) {
    call_fn(restore, js::undefined(), &[], "restoreCloudHookState")?;
  }
  outcome
}

async fn body(args: &mut Val, restore_cloud_hook_state: &Cell, has_file_operation_scope: bool) -> JsResult<Val> {
  let should_commit = init_transaction_unless_disabled(args).await?;

  let mut external_upload_source = Val::Undefined;
  if truthy_path(get(args.get(), "collection")?, "config", "upload")?
    && !js::truthy(get(args.get(), "overrideAccess")?)
  {
    let r = call("createSanitizeUpload", &[args.get()])?;
    external_upload_source = at(r, 0)?;
    *args = at(r, 1)?;
  }

  let initial_intent = call_val("createInitialPublicationIntent", &[args.get()])?;
  call("ensureUsernameOrEmailCreate", &[args.get()])?;

  // beforeOperation - Collection
  let collection = get_val(get(args.get(), "collection")?, "config")?;
  let override_access_arg = get_val(args.get(), "overrideAccess")?;
  *args = await_js(build_before_operation(args.clone(), collection, "create", override_access_arg)?).await?;

  let d = call("createArgs", &[args.get()])?;
  let autosave = at(d, 0)?;
  let collection_config = at(d, 1)?;
  let collection = at(d, 2)?;
  let depth = at(d, 3)?;
  let disable_verification_email = at(d, 4)?;
  let draft = at(d, 5)?;
  let duplicate_from_id = at(d, 6)?;
  let override_access = at(d, 7)?;
  let overwrite_existing_files = at(d, 8)?;
  let populate = at(d, 9)?;
  let publish_all_locales_arg = at(d, 10)?;
  let fallback_locale = at(d, 11)?;
  let locale = at(d, 12)?;
  let payload = at(d, 13)?;
  let config = at(d, 14)?;
  let req = at(d, 15)?;
  let incoming_select = at(d, 16)?;
  let selected_locales = at(d, 17)?;
  let show_hidden_fields = at(d, 18)?;
  let mut data = at(d, 19)?;

  let p = call(
    "createPublication",
    &[draft.get(), collection_config.get(), publish_all_locales_arg.get(), config.get(), data.get(), initial_intent.get()],
  )?;
  let publish_all_locales = at(p, 0)?;
  let all_locales_publication_status = at(p, 1)?;
  let is_saving_draft = js::truthy(js::get_element(p, 2)?);

  if is_saving_draft {
    host::set(data.get(), "_status", js::string("draft"))?;
  }

  let is_duplicating = !is_nullish(duplicate_from_id.get());

  if is_duplicating && js::strict_equals(get(collection_config.get(), "disableDuplicate")?, js::boolean(true)) {
    return Err(host::throw_from("cannotDuplicate", &[collection_config.get()]));
  }

  let mut duplicated_from_doc_with_locales = empty_object()?;
  let mut duplicated_from_doc = empty_object()?;

  if is_duplicating {
    let r = await_helper(
      "getDuplicateDocumentData",
      &[
        duplicate_from_id.get(),
        collection_config.get(),
        js::boolean(is_saving_draft),
        override_access.get(),
        req.get(),
        selected_locales.get(),
      ],
    )
    .await?;
    duplicated_from_doc = get_val(r.get(), "duplicatedFromDoc")?;
    duplicated_from_doc_with_locales = get_val(r.get(), "duplicatedFromDocWithLocales")?;
  }

  // Access
  if !js::truthy(override_access.get()) {
    let slug = get_val(collection_config.get(), "slug")?;
    let access = get_val(get(collection_config.get(), "access")?, "create")?;
    let mut a = AccessArgs::new(slug, Val::Undefined, req.clone());
    a.data = data.clone();
    await_js(execute_access(a, access)?).await?;
  }

  // Generate data for all files and sizes
  let r = await_helper(
    "createGenerateFileData",
    &[
      collection.get(),
      config.get(),
      data.get(),
      js::boolean(is_saving_draft),
      external_upload_source.get(),
      js::boolean(is_duplicating),
      duplicated_from_doc.get(),
      overwrite_existing_files.get(),
      req.get(),
    ],
  )
  .await?;
  let df = call("dataAndFiles", &[r.get()])?;
  data = at(df, 0)?;
  let files_to_upload = at(df, 1)?;

  // beforeValidate - Fields
  let status_cell = call_val("statusCell", &[])?;
  let field_policy_doc = call_val(
    "publicationFieldPolicyDoc",
    &[duplicated_from_doc.get(), duplicated_from_doc_with_locales.get(), data.get(), all_locales_publication_status.get()],
  )?;

  let bv_args = call(
    "createBeforeValidateArgs",
    &[
      collection_config.get(),
      req.get(),
      data.get(),
      duplicated_from_doc.get(),
      field_policy_doc.get(),
      status_cell.get(),
      override_access.get(),
    ],
  )?;
  data = traverse("beforeValidate", bv_args).await?;

  let publication_hook_doc = call_val(
    "publicationHookDoc",
    &[
      duplicated_from_doc.get(),
      duplicated_from_doc_with_locales.get(),
      data.get(),
      all_locales_publication_status.get(),
      status_cell.get(),
    ],
  )?;

  // beforeValidate - Collections
  if has_hooks_strict(collection_config.get(), "beforeValidate")? {
    data = reduce_hooks(&collection_config, "beforeValidate", data, |d| {
      call(
        "dataHookArgs",
        &[collection_config.get(), req.get(), d, js::string("create"), publication_hook_doc.get()],
      )
    })
    .await?;
  }

  // beforeChange - Collection
  if has_hooks(collection_config.get(), "beforeChange")? {
    data = reduce_hooks(&collection_config, "beforeChange", data, |d| {
      call(
        "dataHookArgs",
        &[collection_config.get(), req.get(), d, js::string("create"), publication_hook_doc.get()],
      )
    })
    .await?;
  }

  let publication_data = call_val("spread", &[data.get()])?;

  // beforeChange - Fields
  let bc_args = call(
    "createBeforeChangeArgs",
    &[
      collection_config.get(),
      req.get(),
      data.get(),
      publication_hook_doc.get(),
      duplicated_from_doc_with_locales.get(),
      status_cell.get(),
      override_access.get(),
      js::boolean(is_saving_draft),
    ],
  )?;
  let data_with_locales = traverse("beforeChange", bc_args).await?;

  let has_authorized_publication_status = js::truthy(call(
    "createStatusAfterBeforeChange",
    &[
      publication_data.get(),
      status_cell.get(),
      all_locales_publication_status.get(),
      data_with_locales.get(),
      duplicated_from_doc_with_locales.get(),
      config.get(),
      collection_config.get(),
    ],
  )?);

  if js::truthy(call("localizedStatusEnabled", &[config.get(), collection_config.get()])?)
    && has_authorized_publication_status
  {
    let mut accessible_locale_codes = get_val(get(config.get(), "localization")?, "localeCodes")?;

    if truthy_path(config.get(), "localization", "filterAvailableLocales")? {
      let p = call("callFilterAvailableLocales", &[config.get(), req.get()])?;
      let filtered_locales = await_js(p).await?;
      accessible_locale_codes = call_val("localeCodesOf", &[filtered_locales.get()])?;
    }

    call("setStatusLocales", &[data_with_locales.get(), accessible_locale_codes.get(), js::string("published")])?;
  }

  // Fill every locale of a localized slug
  if js::truthy(get(config.get(), "localization")?) {
    await_helper(
      "fillEmptyLocalizedSlugs",
      &[collection_config.get(), data_with_locales.get(), override_access.get(), req.get()],
    )
    .await?;
  }

  if js::truthy(call(
    "shouldValidateAllLocales",
    &[
      config.get(),
      collection_config.get(),
      publish_all_locales.get(),
      js::boolean(has_authorized_publication_status),
      js::boolean(false),
    ],
  )?) {
    let validation_result = await_helper(
      "createValidateAllLocales",
      &[collection_config.get(), data_with_locales.get(), override_access.get(), req.get(), payload.get()],
    )
    .await?;

    if !js::truthy(get(validation_result.get(), "valid")?) {
      return Err(host::throw_from(
        "createValidationError",
        &[collection_config.get(), validation_result.get(), req.get()],
      ));
    }
  }

  // Create
  let select = call_val("writeSelect", &[collection_config.get(), js::string("create"), req.get(), incoming_select.get()])?;

  let write = WriteDocument {
    collection_config: collection_config.clone(),
    data_with_locales: data_with_locales.clone(),
    data: data.clone(),
    req: req.clone(),
    payload: payload.clone(),
  };

  let has_managed_local_upload = js::truthy(call(
    "createHasManagedLocalUpload",
    &[collection_config.get(), files_to_upload.get(), data_with_locales.get()],
  )?);

  let doc = if js::truthy(call("usesCloudFileCreation", &[collection_config.get(), files_to_upload.get(), req.get()])?) {
    restore_cloud_hook_state.set(call_val("captureCloudHookState", &[req.get()])?);
    let write_fn = write.to_js()?;
    await_helper(
      "runCloudFileCreation",
      &[collection_config.get(), data_with_locales.get(), files_to_upload.get(), req.get(), write_fn],
    )
    .await?
  } else if has_managed_local_upload {
    let write_fn = write.to_js()?;
    await_helper("runFileCreationPlan", &[collection_config.get(), files_to_upload.get(), req.get(), write_fn]).await?
  } else {
    if !truthy_path(collection_config.get(), "upload", "disableLocalStorage")? {
      await_helper("uploadFiles", &[payload.get(), files_to_upload.get(), req.get()]).await?;
    }
    await_js(write.call()?).await?
  };

  let verification_token = get_val(doc.get(), "_verificationToken")?;
  let mut result_with_locales = call_val("sanitizeInternalFields", &[doc.get()])?;

  // Add collection property for auth collections
  if js::truthy(get(collection_config.get(), "auth")?) {
    result_with_locales = call_val("withCollection", &[result_with_locales.get(), collection_config.get()])?;
  }

  // Create version
  if js::truthy(get(collection_config.get(), "versions")?) {
    await_helper(
      "createSaveVersion",
      &[result_with_locales.get(), autosave.get(), collection_config.get(), payload.get(), req.get()],
    )
    .await?;
  }

  // Send verification email if applicable
  // collectionConfig.auth && collectionConfig.auth.verify && resultWithLocales.email
  if js::truthy(get(collection_config.get(), "auth")?)
    && truthy_path(collection_config.get(), "auth", "verify")?
    && js::truthy(get(result_with_locales.get(), "email")?)
  {
    await_helper(
      "sendVerificationEmail",
      &[
        collection_config.get(),
        payload.get(),
        disable_verification_email.get(),
        req.get(),
        verification_token.get(),
        result_with_locales.get(),
      ],
    )
    .await?;
  }

  // afterRead - Fields
  let ar_args = call(
    "createAfterReadArgs",
    &[
      collection_config.get(),
      req.get(),
      depth.get(),
      result_with_locales.get(),
      draft.get(),
      fallback_locale.get(),
      locale.get(),
      override_access.get(),
      populate.get(),
      select.get(),
      show_hidden_fields.get(),
    ],
  )?;
  let mut result = traverse("afterRead", ar_args).await?;

  // afterRead - Collection
  if has_hooks(collection_config.get(), "afterRead")? {
    result = reduce_hooks(&collection_config, "afterRead", result, |doc| {
      call("afterReadHookArgs", &[collection_config.get(), req.get(), doc, override_access.get()])
    })
    .await?;
  }

  // afterChange - Fields
  let ac_args = call(
    "afterChangeArgs",
    &[collection_config.get(), req.get(), data.get(), result.get(), js::string("create"), js::object()],
  )?;
  result = traverse("afterChange", ac_args).await?;

  // afterChange - Collection
  if has_hooks(collection_config.get(), "afterChange")? {
    let args_now = args.clone();
    result = reduce_hooks(&collection_config, "afterChange", result, |doc| {
      call(
        "createAfterChangeHookArgs",
        &[collection_config.get(), req.get(), data.get(), doc, override_access.get(), args_now.get(), select.get()],
      )
    })
    .await?;
  }

  // afterOperation - Collection
  let override_access_arg = get_val(args.get(), "overrideAccess")?;
  let p = build_after_operation(args.clone(), collection_config.clone(), "create", override_access_arg, result)?;
  result = await_js(p).await?;

  await_helper("unlinkTempFilesCaught", &[collection_config.get(), config.get(), req.get()]).await?;

  // Return results
  commit_and_complete(&req, should_commit, has_file_operation_scope).await?;

  Ok(result)
}

/// The `writeDocument` arrow of create.ts.
#[derive(Clone)]
struct WriteDocument {
  collection_config: Val,
  data_with_locales: Val,
  data: Val,
  req: Val,
  payload: Val,
}

impl WriteDocument {
  /// `writeDocument()`: returns its promise.
  fn call(&self) -> JsResult<Local> {
    let w = self.clone();
    spawn(async move { w.run() })
  }

  /// The arrow as a JS function, for the upstream utilities that call it back.
  fn to_js(&self) -> JsResult<Local> {
    let w = self.clone();
    host::closure("writeDocument", move |_| w.call())
  }

  fn run(&self) -> JsResult<Val> {
    let cc = self.collection_config.get();
    let auth = get(cc, "auth")?;
    if js::truthy(auth) && !js::truthy(get(get(cc, "auth")?, "disableLocalStrategy")?) {
      if truthy_path(cc, "auth", "verify")? {
        call("setVerificationFields", &[self.data_with_locales.get()])?;
      }
      // return registerLocalStrategy({ ... }) (the promise, not awaited)
      return call_val(
        "registerLocalStrategy",
        &[cc, self.data_with_locales.get(), self.data.get(), self.req.get()],
      );
    }

    // return payload.db.create({ ... })
    let db = get(self.payload.get(), "db")?;
    let f = get(db, "create")?;
    let args = call("dbCreateArgs", &[cc, self.data_with_locales.get(), self.req.get()])?;
    val(call_fn(f, db, &[args], "payload.db.create")?)
  }
}
