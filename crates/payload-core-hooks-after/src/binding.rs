//! The JS-facing binding object, exposed by `payload-node` as `coreHooksAfterBinding()`
//! (crates/payload-node/src/hooks_after_change.rs) and wrapped by
//! `packages/engine-rs/src/runtime/afterChange`. It shares the core runtime's thread-local state
//! (executor, runtime host), so the runtime's `init` must have run (`getCoreRuntime()`).

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Thrown};

use crate::{after_change, before_duplicate, host};

type Body<const N: usize> = fn([Local; N]) -> JsResult<Local>;

/// Runs an exported function body: sets the env, converts `Err(Thrown)` into a JS throw and
/// never lets a panic cross the FFI boundary.
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
      let Thrown(e) = js::engine_error("payload core hooks (afterChange/beforeDuplicate) panicked");
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

export!(after_change_export, 1, |[args]| after_change::after_change(args));

export!(before_duplicate_export, 1, |[args]| before_duplicate::before_duplicate(args));

export!(after_change_traverse_fields_export, 1, |[destructured]| after_change::traverse_fields_entry(destructured));

/// Builds the binding object `{ init, afterChange, beforeDuplicate }`.
pub fn create() -> JsResult<Local> {
  let o = js::object();
  js::set_named(o, "init", js::create_function("init", init, ptr::null_mut()))?;
  js::set_named(o, "afterChange", js::create_function("afterChange", after_change_export, ptr::null_mut()))?;
  js::set_named(
    o,
    "afterChangeTraverseFields",
    js::create_function("afterChangeTraverseFields", after_change_traverse_fields_export, ptr::null_mut()),
  )?;
  js::set_named(
    o,
    "beforeDuplicate",
    js::create_function("beforeDuplicate", before_duplicate_export, ptr::null_mut()),
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
