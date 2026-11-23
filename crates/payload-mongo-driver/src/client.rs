//! Clients (one pool per adapter, from the adapter's URL), the tokio runtime they run on, and the
//! read operations of the driver lane.
//!
//! Commands are the ones the Node driver sends for the mongoose calls the lane replaces:
//! `Model.find(...)` -> `find`, `Model.findOne(...)` -> `find` with `limit: 1` / `singleBatch`,
//! `Model.countDocuments(...)` -> `aggregate [{ $match }, { $group: { _id: 1, n: { $sum: 1 } } }]`,
//! `Model.estimatedDocumentCount()` -> `count`, `Model.aggregate(...)` -> `aggregate`. Filters,
//! sorts, projections and pipelines arrive already cast by mongoose and serialized by js-bson.

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use mongodb::bson::{Document, RawDocumentBuf, doc};
use mongodb::options::{
  AggregateOptions, ClientOptions, Collation, CountOptions, EstimatedDocumentCountOptions, FindOneOptions, FindOptions,
  Hint,
};
use mongodb::{Client, Collection};
use tokio::runtime::Runtime;

use crate::json::{write_object, write_value};
use crate::transform::{Flags, Plan, ReadShape, transform_read};
use crate::value::{Bail, V, decode_document};

/// Why a driver lane call did not produce a result: the JS glue re-runs it on the mongoose lane
/// (reads are idempotent), which yields upstream's result or error.
#[derive(Debug)]
pub enum LaneError {
  Bail(&'static str),
  Driver(String),
}

impl From<Bail> for LaneError {
  fn from(bail: Bail) -> Self {
    LaneError::Bail(bail.0)
  }
}

impl From<mongodb::error::Error> for LaneError {
  fn from(error: mongodb::error::Error) -> Self {
    LaneError::Driver(error.to_string())
  }
}

impl std::fmt::Display for LaneError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      LaneError::Bail(reason) => write!(f, "bail: {reason}"),
      LaneError::Driver(message) => write!(f, "driver: {message}"),
    }
  }
}

pub type Result<T> = std::result::Result<T, LaneError>;

static RUNTIME: OnceLock<Runtime> = OnceLock::new();

/// The runtime every client and lane call runs on (`PAYLOAD_MONGO_DRIVER_THREADS` workers,
/// default 2).
pub fn runtime() -> &'static Runtime {
  RUNTIME.get_or_init(|| {
    let threads = std::env::var("PAYLOAD_MONGO_DRIVER_THREADS")
      .ok()
      .and_then(|v| v.parse::<usize>().ok())
      .filter(|&n| n > 0)
      .unwrap_or(2);
    tokio::runtime::Builder::new_multi_thread()
      .worker_threads(threads)
      .thread_name("payload-mongo-driver")
      .enable_all()
      .build()
      .expect("payload-mongo-driver: tokio runtime")
  })
}

pub struct DriverClient {
  pub client: Client,
  pub default_database: String,
  pub replica_set: Option<String>,
}

static CLIENTS: Mutex<Vec<Option<Arc<DriverClient>>>> = Mutex::new(Vec::new());

/// Options of a client beyond its URL (the adapter's `connectOptions` the JS glue maps; anything
/// it cannot map keeps the adapter on the mongoose lane).
#[derive(Debug, Default)]
pub struct ConnectSpec {
  pub app_name: Option<String>,
  pub connect_timeout_ms: Option<u64>,
  pub db_name: Option<String>,
  pub max_pool_size: Option<u32>,
  pub min_pool_size: Option<u32>,
  pub replica_set: Option<String>,
  pub server_selection_timeout_ms: Option<u64>,
}

pub struct ConnectInfo {
  pub id: u32,
  pub default_database: String,
  pub replica_set: Option<String>,
}

