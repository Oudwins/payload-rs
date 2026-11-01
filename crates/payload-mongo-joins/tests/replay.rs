//! Differential replay of the TS calls recorded by test/__rs/mongo-joins/record.mjs.
//!
//! Every recorded unit (one call of a ported function during an upstream int run on MongoDB with
//! the TS engine) is run in Rust against an env that serves each leaf call (buildQuery,
//! buildSortParam, transform, mongoose model calls, ...) from the recording, after checking that
//! Rust makes that call with exactly the recorded arguments (typed values compared by type and
//! value). The unit's result (or error) must equal the recorded one exactly, and every recorded
//! leaf call must have been made.
//!
//! Fixtures: `PAYLOAD_RS_JOINS_FIXTURES` (default test/__rs/mongo-joins/fixtures, git-ignored);
//! the test fails when there are none. `PAYLOAD_RS_JOINS_VERBOSE=1` prints every failure.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use payload_engine::error::{EngineError, Result};
use payload_engine::js::{JsVal, decode_graph_bson, decode_value_bson};
use payload_mongo_joins::util::{is_str, js_key_order, obj, s};
use payload_mongo_joins::{
  AggregatePaginateArgs, BuildQueryArgs, FindDistinctArgs, JoinAggregationArgs, JoinsEnv, ModelOp, ModelRef,
  PaginateArgs, QueryDraftsArgs, ResolveJoinsArgs, SortParam, SortParamArgs, aggregate_paginate,
  build_join_aggregation, find_distinct, query_drafts, resolve_joins,
};
use serde_json::Value as Json;

fn block_on<F: Future>(future: F) -> F::Output {
  let mut cx = Context::from_waker(Waker::noop());
  let mut future = pin!(future);
  for _ in 0..1_000_000 {
    if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
      return value;
    }
  }
  panic!("replay future did not complete");
}

/// Deep equality with JS value semantics: typed values by type and value, host objects by id,
/// numbers like `Object.is`, object keys in order.
fn same(a: &JsVal, b: &JsVal, path: &str) -> std::result::Result<(), String> {
  let diff = || Err(format!("at {path}: {a:?} != {b:?}"));
  if a.typed().is_some() || b.typed().is_some() {
    return if a.typed() == b.typed() { Ok(()) } else { diff() };
  }
  if a.bson().is_some() || b.bson().is_some() {
    return if a.bson() == b.bson() { Ok(()) } else { diff() };
  }
  if a.as_host_object().is_some() || b.as_host_object().is_some() {
    return if a.as_host_object() == b.as_host_object() { Ok(()) } else { diff() };
  }
  match (a, b) {
    (JsVal::Undefined, JsVal::Undefined) | (JsVal::Null, JsVal::Null) => Ok(()),
    (JsVal::Bool(x), JsVal::Bool(y)) if x == y => Ok(()),
    (JsVal::Num(x), JsVal::Num(y)) if (x.is_nan() && y.is_nan()) || (x == y && x.is_sign_negative() == y.is_sign_negative()) => Ok(()),
    (JsVal::Str(x), JsVal::Str(y)) if x == y => Ok(()),
    (JsVal::Arr(x), JsVal::Arr(y)) => {
      if x.len() != y.len() {
        return Err(format!("at {path}: array length {} != {}", x.len(), y.len()));
      }
      for (i, (p, q)) in x.iter().zip(y.iter()).enumerate() {
        same(p, q, &format!("{path}[{i}]"))?;
      }
      Ok(())
    }
    (JsVal::Obj(x), JsVal::Obj(y)) => {
      let (kx, ky): (Vec<&String>, Vec<&String>) = (x.keys().collect(), y.keys().collect());
      if kx != ky {
        return Err(format!("at {path}: keys {kx:?} != {ky:?}"));
      }
      for (k, v) in x.iter() {
        same(v, y.get(k).unwrap_or(&JsVal::Undefined), &format!("{path}.{k}"))?;
      }
      Ok(())
    }
    _ => diff(),
  }
}

