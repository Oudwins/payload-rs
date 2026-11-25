//! The operation drivers of the bulk writes, update-many and delete-many (FUSED_WRITES.md section
//! 13), in two native calls on one Rust-owned transaction: [`find`] runs the operation's document
//! read (`payload.db.find`) in the transaction and hands the documents' ids to JS, which builds
//! the per-document statements' cast filters and update prepare requests (with their clock and
//! ObjectId readings) for exactly those documents; [`exec`] then runs the writes, the result's
//! `afterRead` / population and the commit, with no JS between them.
//!
//! update-many (collections/operations/update.ts): per document, in the find's order, what
//! updateByID runs after its stored read (`by_id::update_document`: `prepare_update`, the lock
//! check, `findAndModify`, the version statements, `enforceMaxVersions`' find). Upstream processes
//! the documents concurrently (`Promise.all`); owner decision D1 allows the sequential order, each
//! document's statements and effects are upstream's. The results' `afterRead` runs once over all
//! documents (one page), as the request dataloader shares population across upstream's concurrent
//! per-document `afterRead`s.
//!
//! delete-many (collections/operations/delete.ts `deleteDocumentsInBulk`): the lock check of every
//! document (`getLockedDocumentIds` / `deleteDocumentLocks`, no session), `deleteCollectionVersions`
//! (`parent in ids`), the documents' `deleteMany` (`id in ids`), the results' `afterRead` (one
//! page), `deleteUserPreferences` (`key in [...]`, sent for zero documents too), then the commit.

use payload_fuse_mongo::{find_stored_many, run_documents};
use payload_mongo_driver::mongodb::bson::{RawBsonRef, RawDocument, RawDocumentBuf};

use crate::by_id::{ByIDRequest, Lock, decode as decode_by_id, delete_command, lock_statements, update_document};
use crate::{Outcome, ResultRead, abort, finish, send, state::StateRead};

pub enum BulkRequest {
  /// One updateByID request per document (`op: 'updateByID'`), in the find's order.
  Update { docs: Vec<RawDocumentBuf>, entries: Vec<ByIDRequest> },
  Delete {
    database: Option<String>,
    collection: String,
    docs: Vec<RawDocumentBuf>,
    /// The cast `{ id: { in: ids } }`.
    query: RawDocumentBuf,
    lock: Option<Lock>,
    /// The versions collection and its cast `{ parent: { in: ids } }`.
    versions: Option<(String, RawDocumentBuf)>,
    /// The preferences collection and its cast key filter.
    preferences: Option<(String, RawDocumentBuf)>,
  },
}

/// The ids of `docs` (`_id` ObjectIds as lowercase hex, `None` for any other `_id`) as a JSON
/// array, and the documents' BSON as hex text of `{ d: [...] }` (what [`decode`] takes back).
fn ids_and_docs(docs: &[RawDocumentBuf]) -> Option<(String, String)> {
  let mut ids = Vec::with_capacity(docs.len());
  let mut array = payload_mongo_driver::mongodb::bson::RawArrayBuf::new();
  for doc in docs {
    ids.push(format!("\"{}\"", doc.get_object_id("_id").ok()?.to_hex()));
    array.push(doc.clone());
  }
  let mut holder = RawDocumentBuf::new();
  holder.append("d", array);
  let mut hex = String::with_capacity(holder.as_bytes().len() * 2);
  for byte in holder.as_bytes() {
    hex.push_str(&format!("{byte:02x}"));
  }
  Some((format!("[{}]", ids.join(",")), hex))
}

/// The bulk operation's document read in transaction `txn`: `[idsJson, docsHex]`, or `[!reason]`
/// (the transaction is then aborted).
pub async fn find(client: u32, txn: u32, read: &ResultRead) -> Vec<String> {
  let docs = match find_stored_many(client, &read.reads, txn).await {
    Ok(docs) => docs,
    Err(reason) => return vec![abort(txn, format!("!{reason}")).await],
  };
  match ids_and_docs(&docs) {
    Some((ids, hex)) => vec![ids, hex],
    None => vec![abort(txn, "!bulk:id".to_string()).await],
  }
}

