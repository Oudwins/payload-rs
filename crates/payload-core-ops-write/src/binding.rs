//! The JS-facing binding object, exposed by `payload-node` as `coreOpsWriteBinding()`
//! (crates/payload-node/src/ops_write.rs) and wrapped by `packages/engine-rs/src/ops-write`. It
//! shares the core runtime's and the read operations' thread-local state, so `coreRuntimeBinding()`
//! and `coreOpsBinding()` must be initialized first (`getCoreOps()`).

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Thrown};

use crate::{create, delete, delete_by_id, duplicate, host, restore_version, update, update_by_id, update_document, validate};

type Body<const N: usize> = fn([Local; N]) -> JsResult<Local>;

/// Runs an exported function body: sets the env, converts `Err(Thrown)` into a JS throw and never
/// lets a panic cross the FFI boundary.
fn run<const N: usize>(env: sys::napi_env, info: sys::napi_callback_info, body: Body<N>) -> sys::napi_value {
  js::set_env(env);
  let (args, _) = js::callback_args::<N>(env, info);
  match catch_unwind(AssertUnwindSafe(|| body(args))) {
    Ok(Ok(v)) => v.0,
    Ok(Err(Thrown(e))) => {
      js::throw(e.get());
      ptr::null_mut()
    }
    Err(_) => {
      let Thrown(e) = js::engine_error("payload core write operations panicked");
      js::throw(e.get());
      ptr::null_mut()
    }
  }
}

macro_rules! export {
  ($name:ident, $n:literal, $body:expr) => {
    unsafe extern "C" fn $name(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
      run::<$n>(env, info, $body)
    }
  };
}

export!(init, 1, |[host_obj]| {
  host::install(host_obj)?;
  Ok(js::undefined())
});

export!(create_export, 1, |[args]| create::create(args));
export!(update_export, 1, |[args]| update::update(args));
export!(update_by_id_export, 1, |[args]| update_by_id::update_by_id(args));
export!(update_document_export, 1, |[args]| update_document::update_document(args));
export!(delete_export, 1, |[args]| delete::delete(args));
export!(delete_by_id_export, 1, |[args]| delete_by_id::delete_by_id(args));
export!(duplicate_export, 1, |[args]| duplicate::duplicate(args));
export!(restore_version_export, 1, |[args]| restore_version::restore_version(args));
export!(validate_export, 1, |[args]| validate::validate(args));
export!(stats_export, 0, |[]| {
  // `stats` calls are not engine work
  payload_core_runtime::js::uncount_entry();
  Ok(js::number(host::calls() as f64))
});

/// Version of the binding / host-helper contract with `packages/engine-rs/src/ops-write`.
pub const API_VERSION: u32 = 1;

/// Builds the binding object.
pub fn create() -> JsResult<Local> {
  let o = js::object();
  macro_rules! add {
    ($js:literal, $f:ident) => {
      js::set_named(o, $js, js::create_function($js, $f, ptr::null_mut()))?;
    };
  }
  add!("init", init);
  add!("create", create_export);
  add!("update", update_export);
  add!("updateByID", update_by_id_export);
  add!("updateDocument", update_document_export);
  add!("delete", delete_export);
  add!("deleteByID", delete_by_id_export);
  add!("duplicate", duplicate_export);
  add!("restoreVersion", restore_version_export);
  add!("validate", validate_export);
  add!("stats", stats_export);
  // The host helper set this build expects (packages/engine-rs/src/ops-write/index.ts checks it).
  js::set_named(o, "apiVersion", js::number(f64::from(API_VERSION)))?;
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
