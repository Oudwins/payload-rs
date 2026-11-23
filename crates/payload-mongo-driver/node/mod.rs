//! Node-API binding of the MongoDB driver lane (crates/payload-mongo-driver), included into
//! payload-node with `#[path]`. Contract: packages/engine-rs/MONGO_DRIVER_CONTRACT.md "napi surface".
//!
//! Every lane call returns a promise settled from the driver runtime through a deferred (one
//! threadsafe-function wakeup on the JS thread). A lane call never rejects: it resolves with the
//! result JSON text, or with `"!<reason>"` when it must be re-run on the mongoose lane (JSON text
//! never starts with `!`).

use std::sync::atomic::{AtomicU64, Ordering};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use payload_mongo_driver::{ConnectSpec, LaneError, ReadTarget};

type Resolver<T> = Box<dyn FnOnce(Env) -> Result<T> + Send>;

/// The driver lane API version (MONGO_DRIVER_CONTRACT.md); the glue requires it.
const API_VERSION: u32 = 1;

static CALLS: AtomicU64 = AtomicU64::new(0);
static SERVED: AtomicU64 = AtomicU64::new(0);
static BAILED: AtomicU64 = AtomicU64::new(0);

#[napi]
pub fn mongo_driver_api_version() -> u32 {
  API_VERSION
}

/// Lane calls made / served by the driver / handed back to the mongoose lane, in this process.
#[napi]
pub fn mongo_driver_stats() -> Vec<f64> {
  [&CALLS, &SERVED, &BAILED].iter().map(|c| c.load(Ordering::Relaxed) as f64).collect()
}

fn spawn_lane<'env>(
  env: &'env Env,
  job: impl std::future::Future<Output = std::result::Result<String, LaneError>> + Send + 'static,
) -> Result<Object<'env>> {
  CALLS.fetch_add(1, Ordering::Relaxed);
  let (deferred, promise) = env.create_deferred::<String, Resolver<String>>()?;
  payload_mongo_driver::runtime().spawn(async move {
    let text = match job.await {
      Ok(text) => {
        SERVED.fetch_add(1, Ordering::Relaxed);
        text
      }
      Err(error) => {
        BAILED.fetch_add(1, Ordering::Relaxed);
        format!("!{error}")
      }
    };
    deferred.resolve(Box::new(move |_| Ok(text)));
  });
  Ok(promise)
}

fn target(client: u32, plan: u32, args: &payload_mongo_driver::ReadArgs) -> ReadTarget {
  ReadTarget {
    client,
    collection: args.collection.clone(),
    database: args.database.clone(),
    flags: args.flags,
    plan,
  }
}

/// `connect(url, spec)`: resolves with `{ id, defaultDatabase, replicaSet }` (JSON), rejects with
/// the driver's error message.
#[napi]
pub fn mongo_driver_connect<'env>(env: &'env Env, url: String, spec_json: String) -> Result<Object<'env>> {
  let spec: serde_json::Value =
    serde_json::from_str(&spec_json).map_err(|e| Error::new(Status::InvalidArg, e.to_string()))?;
  let string = |key: &str| spec.get(key).and_then(serde_json::Value::as_str).map(str::to_string);
  let number = |key: &str| spec.get(key).and_then(serde_json::Value::as_u64);
  let connect_spec = ConnectSpec {
    app_name: string("appName"),
    connect_timeout_ms: number("connectTimeoutMS"),
    db_name: string("dbName"),
    max_pool_size: number("maxPoolSize").map(|n| n as u32),
    min_pool_size: number("minPoolSize").map(|n| n as u32),
    replica_set: string("replicaSet"),
    server_selection_timeout_ms: number("serverSelectionTimeoutMS"),
  };
  let (deferred, promise) = env.create_deferred::<String, Resolver<String>>()?;
  payload_mongo_driver::runtime().spawn(async move {
    match payload_mongo_driver::connect(&url, connect_spec).await {
      Ok(info) => {
        let text = serde_json::json!({
          "id": info.id,
          "defaultDatabase": info.default_database,
          "replicaSet": info.replica_set,
        })
        .to_string();
        deferred.resolve(Box::new(move |_| Ok(text)));
      }
      Err(error) => deferred.reject(Error::new(Status::GenericFailure, error.to_string())),
    }
  });
  Ok(promise)
}