/// Decodes `{ op: 'updateMany', s: <BSON { d }>, e: [<updateByID request>] }` or
/// `{ op: 'deleteMany', d?, c, s, q, lc?, lf?, lfind?, vc?, vq?, pc?, pf? }`.
pub fn decode(request: &RawDocument) -> Result<BulkRequest, String> {
  let stored = RawDocument::from_bytes(request.get_binary("s").map_err(|e| e.to_string())?.bytes).map_err(|e| e.to_string())?;
  let mut docs = Vec::new();
  for doc in stored.get_array("d").map_err(|e| e.to_string())? {
    let RawBsonRef::Document(doc) = doc.map_err(|e| e.to_string())? else { return Err("bulk:doc".to_string()) };
    docs.push(doc.to_raw_document_buf());
  }
  let text = |key: &str| request.get_str(key).ok().map(str::to_string);
  let sub = |key: &str| request.get_document(key).ok().map(RawDocument::to_raw_document_buf);
  match request.get_str("op").map_err(|e| e.to_string())? {
    "updateMany" => {
      let mut entries = Vec::new();
      for entry in request.get_array("e").map_err(|e| e.to_string())? {
        let RawBsonRef::Binary(entry) = entry.map_err(|e| e.to_string())? else { return Err("bulk:entry".to_string()) };
        entries.push(decode_by_id(RawDocument::from_bytes(entry.bytes).map_err(|e| e.to_string())?)?);
      }
      if entries.len() != docs.len() || entries.iter().any(|entry| entry.update.is_none()) {
        return Err("bulk:entries".to_string());
      }
      Ok(BulkRequest::Update { docs, entries })
    }
    "deleteMany" => {
      let lock = match (text("lc"), sub("lf")) {
        (Some(collection), Some(filter)) => {
          Some(Lock { collection, filter, find: request.get_bool("lfind").unwrap_or(false) })
        }
        _ => None,
      };
      Ok(BulkRequest::Delete {
        database: text("d"),
        collection: text("c").ok_or("bulk:c")?,
        query: sub("q").ok_or("bulk:q")?,
        docs,
        lock,
        versions: text("vc").zip(sub("vq")),
        preferences: text("pc").zip(sub("pf")),
      })
    }
    other => Err(format!("op:{other}")),
  }
}

/// Runs `request` in transaction `txn`, then its result read and the commit (or, with `state`, the
/// shadow's reads and the abort). The result text is the `find` page of the result documents.
pub async fn exec(
  client: u32,
  txn: u32,
  request: BulkRequest,
  read: ResultRead,
  state: Option<(Option<String>, Vec<StateRead>)>,
) -> Outcome {
  match run(client, txn, request, &read, state.as_ref()).await {
    Ok((text, state, context)) => Outcome { text, state, context },
    Err(text) => Outcome { text, state: None, context: None },
  }
}

async fn run(
  client: u32,
  txn: u32,
  request: BulkRequest,
  read: &ResultRead,
  state: Option<&(Option<String>, Vec<StateRead>)>,
) -> Result<(String, Option<String>, Option<String>), String> {
  let is_shadow = state.is_some();
  let mut context_writes: Option<String> = None;
  let text = match request {
    BulkRequest::Update { docs, entries } => {
      let mut results = Vec::with_capacity(docs.len());
      for (stored, entry) in docs.iter().zip(&entries) {
        match update_document(client, txn, entry, read, stored, is_shadow, true).await {
          // The documents share `req.context`: upstream's later documents find the keys an
          // earlier one wrote (authorship's submitted marks, `_isNewDoc`, lexical's
          // `internal.richText`) and overwrite them, and its readers see the last write. Each
          // document's prepare starts from the caller's context, which is the same only when every
          // document writes the same values (then a document finding them is one writing them);
          // otherwise the exact lane runs.
          Ok((doc, context)) if context_writes.as_ref().is_none_or(|previous| *previous == context) => {
            context_writes = Some(context);
            results.push(doc);
          }
          Ok(_) => return Err(abort(txn, "!bulk:context".to_string()).await),
          Err(reason) => return Err(abort(txn, reason).await),
        }
      }
      let text = run_documents(client, read.plan, &read.reads, &results, &read.request_json, Some(txn), false);
      if text.starts_with('!') {
        return Err(abort(txn, text).await);
      }
      text
    }
    BulkRequest::Delete { database, collection, docs, query, lock, versions, preferences } => {
      match delete_statements(client, txn, &database, &collection, &docs, query, lock.as_ref(), versions, is_shadow, read).await
      {
        Ok(text) => {
          // `deleteUserPreferences` runs after the results' `afterRead`, for zero documents too
          if let Some((preferences, filter)) = preferences {
            if let Err(reason) = send(client, txn, database, delete_command(&preferences, filter), true).await {
              return Err(abort(txn, reason).await);
            }
          }
          text
        }
        Err(reason) => return Err(abort(txn, reason).await),
      }
    }
  };
  let (text, state) = finish(client, txn, text, state).await?;
  Ok((text, state, context_writes))
}

#[allow(clippy::too_many_arguments)]
async fn delete_statements(
  client: u32,
  txn: u32,
  database: &Option<String>,
  collection: &str,
  docs: &[RawDocumentBuf],
  query: RawDocumentBuf,
  lock: Option<&Lock>,
  versions: Option<(String, RawDocumentBuf)>,
  is_shadow: bool,
  read: &ResultRead,
) -> Result<String, String> {
  if docs.is_empty() {
    return Ok(run_documents(client, read.plan, &read.reads, docs, &read.request_json, Some(txn), true));
  }
  if let Some(lock) = lock {
    lock_statements(client, txn, database.as_deref(), lock, is_shadow).await?;
  }
  if let Some((versions, filter)) = versions {
    send(client, txn, database.clone(), delete_command(&versions, filter), true).await?;
  }
  send(client, txn, database.clone(), delete_command(collection, query), true).await?;
  let text = run_documents(client, read.plan, &read.reads, docs, &read.request_json, Some(txn), true);
  if text.starts_with('!') {
    return Err(text);
  }
  Ok(text)
}
