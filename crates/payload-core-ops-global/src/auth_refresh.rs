//! Port of `packages/payload/src/auth/operations/refresh.ts` (`refreshOperation`). JWT signing
//! (`getFieldsToSign`, `jwtSign`) and `extendSession` stay the upstream JS.

use payload_core_ops::common::{build_after_operation, build_before_operation};
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::auth_small::{apply_user_read_access, forbidden};
use crate::common::{
  await_helper, commit_transaction, config_hooks, db, init_transaction, kill_transaction, throw_t,
};
use crate::host::{ForOf, call, call_fn, call_val, g, gv, loop_body, opt, path, set, throw_from, truthy, unpack, val};

/// `refreshOperation(incomingArgs)`: returns its promise.
pub fn refresh(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run(args))
}

async fn run(incoming_args: Val) -> JsResult<Val> {
  let mut args = incoming_args;

  call("assertNoValidationWrite", &[g(&args, "req")?])?;

  let body: JsResult<Val> = async {
    let should_commit = truthy(&init_transaction(&gv(&args, "req")?).await?);

    // beforeOperation - Collection
    let collection = path(&args, &["collection", "config"])?;
    args = await_js(build_before_operation(args.clone(), collection, "refresh", Val::Bool(false))?).await?;

    // Refresh
    let [collection_config, req, config, secret] = unpack::<4>(call("refreshArgs", &[args.get()])?)?;

    if !js::truthy(path(&args, &["req", "user"])?.get()) {
      return Err(forbidden(&gv(&args, "req")?));
    }
    if !js::strict_equals(path(&args, &["req", "user", "collection"])?.get(), g(&collection_config, "slug")?) {
      return Err(throw_from("apiError", &[js::string("Incorrect collection"), js::number(403.0)]));
    }

    let is_graph_ql = call_val("refreshIsGraphQL", &[args.get(), config.get()])?;

    let payload = gv(&req, "payload")?;
    let mut user = db(&payload, "findOne", || call("refreshFindArgs", &[collection_config.get(), req.get(), args.get()])).await?;

    if !truthy(&user) {
      return Err(forbidden(&gv(&args, "req")?));
    }

    let sid = path(&args, &["req", "user", "_sid"])?;

    if js::truthy(call("usesSessions", &[collection_config.get()])?) {
      let session = if truthy(&sid) {
        await_helper("extendSession", &[collection_config.get(), req.get(), sid.get(), user.get()]).await?
      } else {
        sid.clone()
      };

      if !truthy(&session) {
        return Err(forbidden(&gv(&args, "req")?));
      }
    }

    let payload = gv(&req, "payload")?;
    user = db(&payload, "findOne", || call("refreshFindTrashedArgs", &[collection_config.get(), req.get(), user.get()])).await?;

    if !truthy(&user) {
      return Err(throw_t("notFound", &req));
    }

    set(user.get(), "collection", path(&args, &["req", "user", "collection"])?.get())?;
    set(user.get(), "_strategy", path(&args, &["req", "user", "_strategy"])?.get())?;

    let mut result = Val::Undefined;

    // refresh hook - Collection
    let mut hooks = ForOf::of(path(&args, &["collection", "config", "hooks", "refresh"])?.get(), "args.collection.config.hooks.refresh")?;
    while let Some(refresh_hook) = hooks.next()? {
      let refresh_hook = val(refresh_hook)?;
      let mut done = false;
      let body = async {
        let hook_args = call("refreshHookArgs", &[args.get(), user.get()])?;
        let p = call_fn(refresh_hook.get(), js::undefined(), &[hook_args], "refreshHook")?;
        let hook_result = await_js(p).await?;

        if truthy(&hook_result) {
          result = hook_result;
          done = true;
        }
        Ok(())
      };
      loop_body(&hooks, body).await?;
      if done {
        hooks.close();
        break;
      }
    }

    if !truthy(&result) {
      let fields_to_sign = call_val("refreshFieldsToSign", &[collection_config.get(), user.get(), sid.get(), args.get()])?;

      let signed = await_helper("jwtSign", &[fields_to_sign.get(), secret.get(), collection_config.get()]).await?;
      let [exp, refreshed_token] =
        unpack::<2>(call("awaitedProps", &[signed.get(), js::string("exp"), js::string("token")])?)?;

      result = call_val("refreshResult", &[exp.get(), refreshed_token.get(), user.get()])?;
    }

    let target = result.clone();
    let depth = if truthy(&is_graph_ql) { Val::Num(0.0) } else { path(&collection_config, &["auth", "depth"])? };
    let p = apply_user_read_access(
      collection_config.clone(),
      depth,
      Val::Bool(false),
      req.clone(),
      Val::Bool(false),
      gv(&result, "user")?,
    )?;
    let user_with_read_access = await_js(p).await?;
    set(target.get(), "user", user_with_read_access.get())?;

    // After Refresh - Collection
    result = config_hooks(&collection_config, "afterRefresh", "collectionConfig", result, |result| {
      call("afterRefreshHookArgs", &[args.get(), result])
    })
    .await?;

    // afterOperation - Collection
    let collection = val(opt(g(&args, "collection")?, "config")?)?;
    result = await_js(build_after_operation(args.clone(), collection, "refresh", Val::Bool(false), result)?).await?;

    // Return results
    if should_commit {
      commit_transaction(&req).await?;
    }

    Ok(result)
  }
  .await;

  match body {
    Ok(v) => Ok(v),
    Err(error) => {
      kill_transaction(&gv(&args, "req")?).await?;
      Err(error)
    }
  }
}
