//! Node-API binding of the fused MongoDB writes (crates/payload-fuse-write,
//! packages/engine-rs/FUSED_WRITES.md).

use napi::bindgen_prelude::*;
use napi_derive::napi;

use payload_fuse_mongo::MongoReads;
use payload_fuse_write::{ResultRead, decode_statements, exec};

type Resolver = Box<dyn FnOnce(Env) -> Result<String> + Send>;
type ListResolver = Box<dyn FnOnce(Env) -> Result<Vec<String>> + Send>;

/// `fuseWriteMongoOp(client, txn, op, plan?, requestJson?, reads?, state?)`: one fused write
/// operation (crates/payload-fuse-write `ops`: the request names the operation and carries its
/// prepared documents, or the Rust prepare's input), its result read and the commit in the
/// Rust-owned transaction `txn`. Resolves with `[text]` (`text` as for `fuseWriteMongo`); with
/// `state` (the write lane-shadow's reads, `{ d?, r: [{ c, f, s? }] }`) with `[text, stateJson]`:
/// the touched collections read inside the transaction, which is then aborted. `updateByID` /
/// `deleteByID` (crates/payload-fuse-write `by_id`, which need the result read) resolve with
/// `[text, stateJson | '', contextWritesJson | '']`, as do `updateMany` / `deleteMany`
/// (crates/payload-fuse-write `bulk`, after `fuseWriteMongoFind` on the same transaction; `text`
/// is the `find` page of the results), and creates whose Rust prepare runs here (`wp`, see
/// crates/payload-fuse-write `ops::decode`) with `[text, stateJson | '', contextWritesJson | '',
/// callerDataJson | '']`. Never rejects.
#[napi]
#[allow(clippy::too_many_arguments)]
pub fn fuse_write_mongo_op<'env>(
  env: &'env Env,
  client: u32,
  txn: u32,
  op: BufferSlice,
  plan: Option<u32>,
  request_json: Option<String>,
  reads: Option<BufferSlice>,
  state: Option<BufferSlice>,
) -> Result<Object<'env>> {
  // decoded on the runtime: the JS thread only copies the bytes
  let (op, reads, state) = (op.to_vec(), reads.map(|reads| reads.to_vec()), state.map(|state| state.to_vec()));
  let (deferred, promise) = env.create_deferred::<Vec<String>, ListResolver>()?;
  payload_mongo_driver::runtime().spawn(async move {
    let raw = payload_mongo_driver::mongodb::bson::RawDocument::from_bytes(&op);
    let by_id = match raw {
      Ok(doc) if matches!(doc.get_str("op"), Ok("updateByID" | "deleteByID")) => Some(payload_fuse_write::by_id::decode(doc)),
      _ => None,
    };
    let bulk = match raw {
      Ok(doc) if matches!(doc.get_str("op"), Ok("updateMany" | "deleteMany")) => Some(payload_fuse_write::bulk::decode(doc)),
      _ => None,
    };
    let request = if by_id.is_some() || bulk.is_some() {
      Err("!byID".to_string())
    } else {
      payload_fuse_write::ops::decode(&op)
    };
    let read = match (plan, request_json, reads) {
      (Some(plan), Some(request_json), Some(reads)) => match MongoReads::decode(&reads) {
        Ok(reads) => Ok(Some(ResultRead { plan, reads, request_json })),
        Err(_) => Err(()),
      },
      _ => Ok(None),
    };
    let state = match state.map(|state| payload_fuse_write::state::decode_state_reads(&state)) {
      Some(Ok(state)) => Ok(Some(state)),
      Some(Err(_)) => Err(()),
      None => Ok(None),
    };
    let outcome = match (bulk, by_id, request, read, state) {
      (Some(Ok(request)), _, _, Ok(Some(read)), Ok(state)) => {
        let outcome = payload_fuse_write::bulk::exec(client, txn, request, read, state).await;
        vec![outcome.text, outcome.state.unwrap_or_default(), outcome.context.unwrap_or_default()]
      }
      (Some(request), ..) => {
        let _ = payload_mongo_driver::txn_end(txn, false).await;
        vec![match request {
          Err(reason) => format!("!{reason}"),
          Ok(_) => "!fuse-write:args".to_string(),
        }]
      }
      (None, Some(Ok(request)), _, Ok(Some(read)), Ok(state)) => {
        let outcome = payload_fuse_write::by_id::exec(client, txn, request, read, state).await;
        vec![outcome.text, outcome.state.unwrap_or_default(), outcome.context.unwrap_or_default()]
      }
      (None, Some(request), ..) => {
        let _ = payload_mongo_driver::txn_end(txn, false).await;
        vec![match request {
          Err(reason) => format!("!{reason}"),
          Ok(_) => "!fuse-write:args".to_string(),
        }]
      }
      (None, None, Ok(request), Ok(read), Ok(state)) => {
        let is_prepared_here = request.prepare.is_some();
        let payload_fuse_write::ops::CreateOutcome { outcome, caller_data } =
          payload_fuse_write::ops::exec(client, txn, request, read, state).await;
        if is_prepared_here {
          vec![outcome.text, outcome.state.unwrap_or_default(), outcome.context.unwrap_or_default(), caller_data.unwrap_or_default()]
        } else {
          match outcome.state {
            Some(state) => vec![outcome.text, state],
            None => vec![outcome.text],
          }
        }
      }
      (None, None, Err(reason), _, _) => {
        // a request the drivers do not model (e.g. the Rust prepare bailed): the exact lane
        let _ = payload_mongo_driver::txn_end(txn, false).await;
        vec![if reason.starts_with('!') { reason } else { format!("!{reason}") }]
      }
      _ => {
        let _ = payload_mongo_driver::txn_end(txn, false).await;
        vec!["!fuse-write:args".to_string()]
      }
    };
    deferred.resolve(Box::new(move |_| Ok(outcome)));
  });
  Ok(promise)
}

