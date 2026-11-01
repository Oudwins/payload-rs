//! Test-only Node binding used by test/__rs/find/*.int.spec.ts to compare the
//! Rust port against the live TS implementation, call by call.
//!
//! The addon also compiles the `payload-sqlite` napi bindings of
//! `crates/payload-node` (`sqlite*` functions), so it can be loaded as
//! `PAYLOAD_ENGINE_ADDON` by `@payloadcms/engine-rs/sqlite`: the TS client that
//! backs `payload.db.drizzle` and the Rust find code then share one
//! `payload-sqlite` registry, and Rust statements run on the very client or
//! transaction connection (by `ConnId`) the TS query used.

use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::Function;
use napi_derive::napi;
use payload_engine::error::{EngineError, Result as EngineResult};
use payload_engine::host::Host;
use payload_engine::js::{decode_graph_typed, encode_value};
use payload_sql_find::args::QueryConfig;
use payload_sql_find::exec::{self, QueuedConn};
use payload_sql_find::relational::{Mode, build_relational_query};
use payload_sql_find::schema::DrizzleSchema;
use payload_sqlite::IntMode;
use payload_sqlite::worker::{self, ConnId};
use serde_json::{Value as Json, json};

#[path = "../../../payload-node/src/sqlite.rs"]
#[allow(dead_code, clippy::all)]
mod sqlite;

static SCHEMAS: Mutex<Vec<Arc<DrizzleSchema>>> = Mutex::new(Vec::new());

fn to_napi(e: EngineError) -> napi::Error {
  napi::Error::from_reason(format!("{}: {}", e.name, e.message))
}

fn parse(text: &str) -> napi::Result<Json> {
  serde_json::from_str(text).map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn schema(handle: u32) -> napi::Result<Arc<DrizzleSchema>> {
  SCHEMAS
    .lock()
    .map_err(|_| napi::Error::from_reason("poisoned"))?
    .get(handle as usize)
    .cloned()
    .ok_or_else(|| napi::Error::from_reason("unknown schema handle"))
}

/// Registers a live drizzle schema description (`describeDrizzleSchema`).
#[napi]
pub fn register_schema(schema_json: String) -> napi::Result<u32> {
  let schema = DrizzleSchema::from_json(&parse(&schema_json)?).map_err(to_napi)?;
  let mut schemas = SCHEMAS.lock().map_err(|_| napi::Error::from_reason("poisoned"))?;
  schemas.push(Arc::new(schema));
  Ok((schemas.len() - 1) as u32)
}

/// Registers a schema built from `adapter.rawTables` + `adapter.rawRelations`.
#[napi]
pub fn register_raw_schema(raw_tables_json: String, raw_relations_json: String) -> napi::Result<u32> {
  let schema = DrizzleSchema::from_raw(&parse(&raw_tables_json)?, &parse(&raw_relations_json)?).map_err(to_napi)?;
  let mut schemas = SCHEMAS.lock().map_err(|_| napi::Error::from_reason("poisoned"))?;
  schemas.push(Arc::new(schema));
  Ok((schemas.len() - 1) as u32)
}

/// Clients this binding opened itself for `{ dbPath }` targets (reference runs
/// on the real `@libsql/client`, whose connections Rust cannot share):
/// `(path, (dev, inode), id)`. A recreated file gets a new client.
static OWN_CLIENTS: Mutex<Vec<(String, (u64, u64), ConnId)>> = Mutex::new(Vec::new());

fn file_id(db_path: &str) -> napi::Result<(u64, u64)> {
  use std::os::unix::fs::MetadataExt;
  let meta = std::fs::metadata(db_path).map_err(|e| napi::Error::from_reason(format!("{db_path}: {e}")))?;
  Ok((meta.dev(), meta.ino()))
}

/// The executor of a target: `{ connId }` (the `payload-sqlite` client or
/// transaction id of the TS query) or `{ dbPath }`.
fn executor(target: &Json) -> napi::Result<QueuedConn> {
  if let Some(id) = target.get("connId").and_then(|v| v.as_u64()) {
    return Ok(QueuedConn { id: id as ConnId, int_mode: IntMode::Number });
  }
  let path = target
    .get("dbPath")
    .and_then(|v| v.as_str())
    .ok_or_else(|| napi::Error::from_reason("target needs connId or dbPath"))?;
  let fid = file_id(path)?;
  let mut clients = OWN_CLIENTS.lock().map_err(|_| napi::Error::from_reason("poisoned"))?;
  if let Some((_, _, id)) = clients.iter().find(|(p, f, _)| p == path && *f == fid) {
    return Ok(QueuedConn { id: *id, int_mode: IntMode::Number });
  }
  for (_, _, id) in clients.drain(..).filter(|(p, _, _)| p == path) {
    worker::release(id);
  }
  let id = worker::open_client(path).map_err(|e| napi::Error::from_reason(e.to_string()))?;
  clients.push((path.to_string(), fid, id));
  Ok(QueuedConn { id, int_mode: IntMode::Number })
}

/// Runs `fromDriver` functions of custom columns through a JS callback
/// `(json: string) => string`, with `json = { id, arg }` (`arg` and the result
/// in the `serializeForEngine` tree format).
struct JsHost<'a> {
  call: Option<&'a Function<'a, String, String>>,
}

