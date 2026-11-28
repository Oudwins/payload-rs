//! The driver lane of the Payload MongoDB adapter (RUST_PERF_PLAN.md S3, work package B): Payload's
//! MongoDB reads run on a Rust `mongodb` client (tokio), the documents are decoded, transformed
//! (db-mongodb's read `transform`) and written as JSON in Rust, and JS materializes them with one
//! `JSON.parse`. Contract: packages/engine-rs/MONGO_DRIVER_CONTRACT.md.
//!
//! No Node dependency: crates/payload-node/src/mongo_driver.rs binds it.

pub mod client;
pub mod json;
pub mod transform;
pub mod value;

use mongodb::bson::{Bson, Document};
use mongodb::options::{Collation, Hint};

pub use client::{
  ConnectInfo, ConnectSpec, CountSpec, FindSpec, LaneError, ReadTarget, aggregate, aggregate_docs_raw, aggregate_raw, close, command, connect, count,
  command_raw, database_name, find_one, find_one_raw, find_raw, paginate, register_plan, runtime, transform_raw, txn_begin,
  txn_command, txn_command_raw, txn_end,
};
pub use transform::Flags;
/// The driver crate itself (bson types for the binding).
pub use mongodb;

/// Arguments the JS glue sends as one js-bson document (MONGO_DRIVER_CONTRACT.md "Arguments").
pub struct ReadArgs {
  pub database: Option<String>,
  pub collection: String,
  pub find: Option<FindSpec>,
  pub count: CountSpec,
  pub pipeline: Option<Vec<Document>>,
  pub collation: Option<Collation>,
  pub flags: Flags,
  /// The Rust-owned transaction the read runs in (`txn`, see [`client::txn_begin`]).
  pub txn: Option<u32>,
}

fn bad(what: &str) -> LaneError {
  LaneError::Driver(format!("invalid driver lane arguments: {what}"))
}

fn integer(value: &Bson) -> Option<i64> {
  match value {
    Bson::Int32(n) => Some(*n as i64),
    Bson::Int64(n) => Some(*n),
    Bson::Double(n) if n.fract() == 0.0 && n.is_finite() => Some(*n as i64),
    _ => None,
  }
}

fn collation(value: Option<&Bson>) -> Result<Option<Collation>, LaneError> {
  match value {
    None | Some(Bson::Null) => Ok(None),
    Some(Bson::Document(doc)) => mongodb::bson::from_document::<Collation>(doc.clone())
      .map(Some)
      .map_err(|_| LaneError::Bail("unsupported collation")),
    Some(_) => Err(bad("collation")),
  }
}

fn hint(value: Option<&Bson>) -> Result<Option<Hint>, LaneError> {
  match value {
    None | Some(Bson::Null) => Ok(None),
    Some(Bson::Document(doc)) => Ok(Some(Hint::Keys(doc.clone()))),
    Some(Bson::String(name)) => Ok(Some(Hint::Name(name.clone()))),
    Some(_) => Err(bad("hint")),
  }
}

fn document(value: Option<&Bson>, what: &str) -> Result<Option<Document>, LaneError> {
  match value {
    None | Some(Bson::Null) => Ok(None),
    Some(Bson::Document(doc)) => Ok(Some(doc.clone())),
    Some(_) => Err(bad(what)),
  }
}

/// A find spec (`{ filter, sort?, projection?, skip?, limit?, collation?, hint? }`, js-bson).
pub fn find_spec(doc: &Document) -> Result<FindSpec, LaneError> {
  let filter = document(doc.get("filter"), "filter")?.unwrap_or_default();
  let skip = match doc.get("skip") {
    None | Some(Bson::Null) => None,
    Some(value) => Some(integer(value).and_then(|n| u64::try_from(n).ok()).ok_or_else(|| bad("skip"))?),
  };
  let limit = match doc.get("limit") {
    None | Some(Bson::Null) => None,
    Some(value) => Some(integer(value).ok_or_else(|| bad("limit"))?),
  };
  Ok(FindSpec {
    collation: collation(doc.get("collation"))?,
    filter,
    hint: hint(doc.get("hint"))?,
    limit,
    projection: document(doc.get("projection"), "projection")?,
    skip,
    sort: document(doc.get("sort"), "sort")?,
  })
}

/// Decodes the js-bson arguments of a lane call.
pub fn read_args(bytes: &[u8]) -> Result<ReadArgs, LaneError> {
  let doc = Document::from_reader(bytes).map_err(|e| bad(&e.to_string()))?;
  let collection = doc.get_str("collection").map_err(|_| bad("collection"))?.to_string();
  let database = doc.get_str("database").ok().map(str::to_string);
  let find = match doc.get("find") {
    Some(Bson::Document(find)) => Some(find_spec(find)?),
    None | Some(Bson::Null) => None,
    Some(_) => return Err(bad("find")),
  };
  let count = match doc.get("count") {
    None | Some(Bson::Null) => CountSpec::None,
    Some(Bson::String(mode)) if mode == "estimated" => CountSpec::Estimated,
    Some(Bson::Document(count)) => CountSpec::Documents {
      collation: collation(count.get("collation"))?,
      filter: document(count.get("filter"), "count filter")?.unwrap_or_default(),
      hint: hint(count.get("hint"))?,
    },
    Some(_) => return Err(bad("count")),
  };
  let pipeline = match doc.get("pipeline") {
    None | Some(Bson::Null) => None,
    Some(Bson::Array(stages)) => Some(
      stages
        .iter()
        .map(|stage| match stage {
          Bson::Document(stage) => Ok(stage.clone()),
          _ => Err(bad("pipeline stage")),
        })
        .collect::<Result<Vec<_>, _>>()?,
    ),
    Some(_) => return Err(bad("pipeline")),
  };
  Ok(ReadArgs {
    collation: collation(doc.get("collation"))?,
    collection,
    count,
    database,
    find,
    flags: Flags { allow_additional_keys: doc.get_bool("allowAdditionalKeys").unwrap_or(false) },
    pipeline,
    txn: match doc.get("txn") {
      None | Some(Bson::Null) => None,
      Some(value) => Some(integer(value).and_then(|n| u32::try_from(n).ok()).ok_or_else(|| bad("txn"))?),
    },
  })
}
