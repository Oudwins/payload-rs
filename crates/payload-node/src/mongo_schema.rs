//! napi binding of `payload-mongo-schema` (the mongoose models `@payloadcms/db-mongodb`'s `init`
//! builds), replayed by packages/engine-rs/src/mongo-schema.

use napi::bindgen_prelude::{FnArgs, Function};
use napi_derive::napi;
use payload_engine::error::EngineError;
use payload_engine::host::Host;
use payload_engine::js::{JsVal, decode_graph_typed, encode_value};
use payload_mongo_schema::{Input, Options, build_mongo_models};
use serde_json::Value as Json;

use crate::schema::to_napi_error;

/// `callFunction(id, argJson)`: the argument in the `encode_value` encoding, the result in the
/// `serializeForEngine` one (decoded typed). A throwing function answers `{"$hostError":true}`.
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

fn parse_json(input: &str, what: &str) -> Result<Json, EngineError> {
  serde_json::from_str(input).map_err(|e| EngineError::internal(format!("invalid {what} JSON: {e}")))
}

/// `buildMongoSchemaDescription(graphJson, optionsJson, callFunction)`
///
/// - `graphJson`: `serializeForEngine({ config, collections, blocks, collectionsSchemaOptions })`
///   (`collections`: `{ [slug]: { customIDType } }`, `blocks`: `payload.blocks`);
/// - `optionsJson`: `{ useBigIntForNumberIDs, autoPluralization, isCacheEnabled }`.
///
/// Returns the description JSON (`Description::to_json`). Errors upstream throws while building
/// are its last op (`throw`); a JS function that threw is a `throw` op named `HostError`.
#[napi(js_name = "buildMongoSchemaDescription")]
pub fn build_mongo_schema_description_js(
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
  let flag = |key: &str| options.get(key).and_then(Json::as_bool).unwrap_or(false);
  let options = Options {
    use_big_int_for_number_ids: flag("useBigIntForNumberIDs"),
    auto_pluralization: flag("autoPluralization"),
    is_cache_enabled: flag("isCacheEnabled"),
  };
  let host = CallbackHost { callback: call_function };
  let description = build_mongo_models(
    &host,
    Input {
      config: root.get("config"),
      collections: root.get("collections"),
      blocks: root.get("blocks"),
      collections_schema_options: root.get("collectionsSchemaOptions"),
    },
    &options,
  );
  Ok(description.to_json(&root).to_string())
}