fn same_js(rust: &JsVal, recorded: &JsVal, what: &str) -> std::result::Result<(), String> {
  same(&js_key_order(rust), &js_key_order(recorded), what)
}

fn field_names(fields: &JsVal) -> JsVal {
  JsVal::arr(fields.items().map(|f| if f.get("name").is_undefined() { JsVal::Null } else { f.get("name").clone() }).collect())
}

struct Event {
  kind: String,
  method: Option<String>,
  model: JsVal,
  args: JsVal,
  chain: JsVal,
  result: JsVal,
  error: Option<EngineError>,
}

#[derive(Clone, Copy, PartialEq)]
enum Order {
  /// the k-th leaf call of Rust must be the k-th recorded one (by call / exec time)
  Strict,
  /// the first unused recorded call with the same arguments (concurrent branches)
  Relaxed,
}

struct ReplayEnv<'a> {
  config: &'a JsVal,
  info: &'a JsVal,
  events: Vec<Event>,
  used: RefCell<Vec<bool>>,
  next: RefCell<usize>,
  order: Order,
  mismatch: RefCell<Option<String>>,
}

impl ReplayEnv<'_> {
  /// Serves the next leaf call: `expect` gets the recorded arguments and returns a mismatch.
  fn leaf(&self, kind: &str, method: Option<&str>, check: impl Fn(&Event) -> std::result::Result<(), String>) -> Result<JsVal> {
    let fail = |message: String| -> Result<JsVal> {
      self.mismatch.borrow_mut().get_or_insert(message.clone());
      Err(EngineError::internal(format!("replay mismatch: {message}")))
    };
    if self.mismatch.borrow().is_some() {
      return fail("after an earlier mismatch".into());
    }
    let mut used = self.used.borrow_mut();
    let index = match self.order {
      Order::Strict => {
        let mut next = self.next.borrow_mut();
        let i = *next;
        *next += 1;
        let Some(event) = self.events.get(i) else {
          return fail(format!("extra leaf call {kind} {method:?} (recorded {} calls)", self.events.len()));
        };
        if event.kind != kind || event.method.as_deref() != method {
          return fail(format!("leaf #{i}: rust calls {kind} {method:?}, recorded {} {:?}", event.kind, event.method));
        }
        if let Err(e) = check(event) {
          return fail(format!("leaf #{i} {kind} {method:?}: {e}"));
        }
        i
      }
      Order::Relaxed => {
        let mut last_error = None;
        let found = (0..self.events.len()).find(|&i| {
          let event = &self.events[i];
          if used[i] || event.kind != kind || event.method.as_deref() != method {
            return false;
          }
          match check(event) {
            Ok(()) => true,
            Err(e) => {
              last_error = Some(e);
              false
            }
          }
        });
        match found {
          Some(i) => i,
          None => {
            return fail(format!("no recorded {kind} {method:?} call matches ({})", last_error.unwrap_or_default()));
          }
        }
      }
    };
    used[index] = true;
    let event = &self.events[index];
    match &event.error {
      Some(error) => Err(error.clone()),
      None => Ok(event.result.clone()),
    }
  }

  fn unused_events(&self) -> Vec<String> {
    let used = self.used.borrow();
    self
      .events
      .iter()
      .zip(used.iter())
      .filter(|(_, u)| !**u)
      .map(|(e, _)| format!("{} {:?}", e.kind, e.method))
      .collect()
  }
}

fn check_value(rust: &JsVal, recorded: &JsVal, what: &str) -> std::result::Result<(), String> {
  same_js(rust, recorded, what)
}

