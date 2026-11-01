//! Port of `packages/payload/src/collections/operations/restoreVersion.ts`
//! (`restoreVersionOperation`).

use payload_core_ops::common::{AccessArgs, build_after_operation, build_before_operation, execute_access, has_hooks};
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Thrown, Val};

use crate::common::{
  await_helper, commit_and_complete, init_transaction_unless_disabled, reduce_hooks, traverse,
};
use crate::host::{self, Cell, at, call, call_fn, call_val, get, get_val, val};

/// `restoreVersionOperation(args)`: returns its promise.
pub fn restore_version(args: Local) -> JsResult<Local> {
  host::count_call();
  let args = val(args)?;
  spawn(run(args))
}

/// The destructured args (taken before `beforeOperation`, as upstream does).
struct Params {
  id: Val,
  collection_config: Val,
  depth: Val,
  draft_arg: Val,
  override_access: Val,
  populate: Val,
  req: Val,
  fallback_locale: Val,
  locale: Val,
  payload: Val,
  incoming_select: Val,
  show_hidden_fields: Val,
}

async fn run(args: Val) -> JsResult<Val> {
  let mut args = args;
  call("assertNoValidationWrite", &[get(args.get(), "req")?])?;

  let d = call("restoreVersionArgs", &[args.get()])?;
  let p = Params {
    id: at(d, 0)?,
    collection_config: at(d, 1)?,
    depth: at(d, 2)?,
    draft_arg: at(d, 3)?,
    override_access: at(d, 4)?,
    populate: at(d, 5)?,
    req: at(d, 6)?,
    fallback_locale: at(d, 7)?,
    locale: at(d, 8)?,
    payload: at(d, 9)?,
    incoming_select: at(d, 10)?,
    show_hidden_fields: at(d, 11)?,
  };
  let has_file_operation_scope = js::truthy(get(p.collection_config.get(), "upload")?);

  if has_file_operation_scope {
    call("beginFileOperationScope", &[p.req.get()])?;
  }

  match body(&mut args, &p, has_file_operation_scope).await {
    Ok(v) => Ok(v),
    Err(Thrown(error)) => {
      await_helper("killTransaction", &[p.req.get()]).await?;
      if has_file_operation_scope {
        await_helper("abortFileOperationScope", &[p.req.get()]).await?;
      }
      Err(Thrown(error))
    }
  }
}

