//! Exposes the global and auth operation ports (crates/payload-core-ops-global) as
//! `coreOpsGlobalBinding()`. The binding object is built with raw Node-API by that crate and runs
//! on the core runtime and the collection operations' host (initialize `coreOpsBinding()` first).

use napi::bindgen_prelude::{Env, Result, Unknown};
use napi_derive::napi;

#[napi]
pub fn core_ops_global_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_core_ops_global::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}
