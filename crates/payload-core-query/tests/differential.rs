//! Replays the calls recorded by `test/__rs/core-query/record.sh` (real upstream int runs) through
//! the decoded-value utilities of the port (select / sort / version-key / trash filter) and
//! requires identical results, errors, in-place mutations of the arguments and select-function
//! calls.
//!
//! The query validation functions (`validateQueryPaths`, `validateSortQuery`,
//! `sanitizeJoinQuery`, `getLocalizedPaths`, `getFieldByPath`, `sanitizeWhereQuery`,
//! `combineQueries`) run on live JS values and are verified by the live differential
//! (`test/__rs/core-query/live`); their records are counted but not replayed here.
//!
//! The fixtures are git-ignored: the test fails when they are missing or when a replayed function
//! has no record, unless `RS_CORE_QUERY_ALLOW_MISSING_FIXTURES=1` skips it explicitly.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use payload_core_query::graph::{decode_cfg, decode_data, encode_data};
use payload_core_query::js::{InheritedEnumerables, JsError, get, new_obj, set, set_inherited_enumerables};
use payload_core_query::select::{
  SelectHost, SelectMode, get_query_drafts_select, get_select_mode, resolve_select, sanitize_select,
  strip_unselected_fields,
};
use payload_core_query::sort::{get_query_drafts_sort, sanitize_sort_query};
use payload_core_query::where_query::{
  append_global_version_to_query_key, append_non_trashed_filter, append_version_to_query_key,
};
use payload_engine::js::{JsVal, decode_graph};
use payload_sql_read::Val;
use serde_json::{Value as Json, json};

/// Functions replayed here; every one must have recorded calls.
const REPLAYED: [&str; 10] = [
  "appendGlobalVersionToQueryKey",
  "appendNonTrashedFilter",
  "appendVersionToQueryKey",
  "getQueryDraftsSelect",
  "getQueryDraftsSort",
  "getSelectMode",
  "resolveSelect",
  "sanitizeSelect",
  "sanitizeSortQuery",
  "stripUnselectedFields",
];

/// Functions on live values (verified by `test/__rs/core-query/live`).
const LIVE: [&str; 7] = [
  "combineQueries",
  "getFieldByPath",
  "getLocalizedPaths",
  "sanitizeJoinQuery",
  "sanitizeWhereQuery",
  "validateQueryPaths",
  "validateSortQuery",
];

fn fixtures_dir() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/__rs/core-query/fixtures")
}

// ---------------------------------------------------------------------------------------------
// comparison

fn num(n: &serde_json::Number) -> f64 {
  n.to_string().parse().unwrap_or(f64::NAN)
}

fn diff(expected: &Json, actual: &Json, path: &str) -> Option<String> {
  match (expected, actual) {
    (Json::Number(a), Json::Number(b)) => (num(a) != num(b)).then(|| format!("{path}: {a} != {b}")),
    (Json::Array(a), Json::Array(b)) => {
      if a.len() != b.len() {
        return Some(format!("{path}: len {} != {}", a.len(), b.len()));
      }
      a.iter().zip(b).enumerate().find_map(|(i, (x, y))| diff(x, y, &format!("{path}[{i}]")))
    }
    (Json::Object(a), Json::Object(b)) => {
      let ka: Vec<_> = a.keys().collect();
      let kb: Vec<_> = b.keys().collect();
      if ka != kb {
        return Some(format!("{path}: keys {ka:?} != {kb:?}"));
      }
      a.iter().find_map(|(k, v)| diff(v, &b[k], &format!("{path}.{k}")))
    }
    (a, b) => (a != b).then(|| format!("{path}: {a} != {b}")),
  }
}

// ---------------------------------------------------------------------------------------------
// replay host (entity `select` functions)

struct ReplayHost {
  recorded: Vec<Json>,
  cursor: Cell<usize>,
  actual: RefCell<Vec<Json>>,
}

impl ReplayHost {
  fn new(recorded: Vec<Json>) -> Self {
    Self { recorded, cursor: Cell::new(0), actual: RefCell::new(Vec::new()) }
  }

  fn outcome(rec: &Json) -> Result<Val, JsError> {
    if let Some(ok) = rec.get("ok") {
      return Ok(decode_data(ok));
    }
    let err = rec.get("err").cloned().unwrap_or(Json::Null);
    let thrown = new_obj([
      ("name".to_string(), Val::str(err.get("name").and_then(|v| v.as_str()).unwrap_or("Error"))),
      ("message".to_string(), Val::str(err.get("message").and_then(|v| v.as_str()).unwrap_or(""))),
    ]);
    Err(JsError::Thrown(thrown))
  }
}

