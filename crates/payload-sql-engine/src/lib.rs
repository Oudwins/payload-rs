//! The SQLite engine of `packages/engine-rs/ENGINE_CONTRACT.md`: one [`SqliteEngine`] per
//! adapter instance decodes the config graph once, builds the raw schema from it (both live as
//! long as the engine) and runs every `@payloadcms/drizzle` data method by composing the module
//! crates:
//!
//! - `payload-sql-query`: `buildQuery` (where / sort / joins) and the select statements
//! - `payload-sql-find`: `buildFindManyArgs`, `findMany`, drizzle relational queries
//! - `payload-sql-read`: the read `transform`
//! - `payload-sql-write`: `transformForWrite`
//! - `payload-sql-upsert`: `upsertRow` and the write operations
//!
//! All SQL runs inside a `payload-sqlite` worker job on the [`Session`] of the client or
//! transaction `ConnId` the call was made for: payload-sql-find statements through
//! [`LibsqlConn`] (libsql's `executeStmt` port), payload-sql-upsert statements on the same
//! connection's `rusqlite::Connection`. Engine statements therefore share ordering and
//! transactions with drizzle and the TS client.
//!
//! The operations themselves (packages/drizzle/src/*.ts) are ported in [`ops`].

pub mod convert;
mod fields;
mod hosts;
mod ops;
mod schema_json;

use std::collections::HashMap;

use payload_engine::error::{EngineError, Result};
use payload_engine::host::Host;
use payload_engine::js::{JsVal, decode_graph, decode_graph_typed, encode_value};
use payload_engine::sql::schema::{RawSchema, SchemaInput, SchemaOptions, build_raw_schema, resolve_path};
use payload_sql_find::exec::{LibsqlConn, client_error_json};
use payload_sql_find::schema::DrizzleSchema;
use payload_sqlite::{IntMode, Session};
use serde_json::{Value as Json, json};

pub use payload_sqlite::rusqlite;

/// Adapter options (`optionsJson` of the contract).
#[derive(Clone, Debug)]
pub struct EngineOptions {
  pub schema: SchemaOptions,
  pub query: payload_sql_query::AdapterOptions,
  pub upsert: payload_sql_upsert::AdapterOptions,
  /// `Date.now()` of the JS caller for this call (`contextJson.now`): every "now" stamp of the
  /// method uses it, so fake timers apply. `None` reads the system clock.
  pub now: Option<f64>,
}

impl EngineOptions {
  /// `{ idType, autoIncrement, blocksAsJSON, localesSuffix, relationshipsSuffix, versionsSuffix,
  /// allowIDOnCreate, name, limitedBoundParameters }`
  pub fn from_json(json: &Json) -> Self {
    Self {
      schema: SchemaOptions::from_json(json),
      query: payload_sql_query::AdapterOptions::from_json(json),
      upsert: payload_sql_upsert::AdapterOptions::from_js(&JsVal::from_json(json)),
      now: None,
    }
  }

  /// These options with the call context applied (`contextJson` of `call`:
  /// `{ allowIDOnCreate?, blocksAsJSON?, limitedBoundParameters?, now? }`). Payload code and tests
  /// assign the flags on a live adapter (`payload.db.allowIDOnCreate = true`), and the drizzle data
  /// methods read them per call; `now` is the caller's `Date.now()`.
  pub fn at_call_time(&self, adapter: &Json) -> Self {
    let mut out = self.clone();
    out.now = adapter.get("now").and_then(Json::as_f64).filter(|n| n.is_finite());
    let flag = |key: &str| adapter.get(key).map(|v| JsVal::from_json(v).truthy());
    if let Some(allow) = flag("allowIDOnCreate") {
      out.upsert.allow_id_on_create = allow;
    }
    if let Some(blocks) = flag("blocksAsJSON") {
      out.schema.blocks_as_json = blocks;
      out.query.blocks_as_json = blocks;
    }
    if let Some(limited) = flag("limitedBoundParameters") {
      out.query.limited_bound_parameters = limited;
      out.upsert.limited_bound_parameters = limited;
    }
    out
  }
}

