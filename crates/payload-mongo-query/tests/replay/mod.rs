//! Replays cases recorded from the real TS (`test/__rs/mongo-query`) through the Rust builders.
//!
//! Fixture (JSON, optionally gzipped):
//! `{ suite, graph: {objects, root: {config, collections, blocks, defaultIDType, fieldSets}},
//!    modelInfo: {slug: collectionName}, disableFallbackSort, cases: [case] }` where every case has
//! `id`, `kind` (`buildQuery` | `modelBuildQuery` | `sort` | `projection`), `args` (a
//! `serializeForEngine` graph, BSON typed), the TS `result` graph or `error` `{name, message,
//! status?}`, `hostOps` (`[{request, result | error}]` in call order, both graphs) and `argsAfter`
//! when the TS changed its arguments.
//!
//! A case passes when the Rust result (or error name + message + status) is exactly the TS one
//! (typed: `ObjectId` bytes, `Date` time values, key order, `undefined` vs missing), the host ops
//! are the recorded requests in the same order, and the reported argument mutations turn `args`
//! into `argsAfter`.

#![allow(dead_code)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::task::{Context, Poll, Waker};

use payload_engine::error::{EngineError, Result};
use payload_engine::js::{JsVal, Obj, TypedValue, decode_graph_bson, encode_value};
use payload_mongo_query::{
  BuildQueryArgs, BuildSortArgs, LocalBoxFuture, ModelOp, ModelRef, Mutation, QueryCx, QueryEnv, QueryHost,
  SchemaBuildQueryArgs, build_projection_from_select, build_query, build_sort_param, parse_params, schema_build_query,
};
use serde_json::{Value as Json, json};

pub struct Fixture {
  pub suite: String,
  pub root: JsVal,
  pub model_info: HashMap<String, String>,
  pub disable_fallback_sort: bool,
  pub cases: Vec<Json>,
}

pub fn load(path: &Path) -> Fixture {
  let bytes = if path.extension().is_some_and(|e| e == "gz") {
    let out = Command::new("gzip").arg("-dc").arg(path).output().expect("run gzip");
    assert!(out.status.success(), "gzip -dc {} failed", path.display());
    out.stdout
  } else {
    std::fs::read(path).expect("read fixture")
  };
  let json: Json = serde_json::from_slice(&bytes).expect("fixture json");
  let root = decode_graph_bson(&json["graph"]).expect("decode graph");
  let model_info = json["modelInfo"]
    .as_object()
    .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned())).collect())
    .unwrap_or_default();
  Fixture {
    suite: json["suite"].as_str().unwrap_or_default().to_owned(),
    root,
    model_info,
    disable_fallback_sort: json["disableFallbackSort"].as_bool().unwrap_or(false),
    cases: json["cases"].as_array().cloned().unwrap_or_default(),
  }
}

/// Typed deep equality; the path of the first difference.
pub fn first_difference(expected: &JsVal, actual: &JsVal, path: &str) -> Option<String> {
  let at = |what: String| Some(format!("{path}: {what}"));
  match (expected.typed(), actual.typed()) {
    (Some(TypedValue::Date(a)), Some(TypedValue::Date(b))) => {
      return if a == b || (a.is_nan() && b.is_nan()) { None } else { at(format!("date {a} != {b}")) };
    }
    (Some(a), Some(b)) => return if a == b { None } else { at(format!("{a:?} != {b:?}")) },
    (None, None) => {}
    (a, b) => return at(format!("{a:?} != {b:?}")),
  }
  match (expected.bson(), actual.bson()) {
    (Some(a), Some(b)) => return if a == b { None } else { at(format!("{a:?} != {b:?}")) },
    (None, None) => {}
    (a, b) => return at(format!("{a:?} != {b:?}")),
  }
  match (expected, actual) {
    (JsVal::Undefined, JsVal::Undefined) | (JsVal::Null, JsVal::Null) => None,
    (JsVal::Bool(a), JsVal::Bool(b)) if a == b => None,
    // the boundary encoding has no `-0`
    (JsVal::Num(a), JsVal::Num(b)) if a == b || (a.is_nan() && b.is_nan()) => None,
    (JsVal::Str(a), JsVal::Str(b)) if a == b => None,
    (JsVal::Fn(a), JsVal::Fn(b)) if a == b => None,
    (JsVal::Arr(a), JsVal::Arr(b)) => {
      if a.len() != b.len() {
        return at(format!("array length {} != {}", a.len(), b.len()));
      }
      a.iter().zip(b.iter()).enumerate().find_map(|(i, (x, y))| first_difference(x, y, &format!("{path}[{i}]")))
    }
    (JsVal::Obj(a), JsVal::Obj(b)) => {
      let ka: Vec<&String> = a.keys().collect();
      let kb: Vec<&String> = b.keys().collect();
      if ka != kb {
        return at(format!("keys {ka:?} != {kb:?}"));
      }
      a.iter().find_map(|(k, x)| first_difference(x, b.get(k).unwrap_or(&JsVal::Undefined), &format!("{path}.{k}")))
    }
    _ => at(format!("{expected:?} != {actual:?}")),
  }
}