impl SelectHost for ReplayHost {
  fn call_select(&self, _function: &JsVal, operation: &str, select: &Val) -> Result<Val, JsError> {
    let idx = self.cursor.get();
    self.cursor.set(idx + 1);
    self.actual.borrow_mut().push(json!({ "kind": "select", "operation": operation }));
    match self.recorded.get(idx) {
      // the function returned the `select` it was given
      Some(rec) if rec.get("same").and_then(|v| v.as_bool()) == Some(true) => Ok(select.clone()),
      Some(rec) => Self::outcome(rec),
      None => Ok(Val::Undefined),
    }
  }
}

fn normalize_host(calls: &[Json]) -> Vec<Json> {
  calls.iter().map(|c| json!({ "kind": c.get("kind"), "operation": c.get("operation") })).collect()
}

// ---------------------------------------------------------------------------------------------
// replay

struct Suite {
  configs: HashMap<u64, JsVal>,
}

fn scalar<'a>(rec: &'a Json, key: &str) -> &'a Json {
  rec.get("scalars").and_then(|s| s.get(key)).unwrap_or(&Json::Null)
}

fn scalar_truthy(rec: &Json, key: &str) -> bool {
  match scalar(rec, key) {
    Json::Null => false,
    Json::Bool(b) => *b,
    Json::Number(n) => num(n) != 0.0,
    Json::String(s) => !s.is_empty(),
    _ => true,
  }
}

fn error_json(e: &JsError) -> Json {
  json!({ "name": e.name(), "message": e.message() })
}

/// Replays one record; returns a description of the first mismatch.
fn replay(suite: &Suite, rec: &Json) -> Result<(), String> {
  let fn_name = rec["fn"].as_str().unwrap_or("");
  let config = rec.get("config").and_then(|c| c.as_u64()).and_then(|id| suite.configs.get(&id));
  let empty_root = JsVal::obj(Default::default());
  let root = config.unwrap_or(&empty_root);
  let cfg = |key: &str| rec.get("cfg").and_then(|c| c.get(key)).map(|v| decode_cfg(v, root)).unwrap_or_default();
  let data = decode_data(&rec["before"]);
  let arg = |key: &str| get(&data, key).unwrap_or_default();
  let recorded_host: Vec<Json> = rec.get("host").and_then(|h| h.as_array()).cloned().unwrap_or_default();
  let host = ReplayHost::new(recorded_host.clone());

  let outcome: Result<Val, JsError> = match fn_name {
    "sanitizeSortQuery" => sanitize_sort_query(&cfg("fields"), &arg("sort")),
    "sanitizeSelect" => sanitize_select(&cfg("fields"), &arg("select"), scalar_truthy(rec, "versions")),
    "resolveSelect" => {
      let op = scalar(rec, "operation").as_str().unwrap_or("").to_string();
      resolve_select(&host, &cfg("config"), &op, &arg("select"))
    }
    "getSelectMode" => Ok(Val::str(get_select_mode(&arg("select")).as_str())),
    "stripUnselectedFields" => {
      let mode = match scalar(rec, "selectMode").as_str() {
        Some("include") => Some(SelectMode::Include),
        Some("exclude") => Some(SelectMode::Exclude),
        _ => None,
      };
      strip_unselected_fields(&cfg("field"), &arg("select"), mode, &arg("siblingDoc")).map(Val::Bool)
    }
    "appendNonTrashedFilter" => {
      let path = scalar(rec, "deletedAtPath").as_str().map(str::to_string);
      append_non_trashed_filter(path.as_deref(), &arg("enableTrash"), &arg("trash"), &arg("where"))
    }
    "appendVersionToQueryKey" => append_version_to_query_key(&arg("query")),
    "appendGlobalVersionToQueryKey" => append_global_version_to_query_key(&arg("query")),
    "getQueryDraftsSort" => get_query_drafts_sort(&cfg("collectionConfig"), &arg("sort")),
    "getQueryDraftsSelect" => Ok(get_query_drafts_select(&arg("select"))),
    other => return Err(format!("unknown fn {other}")),
  };

  let expected_err = rec.get("error").filter(|e| !e.is_null());
  match (&outcome, expected_err) {
    (Err(e), Some(exp)) => {
      let got = error_json(e);
      if got["name"] != exp["name"] || got["message"] != exp["message"] {
        return Err(format!("error {got} != {}", json!({"name": exp["name"], "message": exp["message"]})));
      }
      return Ok(());
    }
    (Err(e), None) => return Err(format!("unexpected error {}", error_json(e))),
    (Ok(_), Some(exp)) => return Err(format!("expected error {exp}")),
    (Ok(_), None) => {}
  }

  let result = outcome.unwrap_or_default();
  let after = data.clone();
  set(&after, "result", result).map_err(|e| e.message())?;
  if let Some(d) = diff(&rec["after"], &encode_data(&after), "$after") {
    return Err(d);
  }
  let expected_host = normalize_host(&recorded_host);
  let actual_host = normalize_host(&host.actual.borrow());
  if let Some(d) = diff(&Json::Array(expected_host), &Json::Array(actual_host), "$host") {
    return Err(d);
  }
  Ok(())
}

