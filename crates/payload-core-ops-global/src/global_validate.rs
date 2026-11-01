//! Port of `packages/payload/src/globals/operations/validate.ts` (`validateOperation`,
//! `validateOperationWithScopedRequest`, `resolveValidationGlobalSource`; each its own task like
//! the TS `async` functions).

use payload_core_ops::common::AccessArgs;
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::common::{access, db, throw_t};
use crate::host::{call, call_val, g, get, gv, is_nullish, path, set, truthy, unpack, val};

/// `validateOperation(args)`: returns its promise.
pub fn validate(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run(args))
}

async fn run(args: Val) -> JsResult<Val> {
  let previous_operation = path(&args, &["req", "operation"])?;
  let req = g(&args, "req")?;
  let mut operation = g(&args, "validationOperation")?;
  if is_nullish(operation) {
    operation = js::string("validate");
  }
  set(req, "operation", operation)?;

  let result: JsResult<Val> = async {
    let p = spawn(scoped(args.clone()))?;
    await_js(p).await
  }
  .await;
  // finally
  set(g(&args, "req")?, "operation", previous_operation.get())?;
  result
}

/// `validateOperationWithScopedRequest(args)`
async fn scoped(args: Val) -> JsResult<Val> {
  let [
    slug,
    incoming_data,
    draft,
    global_config,
    on_validation_data,
    override_access,
    req,
    skip_access_control,
    skip_mutation_hooks,
    source_data,
    validation_operation,
  ] = unpack::<11>(call("globalValidateArgs", &[args.get()])?)?;

  let access_result = if !truthy(&skip_access_control) && !truthy(&override_access) {
    let validate = path(&global_config, &["access", "validate"])?;
    let mut a = AccessArgs::new(slug.clone(), Val::Undefined, req.clone());
    a.data = incoming_data.clone();
    access(a, validate).await?
  } else {
    Val::Bool(true)
  };

  let stored_global = if truthy(&source_data) {
    gv(&source_data, "docWithLocales")?
  } else {
    let p = spawn(resolve_source(
      slug.clone(),
      access_result,
      draft.clone(),
      global_config.clone(),
      override_access.clone(),
      req.clone(),
    ))?;
    await_js(p).await?
  };

  let doc_with_locales = call_val("copyWithoutID", &[stored_global.get()])?;

  let original_doc = if truthy(&source_data) {
    call_val(
      "validationOriginalFromSource",
      &[req.get(), source_data.get(), doc_with_locales.get(), global_config.get()],
    )?
  } else {
    let p = call(
      "globalValidateAfterRead",
      &[req.get(), doc_with_locales.get(), draft.get(), global_config.get()],
    )?;
    await_js(p).await?
  };

  call_val(
    "globalRunValidationLifecycle",
    &[
      doc_with_locales.get(),
      global_config.get(),
      incoming_data.get(),
      on_validation_data.get(),
      original_doc.get(),
      override_access.get(),
      req.get(),
      skip_mutation_hooks.get(),
      validation_operation.get(),
    ],
  )
}

/// `resolveValidationGlobalSource({ slug, accessResult, draft, globalConfig, overrideAccess, req })`
async fn resolve_source(
  slug: Val,
  access_result: Val,
  draft: Val,
  global_config: Val,
  override_access: Val,
  req: Val,
) -> JsResult<Val> {
  let payload = gv(&req, "payload")?;
  let main = db(&payload, "findGlobal", || call("validationFindGlobalArgs", &[slug.get(), req.get(), js::undefined(), js::boolean(false)])).await?;
  let has_main = js::truthy(call("hasKeys", &[main.get()])?);
  let base = if has_main { main.clone() } else { call_val("globalTypeDoc", &[slug.get()])? };

  if truthy(&draft) && js::truthy(crate::host::opt(g(&global_config, "versions")?, "drafts")?) {
    let p = call("findNewestDraft", &[base.get(), global_config.get(), req.get()])?;
    let newest_draft = await_js(p).await?;

    if truthy(&newest_draft) {
      if js::truthy(call("hasWhereAccessResult", &[access_result.get()])?) {
        let p = call(
          "findAccessibleDraft",
          &[access_result.get(), base.get(), newest_draft.get(), global_config.get(), override_access.get(), req.get()],
        )?;
        let accessible_draft = await_js(p).await?;

        if !truthy(&accessible_draft) {
          return Err(throw_t("forbidden", &req));
        }
      }

      return call_val("globalDocumentFromDraft", &[base.get(), newest_draft.get()]);
    }
  }

  if !has_main {
    return val(js::object());
  }

  if !js::truthy(call("hasWhereAccessResult", &[access_result.get()])?) {
    return Ok(main);
  }

  let payload = get(req.get(), "payload")?;
  let payload = val(payload)?;
  let accessible_main = db(&payload, "findGlobal", || {
    call("validationFindGlobalArgs", &[slug.get(), req.get(), access_result.get(), js::boolean(true)])
  })
  .await?;

  if !js::truthy(call("hasKeys", &[accessible_main.get()])?) {
    return Err(throw_t("forbidden", &req));
  }

  Ok(accessible_main)
}
