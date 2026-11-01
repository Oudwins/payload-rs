//! Replays the calls recorded by `test/__rs/core-query/record.sh` (real upstream int runs) through
//! the Rust port and requires identical results, errors, in-place mutations of the arguments and
//! host-call sequences. Fixture files that are missing are skipped (they are git-ignored).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;

use payload_core_query::graph::{decode_cfg, decode_data, encode_data};
use payload_core_query::host::{EntityPermissionsCall, ExecuteAccessCall, Host};
use payload_core_query::js::{InheritedEnumerables, JsError, get, new_obj, set, set_inherited_enumerables};
use payload_core_query::paths::{LocalizedPathsArgs, PathToQuery, get_field_by_path, get_localized_paths};
use payload_core_query::rt::{Outcome, Promise, Rt};
use payload_core_query::select::{
  SelectMode, get_query_drafts_select, get_select_mode, resolve_select, sanitize_select, strip_unselected_fields,
};
use payload_core_query::sort::{get_query_drafts_sort, sanitize_sort_query};
use payload_core_query::validate::{
  Ctx, ValidateQueryPathsArgs, ValidateSortQueryArgs, validate_query_paths, validate_sort_query,
};
use payload_core_query::where_query::{
  append_global_version_to_query_key, append_non_trashed_filter, append_version_to_query_key, combine_queries,
  sanitize_where_query,
};
use payload_core_query::{QueryConfig, join::sanitize_join_query};
use payload_engine::js::{JsVal, Obj, decode_graph};
use payload_sql_read::Val;
use serde_json::{Value as Json, json};

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

/// Compares a `$cfg`-encoded expected config value with a Rust config value (config objects by
/// identity, everything else structurally).
fn cfg_diff(expected: &Json, actual: &JsVal, root: &JsVal, path: &str) -> Option<String> {
  if let Json::Object(o) = expected
    && o.len() == 1
  {
    let (k, v) = o.iter().next().unwrap();
    match k.as_str() {
      "$cfg" => {
        let target = payload_core_query::graph::resolve_cfg_path(root, v.as_array().map(|a| a.as_slice()).unwrap_or(&[]));
        return match target {
          Some(t) if t.identity().is_some() && t.identity() == actual.identity() => None,
          Some(t) if t.identity().is_none() && t.strict_eq(actual) => None,
          _ => Some(format!("{path}: expected config object at {v}, got {}", short(actual))),
        };
      }
      "$undefined" => return (!actual.is_undefined()).then(|| format!("{path}: expected undefined, got {}", short(actual))),
      "$fn" => return (!actual.is_fn()).then(|| format!("{path}: expected function")),
      "$num" => {
        let n = match v.as_str() {
          Some("Infinity") => f64::INFINITY,
          Some("-Infinity") => f64::NEG_INFINITY,
          _ => f64::NAN,
        };
        let ok = actual.as_num().is_some_and(|a| a == n || (a.is_nan() && n.is_nan()));
        return (!ok).then(|| format!("{path}: number mismatch"));
      }
      "$obj" => return cfg_diff(v, actual, root, path),
      _ => {}
    }
  }
  match (expected, actual) {
    (Json::Null, JsVal::Null) => None,
    (Json::Bool(a), JsVal::Bool(b)) if a == b => None,
    (Json::Number(a), JsVal::Num(b)) if num(a) == *b => None,
    (Json::String(a), JsVal::Str(b)) if a.as_str() == &**b => None,
    (Json::Array(a), JsVal::Arr(b)) => {
      if a.len() != b.len() {
        return Some(format!("{path}: len {} != {}", a.len(), b.len()));
      }
      a.iter().zip(b.iter()).enumerate().find_map(|(i, (x, y))| cfg_diff(x, y, root, &format!("{path}[{i}]")))
    }
    (Json::Object(a), JsVal::Obj(b)) => {
      let ka: Vec<&String> = a.keys().collect();
      let kb: Vec<&String> = b.keys().collect();
      if ka != kb {
        return Some(format!("{path}: keys {ka:?} != {kb:?}"));
      }
      a.iter().find_map(|(k, v)| cfg_diff(v, b.get(k).unwrap(), root, &format!("{path}.{k}")))
    }
    _ => Some(format!("{path}: {expected} != {}", short(actual))),
  }
}

fn short(v: &JsVal) -> String {
  let s = v.to_json().to_string();
  if s.len() > 200 { format!("{}...", &s[..200]) } else { s }
}

// ---------------------------------------------------------------------------------------------
// replay host

struct ReplayHost {
  recorded: Vec<Json>,
  cursor: Cell<usize>,
  actual: RefCell<Vec<Json>>,
  externals: RefCell<Vec<(u64, Promise, Outcome)>>,
}