/// The recorded host ops, answered in order; a request that is not the recorded one fails the case.
struct RecordedHost<'a> {
  ops: &'a [Json],
  next: Cell<usize>,
  mismatch: RefCell<Option<String>>,
  model_info: &'a HashMap<String, String>,
}

fn recorded_error(e: &Json) -> EngineError {
  EngineError::new(e["name"].as_str().unwrap_or("Error"), e["message"].as_str().unwrap_or_default())
}

impl QueryHost for RecordedHost<'_> {
  fn model_op(&self, op: &ModelOp) -> LocalBoxFuture<'static, Result<JsVal>> {
    let i = self.next.get();
    self.next.set(i + 1);
    let request = op.to_request();
    let result = match self.ops.get(i) {
      None => {
        self.mismatch.borrow_mut().get_or_insert_with(|| format!("unexpected host op #{i}: {}", encode_value(&request)));
        Err(EngineError::internal("unexpected host op"))
      }
      Some(recorded) => {
        let expected = decode_graph_bson(&recorded["request"]).expect("decode host op request");
        if let Some(diff) = first_difference(&expected, &request, "request") {
          self.mismatch.borrow_mut().get_or_insert_with(|| format!("host op #{i} differs: {diff}"));
          Err(EngineError::internal("host op differs"))
        } else if let Some(error) = recorded.get("error").filter(|e| !e.is_null()) {
          Err(recorded_error(error))
        } else {
          Ok(decode_graph_bson(&recorded["result"]).expect("decode host op result"))
        }
      }
    };
    Box::pin(async move { result })
  }

  fn collection_name(&self, slug: &str) -> Result<JsVal> {
    self
      .model_info
      .get(slug)
      .map(|name| JsVal::str(name.as_str()))
      .ok_or_else(|| EngineError::internal(format!("no model info for {slug}")))
  }
}

/// Polls a future whose host ops are all settled already.
fn block_on<T>(future: LocalBoxFuture<'_, T>) -> T {
  let mut future = future;
  let mut cx = Context::from_waker(Waker::noop());
  loop {
    if let Poll::Ready(v) = future.as_mut().poll(&mut cx) {
      return v;
    }
  }
}

/// `args` with the reported mutations applied (by object identity).
fn apply_mutations(v: &JsVal, mutations: &[Mutation]) -> JsVal {
  let own: Vec<&Mutation> = match v.identity() {
    Some(id) => mutations.iter().filter(|m| m.object.identity() == Some(id)).collect(),
    None => Vec::new(),
  };
  if v.typed().is_some() || v.bson().is_some() {
    return v.clone();
  }
  match v {
    JsVal::Arr(a) => {
      let mut items: Vec<JsVal> = a.iter().map(|item| apply_mutations(item, mutations)).collect();
      for m in own {
        let i: usize = m.key.parse().expect("array index");
        if i >= items.len() {
          items.resize(i + 1, JsVal::Undefined);
        }
        items[i] = m.value.clone();
      }
      JsVal::arr(items)
    }
    JsVal::Obj(o) => {
      let mut out: Obj = o.iter().map(|(k, item)| (k.clone(), apply_mutations(item, mutations))).collect();
      for m in own {
        out.insert(m.key.clone(), m.value.clone());
      }
      JsVal::obj(out)
    }
    other => other.clone(),
  }
}

pub struct Outcome {
  pub id: Json,
  pub kind: String,
  pub failure: Option<String>,
  /// The Rust result in the boundary encoding (`{ result }` / `{ error }`), for the TS side.
  pub output: Json,
}

fn error_json(e: &EngineError) -> Json {
  let mut out = json!({ "name": e.name, "message": e.message });
  if let Some(status) = e.data.as_ref().and_then(|d| d.get("status")) {
    out["status"] = status.clone();
  } else if e.name == "APIError" {
    // `new APIError(message)` defaults to status 500
    out["status"] = json!(500);
  }
  out
}

fn field_set(fx: &Fixture, index: &JsVal) -> JsVal {
  let i = index.as_num().map(|n| n as usize).unwrap_or(usize::MAX);
  fx.root.get("fieldSets").as_arr().and_then(|a| a.get(i)).cloned().unwrap_or_default()
}

fn opt_str(v: &JsVal) -> Option<&str> {
  v.as_str()
}

