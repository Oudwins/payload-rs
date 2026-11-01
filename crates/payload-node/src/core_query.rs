//! Exposes the live query validation port (crates/payload-core-query `live`) as
//! `coreQueryBinding()`. It shares the core runtime of `coreRuntimeBinding()` (executor and host).

use napi::bindgen_prelude::{Env, Result, Unknown};
use napi_derive::napi;

#[napi]
pub fn core_query_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_core_query::live::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}