impl JoinsEnv for ReplayEnv<'_> {
  fn config(&self) -> &JsVal {
    self.config
  }

  fn collection_config(&self, slug: &str) -> Option<JsVal> {
    self.config.get("collections").items().find(|c| is_str(c.get("slug"), slug)).cloned()
  }

  fn has_model(&self, model: &ModelRef) -> bool {
    match model {
      ModelRef::Collection(slug) => !self.info.path(&["collectionNames", "collections", slug]).is_nullish(),
      ModelRef::Versions(slug) => !self.info.path(&["collectionNames", "versions", slug]).is_nullish(),
      ModelRef::Globals => true,
    }
  }

  fn use_join_aggregations(&self) -> bool {
    self.info.path(&["adapter", "useJoinAggregations"]).truthy()
  }

  fn disable_index_hints(&self) -> JsVal {
    self.info.path(&["adapter", "disableIndexHints"]).clone()
  }

  fn collation(&self) -> JsVal {
    self.info.path(&["adapter", "collation"]).clone()
  }

  fn call_function(&self, _function: &JsVal, arg: JsVal) -> Result<JsVal> {
    self.leaf("getForeignPath", None, |e| check_value(&arg, &e.args, "arg"))
  }

  async fn collection_name(&self, model: &ModelRef) -> Result<JsVal> {
    let name = match model {
      ModelRef::Collection(slug) => self.info.path(&["collectionNames", "collections", slug]),
      ModelRef::Versions(slug) => self.info.path(&["collectionNames", "versions", slug]),
      ModelRef::Globals => &JsVal::Undefined,
    };
    Ok(name.clone())
  }

  async fn build_query(&self, args: BuildQueryArgs<'_>) -> Result<JsVal> {
    let expected = obj([
      ("collectionSlug", args.collection_slug.map(s).unwrap_or_default()),
      ("fields", field_names(args.fields)),
      ("globalSlug", JsVal::Undefined),
      ("locale", args.locale.clone()),
      ("where", args.where_.clone()),
    ]);
    self.leaf("buildQuery", None, |e| check_value(&expected, &e.args, "args"))
  }

  async fn model_build_query(&self, model: &ModelRef, locale: &JsVal, where_: &JsVal) -> Result<JsVal> {
    let expected = obj([("locale", locale.clone()), ("model", model.to_js()), ("where", where_.clone())]);
    self.leaf("modelBuildQuery", None, |e| check_value(&expected, &e.args, "args"))
  }

  fn build_sort_param(&self, args: SortParamArgs<'_>) -> Result<SortParam> {
    let expected = obj([
      ("fields", field_names(args.fields)),
      ("hasSortAggregation", JsVal::Bool(args.with_sort_aggregation)),
      ("locale", args.locale.clone()),
      ("parentIsLocalized", JsVal::Undefined),
      ("sort", args.sort.clone()),
      ("timestamps", args.timestamps.clone()),
      ("versions", args.versions.clone()),
    ]);
    let result = self.leaf("buildSortParam", None, |e| check_value(&expected, &e.args, "args"))?;
    Ok(SortParam { sort: result.get("sort").clone(), sort_aggregation: result.get("sortAggregation").items().cloned().collect() })
  }

  fn build_projection_from_select(&self, fields: &JsVal, select: &JsVal) -> Result<JsVal> {
    let expected = obj([("fields", field_names(fields)), ("select", select.clone())]);
    self.leaf("buildProjectionFromSelect", None, |e| check_value(&expected, &e.args, "args"))
  }

  fn transform_read(&self, data: JsVal, fields: &JsVal) -> Result<JsVal> {
    let expected = obj([
      ("data", data),
      ("fields", field_names(fields)),
      ("globalSlug", JsVal::Undefined),
      ("operation", s("read")),
      ("parentIsLocalized", JsVal::Undefined),
    ]);
    let result = self.leaf("transform", None, |e| check_value(&expected, &e.args, "args"))?;
    Ok(result.get("data").clone())
  }

  async fn get_session(&self) -> Result<JsVal> {
    self.leaf("getSession", None, |_| Ok(()))
  }

  async fn paginate(&self, args: PaginateArgs) -> Result<JsVal> {
    let expected = JsVal::arr(vec![
      args.query.clone(),
      args.options.clone(),
      obj([("hasCustomCountFn", JsVal::Bool(args.custom_count.is_some()))]),
    ]);
    self.leaf("model", Some("paginate"), |e| {
      check_value(&args.model.to_js(), &e.model, "model")?;
      check_value(&expected, &e.args, "args")
    })
  }

  fn model_op(&self, op: ModelOp) -> impl Future<Output = Result<JsVal>> {
    let chain = JsVal::arr(op.chain.iter().map(|(m, a)| JsVal::arr(vec![s(*m), JsVal::arr(a.clone())])).collect());
    let result = self.leaf("model", Some(op.method), |e| {
      check_value(&op.model.to_js(), &e.model, "model")?;
      check_value(&JsVal::arr(op.args.clone()), &e.args, "args")?;
      check_value(&chain, &e.chain, "chain")
    });
    std::future::ready(result)
  }
}