impl Host for JsHost<'_> {
  fn call(&self, id: u32, arg: &Json) -> EngineResult<payload_engine::js::JsVal> {
    let call = self.call.ok_or_else(|| EngineError::internal(format!("no JS host available to call function {id}")))?;
    let out = call
      .call(json!({ "id": id, "arg": arg }).to_string())
      .map_err(|e| EngineError::new("Error", e.reason.clone()))?;
    let tree: Json = serde_json::from_str(&out).map_err(|e| EngineError::internal(e.to_string()))?;
    if let Some(err) = tree.get("$error") {
      return Err(EngineError::new(
        err.get("name").and_then(|n| n.as_str()).unwrap_or("Error"),
        err.get("message").and_then(|n| n.as_str()).unwrap_or(""),
      ));
    }
    decode_graph_typed(&json!({ "root": tree, "objects": [] }))
  }
}

/// Builds and (when `target_json` is not empty) executes
/// `db.query[table].findMany(config)` / `findFirst`.
/// Returns `{ sql, params, result }` (`result` in the `serializeForEngine`
/// tree format, so `undefined`, `Date`s and `bigint`s are kept) or `{ error }`.
#[napi]
pub fn relational_query(
  schema_handle: u32,
  target_json: String,
  table: String,
  config_json: String,
  mode: String,
  call_function: Option<Function<String, String>>,
) -> napi::Result<String> {
  let schema = schema(schema_handle)?;
  let config = QueryConfig::from_json(&parse(&config_json)?).map_err(to_napi)?;
  let mode = if mode == "first" { Mode::First } else { Mode::Many };
  let host = JsHost { call: call_function.as_ref() };
  let out = match build_relational_query(&schema, &table, &config, mode) {
    Err(e) => json!({ "error": e.to_json() }),
    Ok(built) => {
      let mut out = json!({ "sql": built.sql.sql, "params": built.sql.params });
      if !target_json.is_empty() {
        let conn = executor(&parse(&target_json)?)?;
        match exec::execute_js(&conn, &built, mode, &host) {
          Ok(result) => out["result"] = encode_value(&result),
          Err(e) => out["error"] = e.to_json(),
        }
      }
      out
    }
  };
  Ok(out.to_string())
}

// ---------------------------------------------------------------------------
// buildFindManyArgs / findMany on top of the Rust query builder
// ---------------------------------------------------------------------------

use std::collections::{HashMap, HashSet};

