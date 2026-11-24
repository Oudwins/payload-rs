//! napi binding of the fused read lanes (packages/engine-rs/FUSE_CONTRACT.md):
//!
//! ```ts
//! fuseRegisterPlan(planJson: string): number
//! fuseRunSqlite(engine: SqliteEngine, connId: number, blocksAsJSON: boolean | undefined,
//!               limitedBoundParameters: boolean | undefined, requestJson: string): string
//!
//! fuseRunMongo(client: number, transformPlan: number, requestJson: string,
//!              reads: Uint8Array): Promise<string>
//! ```
//!
//! `fuseRunSqlite` runs synchronously: the whole operation is one `payload-sqlite` queue job
//! (the JS thread waits, as for every engine statement). `fuseRunMongo` runs on the MongoDB
//! driver's runtime (the reads, then the fused core) and settles its promise from there; it never
//! rejects. The result is the operation's JSON or `!<reason>` when it bailed.

use napi::bindgen_prelude::{BufferSlice, Env, Object};
use napi::Result;
use napi_derive::napi;
use payload_fuse_mongo::MongoReads;
use payload_fuse_sqlite::SqliteBackend;
use payload_sqlite::worker;

use crate::engine::SqliteEngineJs;

#[napi]
pub fn fuse_register_plan(plan_json: String) -> Result<u32> {
  payload_fuse::register_plan(&plan_json).map_err(|reason| napi::Error::new(napi::Status::InvalidArg, reason))
}

#[napi]
pub fn fuse_run_sqlite(
  engine: &SqliteEngineJs,
  conn_id: u32,
  blocks_as_json: Option<bool>,
  limited_bound_parameters: Option<bool>,
  request_json: String,
) -> String {
  let (engine, client_id) = engine.fused_target();
  if let Some(client) = client_id {
    if client != conn_id && !worker::same_database(client, conn_id) {
      return "!sqlite:foreign-connection".to_string();
    }
  }
  // `contextJson` of `SqliteEngine.call`: a flag left out keeps the engine's create-time option
  let mut context = serde_json::Map::new();
  if let Some(flag) = blocks_as_json {
    context.insert("blocksAsJSON".into(), flag.into());
  }
  if let Some(flag) = limited_bound_parameters {
    context.insert("limitedBoundParameters".into(), flag.into());
  }
  let context = serde_json::Value::Object(context);
  let backend = SqliteBackend::new(engine, &context);
  payload_fuse::run(&backend, conn_id, &request_json)
}

type Resolver = Box<dyn FnOnce(Env) -> Result<String> + Send>;

#[napi]
pub fn fuse_run_mongo<'env>(
  env: &'env Env,
  client: u32,
  transform_plan: u32,
  request_json: String,
  reads: BufferSlice,
) -> Result<Object<'env>> {
  let reads = MongoReads::decode(&reads);
  let (deferred, promise) = env.create_deferred::<String, Resolver>()?;
  payload_mongo_driver::runtime().spawn(async move {
    let text = match reads {
      Ok(reads) => payload_fuse_mongo::run(client, transform_plan, reads, request_json).await,
      Err(_) => "!mongo:args".to_string(),
    };
    deferred.resolve(Box::new(move |_| Ok(text)));
  });
  Ok(promise)
}
