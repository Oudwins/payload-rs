//! Ports of the small auth operations of `packages/payload/src/auth/operations`:
//! `access.ts` (`accessOperation`), `auth.ts` (`auth`), `init.ts` (`initOperation`),
//! `logout.ts` (`logoutOperation`), `me.ts` (`meOperation`), `verifyEmail.ts`
//! (`verifyEmailOperation`), and `auth/applyUserReadAccess.ts` (its own task, as upstream's
//! `async` function).

use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::common::{
  await_helper, commit_transaction, config_hooks, db, init_transaction, kill_transaction, replace_loop, throw_t,
};
use crate::host::{ForOf, call, call_fn, call_val, g, gv, loop_body, path, set, throw_from, truthy, unpack, val};

/// `accessOperation(args)`: returns its promise.
pub fn access(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(async move {
    let req = gv(&args, "req")?;
    call("adminInitTelemetry", &[req.get()])?;
    // return getAccessResults({ req }) (the promise, not awaited)
    call_val("getAccessResults", &[req.get()])
  })
}

/// `auth(args)`: returns its promise.
pub fn auth(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(async move {
    let [can_set_headers, headers, req, payload] = unpack::<4>(call("authArgs", &[args.get()])?)?;

    let p = call("executeAuthStrategies", &[can_set_headers.get(), headers.get(), payload.get(), req.get()])?;
    let strategies = await_js(p).await?;
    let [response_headers, user] =
      unpack::<2>(call("awaitedProps", &[strategies.get(), js::string("responseHeaders"), js::string("user")])?)?;

    set(req.get(), "user", user.get())?;
    set(req.get(), "responseHeaders", response_headers.get())?;

    let permissions = await_helper("getAccessResults", &[req.get()]).await?;

    call_val("authResult", &[permissions.get(), response_headers.get(), user.get()])
  })
}

/// `initOperation(args)`: returns its promise.
pub fn init(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(async move {
    let [slug, req, where_] = unpack::<3>(call("initArgs", &[args.get()])?)?;
    let payload = gv(&req, "payload")?;
    let doc = db(&payload, "findOne", || call("initFindArgs", &[slug.get(), req.get(), where_.get()])).await?;
    Ok(Val::Bool(truthy(&doc)))
  })
}

/// `logoutOperation(incomingArgs)`: returns its promise.
pub fn logout(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run_logout(args))
}

