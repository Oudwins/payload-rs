//! Differential replay of upstream `transform` calls recorded during real upstream runs on MongoDB
//! (test/__rs/mongo-transform/recorder.ts, test/__rs/mongo-transform/record.mjs).
//!
//! Every recorded call is replayed on the recorded "before" state and compared with the recorded
//! "after" state: values (typed ObjectId / Date / bigint / Decimal128 / RegExp / Binary, own
//! `undefined` keys, key order), the sharing structure of the result (a bijection between the
//! objects of both sides), which result objects are the input objects (in-place mutation and
//! identity, the recorder's `identity` list), the return value and the thrown error.
//!
//! Inputs: `PAYLOAD_RS_MONGO_TRANSFORM_FIXTURES` (`:`-separated files or directories of `.jsonl`
//! recordings), default test/__rs/mongo-transform/fixtures. Fails when no call was replayed, when
//! any call differs, or when the comparison does not discriminate (the recorded "before" states
//! must differ from the "after" states for some calls).

use std::cell::Cell;
use std::collections::HashMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};

use payload_engine::js::{JsVal, decode_graph_bson};
use payload_mongo_transform::{
  Exporter, Importer, Operation, Operators, TransformArgs, TransformEnv, TransformState, Val, transform, transform_val,
};
use serde_json::Value as Json;

fn jsonl_files(path: &Path, out: &mut Vec<PathBuf>) {
  if path.is_dir() {
    let mut entries: Vec<_> = std::fs::read_dir(path).into_iter().flatten().flatten().map(|e| e.path()).collect();
    entries.sort();
    for entry in entries {
      jsonl_files(&entry, out);
    }
  } else if path.extension().is_some_and(|e| e == "jsonl") {
    out.push(path.to_path_buf());
  }
}

/// Pre-order (first visit) of the object values of `root`, as the recorder's `objectsOf`.
fn objects_of(root: &Val) -> Vec<Val> {
  fn visit(v: &Val, seen: &mut std::collections::HashSet<usize>, out: &mut Vec<Val>) {
    let Some(id) = v.identity() else { return };
    if !seen.insert(id) {
      return;
    }
    out.push(v.clone());
    match v {
      Val::Arr(_) => {
        for item in v.items() {
          visit(&item, seen, out);
        }
      }
      Val::Obj(o) => {
        let values: Vec<Val> = o.borrow().values().cloned().collect();
        for item in &values {
          visit(item, seen, out);
        }
      }
      _ => {}
    }
  }
  let mut out = Vec::new();
  visit(root, &mut std::collections::HashSet::new(), &mut out);
  out
}

/// Deep equality of two decoded values with a bijection between their objects.
struct Compare {
  ab: HashMap<usize, usize>,
  ba: HashMap<usize, usize>,
}

impl Compare {
  fn new() -> Self {
    Compare { ab: HashMap::new(), ba: HashMap::new() }
  }

