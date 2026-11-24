//! The operation drivers of the fused writes (FUSED_WRITES.md section 11): one operation's
//! statements, in upstream's order, built from its prepared documents.
//!
//! `create` (packages/payload/src/collections/operations/create.ts, db-mongodb `create` /
//! `createVersion`):
//!
//! 1. `insert <collection>` of the document (`Model.create([data], { session })`);
//! 2. with versions: `insert <versions collection>` of the version document, then the latest flip
//!    (`updateMany` unsetting `latest` on the parent's other latest versions older than it);
//! 3. no `enforceMaxVersions` find: the document's id was generated in this call, so the parent
//!    has no other version (owner decision 2026-11-24; the plan flag `m` is set by the JS side
//!    only then);
//!
//! then the result's `afterRead` (population in the transaction) on the inserted document and the
//! commit ([`crate::finish`]).

use payload_mongo_driver::mongodb::bson::{RawBsonRef, RawDocument, RawDocumentBuf, rawdoc};

use crate::prepare_stub::{WriteCtx, prepare_create};
use crate::{ResultOf, Statement};

pub enum Op {
  Create,
}

pub struct OpRequest {
  pub op: Op,
  pub database: Option<String>,
  pub statements: Vec<Statement>,
}

/// Decodes `{ op: "create", d?: <database>, c: <collection>, doc?: <document>, v?: { c, doc },
/// m: <skip max versions>, p?: { plan, data, clock, ids } }`: with `doc` the document the JS side
/// prepared (temporary TS prepare, src/fuse-write/prepare.ts), else `p` for the Rust prepare.
pub fn decode(bytes: &[u8]) -> Result<OpRequest, String> {
  let request = RawDocument::from_bytes(bytes).map_err(|e| e.to_string())?;
  let op = match request.get_str("op").map_err(|e| e.to_string())? {
    "create" => Op::Create,
    other => return Err(format!("op:{other}")),
  };
  let database = request.get_str("d").ok().map(str::to_string);
  let collection = request.get_str("c").map_err(|e| e.to_string())?.to_string();
  let (doc, version) = match request.get_document("doc") {
    Ok(doc) => {
      let version = match request.get_document("v") {
        Ok(v) => Some((
          v.get_str("c").map_err(|e| e.to_string())?.to_string(),
          v.get_document("doc").map_err(|e| e.to_string())?.to_raw_document_buf(),
        )),
        Err(_) => None,
      };
      (doc.to_raw_document_buf(), version)
    }
    Err(_) => {
      let input = request.get_document("p").map_err(|e| e.to_string())?;
      let ctx = decode_ctx(input)?;
      let plan = input.get_i32("plan").map_err(|e| e.to_string())? as u32;
      let data = input.get_str("data").map_err(|e| e.to_string())?;
      let prepared = prepare_create(plan, data, &ctx).map_err(|bail| bail.0)?;
      let version_collection = request.get_str("vc").ok().map(str::to_string);
      (prepared.doc, version_collection.zip(prepared.version))
    }
  };
  let mut statements = match op {
    Op::Create => create_statements(&collection, doc, version)?,
  };
  for statement in &mut statements {
    statement.database.clone_from(&database);
  }
  Ok(OpRequest { op, database, statements })
}

fn decode_ctx(input: &RawDocument) -> Result<WriteCtx, String> {
  let mut clock = Vec::new();
  for value in input.get_array("clock").map_err(|e| e.to_string())? {
    clock.push(value.map_err(|e| e.to_string())?.as_str().ok_or("ctx:clock")?.to_string());
  }
  let mut ids = Vec::new();
  for value in input.get_array("ids").map_err(|e| e.to_string())? {
    ids.push(value.map_err(|e| e.to_string())?.as_object_id().ok_or("ctx:ids")?);
  }
  Ok(WriteCtx {
    clock,
    ids,
    user_json: input.get_str("user").ok().map(str::to_string),
    locale: input.get_str("locale").ok().map(str::to_string),
  })
}

fn create_statements(
  collection: &str,
  doc: RawDocumentBuf,
  version: Option<(String, RawDocumentBuf)>,
) -> Result<Vec<Statement>, String> {
  let mut statements = vec![Statement {
    database: None,
    command: rawdoc! { "insert": collection, "documents": [doc], "ordered": true },
    in_txn: true,
    result: ResultOf::Inserted,
  }];
  if let Some((versions, version)) = version {
    let id = version.get_object_id("_id").map_err(|_| "version:_id")?;
    let parent = version.get("parent").map_err(|e| e.to_string())?.ok_or("version:parent")?.to_raw_bson();
    let updated_at = match version.get("updatedAt").map_err(|e| e.to_string())? {
      Some(value @ RawBsonRef::DateTime(_)) => value.to_raw_bson(),
      _ => return Err("version:updatedAt".to_string()),
    };
    let flip = rawdoc! {
      "$and": [
        { "_id": { "$ne": id } },
        { "$or": [{ "parent": { "$eq": parent } }] },
        { "latest": { "$eq": true } },
        { "updatedAt": { "$lt": updated_at } },
      ]
    };
    statements.push(Statement {
      database: None,
      command: rawdoc! { "insert": versions.as_str(), "documents": [version], "ordered": true },
      in_txn: true,
      result: ResultOf::None,
    });
    statements.push(Statement {
      database: None,
      command: rawdoc! {
        "update": versions.as_str(),
        "updates": [{ "q": flip, "u": { "$unset": { "latest": 1 } }, "multi": true }],
        "ordered": true,
      },
      in_txn: true,
      result: ResultOf::None,
    });
  }
  Ok(statements)
}
