//! Node-API entry of the write-side library of the fused MongoDB writes
//! (crates/payload-fuse-write `prepare`, packages/engine-rs/FUSED_WRITES.md section 12).

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// `fuseWritePrepare(planJson, requestJson, stored?)`: runs `prepare_create` / `prepare_update`
/// on one JSON request (`crates/payload-fuse-write/src/prepare/text.rs` documents both texts);
/// `stored` is the stored document's BSON for updates.
#[napi]
pub fn fuse_write_prepare(plan_json: String, request_json: String, stored: Option<BufferSlice>) -> String {
  payload_fuse_write::prepare::prepare_json(&plan_json, &request_json, stored.as_deref())
}