async fn body(args: &mut Val, p: &Params, has_file_operation_scope: bool) -> JsResult<Val> {
  let should_commit = init_transaction_unless_disabled(args).await?;
  let cc = p.collection_config.clone();
  let req = p.req.clone();

  // beforeOperation - Collection
  let collection = get_val(get(args.get(), "collection")?, "config")?;
  *args = await_js(build_before_operation(args.clone(), collection, "restoreVersion", p.override_access.clone())?).await?;

  if !js::truthy(p.id.get()) {
    return Err(host::throw_from("missingRestoreVersionID", &[]));
  }

  // Retrieve original raw version
  let pr = {
    let db = get(get(req.get(), "payload")?, "db")?;
    let f = get(db, "findVersions")?;
    let a = call("restoreFindVersionsArgs", &[cc.get(), req.get(), p.id.get()])?;
    call_fn(f, db, &[a], "req.payload.db.findVersions")?
  };
  let found = await_js(pr).await?;
  let version_docs = get(found.get(), "docs")?;
  let raw_version_to_restore = call_val("firstOf", &[version_docs])?;

  if !js::truthy(raw_version_to_restore.get()) {
    return Err(host::throw_from("notFound", &[get(req.get(), "t")?]));
  }

  let parent_doc_id = get_val(raw_version_to_restore.get(), "parent")?;
  let version_to_restore_with_locales = get_val(raw_version_to_restore.get(), "version")?;

  // Access
  let restored_statuses = call_val("restoredStatuses", &[p.draft_arg.get(), version_to_restore_with_locales.get()])?;

  let access_results_list = val(js::array())?;

  if js::truthy(p.override_access.get()) {
    js::push(access_results_list.get(), js::boolean(true))?;
  } else {
    let statuses = host::iterable(call("statusesToAuthorize", &[restored_statuses.get()])?)?;
    let mut i = 0;
    while i < js::array_length(statuses.get()) {
      let status = host::element(statuses.get(), i)?;
      let slug = get_val(cc.get(), "slug")?;
      let mut a = AccessArgs::new(slug, Val::Undefined, req.clone());
      a.id = parent_doc_id.clone();
      a.data = call_val("statusData", &[status])?;
      let access = get_val(get(cc.get(), "access")?, "update")?;
      let r = await_js(execute_access(a, access)?).await?;
      js::push(access_results_list.get(), r.get())?;
      i += 1;
    }
  }

  let has_where_policy = js::truthy(call("someWhereAccessResult", &[access_results_list.get()])?);

  // Retrieve document
  let find_one_args =
    call_val("restoreFindOneArgs", &[cc.get(), req.get(), access_results_list.get(), parent_doc_id.get()])?;

  let pr = {
    let db = get(get(req.get(), "payload")?, "db")?;
    let f = get(db, "findOne")?;
    call_fn(f, db, &[find_one_args.get()], "req.payload.db.findOne")?
  };
  let doc = await_js(pr).await?;

  if !js::truthy(doc.get()) && !has_where_policy {
    return Err(host::throw_from("notFound", &[get(req.get(), "t")?]));
  }
  if !js::truthy(doc.get()) && has_where_policy {
    return Err(host::throw_from("forbidden", &[get(req.get(), "t")?]));
  }

  if js::truthy(get(cc.get(), "trash")?) && js::truthy(host::opt(doc.get(), "deletedAt")?) {
    return Err(host::throw_from("restoreTrashed", &[parent_doc_id.get()]));
  }

  if js::truthy(get(cc.get(), "upload")?) && !js::truthy(p.override_access.get()) {
    await_helper("restoreCheckVersionAccess", &[p.id.get(), cc.get(), req.get()]).await?;
  }

  // fetch previousDoc
  let prev_doc_with_locales = await_helper(
    "getLatestCollectionVersion",
    &[parent_doc_id.get(), cc.get(), p.payload.get(), find_one_args.get(), req.get()],
  )
  .await?;

  let validation_locale = call_val("validationLocaleOf", &[p.payload.get(), p.locale.get()])?;

  let ar = call(
    "restoreOriginalAfterReadArgs",
    &[cc.get(), req.get(), prev_doc_with_locales.get(), p.draft_arg.get(), validation_locale.get()],
  )?;
  let original_doc = traverse("afterRead", ar).await?;

  let ar = call(
    "restoreOriginalAfterReadArgs",
    &[cc.get(), req.get(), get(raw_version_to_restore.get(), "version")?, p.draft_arg.get(), validation_locale.get()],
  )?;
  let prev_version_doc = traverse("afterRead", ar).await?;

  // beforeValidate - Fields
  let req_with_validation_locale = call_val("restoreValidationRequest", &[req.get(), validation_locale.get()])?;

  let bv = call(
    "restoreBeforeValidateArgs",
    &[
      parent_doc_id.get(),
      cc.get(),
      req.get(),
      prev_version_doc.get(),
      original_doc.get(),
      p.override_access.get(),
      req_with_validation_locale.get(),
    ],
  )?;
  let mut data = traverse("beforeValidate", bv).await?;

  // beforeValidate - Collection
  if has_hooks(cc.get(), "beforeValidate")? {
    data = reduce_hooks(&cc, "beforeValidate", data, |d| {
      call("restoreDataHookArgs", &[cc.get(), req.get(), d, original_doc.get(), req_with_validation_locale.get()])
    })
    .await?;
  }

  // beforeChange - Collection
  if has_hooks(cc.get(), "beforeChange")? {
    data = reduce_hooks(&cc, "beforeChange", data, |d| {
      call("restoreDataHookArgs", &[cc.get(), req.get(), d, original_doc.get(), req_with_validation_locale.get()])
    })
    .await?;
  }

  // beforeChange - Fields
  let bc = call(
    "restoreBeforeChangeArgs",
    &[
      parent_doc_id.get(),
      cc.get(),
      req.get(),
      data.get(),
      original_doc.get(),
      version_to_restore_with_locales.get(),
      p.override_access.get(),
      req_with_validation_locale.get(),
      p.draft_arg.get(),
    ],
  )?;
  let result = Cell::new(traverse("beforeChange", bc).await?);

  // Update
  let select = call_val("writeSelect", &[cc.get(), js::string("restoreVersion"), req.get(), p.incoming_select.get()])?;

  call("restoreStampResult", &[result.local(), p.draft_arg.get()])?;

  let write = WriteRestoredVersion {
    cc: cc.clone(),
    result: result.clone(),
    draft_arg: p.draft_arg.clone(),
    parent_doc_id: parent_doc_id.clone(),
    req: req.clone(),
    req_with_validation_locale: req_with_validation_locale.clone(),
    select: select.clone(),
    payload: p.payload.clone(),
  };

  let restored = if js::truthy(get(cc.get(), "upload")?) {
    let w = write.clone();
    let write_fn = host::closure("writeRestoredVersion", move |a| {
      let restored = val(a[0])?;
      let w = w.clone();
      spawn(async move { w.run(restored).await })
    })?;
    await_helper(
      "runStoredFileRestore",
      &[
        parent_doc_id.get(),
        cc.get(),
        prev_doc_with_locales.get(),
        req.get(),
        version_to_restore_with_locales.get(),
        write_fn,
      ],
    )
    .await?
  } else {
    let w = write.clone();
    let restored_arg = version_to_restore_with_locales.clone();
    await_js(spawn(async move { w.run(restored_arg).await })?).await?
  };
  result.set(restored);

  // afterRead - Fields
  let ar = call(
    "afterReadArgsWithoutDraft",
    &[
      cc.get(),
      req.get(),
      p.depth.get(),
      result.local(),
      p.fallback_locale.get(),
      p.locale.get(),
      p.override_access.get(),
      p.populate.get(),
      select.get(),
      p.show_hidden_fields.get(),
    ],
  )?;
  result.set(traverse("afterRead", ar).await?);

  // afterRead - Collection
  if has_hooks(cc.get(), "afterRead")? {
    let r = reduce_hooks(&cc, "afterRead", result.get(), |doc| {
      call("afterReadHookArgs", &[cc.get(), req.get(), doc, p.override_access.get()])
    })
    .await?;
    result.set(r);
  }

  // afterChange - Fields
  let ac = call(
    "afterChangeArgs",
    &[cc.get(), req.get(), result.local(), result.local(), js::string("update"), prev_doc_with_locales.get()],
  )?;
  result.set(traverse("afterChange", ac).await?);

  // afterChange - Collection
  if has_hooks(cc.get(), "afterChange")? {
    let r = reduce_hooks(&cc, "afterChange", result.get(), |doc| {
      call(
        "restoreAfterChangeHookArgs",
        &[cc.get(), req.get(), doc, p.override_access.get(), prev_doc_with_locales.get()],
      )
    })
    .await?;
    result.set(r);
  }

  // afterOperation - Collection
  let pr = build_after_operation(args.clone(), cc.clone(), "restoreVersion", p.override_access.clone(), result.get())?;
  let out = await_js(pr).await?;

  commit_and_complete(&req, should_commit, has_file_operation_scope).await?;

  Ok(out)
}

