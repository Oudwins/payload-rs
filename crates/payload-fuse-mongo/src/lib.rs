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

use std::sync::Mutex;

use payload_engine::js::{JsVal, Obj as JsObj};
use payload_fuse::{Bail, FuseResult, FusedBackend, Job, ReadSession};
use payload_mongo_driver::client::{DriverClient, client, plan};
use payload_mongo_driver::mongodb::Collection;
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

/// What the reads returned.
enum Loaded {
  Page { count: Option<u64>, docs: Vec<RawDocumentBuf>, pagination: bool, limit: f64, page: f64 },
  One(Option<RawDocumentBuf>),
  Count(u64),
}

/// Runs `reads` on client `client_id`, then the fused operation `request_json` on their
/// documents (driver transform plan `plan_id`). Returns the result JSON or `!<reason>`.
pub async fn run(client_id: u32, plan_id: u32, reads: MongoReads, request_json: String) -> String {
  let loaded = match load(client_id, &reads).await {
    Ok(loaded) => loaded,
    Err(LaneError::Bail(reason)) => return format!("!mongo:{reason}"),
    Err(LaneError::Driver(_)) => return "!mongo:driver".to_string(),
  };
  let plan = match plan(plan_id) {
    Ok(plan) => plan,
    Err(_) => return "!mongo:plan".to_string(),
  };
  let backend = MongoBackend { loaded: Mutex::new(Some(loaded)), plan, flags: reads.flags };
  payload_fuse::run(&backend, 0, &request_json)
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

async fn run_find(coll: &Collection<RawDocumentBuf>, find: Option<&FindSpec>) -> Result<Vec<RawDocumentBuf>, LaneError> {
  let Some(find) = find else { return Ok(Vec::new()) };
  let mut options = FindOptions::default();
  options.sort = find.sort.clone();
  options.projection = find.projection.clone();
  options.skip = find.skip;
  options.limit = find.limit;
  options.collation = find.collation.clone();
  options.hint = find.hint.clone();
  let mut cursor = coll.find(find.filter.clone()).with_options(options).await?;
  let mut docs = Vec::new();
  while cursor.advance().await? {
    docs.push(cursor.current().to_raw_document_buf());
  }
  Ok(docs)
}

async fn load(client_id: u32, reads: &MongoReads) -> Result<Loaded, LaneError> {
  let state = client(client_id)?;
  let coll = collection(&state, reads.database.as_deref(), &reads.collection);
  Ok(match reads.op {
    ReadOp::Find { pagination, limit, page } => {
      // mongoose-paginate-v2: the count is started first, both in flight
      let (count, docs) = tokio::join!(run_count(&coll, &reads.count), run_find(&coll, reads.find.as_ref()));
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
      Loaded::One(coll.find_one(find.filter.clone()).with_options(options).await?)
    }
    ReadOp::Count => Loaded::Count(run_count(&coll, &reads.count).await?.ok_or(LaneError::Bail("no count"))?),
  })
}

/// The fused core's view of the loaded reads: each read is served once, in the operation's order.
struct MongoBackend {
  loaded: Mutex<Option<Loaded>>,
  plan: std::sync::Arc<Plan>,
  flags: Flags,
}

impl FusedBackend for MongoBackend {
  fn name(&self) -> &'static str {
    "mongodb"
  }

  fn run(&self, _conn: u32, job: Job) -> FuseResult<String> {
    let loaded = self.loaded.lock().unwrap_or_else(|e| e.into_inner()).take();
    let mut session = MongoSession { loaded, plan: &self.plan, flags: self.flags };
    job(&mut session)
  }
}

struct MongoSession<'p> {
  loaded: Option<Loaded>,
  plan: &'p Plan,
  flags: Flags,
}

fn bail(reason: &'static str) -> Bail {
  Bail::new(format!("mongo:{reason}"))
}

impl MongoSession<'_> {
  /// One document as `transform` leaves it (`lean_with_id`: read through `Model.paginate`).
  fn document(&self, raw: &RawDocument, lean_with_id: bool) -> FuseResult<JsVal> {
    let mut doc = decode_document(raw).map_err(|b| bail(b.0))?;
    transform_read(self.plan, self.flags, ReadShape { lean_with_id }, &mut doc).map_err(|b| bail(b.0))?;
    to_js(V::Obj(doc), 0)
  }
}

impl ReadSession for MongoSession<'_> {
  fn find(&mut self, _args: &JsVal) -> FuseResult<JsVal> {
    let Some(Loaded::Page { count, docs, pagination, limit, page }) = self.loaded.take() else {
      return Err(bail("read order"));
    };
    let docs = docs.iter().map(|raw| self.document(raw, true)).collect::<FuseResult<Vec<_>>>()?;
    Ok(page_result(docs, count, pagination, limit, page))
  }

  fn find_one(&mut self, _args: &JsVal) -> FuseResult<JsVal> {
    let Some(Loaded::One(doc)) = self.loaded.take() else { return Err(bail("read order")) };
    match doc {
      Some(raw) => self.document(&raw, false),
      None => Ok(JsVal::Null),
    }
  }

  fn count(&mut self, _args: &JsVal) -> FuseResult<JsVal> {
    let Some(Loaded::Count(total)) = self.loaded.take() else { return Err(bail("read order")) };
    let mut out = JsObj::new();
    out.insert("totalDocs".to_string(), JsVal::Num(total as f64));
    Ok(JsVal::obj(out))
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
