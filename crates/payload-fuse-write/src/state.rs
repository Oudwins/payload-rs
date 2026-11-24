//! The write lane-shadow's view of the database (FUSED_WRITES.md section 9): the documents a write
//! touched, per collection, as canonical extended JSON (BSON types kept: ObjectId vs string, Date
//! vs string, Int32 vs Int64 vs Double), read with the same finds after both lanes. The fused lane
//! reads them inside its transaction before the abort, the exact lane after its commit.

use payload_mongo_driver::mongodb::bson::{Bson, Document, RawBsonRef, RawDocument};
use payload_mongo_driver::{FindSpec, find_raw};

pub struct StateRead {
  pub collection: String,
  pub filter: Document,
  pub sort: Option<Document>,
}

/// Decodes `{ d?: <database>, r: [{ c: <collection>, f: <filter>, s?: <sort> }] }`.
pub fn decode_state_reads(bytes: &[u8]) -> Result<(Option<String>, Vec<StateRead>), String> {
  let doc = RawDocument::from_bytes(bytes).map_err(|e| e.to_string())?;
  let database = doc.get_str("d").ok().map(str::to_string);
  let mut reads = Vec::new();
  for item in doc.get_array("r").map_err(|e| e.to_string())? {
    let RawBsonRef::Document(item) = item.map_err(|e| e.to_string())? else {
      return Err("state read".to_string());
    };
    let collection = item.get_str("c").map_err(|e| e.to_string())?.to_string();
    let filter = Document::try_from(item.get_document("f").map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let sort = match item.get_document("s") {
      Ok(sort) => Some(Document::try_from(sort).map_err(|e| e.to_string())?),
      Err(_) => None,
    };
    reads.push(StateRead { collection, filter, sort });
  }
  Ok((database, reads))
}

/// `[[<doc>, ...], ...]` per read, canonical extended JSON, in the reads' sort order.
pub async fn read_state(
  client: u32,
  database: Option<&str>,
  txn: Option<u32>,
  reads: &[StateRead],
) -> Result<String, String> {
  let mut out = Vec::with_capacity(reads.len());
  for read in reads {
    let find = FindSpec { filter: read.filter.clone(), sort: read.sort.clone(), ..FindSpec::default() };
    let docs = find_raw(client, database, &read.collection, find, txn).await.map_err(|e| e.to_string())?;
    let mut values = Vec::with_capacity(docs.len());
    for raw in docs {
      let doc = Document::try_from(raw.as_ref()).map_err(|e| e.to_string())?;
      values.push(Bson::Document(doc).into_canonical_extjson());
    }
    out.push(serde_json::Value::Array(values));
  }
  Ok(serde_json::Value::Array(out).to_string())
}
