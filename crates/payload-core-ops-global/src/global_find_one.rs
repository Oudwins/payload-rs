//! Port of `packages/payload/src/globals/operations/findOne.ts` (`findOneOperation`).

use payload_core_ops::common::{AccessArgs, has_drafts_enabled};
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::common::{access, config_hooks, db, throw_t};
use crate::host::{call, call_fn, call_val, g, get, gv, is_false, is_nullish, path, truthy, unpack, val};

/// `findOneOperation(args)`: returns its promise.
pub fn find_one(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run(args))
}

async fn run(args: Val) -> JsResult<Val> {
  let mut args = args;
  let [
    slug,
    depth,
    disable_errors,
    replace_with_version,
    flatten_locales,
    global_config,
    include_lock_status_from_args,
    override_access,
    populate,
    fallback_locale,
    locale,
    req,
    incoming_select,
    show_hidden_fields,
  ] = unpack::<14>(call("findOneArgs", &[args.get()])?)?;

  let include_lock_status = call_val("includeLockStatus", &[include_lock_status_from_args.get(), req.get()])?;

  // beforeOperation - Global
  args = config_hooks(&global_config, "beforeOperation", "globalConfig", args, |args| {
    call("globalBeforeOperationArgs", &[args, global_config.get(), js::string("read"), override_access.get()])
  })
  .await?;

  // Retrieve and execute access
  let mut access_result = Val::Undefined;
  if !truthy(&override_access) {
    let slug = gv(&global_config, "slug")?;
    let read = path(&global_config, &["access", "read"])?;
    access_result = access(AccessArgs::new(slug, disable_errors.clone(), req.clone()), read).await?;
  }

  if is_false(access_result.get()) {
    if !truthy(&disable_errors) {
      return Err(throw_t("notFound", &req));
    }
    return Ok(Val::Null);
  }

  let select = call_val("selectRead", &[global_config.get(), req.get(), incoming_select.get(), js::string("read")])?;

  // Perform database operation
  let db_select = call_val("findOneDbSelect", &[global_config.get(), replace_with_version.get(), select.get()])?;
  let payload = gv(&req, "payload")?;
  let doc_from_db = db(&payload, "findGlobal", || {
    call(
      "findGlobalArgs",
      &[slug.get(), locale.get(), req.get(), db_select.get(), override_access.get(), access_result.get()],
    )
  })
  .await?;

  // Check if no document was returned (Postgres returns {} instead of null)
  let has_doc = js::truthy(call("hasKeys", &[doc_from_db.get()])?);

  if !has_doc
    && !js::truthy(g(&args, "data")?)
    && !truthy(&override_access)
    && !crate::host::is_true(access_result.get())
  {
    if !truthy(&disable_errors) {
      return Ok(val(js::object())?);
    }
    return Ok(Val::Null);
  }

  // (args.data as any) ?? (hasDoc ? docFromDB : null) ?? {}
  let mut doc = gv(&args, "data")?;
  if is_nullish(doc.get()) {
    doc = if has_doc { doc_from_db.clone() } else { Val::Null };
  }
  if is_nullish(doc.get()) {
    doc = val(js::object())?;
  }

  // Include Lock Status if required
  if truthy(&include_lock_status) && truthy(&slug) {
    let mut lock_status = Val::Null;
    let locked: JsResult<Val> = async {
      let lock_ms = call_val("lockDurationMs", &[global_config.get()])?;
      let payload = g(&req, "payload")?;
      let find = get(payload, "find")?;
      let find_args = call("globalLockArgs", &[slug.get(), req.get(), lock_ms.get()])?;
      let p = call_fn(find, payload, &[find_args], "req.payload.find")?;
      let locked_document = await_js(p).await?;
      call_val("lockStatusOf", &[locked_document.get(), lock_status.get()])
    }
    .await;
    if let Ok(status) = locked {
      lock_status = status;
    }
    call("applyLockStatus", &[doc.get(), lock_status.get()])?;
  }

  // Replace document with draft if available
  if truthy(&replace_with_version) && has_drafts_enabled(global_config.get())? {
    let p = call(
      "globalReplaceWithDraft",
      &[access_result.get(), doc.get(), global_config.get(), override_access.get(), req.get(), select.get()],
    )?;
    doc = await_js(p).await?;
  }

  // Execute before global hook
  doc = config_hooks(&global_config, "beforeRead", "globalConfig", doc, |doc| {
    call("globalReadHookArgs", &[req.get(), doc, global_config.get(), override_access.get()])
  })
  .await?;

  // Execute globalType field if not selected
  call("stripGlobalType", &[select.get(), doc.get()])?;

  // Execute field-level hooks and access
  let p = call(
    "findOneAfterRead",
    &[
      req.get(),
      depth.get(),
      doc.get(),
      replace_with_version.get(),
      fallback_locale.get(),
      flatten_locales.get(),
      global_config.get(),
      locale.get(),
      override_access.get(),
      populate.get(),
      select.get(),
      show_hidden_fields.get(),
    ],
  )?;
  doc = await_js(p).await?;

  // Execute after global hook
  doc = config_hooks(&global_config, "afterRead", "globalConfig", doc, |doc| {
    call("globalReadHookArgs", &[req.get(), doc, global_config.get(), override_access.get()])
  })
  .await?;

  Ok(doc)
}
