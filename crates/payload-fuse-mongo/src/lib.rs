//! The MongoDB backend of the fused read lanes (packages/engine-rs/FUSE_CONTRACT.md section 8): a
//! fused `find` / `findByID` / `count` runs the reads the driver lane would run for
//! `payload.db.find` / `findOne` / `count` (MONGO_DRIVER_CONTRACT.md: the commands
//! mongoose-paginate-v2 / mongoose would send, on the Rust `mongodb` client), the driver crate's
//! read `transform`, and the fused operation's `afterRead` (crates/payload-fuse), and writes the
//! operation's result JSON, without JS in between.
//!
//! The commands arrive built (js-bson): the TS side (packages/engine-rs/src/fuse/mongo.ts) builds
//! them like the driver lane, from upstream's query planning and the casting mongoose would
//! apply. [`run`] does the I/O on the driver runtime, then hands the documents to the fused core.

use std::sync::{Arc, Mutex};

use payload_engine::js::{JsVal, Obj as JsObj};
use payload_fuse::plan::{CollectionPlan, Field, Kind};
use payload_fuse::{Bail, FuseResult, FusedBackend, Job, RawLeaves, ReadSession, Related};
use payload_mongo_driver::client::{DriverClient, client, plan};
use payload_mongo_driver::mongodb::{self, Collection};
use payload_mongo_driver::mongodb::bson::oid::ObjectId;
use payload_mongo_driver::mongodb::bson::{Bson, Document, RawDocument, RawDocumentBuf};
use payload_mongo_driver::mongodb::options::{CountOptions, EstimatedDocumentCountOptions, FindOneOptions, FindOptions};
use payload_mongo_driver::transform::{Plan, ReadShape, transform_read};
use payload_mongo_driver::value::{V, decode_array, decode_document};
use payload_mongo_driver::{CountSpec, FindSpec, Flags, LaneError, read_args};

/// The reads of one fused call (js-bson): the driver lane's `ReadArgs` (`collection`,
/// `database`, `find`, `count`, `allowAdditionalKeys`) plus `op` (`find` | `findOne` | `count`)
/// and, for `find`, the inputs of mongoose-paginate-v2's result `meta`: `{ pagination, limit,
/// page }` (its local `pagination`, `limit` and `page` after option parsing).
pub struct MongoReads {
  database: Option<String>,
  collection: String,
  op: ReadOp,
  find: Option<FindSpec>,
  count: CountSpec,
  flags: Flags,
}

#[derive(Clone, Copy)]
enum ReadOp {
  Find { pagination: bool, limit: f64, page: f64 },
  FindOne,
  Count,
}

impl MongoReads {
  pub fn decode(bytes: &[u8]) -> Result<Self, LaneError> {
    let args = read_args(bytes)?;
    let doc = Document::from_reader(bytes).map_err(|_| LaneError::Bail("args"))?;
    let number = |value: Option<&Bson>| match value {
      Some(Bson::Int32(n)) => Some(*n as f64),
      Some(Bson::Int64(n)) => Some(*n as f64),
      Some(Bson::Double(n)) => Some(*n),
      _ => None,
    };
    let op = match doc.get_str("op") {
      Ok("find") => {
        let meta = doc.get_document("meta").map_err(|_| LaneError::Bail("meta"))?;
        ReadOp::Find {
          pagination: meta.get_bool("pagination").map_err(|_| LaneError::Bail("meta"))?,
          limit: number(meta.get("limit")).ok_or(LaneError::Bail("meta"))?,
          page: number(meta.get("page")).ok_or(LaneError::Bail("meta"))?,
        }
      }
      Ok("findOne") => ReadOp::FindOne,
      Ok("count") => ReadOp::Count,
      _ => return Err(LaneError::Bail("op")),
    };
    Ok(Self {
      database: args.database,
      collection: args.collection,
      op,
      find: args.find,
      count: args.count,
      flags: args.flags,
    })
  }
}

