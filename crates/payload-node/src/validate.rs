//! Exposes Payload's default field validators on live JS values
//! (crates/payload-core-validate/live) as `validateBinding({ ObjectId, validateJSONSchema })`,
//! which returns the validators object (`packages/payload/src/fields/validations.ts` loads it
//! synchronously when `PAYLOAD_ENGINE=rs`).

use napi::bindgen_prelude::{Env, Result, Unknown};
use napi::JsValue;
use napi_derive::napi;

#[napi]
pub fn validate_binding(env: Env, deps: Unknown) -> Result<Unknown<'static>> {
  let raw = unsafe { payload_core_validate_live::create_binding(env.raw(), deps.raw()) };
  Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
}