  fn eq(&mut self, a: &JsVal, b: &JsVal, path: &str) -> Result<(), String> {
    let (ia, ib) = (a.identity(), b.identity());
    if let (Some(ia), Some(ib)) = (ia, ib) {
      match (self.ab.get(&ia), self.ba.get(&ib)) {
        (Some(x), _) if *x == ib => return Ok(()),
        (None, None) => {
          self.ab.insert(ia, ib);
          self.ba.insert(ib, ia);
        }
        _ => return Err(format!("{path}: different sharing of objects")),
      }
    }
    let typed = (a.typed(), b.typed());
    if typed.0.is_some() || typed.1.is_some() {
      return match typed {
        (Some(x), Some(y)) if format!("{x:?}") == format!("{y:?}") => Ok(()),
        _ => Err(format!("{path}: {a:?} != {b:?}")),
      };
    }
    let bson = (a.bson(), b.bson());
    if bson.0.is_some() || bson.1.is_some() {
      return if bson.0 == bson.1 { Ok(()) } else { Err(format!("{path}: {:?} != {:?}", bson.0, bson.1)) };
    }
    match (a, b) {
      (JsVal::Undefined, JsVal::Undefined) | (JsVal::Null, JsVal::Null) | (JsVal::Fn(_), JsVal::Fn(_)) => Ok(()),
      (JsVal::Bool(x), JsVal::Bool(y)) if x == y => Ok(()),
      (JsVal::Num(x), JsVal::Num(y)) if x == y || (x.is_nan() && y.is_nan()) => Ok(()),
      (JsVal::Str(x), JsVal::Str(y)) if x == y => Ok(()),
      (JsVal::Arr(x), JsVal::Arr(y)) => {
        if x.len() != y.len() {
          return Err(format!("{path}: array length {} != {}", x.len(), y.len()));
        }
        for (i, (p, q)) in x.iter().zip(y.iter()).enumerate() {
          self.eq(p, q, &format!("{path}[{i}]"))?;
        }
        Ok(())
      }
      (JsVal::Obj(x), JsVal::Obj(y)) => {
        let kx: Vec<&String> = x.keys().collect();
        let ky: Vec<&String> = y.keys().collect();
        if kx != ky {
          return Err(format!("{path}: keys {kx:?} != {ky:?}"));
        }
        for (k, p) in x.iter() {
          self.eq(p, &y[k], &format!("{path}.{k}"))?;
        }
        Ok(())
      }
      _ => Err(format!("{path}: {a:?} != {b:?}")),
    }
  }
}

#[derive(Default)]
struct Stats {
  files: usize,
  calls: usize,
  passed: usize,
  errors_expected: usize,
  changed: usize,
  unparsed: usize,
  failures: Vec<String>,
  unsupported: Vec<String>,
  by_operation: HashMap<String, usize>,
}

fn decode(json: &Json) -> Result<JsVal, String> {
  decode_graph_bson(json).map_err(|e| e.to_string())
}

fn replay_file(file: &Path, stats: &mut Stats) {
  stats.files += 1;
  let reader = std::io::BufReader::new(std::fs::File::open(file).expect("open recording"));
  let mut configs: HashMap<u64, TransformEnv> = HashMap::new();
  let mut fields: HashMap<u64, JsVal> = HashMap::new();
  for (line_no, line) in reader.lines().enumerate() {
    let line = line.expect("read line");
    let at = format!("{}:{}", file.display(), line_no + 1);
    let record: Json = match serde_json::from_str(&line) {
      Ok(r) => r,
      Err(e) => {
        stats.unparsed += 1;
        stats.failures.push(format!("{at}: unparseable record ({e})"));
        continue;
      }
    };
    let id = record["id"].as_u64().unwrap_or(u64::MAX);
    match record["t"].as_str() {
      Some("config") => {
        configs.insert(id, TransformEnv::new(decode(&record["graph"]).expect("config graph")));
      }
      Some("fields") => {
        let value = if let Some(reference) = record.get("ref") {
          let env = &configs[&record["config"].as_u64().expect("config id")];
          let kind = reference[0].as_str().expect("ref kind");
          let index = reference[1].as_u64().expect("ref index") as usize;
          env.config.get(kind).as_arr().expect("entities")[index].get("fields").clone()
        } else {
          decode(&record["graph"]).expect("fields graph")
        };
        fields.insert(id, value);
      }
      Some("call") => {
        stats.calls += 1;
        match replay_call(&record, &configs, &fields, stats) {
          Ok(()) => stats.passed += 1,
          // the adversarial generator (test/__rs/mongo-transform/synthetic.spec.ts) also covers
          // shapes the engine rejects explicitly instead of modelling (see the crate docs)
          Err(e) if e.contains("is not supported by the engine") && file.to_string_lossy().contains("synthetic") => {
            stats.unsupported.push(format!("{at}: {e}"))
          }
          Err(e) => stats.failures.push(format!("{at}: {e}")),
        }
      }
      _ => {}
    }
  }
}