fn decode(json: &Json) -> JsVal {
  decode_value_bson(json).unwrap_or_else(|e| panic!("decode: {e}"))
}

fn error_of(json: &Json) -> EngineError {
  EngineError::new(
    json.get("name").and_then(Json::as_str).unwrap_or("Error"),
    json.get("message").and_then(Json::as_str).unwrap_or(""),
  )
}

fn events_of(unit: &Json) -> Vec<Event> {
  let mut events: Vec<(f64, Event)> = unit["events"]
    .as_array()
    .map(|a| a.as_slice())
    .unwrap_or(&[])
    .iter()
    .map(|e| {
      let time = e.get("time").and_then(Json::as_f64).unwrap_or(f64::INFINITY);
      (
        time,
        Event {
          kind: e["kind"].as_str().unwrap_or("").to_string(),
          method: e.get("method").and_then(Json::as_str).map(str::to_string),
          model: e.get("model").map(decode).unwrap_or_default(),
          args: e.get("args").map(decode).unwrap_or_default(),
          chain: e.get("chain").map(decode).unwrap_or_default(),
          result: e.get("result").map(decode).unwrap_or_default(),
          error: e.get("error").map(error_of),
        },
      )
    })
    .collect();
  events.sort_by(|a, b| a.0.total_cmp(&b.0));
  events.into_iter().map(|(_, e)| e).collect()
}

fn model_ref(value: &JsVal) -> ModelRef {
  let slug = value.get("slug").to_js_string();
  match value.get("kind").as_str() {
    Some("versions") => ModelRef::Versions(slug.into()),
    Some("globals") => ModelRef::Globals,
    _ => ModelRef::Collection(slug.into()),
  }
}