use payload_engine::js::{JsVal, decode_graph};
use payload_engine::sql::schema::{RawSchema, RawTable};
use payload_sql_find::build_args::{BuildFindManyArgs, build_find_many_args};
use payload_sql_find::context::{AdapterOptions, FieldsSource, FindContext};
use payload_sql_find::find_many::{FindManyArgs, FindManyTrace, find_many_js};
use payload_sql_find::query::SqlQueryBuilder;
use payload_sql_find::sql::Sql;
use payload_sql_query::QueryAdapter;

const BLOCK_MARKER: &str = "__rsBlockTableNameIndex";

struct PayloadCtx {
  root: JsVal,
  schema: Arc<DrizzleSchema>,
  /// `RawSchema` the query builder reads; per-call block indexes of inline field graphs are
  /// added for the duration of a call.
  raw: Mutex<RawSchema>,
  options: AdapterOptions,
}

static PAYLOADS: Mutex<Vec<Arc<PayloadCtx>>> = Mutex::new(Vec::new());

fn collect_block_index(value: &JsVal, seen: &mut HashSet<usize>, out: &mut HashMap<usize, u32>) {
  match value {
    JsVal::Obj(o) => {
      let Some(id) = value.identity() else { return };
      if !seen.insert(id) {
        return;
      }
      if let Some(n) = o.get(BLOCK_MARKER).and_then(|v| v.as_num()) {
        out.insert(id, n as u32);
      }
      for v in o.values() {
        collect_block_index(v, seen, out);
      }
    }
    JsVal::Arr(a) => {
      let Some(id) = value.identity() else { return };
      if !seen.insert(id) {
        return;
      }
      for v in a.iter() {
        collect_block_index(v, seen, out);
      }
    }
    _ => {}
  }
}

fn raw_schema(raw_tables: &Json, raw_relations: &Json, table_name_map: &Json, block_index: HashMap<usize, u32>) -> RawSchema {
  let map = |v: &Json, k: &str| v.get(k).and_then(|x| x.as_object()).cloned().unwrap_or_default();
  RawSchema {
    raw_tables: raw_tables
      .as_object()
      .into_iter()
      .flatten()
      .map(|(k, t)| {
        let table = RawTable {
          name: t.get("name").and_then(|n| n.as_str()).unwrap_or(k).to_string(),
          columns: map(t, "columns"),
          foreign_keys: map(t, "foreignKeys"),
          indexes: map(t, "indexes"),
        };
        (k.clone(), Some(table))
      })
      .collect(),
    raw_relations: raw_relations
      .as_object()
      .into_iter()
      .flatten()
      .map(|(k, v)| (k.clone(), v.as_object().cloned().unwrap_or_default()))
      .collect(),
    table_name_map: table_name_map
      .as_object()
      .into_iter()
      .flatten()
      .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
      .collect(),
    block_table_name_index: block_index,
    ..Default::default()
  }
}

/// Registers `{ config, collections, blocks }` (serialized with `serializeForEngine`, blocks
/// carrying `__rsBlockTableNameIndex`), the adapter options, `adapter.tableNameMap`,
/// `adapter.rawTables` and `adapter.rawRelations`. The drizzle schema is built from the raw
/// schema, or is the registered `schema_handle` (a live schema with `afterSchemaInit` extensions).
#[napi]
pub fn register_payload(
  graph_json: String,
  options_json: String,
  table_name_map_json: String,
  raw_tables_json: String,
  raw_relations_json: String,
  schema_handle: Option<u32>,
) -> napi::Result<u32> {
  let root = decode_graph(&parse(&graph_json)?).map_err(to_napi)?;
  let mut block_index = HashMap::new();
  collect_block_index(&root, &mut HashSet::new(), &mut block_index);
  let options = AdapterOptions::from_json(&parse(&options_json)?);
  let (raw_tables, raw_relations) = (parse(&raw_tables_json)?, parse(&raw_relations_json)?);
  let schema = match schema_handle {
    Some(handle) => schema(handle)?,
    None => Arc::new(DrizzleSchema::from_raw(&raw_tables, &raw_relations).map_err(to_napi)?),
  };
  let raw = raw_schema(&raw_tables, &raw_relations, &parse(&table_name_map_json)?, block_index);
  let ctx = PayloadCtx { root, schema, raw: Mutex::new(raw), options };
  let mut payloads = PAYLOADS.lock().map_err(|_| napi::Error::from_reason("poisoned"))?;
  payloads.push(Arc::new(ctx));
  Ok((payloads.len() - 1) as u32)
}

