//! Port of `packages/payload/src/auth/operations/login.ts` (`loginOperation`).
//!
//! Password hashing (`authenticateLocalStrategy`, `generatePasswordSaltHash`), JWT/session
//! creation (`createAuthToken`, `revokeSession`) and the login-attempt counters
//! (`incrementLoginAttempts`, `resetLoginAttempts`) stay the upstream JS, called at the same
//! points; the input sanitization / where-building segment is one JS helper (no user callbacks).

use payload_core_ops::common::{build_after_operation, build_before_operation};
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::auth_small::{apply_user_read_access, forbidden};
use crate::common::{await_helper, commit_transaction, config_hooks, db, init_transaction, kill_transaction, throw_t};
use crate::host::{call, call_val, g, gv, opt, path, set, truthy, unpack, val};

/// `loginOperation(incomingArgs)`: returns its promise.
pub fn login(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run(args))
}

async fn run(incoming_args: Val) -> JsResult<Val> {
  let mut args = incoming_args;

  call("assertNoValidationWrite", &[g(&args, "req")?])?;

  if js::truthy(g(&path(&args, &["collection", "config", "auth"])?, "disableLocalStrategy")?) {
    return Err(forbidden(&gv(&args, "req")?));
  }

  // beforeOperation - Collection
  let collection = path(&args, &["collection", "config"])?;
  let override_access_arg = gv(&args, "overrideAccess")?;
  args = await_js(build_before_operation(args, collection, "login", override_access_arg)?).await?;

  let [collection_config, data, depth, override_access, req, payload, show_hidden_fields] =
    unpack::<7>(call("loginArgs", &[args.get()])?)?;

  // Login
  let [can_login_with_username, sanitized_email, sanitized_username, password, where_constraint] =
    unpack::<5>(call("loginPrepare", &[collection_config.get(), data.get(), req.get()])?)?;
  let logging_in_with_username = js::boolean(truthy(&can_login_with_username) && truthy(&sanitized_username));

  let mut user = db(&payload, "findOne", || {
    call("userFindOneArgs", &[collection_config.get(), req.get(), where_constraint.get()])
  })
  .await?;

  call("checkLoginPermission", &[logging_in_with_username, req.get(), user.get()])?;

  set(user.get(), "collection", g(&collection_config, "slug")?)?;
  set(user.get(), "_strategy", js::string("local-jwt"))?;

  let authenticated_hash = gv(&user, "hash")?;
  let authenticated_salt = gv(&user, "salt")?;
  let auth_result = await_helper("authenticateLocalStrategy", &[user.get(), password.get(), payload.get()]).await?;
  user = call_val("sanitizeInternalFields", &[user.get()])?;

  let max_login_attempts_enabled = js::truthy(call("maxLoginAttemptsEnabled", &[args.get()])?);

  if !truthy(&auth_result) {
    if max_login_attempts_enabled {
      await_helper("incrementLoginAttempts", &[collection_config.get(), req.get(), user.get()]).await?;

      // Re-check login permissions and max attempts after incrementing attempts, in case parallel updates occurred
      let logging_in_with_username = js::boolean(truthy(&can_login_with_username) && truthy(&sanitized_username));
      call("checkLoginPermission", &[logging_in_with_username, req.get(), user.get()])?;
    }

    return Err(throw_t("authenticationError", &req));
  }

  if js::truthy(path(&collection_config, &["auth", "verify"])?.get()) && crate::host::is_false(g(&user, "_verified")?) {
    return Err(crate::host::throw_from("unverifiedEmail", &[g(&req, "t")?]));
  }

  // Authentication successful - start transaction for remaining operations
  let args_req = gv(&args, "req")?;
  let should_commit = truthy(&init_transaction(&args_req).await?);
  let mut sid = Val::Undefined;

  let body: JsResult<Val> = async {
    // Correct password accepted - re-check that the account didn't get locked by parallel bad
    // attempts in the meantime.
    if max_login_attempts_enabled {
      let found = db(&payload, "findOne", || call("lockStateFindArgs", &[collection_config.get(), req.get(), user.get()])).await?;
      let [lock_until, login_attempts] = unpack::<2>(call(
        "awaitedProps",
        &[found.get(), js::string("lockUntil"), js::string("loginAttempts")],
      )?)?;

      set(user.get(), "lockUntil", lock_until.get())?;
      set(user.get(), "loginAttempts", login_attempts.get())?;

      call("checkLoginPermission", &[js::undefined(), req.get(), user.get()])?;
    }

    let token_result =
      await_helper("createAuthToken", &[collection_config.get(), sanitized_email.get(), req.get(), user.get()]).await?;
    let [exp, token, session] = unpack::<3>(call("authTokenParts", &[token_result.get(), js::boolean(true)])?)?;
    sid = gv(&session, "sid")?;

    if js::truthy(opt(auth_result.get(), "shouldUpdatePasswordHash")?)
      && js::type_of(authenticated_hash.get()) == js::Type::String
      && js::type_of(authenticated_salt.get()) == js::Type::String
    {
      let rehash: JsResult<Val> = async {
        let hashed = await_helper("rehashPassword", &[collection_config.get(), password.get(), req.get()]).await?;
        let [hash, salt] = unpack::<2>(call("awaitedProps", &[hashed.get(), js::string("hash"), js::string("salt")])?)?;

        db(&payload, "updateOne", || {
          call(
            "rehashUpdateArgs",
            &[collection_config.get(), hash.get(), salt.get(), req.get(), user.get(), authenticated_hash.get(), authenticated_salt.get()],
          )
        })
        .await
      }
      .await;
      if let Err(js::Thrown(err)) = rehash {
        // Rehashing is opportunistic and is retried on the next login
        call("logRehashFailure", &[payload.get(), err.get()])?;
      }
    }

    if max_login_attempts_enabled {
      await_helper("resetLoginAttempts", &[collection_config.get(), user.get(), req.get()]).await?;
    }

    // beforeLogin - Collection
    user = config_hooks(&collection_config, "beforeLogin", user.clone(), |user| {
      call("loginHookArgs", &[args.get(), user, js::undefined(), js::boolean(false)])
    })
    .await?;

    set(req.get(), "user", user.get())?;

    // afterLogin - Collection
    user = config_hooks(&collection_config, "afterLogin", user.clone(), |user| {
      call("loginHookArgs", &[args.get(), user, token.get(), js::boolean(true)])
    })
    .await?;

    // afterRead - Fields
    let p = apply_user_read_access(
      collection_config.clone(),
      depth.clone(),
      override_access.clone(),
      req.clone(),
      show_hidden_fields.clone(),
      user.clone(),
    )?;
    let user_with_read_access = await_js(p).await?;

    let result = call_val("loginResult", &[exp.get(), token.get(), user_with_read_access.get()])?;

    // afterOperation - Collection
    let collection = val(opt(g(&args, "collection")?, "config")?)?;
    let override_access_arg = gv(&args, "overrideAccess")?;
    let result = await_js(build_after_operation(args.clone(), collection, "login", override_access_arg, result)?).await?;

    if should_commit {
      commit_transaction(&req).await?;
    }

    // Return results
    Ok(result)
  }
  .await;

  match body {
    Ok(v) => Ok(v),
    Err(error) => {
      // The password was right, but the login failed afterwards, e.g. in a `beforeLogin` hook, so
      // remove the session it started
      if truthy(&sid) {
        await_helper("revokeSession", &[collection_config.get(), payload.get(), req.get(), sid.get(), user.get()]).await?;
      }
      kill_transaction(&gv(&args, "req")?).await?;
      Err(error)
    }
  }
}