/// What the reads returned: the documents decoded, transformed and converted.
enum Loaded {
  Page { count: Option<u64>, docs: Vec<JsVal>, pagination: bool, limit: f64, page: f64 },
  One(Option<JsVal>),
  Count(u64),
}

/// How the documents of a call become the core's values ([`document`]).
#[derive(Clone)]
struct Convert {
  plan: Arc<Plan>,
  flags: Flags,
  /// the collection plan of the operation (`None`: the request does not decode; the core bails)
  fields: Option<Arc<CollectionPlan>>,
  /// raw json / rich text leaves (not in canonical text)
  leaves: Option<RawLeaves>,
}

impl Convert {
  fn document(&self, raw: &RawDocument, lean_with_id: bool) -> FuseResult<JsVal> {
    document(&self.plan, self.flags, raw, lean_with_id, self.fields.as_deref(), self.leaves.as_ref())
  }
}

/// Runs `reads` on client `client_id`, then the fused operation `request_json` on their
/// documents (driver transform plan `plan_id`). Returns the result JSON or `!<reason>`.
pub async fn run(client_id: u32, plan_id: u32, reads: MongoReads, request_json: String) -> String {
  let plan = match plan(plan_id) {
    Ok(plan) => plan,
    Err(_) => return "!mongo:plan".to_string(),
  };
  let (fields, canonical) = match payload_fuse::peek_request(&request_json) {
    Some((fields, canonical)) => (Some(fields), canonical),
    None => (None, false),
  };
  let convert = Convert { plan: Arc::clone(&plan), flags: reads.flags, leaves: (!canonical).then(RawLeaves::default), fields };
  let loaded = match load(client_id, &reads, &convert).await {
    Ok(loaded) => loaded,
    Err(Failure::Lane(LaneError::Bail(reason))) => return format!("!mongo:{reason}"),
    Err(Failure::Lane(LaneError::Driver(_))) => return "!mongo:driver".to_string(),
    Err(Failure::Fuse(Bail(reason))) => return format!("!{reason}"),
  };
  let backend = MongoBackend {
    client: client_id,
    txn: None,
    database: reads.database,
    loaded: Mutex::new(Some(loaded)),
    leaves: convert.leaves.clone(),
    flags: reads.flags,
  };
  // nested finds of relationship population block this worker (`block_in_place`)
  payload_fuse::run(&backend, 0, &request_json)
}

/// The fused `findByID` request `request_json` on `doc` (the document a fused write stored or
/// changed, as the database holds it) instead of a read, with population's nested reads in the
/// Rust-owned transaction `txn` (the fused write lanes, packages/engine-rs/FUSED_WRITES.md). The
/// collection and flags are those of `reads`. Runs on a driver runtime worker.
pub fn run_document(
  client_id: u32,
  plan_id: u32,
  reads: &MongoReads,
  doc: Option<RawDocumentBuf>,
  request_json: &str,
  txn: Option<u32>,
) -> String {
  let plan = match plan(plan_id) {
    Ok(plan) => plan,
    Err(_) => return "!mongo:plan".to_string(),
  };
  let (fields, canonical) = match payload_fuse::peek_request(request_json) {
    Some((fields, canonical)) => (Some(fields), canonical),
    None => (None, false),
  };
  let convert = Convert { plan, flags: reads.flags, leaves: (!canonical).then(RawLeaves::default), fields };
  let doc = match doc.map(|raw| convert.document(&raw, false)).transpose() {
    Ok(doc) => doc,
    Err(Bail(reason)) => return format!("!{reason}"),
  };
  let backend = MongoBackend {
    client: client_id,
    txn,
    database: reads.database.clone(),
    loaded: Mutex::new(Some(Loaded::One(doc))),
    leaves: convert.leaves.clone(),
    flags: reads.flags,
  };
  payload_fuse::run(&backend, 0, request_json)
}

