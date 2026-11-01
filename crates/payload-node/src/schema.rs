//! napi bindings for the raw SQL schema builder (`@payloadcms/drizzle` `buildRawSchema`).

use std::collections::HashMap;

use napi::bindgen_prelude::{FnArgs, Function};
use napi::{Error, Status};
use napi_derive::napi;
use payload_engine::error::EngineError;
use payload_engine::host::Host;
use payload_engine::js::{JsVal, decode_graph_typed, encode_value};
use payload_engine::sql::schema::{RawSchema, SchemaInput, SchemaOptions, build_raw_schema, find_identity_paths, resolve_path};
use payload_engine::strings::json_to_string_with_utf16;
use serde_json::{Value as Json, json};

/// Calls registered JS functions through the `callFunction(id, argJson)` callback. The argument
/// is encoded with [`encode_value`] (decoded by `deserializeFromEngine`, so own keys holding
/// `undefined` survive), the result with `serializeForEngine` (decoded typed).
struct CallbackHost<'a, 'env> {
  callback: &'a Function<'env, FnArgs<(u32, String)>, String>,
}

impl Host for CallbackHost<'_, '_> {
  fn call(&self, id: u32, arg: &Json) -> payload_engine::error::Result<JsVal> {
    self.call_value(id, &JsVal::from_json(arg))
  }

  fn call_value(&self, id: u32, arg: &JsVal) -> payload_engine::error::Result<JsVal> {
    let result = self
      .callback
      .call((id, encode_value(arg).to_string()).into())
      .map_err(|e| EngineError::new("HostError", e.reason.clone()))?;
    let graph: Json = serde_json::from_str(&result)
      .map_err(|e| EngineError::internal(format!("invalid host function result: {e}")))?;
    if graph.get("$hostError").is_some() {
      return Err(EngineError::new("HostError", format!("JS function {id} threw")));
    }
    decode_graph_typed(&graph)
  }
}

/// `[table, column, { path } | { value }]` for the column defaults whose JS value the column JSON
/// does not reproduce.
fn column_defaults(root: &JsVal, schema: &RawSchema) -> Vec<Json> {
  let defaults = &schema.column_defaults;
  let needs_js_value = |v: &JsVal| match v {
    JsVal::Obj(_) | JsVal::Arr(_) => true,
    JsVal::Num(n) => !n.is_finite(),
    _ => false,
  };
  let mut identities = HashMap::new();
  for value in defaults.values().flat_map(|columns| columns.values()) {
    if let Some(id) = value.identity() {
      identities.insert(id, 0);
    }
  }
  let paths: HashMap<usize, Vec<String>> = find_identity_paths_by_id(root, &identities);
  let mut out = Vec::new();
  for (table, columns) in defaults {
    for (column, value) in columns {
      if !needs_js_value(value) {
        continue;
      }
      let source = match value.identity().and_then(|id| paths.get(&id)) {
        Some(path) => json!({ "path": path }),
        None => json!({ "value": encode_value(value) }),
      };
      out.push(json!([table, column, source]));
    }
  }
  out
}

/// Like `find_identity_paths`, keyed by identity.
fn find_identity_paths_by_id(root: &JsVal, ids: &HashMap<usize, u32>) -> HashMap<usize, Vec<String>> {
  let mut tagged = HashMap::new();
  let mut order: Vec<usize> = ids.keys().copied().collect();
  order.sort_unstable();
  for (i, id) in order.iter().enumerate() {
    tagged.insert(*id, i as u32);
  }
  find_identity_paths(root, &tagged).into_iter().map(|(path, i)| (order[i as usize], path)).collect()
}

/// Engine errors are thrown as a JS `Error` whose message is the JSON `{ name, message, data }`,
/// so the TS side can rethrow the matching Payload error class.
pub(crate) fn to_napi_error(error: EngineError) -> Error {
  Error::new(Status::GenericFailure, error.to_json().to_string())
}

fn parse_json(input: &str, what: &str) -> Result<Json, EngineError> {
  serde_json::from_str(input).map_err(|e| EngineError::internal(format!("invalid {what} JSON: {e}")))
}

