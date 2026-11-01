//! Differential replay of recorded upstream TS data method calls (test/__rs/mongo-engine/record.mjs
//! → recorder.ts) through the Rust engine with the real component crates ([`Wired`]): every
//! host op the Rust method issues must equal the next recorded mongoose call (model, method,
//! args, chain, post, `useCustomCountFn` call) and gets the recorded result / thrown error; the
//! method result (or error) and the caller's mutated `data` / `versionData` must equal the
//! recording exactly (typed values included).
//!
//!   PAYLOAD_RS_MONGO_ENGINE_FIXTURES=/tmp/rs-mongoengine-fixtures \
//!     cargo test -p payload-mongo-engine --test replay -- --ignored --nocapture
//!
//! `PAYLOAD_RS_MONGO_ENGINE_REPLAY_REPORT_ONLY=true` prints the report without failing on
//! mismatches; `PAYLOAD_RS_MONGO_ENGINE_REPLAY_FILTER=<method>` replays one method.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, VecDeque};

use std::sync::Arc;

use payload_engine::error::{EngineError, HostThrow};
use payload_engine::js::{JsVal, decode_value_bson, encode_value};
use payload_mongo_engine::host::{LocalBoxFuture, MongoHost, MongoResult, Settlable, run_to_completion};
use payload_mongo_engine::wired::Wired;
use payload_mongo_engine::{Call, CallContext, MongoEngine};
use serde_json::{Value as Json, json};

/// The comparable form of a host op request: `{ op, model, method, args, chain, post, fnOptions }`
/// in a fixed key order (`chain` defaults to `[]`).
fn normalize_request(request: &Json) -> Json {
  let mut out = serde_json::Map::new();
  for key in ["op", "model", "method", "args"] {
    // (`fromCallArgs` is an instruction to the host, not part of the TS call)
    if let Some(v) = request.get(key) {
      out.insert(key.into(), v.clone());
    }
  }
  if request.get("op").and_then(Json::as_str) == Some("model") {
    out.insert("chain".into(), request.get("chain").cloned().unwrap_or_else(|| json!([])));
  }
  if let Some(post) = request.get("post") {
    out.insert("post".into(), post.clone());
  }
  if let Some(Json::Array(fn_options)) = request.get("fnOptions") {
    let normalized: Vec<Json> = fn_options
      .iter()
      .map(|o| {
        json!({
          "arg": o.get("arg").cloned().unwrap_or(Json::Null),
          "key": o.get("key").cloned().unwrap_or(Json::Null),
          "call": normalize_request(o.get("call").unwrap_or(&Json::Null)),
        })
      })
      .collect();
    out.insert("fnOptions".into(), Json::Array(normalized));
  }
  Json::Object(out)
}

fn response_of(op: &Json) -> MongoResult<JsVal> {
  if let Some(error) = op.get("error") {
    // `{ handle, isObject, name?, message?, code?, keyValue? }` (older recordings: under `details`)
    let details = decode_value_bson(error.get("details").unwrap_or(error))?;
    let prop = |key: &str| details.has(key).then(|| details.get(key).clone());
    return Err(EngineError::host_throw(
      details.get("name").as_str().unwrap_or("Error"),
      HostThrow {
        handle: error.get("handle").and_then(Json::as_u64).unwrap_or(0) as u32,
        is_object: error.get("isObject").and_then(Json::as_bool).unwrap_or(false),
        message: prop("message"),
        code: prop("code"),
        key_value: prop("keyValue"),
      },
    ));
  }
  decode_value_bson(op.get("result").unwrap_or(&json!({ "$undefined": true })))
}

/// Serves the recorded ops in order and records every mismatch.
struct ReplayHost {
  expected: RefCell<VecDeque<Json>>,
  session: Json,
  mismatches: RefCell<Vec<String>>,
  issued: RefCell<usize>,
}

