//! `mongoLiveSchemaBinding()` of the main addon (crates/payload-mongo-schema/node/mod.rs): `init(adapter,
//! deps)` = upstream `init.call(adapter)`, returning the promise of the async method. Wrapped by
//! packages/engine-rs/src/mongo-adapter/init.ts; needs the core runtime initialized first.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Thrown};

use super::init;

/// Version of the binding contract (`init(adapter, deps)`).
pub const API_VERSION: u32 = 1;

unsafe extern "C" fn init_export(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
  js::set_env(env);
  let ([adapter, deps], _) = js::callback_args::<2>(env, info);
  let result = catch_unwind(AssertUnwindSafe(|| -> JsResult<Local> {
    match init::init(adapter, deps) {
      Ok(p) => Ok(p),
      // an async method never throws synchronously
      Err(Thrown(e)) => {
        let (deferred, promise) = js::create_promise()?;
        js::reject_deferred(deferred, e.get());
        Ok(promise)
      }
    }
  }));
  match result {
    Ok(Ok(v)) => v.0,
    Ok(Err(Thrown(e))) => {
      js::throw(e.get());
      ptr::null_mut()
    }
    Err(_) => {
      let Thrown(e) = js::engine_error("payload mongo live schema panicked");
      js::throw(e.get());
      ptr::null_mut()
    }
  }
}

pub fn create() -> JsResult<Local> {
  let o = js::object();
  js::set_named(o, "init", js::create_function("init", init_export, ptr::null_mut()))?;
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
