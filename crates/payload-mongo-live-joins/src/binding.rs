//! The JS-facing binding object (`mongoLiveJoinsBinding()` of the main addon,
//! crates/payload-node/src/mongo_live_joins.rs). The core runtime must be initialized first
//! (`getCoreRuntime()` installs the await helper).

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Thrown};

use crate::{build_join_aggregation, deps, resolve_joins};

/// Version of the binding contract (`init(deps)`, `buildJoinAggregation`, `resolveJoins`).
pub const API_VERSION: u32 = 1;

type Body<const N: usize> = fn([Local; N]) -> JsResult<Local>;

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
      let Thrown(e) = js::engine_error("payload mongo live joins panicked");
      js::throw(e.get());
      ptr::null_mut()
    }
  }
}

/// `Promise.reject(error)`: an upstream `async` function never throws synchronously.
fn rejected(error: Local) -> JsResult<Local> {
  let (deferred, promise) = js::create_promise()?;
  js::reject_deferred(deferred, error);
  Ok(promise)
}

macro_rules! export {
  ($name:ident, $n:literal, $body:expr) => {
    unsafe extern "C" fn $name(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
      run::<$n>(env, info, $body)
    }
  };
}

macro_rules! export_async {
  ($name:ident, $f:path) => {
    export!($name, 1, |[args]| match $f(args) {
      Ok(p) => Ok(p),
      Err(Thrown(e)) => rejected(e.get()),
    });
  };
}

// init(deps): installs payload's helpers and registers the ports with the live reads
export!(init, 1, |[deps_obj]| {
  deps::install(deps_obj)?;
  payload_mongo_live::deps::register_build_join_aggregation(crate::build_join_aggregation_native);
  payload_mongo_live::deps::register_resolve_joins(crate::resolve_joins_native);
  Ok(js::undefined())
});
export_async!(build_join_aggregation_export, build_join_aggregation::build_join_aggregation);
export_async!(resolve_joins_export, resolve_joins::resolve_joins);

pub fn create() -> JsResult<Local> {
  let o = js::object();
  macro_rules! add {
    ($js:literal, $f:ident) => {
      js::set_named(o, $js, js::create_function($js, $f, ptr::null_mut()))?;
    };
  }
  add!("init", init);
  add!("buildJoinAggregation", build_join_aggregation_export);
  add!("resolveJoins", resolve_joins_export);
  js::set_named(o, "apiVersion", js::number(f64::from(API_VERSION)))?;
  Ok(o)
}

/// Entry for addons.
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
