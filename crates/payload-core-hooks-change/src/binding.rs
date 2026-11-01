//! The JS-facing binding object, exposed as `hooksBeforeChangeBinding()` by `payload-node` (and
//! the `before_change_addon` example). `packages/engine-rs/src/runtime/beforeChange` wraps it.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Thrown};

use crate::{before_change, host};

type Body<const N: usize> = fn([Local; N]) -> JsResult<Local>;

/// Runs an exported function body: sets the env, converts `Err(Thrown)` into a JS throw and
/// never lets a panic cross the FFI boundary.
fn run<const N: usize>(env: sys::napi_env, info: sys::napi_callback_info, body: Body<N>) -> sys::napi_value {
  js::set_env(env);
  payload_core_runtime::executor::count_entry();
  let (args, _) = js::callback_args::<N>(env, info);
  match catch_unwind(AssertUnwindSafe(|| body(args))) {
    Ok(Ok(v)) => v.0,
    Ok(Err(Thrown(e))) => {
      js::throw(e.get());
      ptr::null_mut()
    }
    Err(_) => {
      let Thrown(e) = js::engine_error("payload beforeChange engine panicked");
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

export!(before_change_export, 1, |[args]| before_change::before_change(args));

export!(before_change_traverse_fields_export, 1, |[destructured]| before_change::traverse_fields_entry(destructured));

export!(run_merge_locale_action, 1, |[state]| {
  before_change::run_merge_locale_action(state)?;
  Ok(js::undefined())
});

/// Builds the binding object.
pub fn create() -> JsResult<Local> {
  let o = js::object();
  js::set_named(o, "init", js::create_function("init", init, ptr::null_mut()))?;
  js::set_named(o, "beforeChange", js::create_function("beforeChange", before_change_export, ptr::null_mut()))?;
  js::set_named(
    o,
    "beforeChangeTraverseFields",
    js::create_function("beforeChangeTraverseFields", before_change_traverse_fields_export, ptr::null_mut()),
  )?;
  js::set_named(
    o,
    "runMergeLocaleAction",
    js::create_function("runMergeLocaleAction", run_merge_locale_action, ptr::null_mut()),
  )?;
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
