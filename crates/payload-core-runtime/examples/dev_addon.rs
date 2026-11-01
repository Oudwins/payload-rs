//! Standalone addon exposing only the core runtime binding, so the runtime can be built and
//! tested without the rest of `payload-node`. Load it via `PAYLOAD_CORE_RUNTIME_ADDON`.

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub fn core_runtime_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_core_runtime::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}
