//! The write-side steps of a fused write on Rust values (packages/engine-rs/FUSED_WRITES.md
//! section 12): upstream's `beforeValidate`, `beforeChange` (default validators, Payload's own
//! hooks), the operation's own steps, db-mongodb's write transform and mongoose's casting, from a
//! [`WritePlan`]. No Node-API, no JS, no I/O.

mod before_change;
mod before_validate;
mod exec;
mod heap;
mod mongoose;
mod ops;
pub mod plan;
mod read;
mod run;
mod text;
mod transform;

use std::time::{SystemTime, UNIX_EPOCH};

use payload_core_validate::Translate;
use payload_engine::js::JsVal;
use payload_mongo_driver::mongodb::bson::{Document, oid::ObjectId};

pub use ops::{prepare_create, prepare_update};
pub use plan::{WritePlan, register_write_plan, write_plan};
pub use text::prepare_json;

/// Not modelled for this input: run the exact lane with the untouched arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bail(pub String);

impl Bail {
  pub fn new(reason: impl Into<String>) -> Bail {
    Bail(reason.into())
  }
}

/// What a nondeterministic reading is for (12.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdUse {
  /// A row id (`baseIDField`: bson-objectid's `new ObjectId().toHexString()`).
  Row,
  /// The main document's `_id` (mongoose's `auto` default).
  Document,
  /// The version document's `_id`.
  Version,
}

/// The clock and ObjectId readings upstream takes (12.3).
pub trait Entropy {
  /// One upstream `new Date()` (ms since the epoch).
  fn now(&mut self) -> Result<f64, Bail>;
  /// One upstream `new ObjectId()`.
  fn object_id(&mut self, used_for: IdUse) -> Result<[u8; 12], Bail>;
}

/// The live lane's readings: the system clock and new ObjectIds.
pub struct SystemEntropy;

impl Entropy for SystemEntropy {
  fn now(&mut self) -> Result<f64, Bail> {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| Bail::new("clock"))?;
    Ok(elapsed.as_millis() as f64)
  }

  fn object_id(&mut self, _used_for: IdUse) -> Result<[u8; 12], Bail> {
    Ok(ObjectId::new().bytes())
  }
}

/// Replays recorded readings in order (the shadow, the differential corpus); bails when a
/// reading is missing or of another kind.
#[derive(Clone, Debug, Default)]
pub struct RecordedEntropy {
  pub clock: std::collections::VecDeque<f64>,
  pub ids: std::collections::VecDeque<(IdUse, [u8; 12])>,
}

impl Entropy for RecordedEntropy {
  fn now(&mut self) -> Result<f64, Bail> {
    self.clock.pop_front().ok_or_else(|| Bail::new("entropy:clock"))
  }

  fn object_id(&mut self, used_for: IdUse) -> Result<[u8; 12], Bail> {
    match self.ids.pop_front() {
      Some((recorded, bytes)) if recorded == used_for => Ok(bytes),
      _ => Err(Bail::new("entropy:objectId")),
    }
  }
}

/// The request-derived inputs of one call (12.2).
pub struct WriteCtx<'a> {
  /// `req.user` as authorship reads it: `Some((user.collection, user.id))` when both are set.
  pub user: Option<(String, JsVal)>,
  pub override_access: bool,
  /// `req.context` at the start of the operation.
  pub context: &'a JsVal,
  /// `req.t`: only used to build a validation error (`None`: every validation failure bails).
  pub t: Option<&'a dyn Translate>,
  /// `req.i18n.language` / `fallbackLanguage` (labels of validation errors).
  pub language: &'a str,
  pub fallback_language: &'a [String],
  pub entropy: &'a mut dyn Entropy,
}

/// The input of `prepare_update` from the operation's first statement (12.4).
pub struct UpdateInput {
  /// The stored document as the find returned it.
  pub stored: Document,
  /// `docWithLocales`: `stored` after db-mongodb's read transform.
  pub doc_with_locales: JsVal,
  /// `originalDoc`: `afterRead` (depth 0) of a deep copy of `docWithLocales`.
  pub original_doc: JsVal,
}

/// The outcome of a prepare call (12.4).
#[derive(Debug)]
pub struct Prepared {
  /// create: the caller's `data` after `beforeValidate` (upstream mutates it in place).
  pub caller_data: Option<JsVal>,
  /// `req.context` keys upstream sets, in order, with their final values.
  pub context_writes: Vec<(String, JsVal)>,
  pub outcome: Result<PreparedWrite, Invalid>,
}

#[derive(Debug)]
pub struct PreparedWrite {
  /// create: `documents[0]` of the insert; update: the `update` of the findAndModify.
  pub doc: Document,
  /// update: the document the findAndModify returns.
  pub stored_after: Option<Document>,
  pub version: Option<VersionWrite>,
}

#[derive(Debug)]
pub struct VersionWrite {
  /// `documents[0]` of `insert _<slug>_versions`.
  pub doc: Document,
  /// The latest-flip `updateMany`'s filter and update.
  pub flip_filter: Document,
  pub flip_update: Document,
}

/// The `ValidationError` upstream throws from `beforeChange`.
#[derive(Clone, Debug)]
pub struct Invalid {
  pub collection: String,
  pub id: Option<JsVal>,
  pub errors: Vec<FieldError>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldError {
  pub label: String,
  pub message: String,
  pub path: String,
}
