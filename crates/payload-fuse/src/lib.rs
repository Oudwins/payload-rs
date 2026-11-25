//! Fused read lanes (packages/engine-rs/FUSE_CONTRACT.md): a whole read operation (`find`,
//! `findByID`, `count`) off the JS heap for configs without user JS on the read path. The
//! database side is a [`FusedBackend`]; this crate builds nothing but what upstream's operation
//! does after the database call (auth `collection` key, the `afterRead` field traversal) and the
//! result JSON.

pub mod after_read;
pub mod backend;
pub mod json;
pub mod plan;
mod populate;
pub mod write;

use std::sync::Arc;

use serde_json::Value as Json;

use payload_engine::js::{JsVal, decode_graph_typed};

pub use backend::{Bail, DirectRead, FuseResult, FusedBackend, Job, Population, ReadSession, Related};
pub use write::RawLeaves;

use after_read::{AccessFn, Fallback, FieldAccess, ReadArgs, SelectMode, after_read_docs, obj_mut};
use populate::{PopRun, resolve_level, write_result};
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
  /// RUST_HTTP_LANES.md 3.1: the result as canonical text.
  canonical: bool,
  population: Option<Population>,
  /// `fieldAccess`: the compiled field `access.read` functions (`ReadArgs::field_access`)
  field_access: Option<Vec<AccessFn>>,
  /// `accessReq`: `req` as compiled functions see it (`lanes::from_typed`)
  access_req: Option<payload_fn_ir::Value>,
  /// the compiled functions the operation used (`after_read::lane_call`)
  checked: std::sync::Mutex<Vec<payload_fn_ir::FnId>>,
}

fn decode_request(text: &str) -> FuseResult<Request> {
  match json::parse(text) {
    Some(request) => decode_request_value(&request, None),
    None => {
      // the general decoder (shared objects, escaped keys, ...)
      let json: Json = serde_json::from_str(text).map_err(|_| Bail::new("request:json"))?;
      let db = decode_graph_typed(json.get("db").unwrap_or(&Json::Null)).map_err(|_| Bail::new("request:db"))?;
      decode_request_value(&JsVal::from_json(&json), Some(db))
    }
  }
}

/// The request from its decoded value; `db` decoded separately by the general decoder, or (with
/// `None`) the `{ objects: [], root }` of `request.db` decoded directly.
fn decode_request_value(request: &JsVal, db: Option<JsVal>) -> FuseResult<Request> {
  let op = match request.get("op").as_str() {
    Some("find") => Op::Find,
    Some("findByID") => Op::FindByID,
    Some("count") => Op::Count,
    _ => return Err(Bail::new("request:op")),
  };
  let plan_id = request.get("plan").as_num().filter(|n| *n >= 0.0 && n.fract() == 0.0).ok_or_else(|| Bail::new("request:plan"))?;
  let plan = plan::plan(plan_id as u32).ok_or_else(|| Bail::new("request:plan"))?;
  let db = match db {
    Some(db) => db,
    None => {
      let wrapper = request.get("db");
      if wrapper.get("objects").as_arr().is_none_or(|objects| !objects.is_empty()) {
        return Err(Bail::new("request:db"));
      }
      wrapper.get("root").clone()
    }
  };
  let fallback = match request.get("fallbackLocale") {
    JsVal::Str(s) if !s.is_empty() => Fallback::One(s.to_string()),
    JsVal::Arr(items) => Fallback::Many(
      items.iter().map(|s| s.as_str().map(str::to_string).ok_or_else(|| Bail::new("request:fallback"))).collect::<FuseResult<_>>()?,
    ),
    JsVal::Undefined | JsVal::Null | JsVal::Bool(false) | JsVal::Str(_) => Fallback::None,
    _ => return Err(Bail::new("request:fallback")),
  };
  let num = |key: &str, default: f64| request.get(key).as_num().unwrap_or(default);
  let flag = |key: &str| matches!(request.get(key), JsVal::Bool(true));
  let select = match request.get("select") {
    JsVal::Undefined | JsVal::Null => None,
    value => Some(value.clone()),
  };
  let select_mode = select_mode_of(request.get("selectMode"));
  let access_req = match request.get("accessReq") {
    JsVal::Undefined => None,
    req => Some(payload_fn_ir::lanes::from_typed(req).ok_or_else(|| Bail::new("request:accessReq"))?),
  };
  let population = match request.get("pop") {
    JsVal::Undefined | JsVal::Null => None,
    pop => Some(decode_population(pop, access_req.clone())?),
  };
  let field_access = decode_access(request.get("fieldAccess"))?;
  Ok(Request {
    op,
    plan,
    db,
    locale: request.get("locale").as_str().map(str::to_string),
    fallback,
    localization: flag("localization"),
    flatten_locales: !matches!(request.get("flattenLocales"), JsVal::Bool(false)),
    show_hidden: flag("showHiddenFields"),
    depth: num("depth", 0.0),
    current_depth: num("currentDepth", 1.0),
    select,
    select_mode,
    auth: flag("auth"),
    canonical: flag("canonical"),
    population,
    field_access,
    access_req,
    checked: Default::default(),
  })
}