/// updateByID's stored-document read (`getLatestCollectionVersion`'s `payload.db.findOne`) inside
/// the Rust-owned transaction `txn`: the `findOne` of `reads` (the write's result read, whose
/// `findOne` is that same read), the raw document or `None`.
pub async fn find_stored(client_id: u32, reads: &MongoReads, txn: u32) -> Result<Option<RawDocumentBuf>, String> {
  let (ReadOp::FindOne, Some(find)) = (reads.op, reads.find.as_ref()) else {
    return Err("stored:read".to_string());
  };
  let find = FindSpec {
    filter: find.filter.clone(),
    sort: find.sort.clone(),
    projection: find.projection.clone(),
    skip: find.skip,
    limit: find.limit,
    collation: find.collation.clone(),
    hint: find.hint.clone(),
  };
  payload_mongo_driver::find_one_raw(client_id, reads.database.as_deref(), &reads.collection, find, Some(txn))
    .await
    .map_err(|error| match error {
      LaneError::Bail(reason) => format!("stored:{reason}"),
      LaneError::Driver(_) => "stored:driver".to_string(),
    })
}

/// updateByID's `docWithLocales` (the stored document `raw` after db-mongodb's read transform, as
/// `findOne` returns it) and `originalDoc` (`afterRead` of a copy at depth 0,
/// `payload_fuse::after_read_original` with the result read `request_json`), with the transform
/// plan `plan_id` and the flags of `reads`.
pub fn update_inputs(plan_id: u32, reads: &MongoReads, raw: &RawDocument, request_json: &str) -> FuseResult<(JsVal, JsVal)> {
  let plan = plan(plan_id).map_err(|_| bail("plan"))?;
  let mut doc = decode_document(raw).map_err(|b| bail(b.0))?;
  transform_read(&plan, reads.flags, ReadShape { lean_with_id: false }, &mut doc).map_err(|b| bail(b.0))?;
  let doc_with_locales = to_js(V::Obj(doc), 0)?;
  let mut original = doc_with_locales.clone();
  payload_fuse::after_read_original(request_json, &mut original)?;
  Ok((doc_with_locales, original))
}

enum Failure {
  Lane(LaneError),
  Fuse(Bail),
}

impl From<LaneError> for Failure {
  fn from(error: LaneError) -> Self {
    Failure::Lane(error)
  }
}

impl From<mongodb::error::Error> for Failure {
  fn from(error: mongodb::error::Error) -> Self {
    Failure::Lane(LaneError::from(error))
  }
}

impl From<Bail> for Failure {
  fn from(bail: Bail) -> Self {
    Failure::Fuse(bail)
  }
}

fn collection(state: &DriverClient, database: Option<&str>, name: &str) -> Collection<RawDocumentBuf> {
  state.client.database(database.unwrap_or(&state.default_database)).collection(name)
}

async fn run_count(coll: &Collection<RawDocumentBuf>, count: &CountSpec) -> Result<Option<u64>, LaneError> {
  Ok(match count {
    CountSpec::None => None,
    CountSpec::Estimated => {
      Some(coll.estimated_document_count().with_options(EstimatedDocumentCountOptions::default()).await?)
    }
    CountSpec::Documents { filter, hint, collation } => {
      let mut options = CountOptions::default();
      options.hint = hint.clone();
      options.collation = collation.clone();
      Some(coll.count_documents(filter.clone()).with_options(options).await?)
    }
  })
}

/// Documents per conversion task: larger results are converted on the driver runtime's workers
/// while the cursor still yields (chunks joined in order), like the driver lane's transform.
const CHUNK: usize = 32;

fn find_options(find: &FindSpec) -> FindOptions {
  let mut options = FindOptions::default();
  options.sort = find.sort.clone();
  options.projection = find.projection.clone();
  options.skip = find.skip;
  options.limit = find.limit;
  options.collation = find.collation.clone();
  options.hint = find.hint.clone();
  options
}

