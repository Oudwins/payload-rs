//! Port of `packages/payload/src/globals/operations/findVersionByID.ts`
//! (`findVersionByIDOperation`).
//!
//! Upstream quirk kept: the `beforeRead` loop assigns the hook result (or `result.version`) to
//! `result` itself.

use payload_core_ops::common::{AccessArgs, has_versions_enabled};
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Type, Val};

use crate::common::{access, db, has_hooks, hooks_of, throw_t};
use crate::host::{
  call, call_fn, call_val, g, get, gv, is_false, is_typeof_object, loop_body, opt, path, set, truthy, unpack, val,
};

/// `findVersionByIDOperation(args)`: returns its promise.
pub fn find_version_by_id(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run(args))
}

/// `(typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id))`
fn is_valid_id(id: Local) -> bool {
  match js::type_of(id) {
    Type::String => js::get_string_utf16(id).is_some_and(|s| !s.is_empty()),
    Type::Number => js::get_f64(id).is_finite(),
    _ => false,
  }
}

async fn run(args: Val) -> JsResult<Val> {
  let [
    id,
    current_depth,
    depth,
    disable_errors,
    global_config,
    override_access,
    populate,
    fallback_locale,
    locale,
    payload,
    req,
    incoming_select,
    show_hidden_fields,
  ] = unpack::<13>(call("globalFindVersionByIDArgs", &[args.get()])?)?;

  if !has_versions_enabled(global_config.get())? {
    if truthy(&disable_errors) {
      return Ok(Val::Null);
    }
    return Err(throw_t("notFound", &req));
  }

  // Access
  let access_results = if !truthy(&override_access) {
    let slug = gv(&global_config, "slug")?;
    let read_versions = path(&global_config, &["access", "readVersions"])?;
    let mut a = AccessArgs::new(slug, disable_errors.clone(), req.clone());
    a.id = id.clone();
    access(a, read_versions).await?
  } else {
    Val::Bool(true)
  };

  // If errors are disabled, and access returns false, return null
  if is_false(access_results.get()) {
    return Ok(Val::Null);
  }

  if !is_valid_id(id.get()) {
    return Err(throw_t("notFound", &req));
  }

  let has_where_access = is_typeof_object(access_results.get());

  let version_fields = call_val("globalVersionFields", &[payload.get(), global_config.get()])?;
  let select = call_val("selectVersions", &[version_fields.get(), global_config.get(), req.get(), incoming_select.get()])?;

  let where_ = call_val("combineQueries", &[call("idWhere", &[id.get()])?, access_results.get()])?;

  call("sanitizeWhereQuery", &[version_fields.get(), payload.get(), where_.get()])?;

  let find_args =
    call_val("globalFindVersionByIDDbArgs", &[global_config.get(), locale.get(), req.get(), select.get(), where_.get()])?;

  // Find by ID
  let found = db(&payload, "findGlobalVersions", || Ok(find_args.get())).await?;
  let results = val(call("awaitedProps", &[found.get(), js::string("docs")])?)?;
  let results = val(js::get_element(results.get(), 0)?)?;
  // !results || results?.length === 0
  let empty = !truthy(&results) || {
    let length = opt(results.get(), "length")?;
    js::type_of(length) == Type::Number && js::get_f64(length) == 0.0
  };
  if empty {
    if !truthy(&disable_errors) {
      if !has_where_access {
        return Err(throw_t("notFound", &req));
      }
      return Err(throw_t("forbidden", &req));
    }
    return Ok(Val::Null);
  }

  // Clone the result - it may have come back memoized
  let first = crate::host::get(results.get(), "0")?;
  let mut result = call_val("deepCopyObjectSimple", &[first])?;

  if !js::truthy(g(&result, "version")?) {
    set(result.get(), "version", js::object())?;
  }

  // Patch globalType onto version doc
  let version = val(g(&result, "version")?)?;
  set(version.get(), "globalType", g(&global_config, "slug")?)?;

  // beforeRead - Collection
  if has_hooks(global_config.get(), "beforeRead")? {
    let mut hooks = hooks_of(global_config.get(), "beforeRead")?;
    while let Some(hook) = hooks.next()? {
      let hook = val(hook)?;
      let body = async {
        let context = g(&req, "context")?;
        let version = g(&result, "version")?;
        let hook_args = call(
          "globalVersionHookArgs",
          &[context, version, global_config.get(), override_access.get(), js::undefined(), js::boolean(false), req.get()],
        )?;
        let p = call_fn(hook.get(), js::undefined(), &[hook_args], "hook")?;
        let hook_result = await_js(p).await?;
        result = if js::truthy(hook_result.get()) { hook_result } else { gv(&result, "version")? };
        Ok(())
      };
      loop_body(&hooks, body).await?;
    }
  }

  // afterRead - Fields
  let target = result.clone();
  let p = call(
    "globalFindVersionByIDAfterRead",
    &[
      req.get(),
      current_depth.get(),
      depth.get(),
      result.get(),
      fallback_locale.get(),
      global_config.get(),
      locale.get(),
      override_access.get(),
      populate.get(),
      select.get(),
      show_hidden_fields.get(),
    ],
  )?;
  let version = await_js(p).await?;
  set(target.get(), "version", version.get())?;

  // afterRead - Global
  if has_hooks(global_config.get(), "afterRead")? {
    let mut hooks = hooks_of(global_config.get(), "afterRead")?;
    while let Some(hook) = hooks.next()? {
      let hook = val(hook)?;
      let body = async {
        let target = result.clone();
        let context = g(&req, "context")?;
        let version = g(&result, "version")?;
        let query = g(&find_args, "where")?;
        let hook_args = call(
          "globalVersionHookArgs",
          &[context, version, global_config.get(), override_access.get(), query, js::boolean(true), req.get()],
        )?;
        let p = call_fn(hook.get(), js::undefined(), &[hook_args], "hook")?;
        let hook_result = await_js(p).await?;
        let value = if js::truthy(hook_result.get()) { hook_result.get() } else { get(result.get(), "version")? };
        set(target.get(), "version", value)?;
        Ok(())
      };
      loop_body(&hooks, body).await?;
    }
  }

  Ok(result)
}