/// The state of one adapter instance.
pub struct SqliteEngine {
  /// `{ config, collections: { [slug]: { config, customIDType } }, blocks }`, decoded once.
  root: JsVal,
  schema: RawSchema,
  drizzle: DrizzleSchema,
  options: EngineOptions,
}

impl SqliteEngine {
  /// Decodes `graph` (`serializeForEngine` output, `Date`s / `bigint`s kept typed) and builds the
  /// raw schema. JS functions the schema builder calls (`dbName` / `enumName`) go through `host`.
  ///
  /// `options.blockTableNameIndexes` (`[path, index][]`) seeds `InternalBlockTableNameIndex`
  /// values already present on block objects (re-init).
  pub fn create(host: &dyn Host, graph: &Json, options: &Json) -> Result<Self> {
    let root = decode_graph_typed(graph)?;
    let options_value = options;
    let options = EngineOptions::from_json(options_value);

    let mut seeds = HashMap::new();
    for entry in options_value.get("blockTableNameIndexes").and_then(Json::as_array).into_iter().flatten() {
      let path: Vec<String> = entry
        .get(0)
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .map(|k| k.as_str().map(str::to_string).unwrap_or_else(|| k.to_string()))
        .collect();
      let index = entry.get(1).and_then(Json::as_f64).unwrap_or(0.0) as u32;
      if let Some(id) = resolve_path(&root, &path).and_then(JsVal::identity) {
        seeds.insert(id, index);
      }
    }

    let schema = build_raw_schema(
      host,
      SchemaInput {
        config: root.get("config"),
        collections: root.get("collections"),
        blocks: root.get("blocks"),
        block_table_name_index: seeds,
      },
      options.schema.clone(),
    )?;
    let schema_json = schema.to_json();
    let drizzle = DrizzleSchema::from_raw(&schema_json["rawTables"], &schema_json["rawRelations"])?;
    Ok(Self { root, schema, drizzle, options })
  }

  /// The JSON napi `buildRawSchema` returns (`rawTables`, `rawTableKeys`, `rawRelations`,
  /// `tableNameMap` pairs, `indexes`, `foreignKeys`, `fieldConstraints`, `blockTableNameIndexes`,
  /// `columnDefaults`), for the schema this engine built.
  pub fn raw_schema_json(&self) -> Json {
    schema_json::raw_schema_output(&self.root, &self.schema)
  }

  pub fn schema(&self) -> &RawSchema {
    &self.schema
  }

  pub fn options(&self) -> &EngineOptions {
    &self.options
  }

  /// Runs one adapter method in `session` (a job of the call's `ConnId`). `args_json` is
  /// `serializeForEngine(args)`; the result is the method's return value in the
  /// `serializeForEngine` tree encoding (`deserializeFromEngine`).
  ///
  /// `context_json` carries the call context (adapter properties read at call time and the
  /// caller's clock, see [`EngineOptions::at_call_time`]); `None` uses the options the engine was
  /// created with and the system clock.
  pub fn call_json(
    &self,
    method: &str,
    args_json: &str,
    context_json: Option<&str>,
    session: &mut Session<'_>,
  ) -> Result<String> {
    let graph: Json =
      serde_json::from_str(args_json).map_err(|e| EngineError::internal(format!("invalid args JSON: {e}")))?;
    let args = decode_graph(&graph)?;
    let options = match context_json {
      Some(text) => {
        let context: Json =
          serde_json::from_str(text).map_err(|e| EngineError::internal(format!("invalid context JSON: {e}")))?;
        self.options.at_call_time(&context)
      }
      None => self.options.clone(),
    };
    let result = self.call(method, &args, &options, session)?;
    Ok(encode_value(&result).to_string())
  }

  /// Runs one adapter method in `session` with decoded arguments and the call's options. Never
  /// panics: an internal panic becomes an `Error`.
  pub fn call(&self, method: &str, args: &JsVal, options: &EngineOptions, session: &mut Session<'_>) -> Result<JsVal> {
    let conn = LibsqlConn::from_session(session, IntMode::Number).map_err(|e| client_error(&e))?;
    let raw = conn.conn.connection().map_err(|e| client_error(&e))?;
    let run = std::panic::AssertUnwindSafe(|| ops::dispatch(self, options, method, args, &conn, raw));
    match std::panic::catch_unwind(run) {
      Ok(result) => result,
      Err(panic) => {
        let message = panic
          .downcast_ref::<String>()
          .cloned()
          .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
          .unwrap_or_else(|| "unknown panic".into());
        Err(EngineError::internal(format!("payload-sql-engine panicked in {method}: {message}")))
      }
    }
  }
}