fn replay_call(record: &Json, configs: &HashMap<u64, TransformEnv>, fields: &HashMap<u64, JsVal>, stats: &mut Stats) -> Result<(), String> {
  let env = configs.get(&record["config"].as_u64().unwrap_or(u64::MAX)).ok_or("unknown config")?;
  let fields = fields.get(&record["fields"].as_u64().unwrap_or(u64::MAX)).ok_or("unknown fields")?;
  let meta = decode(&record["meta"])?;
  let operation = match meta.get("operation").as_str() {
    Some("read") => Operation::Read,
    Some("write") => Operation::Write,
    other => return Err(format!("operation {other:?}")),
  };
  *stats.by_operation.entry(format!("{operation:?}")).or_default() += 1;
  let parent_is_localized = meta.get("parentIsLocalized");
  let validate_relationships = meta.get("validateRelationships");
  let global_slug = meta.get("globalSlug");
  let nows: Vec<f64> = record["nows"].as_array().map(|a| a.iter().filter_map(Json::as_f64).collect()).unwrap_or_default();
  let now_index = Cell::new(0usize);
  let now = || {
    let i = now_index.get();
    now_index.set(i + 1);
    // a stamp upstream could not store (the assignment threw) is not recorded
    nows.get(i).copied().unwrap_or(0.0)
  };
  let args = TransformArgs {
    operation,
    fields,
    global_slug: (!global_slug.is_undefined()).then_some(global_slug),
    parent_is_localized: !parent_is_localized.is_undefined() && parent_is_localized.truthy(),
    validate_relationships: validate_relationships.is_undefined() || validate_relationships.truthy(),
    use_big_int_for_number_ids: record["flags"]["useBigIntForNumberIDs"].as_bool().unwrap_or(false),
    allow_additional_keys: record["flags"]["allowAdditionalKeys"].as_bool().unwrap_or(false),
    now: &now,
  };

  let before = decode(&record["before"])?;
  let mut importer = Importer::default();
  let state = importer.import(&before).map_err(|e| format!("import: {e}"))?;
  let before_index: HashMap<usize, i64> =
    importer.order.iter().enumerate().filter_map(|(i, v)| v.identity().map(|id| (id, i as i64))).collect();
  let ops = Operators {
    inc: state.prop("$inc").map_err(|e| e.to_string())?,
    push: state.prop("$push").map_err(|e| e.to_string())?,
    add_to_set: state.prop("$addToSet").map_err(|e| e.to_string())?,
    pull: state.prop("$pull").map_err(|e| e.to_string())?,
  };
  let data = state.prop("data").map_err(|e| e.to_string())?;
  let result = transform_val(env, &args, &data, &ops);

  match (&result, &record["error"]) {
    (Ok(ret), Json::Null) => {
      let expected = record["ret"].as_str().unwrap_or("");
      let actual = match ret {
        Val::Null => "null",
        Val::Undefined => "undefined",
        _ => "other",
      };
      if actual != expected {
        return Err(format!("returned {actual}, upstream {expected}"));
      }
    }
    (Ok(_), error) => return Err(format!("no error, upstream threw {error}")),
    (Err(e), Json::Null) => return Err(format!("threw {e}, upstream did not")),
    (Err(e), error) => {
      if error["name"].as_str() != Some(e.name.as_str()) || error["message"].as_str() != Some(e.message.as_str()) {
        return Err(format!("threw {e}, upstream threw {error}"));
      }
      stats.errors_expected += 1;
    }
  }
  if now_index.get() != nows.len() && (result.is_ok() || now_index.get() < nows.len()) {
    return Err(format!("stamped {} updatedAt values, upstream {}", now_index.get(), nows.len()));
  }

  let after_rs = Exporter::default().export(&state).map_err(|e| format!("export: {e}"))?;
  let after_ts = decode(&record["after"])?;
  Compare::new().eq(&after_ts, &after_rs, "state")?;

  let identity: Vec<i64> = objects_of(&state).iter().map(|v| v.identity().and_then(|id| before_index.get(&id).copied()).unwrap_or(-1)).collect();
  let expected: Vec<i64> = record["identity"].as_array().map(|a| a.iter().filter_map(Json::as_i64).collect()).unwrap_or_default();
  if identity != expected {
    return Err(format!("object identity {identity:?}, upstream {expected:?}"));
  }
  // the public JsVal entry point gives the same state and result (fresh decode of `before`)
  now_index.set(0);
  let fresh = decode(&record["before"])?;
  let outcome = transform(
    env,
    &args,
    TransformState {
      data: fresh.get("data").clone(),
      inc: fresh.get("$inc").clone(),
      push: fresh.get("$push").clone(),
      add_to_set: fresh.get("$addToSet").clone(),
      pull: fresh.get("$pull").clone(),
    },
  );
  if outcome.result.is_ok() != result.is_ok() {
    return Err("transform() and transform_val() disagree on the result".into());
  }
  let mut compare = Compare::new();
  for (key, value) in [
    ("data", &outcome.state.data),
    ("$inc", &outcome.state.inc),
    ("$push", &outcome.state.push),
    ("$addToSet", &outcome.state.add_to_set),
    ("$pull", &outcome.state.pull),
  ] {
    compare.eq(after_ts.get(key), value, &format!("transform().{key}"))?;
  }
  if Compare::new().eq(&after_ts, &before, "state").is_err() {
    stats.changed += 1;
  }
  Ok(())
}

