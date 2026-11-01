//! Standalone addon exposing the core runtime, the live query binding and the field hook
//! traversal bindings (the same exports as `payload-node`), so the core engine can be built and
//! tested without the rest of `payload-node`. Load it via `PAYLOAD_CORE_RUNTIME_ADDON`
//! (test/__rs/core-query/glue.ts and packages/engine-rs/src/runtime load their bindings from it).

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub fn core_runtime_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_core_runtime::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}

#[napi]
pub fn core_query_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_core_query::live::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}

#[napi]
pub fn hooks_before_validate_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_core_hooks_validate::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}

#[napi]
pub fn hooks_before_change_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_core_hooks_change::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}

#[napi]
pub fn core_hooks_after_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_core_hooks_after::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}
