//! `payload-node` module (included from crates/payload-node/src/lib.rs with `#[path]`): exposes the
//! live transform ports (crates/payload-mongo-live-transform) as `mongoLiveTransformBinding()`.

use napi::bindgen_prelude::{Env, Result, Unknown};
use napi_derive::napi;

#[napi]
pub fn mongo_live_transform_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_mongo_live_transform::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}
