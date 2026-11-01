//! Port of `packages/drizzle/src/transform/read` (drizzle rows -> Payload documents).
//! See RUST_PORT.md for ownership and porting rules.
//!
//! - [`transform::transform`]: `transform/read/index.ts` + `traverseFields.ts`,
//!   `relationship.ts`, `hasManyText.ts`, `hasManyNumber.ts`, and the
//!   `createPathMap` / `createBlocksMap` / `getArrayRelationName` /
//!   `resolveBlockTableName` utilities.
//! - [`value::Val`]: mutable JS values with reference semantics (the TS code
//!   mutates the drizzle rows and reuses them in the result); objects inherit
//!   `Object.prototype` like JS objects.
//! - [`jsstr::JsStr`]: JS strings, including lone UTF-16 surrogates.
//! - [`date`]: V8 `Date.parse` / `toISOString` in the process time zone
//!   (reusable by other crates).
//! - [`json`] / [`encoding`]: the JSON text encoding used across the TS
//!   boundary and by the golden fixtures in `test/__rs/read/fixtures`.

pub mod date;
pub mod dateparse;
pub mod encoding;
pub mod json;
pub mod jsops;
pub mod jsstr;
pub mod props;
pub mod transform;
pub mod value;

pub use transform::{ReadAdapter, TransformArgs, schema_block_index, transform};
pub use value::Val;

use payload_engine::error::Result;
use payload_engine::js::JsVal;

/// JSON text entry point: `data` (the drizzle row) and the returned document are
/// [`encoding`] JSON text as produced/read by `encodeTree` + `JSON.stringify` /
/// `JSON.parse` + `decodeTree` on the TS side (lone surrogates survive).
pub fn transform_json(
  adapter: &ReadAdapter<'_>,
  data: &str,
  fields: &JsVal,
  join_query: &JsVal,
  parent_is_localized: bool,
  table_name: &str,
) -> Result<String> {
  let result = transform(
    adapter,
    TransformArgs { data: encoding::decode_text(data)?, fields, join_query, parent_is_localized, table_name },
  )?;
  encoding::encode_text(&result)
}
