//! The operation drivers of `updateByID` and `deleteByID` (FUSED_WRITES.md section 13): the
//! stored-document read, the lock check and the writes in upstream's order in the Rust-owned
//! transaction, with no JS between them (`updateByID` runs WP-I's `prepare_update` on the stored
//! document in between).
//!
//! `updateByID` (collections/operations/updateByID.ts, utilities/update.ts):
//!
//! 1. `getLatestCollectionVersion`'s `findOne` of the document (in the transaction; the result
//!    read's `findOne`, the same read): none bails (the exact lane throws `NotFound`);
//! 2. `prepare_update` on it (`docWithLocales`, `originalDoc`: payload-fuse-mongo
//!    `update_inputs`); a bail or a validation error bails before anything is written;
//! 3. `checkDocumentLockStatus`: with `overrideLock: false` the lock `find` (no session), which
//!    bails on any lock of the document (the exact lane decides whether it is live), then the lock
//!    `delete` (no session; in the write lane-shadow inside the transaction, which is aborted);
//! 4. `findAndModify` (`returnDocument: 'after'`), whose `value` must be the prepare's
//!    `stored_after` byte for byte (else a bail: the version would have been built from another
//!    document);
//! 5. with versions `saveVersion`: the version insert, the latest flip, `enforceMaxVersions`'
//!    `find` (`skip: max, limit: 1`), which bails when it finds a version (the exact lane deletes
//!    the old versions);
//! 6. the result: `afterRead` (population in the transaction) of saveVersion's returned version
//!    (`version` with `id = parent`), or without versions of the `findAndModify` value; then the
//!    commit.
//!
//! `deleteByID` (collections/operations/deleteByID.ts): the `findOne` (none bails), the lock
//! check, `deleteVersions` (the parent's versions), `findAndModify` with `remove: true` (its value
//! is the result's document), the preferences `delete` (`key: { $in: ['collection-<slug>-<id>'] }`),
//! the result's `afterRead` and the commit.
//!
//! The filters arrive cast (mongoose's casting of db-mongodb's `buildQuery`, built once per
//! collection by src/fuse-write/mongo.ts and given this call's id).

use payload_fuse_mongo::{find_stored, run_document, update_inputs};
use payload_mongo_driver::mongodb::bson::{Bson, Document, RawDocument, RawDocumentBuf, rawdoc};
use payload_mongo_driver::{FindSpec, find_raw, find_spec};

use crate::ops::version_statements;
use crate::prepare::{DriverPrepared, UpdateInput, prepare_update_request, write_plan};
use crate::{Outcome, ResultRead, abort, finish, send, state::StateRead};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ByID {
  Update,
  Delete,
}

/// The lock check of `checkDocumentLockStatus` (absent: locking is off for the collection).
pub struct Lock {
  pub collection: String,
  /// The cast `document.relationTo` / `document.value` filter of the document's locks.
  pub filter: RawDocumentBuf,
  /// `overrideLock: false`: the lock `find` runs first.
  pub find: bool,
}

pub struct ByIDRequest {
  pub op: ByID,
  pub database: Option<String>,
  pub collection: String,
  /// The cast `{ id: { equals: id } }` (`updateOne` / `deleteOne`).
  pub query: RawDocumentBuf,
  pub lock: Option<Lock>,
  /// updateByID: WP-I's write plan id and the prepare request (prepare/text.rs format).
  pub update: Option<(u32, String)>,
  /// The versions collection: updateByID's `enforceMaxVersions` find (`None`: `max` is 0),
  /// deleteByID's cast `{ parent: { equals: id } }`.
  pub versions: Option<(String, Option<FindSpec>, Option<RawDocumentBuf>)>,
  /// deleteByID: the preferences collection and its cast key filter.
  pub preferences: Option<(String, RawDocumentBuf)>,
}

