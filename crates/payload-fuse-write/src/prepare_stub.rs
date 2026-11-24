//! STUB of WP-I's pure Rust prepare (FUSED_WRITES.md section 12, not landed yet): the same entry
//! points the operation drivers ([`crate::ops`]) call, always bailing. Replaced by WP-I's
//! `prepare_create` / `prepare_update` (beforeValidate, the default validators, beforeChange, the
//! db-mongodb write transform and mongoose's casting on Rust value trees).

use payload_mongo_driver::mongodb::bson::RawDocumentBuf;
use payload_mongo_driver::mongodb::bson::oid::ObjectId;

/// What the JS side read before the call, in upstream's order (src/fuse-write/ctx.ts).
pub struct WriteCtx {
  /// ISO clock readings, in upstream's order.
  pub clock: Vec<String>,
  /// ObjectIds generated the way upstream would, in upstream's order.
  pub ids: Vec<ObjectId>,
  pub user_json: Option<String>,
  pub locale: Option<String>,
}

/// A prepared write: the casted document as the main statement stores it, the version document
/// (`None`: the collection has no versions) and the result value before `afterRead`.
pub struct Prepared {
  pub doc: RawDocumentBuf,
  pub version: Option<RawDocumentBuf>,
}

pub struct Bail(pub String);

pub fn prepare_create(_plan: u32, _data_json: &str, _ctx: &WriteCtx) -> Result<Prepared, Bail> {
  Err(Bail("prepare:stub".to_string()))
}

pub fn prepare_update(
  _plan: u32,
  _data_json: &str,
  _original: &RawDocumentBuf,
  _ctx: &WriteCtx,
) -> Result<Prepared, Bail> {
  Err(Bail("prepare:stub".to_string()))
}