/// Runs one unit in Rust: the result (or error).
fn run_unit(env: &ReplayEnv<'_>, kind: &str, args: &JsVal) -> std::result::Result<Result<JsVal>, String> {
  let a = |k: &str| args.get(k).clone();
  Ok(match kind {
    "buildJoinAggregation" => {
      let collection = a("collection").to_js_string();
      let Some(collection_config) = env.collection_config(&collection) else {
        return Err(format!("no collection config for {collection}"));
      };
      block_on(build_join_aggregation(
        env,
        &JoinAggregationArgs {
          collection: &collection,
          collection_config: &collection_config,
          drafts_enabled: &a("draftsEnabled"),
          joins: &a("joins"),
          locale: &a("locale"),
          projection: &a("projection"),
          versions: &a("versions"),
        },
      ))
      .map(JsVal::arr)
    }
    "aggregatePaginate" => {
      let join_aggregation: Option<Vec<JsVal>> = a("joinAggregation").as_arr().map(<[JsVal]>::to_vec);
      let sort_aggregation: Option<Vec<JsVal>> = a("sortAggregation").as_arr().map(<[JsVal]>::to_vec);
      block_on(aggregate_paginate(
        env,
        &AggregatePaginateArgs {
          collation: &a("collation"),
          join_aggregation: join_aggregation.as_deref(),
          limit: &a("limit"),
          model: &model_ref(&a("model")),
          page: &a("page"),
          pagination: &a("pagination"),
          projection: &a("projection"),
          query: &a("query"),
          session: &a("session"),
          sort: &a("sort"),
          sort_aggregation: sort_aggregation.as_deref(),
          use_estimated_count: &a("useEstimatedCount"),
        },
      ))
    }
    "resolveJoins" => {
      let mut docs: Vec<JsVal> = a("docs").items().cloned().collect();
      let collection = a("collectionSlug").to_js_string();
      block_on(resolve_joins(
        env,
        &mut docs,
        &ResolveJoinsArgs {
          collection_slug: &collection,
          joins: &a("joins"),
          locale: &a("locale"),
          projection: &a("projection"),
          versions: a("versions").truthy(),
        },
      ))
      .map(|()| JsVal::arr(docs))
    }
    "findDistinct" => {
      let collection = a("collection").to_js_string();
      let field = a("field").to_js_string();
      block_on(find_distinct(
        env,
        &FindDistinctArgs {
          collection: &collection,
          field: &field,
          limit: &a("limit"),
          locale: &a("locale"),
          page: &a("page"),
          related_access: &a("relatedAccess"),
          sort: &a("sort"),
          where_: &a("where"),
        },
      ))
    }
    "queryDrafts" => {
      let collection = a("collection").to_js_string();
      block_on(query_drafts(
        env,
        &QueryDraftsArgs {
          collection: &collection,
          joins: &a("joins"),
          limit: &a("limit"),
          locale: &a("locale"),
          page: &a("page"),
          pagination: &a("pagination"),
          select: &a("select"),
          sort: &a("sort"),
          where_: &a("where"),
        },
      ))
    }
    other => return Err(format!("unknown unit kind {other}")),
  })
}

#[derive(Default)]
struct Tally {
  units: usize,
  passed: usize,
  relaxed: usize,
  errors_matched: usize,
  failures: Vec<String>,
}

fn replay_unit(config: &JsVal, info: &JsVal, unit: &Json, order: Order) -> std::result::Result<(), String> {
  let kind = unit["kind"].as_str().unwrap_or("");
  let args = decode(&unit["args"]);
  // adapter flags recorded at call time take precedence over the ones of the adapter's config file
  let unit_info;
  let info = match unit.get("adapter") {
    Some(adapter) => {
      let mut props = info.as_obj().cloned().unwrap_or_default();
      props.insert("adapter".into(), decode(adapter));
      unit_info = JsVal::obj(props);
      &unit_info
    }
    None => info,
  };
  let env = ReplayEnv {
    config,
    info,
    events: events_of(unit),
    used: RefCell::new(Vec::new()),
    next: RefCell::new(0),
    order,
    mismatch: RefCell::new(None),
  };
  *env.used.borrow_mut() = vec![false; env.events.len()];
  let outcome = run_unit(&env, kind, &args)?;
  if let Some(mismatch) = env.mismatch.borrow().clone() {
    return Err(format!("leaf calls differ: {mismatch}"));
  }
  match (outcome, unit.get("error")) {
    (Ok(result), None) => same_js(&result, &decode(&unit["result"]), "result")?,
    (Err(error), Some(expected)) => {
      let expected = error_of(expected);
      if error.name != expected.name || error.message != expected.message {
        return Err(format!("error {}: {} != recorded {}: {}", error.name, error.message, expected.name, expected.message));
      }
    }
    (Ok(_), Some(expected)) => return Err(format!("rust succeeded, TS threw {expected}")),
    (Err(error), None) => return Err(format!("rust threw {error}, TS succeeded")),
  }
  let unused = env.unused_events();
  if !unused.is_empty() {
    return Err(format!("recorded leaf calls rust did not make: {unused:?}"));
  }
  Ok(())
}

fn fixture_dirs() -> Vec<PathBuf> {
  let root = std::env::var("PAYLOAD_RS_JOINS_FIXTURES")
    .map(PathBuf::from)
    .unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/__rs/mongo-joins/fixtures"));
  let mut dirs: Vec<PathBuf> = std::fs::read_dir(&root)
    .map(|entries| entries.flatten().map(|e| e.path()).filter(|p| p.join("units.ndjson").exists()).collect())
    .unwrap_or_default();
  dirs.sort();
  dirs
}