fn allow_missing() -> bool {
  std::env::var("RS_CORE_QUERY_ALLOW_MISSING_FIXTURES").is_ok_and(|v| v == "1")
}

#[test]
fn replays_recorded_calls() {
  let dir = fixtures_dir();
  let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
    .map(|entries| {
      entries.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|e| e == "jsonl")).collect()
    })
    .unwrap_or_default();
  if files.is_empty() {
    if allow_missing() {
      eprintln!("RS_CORE_QUERY_ALLOW_MISSING_FIXTURES=1: no fixtures in {}, skipped", dir.display());
      return;
    }
    panic!(
      "no fixtures in {} (record them with test/__rs/core-query/record.sh, or set RS_CORE_QUERY_ALLOW_MISSING_FIXTURES=1 to skip)",
      dir.display()
    );
  }
  files.sort();
  let only = std::env::var("CORE_QUERY_FN").ok();

  let mut failures: Vec<String> = Vec::new();
  let mut per_fn: BTreeMap<String, (usize, usize)> = BTreeMap::new();
  let mut live = 0usize;

  for file in files {
    let text = std::fs::read_to_string(&file).expect("read fixture");
    let mut suite = Suite { configs: HashMap::new() };
    let name = file.file_stem().unwrap().to_string_lossy().to_string();
    for (line_no, line) in text.lines().enumerate() {
      if line.is_empty() {
        continue;
      }
      let rec: Json = serde_json::from_str(line).expect("json line");
      if rec["type"] == "config" {
        let list = |k: &str| -> Vec<String> {
          rec["realm"][k].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default()
        };
        set_inherited_enumerables(InheritedEnumerables { object: list("object"), array: list("array"), string: list("string") });
        let root = decode_graph(&rec["graph"]).expect("config graph");
        suite.configs.insert(rec["id"].as_u64().unwrap_or(0), root);
        continue;
      }
      let fn_name = rec["fn"].as_str().unwrap_or("").to_string();
      if LIVE.contains(&fn_name.as_str()) {
        live += 1;
        continue;
      }
      if only.as_deref().is_some_and(|o| o != fn_name) {
        continue;
      }
      let stat = per_fn.entry(fn_name.clone()).or_default();
      stat.0 += 1;
      if let Err(e) = replay(&suite, &rec) {
        stat.1 += 1;
        if failures.len() < 40 {
          failures.push(format!("{name}:{} {fn_name}: {e}", line_no + 1));
        }
      }
    }
  }

  for (fn_name, (n, failed)) in &per_fn {
    eprintln!("{fn_name:32} {n:6} calls  {failed} mismatches");
  }
  let total: usize = per_fn.values().map(|v| v.0).sum();
  eprintln!(
    "total {total} calls, {} mismatching; {live} records of live-verified functions not replayed",
    per_fn.values().map(|v| v.1).sum::<usize>()
  );
  let expected: Vec<&str> = match only.as_deref() {
    Some(o) => vec![o],
    None => REPLAYED.to_vec(),
  };
  let missing: Vec<&str> = expected.iter().copied().filter(|f| per_fn.get(*f).is_none_or(|s| s.0 == 0)).collect();
  assert!(missing.is_empty(), "no recorded calls replayed for {missing:?} (fixtures incomplete?)");
  assert!(failures.is_empty(), "mismatches:\n{}", failures.join("\n"));
}
