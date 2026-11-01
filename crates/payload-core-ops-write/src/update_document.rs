//! Port of `packages/payload/src/collections/operations/utilities/update.ts` (`updateDocument`),
//! shared by update.ts and updateByID.ts.

use payload_core_ops::common::has_hooks;
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::common::{await_helper, reduce_hooks, traverse, truthy_path};
use crate::host::{self, Cell, at, call, call_fn, call_val, get, val};

/// `updateDocument(args)`: returns its promise.
pub fn update_document(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run(args))
}

/// The destructured parameters of `updateDocument`.
#[derive(Clone)]
struct Params {
  id: Val,
  autosave: Val,
  collection_config: Val,
  config: Val,
  depth: Val,
  doc_with_locales: Val,
  draft_arg: Val,
  fallback_locale: Val,
  files_to_upload: Val,
  locale: Val,
  override_access: Val,
  override_lock: Val,
  payload: Val,
  populate: Val,
  req: Val,
  select: Val,
  should_manage_local_files: Val,
  show_hidden_fields: Val,
}

async fn run(args: Val) -> JsResult<Val> {
  // The parameter destructuring belongs to the async function: a throw rejects.
  let d = call("updateDocumentParams", &[args.get()])?;
  let p = Params {
    id: at(d, 0)?,
    autosave: at(d, 1)?,
    collection_config: at(d, 2)?,
    config: at(d, 3)?,
    depth: at(d, 5)?,
    doc_with_locales: at(d, 6)?,
    draft_arg: at(d, 7)?,
    fallback_locale: at(d, 8)?,
    files_to_upload: at(d, 9)?,
    locale: at(d, 10)?,
    override_access: at(d, 11)?,
    override_lock: at(d, 12)?,
    payload: at(d, 13)?,
    populate: at(d, 14)?,
    req: at(d, 16)?,
    select: at(d, 17)?,
    should_manage_local_files: at(d, 18)?,
    show_hidden_fields: at(d, 19)?,
  };
  let mut data = at(d, 4)?;
  let publish_all_locales_arg = at(d, 15)?;
  let unpublish_all_locales_arg = at(d, 20)?;

  let pro = call(
    "updateDocumentPrologue",
    &[
      p.collection_config.get(),
      p.should_manage_local_files.get(),
      data.get(),
      publish_all_locales_arg.get(),
      unpublish_all_locales_arg.get(),
      p.draft_arg.get(),
      p.locale.get(),
      p.config.get(),
    ],
  )?;
  let next_file_data = at(pro, 0)?;
  let publish_all_locales = at(pro, 1)?;
  let unpublish_all_locales = at(pro, 2)?;
  let all_locales_publication_status = at(pro, 3)?;
  let is_saving_draft = js::truthy(js::get_element(pro, 4)?);

  // Handle potentially locked documents
  await_helper(
    "checkDocumentLockStatusUpdate",
    &[p.id.get(), p.collection_config.get(), p.override_lock.get(), p.req.get()],
  )
  .await?;

  let ar_args = call(
    "originalDocAfterReadArgs",
    &[
      p.collection_config.get(),
      p.req.get(),
      p.doc_with_locales.get(),
      p.draft_arg.get(),
      p.id.get(),
      p.fallback_locale.get(),
      p.locale.get(),
    ],
  )?;
  let original_doc = traverse("afterRead", ar_args).await?;

  let mid = call(
    "updateDocumentMiddle",
    &[
      original_doc.get(),
      data.get(),
      p.collection_config.get(),
      unpublish_all_locales.get(),
      p.req.get(),
      js::boolean(is_saving_draft),
      p.doc_with_locales.get(),
      p.files_to_upload.get(),
    ],
  )?;
  let submitted_top_level_field_names = at(mid, 0)?;
  let is_draft_over_published = js::truthy(js::get_element(mid, 1)?);
  let has_managed_local_upload = js::truthy(js::get_element(mid, 2)?);

  // beforeValidate - Fields
  let status_cell = call_val("statusCell", &[])?;
  let field_policy_doc = call_val(
    "publicationFieldPolicyDoc",
    &[original_doc.get(), p.doc_with_locales.get(), data.get(), all_locales_publication_status.get()],
  )?;

  let bv_args = call(
    "updateBeforeValidateArgs",
    &[
      p.id.get(),
      p.collection_config.get(),
      p.req.get(),
      data.get(),
      original_doc.get(),
      field_policy_doc.get(),
      status_cell.get(),
      p.override_access.get(),
    ],
  )?;
  data = traverse("beforeValidate", bv_args).await?;

  let pw = call("updatePassword", &[data.get(), p.collection_config.get(), js::boolean(is_saving_draft)])?;
  let password = at(pw, 0)?;
  let should_save_password = js::truthy(js::get_element(pw, 1)?);

  let publication_hook_doc = call_val(
    "publicationHookDoc",
    &[
      original_doc.get(),
      p.doc_with_locales.get(),
      data.get(),
      all_locales_publication_status.get(),
      status_cell.get(),
    ],
  )?;

  let cc = p.collection_config.clone();
  // beforeValidate - Collection
  if has_hooks(cc.get(), "beforeValidate")? {
    data = reduce_hooks(&cc, "beforeValidate", data, |d| {
      call("dataHookArgs", &[cc.get(), p.req.get(), d, js::string("update"), publication_hook_doc.get()])
    })
    .await?;
  }

  // beforeChange - Collection
  if has_hooks(cc.get(), "beforeChange")? {
    data = reduce_hooks(&cc, "beforeChange", data, |d| {
      call("dataHookArgs", &[cc.get(), p.req.get(), d, js::string("update"), publication_hook_doc.get()])
    })
    .await?;
  }

  let publication_data = call_val("spread", &[data.get()])?;

  // beforeChange - Fields
  let bc_args = call(
    "updateBeforeChangeArgs",
    &[
      p.id.get(),
      cc.get(),
      p.req.get(),
      data.get(),
      publication_hook_doc.get(),
      p.doc_with_locales.get(),
      submitted_top_level_field_names.get(),
      p.override_access.get(),
      js::boolean(is_saving_draft),
      status_cell.get(),
    ],
  )?;
  let result = Cell::new(traverse("beforeChange", bc_args).await?);

  let has_authorized_publication_status = js::truthy(call(
    "updateStatusAfterBeforeChange",
    &[
      publication_data.get(),
      status_cell.get(),
      all_locales_publication_status.get(),
      result.local(),
      p.doc_with_locales.get(),
      p.config.get(),
      cc.get(),
    ],
  )?);

  let mut localized_publish_data = Val::Null;

  if js::truthy(get(p.config.get(), "localization")?) && js::truthy(get(cc.get(), "versions")?) {
    if js::truthy(call("hasLocalizeStatusEnabled", &[cc.get()])?) {
      if has_authorized_publication_status {
        let mut accessible_locale_codes = host::get_val(get(p.config.get(), "localization")?, "localeCodes")?;

        if truthy_path(p.config.get(), "localization", "filterAvailableLocales")? {
          let pr = call("callFilterAvailableLocales", &[p.config.get(), p.req.get()])?;
          let filtered_locales = await_js(pr).await?;
          accessible_locale_codes = call_val("localeCodesOf", &[filtered_locales.get()])?;
        }

        let status = if js::truthy(unpublish_all_locales.get()) { "draft" } else { "published" };
        call("setStatusLocales", &[result.local(), accessible_locale_codes.get(), js::string(status)])?;
      } else if js::truthy(call(
        "isSingleLocalePublish",
        &[js::boolean(is_saving_draft), result.local(), p.locale.get()],
      )?) {
        let db = get(p.payload.get(), "db")?;
        let f = get(db, "findOne")?;
        let a = call("currentDocFindOneArgs", &[cc.get(), p.req.get(), p.id.get()])?;
        let pr = call_fn(f, db, &[a], "payload.db.findOne")?;
        let current_doc = await_js(pr).await?;

        localized_publish_data = call_val(
          "buildLocalizedPublishData",
          &[p.config.get(), current_doc.get(), cc.get(), p.locale.get(), result.local()],
        )?;
      }
    }
  }

  if js::truthy(call(
    "shouldValidateAllLocales",
    &[
      p.config.get(),
      cc.get(),
      publish_all_locales.get(),
      js::boolean(has_authorized_publication_status),
      unpublish_all_locales.get(),
    ],
  )?) {
    let validation_result = await_helper(
      "updateValidateAllLocales",
      &[
        p.id.get(),
        cc.get(),
        result.local(),
        p.override_access.get(),
        p.req.get(),
        p.payload.get(),
        p.doc_with_locales.get(),
        publication_hook_doc.get(),
        p.locale.get(),
        original_doc.get(),
      ],
    )
    .await?;

    if !js::truthy(get(validation_result.get(), "valid")?) {
      return Err(host::throw_from(
        "updateValidationError",
        &[p.id.get(), cc.get(), validation_result.get(), p.req.get()],
      ));
    }
  }

  // File deletion and writes after the final publish validation.
  if !is_draft_over_published && !has_managed_local_upload {
    await_helper(
      "deleteAssociatedFilesUpdate",
      &[cc.get(), p.config.get(), p.doc_with_locales.get(), p.files_to_upload.get(), p.req.get()],
    )
    .await?;
  }

  if !truthy_path(cc.get(), "upload", "disableLocalStorage")? && !has_managed_local_upload {
    await_helper("uploadFiles", &[p.payload.get(), p.files_to_upload.get(), p.req.get()]).await?;
  }

  let write = WriteDocument {
    p: p.clone(),
    data,
    result,
    localized_publish_data,
    password,
    should_save_password,
    is_saving_draft,
    unpublish_all_locales,
    original_doc,
  };

  if !js::truthy(next_file_data.get()) {
    // return writeDocument()
    return val(write.call()?);
  }

  let write_fn = write.to_js()?;
  call_val(
    "runLocalFileUpdate",
    &[
      p.id.get(),
      cc.get(),
      p.doc_with_locales.get(),
      js::boolean(has_managed_local_upload),
      p.files_to_upload.get(),
      next_file_data.get(),
      p.req.get(),
      write_fn,
    ],
  )
}