/// Decodes `{ op: 'updateByID' | 'deleteByID', d?, c, t: <BSON { q, lf?, mf?, vq?, pf? }>, lc?,
/// lfind?, wp?, p?, vc?, pc? }`.
pub fn decode(request: &RawDocument) -> Result<ByIDRequest, String> {
  let op = match request.get_str("op").map_err(|e| e.to_string())? {
    "updateByID" => ByID::Update,
    "deleteByID" => ByID::Delete,
    other => return Err(format!("op:{other}")),
  };
  let text = |key: &str| request.get_str(key).ok().map(str::to_string);
  let template = RawDocument::from_bytes(request.get_binary("t").map_err(|e| e.to_string())?.bytes).map_err(|e| e.to_string())?;
  let sub = |key: &str| template.get_document(key).ok().map(RawDocument::to_raw_document_buf);
  let query = sub("q").ok_or("byID:q")?;
  let lock = match (text("lc"), sub("lf")) {
    (Some(collection), Some(filter)) => {
      Some(Lock { collection, filter, find: request.get_bool("lfind").unwrap_or(false) })
    }
    _ => None,
  };
  let update = match (request.get_i32("wp"), text("p")) {
    (Ok(plan), Some(prepare)) => Some((plan as u32, prepare)),
    _ => None,
  };
  if op == ByID::Update && update.is_none() {
    return Err("byID:prepare".to_string());
  }
  let versions = match text("vc") {
    Some(collection) => {
      let max_find = match sub("mf") {
        Some(spec) => Some(find_spec(&Document::try_from(spec.as_ref()).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?),
        None => None,
      };
      Some((collection, max_find, sub("vq")))
    }
    None => None,
  };
  let preferences = match (text("pc"), sub("pf")) {
    (Some(collection), Some(filter)) => Some((collection, filter)),
    _ => None,
  };
  Ok(ByIDRequest { op, database: text("d"), collection: text("c").ok_or("byID:c")?, query, lock, update, versions, preferences })
}

/// Runs `request` in transaction `txn`, then its result read and the commit (or, with `state`, the
/// shadow's reads and the abort). See [`crate::exec_shadowed`] for the result text.
pub async fn exec(
  client: u32,
  txn: u32,
  request: ByIDRequest,
  read: ResultRead,
  state: Option<(Option<String>, Vec<StateRead>)>,
) -> Outcome {
  match run(client, txn, request, read, state.as_ref()).await {
    Ok((text, state, context)) => Outcome { text, state, context },
    Err(text) => Outcome { text, state: None, context: None },
  }
}

type Done = (String, Option<String>, Option<String>);

async fn run(
  client: u32,
  txn: u32,
  request: ByIDRequest,
  read: ResultRead,
  state: Option<&(Option<String>, Vec<StateRead>)>,
) -> Result<Done, String> {
  match steps(client, txn, request, read, state).await {
    Ok((read, doc, context)) => {
      let ResultRead { plan, reads, request_json } = read;
      let text = run_document(client, plan, &reads, Some(doc), &request_json, Some(txn));
      if text.starts_with('!') {
        return Err(abort(txn, text).await);
      }
      let (text, state) = finish(client, txn, text, state).await?;
      Ok((text, state, context))
    }
    Err(reason) => Err(abort(txn, reason).await),
  }
}

/// The statements up to the result read: the read, the document it reads, the context writes.
/// `Err`: the bail reason (the caller aborts).
async fn steps(
  client: u32,
  txn: u32,
  request: ByIDRequest,
  read: ResultRead,
  state: Option<&(Option<String>, Vec<StateRead>)>,
) -> Result<(ResultRead, RawDocumentBuf, Option<String>), String> {
  let database = request.database.clone();
  let stored = find_stored(client, &read.reads, txn).await.map_err(|reason| format!("!{reason}"))?;
  let stored = stored.ok_or("!byID:notFound")?;
  let prepared = match &request.update {
    Some((plan_id, prepare)) => Some(prepare_write(&read, &stored, *plan_id, prepare)?),
    None => None,
  };
  if let Some(lock) = &request.lock {
    if lock.find {
      let filter = Document::try_from(lock.filter.as_ref()).map_err(|e| format!("!lock:{e}"))?;
      let find = FindSpec { filter, limit: Some(1), ..FindSpec::default() };
      let locks = find_raw(client, database.as_deref(), &lock.collection, find, None).await.map_err(|_| "!lock:find")?;
      if !locks.is_empty() {
        // the exact lane decides whether the lock is live (`Locked`) or not
        return Err("!byID:locked".to_string());
      }
    }
    // upstream deletes without a session; the shadow keeps it in its aborted transaction
    send(client, txn, database.clone(), delete_command(&lock.collection, lock.filter.clone()), state.is_some()).await?;
  }
  match (request.op, prepared) {
    (ByID::Update, Some((write, context))) => {
      let stored_after = write.stored_after.ok_or("!byID:storedAfter")?;
      let update = to_raw(&write.doc)?;
      let command = rawdoc! {
        "findAndModify": request.collection.as_str(),
        "query": request.query,
        "remove": false,
        "new": true,
        "upsert": false,
        "update": update,
      };
      let reply = send(client, txn, database.clone(), command, true).await?;
      let value = match reply.get("value") {
        Some(Bson::Document(value)) => to_raw(value)?,
        _ => return Err("!byID:notFound".to_string()),
      };
      if value.as_bytes() != to_raw(&stored_after)?.as_bytes() {
        return Err("!byID:storedAfter".to_string());
      }
      let doc = match (write.version, &request.versions) {
        (Some(version), Some((versions, max_find, _))) => {
          let returned = returned_version(&version.doc)?;
          let flip = Some((to_raw(&version.flip_filter)?, to_raw(&version.flip_update)?));
          for statement in version_statements(versions, to_raw(&version.doc)?, flip).map_err(|e| format!("!{e}"))? {
            send(client, txn, database.clone(), statement.command, true).await?;
          }
          if let Some(find) = max_find {
            let find = FindSpec { filter: find.filter.clone(), sort: find.sort.clone(), skip: find.skip, limit: find.limit, ..FindSpec::default() };
            let found = find_raw(client, database.as_deref(), versions, find, Some(txn)).await.map_err(|_| "!byID:maxVersions:find")?;
            if !found.is_empty() {
              // the exact lane deletes the versions past `max`
              return Err("!byID:maxVersions".to_string());
            }
          }
          returned
        }
        (None, None) => value,
        _ => return Err("!byID:versions".to_string()),
      };
      Ok((read, doc, Some(context)))
    }
    (ByID::Delete, None) => {
      if let Some((versions, _, Some(filter))) = &request.versions {
        send(client, txn, database.clone(), delete_command(versions, filter.clone()), true).await?;
      }
      let command = rawdoc! {
        "findAndModify": request.collection.as_str(),
        "query": request.query,
        "remove": true,
        "new": false,
        "upsert": false,
      };
      let reply = send(client, txn, database.clone(), command, true).await?;
      let doc = match reply.get("value") {
        Some(Bson::Document(value)) => to_raw(value)?,
        _ => return Err("!byID:notFound".to_string()),
      };
      if let Some((preferences, filter)) = &request.preferences {
        send(client, txn, database.clone(), delete_command(preferences, filter.clone()), true).await?;
      }
      Ok((read, doc, None))
    }
    _ => Err("!byID:op".to_string()),
  }
}

/// `prepare_update` on the stored document; the prepared write and the context writes.
fn prepare_write(
  read: &ResultRead,
  stored: &RawDocumentBuf,
  plan_id: u32,
  request_json: &str,
) -> Result<(crate::prepare::PreparedWrite, String), String> {
  let (doc_with_locales, original_doc) =
    update_inputs(read.plan, &read.reads, stored, &read.request_json).map_err(|bail| format!("!{}", bail.0))?;
  let stored = Document::try_from(stored.as_ref()).map_err(|_| "!byID:stored")?;
  let plan = write_plan(plan_id).ok_or("!byID:plan")?;
  let input = UpdateInput { stored, doc_with_locales, original_doc };
  let DriverPrepared { prepared, left, context_writes } =
    prepare_update_request(&plan, request_json, &input).map_err(|bail| format!("!prepare:{}", bail.0))?;
  if left != (0, 0) {
    return Err("!prepare:readings-left".to_string());
  }
  // without translations a validation failure bails: the exact lane throws upstream's error
  let write = prepared.outcome.map_err(|_| "!prepare:invalid")?;
  Ok((write, context_writes))
}

/// saveVersion's result as stored: the version's `version` with `_id = parent` (the read
/// transform turns it into the trailing `id` sanitizeInternalFields and saveVersion leave).
fn returned_version(version: &Document) -> Result<RawDocumentBuf, String> {
  let mut doc = version.get_document("version").map_err(|_| "!byID:version")?.clone();
  let parent = version.get("parent").cloned().ok_or("!byID:parent")?;
  if doc.contains_key("_id") || doc.contains_key("id") {
    return Err("!byID:version:id".to_string());
  }
  doc.insert("_id", parent);
  to_raw(&doc)
}

/// mongoose's `deleteMany(filter)` (no options): the `delete` command.
fn delete_command(collection: &str, filter: RawDocumentBuf) -> RawDocumentBuf {
  rawdoc! { "delete": collection, "deletes": [{ "q": filter, "limit": 0 }], "ordered": true }
}

fn to_raw(doc: &Document) -> Result<RawDocumentBuf, String> {
  RawDocumentBuf::from_document(doc).map_err(|e| format!("!bson:{e}"))
}