/// `buildRawSchema(graphJson, optionsJson, callFunction)`
///
/// - `graphJson`: `serializeForEngine({ config, collections, blocks })`
/// - `optionsJson`: `{ autoIncrement, blocksAsJSON, idType, localesSuffix, relationshipsSuffix,
///   versionsSuffix, blockTableNameIndexes?: [path: string[], index: number][] }`
///
/// The graph is decoded with `Date`s / `bigint`s kept typed (`decode_graph_typed`).
///
/// Returns JSON `{ rawTables, rawTableKeys, rawRelations, tableNameMap, indexes, foreignKeys,
/// fieldConstraints, blockTableNameIndexes, columnDefaults }` where
/// - `rawTableKeys` lists every `rawTables` key in order, including keys TS leaves `undefined`
///   (placeholders that were never filled, dropped from the `rawTables` JSON);
/// - `tableNameMap` is `[key, value]` pairs in insertion order, `indexes` / `foreignKeys` are arrays
///   in insertion order;
/// - `blockTableNameIndexes` lists `[path, index]` pairs for every block object that carries
///   `InternalBlockTableNameIndex`;
/// - `columnDefaults` lists `[table, column, source]` for column defaults JSON cannot carry (objects,
///   arrays, `Date`s, `bigint`s, non-finite numbers): `source` is `{ path }` when the value is
///   reachable from the input graph (TS reuses that object, like `default: field.defaultValue`),
///   otherwise `{ value }` in the `serializeForEngine` encoding.
///
/// Generated identifiers that are not valid UTF-16 (a truncation that cut a surrogate pair) are
/// written with their exact code units (`RawSchema::utf16_identifiers`).
#[napi(js_name = "buildRawSchema")]
pub fn build_raw_schema_js(
  graph_json: String,
  options_json: String,
  call_function: Function<FnArgs<(u32, String)>, String>,
) -> napi::Result<String> {
  run(&graph_json, &options_json, &call_function).map_err(to_napi_error)
}

fn run(
  graph_json: &str,
  options_json: &str,
  call_function: &Function<FnArgs<(u32, String)>, String>,
) -> Result<String, EngineError> {
  let root = decode_graph_typed(&parse_json(graph_json, "graph")?)?;
  let options = parse_json(options_json, "options")?;

  let mut seeds = HashMap::new();
  for entry in options.get("blockTableNameIndexes").and_then(|v| v.as_array()).into_iter().flatten() {
    let path: Vec<String> = entry
      .get(0)
      .and_then(|p| p.as_array())
      .into_iter()
      .flatten()
      .map(|k| k.as_str().map(str::to_string).unwrap_or_else(|| k.to_string()))
      .collect();
    let index = entry.get(1).and_then(|i| i.as_f64()).unwrap_or(0.0) as u32;
    if let Some(id) = resolve_path(&root, &path).and_then(|v| v.identity()) {
      seeds.insert(id, index);
    }
  }

  let host = CallbackHost { callback: call_function };
  let schema = build_raw_schema(
    &host,
    SchemaInput {
      config: root.get("config"),
      collections: root.get("collections"),
      blocks: root.get("blocks"),
      block_table_name_index: seeds,
    },
    SchemaOptions::from_json(&options),
  )?;

  let mut out = schema.to_json();
  let block_indexes: Vec<Json> = find_identity_paths(&root, &schema.block_table_name_index)
    .into_iter()
    .map(|(path, index)| json!([path, index]))
    .collect();
  if let Some(o) = out.as_object_mut() {
    // `Map` entries as pairs: a JSON object would reorder integer-like keys when parsed in JS.
    let table_name_map = schema.table_name_map.iter().map(|(k, v)| json!([k, v])).collect();
    o.insert("tableNameMap".into(), Json::Array(table_name_map));
    o.insert("blockTableNameIndexes".into(), Json::Array(block_indexes));
    o.insert("rawTableKeys".into(), json!(schema.raw_tables.keys().collect::<Vec<_>>()));
    o.insert("columnDefaults".into(), Json::Array(column_defaults(&root, &schema)));
  }
  Ok(json_to_string_with_utf16(&out, &schema.utf16_identifiers))
}