/// Parses `url`, creates the client and waits for a server (`ping`), like the mongoose connection's
/// `openUri`.
pub async fn connect(url: &str, spec: ConnectSpec) -> Result<ConnectInfo> {
  let mut options = ClientOptions::parse(url).await?;
  if let Some(app_name) = spec.app_name {
    options.app_name = Some(app_name);
  }
  if let Some(ms) = spec.connect_timeout_ms {
    options.connect_timeout = Some(Duration::from_millis(ms));
  }
  if let Some(ms) = spec.server_selection_timeout_ms {
    options.server_selection_timeout = Some(Duration::from_millis(ms));
  }
  // the Node driver's pool defaults (maxPoolSize 100, minPoolSize 0)
  options.max_pool_size = Some(spec.max_pool_size.unwrap_or(100));
  options.min_pool_size = Some(spec.min_pool_size.unwrap_or(0));
  if let Some(replica_set) = spec.replica_set {
    options.repl_set_name = Some(replica_set);
  }
  // mongoose: `dbName` option, else the URL's database, else `test`
  let default_database =
    spec.db_name.or_else(|| options.default_database.clone()).unwrap_or_else(|| "test".to_string());
  let replica_set = options.repl_set_name.clone();
  let client = Client::with_options(options)?;
  client.database(&default_database).run_command(doc! { "ping": 1 }).await?;
  let state = Arc::new(DriverClient { client, default_database: default_database.clone(), replica_set: replica_set.clone() });
  let mut clients = CLIENTS.lock().expect("clients");
  clients.push(Some(state));
  Ok(ConnectInfo { id: (clients.len() - 1) as u32, default_database, replica_set })
}

pub fn client(id: u32) -> Result<Arc<DriverClient>> {
  CLIENTS
    .lock()
    .expect("clients")
    .get(id as usize)
    .and_then(Clone::clone)
    .ok_or(LaneError::Bail("closed client"))
}

/// Shuts the client's pool down (the adapter's `destroy`).
pub async fn close(id: u32) {
  let state = CLIENTS.lock().expect("clients").get_mut(id as usize).and_then(Option::take);
  if let Some(state) = state {
    state.client.clone().shutdown().await;
  }
}

static PLANS: Mutex<Vec<Arc<Plan>>> = Mutex::new(Vec::new());

pub fn register_plan(text: &str) -> std::result::Result<u32, String> {
  let plan = Plan::parse(text)?;
  let mut plans = PLANS.lock().expect("plans");
  plans.push(Arc::new(plan));
  Ok((plans.len() - 1) as u32)
}

pub fn plan(id: u32) -> Result<Arc<Plan>> {
  PLANS.lock().expect("plans").get(id as usize).cloned().ok_or(LaneError::Bail("unknown plan"))
}

/// The find part of a read (mongoose's `_conditions` and `_optionsForExec()`).
#[derive(Debug, Default)]
pub struct FindSpec {
  pub filter: Document,
  pub sort: Option<Document>,
  pub projection: Option<Document>,
  pub skip: Option<u64>,
  pub limit: Option<i64>,
  pub collation: Option<Collation>,
  pub hint: Option<Hint>,
}

/// The count of a paginated read.
#[derive(Debug)]
pub enum CountSpec {
  None,
  Estimated,
  Documents { filter: Document, hint: Option<Hint>, collation: Option<Collation> },
}

fn collection(state: &DriverClient, database: Option<&str>, name: &str) -> Collection<RawDocumentBuf> {
  state.client.database(database.unwrap_or(&state.default_database)).collection(name)
}

async fn run_count(coll: &Collection<RawDocumentBuf>, count: CountSpec) -> Result<Option<u64>> {
  Ok(match count {
    CountSpec::None => None,
    CountSpec::Estimated => {
      Some(coll.estimated_document_count().with_options(EstimatedDocumentCountOptions::default()).await?)
    }
    CountSpec::Documents { filter, hint, collation } => {
      let mut options = CountOptions::default();
      options.hint = hint;
      options.collation = collation;
      Some(coll.count_documents(filter).with_options(options).await?)
    }
  })
}