/// `fieldAccess`: the `FnId`s of the plan's field `access.read` functions, or absent.
fn decode_access(value: &JsVal) -> FuseResult<Option<Vec<AccessFn>>> {
  let items = match value {
    JsVal::Undefined | JsVal::Null => return Ok(None),
    JsVal::Arr(items) => items,
    _ => return Err(Bail::new("request:fieldAccess")),
  };
  let functions = items
    .iter()
    .map(|item| {
      let id = item.as_num().filter(|n| *n >= 0.0 && n.fract() == 0.0).ok_or_else(|| Bail::new("request:fieldAccess"))? as u32;
      let meta = payload_fn_ir::registry::meta(id).ok_or_else(|| Bail::new("access:field:not-compiled"))?;
      let request_only = match meta.arg_keys.as_slice() {
        [] => true,
        [Some(keys)] => keys.iter().all(|key| key == "req"),
        _ => false,
      };
      Ok(AccessFn { id, request_only })
    })
    .collect::<FuseResult<Vec<_>>>()?;
  Ok(Some(functions))
}

fn select_mode_of(value: &JsVal) -> Option<SelectMode> {
  match value.as_str() {
    Some("include") => Some(SelectMode::Include),
    Some("exclude") => Some(SelectMode::Exclude),
    _ => None,
  }
}

