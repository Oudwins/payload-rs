//! The operation drivers of the fused writes (FUSED_WRITES.md section 13): one operation's
//! statements, in upstream's order, built from its prepared documents.
//!
//! `create` (packages/payload/src/collections/operations/create.ts, db-mongodb `create` /
//! `createVersion`):
//!
//! 1. `insert <collection>` of the document (`Model.create([data], { session })`);
//! 2. with versions: `insert <versions collection>` of the version document, then the latest flip
//!    (`updateMany` unsetting `latest` on the parent's other latest versions older than it; none
//!    when the prepare's flip update is empty: mongoose then sends nothing);
//! 3. no `enforceMaxVersions` find: the document's id was generated in this call, so the parent
//!    has no other version (owner decision 2026-11-24; fused creates never take a custom id, see
//!    the write plan in src/fuse-write/plan.ts);
//!
//! then the result's `afterRead` (population in the transaction) on the inserted document and the
//! commit ([`crate::exec_shadowed`]). Before the statements, the all-locales publish validation's
//! unique-value lookups (`u` with the templates `ut`, [`crate::unique`]; no session).


use payload_mongo_driver::mongodb::bson::{Bson, RawBsonRef, RawDocument, RawDocumentBuf, rawdoc};

use crate::unique::UniqueTemplates;
use crate::{ResultOf, Statement};

pub enum Op {
  Create,
}

pub struct OpRequest {
  pub op: Op,
  pub database: Option<String>,
  pub statements: Vec<Statement>,
  /// The prepare's unique-value lookups `(path, locale, value)` and their templates.
  pub unique: Option<(UniqueTemplates, Vec<(String, String, Bson)>)>,
}

/// Runs `request`'s unique-value lookups (no session) before its statements; `Err`: the bail
/// text, the transaction `txn` aborted.
pub async fn unique_lookups(client: u32, txn: u32, request: &OpRequest) -> Result<(), String> {
  let Some((templates, lookups)) = &request.unique else { return Ok(()) };
  match crate::unique::run(client, request.database.as_deref(), Some(templates), lookups, None).await {
    Ok(()) => Ok(()),
    Err(reason) => Err(crate::abort(txn, reason).await),
  }
}

/// The latest flip of a version insert: its filter and update as mongoose casts them (`None`:
/// built here, as db-mongodb `createVersion` sends it).
pub(crate) type Flip = Option<(RawDocumentBuf, RawDocumentBuf)>;

/// Decodes `{ op: "create", d?: <database>, c: <collection>, doc | dob, v?: { c, doc | dob, ff?,
/// fu? } }`: `doc` the document as a subdocument (the temporary TS prepare,
/// src/fuse-write/mongo.ts), `dob` its BSON bytes (WP-I's prepare, `fuseWritePrepare`), `ff` /
/// `fu` the flip's filter and update from that prepare.
pub fn decode(bytes: &[u8]) -> Result<OpRequest, String> {
  let request = RawDocument::from_bytes(bytes).map_err(|e| e.to_string())?;
  let op = match request.get_str("op").map_err(|e| e.to_string())? {
    "create" => Op::Create,
    other => return Err(format!("op:{other}")),
  };
  let database = request.get_str("d").ok().map(str::to_string);
  let collection = request.get_str("c").map_err(|e| e.to_string())?.to_string();
  let doc = document(request, "doc", "dob")?;
  let version = match request.get_document("v") {
    Ok(v) => {
      let flip = match (v.get_binary("ff"), v.get_binary("fu")) {
        (Ok(filter), Ok(update)) => Some((
          RawDocumentBuf::from_bytes(filter.bytes.to_vec()).map_err(|e| e.to_string())?,
          RawDocumentBuf::from_bytes(update.bytes.to_vec()).map_err(|e| e.to_string())?,
        )),
        _ => None,
      };
      Some((v.get_str("c").map_err(|e| e.to_string())?.to_string(), document(v, "doc", "dob")?, flip))
    }
    Err(_) => None,
  };
  let mut statements = match op {
    Op::Create => create_statements(&collection, doc, version)?,
  };
  for statement in &mut statements {
    statement.database.clone_from(&database);
  }
  let unique = match request.get_document("ut") {
    Ok(templates) => {
      let mut lookups = Vec::new();
      for entry in request.get_array("u").map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?.as_array().ok_or("create:u")?;
        let mut parts = entry.into_iter();
        let mut next = || parts.next().ok_or("create:u").and_then(|p| p.map_err(|_| "create:u"));
        let path = next()?.as_str().ok_or("create:u")?.to_string();
        let locale = next()?.as_str().ok_or("create:u")?.to_string();
        let value = Bson::try_from(next()?.to_raw_bson()).map_err(|e| e.to_string())?;
        lookups.push((path, locale, value));
      }
      Some((crate::unique::decode(templates)?, lookups))
    }
    Err(_) => None,
  };
  Ok(OpRequest { op, database, statements, unique })
}

