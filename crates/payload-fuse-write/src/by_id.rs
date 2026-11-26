//! The operation drivers of `updateByID` and `deleteByID` (FUSED_WRITES.md section 13): the
//! stored-document read, the lock check and the writes in upstream's order in the Rust-owned
//! transaction, with no JS between them (`updateByID` runs WP-I's `prepare_update` on the stored
//! document in between).
//!
//! `updateByID` (collections/operations/updateByID.ts, utilities/update.ts):
//!
//! 1. `getLatestCollectionVersion`'s `findOne` of the document (in the transaction; the result
//!    read's `findOne`, the same read): none bails (the exact lane throws `NotFound`). With drafts
//!    it first reads the parent's latest version (`findVersions`, `latest: true`, `-updatedAt`,
//!    limit 1): when there is one, `docWithLocales` / `originalDoc` come from its `version` (with
//!    `id`), else from the `findOne`;
//! 2. `prepare_update` on it (`docWithLocales`, `originalDoc`: payload-fuse-mongo
//!    `update_inputs`); a bail or a validation error bails before anything is written;
//! 3. `checkDocumentLockStatus`: with `overrideLock: false` the lock `find` (no session), which
//!    bails on any lock of the document (the exact lane decides whether it is live), then the lock
//!    `delete` (no session; in the write lane-shadow inside the transaction, which is aborted);
//! 4. `findAndModify` (`returnDocument: 'after'`), whose `value` must be the prepare's
//!    `stored_after` byte for byte (else a bail: the version would have been built from another
//!    document). When the inputs came from the latest version the main document was not read: the
//!    prepare runs again with `value` as the stored document (its `$set` must be the first run's,
//!    and `$set` applied to `value` must give `value`). A draft save (`isSavingDraft`) sends no
//!    `findAndModify`: its version comes from beforeChange's result;
//! 5. with versions `saveVersion`: the version insert, the latest flip, `enforceMaxVersions`'
//!    `find` (`skip: max, limit: 1`) and, when it finds a version with an `updatedAt`, its
//!    `deleteVersions` (`updatedAt <= ` that version's, of the parent);
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
use payload_mongo_driver::mongodb::bson::{Bson, Document, RawBsonRef, RawDocument, RawDocumentBuf, rawdoc};
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
  /// updateByID with drafts: `getLatestCollectionVersion`'s `findVersions` of the parent's latest
  /// version (the versions collection is `versions`'s).
  pub latest: Option<FindSpec>,
  /// updateByID: `enforceMaxVersions`' `deleteVersions` filter (cast `{ updatedAt: {
  /// less_than_equal }, parent: { equals: id } }`) and the sentinel date its `updatedAt` holds.
  pub max_delete: Option<(Document, Bson)>,
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
  let latest = match sub("lv") {
    Some(spec) => Some(find_spec(&Document::try_from(spec.as_ref()).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?),
    None => None,
  };
  if latest.is_some() && versions.is_none() {
    return Err("byID:lv".to_string());
  }
  let max_delete = match (sub("md"), template.get("ms").map_err(|e| e.to_string())?) {
    (Some(filter), Some(sentinel)) => {
      Some((Document::try_from(filter.as_ref()).map_err(|e| e.to_string())?, Bson::try_from(sentinel).map_err(|e| e.to_string())?))
    }
    _ => None,
  };
  Ok(ByIDRequest {
    op,
    database: text("d"),
    collection: text("c").ok_or("byID:c")?,
    query,
    lock,
    update,
    versions,
    preferences,
    latest,
    max_delete,
  })
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
      let text = run_document(client, plan, &reads, Some(doc), &request_json, Some(txn), false);
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
  if request.op == ByID::Update {
    if let Some(version) = latest_version(client, txn, &request).await? {
      let inputs = version_inputs(&version)?;
      let (doc, context) = update_document(client, txn, &request, &read, &inputs, state.is_some(), false, true).await?;
      return Ok((read, doc, Some(context)));
    }
  }
  let stored = find_stored(client, &read.reads, txn).await.map_err(|reason| format!("!{reason}"))?;
  let stored = stored.ok_or("!byID:notFound")?;
  match request.op {
    ByID::Update => {
      let (doc, context) = update_document(client, txn, &request, &read, &stored, state.is_some(), false, false).await?;
      Ok((read, doc, Some(context)))
    }
    ByID::Delete => {
      let database = request.database.clone();
      if let Some(lock) = &request.lock {
        lock_statements(client, txn, database.as_deref(), lock, state.is_some()).await?;
      }
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
  }
}

/// `checkDocumentLockStatus` (and the bulk deletes' `getLockedDocumentIds` /
/// `deleteDocumentLocks`): with `overrideLock: false` the lock `find` (no session), which bails on
/// any lock (the exact lane decides whether it is live and throws `Locked` or records the error),
/// then the lock `delete` without a session (`is_shadow`: in the shadow's aborted transaction).
pub(crate) async fn lock_statements(
  client: u32,
  txn: u32,
  database: Option<&str>,
  lock: &Lock,
  is_shadow: bool,
) -> Result<(), String> {
  if lock.find {
    let filter = Document::try_from(lock.filter.as_ref()).map_err(|e| format!("!lock:{e}"))?;
    let find = FindSpec { filter, limit: Some(1), ..FindSpec::default() };
    let locks = find_raw(client, database, &lock.collection, find, None).await.map_err(|_| "!lock:find")?;
    if !locks.is_empty() {
      return Err("!byID:locked".to_string());
    }
  }
  send(client, txn, database.map(str::to_string), delete_command(&lock.collection, lock.filter.clone()), is_shadow).await?;
  Ok(())
}

/// `getLatestCollectionVersion`'s `findVersions` (with drafts): the parent's latest version.
async fn latest_version(client: u32, txn: u32, request: &ByIDRequest) -> Result<Option<RawDocumentBuf>, String> {
  let (Some(find), Some((versions, _, _))) = (&request.latest, &request.versions) else { return Ok(None) };
  let find = FindSpec { filter: find.filter.clone(), sort: find.sort.clone(), skip: find.skip, limit: find.limit, ..FindSpec::default() };
  let found = find_raw(client, request.database.as_deref(), versions, find, Some(txn)).await.map_err(|_| "!byID:latestVersion:find")?;
  Ok(found.into_iter().next())
}

/// `latestVersion.version` with `version.id = id`, as the stored document the read transform
/// turns into `docWithLocales` (`_id = parent`: the transform's trailing `id`).
fn version_inputs(version: &RawDocumentBuf) -> Result<RawDocumentBuf, String> {
  let version = Document::try_from(version.as_ref()).map_err(|_| "!byID:latestVersion")?;
  returned_version(&version)
}

/// One document's `updateDocument` after its stored read (updateByID, and each document of an
/// update-many, crates/payload-fuse-write `bulk`): `prepare_update` on `stored` (`lean_with_id`:
/// read by `payload.db.find`), the lock check, the `findAndModify` (none for a draft save), the
/// version statements and `enforceMaxVersions`' find. `from_version`: `stored` is the latest
/// version's document (drafts), not the main document. The document the result's `afterRead`
/// reads and the prepare's context writes.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn update_document(
  client: u32,
  txn: u32,
  request: &ByIDRequest,
  read: &ResultRead,
  stored: &RawDocumentBuf,
  is_shadow: bool,
  lean_with_id: bool,
  from_version: bool,
) -> Result<(RawDocumentBuf, String), String> {
  let database = request.database.clone();
  let (plan_id, prepare) = request.update.as_ref().ok_or("!byID:prepare")?;
  let (doc_with_locales, original_doc) = update_inputs(read.plan, &read.reads, stored, &read.request_json, lean_with_id)
    .map_err(|bail| format!("!{}", bail.0))?;
  let input = |stored: &RawDocumentBuf| -> Result<UpdateInput, String> {
    let stored = Document::try_from(stored.as_ref()).map_err(|_| "!byID:stored")?;
    Ok(UpdateInput { stored, doc_with_locales: doc_with_locales.clone(), original_doc: original_doc.clone() })
  };
  // the prepare runs before the lock check: it is pure (the order is unobservable) and a bail
  // then leaves the locks alone
  let (write, context) = prepare_write(&input(stored)?, *plan_id, prepare)?;
  if let Some(lock) = &request.lock {
    lock_statements(client, txn, database.as_deref(), lock, is_shadow).await?;
  }
  let version = if write.draft {
    write.version
  } else {
    let update = to_raw(&write.doc)?;
    let command = rawdoc! {
      "findAndModify": request.collection.as_str(),
      "query": request.query.clone(),
      "remove": false,
      "new": true,
      "upsert": false,
      "update": update.clone(),
    };
    let reply = send(client, txn, database.clone(), command, true).await?;
    let value = match reply.get("value") {
      Some(Bson::Document(value)) => to_raw(value)?,
      _ => return Err("!byID:notFound".to_string()),
    };
    let write = if from_version {
      // the same prepare on the main document as `findAndModify` returned it
      let (again, _) = prepare_write(&input(&value)?, *plan_id, prepare)?;
      if again.draft || to_raw(&again.doc)?.as_bytes() != update.as_bytes() {
        return Err("!byID:storedAfter:update".to_string());
      }
      again
    } else {
      write
    };
    let stored_after = write.stored_after.ok_or("!byID:storedAfter")?;
    if value.as_bytes() != to_raw(&stored_after)?.as_bytes() {
      return Err("!byID:storedAfter".to_string());
    }
    if write.version.is_none() && request.versions.is_none() {
      return Ok((value, context));
    }
    write.version
  };
  let doc = match (version, &request.versions) {
    (Some(version), Some((versions, max_find, _))) => {
      let returned = returned_version(&version.doc)?;
      let flip = Some((to_raw(&version.flip_filter)?, to_raw(&version.flip_update)?));
      for statement in version_statements(versions, to_raw(&version.doc)?, flip).map_err(|e| format!("!{e}"))? {
        send(client, txn, database.clone(), statement.command, true).await?;
      }
      if let Some(find) = max_find {
        let find = FindSpec { filter: find.filter.clone(), sort: find.sort.clone(), skip: find.skip, limit: find.limit, ..FindSpec::default() };
        let found = find_raw(client, database.as_deref(), versions, find, Some(txn)).await.map_err(|_| "!byID:maxVersions:find")?;
        if let Some(oldest) = found.first() {
          // `oldestAllowedDoc?.updatedAt` (read-transformed: a Date becomes its ISO string, which
          // the delete's cast turns back into the same Date): truthy, then `deleteVersions`
          let updated_at = match oldest.get("updatedAt").map_err(|_| "!byID:maxVersions:updatedAt")? {
            None | Some(RawBsonRef::Null) | Some(RawBsonRef::Undefined) => None,
            Some(RawBsonRef::DateTime(date)) if date.try_to_rfc3339_string().is_ok() => Some(Bson::DateTime(date)),
            Some(_) => return Err("!byID:maxVersions:updatedAt".to_string()),
          };
          if let Some(updated_at) = updated_at {
            let (filter, sentinel) = request.max_delete.as_ref().ok_or("!byID:maxVersions")?;
            let mut filter = filter.clone();
            if replace_value(&mut filter, sentinel, &updated_at) == 0 {
              return Err("!byID:maxVersions:template".to_string());
            }
            send(client, txn, database.clone(), delete_command(versions, to_raw(&filter)?), true).await?;
          }
        }
      }
      returned
    }
    _ => return Err("!byID:versions".to_string()),
  };
  Ok((doc, context))
}