/// `"pop": { draft, joins, locale, req, related: { [slug]: { plan, select, selectMode, sort,
/// trash, numberID, auth, backend } } }`
fn decode_population(pop: &JsVal, access_req: Option<payload_fn_ir::Value>) -> FuseResult<Population> {
  let JsVal::Obj(entries) = pop.get("related") else { return Err(Bail::new("request:pop")) };
  let mut related = std::collections::HashMap::with_capacity(entries.len());
  for (slug, entry) in entries.iter() {
    let plan_id = entry.get("plan").as_num().filter(|n| *n >= 0.0 && n.fract() == 0.0).ok_or_else(|| Bail::new("request:pop"))?;
    let plan = plan::plan(plan_id as u32).ok_or_else(|| Bail::new("request:pop"))?;
    let select = match entry.get("select") {
      JsVal::Undefined | JsVal::Null => None,
      value => Some(value.clone()),
    };
    let flag = |key: &str| matches!(entry.get(key), JsVal::Bool(true));
    related.insert(
      slug.clone(),
      Related {
        plan,
        select,
        select_mode: select_mode_of(entry.get("selectMode")),
        sort: entry.get("sort").clone(),
        trash: flag("trash"),
        number_id: flag("numberID"),
        auth: flag("auth"),
        backend: entry.get("backend").clone(),
        field_access: decode_access(entry.get("fieldAccess"))?,
        access: match entry.get("access") {
          JsVal::Undefined | JsVal::Null => None,
          id => Some(id.as_num().filter(|n| *n >= 0.0 && n.fract() == 0.0).ok_or_else(|| Bail::new("request:pop"))? as u32),
        },
      },
    );
  }
  Ok(Population {
    draft: matches!(pop.get("draft"), JsVal::Bool(true)),
    joins: pop.get("joins").clone(),
    locale: pop.get("locale").clone(),
    req: pop.get("req").clone(),
    related,
    access_req,
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
  let leaves = session.raw_leaves();
  write::with_raw_leaves(leaves, || write::with_canonical(request.canonical, || execute_in(&request, session)))
}

/// The collection plan and the canonical-text flag of a request, for a backend that prepares
/// documents before the core runs (`None`: the request does not decode; `run` reports why).
pub fn peek_request(request_json: &str) -> Option<(Arc<CollectionPlan>, bool)> {
  decode_request(request_json).ok().map(|request| (request.plan, request.canonical))
}

fn execute_in(request: &Request, session: &mut dyn ReadSession) -> FuseResult<String> {
  let field_access = match (&request.field_access, &request.access_req) {
    (None, _) => None,
    (Some(functions), Some(req)) => Some(FieldAccess { functions, req: req.clone(), checked: &request.checked }),
    (Some(_), None) => return Err(Bail::new("request:accessReq")),
  };
  let args = ReadArgs {
    plan: &request.plan,
    field_access,
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
    let direct = DirectRead {
      read: &args,
      select,
      select_mode: request.select_mode,
      auth: request.auth,
      population: request.population.as_ref(),
    };
    if let Some(result) = session.find_json(&request.db, matches!(request.op, Op::FindByID), &direct) {
      return result;
    }
  }
  match request.op {
    Op::Find => {
      let mut result = session.find_planned(&request.db, &request.plan)?;
      let mut run = request.population.as_ref().map(|pop| PopRun::new(pop, &request.checked));
      let page = obj_mut(&mut result).ok_or_else(|| Bail::new("find:result"))?;
      let docs = match page.get_mut("docs") {
        Some(JsVal::Arr(docs)) => Arc::make_mut(docs),
        _ => return Err(Bail::new("find:docs")),
      };
      if request.auth {
        for doc in docs.iter_mut() {
          add_collection(doc, &request.plan.slug)?;
        }
      }
      let loads = after_read_docs(&args, docs, select, request.select_mode, run.as_mut())?;
      if let Some(run) = run.as_mut() {
        resolve_level(run, session, &args, docs, loads)?;
      }
      write_result(&result, run.as_ref())
    }
    Op::FindByID => {
      let mut doc = session.find_one_planned(&request.db, &request.plan)?;
      if !doc.truthy() {
        return Err(Bail::new("findByID:notFound"));
      }
      if request.auth {
        add_collection(&mut doc, &request.plan.slug)?;
      }
      let mut run = request.population.as_ref().map(|pop| PopRun::new(pop, &request.checked));
      let loads = after_read_docs(&args, std::slice::from_mut(&mut doc), select, request.select_mode, run.as_mut())?;
      if let Some(run) = run.as_mut() {
        resolve_level(run, session, &args, std::slice::from_mut(&mut doc), loads)?;
      }
      write_result(&doc, run.as_ref())
    }
    Op::Count => write::to_json(&session.count(&request.db)?),
  }
}

/// updateByID's `originalDoc` (collections/operations/utilities/update.ts): `afterRead({ depth: 0,
/// doc, fallbackLocale: null, overrideAccess: true, showHiddenFields: true, ... })` on `doc` (a
/// copy of the stored document after the read transform), with the collection plan, locale and
/// localization of the fused request `request_json` (the write's result read). The fused writes,
/// packages/engine-rs/FUSED_WRITES.md section 13.
pub fn after_read_original(request_json: &str, doc: &mut JsVal) -> FuseResult<()> {
  let request = decode_request(request_json)?;
  let args = ReadArgs {
    plan: &request.plan,
    locale: request.locale.clone(),
    fallback: Fallback::None,
    localization: request.localization,
    flatten_locales: true,
    show_hidden: true,
    depth: 0.0,
    current_depth: 1.0,
    // `overrideAccess: true`: no field access applies
    field_access: None,
  };
  after_read::after_read(&args, doc, None, None)
}

/// `{ ...doc, collection: slug }`
pub(crate) fn add_collection(doc: &mut JsVal, slug: &str) -> FuseResult<()> {
  let props = obj_mut(doc).ok_or_else(|| Bail::new("doc:not-object"))?;
  props.insert("collection".to_string(), JsVal::str(slug));
  Ok(())
}

/// Registers a collection plan (`plan.ts` JSON) and returns its id.
pub fn register_plan(json: &str) -> Result<u32, String> {
  plan::register_plan(json)
}