pub fn run_case(fx: &Fixture, case: &Json) -> Outcome {
  let id = case["id"].clone();
  let kind = case["kind"].as_str().unwrap_or_default().to_owned();
  let args = decode_graph_bson(&case["args"]).expect("decode case args");
  let empty = Vec::new();
  let host = RecordedHost {
    ops: case["hostOps"].as_array().unwrap_or(&empty),
    next: Cell::new(0),
    mismatch: RefCell::new(None),
    model_info: &fx.model_info,
  };
  let env = QueryEnv::from_root(&fx.root, fx.disable_fallback_sort);
  let cx = QueryCx::new(env, &host);

  let mut sort_aggregation: Vec<JsVal> = Vec::new();
  let result: Result<JsVal> = match kind.as_str() {
    "buildQuery" => {
      let fields = field_set(fx, args.get("fieldSet"));
      block_on(Box::pin(build_query(
        &cx,
        BuildQueryArgs {
          collection_slug: opt_str(args.get("collectionSlug")),
          fields: &fields,
          global_slug: opt_str(args.get("globalSlug")),
          locale: args.get("locale"),
          where_: args.get("where"),
        },
      )))
    }
    "parseParams" => {
      let fields = field_set(fx, args.get("fieldSet"));
      block_on(parse_params(
        &cx,
        BuildQueryArgs {
          collection_slug: opt_str(args.get("collectionSlug")),
          fields: &fields,
          global_slug: opt_str(args.get("globalSlug")),
          locale: args.get("locale"),
          where_: args.get("where"),
        },
        args.get("parentIsLocalized").truthy(),
      ))
    }
    "modelBuildQuery" => {
      let model = args.get("model");
      let versions_fields = field_set(fx, model.get("versionsFieldSet"));
      let model_ref = match model.get("kind").as_str() {
        Some("collections") => ModelRef::Collection(model.get("slug").as_str().unwrap_or_default()),
        Some("versions") => ModelRef::Versions { collection_slug: opt_str(model.get("collectionSlug")), versions_fields: &versions_fields },
        _ => ModelRef::Globals,
      };
      block_on(Box::pin(schema_build_query(
        &cx,
        model_ref,
        SchemaBuildQueryArgs { global_slug: opt_str(args.get("globalSlug")), locale: args.get("locale"), where_: args.get("where") },
      )))
    }
    "sort" => {
      let fields = field_set(fx, args.get("fieldSet"));
      let with_aggregation = args.get("withAggregation").truthy();
      build_sort_param(
        &cx,
        BuildSortArgs {
          fields: &fields,
          locale: args.get("locale"),
          parent_is_localized: args.get("parentIsLocalized").truthy(),
          sort: args.get("sort"),
          sort_aggregation: with_aggregation.then_some(&mut sort_aggregation),
          timestamps: args.get("timestamps").truthy(),
        },
      )
      .map(|sort| {
        let mut out = Obj::new();
        out.insert("sort".into(), sort);
        if with_aggregation {
          out.insert("sortAggregation".into(), JsVal::arr(sort_aggregation.clone()));
        }
        JsVal::obj(out)
      })
    }
    "projection" => {
      let fields = field_set(fx, args.get("fieldSet"));
      build_projection_from_select(&cx, &fields, args.get("select")).map(Option::unwrap_or_default)
    }
    other => Err(EngineError::internal(format!("unknown case kind {other}"))),
  };

  let mutations = cx.take_mutations();
  let mut failure = host.mismatch.borrow().clone();
  let used = host.next.get();
  let recorded_ops = host.ops.len();

  if failure.is_none() {
    failure = match (&result, case.get("error").filter(|e| !e.is_null())) {
      (Ok(actual), None) => {
        let expected = decode_graph_bson(&case["result"]).expect("decode case result");
        first_difference(&expected, actual, "result")
      }
      (Err(e), Some(expected)) => {
        let actual = error_json(e);
        (actual != *expected).then(|| format!("error {actual} != {expected}"))
      }
      (Ok(actual), Some(expected)) => Some(format!("expected error {expected}, got {}", encode_value(actual))),
      (Err(e), None) => Some(format!("unexpected error {}", error_json(e))),
    };
  }
  if failure.is_none() && used != recorded_ops {
    failure = Some(format!("{used} host ops issued, {recorded_ops} recorded"));
  }
  if failure.is_none() {
    let after = match case.get("argsAfter").filter(|a| !a.is_null()) {
      Some(after) => decode_graph_bson(after).expect("decode argsAfter"),
      None => args.clone(),
    };
    let mutated = apply_mutations(&args, &mutations);
    failure = first_difference(&after, &mutated, "argsAfter");
  }

  let output = match &result {
    Ok(v) => json!({ "result": encode_value(v) }),
    Err(e) => json!({ "error": error_json(e) }),
  };
  Outcome { id, kind, failure, output }
}