/// The find's documents, converted by `convert` (`lean_with_id`: read through `Model.paginate`).
async fn run_find(
  coll: &Collection<RawDocumentBuf>,
  find: Option<&FindSpec>,
  convert: &Convert,
  lean_with_id: bool,
) -> Result<Vec<JsVal>, Failure> {
  let Some(find) = find else { return Ok(Vec::new()) };
  let mut cursor = coll.find(find.filter.clone()).with_options(find_options(find)).await?;
  let mut tasks = Vec::new();
  let mut chunk = Vec::with_capacity(CHUNK);
  while cursor.advance().await? {
    chunk.push(cursor.current().to_raw_document_buf());
    if chunk.len() == CHUNK {
      let docs = std::mem::replace(&mut chunk, Vec::with_capacity(CHUNK));
      let convert = convert.clone();
      tasks.push(tokio::spawn(async move {
        docs.iter().map(|raw| convert.document(raw, lean_with_id)).collect::<FuseResult<Vec<_>>>()
      }));
    }
  }
  // the last chunk in this task, while the spawned ones run on the other workers
  let tail = chunk.iter().map(|raw| convert.document(raw, lean_with_id)).collect::<FuseResult<Vec<_>>>()?;
  let mut docs = Vec::new();
  for task in tasks {
    docs.extend(task.await.map_err(|_| LaneError::Bail("conversion task failed"))??);
  }
  docs.extend(tail);
  Ok(docs)
}

async fn load(client_id: u32, reads: &MongoReads, convert: &Convert) -> Result<Loaded, Failure> {
  let state = client(client_id)?;
  let coll = collection(&state, reads.database.as_deref(), &reads.collection);
  Ok(match reads.op {
    ReadOp::Find { pagination, limit, page } => {
      // mongoose-paginate-v2: the count is started first, both in flight
      let (count, docs) =
        tokio::join!(run_count(&coll, &reads.count), run_find(&coll, reads.find.as_ref(), convert, true));
      Loaded::Page { count: count?, docs: docs?, pagination, limit, page }
    }
    ReadOp::FindOne => {
      let find = reads.find.as_ref().ok_or(LaneError::Bail("findOne without find"))?;
      let mut options = FindOneOptions::default();
      options.sort = find.sort.clone();
      options.projection = find.projection.clone();
      options.skip = find.skip;
      options.collation = find.collation.clone();
      options.hint = find.hint.clone();
      match coll.find_one(find.filter.clone()).with_options(options).await? {
        Some(raw) => Loaded::One(Some(convert.document(&raw, false)?)),
        None => Loaded::One(None),
      }
    }
    ReadOp::Count => Loaded::Count(run_count(&coll, &reads.count).await?.ok_or(LaneError::Bail("no count"))?),
  })
}

/// The fused core's view of the loaded reads: each read is served once, in the operation's order.
struct MongoBackend {
  client: u32,
  /// The Rust-owned transaction nested reads run in (fused writes, [`run_document`]).
  txn: Option<u32>,
  database: Option<String>,
  loaded: Mutex<Option<Loaded>>,
  leaves: Option<RawLeaves>,
  flags: Flags,
}

impl FusedBackend for MongoBackend {
  fn name(&self) -> &'static str {
    "mongodb"
  }

  fn run(&self, _conn: u32, job: Job) -> FuseResult<String> {
    let loaded = self.loaded.lock().unwrap_or_else(|e| e.into_inner()).take();
    let mut session = MongoSession { backend: self, loaded };
    job(&mut session)
  }
}

struct MongoSession<'p> {
  backend: &'p MongoBackend,
  loaded: Option<Loaded>,
}

fn bail(reason: &'static str) -> Bail {
  Bail::new(format!("mongo:{reason}"))
}

impl MongoSession<'_> {
  fn page(&mut self) -> FuseResult<JsVal> {
    let Some(Loaded::Page { count, docs, pagination, limit, page }) = self.loaded.take() else {
      return Err(bail("read order"));
    };
    Ok(page_result(docs, count, pagination, limit, page))
  }

  fn one(&mut self) -> FuseResult<JsVal> {
    let Some(Loaded::One(doc)) = self.loaded.take() else { return Err(bail("read order")) };
    Ok(doc.unwrap_or(JsVal::Null))
  }
}