#[napi]
pub fn mongo_driver_close<'env>(env: &'env Env, client: u32) -> Result<Object<'env>> {
  let (deferred, promise) = env.create_deferred::<(), Resolver<()>>()?;
  payload_mongo_driver::runtime().spawn(async move {
    payload_mongo_driver::close(client).await;
    deferred.resolve(Box::new(|_| Ok(())));
  });
  Ok(promise)
}

/// Registers a transform plan (MONGO_DRIVER_CONTRACT.md "Transform plans"); returns its id.
#[napi]
pub fn mongo_driver_register_plan(plan_json: String) -> Result<u32> {
  payload_mongo_driver::register_plan(&plan_json).map_err(|e| Error::new(Status::InvalidArg, e))
}

fn read_args(args: &[u8]) -> std::result::Result<payload_mongo_driver::ReadArgs, LaneError> {
  payload_mongo_driver::read_args(args)
}

/// `Model.paginate(...)` + transform: `[count | null, [docs...]]`.
#[napi]
pub fn mongo_driver_paginate<'env>(env: &'env Env, client: u32, plan: u32, args: BufferSlice) -> Result<Object<'env>> {
  let decoded = read_args(&args);
  spawn_lane(env, async move {
    let args = decoded?;
    let target = target(client, plan, &args);
    payload_mongo_driver::paginate(target, args.count, args.find).await
  })
}

/// `Model.findOne(...)` + transform: the document or `null`.
#[napi]
pub fn mongo_driver_find_one<'env>(env: &'env Env, client: u32, plan: u32, args: BufferSlice) -> Result<Object<'env>> {
  let decoded = read_args(&args);
  spawn_lane(env, async move {
    let mut args = decoded?;
    let target = target(client, plan, &args);
    let find = args.find.take().ok_or(LaneError::Bail("findOne without find"))?;
    payload_mongo_driver::find_one(target, find).await
  })
}

/// `Model.countDocuments(...)` / `Model.estimatedDocumentCount()`: the count as JSON.
#[napi]
pub fn mongo_driver_count<'env>(env: &'env Env, client: u32, args: BufferSlice) -> Result<Object<'env>> {
  let decoded = read_args(&args);
  spawn_lane(env, async move {
    let args = decoded?;
    let count = payload_mongo_driver::count(client, args.database, args.collection, args.count).await?;
    Ok(count.to_string())
  })
}

/// `aggregatePaginate`: `Model.aggregate(pipeline)` and its count + transform: `[count | null, [docs...]]`.
#[napi]
pub fn mongo_driver_aggregate<'env>(env: &'env Env, client: u32, plan: u32, args: BufferSlice) -> Result<Object<'env>> {
  let decoded = read_args(&args);
  spawn_lane(env, async move {
    let mut args = decoded?;
    let target = target(client, plan, &args);
    let pipeline = args.pipeline.take().ok_or(LaneError::Bail("aggregate without pipeline"))?;
    let count = std::mem::replace(&mut args.count, payload_mongo_driver::CountSpec::None);
    payload_mongo_driver::aggregate(target, pipeline, args.collation.take(), count).await
  })
}

/// A command (js-bson document) on the client's database (or `database`): resolves with the reply
/// as js-bson bytes, rejects with an Error whose message is `{ message, code?, codeName? }` JSON.
#[napi]
pub fn mongo_driver_command<'env>(
  env: &'env Env,
  client: u32,
  database: Option<String>,
  command: BufferSlice,
) -> Result<Object<'env>> {
  let command = payload_mongo_driver::mongodb::bson::Document::from_reader(&*command).map_err(|e| Error::new(Status::InvalidArg, e.to_string()))?;
  let (deferred, promise) = env.create_deferred::<Buffer, Resolver<Buffer>>()?;
  payload_mongo_driver::runtime().spawn(async move {
    match payload_mongo_driver::command(client, database, command).await {
      Ok(reply) => {
        let mut bytes = Vec::new();
        match reply.to_writer(&mut bytes) {
          Ok(()) => deferred.resolve(Box::new(move |_| Ok(Buffer::from(bytes)))),
          Err(error) => deferred.reject(Error::new(Status::GenericFailure, error.to_string())),
        }
      }
      Err(error) => deferred.reject(Error::new(Status::GenericFailure, error)),
    }
  });
  Ok(promise)
}