impl MongoHost for ReplayHost {
  fn op(&self, request: JsVal) -> LocalBoxFuture<'static, MongoResult<JsVal>> {
    let request = encode_value(&request);
    if request.get("op").and_then(Json::as_str) == Some("getSession") {
      return Box::pin(Settlable::settled(decode_value_bson(&self.session)));
    }
    let index = {
      let mut issued = self.issued.borrow_mut();
      *issued += 1;
      *issued
    };
    let Some(expected) = self.expected.borrow_mut().pop_front() else {
      self.mismatches.borrow_mut().push(format!("op #{index}: unexpected extra op {request}"));
      return Box::pin(Settlable::settled(Err(EngineError::internal("replay: unexpected op"))));
    };
    let mut actual = normalize_request(&request);
    let wanted = normalize_request(&expected);
    // the recorder marks `post: 'toObject'` only where documents came back (an empty result has
    // nothing to convert, so both requests are the same call)
    let no_documents = match expected.get("result") {
      None => true,
      Some(Json::Array(items)) => items.is_empty(),
      Some(Json::Null) => true,
      Some(v) => *v == json!({ "$undefined": true }),
    };
    // `useCustomCountFn` is only seen by the recorder when mongoose-paginate-v2 calls it (not with
    // `pagination: false`): the recorded options still hold the key where the TS set the function
    let fn_option_uncalled = wanted.get("fnOptions").is_none()
      && wanted.pointer("/args/1").and_then(Json::as_object).is_some_and(|o| o.contains_key("useCustomCountFn"));
    if fn_option_uncalled {
      if let Some(o) = actual.as_object_mut() {
        o.shift_remove("fnOptions");
      }
    }
    if wanted.get("post").is_none() && no_documents {
      if let Some(o) = actual.as_object_mut() {
        o.shift_remove("post");
      }
    }
    if actual.to_string() != wanted.to_string() {
      self.mismatches.borrow_mut().push(format!("op #{index}:\n  rust: {actual}\n  ts:   {wanted}"));
    }
    Box::pin(Settlable::settled(response_of(&expected)))
  }
}

/// Config functions answered from the recording (`fnCalls`: `{ id, arg, result }`).
struct RecordedFunctions {
  calls: Vec<Json>,
}

impl payload_engine::host::Host for RecordedFunctions {
  fn call(&self, id: u32, arg: &Json) -> payload_engine::error::Result<JsVal> {
    self.call_value(id, &JsVal::from_json(arg))
  }

  fn call_value(&self, id: u32, arg: &JsVal) -> payload_engine::error::Result<JsVal> {
    let arg = encode_value(arg);
    self
      .calls
      .iter()
      .find(|c| c["id"].as_u64() == Some(u64::from(id)) && c["arg"] == arg)
      .map(|c| decode_value_bson(&c["result"]))
      .unwrap_or_else(|| Err(EngineError::internal(format!("replay: no recorded call of function {id} with {arg}"))))
  }
}

struct Outcome {
  mismatches: Vec<String>,
}

/// Older recordings carry a reduced `req` in `args` and a flat context: the final boundary has no
/// `req` in `args` and `{ adapter, hasReq, models, now }`.
fn upgrade_record(record: &Json) -> Json {
  let mut record = record.clone();
  if record["context"].get("adapter").is_some() {
    return record;
  }
  let undefined = json!({ "$undefined": true });
  let req = record["args"].get("req").cloned();
  let has_req = req.is_some_and(|r| r != undefined && !r.is_null());
  if let Some(args) = record["args"].as_object_mut() {
    args.shift_remove("req");
  }
  let mut flat = record["context"].as_object().cloned().unwrap_or_default();
  let models = flat.shift_remove("models").unwrap_or(Json::Null);
  record["context"] = json!({ "adapter": Json::Object(flat), "hasReq": has_req, "models": models });
  record
}