/// A document decoded and transformed (`transform_read` of `plan`), as the core's value. With the
/// collection plan `fields` and raw `leaves` (not in canonical text), json / rich text subtrees the
/// transform left raw stay JSON text ([`RawLeaves`]).
fn document(
  plan: &Plan,
  flags: Flags,
  raw: &RawDocument,
  lean_with_id: bool,
  fields: Option<&CollectionPlan>,
  leaves: Option<&RawLeaves>,
) -> FuseResult<JsVal> {
  let mut doc = decode_document(raw).map_err(|b| bail(b.0))?;
  transform_read(plan, flags, ReadShape { lean_with_id }, &mut doc).map_err(|b| bail(b.0))?;
  match (fields, leaves) {
    (Some(collection), Some(leaves)) => {
      let planned = Planned { collection, leaves, localized: plan.localization.is_some() };
      planned.object(doc, &collection.fields, false, 0)
    }
    _ => to_js(V::Obj(doc), 0),
  }
}

impl ReadSession for MongoSession<'_> {
  fn find(&mut self, _args: &JsVal) -> FuseResult<JsVal> {
    self.page()
  }

  fn find_one(&mut self, _args: &JsVal) -> FuseResult<JsVal> {
    self.one()
  }

  fn raw_leaves(&self) -> Option<RawLeaves> {
    self.backend.leaves.clone()
  }

  fn count(&mut self, _args: &JsVal) -> FuseResult<JsVal> {
    let Some(Loaded::Count(total)) = self.loaded.take() else { return Err(bail("read order")) };
    let mut out = JsObj::new();
    out.insert("totalDocs".to_string(), JsVal::Num(total as f64));
    Ok(JsVal::obj(out))
  }

  /// db-mongodb `find` of a nested find (`pagination: false`, `where: { and: [{ id: { in } }] }`):
  /// mongoose-paginate-v2's `Model.find(query, projection, { limit: 0 })` with the cast filter
  /// `{ $and: [{ _id: { $in: [ObjectId...] } }] }` and the sort / projection the TS side cast for
  /// the collection (`related.backend`: `{ collection, plan, sort, projection }`).
  fn populate_find(&mut self, _args: &JsVal, related: &Related, ids: &[JsVal]) -> FuseResult<Vec<JsVal>> {
    let backend = &related.backend;
    let collection_name = backend.get("collection").as_str().ok_or_else(|| bail("populate:backend"))?.to_string();
    let plan_id = backend.get("plan").as_num().ok_or_else(|| bail("populate:backend"))? as u32;
    let plan = plan(plan_id).map_err(|_| bail("plan"))?;
    let mut in_ids = Vec::with_capacity(ids.len());
    for id in ids {
      // `Types.ObjectId.isValid` strings become ObjectIds; only canonical hex ids are fused
      let hex = id.as_str().filter(|s| s.len() == 24 && s.bytes().all(|b| b.is_ascii_hexdigit()));
      let oid = hex.and_then(|hex| ObjectId::parse_str(hex).ok()).ok_or_else(|| bail("populate:id"))?;
      in_ids.push(Bson::ObjectId(oid));
    }
    let mut id_condition = Document::new();
    id_condition.insert("$in", Bson::Array(in_ids));
    let mut condition = Document::new();
    condition.insert("_id", id_condition);
    let mut filter = Document::new();
    filter.insert("$and", Bson::Array(vec![Bson::Document(condition)]));
    let find = FindSpec {
      filter,
      sort: to_document(backend.get("sort"))?,
      projection: to_document(backend.get("projection"))?,
      skip: None,
      limit: Some(0),
      collation: None,
      hint: None,
    };
    let convert = Convert {
      plan,
      flags: self.backend.flags,
      fields: Some(Arc::clone(&related.plan)),
      leaves: self.backend.leaves.clone(),
    };
    let lane_bail = |error: LaneError| match error {
      LaneError::Bail(reason) => bail(reason),
      LaneError::Driver(_) => bail("driver"),
    };
    if let Some(txn) = self.backend.txn {
      let database = self.backend.database.as_deref();
      let raws = tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(payload_mongo_driver::find_raw(
          self.backend.client,
          database,
          &collection_name,
          find,
          Some(txn),
        ))
      })
      .map_err(lane_bail)?;
      return raws.iter().map(|raw| convert.document(raw, true)).collect();
    }
    let state = client(self.backend.client).map_err(|_| bail("client"))?;
    let coll = collection(&state, self.backend.database.as_deref(), &collection_name);
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(run_find(&coll, Some(&find), &convert, true)))
      .map_err(|error| match error {
        Failure::Lane(error) => lane_bail(error),
        Failure::Fuse(bail) => bail,
      })
  }
}

