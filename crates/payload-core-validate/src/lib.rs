//! Port of `packages/payload/src/fields/validations.ts`: Payload's default field validators.
//!
//! Every validator takes the value, the validate `options` object exactly as TS builds it
//! (`{ ...field, id, blockData, collectionSlug, data, event, jsonError, operation,
//! overrideAccess, path, preferences, previousValue, siblingData }`, without `req`) and a
//! [`Req`] with the request parts the validators read (`req.payload.config`,
//! `req.payload.collections`, `req.payload.db.defaultIDType`, `req.t`) plus a [`ValidateHost`]
//! for the JS callbacks (`filterOptions`, `payloadDataLoader.find`, `logger.error`, the rich
//! text editor and JSON Schema validation).
//!
//! The result is TS's `true | string`; an `Err` is what the TS validator would throw.
//!
//! This crate works on [`JsVal`](payload_engine::js::JsVal) data snapshots, for Rust callers
//! that hold plain data. The validators the addon exposes to JS (`validateBinding()`) are the
//! live-value port in `live/` (`payload-core-validate-live`), which reads the caller's objects
//! after every await like TS and calls methods (`toString`, `ObjectId`) through JS; values a
//! snapshot can't evaluate (own `toString` / `toJSON` functions, `ObjectId` duck typing) are
//! unsupported-value errors here.

pub mod date;
pub mod host;
pub mod i18n;
pub mod js;
pub mod replay;
pub mod tz;
pub mod validations;

pub use host::{FilterOptionsCall, FindArgs, Req, ValidateHost};
pub use i18n::{I18n, Translate};
pub use validations::{
  BlocksFilterOptionsResult, Validator, array, blocks, blocks_invalid_block_slugs, blocks_prefix, checkbox, code, confirm_password, date as date_validator,
  email, json, number, password, point, radio, relationship, relationship_prefix, rich_text, select, slug, text, textarea, upload,
  username, validate, validate_blocks_filter_options, validate_filter_options,
};

/// `true | string`
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ValidationResult {
  Valid,
  Invalid(String),
}

impl ValidationResult {
  pub fn is_valid(&self) -> bool {
    matches!(self, ValidationResult::Valid)
  }
}