fn replay_call(engine: &MongoEngine<Wired>, record: &Json) -> Outcome {
  let record = &upgrade_record(record);
  let mut mismatches = Vec::new();
  let method = record["method"].as_str().unwrap_or_default().to_string();
  let args = match decode_value_bson(&record["args"]) {
    Ok(args) => args,
    Err(e) => return Outcome { mismatches: vec![format!("args decode: {e}")] },
  };
  let ctx = match CallContext::parse(&record["context"]) {
    Ok(ctx) => ctx,
    Err(e) => return Outcome { mismatches: vec![format!("context: {e}")] },
  };
  let host = ReplayHost {
    expected: RefCell::new(record["ops"].as_array().cloned().unwrap_or_default().into()),
    session: record["session"].clone(),
    mismatches: RefCell::new(Vec::new()),
    issued: RefCell::new(0),
  };
  let functions = RecordedFunctions { calls: record.get("fnCalls").and_then(Json::as_array).cloned().unwrap_or_default() };
  let times = RefCell::new(VecDeque::from(replay_clock(record)));
  let fallback = ctx.now;
  let clock = || times.borrow_mut().pop_front().unwrap_or(fallback);
  let call = Call { graph: engine.graph(), ctx: &ctx, host: &host, functions: &functions, now: &clock };
  let outcome = run_to_completion(Box::pin(engine.run(&call, &method, &args)));
  mismatches.extend(host.mismatches.borrow().iter().cloned());
  let left = host.expected.borrow().len();
  if left > 0 {
    mismatches.push(format!("{left} recorded op(s) not issued, next: {}", normalize_request(&host.expected.borrow()[0])));
  }
  let Some(outcome) = outcome else {
    mismatches.push("call did not finish".into());
    return Outcome { mismatches };
  };
  match (&outcome.result, record.get("result"), record.get("error")) {
    (Ok(result), Some(expected), _) => {
      let actual = encode_value(result);
      if actual.to_string() != expected.to_string() {
        mismatches.push(format!("result:\n  rust: {actual}\n  ts:   {expected}"));
      }
    }
    (Err(error), _, Some(expected)) => {
      let actual = error.to_json();
      let same = if let Some(handle) = expected.get("rethrow") {
        actual.get("rethrow") == Some(handle)
      } else {
        let name_ok = actual.get("name") == expected.get("name");
        let detail_ok = if expected.get("name").and_then(Json::as_str) == Some("ValidationError") {
          normalize_validation(actual.get("data")) == normalize_validation(expected.get("data"))
        } else {
          actual.get("message") == expected.get("message")
        };
        name_ok && detail_ok
      };
      if !same {
        mismatches.push(format!("error:\n  rust: {actual}\n  ts:   {expected}"));
      }
    }
    (Ok(result), None, Some(expected)) => {
      mismatches.push(format!("rust returned {} where ts threw {expected}", encode_value(result)))
    }
    (Err(error), Some(expected), _) => {
      mismatches.push(format!("rust threw {} where ts returned {expected}", error.to_json()))
    }
    _ => mismatches.push("recording has neither result nor error".into()),
  }
  // `upsert` forwards the caller's own `data` to `this.updateOne` (host op `adapterCall` with
  // `fromCallArgs`), whose mutations the replay cannot see
  if let Some(expected) = record.get("dataAfter").filter(|_| method != "upsert") {
    let key = record.get("mutatedKey").and_then(Json::as_str).unwrap_or("data");
    let actual = match &outcome.mutated {
      Some((k, value)) if *k == key => encode_value(value),
      _ => encode_value(args.get(key)),
    };
    if actual.to_string() != expected.to_string() {
      mismatches.push(format!("{key} after the call:\n  rust: {actual}\n  ts:   {expected}"));
    }
  }
  Outcome { mismatches }
}

