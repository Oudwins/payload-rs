//! What the validators need from the request (`req`) and from JS.

use payload_engine::error::{EngineError, Result};
use payload_engine::js::JsVal;

use crate::i18n::Translate;
use crate::{ValidationResult, date};

/// The `req` parts the default validators read. Everything else on `options` is data.
pub struct Req<'a> {
  /// `req.payload.config` (the sanitized config).
  pub config: &'a JsVal,
  /// `req.payload.collections`: `{ [slug]: { config, customIDType } }`. `undefined` when the
  /// validator runs on the client.
  pub collections: &'a JsVal,
  /// `req.payload.db.defaultIDType`
  pub default_id_type: &'a JsVal,
  /// `req.t`
  pub t: &'a dyn Translate,
  pub host: &'a dyn ValidateHost,
}

/// A user `filterOptions` function call. The host builds the JS argument object in TS key
/// order and adds `req` (and `user: req.user` where TS passes it):
/// - `Blocks`: `{ id, data, req, siblingData, user }`
/// - `Relationship` (relationship and upload): `{ id, blockData, data, relationTo, req, siblingData, user }`
/// - `Select`: `{ data, options, req, siblingData }`
pub enum FilterOptionsCall<'a> {
  Blocks { id: &'a JsVal, data: &'a JsVal, sibling_data: &'a JsVal },
  Relationship { id: &'a JsVal, block_data: &'a JsVal, data: &'a JsVal, relation_to: &'a JsVal, sibling_data: &'a JsVal },
  Select { data: &'a JsVal, options: &'a JsVal, sibling_data: &'a JsVal },
}

/// `req.payloadDataLoader.find({ collection, depth: 0, disableErrors: true, limit: 0,
/// overrideAccess, pagination: false, req, where })`
pub struct FindArgs<'a> {
  pub collection: &'a JsVal,
  pub override_access: &'a JsVal,
  pub where_: &'a JsVal,
}

/// Callbacks into the JS runtime. TS awaits `filter_options` and `find`; a JS-backed host either
/// resolves the promises before returning or interrupts the run (see [`crate::replay`]).
pub trait ValidateHost {
  /// Calls the `filterOptions` function `func` (a `JsVal::Fn` handle) and returns its result.
  fn filter_options(&self, func: u32, call: FilterOptionsCall<'_>) -> Result<JsVal>;

  /// `req.payloadDataLoader.find(...)`: returns the paginated result object (`{ docs, ... }`).
  fn find(&self, args: FindArgs<'_>) -> Result<JsVal>;

  /// `req.payload.logger.error({ err, msg })`
  fn log_error(&self, msg: &str, err: &EngineError) -> Result<()>;

  /// `validateJSONSchema({ jsonSchema, value })` (zod `fromJSONSchema` on the server, a no-op
  /// in the browser build). Not ported: zod's messages can't be matched without porting zod.
  fn validate_json_schema(&self, json_schema: &JsVal, value: &JsVal) -> Result<ValidationResult>;

  /// `editor.validate(value, options)` of the field's rich text adapter; `options` is the
  /// validate options object without `req`.
  fn rich_text_validate(&self, editor: &JsVal, value: &JsVal, options: &JsVal) -> Result<ValidationResult>;

  /// `String(date)` / `date.toString()` of a valid `Date` (`Date.prototype.toString`, which
  /// prints the process time zone's display name, so only JS can produce it).
  fn date_to_string(&self, _ms: f64) -> Result<String> {
    Err(crate::js::unsupported_function("Date.prototype.toString"))
  }

  /// Converts a local time value to UTC for `Date.parse`, in the process time zone like V8.
  fn local_to_utc(&self, local_ms: i64) -> f64 {
    crate::tz::local_to_utc(local_ms)
  }

  /// Whether `err` is the host interrupting the run (not a JS exception). Validators propagate
  /// it through `try`/`catch` emulation instead of handling it.
  fn is_interrupt(&self, _err: &EngineError) -> bool {
    false
  }
}

/// Adapts a [`ValidateHost`] to [`date::LocalTz`].
pub(crate) struct HostTz<'a>(pub &'a dyn ValidateHost);

impl date::LocalTz for HostTz<'_> {
  fn local_to_utc(&self, local_ms: i64) -> f64 {
    self.0.local_to_utc(local_ms)
  }
}
