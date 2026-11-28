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
//!
//! By default ([`crate::is_merging`]) the writes of every document are one `bulkWrite`
//! ([`merged_updates`], `delete_statements`; FUSED_WRITES.md section 13, "Merged statements").

use payload_fuse_mongo::{find_stored_many, run_documents};
use payload_mongo_driver::mongodb::bson::{RawArrayBuf, RawBsonRef, RawDocument, RawDocumentBuf, rawdoc};

use crate::by_id::{
  ByIDRequest, Lock, beside_lock_find, decode as decode_by_id, delete_command, delete_older_versions, lock_statements,
  prepare_document, returned_version, to_raw, update_command, update_document, updated_and_oldest_many, version_writes,
};
use crate::{Outcome, ResultRead, abort, finish, is_merging, send, send_writes, state::StateRead};

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
      let merged = if is_merging() { merged_updates(client, txn, &docs, &entries, read).await } else { Ok(None) };
      let mut results = Vec::with_capacity(docs.len());
      let separate = match merged {
        Ok(Some((merged, context))) => {
          results = merged;
          context_writes = context;
          &[][..]
        }
        Ok(None) => &docs[..],
        Err(reason) => return Err(abort(txn, reason).await),
      };
      for (stored, entry) in separate.iter().zip(&entries) {
        match update_document(client, txn, entry, read, stored, is_shadow, true, false).await {
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

/// Stored-document bytes read back per `aggregate` of [`merged_updates`] (its one result
/// document holds them all and must stay below the 16 MB BSON limit).
const UPDATED_READ_BYTES: usize = 4 << 20;

/// update-many's documents merged (FUSED_WRITES.md section 13, "Merged statements"): every
/// document's prepare (pure) first; then one `bulkWrite` of every document's lock delete, update,
/// version insert and latest flip, in the find's order, beside one lock `find` of all of them
/// (any lock bails, as each document's own find would); then the updated documents (each must be
/// its prepare's `stored_after`) and their `enforceMaxVersions` versions, one `aggregate` per
/// few MB of documents, and the max-versions deletes. Each document's statements keep their
/// order; only the interleaving between documents differs (D1, as the per-document sequence).
/// `None`: a document needs the per-document statements (a draft save, unique lookups, no
/// versions, a max-versions find `$lookup` would read differently).
async fn merged_updates(
  client: u32,
  txn: u32,
  docs: &[RawDocumentBuf],
  entries: &[ByIDRequest],
  read: &ResultRead,
) -> Result<Option<(Vec<RawDocumentBuf>, Option<String>)>, String> {
  let mut prepared = Vec::with_capacity(docs.len());
  let mut context_writes: Option<String> = None;
  for (stored, entry) in docs.iter().zip(entries) {
    let (write, context) = prepare_document(entry, read, stored, true)?;
    let Some((_, max_find, _)) = &entry.versions else { return Ok(None) };
    let is_lookup_read = max_find.as_ref().is_none_or(|find| find.limit.is_none_or(|limit| limit > 0));
    if write.draft || !write.unique.is_empty() || write.version.is_none() || write.stored_after.is_none() || !is_lookup_read {
      return Ok(None);
    }
    // the documents share `req.context` (see `run`)
    if context_writes.as_ref().is_some_and(|previous| *previous != context) {
      return Err("!bulk:context".to_string());
    }
    context_writes = Some(context);
    prepared.push(write);
  }
  let mut writes = Vec::new();
  let mut mains = Vec::with_capacity(entries.len());
  let mut lock_filters = RawArrayBuf::new();
  let mut lock_collection: Option<&str> = None;
  for (entry, write) in entries.iter().zip(&prepared) {
    if let Some(lock) = &entry.lock {
      writes.push((entry.database.clone(), delete_command(&lock.collection, lock.filter.clone())));
      if lock.find {
        if lock_collection.is_some_and(|collection| collection != lock.collection) {
          return Ok(None);
        }
        lock_collection = Some(&lock.collection);
        lock_filters.push(lock.filter.clone());
      }
    }
    mains.push(writes.len());
    writes.push((entry.database.clone(), update_command(entry, to_raw(&write.doc)?)));
    let (Some(version), Some((versions, _, _))) = (&write.version, &entry.versions) else { return Err("!byID:versions".to_string()) };
    writes.extend(version_writes(&entry.database, versions, version)?);
  }
  let lock = lock_collection.map(|collection| Lock { collection: collection.to_string(), filter: rawdoc! { "$or": lock_filters }, find: true });
  let database = entries.first().and_then(|entry| entry.database.clone());
  let counts = beside_lock_find(client, database.as_deref(), lock.as_ref(), send_writes(client, txn, writes)).await?;
  if mains.iter().any(|&main| counts[main] != 1) {
    return Err("!byID:notFound".to_string());
  }
  let mut results = Vec::with_capacity(entries.len());
  let mut start = 0;
  while start < entries.len() {
    let mut end = start;
    let mut bytes = 0;
    while end < entries.len() && (end == start || bytes + docs[end].as_bytes().len() <= UPDATED_READ_BYTES) {
      bytes += docs[end].as_bytes().len();
      end += 1;
    }
    let requests: Vec<&ByIDRequest> = entries[start..end].iter().collect();
    let found = updated_and_oldest_many(txn, &requests).await?.ok_or("!bulk:updated")?;
    for ((updated, oldest), (entry, write)) in found.into_iter().zip(entries[start..end].iter().zip(&prepared[start..end])) {
      let stored_after = write.stored_after.as_ref().ok_or("!byID:storedAfter")?;
      if updated.as_bytes() != to_raw(stored_after)?.as_bytes() {
        return Err("!byID:storedAfter".to_string());
      }
      let (Some(version), Some((versions, _, _))) = (&write.version, &entry.versions) else { return Err("!byID:versions".to_string()) };
      delete_older_versions(client, txn, entry, versions, oldest.as_deref()).await?;
      results.push(returned_version(&version.doc)?);
    }
    start = end;
  }
  Ok(Some((results, context_writes)))
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
  if is_merging() {
    // the lock delete, `deleteCollectionVersions` and the documents' delete in one `bulkWrite`,
    // beside the lock `find` (by_id `beside_lock_find`)
    let mut writes: Vec<_> = lock.map(|lock| (database.clone(), delete_command(&lock.collection, lock.filter.clone()))).into_iter().collect();
    if let Some((versions, filter)) = versions {
      writes.push((database.clone(), delete_command(&versions, filter)));
    }
    writes.push((database.clone(), delete_command(collection, query)));
    beside_lock_find(client, database.as_deref(), lock, send_writes(client, txn, writes)).await?;
  } else {
    if let Some(lock) = lock {
      lock_statements(client, txn, database.as_deref(), lock, is_shadow).await?;
    }
    if let Some((versions, filter)) = versions {
      send(client, txn, database.clone(), delete_command(&versions, filter), true).await?;
    }
    send(client, txn, database.clone(), delete_command(collection, query), true).await?;
  }
  let text = run_documents(client, read.plan, &read.reads, docs, &read.request_json, Some(txn), true);
  if text.starts_with('!') {
    return Err(text);
  }
  Ok(text)
}
