//! Standalone addon exposing the core runtime, the core query, the Mongo live and the Mongo live
//! query bindings (the same exports as `payload-node`), so the query port can be built and tested
//! without the rest of `payload-node`. Load it via `PAYLOAD_ENGINE_ADDON`.

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

#[napi]
pub fn mongo_live_query_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_mongo_live_query::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}