/// A JSON-like sort / projection as js-bson serializes it (integers as int32).
fn to_document(value: &JsVal) -> FuseResult<Option<Document>> {
  match value {
    JsVal::Undefined | JsVal::Null => Ok(None),
    JsVal::Obj(props) => {
      let mut out = Document::new();
      for (key, value) in props.iter() {
        let bson = match value {
          JsVal::Bool(b) => Bson::Boolean(*b),
          JsVal::Num(n) if n.fract() == 0.0 && *n >= i32::MIN as f64 && *n <= i32::MAX as f64 && !(*n == 0.0 && n.is_sign_negative()) => {
            Bson::Int32(*n as i32)
          }
          JsVal::Num(n) => Bson::Double(*n),
          JsVal::Str(s) => Bson::String(s.to_string()),
          _ => return Err(bail("populate:backend")),
        };
        out.insert(key.clone(), bson);
      }
      Ok(Some(out))
    }
    _ => Err(bail("populate:backend")),
  }
}

/// mongoose-paginate-v2's result (`{ docs, ...meta }`, src/index.js) for db-mongodb's options
/// (never an `offset`; `lean`, `leanWithId`).
fn page_result(docs: Vec<JsVal>, count: Option<u64>, pagination: bool, limit: f64, page: f64) -> JsVal {
  let total = if pagination { count.map_or(f64::NAN, |n| n as f64) } else { docs.len() as f64 };
  let pages = if limit > 0.0 {
    let pages = (total / limit).ceil();
    // `Math.ceil(total / limit) || 1`
    JsVal::Num(if pages == 0.0 || pages.is_nan() { 1.0 } else { pages })
  } else {
    JsVal::Null
  };
  let mut meta_limit = JsVal::Num(total);
  let mut total_pages = JsVal::Num(1.0);
  let mut page_value = page;
  let mut paging_counter = (page - 1.0) * limit + 1.0;
  let mut has_prev = false;
  let mut has_next = false;
  let mut prev = JsVal::Null;
  let mut next = JsVal::Null;
  if pagination {
    meta_limit = JsVal::Num(limit);
    total_pages = pages.clone();
    if page > 1.0 {
      has_prev = true;
      prev = JsVal::Num(page - 1.0);
    }
    // `page < pages` (`null` is 0)
    let pages_number = match pages {
      JsVal::Num(n) => n,
      _ => 0.0,
    };
    if page < pages_number {
      has_next = true;
      next = JsVal::Num(page + 1.0);
    }
  }
  if limit == 0.0 {
    meta_limit = JsVal::Num(0.0);
    total_pages = JsVal::Num(1.0);
    page_value = 1.0;
    paging_counter = 1.0;
    prev = JsVal::Null;
    next = JsVal::Null;
    has_prev = false;
    has_next = false;
  }
  let mut out = JsObj::with_capacity(10);
  out.insert("docs".to_string(), JsVal::arr(docs));
  out.insert("totalDocs".to_string(), JsVal::Num(total));
  out.insert("limit".to_string(), meta_limit);
  out.insert("totalPages".to_string(), total_pages);
  out.insert("page".to_string(), JsVal::Num(page_value));
  out.insert("pagingCounter".to_string(), JsVal::Num(paging_counter));
  out.insert("hasPrevPage".to_string(), JsVal::Bool(has_prev));
  out.insert("hasNextPage".to_string(), JsVal::Bool(has_next));
  out.insert("prevPage".to_string(), prev);
  out.insert("nextPage".to_string(), next);
  JsVal::obj(out)
}

