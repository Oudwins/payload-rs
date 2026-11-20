//! Exposes the live Mongo query port (crates/payload-mongo-live-query) as `mongoLiveQueryBinding()`.
//! Compiled into payload-node (`#[path]` module); runs on the core runtime (initialize
//! `coreRuntimeBinding()` first).

use napi::bindgen_prelude::{Env, Result, Unknown};
use napi_derive::napi;

#[napi]
pub fn mongo_live_query_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_mongo_live_query::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}
