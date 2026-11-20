//! Exposes the live-object MongoDB engine (crates/payload-mongo-live: shared live helpers and the
//! read data methods) as `mongoLiveBinding()`. The binding object is built with raw Node-API by
//! that crate and runs on the core runtime (initialize `coreRuntimeBinding()` and
//! `coreQueryBinding()` first). The other Mongo live crates register their ports of the db-mongodb
//! functions the reads call here (`payload_mongo_live::deps::register_*`); until one is registered
//! the reads call upstream's TS function.

use napi::bindgen_prelude::{Env, Result, Unknown};
use napi_derive::napi;

#[napi]
pub fn mongo_live_binding(env: Env) -> Result<Unknown<'static>> {
  register_ports();
  let raw = unsafe { payload_mongo_live::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}

/// Ports registered with the reads' dependency table whose crates do not register themselves
/// (payload-mongo-live-transform and -joins register from their bindings' `init`). The query port
/// needs its binding initialized with its host: `getMongoLive()` (packages/engine-rs/src/mongo-live)
/// does that right after creating this binding.
fn register_ports() {
  use payload_mongo_live::deps;
  deps::register_build_query(payload_mongo_live_query::deps::build_query);
  deps::register_build_sort_param(payload_mongo_live_query::deps::build_sort_param);
  deps::register_build_projection_from_select(payload_mongo_live_query::deps::build_projection_from_select);
}