/// The `Date.now()` values the TS method read, in order, recovered from the recording: `createdAt`
/// (create methods, when the input has none) then `updatedAt` (write transform, when the input's
/// is `undefined`), as they appear in the written document.
fn replay_clock(record: &Json) -> Vec<f64> {
  let method = record["method"].as_str().unwrap_or_default();
  let undefined = json!({ "$undefined": true });
  let args = &record["args"];
  let (input, written) = match method {
    "create" | "createGlobal" => (args.get("data").cloned(), record.get("dataAfter").cloned()),
    "createVersion" | "createGlobalVersion" => (
      Some(json!({ "createdAt": args.get("createdAt").cloned().unwrap_or(undefined.clone()), "updatedAt": args.get("updatedAt").cloned().unwrap_or(undefined.clone()) })),
      record["ops"].get(0).and_then(|op| op["args"].get(0)).and_then(|docs| docs.get(0)).cloned(),
    ),
    "updateVersion" | "updateGlobalVersion" => (args.get("versionData").cloned(), record.get("dataAfter").cloned()),
    "updateOne" | "updateMany" | "updateGlobal" | "updateJobs" => (args.get("data").cloned(), record.get("dataAfter").cloned()),
    _ => (None, None),
  };
  let (Some(input), Some(written)) = (input, written) else { return Vec::new() };
  let time = |key: &str| written.get(key).and_then(Json::as_str).and_then(payload_engine::js::parse_iso_date);
  let mut out = Vec::new();
  let is_create = matches!(method, "create" | "createGlobal" | "createVersion" | "createGlobalVersion");
  let created = input.get("createdAt");
  let created_falsy = match created {
    None | Some(Json::Null) | Some(Json::Bool(false)) => true,
    Some(Json::String(s)) => s.is_empty(),
    Some(v) => *v == undefined || v.as_f64() == Some(0.0),
  };
  if is_create && created_falsy {
    out.extend(time("createdAt"));
  }
  let updated = input.get("updatedAt");
  if updated.is_none() || updated == Some(&undefined) {
    out.extend(time("updatedAt"));
  }
  out
}

/// `ValidationError` data without `undefined` keys (`{ collection, errors: [{ path }], global }`).
fn normalize_validation(data: Option<&Json>) -> Json {
  let Some(Json::Object(o)) = data else { return Json::Null };
  Json::Object(o.iter().filter(|(_, v)| **v != json!({ "$undefined": true })).map(|(k, v)| (k.clone(), v.clone())).collect())
}

fn load_engine(dir: &std::path::Path, index: u64) -> Result<Arc<MongoEngine<Wired>>, String> {
  let text = std::fs::read_to_string(dir.join(format!("config-{index}.json"))).map_err(|e| e.to_string())?;
  let config: Json = serde_json::from_str(&text).map_err(|e| e.to_string())?;
  let options = config["options"].clone();
  MongoEngine::create(&config["graph"], |graph| Wired::new(graph, options)).map(Arc::new).map_err(|e| e.to_string())
}

#[test]
#[ignore = "needs recorded fixtures (test/__rs/mongo-engine/record.mjs)"]
fn replays_recorded_upstream_calls() {
  let root = std::env::var("PAYLOAD_RS_MONGO_ENGINE_FIXTURES").unwrap_or_else(|_| "/tmp/rs-mongoengine-fixtures".into());
  let filter = std::env::var("PAYLOAD_RS_MONGO_ENGINE_REPLAY_FILTER").ok();
  let report_only = std::env::var("PAYLOAD_RS_MONGO_ENGINE_REPLAY_REPORT_ONLY").is_ok_and(|v| v == "true");
  let mut per_method: BTreeMap<String, (usize, usize)> = BTreeMap::new();
  let mut failures: Vec<String> = Vec::new();
  let mut total = 0usize;
  let mut dirs: Vec<_> = std::fs::read_dir(&root).expect("fixtures dir").flatten().map(|e| e.path()).collect();
  dirs.sort();
  for dir in dirs.into_iter().filter(|d| d.join("calls.ndjson").exists()) {
    let mut engines: HashMap<u64, Arc<MongoEngine<Wired>>> = HashMap::new();
    let calls = std::fs::read_to_string(dir.join("calls.ndjson")).expect("calls");
    for (line_no, line) in calls.lines().enumerate() {
      let record: Json = serde_json::from_str(line).expect("record json");
      let method = record["method"].as_str().unwrap_or_default().to_string();
      if filter.as_deref().is_some_and(|f| f != method) {
        continue;
      }
      let index = record["config"].as_u64().unwrap_or(0);
      let engine = match engines.get(&index) {
        Some(engine) => Arc::clone(engine),
        None => match load_engine(&dir, index) {
          Ok(engine) => {
            engines.insert(index, Arc::clone(&engine));
            engine
          }
          Err(e) => panic!("{}: config-{index}: {e}", dir.display()),
        },
      };
      total += 1;
      let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| replay_call(&engine, &record)))
        .unwrap_or_else(|_| Outcome { mismatches: vec!["panicked".into()] });
      let entry = per_method.entry(method.clone()).or_default();
      if outcome.mismatches.is_empty() {
        entry.0 += 1;
      } else {
        entry.1 += 1;
        failures.push(format!(
          "{}:{} {method}\n{}",
          dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
          line_no + 1,
          outcome.mismatches.iter().map(|m| truncate(m, 1500)).collect::<Vec<_>>().join("\n")
        ));
      }
    }
  }
  println!("method                 pass   fail");
  for (method, (pass, fail)) in &per_method {
    println!("{method:<22} {pass:>5} {fail:>6}");
  }
  let passed: usize = per_method.values().map(|(p, _)| p).sum();
  println!("total {total}, passed {passed}, failed {}", failures.len());
  for failure in failures.iter().take(40) {
    println!("---\n{failure}");
  }
  if let Ok(out) = std::env::var("PAYLOAD_RS_MONGO_ENGINE_REPLAY_OUT") {
    std::fs::write(out, failures.join("\n---\n")).expect("write failures");
  }
  assert!(total > 0, "no recorded calls replayed (fixtures in {root})");
  if !report_only {
    assert!(failures.is_empty(), "{} of {total} recorded calls differ", failures.len());
  }
}