fn payload(handle: u32) -> napi::Result<Arc<PayloadCtx>> {
  PAYLOADS
    .lock()
    .map_err(|_| napi::Error::from_reason("poisoned"))?
    .get(handle as usize)
    .cloned()
    .ok_or_else(|| napi::Error::from_reason("unknown payload handle"))
}

/// Resolves `{ collection }` or `{ graph }` fields; returns the fields, their source and the
/// block index of an inline graph.
fn resolve_fields(ctx: &PayloadCtx, spec: &Json) -> napi::Result<(JsVal, FieldsSource, HashMap<usize, u32>)> {
  if let Some(slug) = spec.get("collection").and_then(|s| s.as_str()) {
    let fields = ctx.root.get("collections").get(slug).get("config").get("flattenedFields").clone();
    return Ok((fields, FieldsSource::Collection(slug.into()), HashMap::new()));
  }
  let graph = spec.get("graph").ok_or_else(|| napi::Error::from_reason("fields spec needs collection or graph"))?;
  let fields = decode_graph(graph).map_err(to_napi)?;
  let mut index = HashMap::new();
  collect_block_index(&fields, &mut HashSet::new(), &mut index);
  Ok((fields, FieldsSource::Caller, index))
}

/// Reads an argument; `{ "$graph": <serializeForEngine output> }` keeps `undefined` values.
fn js_arg(args: &Json, key: &str) -> JsVal {
  match args.get(key) {
    None => JsVal::Undefined,
    Some(v) => match v.get("$graph") {
      Some(graph) => decode_graph(graph).unwrap_or(JsVal::Undefined),
      None => JsVal::from_json(v),
    },
  }
}

fn str_arg<'a>(args: &'a Json, key: &str) -> Option<&'a str> {
  args.get(key).and_then(|v| v.as_str())
}

