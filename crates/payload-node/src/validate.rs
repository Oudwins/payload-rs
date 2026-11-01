//! Exposes Payload's default field validators on live JS values
//! (crates/payload-core-validate/live) as `validateBinding()`. It shares the core runtime of
//! `coreRuntimeBinding()` (executor and property helpers), whose `init` must run first; the TS
//! glue in `packages/engine-rs/src/validate` does that.

use napi::bindgen_prelude::{Env, Result, Unknown};
use napi_derive::napi;

#[napi]
pub fn validate_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_core_validate_live::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}