const MAX_DEPTH: usize = 400;

/// A transformed document value as the JS value `JSON.parse` of the driver lane's text gives:
/// subtrees the transform left raw are decoded with js-bson's promotions; values JSON cannot carry
/// bail (the exact lane serves the call).
fn to_js(value: V<'_>, depth: usize) -> FuseResult<JsVal> {
  if depth > MAX_DEPTH {
    return Err(bail("deep"));
  }
  Ok(match value {
    V::Undefined => JsVal::Undefined,
    V::Null => JsVal::Null,
    V::Bool(b) => JsVal::Bool(b),
    V::Num(n) => {
      if !n.is_finite() {
        return Err(bail("non-finite"));
      }
      JsVal::Num(n)
    }
    V::Int(i) => JsVal::Num(i as f64),
    V::Str(s) => JsVal::str(s.as_ref()),
    V::Arr(items) => JsVal::arr(items.into_iter().map(|item| to_js(item, depth + 1)).collect::<FuseResult<_>>()?),
    V::Obj(obj) => {
      let mut out = JsObj::with_capacity(obj.0.len());
      for (key, value) in obj.0 {
        let value = to_js(value, depth + 1)?;
        // a repeated key keeps its first position with the last value (`decode_document` already
        // merged repeats)
        out.insert(key.into_owned(), value);
      }
      JsVal::obj(out)
    }
    V::RawDoc(doc) => to_js(V::Obj(decode_document(doc).map_err(|b| bail(b.0))?), depth)?,
    V::RawArr(array) => to_js(V::Arr(decode_array(array).map_err(|b| bail(b.0))?), depth)?,
    V::ObjectId(_) => return Err(bail("objectid")),
    V::Date(_) => return Err(bail("date")),
    V::Opaque(what) => return Err(bail(what)),
  })
}

/// The conversion of a transformed document guided by the collection plan: the same values as
/// [`to_js`], except that a raw (not yet decoded) object holding a whole json or rich text value
/// (one the `afterRead` traversal does not look into: a json leaf, rich text without node types
/// that have `afterRead` work) is kept as its JSON text.
struct Planned<'p> {
  collection: &'p CollectionPlan,
  leaves: &'p RawLeaves,
  /// localized fields hold `{ [locale]: value }`
  localized: bool,
}