/// The `writeRestoredVersion` async arrow (reassigns the shared `result`).
#[derive(Clone)]
struct WriteRestoredVersion {
  cc: Val,
  result: Cell,
  draft_arg: Val,
  parent_doc_id: Val,
  req: Val,
  req_with_validation_locale: Val,
  select: Val,
  payload: Val,
}

impl WriteRestoredVersion {
  async fn run(&self, restored: Val) -> JsResult<Val> {
    if js::truthy(get(self.cc.get(), "upload")?) {
      self.result.set(call_val("restoreUploadDataFromDocument", &[self.result.local(), restored.get()])?);
    }
    if !js::truthy(self.draft_arg.get()) {
      let pr = {
        let db = get(get(self.req.get(), "payload")?, "db")?;
        let f = get(db, "updateOne")?;
        let a = call(
          "restoreUpdateOneArgs",
          &[
            self.parent_doc_id.get(),
            self.cc.get(),
            self.result.local(),
            self.req_with_validation_locale.get(),
            self.select.get(),
          ],
        )?;
        call_fn(f, db, &[a], "req.payload.db.updateOne")?
      };
      self.result.set(await_js(pr).await?);
    }

    await_helper(
      "restoreSaveVersion",
      &[
        self.parent_doc_id.get(),
        self.cc.get(),
        self.result.local(),
        self.draft_arg.get(),
        self.payload.get(),
        self.req_with_validation_locale.get(),
        self.select.get(),
      ],
    )
    .await
  }
}
