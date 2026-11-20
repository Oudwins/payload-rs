//! `mongoLiveJoinsBinding()` of the main addon (compiled into crates/payload-node through a
//! `#[path]` module line): the live ports of db-mongodb's `buildJoinAggregation` / `resolveJoins`
//! (crates/payload-mongo-live-joins). Its `init(deps)` also registers them in
//! `payload_mongo_live::deps`, so the live read methods call them. Initialize
//! `coreRuntimeBinding()` and `getMongoLive()` first.

use napi::bindgen_prelude::{Env, Result, Unknown};
use napi_derive::napi;

#[napi]
pub fn mongo_live_joins_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_mongo_live_joins::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}
