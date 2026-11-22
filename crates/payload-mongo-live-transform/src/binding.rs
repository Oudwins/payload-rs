//! The JS-facing binding object, exposed by `payload-node` as `mongoLiveTransformBinding()`
//! (crates/payload-mongo-live-transform/node/mod.rs): `{ init, transform, handleError,
//! getCollection, getGlobal, getDBName, isObjectID }`, each taking the TS function's argument
//! object (read in the TS destructuring order). Rust callers use the crate API directly.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Thrown};

use crate::live::{self, call};
use crate::{transform, utilities};

type Body<const N: usize> = fn([Local; N]) -> JsResult<Local>;

fn run<const N: usize>(env: sys::napi_env, info: sys::napi_callback_info, body: Body<N>) -> sys::napi_value {
  js::set_env(env);
  let (args, _) = js::callback_args::<N>(env, info);
  match catch_unwind(AssertUnwindSafe(|| body(args))) {
    Ok(Ok(v)) => v.0,
    Ok(Err(Thrown(e))) => {
      // release the engine's reference (a primitive's slot) before the exception is pending:
      // slot cleanup calls into JS, which a pending exception would abort
      let value = e.get();
      drop(e);
      js::throw(value);
      ptr::null_mut()
    }
    Err(_) => {
      let Thrown(e) = js::engine_error("payload-mongo-live-transform panicked");
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

export!(init, 1, |[deps]| {
  live::install(deps)?;
  // the live engine's `deps::transform` runs this port from now on, unless `deps.register === false`
  let register = js::get_named(deps, "register")?;
  if !(js::type_of(register) == js::Type::Boolean && !js::get_bool(register)) {
    crate::register::register();
  }
  Ok(js::undefined())
});

export!(transform_export, 1, |[args]| transform::transform(&transform::TransformArgs::from_object(args)?));

// the live engine's entry (fast.js, register.rs) with the TS args object, for the differentials
export!(fast_transform_export, 1, |[args]| {
  let a = transform::TransformArgs::from_object(args)?;
  let fast = live::fast_transform()?;
  js::call(
    fast.get(),
    js::undefined(),
    &[
      a.add_to_set,
      a.inc,
      a.pull,
      a.push,
      a.adapter,
      a.data,
      a.fields,
      a.global_slug,
      a.operation,
      a.parent_is_localized,
      a.validate_relationships,
    ],
  )
});

// every export destructures its argument with the TS parameter pattern (helpers.js), so missing /
// null arguments throw V8's destructuring TypeErrors and defaults apply like upstream

export!(fast_stats_export, 0, |[]| live::fast_stats());

export!(handle_error_export, 1, |[args]| {
  let h = live::helpers()?;
  let [collection, error, global, req] = live::elements::<4>(call(&h.destructure_handle_error, &[args])?)?;
  Err(utilities::handle_error(collection, error, global, req))
});

export!(get_collection_export, 1, |[args]| {
  let h = live::helpers()?;
  let [adapter, slug, versions] = live::elements::<3>(call(&h.destructure_get_collection, &[args])?)?;
  utilities::get_collection(adapter, slug, versions)?.to_object()
});

export!(get_global_export, 1, |[args]| {
  let h = live::helpers()?;
  let [adapter, slug, versions] = live::elements::<3>(call(&h.destructure_get_global, &[args])?)?;
  utilities::get_global(adapter, slug, versions)?.to_object()
});

export!(get_db_name_export, 1, |[args]| {
  let h = live::helpers()?;
  // `({ config: { name, slug }, config, target = 'dbName', versions = false })`
  let [name, slug, config, target, versions] = live::elements::<5>(call(&h.destructure_get_db_name, &[args])?)?;
  utilities::get_db_name_destructured(name, slug, config, target, versions)
});

export!(is_object_id_export, 1, |[value]| Ok(js::boolean(live::is_object_id(value)?)));

/// Builds the binding object.
pub fn create() -> JsResult<Local> {
  let o = js::object();
  let add = |name: &str, f: unsafe extern "C" fn(sys::napi_env, sys::napi_callback_info) -> sys::napi_value| {
    js::set_named(o, name, js::create_function(name, f, ptr::null_mut()))
  };
  add("init", init)?;
  add("transform", transform_export)?;
  add("fastTransform", fast_transform_export)?;
  add("fastTransformStats", fast_stats_export)?;
  add("handleError", handle_error_export)?;
  add("getCollection", get_collection_export)?;
  add("getGlobal", get_global_export)?;
  add("getDBName", get_db_name_export)?;
  add("isObjectID", is_object_id_export)?;
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