/// A connection error of the session (e.g. a closed client): libsql's error, as data.
fn client_error(error: &payload_sqlite::ClientError) -> EngineError {
  let json = client_error_json(error);
  let message = json["message"].as_str().unwrap_or("").to_string();
  EngineError::new("LibsqlError", message).with_data(json)
}

/// The JSON an engine error crosses the napi boundary as (ENGINE_CONTRACT.md "Errors"):
/// `{ name, message, data }`, except for failed statements, which become drizzle's
/// `DrizzleQueryError`: `{ name: 'DrizzleQueryError', message, query, params, cause }` with
/// `params` in the tree encoding and `cause` a sqlite runtime error
/// (`{ code, kind: 'sqlite', message, rawCode }`, as `packages/engine-rs/src/sqlite/native.ts`).
///
/// Statement failures are recognised by their typed origin: payload-sql-upsert's executor builds
/// them (`DbError::to_engine_error`) as name `Error` with `{ query, params, cause: { code,
/// message, rawCode } }` data; no user value reaches an error's `data` under name `Error`.
///
/// The query crate carries constructor arguments in `data` (`new APIError(message, 400)` as
/// `{ status: 400 }`, `new QueryError([{ path }])` as `{ status: 400, data: [{ path }] }`); they
/// are moved to the contract's fields: `APIError` gets a top-level `status` and `data` (the
/// constructor's `data` argument), `QueryError`'s `data` is the `[{ path }]` list.
pub fn error_json(error: &EngineError) -> Json {
  if let Some(drizzle) = drizzle_query_error(error) {
    return drizzle;
  }
  let mut out = error.to_json();
  let data = error.data.as_ref().and_then(Json::as_object);
  match (error.name.as_str(), data) {
    ("APIError", Some(data)) if data.contains_key("status") => {
      out["status"] = data["status"].clone();
      out["data"] = data.get("data").cloned().unwrap_or(Json::Null);
    }
    ("QueryError", Some(data)) if data.contains_key("data") => {
      out["data"] = data["data"].clone();
    }
    _ => {}
  }
  out
}

fn drizzle_query_error(error: &EngineError) -> Option<Json> {
  let data = error.data.as_ref()?.as_object()?;
  // payload-sql-find (`exec::drizzle_query_error`) already builds the boundary shape as data
  if error.name == "DrizzleQueryError" {
    let mut out = serde_json::Map::new();
    out.insert("name".into(), json!("DrizzleQueryError"));
    out.insert("message".into(), json!(error.message));
    for key in ["query", "params", "cause"] {
      out.insert(key.into(), data.get(key).cloned().unwrap_or(Json::Null));
    }
    return Some(Json::Object(out));
  }
  if error.name != "Error" {
    return None;
  }
  if data.len() != 3 {
    return None;
  }
  let query = data.get("query")?.as_str()?;
  let params = data.get("params")?.as_array()?;
  let cause = data.get("cause")?.as_object()?;
  let code = cause.get("code")?.as_str()?;
  let message = cause.get("message")?.as_str()?;
  let raw_code = cause.get("rawCode")?;
  // libsql's `LibsqlError` message is `${code}: ${message}`; the cause carries the sqlite message
  let sqlite_message = message.strip_prefix(&format!("{code}: ")).unwrap_or(message).to_string();
  let cause = if raw_code.is_null() {
    json!({ "code": code, "kind": "libsql", "message": payload_sqlite::conn::compat_message(sqlite_message) })
  } else {
    json!({ "code": code, "kind": "sqlite", "message": payload_sqlite::conn::compat_message(sqlite_message), "rawCode": raw_code })
  };
  Some(json!({
    "name": "DrizzleQueryError",
    "message": error.message,
    "query": query,
    "params": params,
    "cause": cause,
  }))
}
