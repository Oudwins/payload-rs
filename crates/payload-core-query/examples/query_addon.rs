//! Standalone addon exposing the core runtime and the live query binding, so the query port can
//! be built and tested without the rest of `payload-node`. Load it via
//! `PAYLOAD_CORE_RUNTIME_ADDON` (test/__rs/core-query/glue.ts loads `coreQueryBinding()` from it).

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
