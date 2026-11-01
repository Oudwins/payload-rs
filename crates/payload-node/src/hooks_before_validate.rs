//! Exposes the beforeValidate traversal (crates/payload-core-hooks-validate) as
//! `hooksBeforeValidateBinding()`. It shares the core runtime of `coreRuntimeBinding()`.

use napi::bindgen_prelude::{Env, Result, Unknown};
use napi_derive::napi;

#[napi]
pub fn hooks_before_validate_binding(env: Env) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_core_hooks_validate::create_binding(env.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}
