pub mod bson;
pub mod error;
pub mod fields;
pub mod host;
pub mod js;
pub mod sql;
pub mod strings;

pub fn version() -> &'static str {
  env!("CARGO_PKG_VERSION")
}
