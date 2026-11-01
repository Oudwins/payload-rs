//! napi binding of the SQLite engine (`packages/engine-rs/ENGINE_CONTRACT.md`):
//!
//! ```ts
//! class SqliteEngine {
//!   static create(graphJson: string, optionsJson: string, callFunction: (id: number, argJson: string) => string): SqliteEngine
//!   rawSchema(): string
//!   attachClient(clientId: number): void
//!   call(method: string, argsJson: string, connId: number): Promise<string>
//! }
//! ```
//!
//! `call` runs on the ordered `payload-sqlite` queue of `connId` (the adapter's client or the
//! active transaction), on that connection, so engine SQL interleaves with drizzle / the TS client
//! exactly in call order. Errors reject with an `Error` whose message is the JSON
//! `{ name, message, data }` of the engine error.

use std::sync::Arc;

use napi::bindgen_prelude::{FnArgs, Function, Object};
use napi::{Env, Result};
use napi_derive::napi;
use payload_engine::error::EngineError;
use payload_engine::host::Host;
use payload_engine::js::{JsVal, decode_graph};
use payload_sql_engine::SqliteEngine as Engine;
use payload_sqlite::worker;
use serde_json::Value as Json;

/// Engine errors reject with an `Error` whose message is the boundary JSON
/// ([`payload_sql_engine::error_json`]).
fn to_napi_error(error: EngineError) -> napi::Error {
  napi::Error::new(napi::Status::GenericFailure, payload_sql_engine::error_json(&error).to_string())
}

/// Calls registered JS functions through `callFunction(id, argJson)`, which returns the result
/// encoded with `serializeForEngine` (or `{ $hostError }` when the function threw).
struct CallbackHost<'a, 'env> {
  callback: &'a Function<'env, FnArgs<(u32, String)>, String>,
}

impl Host for CallbackHost<'_, '_> {
  fn call(&self, id: u32, arg: &Json) -> payload_engine::error::Result<JsVal> {
    let result = self
      .callback
      .call((id, arg.to_string()).into())
      .map_err(|e| EngineError::new("HostError", e.reason.clone()))?;
    let graph: Json = serde_json::from_str(&result)
      .map_err(|e| EngineError::internal(format!("invalid host function result: {e}")))?;
    if graph.get("$hostError").is_some() {
      return Err(EngineError::new("HostError", format!("JS function {id} threw")));
    }
    decode_graph(&graph)
  }
}

fn parse_json(input: &str, what: &str) -> std::result::Result<Json, EngineError> {
  serde_json::from_str(input).map_err(|e| EngineError::internal(format!("invalid {what} JSON: {e}")))
}

#[napi(js_name = "SqliteEngine")]
pub struct SqliteEngineJs {
  engine: Arc<Engine>,
  client_id: Option<u32>,
}

#[napi]
impl SqliteEngineJs {
  /// Decodes the graph once and builds the raw schema; both live as long as the engine.
  #[napi(factory)]
  pub fn create(
    graph_json: String,
    options_json: String,
    call_function: Function<FnArgs<(u32, String)>, String>,
  ) -> Result<Self> {
    let host = CallbackHost { callback: &call_function };
    let engine = parse_json(&graph_json, "graph")
      .and_then(|graph| Ok((graph, parse_json(&options_json, "options")?)))
      .and_then(|(graph, options)| Engine::create(&host, &graph, &options))
      .map_err(to_napi_error)?;
    Ok(Self { engine: Arc::new(engine), client_id: None })
  }

  /// Same JSON as `buildRawSchema` (rawTables, rawRelations, tableNameMap, ...).
  #[napi]
  pub fn raw_schema(&self) -> String {
    self.engine.raw_schema_json().to_string()
  }

  /// Tells the engine which payload-sqlite client belongs to this adapter: `call` then rejects
  /// connection ids of another database file.
  #[napi]
  pub fn attach_client(&mut self, client_id: u32) {
    self.client_id = Some(client_id);
  }

  /// Runs one adapter method on `connId` (the client's or the active transaction's connection).
  /// `contextJson` (optional): the call context, `{ allowIDOnCreate, limitedBoundParameters,
  /// blocksAsJSON?, now }` (adapter properties read at call time and the caller's `Date.now()`).
  #[napi(ts_return_type = "Promise<string>")]
  pub fn call<'env>(
    &self,
    env: &'env Env,
    method: String,
    args_json: String,
    conn_id: u32,
    context_json: Option<String>,
  ) -> Result<Object<'env>> {
    if let Some(client) = self.client_id {
      if client != conn_id && !worker::same_queue(client, conn_id) {
        let error = EngineError::internal(format!("connection {conn_id} does not belong to the adapter's client {client}"));
        return Err(to_napi_error(error));
      }
    }
    let engine = Arc::clone(&self.engine);
    crate::sqlite::queue_job(env, conn_id, move |session| {
      engine.call_json(&method, &args_json, context_json.as_deref(), session).map_err(to_napi_error)
    })
  }
}