fn truncate(s: &str, max: usize) -> String {
  if s.len() <= max {
    return s.to_string();
  }
  let mut end = max;
  while !s.is_char_boundary(end) {
    end -= 1;
  }
  format!("{}…", &s[..end])
}

/// The replay detects differences: a call whose recorded op, result or mutation is altered fails.
#[test]
#[ignore = "needs recorded fixtures (test/__rs/mongo-engine/record.mjs)"]
fn replay_detects_altered_recordings() {
  let root = std::env::var("PAYLOAD_RS_MONGO_ENGINE_FIXTURES").unwrap_or_else(|_| "/tmp/rs-mongoengine-fixtures".into());
  let mut checked = 0;
  let mut dirs: Vec<_> = std::fs::read_dir(&root).expect("fixtures dir").flatten().map(|e| e.path()).collect();
  dirs.sort();
  'outer: for dir in dirs.into_iter().filter(|d| d.join("calls.ndjson").exists()) {
    let calls = std::fs::read_to_string(dir.join("calls.ndjson")).expect("calls");
    let mut engines: HashMap<u64, Arc<MongoEngine<Wired>>> = HashMap::new();
    for line in calls.lines() {
      let record: Json = serde_json::from_str(line).expect("record json");
      let index = record["config"].as_u64().unwrap_or(0);
      let engine = engines.entry(index).or_insert_with(|| load_engine(&dir, index).expect("engine")).clone();
      if !replay_call(&engine, &record).mismatches.is_empty() || record["ops"].as_array().is_none_or(Vec::is_empty) {
        continue;
      }
      // 1. an op argument changed
      let mut altered = record.clone();
      altered["ops"][0]["method"] = json!("someOtherMethod");
      assert!(!replay_call(&engine, &altered).mismatches.is_empty(), "altered op not detected");
      // 2. an op missing
      let mut altered = record.clone();
      altered["ops"].as_array_mut().expect("ops").push(json!({ "op": "model", "method": "find", "args": [] }));
      assert!(!replay_call(&engine, &altered).mismatches.is_empty(), "missing op not detected");
      // 3. the result changed
      if record.get("result").is_some() {
        let mut altered = record.clone();
        altered["result"] = json!({ "different": true });
        assert!(!replay_call(&engine, &altered).mismatches.is_empty(), "altered result not detected");
      }
      checked += 1;
      if checked >= 20 {
        break 'outer;
      }
    }
  }
  assert!(checked > 0, "no passing recorded call to alter");
}

