//! Differential check of the db-mongodb utilities against upstream results recorded by
//! test/__rs/mongo-transform/utilities.spec.ts (`utilities.json` below
//! `PAYLOAD_RS_MONGO_TRANSFORM_FIXTURES`, default test/__rs/mongo-transform/fixtures).
//! Fails when no recording is found.

use std::path::{Path, PathBuf};

use payload_engine::error::EngineError;
use payload_engine::host::NoHost;
use payload_engine::js::{JsVal, decode_graph_bson, decode_value_bson, encode_value};
use payload_mongo_transform::{DbNameTarget, ModelKind, get_collection, get_db_name, get_global, handle_error, is_object_id};
use serde_json::{Value as Json, json};

fn find(path: &Path, out: &mut Vec<PathBuf>) {
  if path.is_dir() {
    for entry in std::fs::read_dir(path).into_iter().flatten().flatten() {
      find(&entry.path(), out);
    }
  } else if path.file_name().is_some_and(|n| n == "utilities.json") {
    out.push(path.to_path_buf());
  }
}

fn graph(v: &Json) -> JsVal {
  decode_graph_bson(v).expect("graph")
}

/// The recorded `{ ok }` / `{ error: { name, message, data } }` of a call, as a comparable tree.
fn outcome(result: Result<JsVal, EngineError>) -> Json {
  match result {
    Ok(v) => json!({ "ok": encode_value(&v) }),
    Err(e) => json!({ "error": { "name": e.name, "message": e.message, "data": e.data.unwrap_or(Json::Null) } }),
  }
}

fn recorded(result: &Json) -> Json {
  if let Some(ok) = result.get("ok") {
    return json!({ "ok": encode_value(&graph(ok)) });
  }
  let error = &result["error"];
  json!({ "error": { "name": error["name"], "message": error["message"], "data": encode_value(&graph(&error["data"])) } })
}

#[test]
fn utilities_match_upstream() {
  let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
  let inputs = std::env::var("PAYLOAD_RS_MONGO_TRANSFORM_FIXTURES")
    .map(|v| v.split(':').map(PathBuf::from).collect::<Vec<_>>())
    .unwrap_or_else(|_| vec![root.join("test/__rs/mongo-transform/fixtures")]);
  let mut files = Vec::new();
  for input in &inputs {
    find(input, &mut files);
  }
  assert!(!files.is_empty(), "no utilities.json recording found in {inputs:?}");
  let mut failures = Vec::new();
  let mut checked = 0;
  for file in &files {
    let rec: Json = serde_json::from_str(&std::fs::read_to_string(file).expect("read")).expect("json");

    for case in rec["handleErrorCases"].as_array().expect("cases") {
      checked += 1;
      let error = graph(&case["error"]);
      let options = graph(&case["options"]);
      let localization = options.has("localization").then(|| options.get("localization"));
      let mut actual = match handle_error(&error, options.get("collection").as_str(), options.get("global").as_str(), localization) {
        // upstream rethrows the error itself
        None => json!({ "rethrown": true }),
        Some(e) => outcome(Err(e)),
      };
      let expected = if case["result"].get("error").is_some_and(|e| e["name"] != "ValidationError") || case["result"].get("ok").is_some() {
        json!({ "rethrown": true })
      } else {
        let mut expected = recorded(&case["result"]);
        // the glue fills `errors[].message` and the message `new ValidationError(...)` builds
        expected["error"]["message"] = json!("");
        for e in expected["error"]["data"]["errors"].as_array_mut().into_iter().flatten() {
          e.as_object_mut().map(|o| o.shift_remove("message"));
        }
        expected
      };
      if let Some(data) = actual.pointer_mut("/error/data") {
        *data = encode_value(&decode_value_bson(data).expect("data"));
      }
      if actual != expected {
        failures.push(format!("handleError {}: {actual} != {expected}", case["error"]));
      }
    }

    for case in rec["getDBNameCases"].as_array().expect("cases") {
      checked += 1;
      let target = if case["target"] == "enumName" { DbNameTarget::EnumName } else { DbNameTarget::DbName };
      let actual = outcome(get_db_name(&NoHost, &graph(&case["config"]), target, case["versions"].as_bool().unwrap_or(false)));
      let expected = recorded(&case["result"]);
      if actual != expected {
        failures.push(format!("getDBName {}: {actual} != {expected}", case["config"]));
      }
    }

    let input = graph(&rec["entityInput"]);
    let has_model = |kind: ModelKind, slug: &str| {
      let list = match kind {
        ModelKind::Collections => input.path(&["models", "collections"]),
        ModelKind::Versions => input.path(&["models", "versions"]),
        ModelKind::Globals => return true,
      };
      list.items().any(|s| s.as_str() == Some(slug))
    };
    for case in rec["entityCases"].as_array().expect("cases") {
      checked += 1;
      let slug = case["slug"].as_str().expect("slug");
      let versions = case["versions"].as_bool().unwrap_or(false);
      let model_name = |kind: ModelKind| JsVal::str(if kind == ModelKind::Versions { "versions" } else if kind == ModelKind::Globals { "globals" } else { "collections" });
      let actual = if case["kind"] == "collection" {
        outcome(get_collection(input.get("collections"), slug, versions, has_model).map(|e| {
          JsVal::obj(
            [
              ("collectionConfig".to_string(), e.collection_config),
              ("customIDType".to_string(), e.custom_id_type),
              ("model".to_string(), model_name(e.model.kind)),
            ]
            .into_iter()
            .collect(),
          )
        }))
      } else {
        outcome(get_global(input.get("config"), slug, versions, has_model).map(|(config, model)| {
          JsVal::obj([("globalConfig".to_string(), config), ("model".to_string(), model_name(model.kind))].into_iter().collect())
        }))
      };
      let expected = recorded(&case["result"]);
      if actual != expected {
        failures.push(format!("{} {slug} versions={versions}: {actual} != {expected}", case["kind"]));
      }
    }

    for case in rec["objectIDCases"].as_array().expect("cases") {
      checked += 1;
      let actual = is_object_id(&graph(&case["value"]));
      if Some(actual) != case["result"].as_bool() {
        failures.push(format!("isObjectID {}: {actual}", case["value"]));
      }
    }
  }
  println!("db-mongodb utilities: {} recordings, {checked} cases, {} failed", files.len(), failures.len());
  for failure in &failures {
    println!("  {failure}");
  }
  assert!(checked > 0, "no cases");
  assert!(failures.is_empty(), "{} utility cases differ from upstream", failures.len());
}