/// Documents per transform task: larger results are transformed in parallel on the driver
/// runtime, chunk by chunk as the cursor yields them (and joined in order).
const TRANSFORM_CHUNK: usize = 32;

/// Runs the find and writes its documents (transformed) as JSON array elements.
async fn run_find(
  coll: &Collection<RawDocumentBuf>,
  find: FindSpec,
  plan: &Arc<Plan>,
  flags: Flags,
  shape: ReadShape,
) -> Result<String> {
  let mut options = FindOptions::default();
  options.sort = find.sort;
  options.projection = find.projection;
  options.skip = find.skip;
  options.limit = find.limit;
  options.collation = find.collation;
  options.hint = find.hint;
  let mut cursor = coll.find(find.filter).with_options(options).await?;
  let mut tasks = Vec::new();
  let mut chunk = Vec::with_capacity(TRANSFORM_CHUNK);
  while cursor.advance().await? {
    chunk.push(cursor.current().to_raw_document_buf());
    if chunk.len() == TRANSFORM_CHUNK {
      let docs = std::mem::replace(&mut chunk, Vec::with_capacity(TRANSFORM_CHUNK));
      let plan = plan.clone();
      tasks.push(tokio::spawn(async move { write_docs(&docs, &plan, flags, shape) }));
    }
  }
  // the last chunk in this task, while the spawned ones run on the other workers
  let tail = write_docs(&chunk, plan, flags, shape)?;
  let mut out = String::new();
  for task in tasks {
    let part = task.await.map_err(|_| LaneError::Bail("transform task failed"))??;
    if !out.is_empty() {
      out.push(',');
    }
    out.push_str(&part);
  }
  if !tail.is_empty() {
    if !out.is_empty() {
      out.push(',');
    }
    out.push_str(&tail);
  }
  Ok(out)
}

/// `docs` transformed, as comma-separated JSON documents.
fn write_docs(docs: &[RawDocumentBuf], plan: &Plan, flags: Flags, shape: ReadShape) -> Result<String> {
  let mut out = String::with_capacity(docs.iter().map(|doc| doc.as_bytes().len()).sum::<usize>() + 16);
  for (index, doc) in docs.iter().enumerate() {
    if index > 0 {
      out.push(',');
    }
    write_doc(&mut out, doc, plan, flags, shape)?;
  }
  Ok(out)
}

/// Decodes and transforms `raw` and writes it as JSON.
fn write_doc(
  out: &mut String,
  raw: &mongodb::bson::RawDocument,
  plan: &Plan,
  flags: Flags,
  shape: ReadShape,
) -> Result<()> {
  let mut doc = decode_document(raw)?;
  transform_read(plan, flags, shape, &mut doc)?;
  write_object(out, &doc)?;
  Ok(())
}

pub struct ReadTarget {
  pub client: u32,
  pub database: Option<String>,
  pub collection: String,
  pub plan: u32,
  pub flags: Flags,
}

/// mongoose-paginate-v2's `Promise.all([countPromise, docsPromise])` (the count started first) plus
/// `leanWithId` and transform: `[count, [docs...]]` (`count` is `null` without a count query).
pub async fn paginate(target: ReadTarget, count: CountSpec, find: Option<FindSpec>) -> Result<String> {
  let state = client(target.client)?;
  let plan = plan(target.plan)?;
  let coll = collection(&state, target.database.as_deref(), &target.collection);
  let count_future = run_count(&coll, count);
  let find_future = async {
    match find {
      Some(find) => run_find(&coll, find, &plan, target.flags, ReadShape { lean_with_id: true }).await,
      None => Ok(String::new()),
    }
  };
  let (count, docs) = tokio::join!(count_future, find_future);
  let (count, docs) = (count?, docs?);
  let mut out = String::with_capacity(docs.len() + 32);
  out.push('[');
  match count {
    Some(count) => write_value(&mut out, &V::Num(count as f64))?,
    None => out.push_str("null"),
  }
  out.push_str(",[");
  out.push_str(&docs);
  out.push_str("]]");
  Ok(out)
}