/// Runs `f` with a [`FindContext`] backed by the Rust query builder.
fn with_find_ctx<T>(
  ctx: &PayloadCtx,
  inline_index: HashMap<usize, u32>,
  f: impl FnOnce(&FindContext<'_>) -> T,
) -> napi::Result<T> {
  let mut raw = ctx.raw.lock().map_err(|_| napi::Error::from_reason("poisoned"))?;
  let added: Vec<usize> = inline_index.keys().filter(|k| !raw.block_table_name_index.contains_key(k)).copied().collect();
  raw.block_table_name_index.extend(inline_index);
  let config = ctx.root.get("config");
  let collections = ctx.root.get("collections");
  let blocks = ctx.root.get("blocks");
  let out = {
    let adapter = QueryAdapter::new(&raw, config, collections, blocks, ctx.options.clone());
    let query = SqlQueryBuilder::new(&adapter);
    let find_ctx = FindContext {
      schema: &ctx.schema,
      table_name_map: &raw.table_name_map,
      config,
      collections,
      blocks,
      block_table_name_index: &raw.block_table_name_index,
      options: &ctx.options,
      query: &query,
    };
    f(&find_ctx)
  };
  for k in added {
    raw.block_table_name_index.remove(&k);
  }
  Ok(out)
}

#[napi]
pub fn build_find_many_args_rs(handle: u32, args_json: String) -> napi::Result<String> {
  let ctx = payload(handle)?;
  let args = parse(&args_json)?;
  let (fields, _, inline_index) = resolve_fields(&ctx, &args["fields"])?;
  let select = js_arg(&args, "select");
  let join_query = js_arg(&args, "joinQuery");
  let out = with_find_ctx(&ctx, inline_index, |find_ctx| {
    build_find_many_args(
      find_ctx,
      &BuildFindManyArgs {
        collection_slug: str_arg(&args, "collectionSlug"),
        depth: args.get("depth").and_then(|d| d.as_f64()),
        drafts_enabled: args.get("draftsEnabled").and_then(|d| d.as_bool()).unwrap_or(false),
        fields: &fields,
        join_query: &join_query,
        locale: str_arg(&args, "locale"),
        select: &select,
        table_name: str_arg(&args, "tableName").unwrap_or(""),
        versions: args.get("versions").and_then(|d| d.as_bool()).unwrap_or(false),
      },
    )
  })?;
  Ok(match out {
    Ok(config) => json!({ "result": config.to_json() }),
    Err(e) => json!({ "error": e.to_json() }),
  }
  .to_string())
}

#[napi]
pub fn find_many_rs(
  handle: u32,
  args_json: String,
  target_json: String,
  call_function: Option<Function<String, String>>,
) -> napi::Result<String> {
  let ctx = payload(handle)?;
  let args = parse(&args_json)?;
  let (fields, fields_source, inline_index) = resolve_fields(&ctx, &args["fields"])?;
  let joins = js_arg(&args, "joins");
  let select = js_arg(&args, "select");
  let sort = js_arg(&args, "sort");
  let where_ = js_arg(&args, "where");
  let mut trace = FindManyTrace::default();
  let conn = executor(&parse(&target_json)?)?;
  let host = JsHost { call: call_function.as_ref() };
  let out = {
    with_find_ctx(&ctx, inline_index, |find_ctx| {
    find_many_js(
      find_ctx,
      &conn,
      &FindManyArgs {
        collection_slug: str_arg(&args, "collectionSlug"),
        drafts_enabled: args.get("draftsEnabled").and_then(|d| d.as_bool()).unwrap_or(false),
        fields: &fields,
        fields_source,
        joins: &joins,
        limit: args.get("limit").and_then(|d| d.as_f64()),
        locale: str_arg(&args, "locale"),
        page: args.get("page").and_then(|d| d.as_f64()),
        pagination: args.get("pagination").and_then(|d| d.as_bool()),
        select: &select,
        sort: &sort,
        table_name: str_arg(&args, "tableName").unwrap_or(""),
        versions: args.get("versions").and_then(|d| d.as_bool()).unwrap_or(false),
        where_: &where_,
      },
      &host,
      &mut |doc| Ok(doc),
      Some(&mut trace),
    )
    })
  }?;
  let sql_json = |s: &Option<Sql>| s.as_ref().map(|s| s.to_json()).unwrap_or(Json::Null);
  Ok(match out {
    Ok(result) => json!({
      "result": encode_value(&result.to_js()),
      "trace": { "distinct": sql_json(&trace.distinct), "count": sql_json(&trace.count), "relational": sql_json(&trace.relational) },
    }),
    Err(e) => json!({ "error": e.to_json() }),
  }
  .to_string())
}

/// Compares two registered schemas (e.g. live drizzle vs `from_raw`); returns a description of
/// the first differences or an empty string.
#[napi]
pub fn diff_schemas(a: u32, b: u32) -> napi::Result<String> {
  let (a, b) = (schema(a)?, schema(b)?);
  let mut out = Vec::new();
  for (name, table) in &a.tables {
    match b.tables.get(name) {
      None => out.push(format!("missing table {name}")),
      Some(other) if other != table => out.push(format!("table {name}: {table:?} != {other:?}")),
      _ => {}
    }
  }
  for name in b.tables.keys() {
    if !a.tables.contains_key(name) {
      out.push(format!("extra table {name}"));
    }
  }
  out.truncate(5);
  Ok(out.join("\n"))
}
