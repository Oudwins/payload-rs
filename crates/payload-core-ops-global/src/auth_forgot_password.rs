//! Port of `packages/payload/src/auth/operations/forgotPassword.ts` (`forgotPasswordOperation`).
//! Token generation (`crypto.randomBytes`), URL/HTML building and `email.sendEmail` stay JS.

use payload_core_ops::common::{build_after_operation, build_before_operation};
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::common::{
  commit_transaction, db, has_hooks, hooks_of, init_transaction, kill_transaction, local_api,
};
use crate::host::{call, call_val, g, gv, method, opt, path, truthy, unpack, val};

/// `forgotPasswordOperation(incomingArgs)`: returns its promise.
pub fn forgot_password(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run(args))
}

async fn run(incoming_args: Val) -> JsResult<Val> {
  let [_data, override_access, can_login_with_email, can_login_with_username, sanitized_email, sanitized_username] =
    unpack::<6>(call("forgotPasswordPrelude", &[incoming_args.get()])?)?;
  let mut args = incoming_args;
  let mut has_sent_email = false;
  // `releaseRequestInterval`: set once the request interval is reserved.
  let mut release: Option<(Val, Val, Val, Val, Val)> = None;

  let body: JsResult<Val> = async {
    let should_commit = truthy(&init_transaction(&gv(&args, "req")?).await?);

    // beforeOperation - Collection
    let collection = path(&args, &["collection", "config"])?;
    args = await_js(build_before_operation(args.clone(), collection, "forgotPassword", override_access.clone())?).await?;

    let [
      collection_config,
      disable_email,
      _expiration,
      config,
      email,
      payload,
      req,
      min_request_interval,
      where_constraint,
      now,
      mut token,
      reset_password_expiration,
      reserve,
    ] = unpack::<13>(call(
      "forgotPasswordSetup",
      &[
        args.get(),
        can_login_with_email.get(),
        sanitized_email.get(),
        can_login_with_username.get(),
        sanitized_username.get(),
      ],
    )?)?;

    let mut user;

    if truthy(&reserve) {
      let [requested_at, reservation_req] = unpack::<2>(call("reservationRequest", &[now.get(), req.get()])?)?;

      user = db(&payload, "updateOne", || {
        call(
          "reserveRequestArgs",
          &[
            collection_config.get(),
            requested_at.get(),
            reservation_req.get(),
            where_constraint.get(),
            now.get(),
            min_request_interval.get(),
          ],
        )
      })
      .await?;

      if truthy(&user) {
        let user_id = gv(&user, "id")?;
        release = Some((payload.clone(), collection_config.clone(), reservation_req.clone(), user_id, requested_at.clone()));
      }
    } else {
      user = db(&payload, "findOne", || {
        call("userFindOneArgs", &[collection_config.get(), req.get(), where_constraint.get()])
      })
      .await?;
    }

    // We don't want to indicate specifically that an email was not found, as doing so could lead
    // to the exposure of registered emails. Therefore, we prefer to fail silently.
    if !truthy(&user) {
      if should_commit {
        commit_transaction(&gv(&args, "req")?).await?;
      }
      return Ok(Val::Null);
    }

    user = local_api(&payload, "update", || {
      call(
        "resetTokenUpdateArgs",
        &[user.get(), collection_config.get(), reset_password_expiration.get(), token.get(), req.get()],
      )
    })
    .await?;

    if !truthy(&disable_email) && js::truthy(g(&user, "email")?) {
      let mut html = call_val("forgotPasswordHTML", &[config.get(), req.get(), token.get()])?;

      let forgot = opt(path(&collection_config, &["auth"])?.get(), "forgotPassword")?;
      if js::type_of(opt(forgot, "generateEmailHTML")?) == js::Type::Function {
        let forgot = val(get_forgot(&collection_config)?)?;
        html = await_js(method(forgot.get(), "generateEmailHTML", "collectionConfig.auth.forgotPassword.generateEmailHTML", || {
          call("emailHookArgs", &[req.get(), token.get(), user.get()])
        })?)
        .await?;
      }

      let mut subject = call_val("translate", &[req.get(), js::string("authentication:resetYourPassword")])?;

      let forgot = opt(path(&collection_config, &["auth"])?.get(), "forgotPassword")?;
      if js::type_of(opt(forgot, "generateEmailSubject")?) == js::Type::Function {
        let forgot = val(get_forgot(&collection_config)?)?;
        subject = await_js(method(
          forgot.get(),
          "generateEmailSubject",
          "collectionConfig.auth.forgotPassword.generateEmailSubject",
          || call("emailHookArgs", &[req.get(), token.get(), user.get()]),
        )?)
        .await?;
      }

      await_js(method(email.get(), "sendEmail", "email.sendEmail", || {
        call("resetEmailArgs", &[email.get(), html.get(), subject.get(), user.get()])
      })?)
      .await?;
      has_sent_email = true;
    }

    // afterForgotPassword - Collection
    if has_hooks(collection_config.get(), "afterForgotPassword")? {
      let hooks = hooks_of(collection_config.get(), "afterForgotPassword")?;
      crate::common::await_loop(hooks, "hook", || call("afterForgotPasswordHookArgs", &[args.get(), req.get()])).await?;
    }

    // afterOperation - Collection
    let collection = val(opt(g(&args, "collection")?, "config")?)?;
    token = await_js(build_after_operation(args.clone(), collection, "forgotPassword", override_access.clone(), token)?).await?;

    if should_commit {
      commit_transaction(&req).await?;
    }

    Ok(token)
  }
  .await;

  match body {
    Ok(v) => Ok(v),
    Err(error) => {
      kill_transaction(&gv(&args, "req")?).await?;

      if !has_sent_email {
        if let Some((payload, collection_config, reservation_req, user_id, requested_at)) = release {
          let released: JsResult<Val> = async {
            let p = spawn(release_request_interval(payload, collection_config, reservation_req, user_id, requested_at))?;
            await_js(p).await
          }
          .await;
          if let Err(js::Thrown(err)) = released {
            call("logReleaseFailure", &[args.get(), err.get()])?;
          }
        }
      }

      Err(error)
    }
  }
}

/// `collectionConfig.auth.forgotPassword` (the method receiver).
fn get_forgot(collection_config: &Val) -> JsResult<Local> {
  g(&path(collection_config, &["auth"])?, "forgotPassword")
}

/// `releaseRequestInterval = async () => { await payload.db.updateOne({ ... }) }`
async fn release_request_interval(
  payload: Val,
  collection_config: Val,
  reservation_req: Val,
  user_id: Val,
  requested_at: Val,
) -> JsResult<Val> {
  db(&payload, "updateOne", || {
    call("releaseRequestArgs", &[collection_config.get(), reservation_req.get(), user_id.get(), requested_at.get()])
  })
  .await?;
  Ok(Val::Undefined)
}
