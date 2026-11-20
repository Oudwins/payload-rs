//! The JS-facing binding object, exposed by `payload-node` as `mongoLiveQueryBinding()`
//! (crates/payload-mongo-live-query/node/binding.rs). It shares the core runtime's thread-local
//! executor, so the core runtime's `init` must have run first (`getCoreRuntime()`); `init(host)`
//! installs this crate's helpers (test/__rs/mongo-live-query/glue.ts builds them).
//!
//! Every export takes the single object argument of the upstream function and destructures it like
//! the TS (async ones inside their task, so destructuring errors reject).

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Thrown};

use crate::{host, projection, query, sort};

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
      let Thrown(e) = js::engine_error("payload mongo live query panicked");
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
  // `getBuildQueryPlugin` (upstream's JS functions) awaiting this binding's `parseParams`
  query::install_build_query_plugin(js::create_function("parseParams", parse_params, ptr::null_mut()))?;
  Ok(js::undefined())
});
export!(build_query, 1, |[args]| query::build_query_entry(args));
export!(parse_params, 1, |[args]| query::parse_params_entry(args));
export!(build_and_or_conditions, 1, |[args]| query::build_and_or_conditions_entry(args));
export!(build_search_param, 1, |[args]| query::build_search_param_entry(args));
export!(sanitize_query_value, 1, |[args]| query::sanitize_query_value_entry(args));
export!(get_build_query_plugin, 1, |[args]| query::get_build_query_plugin(args));
export!(build_sort_param, 1, |[args]| sort::build_sort_param_entry(args));
export!(get_localized_sort_property, 1, |[args]| sort::get_localized_sort_property_entry(args));
export!(build_projection_from_select, 1, |[args]| projection::build_projection_from_select_entry(args));

/// Version of the host-helper contract with the TS glue (checked at load).
pub const API_VERSION: u32 = 2;

pub fn create() -> JsResult<Local> {
  let o = js::object();
  macro_rules! add {
    ($js:literal, $f:ident) => {
      js::set_named(o, $js, js::create_function($js, $f, ptr::null_mut()))?;
    };
  }
  add!("init", init);
  add!("buildQuery", build_query);
  add!("parseParams", parse_params);
  add!("buildAndOrConditions", build_and_or_conditions);
  add!("buildSearchParam", build_search_param);
  add!("sanitizeQueryValue", sanitize_query_value);
  add!("getBuildQueryPlugin", get_build_query_plugin);
  add!("buildSortParam", build_sort_param);
  add!("getLocalizedSortProperty", get_localized_sort_property);
  add!("buildProjectionFromSelect", build_projection_from_select);
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
