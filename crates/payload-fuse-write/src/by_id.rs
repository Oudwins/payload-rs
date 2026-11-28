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
//!
//! By default ([`crate::is_merging`]) independent statements share round trips: writes in a row
//! are one `bulkWrite`, the lock delete joins them inside the transaction, the lock `find` runs
//! beside them ([`merged_update`], the delete in `steps`; FUSED_WRITES.md section 13, "Merged
//! statements").

use payload_fuse_mongo::{find_stored, run_document, update_inputs};
use payload_mongo_driver::mongodb::bson::{Bson, Document, RawArrayBuf, RawBsonRef, RawDocument, RawDocumentBuf, rawdoc};
use payload_mongo_driver::{FindSpec, find_raw, find_spec, txn_command_raw};

use crate::ops::version_statements;
use crate::unique::UniqueTemplates;
use crate::prepare::{DriverPrepared, PreparedWrite, UpdateInput, VersionWrite, prepare_update_request, write_plan};
use crate::{Outcome, ResultRead, abort, finish, is_merging, merged_command_failed, send, send_writes, state::StateRead};

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
  /// version (the versions collection is `versions`'s); with a where-constraint update access the
  /// one of `tl` (`{ lv }`: the access where with the version keys, combined into it).
  pub latest: Option<FindSpec>,
  /// updateByID: `enforceMaxVersions`' `deleteVersions` filter (cast `{ updatedAt: {
  /// less_than_equal }, parent: { equals: id } }`) and the sentinel date its `updatedAt` holds.
  pub max_delete: Option<(Document, Bson)>,
  /// The stored-document paths of relationships to collections the result read does not serve
  /// (`up`): a stored value at one bails before any statement (the result read would).
  pub unserved: Vec<Vec<String>>,
  /// updateByID: the templates of the all-locales publish validation's unique-value lookups
  /// (`ut`) and the document's id (`uid`, its own value is no conflict).
  pub unique: Option<(UniqueTemplates, String)>,
}

