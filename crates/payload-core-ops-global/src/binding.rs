//! The JS-facing binding object, exposed by `payload-node` as `coreOpsGlobalBinding()`
//! (crates/payload-node/src/ops_global.rs) and wrapped by `packages/engine-rs/src/ops-global`.
//! It shares the core runtime's thread-local state (executor, runtime host) and uses the
//! collection operations' host (payload-core-ops), so `getCoreOps()` must have run.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Thrown};

use crate::{
  auth_forgot_password, auth_login, auth_refresh, auth_register_unlock, auth_reset_password, auth_small,
  global_count_versions, global_doc_access, global_find_one, global_find_version_by_id, global_find_versions,
  global_restore_version, global_update, global_validate, host,
};

type Body = fn(Local) -> JsResult<Local>;

/// Runs an exported function body: sets the env, converts `Err(Thrown)` into a JS throw and
/// never lets a panic cross the FFI boundary. Operation bodies only fail synchronously when the
/// engine itself fails (napi); everything the TS does inside the `async` function rejects.
fn run(env: sys::napi_env, info: sys::napi_callback_info, body: Body) -> sys::napi_value {
  js::set_env(env);
  let ([arg], _) = js::callback_args::<1>(env, info);
  match catch_unwind(AssertUnwindSafe(|| body(arg))) {
    Ok(Ok(v)) => v.0,
    Ok(Err(Thrown(e))) => {
      js::throw(e.get());
      ptr::null_mut()
    }
    Err(_) => {
      let Thrown(e) = js::engine_error("payload core global/auth operations panicked");
      js::throw(e.get());
      ptr::null_mut()
    }
  }
}

macro_rules! export {
  ($name:ident, $body:expr) => {
    unsafe extern "C" fn $name(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
      run(env, info, $body)
    }
  };
}

export!(init_export, |host_obj| {
  host::install(host_obj)?;
  Ok(js::undefined())
});
export!(global_find_one_export, global_find_one::find_one);
export!(global_update_export, global_update::update);
export!(global_find_versions_export, global_find_versions::find_versions);
export!(global_find_version_by_id_export, global_find_version_by_id::find_version_by_id);
export!(global_count_versions_export, global_count_versions::count_global_versions);
export!(global_restore_version_export, global_restore_version::restore_version);
export!(global_doc_access_export, global_doc_access::doc_access);
export!(global_validate_export, global_validate::validate);
export!(login_export, auth_login::login);
export!(logout_export, auth_small::logout);
export!(me_export, auth_small::me);
export!(refresh_export, auth_refresh::refresh);
export!(forgot_password_export, auth_forgot_password::forgot_password);
export!(reset_password_export, auth_reset_password::reset_password);
export!(register_first_user_export, auth_register_unlock::register_first_user);
export!(unlock_export, auth_register_unlock::unlock);
export!(verify_email_export, auth_small::verify_email);
export!(access_export, auth_small::access);
export!(auth_export, auth_small::auth);
export!(auth_init_export, auth_small::init);

/// Builds the binding object.
pub fn create() -> JsResult<Local> {
  let o = js::object();
  macro_rules! add {
    ($js:literal, $f:ident) => {
      js::set_named(o, $js, js::create_function($js, $f, ptr::null_mut()))?;
    };
  }
  add!("init", init_export);
  add!("globalFindOne", global_find_one_export);
  add!("globalUpdate", global_update_export);
  add!("globalFindVersions", global_find_versions_export);
  add!("globalFindVersionByID", global_find_version_by_id_export);
  add!("globalCountVersions", global_count_versions_export);
  add!("globalRestoreVersion", global_restore_version_export);
  add!("globalDocAccess", global_doc_access_export);
  add!("globalValidate", global_validate_export);
  add!("login", login_export);
  add!("logout", logout_export);
  add!("me", me_export);
  add!("refresh", refresh_export);
  add!("forgotPassword", forgot_password_export);
  add!("resetPassword", reset_password_export);
  add!("registerFirstUser", register_first_user_export);
  add!("unlock", unlock_export);
  add!("verifyEmail", verify_email_export);
  add!("access", access_export);
  add!("auth", auth_export);
  add!("authInit", auth_init_export);
  Ok(o)
}

/// Entry for addons: `env` is the env of the current napi call.
///
/// # Safety
/// Must be called on the JS thread from inside a napi callback.
pub unsafe fn create_binding(env: sys::napi_env) -> sys::napi_value {
  js::set_env(env);
  match create() {
    Ok(v) => v.0,
    Err(Thrown(e)) => {
      js::throw(e.get());
      ptr::null_mut()
    }
  }
}
