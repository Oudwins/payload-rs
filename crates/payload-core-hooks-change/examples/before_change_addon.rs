//! Standalone addon exposing the core runtime binding and the beforeChange binding (the same two
//! exports `payload-node` has), so the port can be built and tested without the rest of
//! `payload-node`. Load it via `PAYLOAD_CORE_RUNTIME_ADDON`.

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub fn core_runtime_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_core_runtime::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}

#[napi]
pub fn hooks_before_change_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_core_hooks_change::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}