/// `fuseWriteMongoFind(client, txn, plan, requestJson, reads)`: the document read of a bulk fused
/// write (update-many / delete-many: `payload.db.find`, the `find` of `reads`) in the Rust-owned
/// transaction `txn` (crates/payload-fuse-write `bulk::find`). Resolves with `[idsJson, docsHex]`
/// (the documents' ids and their BSON for the operation request) or `[!reason]` (the transaction
/// is aborted). Never rejects.
#[napi]
pub fn fuse_write_mongo_find<'env>(
  env: &'env Env,
  client: u32,
  txn: u32,
  plan: u32,
  request_json: String,
  reads: BufferSlice,
) -> Result<Object<'env>> {
  let reads = reads.to_vec();
  let (deferred, promise) = env.create_deferred::<Vec<String>, ListResolver>()?;
  payload_mongo_driver::runtime().spawn(async move {
    let outcome = match MongoReads::decode(&reads) {
      Ok(reads) => payload_fuse_write::bulk::find(client, txn, &ResultRead { plan, reads, request_json }).await,
      Err(_) => {
        let _ = payload_mongo_driver::txn_end(txn, false).await;
        vec!["!fuse-write:args".to_string()]
      }
    };
    deferred.resolve(Box::new(move |_| Ok(outcome)));
  });
  Ok(promise)
}

/// `fuseWriteMongoState(client, state)`: the write lane-shadow's reads (`{ d?, r: [...] }`)
/// outside any transaction (the exact lane's side, after its commit), as canonical extended JSON
/// (crates/payload-fuse-write `state`). Resolves with `!<reason>` on a failure.
#[napi]
pub fn fuse_write_mongo_state<'env>(env: &'env Env, client: u32, state: BufferSlice) -> Result<Object<'env>> {
  let reads = payload_fuse_write::state::decode_state_reads(&state);
  let (deferred, promise) = env.create_deferred::<String, Resolver>()?;
  payload_mongo_driver::runtime().spawn(async move {
    let text = match reads {
      Ok((database, reads)) => payload_fuse_write::state::read_state(client, database.as_deref(), None, &reads)
        .await
        .unwrap_or_else(|error| format!("!state:{error}")),
      Err(error) => format!("!state:{error}"),
    };
    deferred.resolve(Box::new(move |_| Ok(text)));
  });
  Ok(promise)
}

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