/// The `writeDocument` arrow of `updateDocument` (reassigns the shared `result`).
#[derive(Clone)]
struct WriteDocument {
  p: Params,
  data: Val,
  result: Cell,
  localized_publish_data: Val,
  password: Val,
  should_save_password: bool,
  is_saving_draft: bool,
  unpublish_all_locales: Val,
  original_doc: Val,
}

impl WriteDocument {
  fn call(&self) -> JsResult<Local> {
    let w = self.clone();
    spawn(async move { w.run().await })
  }

  fn to_js(&self) -> JsResult<Local> {
    let w = self.clone();
    host::closure("writeDocument", move |_| w.call())
  }

  async fn run(&self) -> JsResult<Val> {
    let p = &self.p;
    let cc = p.collection_config.clone();
    // const dataToUpdate = { ...(localizedPublishData ?? result) }
    let source = if host::is_nullish(self.localized_publish_data.get()) {
      self.result.get()
    } else {
      self.localized_publish_data.clone()
    };
    let data_to_update = call_val("spread", &[source.get()])?;

    // Handle potential password update
    if self.should_save_password && js::type_of(self.password.get()) == js::Type::String {
      let hash = await_helper("generatePasswordSaltHash", &[cc.get(), self.password.get(), p.req.get()]).await?;
      call(
        "applyPasswordHash",
        &[data_to_update.get(), self.data.get(), hash.get(), cc.get(), p.req.get(), p.id.get(), p.doc_with_locales.get()],
      )?;
    }

    // Update
    let mut result_with_locales = self.result.get();

    if !self.is_saving_draft {
      call("setUpdatedAtNow", &[data_to_update.get()])?;
      if js::truthy(self.localized_publish_data.get()) {
        let req = p.req.get();
        let db = get(get(req, "payload")?, "db")?;
        let f = get(db, "updateOne")?;
        let a = call("dbUpdateOneArgs", &[p.id.get(), cc.get(), data_to_update.get(), p.locale.get(), p.req.get()])?;
        await_js(call_fn(f, db, &[a], "req.payload.db.updateOne")?).await?;
        result_with_locales = call_val("withUpdatedAt", &[self.result.local(), data_to_update.get()])?;
      } else {
        let req = p.req.get();
        let db = get(get(req, "payload")?, "db")?;
        let f = get(db, "updateOne")?;
        let a = call("dbUpdateOneArgs", &[p.id.get(), cc.get(), data_to_update.get(), p.locale.get(), p.req.get()])?;
        result_with_locales = await_js(call_fn(f, db, &[a], "req.payload.db.updateOne")?).await?;
      }
    }

    // Create version
    if js::truthy(get(cc.get(), "versions")?) {
      result_with_locales = await_helper(
        "updateSaveVersion",
        &[
          p.id.get(),
          p.autosave.get(),
          cc.get(),
          result_with_locales.get(),
          js::boolean(self.is_saving_draft),
          p.payload.get(),
          p.req.get(),
          self.unpublish_all_locales.get(),
        ],
      )
      .await?;
    }

    // afterRead - Fields
    let ar_args = call(
      "updateAfterReadArgs",
      &[
        cc.get(),
        p.req.get(),
        p.depth.get(),
        result_with_locales.get(),
        p.draft_arg.get(),
        p.fallback_locale.get(),
        p.locale.get(),
        p.override_access.get(),
        p.populate.get(),
        p.select.get(),
        p.show_hidden_fields.get(),
      ],
    )?;
    self.result.set(traverse("afterRead", ar_args).await?);

    // afterRead - Collection
    if has_hooks(cc.get(), "afterRead")? {
      let r = reduce_hooks(&cc, "afterRead", self.result.get(), |doc| {
        call("afterReadHookArgs", &[cc.get(), p.req.get(), doc, p.override_access.get()])
      })
      .await?;
      self.result.set(r);
    }

    // afterChange - Fields
    let ac_args = call(
      "afterChangeArgs",
      &[cc.get(), p.req.get(), self.data.get(), self.result.local(), js::string("update"), self.original_doc.get()],
    )?;
    self.result.set(traverse("afterChange", ac_args).await?);

    // afterChange - Collection
    if has_hooks(cc.get(), "afterChange")? {
      let r = reduce_hooks(&cc, "afterChange", self.result.get(), |doc| {
        call(
          "updateAfterChangeHookArgs",
          &[
            cc.get(),
            p.req.get(),
            self.data.get(),
            doc,
            p.override_access.get(),
            self.original_doc.get(),
            p.select.get(),
          ],
        )
      })
      .await?;
      self.result.set(r);
    }

    Ok(self.result.get())
  }
}
