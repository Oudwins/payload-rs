//! Exposes the core runtime binding (crates/payload-core-runtime) as `coreRuntimeBinding()`.
//! The binding object is built with raw Node-API by the runtime crate; see RUST_CORE_DESIGN.md.

use napi::bindgen_prelude::{Env, Result, Unknown};
use napi_derive::napi;

#[napi]
pub fn core_runtime_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_core_runtime::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}