/// The document at `key` (a subdocument) or at `bytes_key` (its BSON bytes).
fn document(owner: &RawDocument, key: &str, bytes_key: &str) -> Result<RawDocumentBuf, String> {
  if let Ok(doc) = owner.get_document(key) {
    return Ok(doc.to_raw_document_buf());
  }
  let bytes = owner.get_binary(bytes_key).map_err(|e| e.to_string())?;
  RawDocumentBuf::from_bytes(bytes.bytes.to_vec()).map_err(|e| e.to_string())
}

fn create_statements(
  collection: &str,
  doc: RawDocumentBuf,
  version: Option<(String, RawDocumentBuf, Flip)>,
) -> Result<Vec<Statement>, String> {
  let mut statements = vec![Statement {
    database: None,
    command: rawdoc! { "insert": collection, "documents": [doc], "ordered": true },
    in_txn: true,
    result: ResultOf::Inserted,
  }];
  if let Some((versions, version, flip)) = version {
    statements.extend(version_statements(&versions, version, flip)?);
  }
  Ok(statements)
}

/// db-mongodb `createVersion`'s statements: the version insert, then the latest flip (none when
/// its update is empty).
pub(crate) fn version_statements(versions: &str, version: RawDocumentBuf, flip: Flip) -> Result<Vec<Statement>, String> {
  let (filter, update) = match flip {
    Some(flip) => flip,
    None => built_flip(&version)?,
  };
  let mut statements = vec![Statement {
    database: None,
    command: rawdoc! { "insert": versions, "documents": [version], "ordered": true },
    in_txn: true,
    result: ResultOf::None,
  }];
  if !update.is_empty() {
    statements.push(Statement {
      database: None,
      command: rawdoc! {
        "update": versions,
        "updates": [{ "q": filter, "u": update, "multi": true }],
        "ordered": true,
      },
      in_txn: true,
      result: ResultOf::None,
    });
  }
  Ok(statements)
}

/// db-mongodb `createVersion`'s flip for `version`: the parent's other latest versions older than it.
fn built_flip(version: &RawDocumentBuf) -> Result<(RawDocumentBuf, RawDocumentBuf), String> {
  let id = version.get_object_id("_id").map_err(|_| "version:_id")?;
  let parent = version.get("parent").map_err(|e| e.to_string())?.ok_or("version:parent")?.to_raw_bson();
  let updated_at = match version.get("updatedAt").map_err(|e| e.to_string())? {
    Some(value @ RawBsonRef::DateTime(_)) => value.to_raw_bson(),
    _ => return Err("version:updatedAt".to_string()),
  };
  let filter = rawdoc! {
    "$and": [
      { "_id": { "$ne": id } },
      { "$or": [{ "parent": { "$eq": parent } }] },
      { "latest": { "$eq": true } },
      { "updatedAt": { "$lt": updated_at } },
    ]
  };
  Ok((filter, rawdoc! { "$unset": { "latest": 1 } }))
}