#[test]
fn replay_recorded_units() {
  let verbose = std::env::var("PAYLOAD_RS_JOINS_VERBOSE").as_deref() == Ok("1");
  let dirs = fixture_dirs();
  assert!(!dirs.is_empty(), "no fixtures: run test/__rs/mongo-joins/record.mjs first");

  let mut tallies: BTreeMap<String, Tally> = BTreeMap::new();
  for dir in &dirs {
    let mut configs: BTreeMap<u64, (JsVal, JsVal)> = BTreeMap::new();
    let units = std::fs::read_to_string(dir.join("units.ndjson")).expect("units.ndjson");
    for (line_no, line) in units.lines().enumerate() {
      let unit: Json = serde_json::from_str(line).expect("unit json");
      let config_index = unit.get("config").and_then(Json::as_u64).unwrap_or(0);
      let (config, info) = configs.entry(config_index).or_insert_with(|| {
        let text = std::fs::read_to_string(dir.join(format!("config-{config_index}.json"))).expect("config json");
        let json: Json = serde_json::from_str(&text).expect("config json");
        (decode_graph_bson(&json["graph"]).expect("config graph"), decode(&json["info"]))
      });
      let kind = unit["kind"].as_str().unwrap_or("").to_string();
      let tally = tallies.entry(kind.clone()).or_default();
      tally.units += 1;
      let strict = replay_unit(config, info, &unit, Order::Strict);
      let outcome = match strict {
        Ok(()) => Ok(false),
        Err(strict_error) if matches!(kind.as_str(), "resolveJoins" | "queryDrafts") => {
          let relaxed = replay_unit(config, info, &unit, Order::Relaxed);
          if relaxed.is_ok() && std::env::var("PAYLOAD_RS_JOINS_STRICT_REASONS").as_deref() == Ok("1") {
            eprintln!("relaxed {kind}: {}", truncate(&strict_error, 400));
          }
          relaxed.map(|()| true).map_err(|e| format!("{strict_error} / relaxed: {e}"))
        }
        Err(e) => Err(e),
      };
      match outcome {
        Ok(relaxed) => {
          tally.passed += 1;
          tally.relaxed += usize::from(relaxed);
          tally.errors_matched += usize::from(unit.get("error").is_some());
        }
        Err(e) => {
          let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
          let message = format!("{name}:{} {kind}: {e}", line_no + 1);
          if verbose {
            eprintln!("{message}");
          }
          tally.failures.push(message);
        }
      }
    }
  }

  let mut total = 0;
  let mut failed = 0;
  for (kind, tally) in &tallies {
    eprintln!(
      "{kind}: {} units, {} passed ({} with concurrent leaf order relaxed, {} recorded errors reproduced), {} failed",
      tally.units,
      tally.passed,
      tally.relaxed,
      tally.errors_matched,
      tally.failures.len()
    );
    for failure in tally.failures.iter().take(5) {
      eprintln!("  {}", truncate(failure, 1500));
    }
    total += tally.units;
    failed += tally.failures.len();
  }
  assert!(total > 0, "fixtures contain no units");
  assert_eq!(failed, 0, "{failed} of {total} units differ");
}

fn truncate(text: &str, max: usize) -> String {
  if text.len() <= max {
    return text.to_string();
  }
  let mut end = max;
  while !text.is_char_boundary(end) {
    end -= 1;
  }
  format!("{}…", &text[..end])
}

