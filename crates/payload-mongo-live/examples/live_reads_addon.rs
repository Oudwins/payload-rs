//! Standalone addon exposing the core runtime, the live query binding and the Mongo live binding
//! (the same exports as `payload-node`), so the live reads can be built and tested without the rest
//! of `payload-node`. Load it via `PAYLOAD_ENGINE_ADDON` (packages/engine-rs/src/runtime, query and
//! mongo-live load their bindings from it).

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub fn core_runtime_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_core_runtime::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}

#[napi]
pub fn core_query_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_core_query::live::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}

#[napi]
pub fn mongo_live_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_mongo_live::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}
