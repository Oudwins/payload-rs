//! Fused read lanes (packages/engine-rs/FUSE_CONTRACT.md): a whole read operation (`find`,
//! `findByID`, `count`) off the JS heap for configs without user JS on the read path. The
//! database side is a [`FusedBackend`]; this crate builds nothing but what upstream's operation
//! does after the database call (auth `collection` key, the `afterRead` field traversal) and the
//! result JSON.

pub mod after_read;
pub mod backend;
pub mod plan;
pub mod write;

use std::sync::Arc;

use serde_json::Value as Json;

use payload_engine::js::{JsVal, decode_graph_typed};

pub use backend::{Bail, DirectRead, FuseResult, FusedBackend, Job, ReadSession};

use after_read::{Fallback, ReadArgs, SelectMode, after_read, obj_mut};
use plan::CollectionPlan;

/// `Object.prototype` property names: a document or config key with one of these names is read
/// through the prototype by upstream, which the core does not model.
pub const OBJECT_PROTOTYPE_KEYS: &[&str] = &[
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
];

#[derive(Clone, Copy)]
enum Op {
  Find,
  FindByID,
  Count,
}

/// An operation decoded from the request JSON (FUSE_CONTRACT.md section 4).
struct Request {
  op: Op,
  plan: Arc<CollectionPlan>,
  db: JsVal,
  locale: Option<String>,
  fallback: Fallback,
  localization: bool,
  flatten_locales: bool,
  show_hidden: bool,
  depth: f64,
  current_depth: f64,
  select: Option<JsVal>,
  select_mode: Option<SelectMode>,
  auth: bool,
}

fn decode_request(json: &str) -> FuseResult<Request> {
  let json: Json = serde_json::from_str(json).map_err(|_| Bail::new("request:json"))?;
  let op = match json.get("op").and_then(Json::as_str) {
    Some("find") => Op::Find,
    Some("findByID") => Op::FindByID,
    Some("count") => Op::Count,
    _ => return Err(Bail::new("request:op")),
  };
  let plan_id = json.get("plan").and_then(Json::as_u64).ok_or_else(|| Bail::new("request:plan"))?;
  let plan = plan::plan(plan_id as u32).ok_or_else(|| Bail::new("request:plan"))?;
  let db = decode_graph_typed(json.get("db").unwrap_or(&Json::Null)).map_err(|_| Bail::new("request:db"))?;
  let fallback = match json.get("fallbackLocale") {
    Some(Json::String(s)) if !s.is_empty() => Fallback::One(s.clone()),
    Some(Json::Array(items)) => {
      Fallback::Many(items.iter().map(|s| s.as_str().map(str::to_string).ok_or_else(|| Bail::new("request:fallback"))).collect::<FuseResult<_>>()?)
    }
    None | Some(Json::Null | Json::Bool(false)) => Fallback::None,
    Some(Json::String(_)) => Fallback::None,
    Some(_) => return Err(Bail::new("request:fallback")),
  };
  let num = |key: &str, default: f64| json.get(key).and_then(Json::as_f64).unwrap_or(default);
  let flag = |key: &str| json.get(key).and_then(Json::as_bool).unwrap_or(false);
  let select = match json.get("select") {
    None | Some(Json::Null) => None,
    Some(value) => Some(JsVal::from_json(value)),
  };
  let select_mode = match json.get("selectMode").and_then(Json::as_str) {
    Some("include") => Some(SelectMode::Include),
    Some("exclude") => Some(SelectMode::Exclude),
    _ => None,
  };
  Ok(Request {
    op,
    plan,
    db,
    locale: json.get("locale").and_then(Json::as_str).map(str::to_string),
    fallback,
    localization: flag("localization"),
    flatten_locales: json.get("flattenLocales").and_then(Json::as_bool).unwrap_or(true),
    show_hidden: flag("showHiddenFields"),
    depth: num("depth", 0.0),
    current_depth: num("currentDepth", 1.0),
    select,
    select_mode,
    auth: flag("auth"),
  })
}

/// Runs one fused operation on `backend` and returns the result JSON text, or `!<reason>` when it
/// bailed (FUSE_CONTRACT.md section 5).
pub fn run(backend: &dyn FusedBackend, conn: u32, request_json: &str) -> String {
  let outcome = decode_request(request_json).and_then(|request| backend.run(conn, Box::new(move |session| execute(request, session))));
  match outcome {
    Ok(text) => text,
    Err(Bail(reason)) => format!("!{reason}"),
  }
}

fn execute(request: Request, session: &mut dyn ReadSession) -> FuseResult<String> {
  let args = ReadArgs {
    plan: &request.plan,
    locale: request.locale.clone(),
    fallback: request.fallback.clone(),
    localization: request.localization,
    flatten_locales: request.flatten_locales,
    show_hidden: request.show_hidden,
    depth: request.depth,
    current_depth: request.current_depth,
  };
  let select = request.select.as_ref();
  if matches!(request.op, Op::Find | Op::FindByID) {
    let direct = DirectRead { read: &args, select, select_mode: request.select_mode, auth: request.auth };
    if let Some(result) = session.find_json(&request.db, matches!(request.op, Op::FindByID), &direct) {
      return result;
    }
  }
  match request.op {
    Op::Find => {
      let mut result = session.find(&request.db)?;
      let page = obj_mut(&mut result).ok_or_else(|| Bail::new("find:result"))?;
      let docs = match page.get_mut("docs") {
        Some(JsVal::Arr(docs)) => Arc::make_mut(docs),
        _ => return Err(Bail::new("find:docs")),
      };
      for doc in docs.iter_mut() {
        if request.auth {
          add_collection(doc, &request.plan.slug)?;
        }
        after_read(&args, doc, select, request.select_mode)?;
      }
      write::to_json(&result)
    }
    Op::FindByID => {
      let mut doc = session.find_one(&request.db)?;
      if !doc.truthy() {
        return Err(Bail::new("findByID:notFound"));
      }
      if request.auth {
        add_collection(&mut doc, &request.plan.slug)?;
      }
      after_read(&args, &mut doc, select, request.select_mode)?;
      write::to_json(&doc)
    }
    Op::Count => write::to_json(&session.count(&request.db)?),
  }
}

/// `{ ...doc, collection: slug }`
fn add_collection(doc: &mut JsVal, slug: &str) -> FuseResult<()> {
  let props = obj_mut(doc).ok_or_else(|| Bail::new("doc:not-object"))?;
  props.insert("collection".to_string(), JsVal::str(slug));
  Ok(())
}

/// Registers a collection plan (`plan.ts` JSON) and returns its id.
pub fn register_plan(json: &str) -> Result<u32, String> {
  plan::register_plan(json)
}
