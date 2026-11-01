//! Port of `packages/payload/src/auth/operations/resetPassword.ts` (`resetPasswordOperation`,
//! `validatePasswordField`). Hashing, authentication and session handling stay the upstream JS.

use payload_core_ops::common::{build_after_operation, build_before_operation};
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::auth_small::apply_user_read_access;
use crate::common::{
  await_helper, await_loop, commit_transaction, config_hooks, db, has_hooks, hooks_of, init_transaction,
  kill_transaction,
};
use crate::host::{call, call_fn, call_val, g, gv, opt, path, set, throw_from, truthy, unpack, val};

/// `resetPasswordOperation(args)`: returns its promise.
pub fn reset_password(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run(args))
}

async fn run(args: Val) -> JsResult<Val> {
  let mut args = args;
  let [collection_config, data, depth, override_access, payload, req] =
    unpack::<6>(call("resetPasswordArgs", &[args.get()])?)?;

  let mut sid = Val::Undefined;
  let mut session_user = Val::Null;

  let body: JsResult<Val> = async {
    let should_commit = truthy(&init_transaction(&req).await?);

    let collection = path(&args, &["collection", "config"])?;
    args = await_js(build_before_operation(args.clone(), collection, "resetPassword", override_access.clone())?).await?;

    // Reset Password
    let where_ = call_val("resetPasswordWhere", &[collection_config.get(), data.get()])?;

    let mut user = db(&payload, "findOne", || {
      call("userFindOneArgs", &[collection_config.get(), req.get(), where_.get()])
    })
    .await?;

    if !truthy(&user) {
      return Err(throw_from("apiError", &[js::string("Token is either invalid or has expired."), js::number(403.0)]));
    }

    let p = spawn(validate_password_field(
      collection_config.clone(),
      override_access.clone(),
      gv(&data, "password")?,
      req.clone(),
      user.clone(),
    ))?;
    await_js(p).await?;

    let hashed = await_helper("hashPassword", &[collection_config.get(), data.get(), req.get()]).await?;
    let [hash, salt] = unpack::<2>(call("awaitedProps", &[hashed.get(), js::string("hash"), js::string("salt")])?)?;

    call("resetPasswordApply", &[user.get(), salt.get(), hash.get(), collection_config.get()])?;

    // beforeValidate - Collection
    if has_hooks(collection_config.get(), "beforeValidate")? {
      let hooks = hooks_of(collection_config.get(), "beforeValidate", "collectionConfig")?;
      await_loop(hooks, "hook", || call("resetPasswordBeforeValidateArgs", &[args.get(), req.get(), user.get()])).await?;
    }

    // Update new password
    call("resetPasswordBeforeUpdate", &[user.get(), collection_config.get()])?;

    let doc = db(&payload, "updateOne", || {
      call("resetPasswordUpdateArgs", &[user.get(), collection_config.get(), req.get()])
    })
    .await?;

    await_helper("authenticateWith", &[doc.get(), data.get(), payload.get()]).await?;

    user = doc;
    set(user.get(), "collection", g(&collection_config, "slug")?)?;
    set(user.get(), "_strategy", js::string("local-jwt"))?;

    let token_result =
      await_helper("createAuthTokenFor", &[collection_config.get(), user.get(), req.get()]).await?;
    let [_exp, token, session] = unpack::<3>(call("authTokenParts", &[token_result.get(), js::boolean(false)])?)?;

    session_user = user.clone();
    sid = gv(&session, "sid")?;

    // beforeLogin - Collection
    user = config_hooks(&collection_config, "beforeLogin", "collectionConfig", user.clone(), |user| {
      call("loginHookArgs", &[args.get(), user, js::undefined(), js::boolean(false)])
    })
    .await?;

    set(req.get(), "user", user.get())?;

    // afterLogin - Collection
    user = config_hooks(&collection_config, "afterLogin", "collectionConfig", user.clone(), |user| {
      call("loginHookArgs", &[args.get(), user, token.get(), js::boolean(true)])
    })
    .await?;

    set(user.get(), "collection", g(&collection_config, "slug")?)?;
    set(user.get(), "_strategy", js::string("local-jwt"))?;

    let p = apply_user_read_access(
      collection_config.clone(),
      depth.clone(),
      override_access.clone(),
      req.clone(),
      Val::Bool(false),
      user.clone(),
    )?;
    let user_with_read_access = await_js(p).await?;

    if should_commit {
      commit_transaction(&req).await?;
    }

    let result = call_val("tokenUserResult", &[token.get(), user_with_read_access.get()])?;

    // afterOperation - Collection
    let collection = val(opt(g(&args, "collection")?, "config")?)?;
    let result =
      await_js(build_after_operation(args.clone(), collection, "resetPassword", override_access.clone(), result)?).await?;

    Ok(result)
  }
  .await;

  match body {
    Ok(v) => Ok(v),
    Err(error) => {
      // Logging in with the new password failed, e.g. in a `beforeLogin` hook, so remove the
      // session it started
      if truthy(&sid) {
        await_helper("revokeSession", &[collection_config.get(), payload.get(), req.get(), sid.get(), session_user.get()])
          .await?;
      }
      kill_transaction(&req).await?;
      Err(error)
    }
  }
}

/// `validatePasswordField({ collectionConfig, overrideAccess, password, req, user })`
async fn validate_password_field(
  collection_config: Val,
  override_access: Val,
  password: Val,
  req: Val,
  user: Val,
) -> JsResult<Val> {
  let password_field = call_val("findPasswordField", &[collection_config.get()])?;

  if !js::truthy(call("hasValidate", &[password_field.get()])?) {
    return Ok(Val::Undefined);
  }

  let validate = gv(&password_field, "validate")?;
  let options = call("passwordValidateOptions", &[password_field.get(), user.get(), password.get(), collection_config.get(), override_access.get(), req.get()])?;

  let p = call_fn(validate.get(), js::undefined(), &[password.get(), options], "validate")?;
  let validation_result = await_js(p).await?;

  if js::type_of(validation_result.get()) == js::Type::String {
    return Err(throw_from("passwordValidationError", &[collection_config.get(), validation_result.get()]));
  }

  Ok(Val::Undefined)
}
