//! Exposes the live write data methods of the MongoDB engine (crates/payload-mongo-live-write) as
//! `mongoLiveWriteBinding()`. The binding object is built with raw Node-API by that crate and runs
//! on the core runtime with payload-mongo-live's host (initialize `getMongoLive()` first: core
//! runtime, core query, `mongoLiveBinding().init(host)`). Each method takes the adapter as `this`.

use napi::bindgen_prelude::{Env, Result, Unknown};
use napi_derive::napi;

#[napi]
pub fn mongo_live_write_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_mongo_live_write::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}