impl Planned<'_> {
  fn object(&self, obj: payload_mongo_driver::value::Obj<'_>, fields: &[Field], parent_localized: bool, depth: usize) -> FuseResult<JsVal> {
    if depth > MAX_DEPTH {
      return Err(bail("deep"));
    }
    let mut out = JsObj::with_capacity(obj.0.len());
    for (key, value) in obj.0 {
      let value = match find_field(fields, &key) {
        Some(field) => self.field(value, field, parent_localized, depth + 1)?,
        None => to_js(value, depth + 1)?,
      };
      out.insert(key.into_owned(), value);
    }
    Ok(JsVal::obj(out))
  }

  /// The value of `field` (for a localized field, its `{ [locale]: value }` object).
  fn field(&self, mut value: V<'_>, field: &Field, parent_localized: bool, depth: usize) -> FuseResult<JsVal> {
    if self.localized && field.localized && !parent_localized && value.is_plain_object() {
      let Some(locales) = value.obj_mut().map_err(|b| bail(b.0))?.map(std::mem::take) else { return to_js(value, depth) };
      let mut out = JsObj::with_capacity(locales.0.len());
      for (locale, localized) in locales.0 {
        out.insert(locale.into_owned(), self.value(localized, field, true, depth + 1)?);
      }
      return Ok(JsVal::obj(out));
    }
    self.value(value, field, parent_localized || field.localized, depth)
  }

  fn value(&self, value: V<'_>, field: &Field, parent_localized: bool, depth: usize) -> FuseResult<JsVal> {
    match (field.kind, value) {
      (Kind::Leaf, V::RawDoc(doc)) if field.type_name == "json" => raw(self.leaves, &V::RawDoc(doc)),
      (Kind::RichText, V::RawDoc(doc)) if field.lexical_active.as_ref().is_some_and(|active| active.is_empty()) => {
        raw(self.leaves, &V::RawDoc(doc))
      }
      (Kind::Group | Kind::Tab, mut value) if field.affects_data && value.is_plain_object() => {
        let obj = value.obj_mut().map_err(|b| bail(b.0))?.map(std::mem::take).unwrap_or_default();
        self.object(obj, &field.fields, parent_localized, depth)
      }
      (Kind::Array, mut value) if value.is_array() => {
        let rows = value.arr_mut().map_err(|b| bail(b.0))?.map(std::mem::take).unwrap_or_default();
        let mut out = Vec::with_capacity(rows.len());
        for mut row in rows {
          out.push(if row.is_plain_object() {
            let obj = row.obj_mut().map_err(|b| bail(b.0))?.map(std::mem::take).unwrap_or_default();
            self.object(obj, &field.fields, parent_localized, depth + 1)?
          } else {
            to_js(row, depth + 1)?
          });
        }
        Ok(JsVal::arr(out))
      }
      (Kind::Blocks, mut value) if value.is_array() => {
        let rows = value.arr_mut().map_err(|b| bail(b.0))?.map(std::mem::take).unwrap_or_default();
        let mut out = Vec::with_capacity(rows.len());
        for mut row in rows {
          let fields = match row.obj_mut().map_err(|b| bail(b.0))? {
            Some(obj) => match obj.get("blockType") {
              Some(V::Str(slug)) => self.block_fields(field, slug),
              _ => None,
            },
            None => None,
          };
          out.push(match (fields, row.is_plain_object()) {
            (Some(fields), true) => {
              let obj = row.obj_mut().map_err(|b| bail(b.0))?.map(std::mem::take).unwrap_or_default();
              self.object(obj, &fields, parent_localized, depth + 1)?
            }
            _ => to_js(row, depth + 1)?,
          });
        }
        Ok(JsVal::arr(out))
      }
      (_, value) => to_js(value, depth),
    }
  }

  fn block_fields(&self, field: &Field, slug: &str) -> Option<std::sync::Arc<Vec<Field>>> {
    self
      .collection
      .global_blocks
      .get(slug)
      .cloned()
      .or_else(|| field.blocks.iter().find(|(s, _)| s == slug).map(|(_, fields)| fields.clone()))
  }
}

/// The data field named `name` of one object level (rows, collapsibles, unnamed groups and
/// unnamed tabs are part of their parent's level).
fn find_field<'f>(fields: &'f [Field], name: &str) -> Option<&'f Field> {
  for field in fields {
    match field.kind {
      Kind::Row => {
        if let Some(found) = find_field(&field.fields, name) {
          return Some(found);
        }
      }
      Kind::Group if !field.affects_data => {
        if let Some(found) = find_field(&field.fields, name) {
          return Some(found);
        }
      }
      Kind::Tabs => {
        for tab in &field.tabs {
          if tab.affects_data {
            if tab.name.as_deref() == Some(name) {
              return Some(tab);
            }
          } else if let Some(found) = find_field(&tab.fields, name) {
            return Some(found);
          }
        }
      }
      Kind::Ui => {}
      _ if field.affects_data && field.name.as_deref() == Some(name) => return Some(field),
      _ => {}
    }
  }
  None
}

/// A raw subtree as a raw leaf (its JSON as the driver lane writes it).
fn raw(leaves: &RawLeaves, value: &V<'_>) -> FuseResult<JsVal> {
  let mut text = String::new();
  payload_mongo_driver::json::write_value(&mut text, value).map_err(|b| bail(b.0))?;
  Ok(leaves.value(text))
}