/// `prepare_update` on `input`; the prepared write and the context writes.
fn prepare_write(input: &UpdateInput, plan_id: u32, request_json: &str) -> Result<(crate::prepare::PreparedWrite, String), String> {
  let plan = write_plan(plan_id).ok_or("!byID:plan")?;
  let DriverPrepared { prepared, left, context_writes } =
    prepare_update_request(&plan, request_json, input).map_err(|bail| format!("!prepare:{}", bail.0))?;
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

/// Replaces every `from` value in `doc` (nested documents and arrays) with `to`; the count.
fn replace_value(doc: &mut Document, from: &Bson, to: &Bson) -> usize {
  fn walk(value: &mut Bson, from: &Bson, to: &Bson) -> usize {
    if value == from {
      *value = to.clone();
      return 1;
    }
    match value {
      Bson::Document(doc) => doc.iter_mut().map(|(_, v)| walk(v, from, to)).sum(),
      Bson::Array(items) => items.iter_mut().map(|v| walk(v, from, to)).sum(),
      _ => 0,
    }
  }
  doc.iter_mut().map(|(_, v)| walk(v, from, to)).sum()
}

/// mongoose's `deleteMany(filter)` (no options): the `delete` command.
pub(crate) fn delete_command(collection: &str, filter: RawDocumentBuf) -> RawDocumentBuf {
  rawdoc! { "delete": collection, "deletes": [{ "q": filter, "limit": 0 }], "ordered": true }
}

pub(crate) fn to_raw(doc: &Document) -> Result<RawDocumentBuf, String> {
  RawDocumentBuf::from_document(doc).map_err(|e| format!("!bson:{e}"))
}