async fn run_logout(incoming_args: Val) -> JsResult<Val> {
  let mut args = incoming_args.clone();
  let [all_sessions, collection_config, user, req] = unpack::<4>(call("logoutArgs", &[incoming_args.get()])?)?;

  let should_commit = truthy(&init_transaction(&req).await?);

  let body: JsResult<Val> = async {
    args = config_hooks(&collection_config, "afterLogout", args.clone(), |args| {
      call("afterLogoutHookArgs", &[args, req.get()])
    })
    .await?;

    if js::truthy(call("logoutUsesSessions", &[collection_config.get()])?) {
      let where_ = call_val("userWhere", &[collection_config.get(), user.get()])?;
      let payload = path(&req, &["payload"])?;
      let user_with_sessions = db(&payload, "findOne", || {
        call("userFindOneArgs", &[collection_config.get(), req.get(), where_.get()])
      })
      .await?;

      if !truthy(&user_with_sessions) {
        return Err(throw_from("apiError", &[js::string("No User"), js::number(400.0)]));
      }

      call("removeSessions", &[user_with_sessions.get(), all_sessions.get(), req.get()])?;

      let payload = path(&req, &["payload"])?;
      db(&payload, "updateOne", || {
        call("logoutUpdateArgs", &[user.get(), collection_config.get(), user_with_sessions.get(), req.get()])
      })
      .await?;
    }

    if should_commit {
      commit_transaction(&req).await?;
    }

    Ok(Val::Bool(true))
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

/// `meOperation(args)`: returns its promise.
pub fn me(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run_me(args))
}

async fn run_me(args: Val) -> JsResult<Val> {
  let [collection, current_token, depth, draft, joins, populate, req, select] =
    unpack::<8>(call("meArgs", &[args.get()])?)?;

  let mut result = call_val("meEmptyResult", &[])?;

  if js::truthy(g(&req, "user")?) {
    if !js::strict_equals(path(&req, &["user", "collection"])?.get(), path(&collection, &["config", "slug"])?.get()) {
      return call_val("meEmptyResult", &[]);
    }

    let p = call(
      "meFindByID",
      &[req.get(), collection.get(), depth.get(), draft.get(), joins.get(), populate.get(), select.get()],
    )?;
    let user = await_js(p).await?;

    if truthy(&user) {
      call("meUserMetadata", &[user.get(), collection.get(), req.get()])?;
    }

    // me hook - Collection
    let mut hooks = ForOf::new(path(&collection, &["config", "hooks", "me"])?.get())?;
    while let Some(me_hook) = hooks.next()? {
      let me_hook = val(me_hook)?;
      let mut done = false;
      let body = async {
        let hook_args = call("meHookArgs", &[args.get(), user.get()])?;
        let p = call_fn(me_hook.get(), js::undefined(), &[hook_args], "meHook")?;
        let hook_result = await_js(p).await?;

        if truthy(&hook_result) {
          call("meApplyHookResult", &[result.get(), hook_result.get()])?;
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

    set(result.get(), "collection", path(&req, &["user", "collection"])?.get())?;

    if !js::truthy(g(&result, "user")?) {
      call("meDefaultUser", &[result.get(), user.get(), current_token.get(), collection.get()])?;
    }
  }

  // After Me - Collection
  if js::truthy(crate::host::opt(crate::host::opt(path(&collection, &["config", "hooks"])?.get(), "afterMe")?, "length")?) {
    let hooks = crate::common::hooks_of(path(&collection, &["config"])?.get(), "afterMe")?;
    result = replace_loop(hooks, result, "hook", |result| {
      call("afterMeHookArgs", &[collection.get(), req.get(), result])
    })
    .await?;
  }

  Ok(result)
}

/// `verifyEmailOperation(args)`: returns its promise.
pub fn verify_email(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run_verify_email(args))
}

async fn run_verify_email(args: Val) -> JsResult<Val> {
  let [collection, req, token] = unpack::<3>(call("verifyEmailArgs", &[args.get()])?)?;

  let body: JsResult<Val> = async {
    let should_commit = truthy(&init_transaction(&req).await?);

    let where_ = call_val("verificationWhere", &[collection.get(), token.get()])?;

    let payload = gv(&req, "payload")?;
    let user = db(&payload, "findOne", || {
      call("userFindOneArgs", &[path(&collection, &["config"])?.get(), req.get(), where_.get()])
    })
    .await?;

    if !truthy(&user) {
      return Err(throw_from("apiError", &[js::string("Verification token is invalid."), js::number(403.0)]));
    }

    // Ensure updatedAt date is always updated
    call("stampUpdatedAt", &[user.get()])?;

    let payload = gv(&req, "payload")?;
    db(&payload, "updateOne", || call("verifyEmailUpdateArgs", &[user.get(), collection.get(), req.get()])).await?;

    if should_commit {
      commit_transaction(&req).await?;
    }

    Ok(Val::Bool(true))
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

/// `applyUserReadAccess({ collection, depth, overrideAccess, req, showHiddenFields, user })`:
/// returns its promise.
pub fn apply_user_read_access(
  collection: Val,
  depth: Val,
  override_access: Val,
  req: Val,
  show_hidden_fields: Val,
  user: Val,
) -> JsResult<Local> {
  spawn(async move {
    let authentication_metadata = call_val("authenticationMetadata", &[user.get()])?;

    let p = call(
      "userAfterRead",
      &[collection.get(), req.get(), depth.get(), user.get(), override_access.get(), show_hidden_fields.get()],
    )?;
    let mut user_with_read_access = await_js(p).await?;

    if js::truthy(crate::host::opt(crate::host::opt(g(&collection, "hooks")?, "afterRead")?, "length")?) {
      let hooks = crate::common::hooks_of(collection.get(), "afterRead")?;
      user_with_read_access = replace_loop(hooks, user_with_read_access, "hook", |doc| {
        call("userAfterReadHookArgs", &[collection.get(), req.get(), doc, override_access.get()])
      })
      .await?;
    }

    call_val("spreadTwo", &[user_with_read_access.get(), authentication_metadata.get()])
  })
}

/// `throw new Forbidden(req.t)` etc. re-exported for the larger auth ports.
pub fn forbidden(req: &Val) -> js::Thrown {
  throw_t("forbidden", req)
}