/// `Model.findOne(filter, {}, { lean: true, projection })` plus transform: the document's JSON, or
/// `null`.
pub async fn find_one(target: ReadTarget, find: FindSpec) -> Result<String> {
  let state = client(target.client)?;
  let plan = plan(target.plan)?;
  let coll = collection(&state, target.database.as_deref(), &target.collection);
  let mut options = FindOneOptions::default();
  options.sort = find.sort;
  options.projection = find.projection;
  options.skip = find.skip;
  options.collation = find.collation;
  options.hint = find.hint;
  let doc = coll.find_one(find.filter).with_options(options).await?;
  let mut out = String::new();
  match doc {
    Some(raw) => write_doc(&mut out, &raw, &plan, target.flags, ReadShape { lean_with_id: false })?,
    None => out.push_str("null"),
  }
  Ok(out)
}

/// `Model.countDocuments(...)` / `Model.estimatedDocumentCount()`.
pub async fn count(client_id: u32, database: Option<String>, collection_name: String, count: CountSpec) -> Result<u64> {
  let state = client(client_id)?;
  let coll = collection(&state, database.as_deref(), &collection_name);
  run_count(&coll, count).await?.ok_or(LaneError::Bail("no count"))
}

/// db-mongodb's `aggregatePaginate`: `Promise.all([Model.aggregate(pipeline, { collation }),
/// countPromise])` plus transform per document: `[count | null, [docs...]]`.
pub async fn aggregate(
  target: ReadTarget,
  pipeline: Vec<Document>,
  collation: Option<Collation>,
  count: CountSpec,
) -> Result<String> {
  let state = client(target.client)?;
  let plan = plan(target.plan)?;
  let coll = collection(&state, target.database.as_deref(), &target.collection);
  let docs_future = async {
    let mut options = AggregateOptions::default();
    options.collation = collation;
    let mut cursor = coll.aggregate(pipeline).with_options(options).await?;
    let mut out = String::new();
    let mut first = true;
    while cursor.advance().await? {
      if !first {
        out.push(',');
      }
      first = false;
      write_doc(&mut out, cursor.current(), &plan, target.flags, ReadShape { lean_with_id: false })?;
    }
    Ok::<_, LaneError>(out)
  };
  let (docs, count) = tokio::join!(docs_future, run_count(&coll, count));
  let (docs, count) = (docs?, count?);
  let mut out = String::with_capacity(docs.len() + 32);
  out.push('[');
  match count {
    Some(count) => write_value(&mut out, &V::Num(count as f64))?,
    None => out.push_str("null"),
  }
  out.push_str(",[");
  out.push_str(&docs);
  out.push_str("]]");
  Ok(out)
}

/// A command on the client's database (index builds, `create`, `dropDatabase`, ...), returning
/// the raw reply, or the error as JSON `{ message, code?, codeName? }` (the server's code, which
/// mongoose / db-mongodb branch on, e.g. 48 `NamespaceExists`).
pub async fn command(
  client_id: u32,
  database: Option<String>,
  command: Document,
) -> std::result::Result<Document, String> {
  let state = client(client_id).map_err(|e| serde_json::json!({ "message": e.to_string() }).to_string())?;
  let database = state.client.database(database.as_deref().unwrap_or(&state.default_database));
  database.run_command(command).await.map_err(|error| {
    let mut out = serde_json::json!({ "message": error.to_string() });
    if let mongodb::error::ErrorKind::Command(command_error) = error.kind.as_ref() {
      out["code"] = serde_json::json!(command_error.code);
      out["codeName"] = serde_json::json!(command_error.code_name);
      out["message"] = serde_json::json!(command_error.message);
    }
    out.to_string()
  })
}
