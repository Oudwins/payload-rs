//! `mongoLiveSchemaBinding()` of the main addon (compiled into crates/payload-node through a
//! `#[path]` module line): db-mongodb's `init` (model building) on the live engine
//! (crates/payload-mongo-schema `live`). Initialize `coreRuntimeBinding()` first.

use napi::bindgen_prelude::{Env, Result, Unknown};
use napi_derive::napi;

#[napi]
pub fn mongo_live_schema_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_mongo_schema::live::binding::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}