/// Changes the first scalar of a JSON value (depth first); a value without scalars is replaced.
fn mutate(json: &mut Json) -> bool {
  match json {
    Json::String(text) => {
      text.push('x');
      true
    }
    Json::Number(n) => {
      *json = Json::from(n.as_f64().unwrap_or(0.0) + 1.0);
      true
    }
    Json::Bool(b) => {
      *b = !*b;
      true
    }
    Json::Null => {
      *json = Json::String("x".into());
      true
    }
    Json::Array(items) => items.iter_mut().any(mutate) || {
      items.push(Json::String("x".into()));
      true
    },
    // a typed value (`$oid`, `$date`, ...) becomes a string
    Json::Object(map) if map.len() == 1 && map.keys().all(|k| k.starts_with('$')) => {
      *json = Json::String("x".into());
      true
    }
    Json::Object(map) => map.values_mut().any(mutate) || {
      map.insert("x".into(), Json::String("x".into()));
      true
    },
  }
}

/// The differential must reject a wrong result, a wrong leaf argument and a missing leaf call:
/// every unit (up to 50 per kind) is replayed with each corruption and must fail.
#[test]
fn replay_rejects_corrupted_recordings() {
  let dirs = fixture_dirs();
  assert!(!dirs.is_empty(), "no fixtures: run test/__rs/mongo-joins/record.mjs first");
  let mut checked: BTreeMap<String, usize> = BTreeMap::new();
  let mut accepted = Vec::new();
  for dir in &dirs {
    let mut configs: BTreeMap<u64, (JsVal, JsVal)> = BTreeMap::new();
    let units = std::fs::read_to_string(dir.join("units.ndjson")).expect("units.ndjson");
    for line in units.lines() {
      let unit: Json = serde_json::from_str(line).expect("unit json");
      let kind = unit["kind"].as_str().unwrap_or("").to_string();
      let count = checked.entry(kind.clone()).or_default();
      if *count >= 50 {
        continue;
      }
      let config_index = unit.get("config").and_then(Json::as_u64).unwrap_or(0);
      let (config, info) = configs.entry(config_index).or_insert_with(|| {
        let text = std::fs::read_to_string(dir.join(format!("config-{config_index}.json"))).expect("config json");
        let json: Json = serde_json::from_str(&text).expect("config json");
        (decode_graph_bson(&json["graph"]).expect("config graph"), decode(&json["info"]))
      });
      let passes = |unit: &Json| {
        replay_unit(config, info, unit, Order::Strict).is_ok() || replay_unit(config, info, unit, Order::Relaxed).is_ok()
      };
      if !passes(&unit) {
        continue;
      }
      *count += 1;

      let mut corrupted = unit.clone();
      if corrupted.get("error").is_some() {
        corrupted["error"]["message"] = Json::String("corrupted".into());
      } else {
        mutate(&mut corrupted["result"]);
      }
      if passes(&corrupted) {
        accepted.push(format!("{kind}: corrupted result accepted"));
      }

      let events = unit["events"].as_array().map(Vec::len).unwrap_or(0);
      if events > 0 {
        // a leaf call Rust makes with arguments it computed (getSession has none)
        if let Some(i) = unit["events"].as_array().and_then(|a| a.iter().position(|e| e["kind"] != "getSession")) {
          let mut corrupted = unit.clone();
          mutate(&mut corrupted["events"][i]["args"]);
          if passes(&corrupted) {
            accepted.push(format!("{kind}: corrupted leaf args of {} accepted", unit["events"][i]["kind"]));
          }
        }
        let mut corrupted = unit.clone();
        corrupted["events"].as_array_mut().map(|a| a.remove(0));
        if passes(&corrupted) {
          accepted.push(format!("{kind}: missing leaf call accepted"));
        }
        let mut corrupted = unit.clone();
        let first = corrupted["events"][0].clone();
        corrupted["events"].as_array_mut().map(|a| a.push(first));
        if passes(&corrupted) {
          accepted.push(format!("{kind}: extra recorded leaf call accepted"));
        }
      }
    }
  }
  eprintln!("corruption checks per kind: {checked:?}");
  assert!(checked.values().sum::<usize>() > 0, "no passing units to corrupt");
  assert!(accepted.is_empty(), "{} corruptions accepted: {:#?}", accepted.len(), &accepted[..accepted.len().min(20)]);
}
