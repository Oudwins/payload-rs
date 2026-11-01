//! Exposes the beforeChange binding (crates/payload-core-hooks-change) as
//! `hooksBeforeChangeBinding()`. It shares the core runtime's executor and host, so it must be
//! loaded from the same addon as `coreRuntimeBinding()`; see RUST_CORE_DESIGN.md.

use napi::bindgen_prelude::{Env, Result, Unknown};
use napi_derive::napi;

#[napi]
pub fn hooks_before_change_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_core_hooks_change::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}
