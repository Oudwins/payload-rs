//! Ports of `packages/payload/src/auth/operations/registerFirstUser.ts`
//! (`registerFirstUserOperation`) and `unlock.ts` (`unlockOperation`).

use payload_core_ops::common::{AccessArgs, build_after_operation, build_before_operation};
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::common::{
  access, await_helper, commit_transaction, db, init_transaction, kill_transaction, local_api, throw_t,
};
use crate::host::{call, call_val, gv, is_typeof_object, path, truthy, unpack, val};

/// `registerFirstUserOperation(args)`: returns its promise.
pub fn register_first_user(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run_register(args))
}

async fn run_register(args: Val) -> JsResult<Val> {
  let [config, slug, verify, data, req, payload] = unpack::<6>(call("registerFirstUserArgs", &[args.get()])?)?;

  let body: JsResult<Val> = async {
    let should_commit = truthy(&init_transaction(&req).await?);

    call("ensureUsernameOrEmail", &[config.get(), slug.get(), data.get(), req.get()])?;

    let where_ = call_val("noTrashedWhere", &[config.get()])?;

    let doc = db(&payload, "findOne", || call("userFindOneArgs", &[config.get(), req.get(), where_.get()])).await?;

    if truthy(&doc) {
      return Err(throw_t("forbidden", &req));
    }

    // Register first user
    let result = local_api(&payload, "create", || call("registerCreateArgs", &[slug.get(), data.get(), req.get()])).await?;

    // auto-verify (if applicable)
    if truthy(&verify) {
      local_api(&payload, "update", || call("registerVerifyArgs", &[result.get(), slug.get(), req.get()])).await?;
    }

    // Log in new user
    let logged_in = local_api(&payload, "login", || call("registerLoginArgs", &[args.get(), slug.get(), req.get()])).await?;
    let [exp, token, user] = unpack::<3>(call(
      "awaitedProps",
      &[logged_in.get(), js::string("exp"), js::string("token"), js::string("user")],
    )?)?;

    if should_commit {
      commit_transaction(&req).await?;
    }

    call_val("loginResult", &[exp.get(), token.get(), user.get()])
  }
  .await;

  match body {
    Ok(v) => Ok(v),
    Err(error) => {
      kill_transaction(&req).await?;
      Err(error)
    }
  }
}

/// `unlockOperation(args)`: returns its promise.
pub fn unlock(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run_unlock(args))
}

async fn run_unlock(args: Val) -> JsResult<Val> {
  let mut args = args;
  let [collection_config, override_access, locale, req, can_login_with_email, can_login_with_username, sanitized_email, sanitized_username] =
    unpack::<8>(call("unlockPrelude", &[args.get()])?)?;

  let body: JsResult<Val> = async {
    let collection = path(&args, &["collection", "config"])?;
    args = await_js(build_before_operation(args.clone(), collection, "unlock", override_access.clone())?).await?;

    let should_commit = truthy(&init_transaction(&req).await?);
    let mut where_constraint = val(js::object())?;

    // Access
    if !truthy(&override_access) {
      let slug = gv(&collection_config, "slug")?;
      let unlock = path(&collection_config, &["access", "unlock"])?;
      let access_result = access(AccessArgs::new(slug, Val::Undefined, req.clone()), unlock).await?;

      if truthy(&access_result) && is_typeof_object(access_result.get()) {
        where_constraint = access_result;
      }
    }

    // Unlock
    where_constraint = call_val(
      "unlockWhere",
      &[
        where_constraint.get(),
        can_login_with_email.get(),
        sanitized_email.get(),
        can_login_with_username.get(),
        sanitized_username.get(),
        collection_config.get(),
      ],
    )?;

    let payload = gv(&req, "payload")?;
    let user = db(&payload, "findOne", || {
      call("unlockFindArgs", &[collection_config.get(), locale.get(), req.get(), where_constraint.get()])
    })
    .await?;

    let result;

    if truthy(&user) {
      await_helper("resetLoginAttempts", &[collection_config.get(), user.get(), req.get()]).await?;
      result = Val::Bool(true);
    } else {
      return Err(throw_t("forbidden", &req));
    }

    if should_commit {
      commit_transaction(&req).await?;
    }

    let collection = path(&args, &["collection", "config"])?;
    let result = await_js(build_after_operation(args.clone(), collection, "unlock", override_access.clone(), result)?).await?;

    Ok(Val::Bool(truthy(&result)))
  }
  .await;

  match body {
    Ok(v) => Ok(v),
    Err(error) => {
      kill_transaction(&req).await?;
      Err(error)
    }
  }
}
