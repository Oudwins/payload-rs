//! Node-API binding of the fused MongoDB writes (crates/payload-fuse-write,
//! packages/engine-rs/FUSED_WRITES.md).

use napi::bindgen_prelude::*;
use napi_derive::napi;

use payload_fuse_mongo::MongoReads;
use payload_fuse_write::{ResultRead, decode_statements, exec};

type Resolver = Box<dyn FnOnce(Env) -> Result<String> + Send>;

/// `fuseWriteMongo(client, txn, statements, plan?, requestJson?, reads?)`: runs the statements of
/// one fused write in the Rust-owned transaction `txn` (`mongoDriverTxnBegin`), the result's
/// fused `findByID` request on the stored document, and the commit. Resolves with the result text,
/// `!<reason>` (aborted, nothing committed: run the exact lane) or `!!<error JSON>` (the commit
/// failed). Never rejects.
#[napi]
pub fn fuse_write_mongo<'env>(
  env: &'env Env,
  client: u32,
  txn: u32,
  statements: BufferSlice,
  plan: Option<u32>,
  request_json: Option<String>,
  reads: Option<BufferSlice>,
) -> Result<Object<'env>> {
  let statements = decode_statements(&statements);
  let read = match (plan, request_json, reads) {
    (Some(plan), Some(request_json), Some(reads)) => Some(MongoReads::decode(&reads).map(|reads| ResultRead { plan, reads, request_json })),
    _ => None,
  };
  let (deferred, promise) = env.create_deferred::<String, Resolver>()?;
  payload_mongo_driver::runtime().spawn(async move {
    let text = match (statements, read) {
      (Ok(statements), None) => exec(client, txn, statements, None).await,
      (Ok(statements), Some(Ok(read))) => exec(client, txn, statements, Some(read)).await,
      (Err(_), _) | (_, Some(Err(_))) => {
        let _ = payload_mongo_driver::txn_end(txn, false).await;
        "!fuse-write:args".to_string()
      }
    };
    deferred.resolve(Box::new(move |_| Ok(text)));
  });
  Ok(promise)
}
