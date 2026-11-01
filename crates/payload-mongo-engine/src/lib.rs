//! The MongoDB engine: the data methods of `@payloadcms/db-mongodb` as faithful ports whose
//! database calls are host ops (packages/engine-rs/MONGO_ENGINE_CONTRACT.md).
//!
//! [`MongoEngine::create`] decodes the config graph once; [`MongoEngine::call`] runs one adapter
//! method as a future that awaits each host op where the TS method awaits it. The future is polled
//! on the JS thread by the binding (crates/payload-node/src/mongo_engine.rs), so the synchronous
//! parts of a method run exactly where the TS method runs them.

pub mod components;
pub mod context;
pub mod distinct;
pub mod entity;
pub mod host;
pub mod paginate;
pub mod read;
pub mod util;
pub mod wired;
pub mod write;

use std::rc::Rc;
use std::sync::Arc;

use payload_engine::error::EngineError;
use payload_engine::js::{JsVal, decode_graph_bson, decode_value_bson, encode_value};
use serde_json::Value as Json;

pub use crate::components::Components;
pub use crate::context::{Call, CallContext, Graph};
pub use crate::host::{MongoError, MongoHost, MongoResult};
use crate::read::{CountTarget, VersionsTarget};
use crate::write::WriteOutcome;

/// The data methods [`MongoEngine::call`] runs (every data method of the adapter).
pub const METHODS: &[&str] = &[
  "count",
  "countGlobalVersions",
  "countVersions",
  "create",
  "createGlobal",
  "createGlobalVersion",
  "createVersion",
  "deleteMany",
  "deleteOne",
  "deleteVersions",
  "find",
  "findDistinct",
  "findGlobal",
  "findGlobalVersions",
  "findOne",
  "findVersions",
  "queryDrafts",
  "updateGlobal",
  "updateGlobalVersion",
  "updateJobs",
  "updateMany",
  "updateOne",
  "updateVersion",
  "upsert",
];

pub struct MongoEngine<C> {
  graph: Graph,
  components: C,
}

impl<C: Components + 'static> MongoEngine<C> {
  /// Decodes `graphJson` (`serializeForEngine({ config, collections: { [slug]: { config,
  /// customIDType } } })`) once.
  /// `components` is built from the decoded graph (identity-keyed caches of the components are
  /// valid against it).
  pub fn create(graph: &Json, components: impl FnOnce(&Graph) -> C) -> Result<Self, EngineError> {
    let graph = Graph::new(decode_graph_bson(graph)?);
    let components = components(&graph);
    Ok(Self { graph, components })
  }

  pub fn graph(&self) -> &Graph {
    &self.graph
  }

  pub fn components(&self) -> &C {
    &self.components
  }

  /// The schema description the TS builds the mongoose schemas from.
  pub fn schema_description(&self, functions: &dyn payload_engine::host::Host) -> MongoResult<Json> {
    self.components.schema_description(&self.graph, functions)
  }

  /// Runs one adapter method. `args_json` is the tree encoding (BSON markers) of the method's
  /// argument without `req`; `context_json` the [`CallContext`]. Resolves with
  /// `{ result, mutations }`; fails with the error JSON (`{ name, message, data, mutations? }` or
  /// `{ rethrow: n, mutations? }`).
  pub fn call(
    self: &Arc<Self>,
    method: String,
    args_json: String,
    context_json: String,
    host: Rc<dyn MongoHost>,
    functions: Rc<dyn payload_engine::host::Host>,
  ) -> host::LocalBoxFuture<'static, Result<String, String>> {
    let engine = Arc::clone(self);
    Box::pin(async move {
      let prepared = (|| -> MongoResult<(JsVal, CallContext)> {
        let args = serde_json::from_str::<Json>(&args_json)
          .map_err(|e| EngineError::internal(format!("invalid args JSON: {e}")))
          .and_then(|json| decode_value_bson(&json))?;
        let ctx = serde_json::from_str::<Json>(&context_json)
          .map_err(|e| EngineError::internal(format!("invalid context JSON: {e}")))
          .and_then(|json| CallContext::parse(&json))?;
        Ok((args, ctx))
      })();
      let (args, ctx) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => return Err(error.to_json().to_string()),
      };
      let now = ctx.now;
      let clock = move || now;
      let call = Call { graph: &engine.graph, ctx: &ctx, host: &*host, functions: &*functions, now: &clock };
      let original = args.get(match method.as_str() {
        "createVersion" | "createGlobalVersion" | "updateVersion" | "updateGlobalVersion" => "versionData",
        _ => "data",
      });
      let original = encode_value(original);
      let outcome = engine.run(&call, &method, &args).await;
      // only a changed argument is reported (unchanged values keep their identity in JS)
      let mutations: Vec<Json> = outcome
        .mutated
        .iter()
        .map(|(key, value)| (key, encode_value(value)))
        .filter(|(_, value)| *value != original)
        .map(|(key, value)| serde_json::json!([[key], value]))
        .collect();
      match outcome.result {
        Ok(result) => Ok(serde_json::json!({ "result": encode_value(&result), "mutations": mutations }).to_string()),
        Err(error) => {
          let mut json = error.to_json();
          if !mutations.is_empty() {
            if let Some(o) = json.as_object_mut() {
              o.insert("mutations".into(), Json::Array(mutations));
            }
          }
          Err(json.to_string())
        }
      }
    })
  }

  /// Runs `method` on decoded arguments.
  pub async fn run(&self, call: &Call<'_>, method: &str, args: &JsVal) -> WriteOutcome {
    let c = &self.components;
    let plain = WriteOutcome::plain;
    match method {
      "count" => plain(read::count(c, call, args, CountTarget::Collection).await),
      "countVersions" => plain(read::count(c, call, args, CountTarget::CollectionVersions).await),
      "countGlobalVersions" => plain(read::count(c, call, args, CountTarget::GlobalVersions).await),
      "find" => plain(read::find(c, call, args).await),
      "findOne" => plain(read::find_one(c, call, args).await),
      "findGlobal" => plain(read::find_global(c, call, args).await),
      "findVersions" => plain(read::find_versions(c, call, args, VersionsTarget::Collection).await),
      "findGlobalVersions" => plain(read::find_versions(c, call, args, VersionsTarget::Global).await),
      "queryDrafts" => plain(read::query_drafts(c, call, args).await),
      "findDistinct" => plain(distinct::find_distinct(c, call, args).await),
      "create" => write::create(c, call, args).await,
      "createGlobal" => write::create_global(c, call, args).await,
      "createVersion" => write::create_version(c, call, args).await,
      "createGlobalVersion" => write::create_global_version(c, call, args).await,
      "updateOne" => write::update_one(c, call, args).await,
      "upsert" => plain(write::upsert(call, args).await),
      "updateMany" => write::update_many(c, call, args).await,
      "updateGlobal" => write::update_global(c, call, args).await,
      "updateVersion" => write::update_version(c, call, args).await,
      "updateGlobalVersion" => write::update_global_version(c, call, args).await,
      "updateJobs" => write::update_jobs(c, call, args).await,
      "deleteOne" => plain(write::delete_one(c, call, args).await),
      "deleteMany" => plain(write::delete_many(c, call, args).await),
      "deleteVersions" => plain(write::delete_versions(c, call, args).await),
      other => plain(Err(EngineError::internal(format!("unknown mongo engine method: {other}")))),
    }
  }
}