impl ReplayHost {
  fn new(recorded: Vec<Json>) -> Self {
    Self { recorded, cursor: Cell::new(0), actual: RefCell::new(Vec::new()), externals: RefCell::new(Vec::new()) }
  }

  fn outcome(rec: &Json) -> Outcome {
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

  /// Settles like the recorded promise: synchronously (depth 0), in the job at microtask level
  /// `depth`, or once the queue drained (external, in recorded order).
  fn schedule(&self, rt: &Rt, actual: Json) -> Promise {
    let idx = self.cursor.get();
    self.cursor.set(idx + 1);
    self.actual.borrow_mut().push(actual);
    let Some(rec) = self.recorded.get(idx) else {
      return rt.pending();
    };
    let outcome = Self::outcome(rec);
    if rec.get("external").and_then(|v| v.as_bool()) == Some(true) {
      let p = rt.pending();
      let seq = rec.get("settleSeq").and_then(|v| v.as_u64()).unwrap_or(u64::MAX);
      self.externals.borrow_mut().push((seq, p.clone(), outcome));
      return p;
    }
    let depth = rec.get("depth").and_then(|v| v.as_u64()).unwrap_or(0);
    if depth == 0 {
      return rt.settled(outcome);
    }
    let p = rt.pending();
    chain(rt.clone(), p.clone(), outcome, depth);
    p
  }
}

fn chain(rt: Rt, p: Promise, outcome: Outcome, remaining: u64) {
  let rt2 = rt.clone();
  rt.queue_job(move || {
    if remaining == 1 {
      rt2.settle(&p, outcome);
    } else {
      chain(rt2, p, outcome, remaining - 1);
    }
  });
}

impl Host for ReplayHost {
  fn get_entity_permissions(&self, rt: &Rt, call: EntityPermissionsCall) -> Promise {
    let actual = json!({
      "kind": "permissions",
      "blockRefs": call.block_references_permissions,
      "entityType": call.entity_type.as_str(),
      "isolated": call.isolated_transaction_id,
      "slug": call.entity.get("slug").to_json(),
    });
    self.schedule(rt, actual)
  }

  fn execute_access(&self, rt: &Rt, call: ExecuteAccessCall) -> Promise {
    let access = match call.access {
      JsVal::Fn(id) => json!({ "$fn": id }),
      _ => json!({ "$undefined": true }),
    };
    self.schedule(rt, json!({ "kind": "access", "access": access, "slug": call.slug }))
  }

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

