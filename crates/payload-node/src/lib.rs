use napi_derive::napi;

mod core_query;
mod hooks_before_validate;
mod hooks_after_change;
mod hooks_before_change;
mod ops;
mod engine;
mod runtime;
mod schema;
mod sqlite;
mod validate;

#[napi]
pub fn version() -> String {
  payload_engine::version().to_string()
}
