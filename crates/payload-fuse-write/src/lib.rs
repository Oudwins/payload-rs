//! Fused MongoDB writes (packages/engine-rs/FUSED_WRITES.md): the statements of one write
//! operation, in upstream's order, in a transaction the Rust client owns; then the operation's
//! `afterRead` (and population, its nested reads in the same transaction) on the document the
//! statements stored or changed, through the fused read core (crates/payload-fuse-mongo
//! `run_document`); then the commit. No JS runs between the statements.
//!
//! The statements arrive as the commands the Node driver would send (BSON as the TS side
//! serialized them, packages/engine-rs/src/fuse-write).

use payload_fuse_mongo::MongoReads;
use payload_mongo_driver::mongodb::bson::{Bson, RawBsonRef, RawDocumentBuf};
use payload_mongo_driver::{command_raw, txn_command_raw, txn_end};

/// Which document of a statement the operation's result is read from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResultOf {
  None,
  /// `insert`: the inserted document (`documents[0]`, the stored document).
  Inserted,
  /// `findAndModify`: the reply's `value` (after the update, or the removed document).
  Value,
}

pub struct Statement {
  pub database: Option<String>,
  pub command: RawDocumentBuf,
  /// Inside the operation's transaction; `false`: a statement upstream sends without a session.
  pub in_txn: bool,
  pub result: ResultOf,
}

/// The fused read of the operation's result.
pub struct ResultRead {
  pub plan: u32,
  pub reads: MongoReads,
  pub request_json: String,
}

/// Decodes `{ s: [{ c: <command>, t: <in txn>, r: 0 | 1 | 2, d?: <database> }] }`.
pub fn decode_statements(bytes: &[u8]) -> Result<Vec<Statement>, String> {
  let doc = payload_mongo_driver::mongodb::bson::RawDocument::from_bytes(bytes).map_err(|e| e.to_string())?;
  let list = doc.get_array("s").map_err(|e| e.to_string())?;
  let mut out = Vec::new();
  for item in list {
    let RawBsonRef::Document(item) = item.map_err(|e| e.to_string())? else {
      return Err("statement".to_string());
    };
    let command = item.get_document("c").map_err(|e| e.to_string())?.to_raw_document_buf();
    let in_txn = item.get_bool("t").map_err(|e| e.to_string())?;
    let result = match item.get_i32("r").map_err(|e| e.to_string())? {
      1 => ResultOf::Inserted,
      2 => ResultOf::Value,
      _ => ResultOf::None,
    };
    let database = item.get_str("d").ok().map(str::to_string);
    out.push(Statement { command, database, in_txn, result });
  }
  Ok(out)
}

/// Runs `statements` in order (in transaction `txn` where `in_txn`), then `read` on the result
/// document, then commits. Returns the read's result text (`null` without a read); `!<reason>`
/// when the call must run on the exact lane (nothing is committed: the transaction is aborted);
/// `!!<error JSON>` when the commit failed (its outcome is the error upstream throws).
pub async fn exec(client: u32, txn: u32, statements: Vec<Statement>, read: Option<ResultRead>) -> String {
  let mut result_doc: Option<RawDocumentBuf> = None;
  for statement in statements {
    let Statement { command, database, in_txn, result } = statement;
    let inserted = if result == ResultOf::Inserted { inserted_document(&command) } else { None };
    let reply =
      if in_txn { txn_command_raw(txn, database, command).await } else { command_raw(client, database, command).await };
    let reply = match reply {
      Ok(reply) => reply,
      Err(error) => return abort(txn, format!("!statement:{error}")).await,
    };
    if let Some(Bson::Array(errors)) = reply.get("writeErrors") {
      if !errors.is_empty() {
        return abort(txn, "!statement:writeErrors".to_string()).await;
      }
    }
    match result {
      ResultOf::None => {}
      ResultOf::Inserted => result_doc = inserted,
      ResultOf::Value => {
        result_doc = match reply.get("value") {
          Some(Bson::Document(value)) => match RawDocumentBuf::from_document(value) {
            Ok(raw) => Some(raw),
            Err(_) => return abort(txn, "!statement:value".to_string()).await,
          },
          _ => None,
        }
      }
    }
  }
  let text = match read {
    Some(ResultRead { plan, reads, request_json }) => {
      let text = payload_fuse_mongo::run_document(client, plan, &reads, result_doc, &request_json, Some(txn));
      if text.starts_with('!') {
        return abort(txn, text).await;
      }
      text
    }
    None => "null".to_string(),
  };
  match txn_end(txn, true).await {
    Ok(()) => text,
    Err(error) => format!("!!{error}"),
  }
}

fn inserted_document(command: &RawDocumentBuf) -> Option<RawDocumentBuf> {
  let documents = command.get_array("documents").ok()?;
  match documents.into_iter().next()?.ok()? {
    RawBsonRef::Document(doc) => Some(doc.to_raw_document_buf()),
    _ => None,
  }
}

async fn abort(txn: u32, reason: String) -> String {
  let _ = txn_end(txn, false).await;
  reason
}