  fn on_idle(&self, rt: &Rt) -> bool {
    let mut ext = self.externals.borrow_mut();
    let Some(i) = ext.iter().enumerate().min_by_key(|(_, e)| e.0).map(|(i, _)| i) else {
      return false;
    };
    let (_, p, o) = ext.remove(i);
    drop(ext);
    rt.settle(&p, o);
    true
  }
}

/// Normalizes `blockRefs` object ids to their order of first appearance and keeps the compared keys.
fn normalize_host(calls: &[Json]) -> Vec<Json> {
  let mut ids: HashMap<String, usize> = HashMap::new();
  calls
    .iter()
    .map(|c| {
      let kind = c.get("kind").cloned().unwrap_or(Json::Null);
      match kind.as_str() {
        Some("permissions") => {
          let raw = c.get("blockRefs").map(|v| v.to_string()).unwrap_or_default();
          let n = ids.len();
          let id = *ids.entry(raw).or_insert(n);
          json!({ "kind": kind, "blockRefs": id, "entityType": c.get("entityType"), "isolated": c.get("isolated"), "slug": c.get("slug") })
        }
        Some("access") => json!({ "kind": kind, "access": c.get("access"), "slug": c.get("slug") }),
        _ => json!({ "kind": kind, "operation": c.get("operation") }),
      }
    })
    .collect()
}

// ---------------------------------------------------------------------------------------------
// replay

struct Suite {
  configs: HashMap<u64, (JsVal, Rc<QueryConfig>)>,
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

fn scalar_slug(rec: &Json, key: &str) -> JsVal {
  match scalar(rec, key) {
    Json::String(s) => JsVal::str(s.as_str()),
    _ => JsVal::Undefined,
  }
}

fn error_json(e: &JsError) -> Json {
  json!({ "name": e.name(), "message": e.message() })
}

fn paths_to_js(paths: &[PathToQuery]) -> JsVal {
  JsVal::arr(
    paths
      .iter()
      .map(|p| {
        let mut o = Obj::new();
        o.insert("collectionSlug".into(), p.collection_slug.clone());
        o.insert("complete".into(), JsVal::Bool(p.complete));
        o.insert("field".into(), p.field.clone());
        o.insert("fields".into(), p.fields.clone());
        o.insert("globalSlug".into(), p.global_slug.clone());
        o.insert("invalid".into(), JsVal::Bool(p.invalid));
        o.insert("parentIsLocalized".into(), p.parent_is_localized.map(JsVal::Bool).unwrap_or(JsVal::Undefined));
        o.insert("path".into(), JsVal::str(p.path.as_str()));
        JsVal::obj(o)
      })
      .collect(),
  )
}

/// Replays one record; returns a description of the first mismatch.
fn replay(suite: &Suite, rec: &Json) -> Result<(), String> {
  let fn_name = rec["fn"].as_str().unwrap_or("");
  let config = rec.get("config").and_then(|c| c.as_u64()).and_then(|id| suite.configs.get(&id));
  let empty_root = JsVal::obj(Obj::new());
  let root = config.map(|c| &c.0).unwrap_or(&empty_root);
  let cfg = |key: &str| rec.get("cfg").and_then(|c| c.get(key)).map(|v| decode_cfg(v, root)).unwrap_or_default();
  let data = decode_data(&rec["before"]);
  let arg = |key: &str| get(&data, key).unwrap_or_default();
  let payload = || config.map(|c| c.1.clone()).ok_or_else(|| "record without config".to_string());
  let recorded_host: Vec<Json> = rec.get("host").and_then(|h| h.as_array()).cloned().unwrap_or_default();
  let host = Rc::new(ReplayHost::new(recorded_host.clone()));

  let mut cfg_result: Option<JsVal> = None;
  let is_async = matches!(fn_name, "validateQueryPaths" | "validateSortQuery" | "sanitizeJoinQuery");

  let outcome: Result<Val, JsError> = match fn_name {
    "combineQueries" => Ok(combine_queries(&arg("where"), &arg("access"))),
    "sanitizeWhereQuery" => {
      let p = payload()?;
      sanitize_where_query(&p, &cfg("fields"), &arg("where")).map(|_| Val::Undefined)
    }
    "getLocalizedPaths" => {
      let p = payload()?;
      let locale = arg("locale");
      let fields = cfg("fields");
      let path = scalar(rec, "incomingPath").as_str().unwrap_or("").to_string();
      let r = get_localized_paths(
        &p,
        LocalizedPathsArgs {
          collection_slug: scalar_slug(rec, "collectionSlug"),
          fields: &fields,
          global_slug: scalar_slug(rec, "globalSlug"),
          incoming_path: &path,
          locale: &locale,
          override_access: scalar_truthy(rec, "overrideAccess"),
          parent_is_localized: scalar(rec, "parentIsLocalized").as_bool(),
          show_hidden_fields: scalar_truthy(rec, "showHiddenFields"),
        },
      );
      r.map(|paths| {
        cfg_result = Some(paths_to_js(&paths));
        Val::Undefined
      })
    }
    "getFieldByPath" => {
      let config_root = scalar_truthy(rec, "hasConfig").then_some(root);
      let r = get_field_by_path(
        config_root,
        &cfg("fields"),
        scalar_truthy(rec, "includeRelationships"),
        scalar(rec, "localizedPath").as_str().unwrap_or(""),
        scalar(rec, "path").as_str().unwrap_or(""),
      );
      r.map(|found| {
        cfg_result = Some(match found {
          None => JsVal::Null,
          Some(f) => {
            let mut o = Obj::new();
            o.insert("field".into(), f.field);
            o.insert("localizedPath".into(), JsVal::str(f.localized_path));
            o.insert("pathHasLocalized".into(), JsVal::Bool(f.path_has_localized));
            JsVal::obj(o)
          }
        });
        Val::Undefined
      })
    }
    "sanitizeSortQuery" => sanitize_sort_query(&cfg("fields"), &arg("sort")),
    "sanitizeSelect" => sanitize_select(&cfg("fields"), &arg("select"), scalar_truthy(rec, "versions")),
    "resolveSelect" => {
      let op = scalar(rec, "operation").as_str().unwrap_or("").to_string();
      resolve_select(&*host, &cfg("config"), &op, &arg("select"))
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
    _ if is_async => {
      let rt = Rt::new();
      let ctx = Ctx::new(rt.clone(), host.clone(), payload()?, arg("locale"));
      let promise = match fn_name {
        "validateQueryPaths" => {
          let policies = arg("policies");
          let errors = arg("errors");
          let errors = errors.as_arr().map(|a| {
            Rc::new(RefCell::new(
              a.borrow().iter().map(|e| get(e, "path").unwrap_or_default().to_js_string()).collect::<Vec<_>>(),
            ))
          });
          validate_query_paths(
            &ctx,
            ValidateQueryPathsArgs {
              collection_config: cfg("collectionConfig"),
              global_config: cfg("globalConfig"),
              errors,
              override_access: scalar_truthy(rec, "overrideAccess"),
              policies: (!policies.is_undefined()).then_some(policies),
              polymorphic_join: scalar_truthy(rec, "polymorphicJoin"),
              show_hidden_fields: scalar_truthy(rec, "showHiddenFields"),
              version_fields: cfg("versionFields"),
              where_: arg("where"),
            },
          )
        }
        "validateSortQuery" => validate_sort_query(
          &ctx,
          ValidateSortQueryArgs {
            collection_config: cfg("collectionConfig"),
            global_config: cfg("globalConfig"),
            override_access: scalar_truthy(rec, "overrideAccess"),
            sort: arg("sort"),
            version_fields: cfg("versionFields"),
          },
        ),
        _ => sanitize_join_query(&ctx, cfg("collectionConfig"), arg("joins"), scalar_truthy(rec, "overrideAccess")),
      };
      // the recorder snapshots in a reaction attached right after the call
      let snapshot: Rc<RefCell<Option<(Outcome, Json)>>> = Rc::new(RefCell::new(None));
      let (s2, d2) = (snapshot.clone(), data.clone());
      rt.then(&promise, move |o| {
        let after = d2.clone();
        let (err_data, result) = match &o {
          Ok(v) => (Val::Undefined, v.clone()),
          Err(e) => (e.data(), Val::Undefined),
        };
        let _ = set(&after, "errorData", err_data);
        let _ = set(&after, "result", result);
        *s2.borrow_mut() = Some((o, encode_data(&after)));
      });
      let h = host.clone();
      rt.run(|rt| h.on_idle(rt));
      let Some((o, after)) = snapshot.borrow_mut().take() else {
        return Err("async call never settled".into());
      };
      let expected_err = rec.get("error").filter(|e| !e.is_null());
      match (&o, expected_err) {
        (Err(e), Some(exp)) => {
          let got = error_json(e);
          if got["name"] != exp["name"] || got["message"] != exp["message"] {
            return Err(format!("error {got} != {}", json!({"name": exp["name"], "message": exp["message"]})));
          }
        }
        (Err(e), None) => return Err(format!("unexpected error {}", error_json(e))),
        (Ok(_), Some(exp)) => return Err(format!("expected error {exp}")),
        (Ok(_), None) => {}
      }
      if let Some(d) = diff(&rec["after"], &after, "$after") {
        return Err(d);
      }
      let expected_host = normalize_host(&recorded_host);
      let actual_host = normalize_host(&host.actual.borrow());
      if let Some(d) = diff(&Json::Array(expected_host), &Json::Array(actual_host), "$host") {
        return Err(d);
      }
      return Ok(());
    }
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
  if let Some(expected) = rec.get("cfgResult").filter(|v| !v.is_null()) {
    let actual = cfg_result.unwrap_or_default();
    if let Some(d) = cfg_diff(expected, &actual, root, "$cfgResult") {
      return Err(d);
    }
  }
  let expected_host = normalize_host(&recorded_host);
  let actual_host = normalize_host(&host.actual.borrow());
  if let Some(d) = diff(&Json::Array(expected_host), &Json::Array(actual_host), "$host") {
    return Err(d);
  }
  Ok(())
}

#[test]
fn replays_recorded_calls() {
  let dir = fixtures_dir();
  let Ok(entries) = std::fs::read_dir(&dir) else {
    eprintln!("no fixtures in {}", dir.display());
    return;
  };
  let mut files: Vec<PathBuf> =
    entries.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|e| e == "jsonl")).collect();
  files.sort();
  let only = std::env::var("CORE_QUERY_FN").ok();

  let mut total = 0usize;
  let mut failures: Vec<String> = Vec::new();
  let mut per_fn: std::collections::BTreeMap<String, (usize, usize)> = Default::default();

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
        let default_id = JsVal::from_json(&rec["defaultIDType"]);
        let cfg = Rc::new(QueryConfig::new(root.clone(), default_id));
        suite.configs.insert(rec["id"].as_u64().unwrap_or(0), (root, cfg));
        continue;
      }
      let fn_name = rec["fn"].as_str().unwrap_or("").to_string();
      if only.as_deref().is_some_and(|o| o != fn_name) {
        continue;
      }
      total += 1;
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
  eprintln!("total {total} calls, {} mismatching", per_fn.values().map(|v| v.1).sum::<usize>());
  assert!(failures.is_empty(), "mismatches:\n{}", failures.join("\n"));
}