/// Decodes `{ op: 'updateByID' | 'deleteByID', d?, c, t: <BSON { q, lf?, mf?, vq?, pf?, lv? }>,
/// tl?: <BSON { lv }>, lc?, lfind?, wp?, p?, vc?, pc? }`.
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
  let access_latest = match request.get_binary("tl") {
    Ok(binary) => {
      let doc = RawDocument::from_bytes(binary.bytes).map_err(|e| e.to_string())?;
      Some(doc.get_document("lv").map_err(|e| e.to_string())?.to_raw_document_buf())
    }
    Err(_) => None,
  };
  if access_latest.is_some() && sub("lv").is_none() {
    return Err("byID:tl".to_string());
  }
  let latest = match access_latest.or_else(|| sub("lv")) {
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
  let mut unserved = Vec::new();
  if let Ok(paths) = request.get_array("up") {
    for path in paths {
      let path = path.map_err(|e| e.to_string())?.as_array().ok_or("byID:up")?;
      let mut segments = Vec::new();
      for segment in path {
        segments.push(segment.map_err(|e| e.to_string())?.as_str().ok_or("byID:up")?.to_string());
      }
      unserved.push(segments);
    }
  }
  let unique = match (request.get_document("ut"), request.get_str("uid")) {
    (Ok(templates), Ok(id)) => Some((crate::unique::decode(templates)?, id.to_string())),
    _ => None,
  };
  Ok(ByIDRequest {
    unique,
    unserved,
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
  if request.unserved.iter().any(|path| holds_value(&stored, path)) {
    return Err("!populate:related".to_string());
  }
  match request.op {
    ByID::Update => {
      let (doc, context) = update_document(client, txn, &request, &read, &stored, state.is_some(), false, false).await?;
      Ok((read, doc, Some(context)))
    }
    ByID::Delete => {
      let database = request.database.clone();
      if is_merging() && read.reads.reads_whole_document() {
        // The stored document is the one `findAndModify` would remove (read in this transaction's
        // snapshot: a concurrent change makes the delete a write conflict), so the lock delete,
        // `deleteVersions`, the document's delete and the preferences delete are one `bulkWrite`.
        let mut writes = lock_delete(&database, request.lock.as_ref());
        if let Some((versions, _, Some(filter))) = &request.versions {
          writes.push((database.clone(), delete_command(versions, filter.clone())));
        }
        let main = writes.len();
        writes.push((database.clone(), rawdoc! {
          "delete": request.collection.as_str(),
          "deletes": [{ "q": request.query.clone(), "limit": 1 }],
          "ordered": true,
        }));
        if let Some((preferences, filter)) = &request.preferences {
          writes.push((database.clone(), delete_command(preferences, filter.clone())));
        }
        let counts = beside_lock_find(client, database.as_deref(), request.lock.as_ref(), send_writes(client, txn, writes)).await?;
        if counts[main] != 1 {
          return Err("!byID:notFound".to_string());
        }
        return Ok((read, stored, None));
      }
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

/// Whether `doc` holds a value other than `null` / an empty array at `path` (array elements are
/// searched for the remaining segments).
fn holds_value(doc: &RawDocument, path: &[String]) -> bool {
  let Some((first, rest)) = path.split_first() else {
    return false;
  };
  match doc.get(first) {
    Ok(Some(value)) => value_holds(value, rest),
    _ => false,
  }
}

fn value_holds(value: RawBsonRef<'_>, rest: &[String]) -> bool {
  match value {
    RawBsonRef::Null | RawBsonRef::Undefined => false,
    RawBsonRef::Array(items) if rest.is_empty() => items.into_iter().next().is_some(),
    RawBsonRef::Array(items) => items.into_iter().flatten().any(|item| value_holds(item, rest)),
    RawBsonRef::Document(doc) if !rest.is_empty() => holds_value(doc, rest),
    _ => rest.is_empty(),
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
    lock_find(client, database, lock).await?;
  }
  send(client, txn, database.map(str::to_string), delete_command(&lock.collection, lock.filter.clone()), is_shadow).await?;
  Ok(())
}

/// The lock `find` of `checkDocumentLockStatus` with `overrideLock: false` (no session): any lock
/// of the documents bails.
async fn lock_find(client: u32, database: Option<&str>, lock: &Lock) -> Result<(), String> {
  let filter = Document::try_from(lock.filter.as_ref()).map_err(|e| format!("!lock:{e}"))?;
  let find = FindSpec { filter, limit: Some(1), ..FindSpec::default() };
  let locks = find_raw(client, database, &lock.collection, find, None).await.map_err(|_| "!lock:find")?;
  if !locks.is_empty() {
    return Err("!byID:locked".to_string());
  }
  Ok(())
}

/// The merged statements' lock check: `write`, the first statements in the transaction after the
/// check (the lock delete among them, inside the transaction), runs beside the lock `find` (with
/// `overrideLock: false`). A lock bails, and the abort undoes what `write` did, so the outcome is
/// the one of the find first; a bail's rerun on the exact lane deletes the locks itself.
pub(crate) async fn beside_lock_find<T>(
  client: u32,
  database: Option<&str>,
  lock: Option<&Lock>,
  write: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
  match lock.filter(|lock| lock.find) {
    Some(lock) => {
      let (found, written) = tokio::join!(lock_find(client, database, lock), write);
      found?;
      written
    }
    None => write.await,
  }
}

/// The lock delete of the merged statements: in the transaction, with the first write.
fn lock_delete(database: &Option<String>, lock: Option<&Lock>) -> Vec<(Option<String>, RawDocumentBuf)> {
  lock.map(|lock| (database.clone(), delete_command(&lock.collection, lock.filter.clone()))).into_iter().collect()
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
  if !write.unique.is_empty() {
    // the all-locales publish validation's `fieldValueExists` finds (no session), before any
    // statement
    let lookups = write.unique.iter().map(|u| Ok((u.path.clone(), u.locale.clone(), lookup_value(&u.value)?))).collect::<Result<Vec<_>, String>>()?;
    let (templates, id) = request.unique.as_ref().map(|(t, id)| (Some(t), Some(id.as_str()))).unwrap_or((None, None));
    crate::unique::run(client, database.as_deref(), templates, &lookups, id).await?;
  }
  if is_merging() {
    let doc = merged_update(client, txn, request, write, &input, *plan_id, prepare, from_version).await?;
    return Ok((doc, context));
  }
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
      let oldest = max_versions_find(client, txn, database.as_deref(), versions, max_find.as_ref()).await?;
      delete_older_versions(client, txn, request, versions, oldest.as_deref()).await?;
      returned
    }
    _ => return Err("!byID:versions".to_string()),
  };
  Ok((doc, context))
}

/// [`update_document`]'s statements after the prepare, merged (FUSED_WRITES.md section 13,
/// "Merged statements"): the lock `find` runs beside the first statement after the check, the
/// lock delete joins the version insert and the latest flip in one `bulkWrite` (after
/// `findAndModify`, none for a draft save), then `enforceMaxVersions`' find.
#[allow(clippy::too_many_arguments)]
async fn merged_update(
  client: u32,
  txn: u32,
  request: &ByIDRequest,
  write: PreparedWrite,
  input: &impl Fn(&RawDocumentBuf) -> Result<UpdateInput, String>,
  plan_id: u32,
  prepare: &str,
  from_version: bool,
) -> Result<RawDocumentBuf, String> {
  let database = request.database.clone();
  let lock = request.lock.as_ref();
  let mut writes = lock_delete(&database, lock);
  let versions = request.versions.as_ref();
  if write.draft {
    let (Some(version), Some((collection, max_find, _))) = (write.version, versions) else {
      return Err("!byID:versions".to_string());
    };
    let returned = returned_version(&version.doc)?;
    writes.extend(version_writes(&database, collection, &version)?);
    beside_lock_find(client, database.as_deref(), lock, send_writes(client, txn, writes)).await?;
    let oldest = max_versions_find(client, txn, database.as_deref(), collection, max_find.as_ref()).await?;
    delete_older_versions(client, txn, request, collection, oldest.as_deref()).await?;
    return Ok(returned);
  }
  // `findAndModify` first (its value is checked against the prepare's `stored_after`, is the result
  // without versions, and is what a publish from the latest version builds its version from),
  // then the lock delete with the version writes
  let update = to_raw(&write.doc)?;
  let command = rawdoc! {
    "findAndModify": request.collection.as_str(),
    "query": request.query.clone(),
    "remove": false,
    "new": true,
    "upsert": false,
    "update": update.clone(),
  };
  let reply = beside_lock_find(client, database.as_deref(), lock, send(client, txn, database.clone(), command, true)).await?;
  let value = match reply.get("value") {
    Some(Bson::Document(value)) => to_raw(value)?,
    _ => return Err("!byID:notFound".to_string()),
  };
  let write = if from_version {
    let (again, _) = prepare_write(&input(&value)?, plan_id, prepare)?;
    if again.draft || to_raw(&again.doc)?.as_bytes() != update.as_bytes() {
      return Err("!byID:storedAfter:update".to_string());
    }
    again
  } else {
    write
  };
  let stored_after = write.stored_after.as_ref().ok_or("!byID:storedAfter")?;
  if value.as_bytes() != to_raw(stored_after)?.as_bytes() {
    return Err("!byID:storedAfter".to_string());
  }
  let has_version = write.version.is_some();
  let (Some(version), Some((collection, max_find, _))) = (write.version, versions) else {
    if versions.is_some() || has_version {
      return Err("!byID:versions".to_string());
    }
    if !writes.is_empty() {
      send_writes(client, txn, writes).await?;
    }
    return Ok(value);
  };
  let returned = returned_version(&version.doc)?;
  writes.extend(version_writes(&database, collection, &version)?);
  send_writes(client, txn, writes).await?;
  let oldest = max_versions_find(client, txn, database.as_deref(), collection, max_find.as_ref()).await?;
  delete_older_versions(client, txn, request, collection, oldest.as_deref()).await?;
  Ok(returned)
}

/// update-many's main update of a document: `findAndModify`'s update as an `update` command (the
/// document after it is read back, see [`updated_and_oldest_many`]).
pub(crate) fn update_command(request: &ByIDRequest, update: RawDocumentBuf) -> RawDocumentBuf {
  rawdoc! {
    "update": request.collection.as_str(),
    "updates": [{ "q": request.query.clone(), "u": update, "multi": false, "upsert": false }],
    "ordered": true,
  }
}

/// [`update_document`]'s prepare alone (update-many's merged statements): the prepared write and
/// the context writes.
pub(crate) fn prepare_document(
  request: &ByIDRequest,
  read: &ResultRead,
  stored: &RawDocumentBuf,
  lean_with_id: bool,
) -> Result<(PreparedWrite, String), String> {
  let (plan_id, prepare) = request.update.as_ref().ok_or("!byID:prepare")?;
  let (doc_with_locales, original_doc) = update_inputs(read.plan, &read.reads, stored, &read.request_json, lean_with_id)
    .map_err(|bail| format!("!{}", bail.0))?;
  let stored = Document::try_from(stored.as_ref()).map_err(|_| "!byID:stored")?;
  prepare_write(&UpdateInput { stored, doc_with_locales, original_doc }, *plan_id, prepare)
}

/// db-mongodb `createVersion`'s writes of `version` on `collection` (the version insert, the latest
/// flip).
pub(crate) fn version_writes(database: &Option<String>, collection: &str, version: &VersionWrite) -> Result<Vec<(Option<String>, RawDocumentBuf)>, String> {
  let flip = Some((to_raw(&version.flip_filter)?, to_raw(&version.flip_update)?));
  let statements = version_statements(collection, to_raw(&version.doc)?, flip).map_err(|e| format!("!{e}"))?;
  Ok(statements.into_iter().map(|statement| (database.clone(), statement.command)).collect())
}

/// `enforceMaxVersions`' `find` (`skip: max, limit: 1`) in the transaction: the oldest version to
/// keep, if any (`None` without `max_find`: `max` is 0).
async fn max_versions_find(
  client: u32,
  txn: u32,
  database: Option<&str>,
  versions: &str,
  max_find: Option<&FindSpec>,
) -> Result<Option<RawDocumentBuf>, String> {
  let Some(find) = max_find else { return Ok(None) };
  let find = FindSpec { filter: find.filter.clone(), sort: find.sort.clone(), skip: find.skip, limit: find.limit, ..FindSpec::default() };
  let found = find_raw(client, database, versions, find, Some(txn)).await.map_err(|_| "!byID:maxVersions:find")?;
  Ok(found.into_iter().next())
}

/// The documents of several updates of one collection after their update (update-many) and
/// their `enforceMaxVersions` versions: one `aggregate` whose `$facet` has [`updated_stages`] of
/// each (`None`: a document needs the separate reads).
pub(crate) async fn updated_and_oldest_many(
  txn: u32,
  requests: &[&ByIDRequest],
) -> Result<Option<Vec<(RawDocumentBuf, Option<RawDocumentBuf>)>>, String> {
  let Some(head) = requests.first() else { return Ok(Some(Vec::new())) };
  let mut queries = RawArrayBuf::new();
  let mut facets = RawDocumentBuf::new();
  for (index, request) in requests.iter().enumerate() {
    let Some((versions, max_find, _)) = &request.versions else { return Ok(None) };
    let Some(stages) = updated_stages(request, versions, max_find.as_ref())? else { return Ok(None) };
    queries.push(request.query.clone());
    facets.append(index.to_string(), stages);
  }
  let mut pipeline = RawArrayBuf::new();
  pipeline.push(rawdoc! { "$match": { "$or": queries } });
  pipeline.push(rawdoc! { "$facet": facets });
  let command = rawdoc! { "aggregate": head.collection.as_str(), "pipeline": pipeline, "cursor": {} };
  let reply = txn_command_raw(txn, head.database.clone(), command).await.map_err(merged_command_failed)?;
  let Some(Bson::Document(facets)) = first_result(&reply)? else { return Err("!byID:updated:cursor".to_string()) };
  let mut out = Vec::with_capacity(requests.len());
  for index in 0..requests.len() {
    match facets.get_array(index.to_string()).map_err(|_| "!byID:updated")?.first() {
      Some(Bson::Document(first)) => out.push(updated_result(first)?),
      _ => return Err("!byID:notFound".to_string()),
    }
  }
  Ok(Some(out))
}

/// The stages reading the document of `request`'s query after the update, as `findAndModify`
/// returns it (wrapped as `{ d: $$ROOT }`, so its own keys never meet the lookup's) and, as `m`,
/// `enforceMaxVersions`' version
/// (`max_find` as a `$lookup` pipeline: `$match`, `$sort`, `$skip`, `$limit`, only `updatedAt`
/// kept). `None`: `max_find` has a non-positive limit, which a `find` reads differently.
fn updated_stages(request: &ByIDRequest, versions: &str, max_find: Option<&FindSpec>) -> Result<Option<RawArrayBuf>, String> {
  let mut pipeline = RawArrayBuf::new();
  pipeline.push(rawdoc! { "$match": request.query.clone() });
  pipeline.push(rawdoc! { "$limit": 1 });
  pipeline.push(rawdoc! { "$replaceWith": { "d": "$$ROOT" } });
  if let Some(find) = max_find {
    let mut lookup = RawArrayBuf::new();
    lookup.push(rawdoc! { "$match": to_raw(&find.filter)? });
    if let Some(sort) = find.sort.as_ref().filter(|sort| !sort.is_empty()) {
      lookup.push(rawdoc! { "$sort": to_raw(sort)? });
    }
    if let Some(skip) = find.skip.filter(|&skip| skip > 0) {
      lookup.push(rawdoc! { "$skip": i64::try_from(skip).map_err(|_| "!byID:maxVersions:skip")? });
    }
    match find.limit {
      None => {}
      Some(limit) if limit > 0 => lookup.push(rawdoc! { "$limit": limit }),
      Some(_) => return Ok(None),
    }
    lookup.push(rawdoc! { "$project": { "_id": 0, "updatedAt": 1 } });
    pipeline.push(rawdoc! { "$lookup": { "from": versions, "pipeline": lookup, "as": "m" } });
  }
  Ok(Some(pipeline))
}

/// The first document of an `aggregate` reply (whose cursor must be exhausted).
fn first_result(reply: &Document) -> Result<Option<&Bson>, String> {
  let cursor = reply.get_document("cursor").map_err(|_| "!byID:updated:cursor")?;
  let batch = cursor.get_array("firstBatch").map_err(|_| "!byID:updated:cursor")?;
  if !matches!(cursor.get("id"), Some(Bson::Int64(0) | Bson::Int32(0))) || batch.len() > 1 {
    return Err("!byID:updated:cursor".to_string());
  }
  Ok(batch.first())
}

/// The updated document (`d`) and the oldest version to keep (`m`'s first) of [`updated_stages`].
fn updated_result(result: &Document) -> Result<(RawDocumentBuf, Option<RawDocumentBuf>), String> {
  let updated = to_raw(result.get_document("d").map_err(|_| "!byID:updated")?)?;
  let oldest = match result.get("m") {
    None => None,
    Some(Bson::Array(found)) => match found.first() {
      Some(Bson::Document(oldest)) => Some(to_raw(oldest)?),
      Some(_) => return Err("!byID:maxVersions:find".to_string()),
      None => None,
    },
    Some(_) => return Err("!byID:maxVersions:find".to_string()),
  };
  Ok((updated, oldest))
}

/// `enforceMaxVersions` after its find: when the oldest version to keep has an `updatedAt`, its
/// `deleteVersions` (`updatedAt <=` it, of the parent) in the transaction.
pub(crate) async fn delete_older_versions(
  client: u32,
  txn: u32,
  request: &ByIDRequest,
  versions: &str,
  oldest: Option<&RawDocument>,
) -> Result<(), String> {
  let Some(oldest) = oldest else { return Ok(()) };
  // `oldestAllowedDoc?.updatedAt` (read-transformed: a Date becomes its ISO string, which the
  // delete's cast turns back into the same Date): truthy, then `deleteVersions`
  let updated_at = match oldest.get("updatedAt").map_err(|_| "!byID:maxVersions:updatedAt")? {
    None | Some(RawBsonRef::Null) | Some(RawBsonRef::Undefined) => return Ok(()),
    Some(RawBsonRef::DateTime(date)) if date.try_to_rfc3339_string().is_ok() => Bson::DateTime(date),
    Some(_) => return Err("!byID:maxVersions:updatedAt".to_string()),
  };
  let (filter, sentinel) = request.max_delete.as_ref().ok_or("!byID:maxVersions")?;
  let mut filter = filter.clone();
  if replace_value(&mut filter, sentinel, &updated_at) == 0 {
    return Err("!byID:maxVersions:template".to_string());
  }
  send(client, txn, request.database.clone(), delete_command(versions, to_raw(&filter)?), true).await?;
  Ok(())
}

/// A unique lookup's value as js-bson serializes it (strings and numbers; anything else bails).
pub(crate) fn lookup_value(value: &payload_engine::js::JsVal) -> Result<Bson, String> {
  use payload_engine::js::JsVal;
  match value {
    JsVal::Str(s) => Ok(Bson::String(s.to_string())),
    JsVal::Num(n) => Ok(Bson::Double(*n)),
    _ => Err("!drafts:localizedPublish:unique:value".to_string()),
  }
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
pub(crate) fn returned_version(version: &Document) -> Result<RawDocumentBuf, String> {
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