/// Pathological data (one recursion per dotted key) fails with V8's error instead of exhausting
/// the stack of the (2 MB) test thread.
#[test]
fn deep_dotted_key_recursion_is_a_range_error() {
  let fields = JsVal::from_json(&serde_json::json!([{ "name": "title", "type": "text" }]));
  let env = TransformEnv::new(JsVal::from_json(&serde_json::json!({ "collections": [] })));
  let data = Val::new_obj();
  for i in 0..1500 {
    data.set(&format!("a{i}.b"), Val::Num(1.0)).expect("set");
  }
  let now = || 0.0;
  let args = TransformArgs {
    operation: Operation::Write,
    fields: &fields,
    global_slug: None,
    parent_is_localized: false,
    validate_relationships: true,
    use_big_int_for_number_ids: false,
    allow_additional_keys: false,
    now: &now,
  };
  let error = transform_val(&env, &args, &data, &Operators::default()).expect_err("too deep");
  assert_eq!((error.name.as_str(), error.message.as_str()), ("RangeError", "Maximum call stack size exceeded"));
}

#[test]
fn replays_recorded_upstream_transform_calls() {
  let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
  let inputs = std::env::var("PAYLOAD_RS_MONGO_TRANSFORM_FIXTURES")
    .map(|v| v.split(':').map(PathBuf::from).collect::<Vec<_>>())
    .unwrap_or_else(|_| vec![root.join("test/__rs/mongo-transform/fixtures")]);
  let mut files = Vec::new();
  for input in &inputs {
    jsonl_files(input, &mut files);
  }
  let mut stats = Stats::default();
  for file in &files {
    replay_file(file, &mut stats);
  }
  println!(
    "mongo transform replay: {} files, {} calls ({:?}), {} passed ({} with the upstream error), {} changed the data, {} explicitly unsupported (synthetic), {} failed",
    stats.files,
    stats.calls,
    stats.by_operation,
    stats.passed,
    stats.errors_expected,
    stats.changed,
    stats.unsupported.len(),
    stats.failures.len()
  );
  for unsupported in &stats.unsupported {
    println!("  unsupported: {unsupported}");
  }
  for failure in stats.failures.iter().take(30) {
    println!("  {failure}");
  }
  assert!(stats.calls > 0, "no recorded calls found in {inputs:?}");
  assert!(stats.changed > 0, "no recorded call changed its data: the comparison would not discriminate");
  assert_eq!(stats.unparsed, 0, "unparseable records");
  assert!(stats.failures.is_empty(), "{} of {} calls differ from upstream", stats.failures.len(), stats.calls);
}
