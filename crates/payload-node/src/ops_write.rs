//! Exposes the collection write operation ports (crates/payload-core-ops-write) as
//! `coreOpsWriteBinding()`. The binding object is built with raw Node-API by that crate and runs
//! on the core runtime (initialize `coreRuntimeBinding()` and `coreOpsBinding()` first).

use napi::bindgen_prelude::{Env, Result, Unknown};
use napi_derive::napi;

#[napi]
pub fn core_ops_write_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_core_ops_write::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}
