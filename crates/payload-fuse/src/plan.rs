//! Collection plans: the part of a sanitized collection config the fused `afterRead` reads,
//! built by `packages/engine-rs/src/fuse/plan.ts` (JSON) and decoded once.
//!
//! Field JSON (keys absent when false / empty):
//!
//! ```jsonc
//! { "t": "text",          // field.type
//!   "n": "title",         // field.name when `'name' in field`
//!   "ad": 1,              // fieldAffectsData(field)
//!   "h": 1, "ht": 1,      // field.hidden truthy / === true
//!   "l": 1,               // field.localized truthy
//!   "d": <json>,          // a static defaultValue ("dn": 1 when it is `null`)
//!   "df": 1,              // a function defaultValue (the core bails when it would apply)
//!   "f": [..],            // fields (array, group, row, collapsible, tab)
//!   "tabs": [..],         // tabs (each with "t": "tab")
//!   "b": { "slug": [..] },// blocks of the field (field.blocks objects)
//!   "r": "slug" | [..],   // relationTo / join collection
//!   "m": 1,               // hasMany
//!   "md": 2,              // maxDepth
//!   "lx": [..] }          // rich text: lexical node types with afterRead work (bail when present)
//! ```

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::Value as Json;

use payload_engine::js::JsVal;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
  /// Data leaves whose `promise()` only does the generic steps (text, number, select, ...).
  Leaf,
  Point,
  RichText,
  Relationship,
  Join,
  Array,
  Blocks,
  Group,
  /// row / collapsible
  Row,
  Tabs,
  Tab,
  Ui,
}

#[derive(Debug)]
pub enum DefaultValue {
  None,
  Static(JsVal),
  Function,
}

#[derive(Debug)]
pub enum RelationTo {
  None,
  One(String),
  Many(Vec<String>),
}

#[derive(Debug)]
pub struct Field {
  pub kind: Kind,
  /// `field.type` as configured (`slug` / `text` / `textarea` matter for locale fallback).
  pub type_name: String,
  pub name: Option<String>,
  pub affects_data: bool,
  pub hidden: bool,
  pub hidden_true: bool,
  pub localized: bool,
  pub default: DefaultValue,
  pub fields: Vec<Field>,
  pub tabs: Vec<Field>,
  pub blocks: Vec<(String, Arc<Vec<Field>>)>,
  pub relation_to: RelationTo,
  pub has_many: bool,
  pub max_depth: Option<f64>,
  /// lexical node types whose presence makes the editor's afterRead hook do work
  pub lexical_active: Option<HashSet<String>>,
}

#[derive(Debug)]
pub struct CollectionPlan {
  pub slug: String,
  pub fields: Vec<Field>,
  /// `req.payload.blocks` (block references), by slug
  pub global_blocks: HashMap<String, Arc<Vec<Field>>>,
  /// Own keys of `req.payload.collections`
  pub collections: HashSet<String>,
  /// Collections with `trash` enabled (population of trashed documents)
  pub trash_collections: HashSet<String>,
}

fn flag(json: &Json, key: &str) -> bool {
  json.get(key).is_some_and(|v| v.as_bool() == Some(true) || v.as_i64() == Some(1))
}

fn decode_fields(json: Option<&Json>) -> Result<Vec<Field>, String> {
  match json {
    None | Some(Json::Null) => Ok(Vec::new()),
    Some(Json::Array(items)) => items.iter().map(decode_field).collect(),
    Some(_) => Err("fields is not an array".into()),
  }
}

fn decode_blocks(json: Option<&Json>) -> Result<Vec<(String, Arc<Vec<Field>>)>, String> {
  let Some(Json::Object(map)) = json else { return Ok(Vec::new()) };
  map.iter().map(|(slug, fields)| Ok((slug.clone(), Arc::new(decode_fields(Some(fields))?)))).collect()
}

fn decode_field(json: &Json) -> Result<Field, String> {
  let type_name = json.get("t").and_then(Json::as_str).ok_or("field without type")?.to_string();
  let kind = match type_name.as_str() {
    "point" => Kind::Point,
    "richText" => Kind::RichText,
    "relationship" | "upload" => Kind::Relationship,
    "join" => Kind::Join,
    "array" => Kind::Array,
    "blocks" => Kind::Blocks,
    "group" => Kind::Group,
    "row" | "collapsible" => Kind::Row,
    "tabs" => Kind::Tabs,
    "tab" => Kind::Tab,
    "ui" => Kind::Ui,
    _ => Kind::Leaf,
  };
  let default = if flag(json, "df") {
    DefaultValue::Function
  } else if flag(json, "dn") {
    DefaultValue::Static(JsVal::Null)
  } else {
    match json.get("d") {
      Some(value) => DefaultValue::Static(JsVal::from_json(value)),
      None => DefaultValue::None,
    }
  };
  let relation_to = match json.get("r") {
    Some(Json::String(s)) => RelationTo::One(s.clone()),
    Some(Json::Array(items)) => RelationTo::Many(items.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()),
    _ => RelationTo::None,
  };
  let lexical_active = json
    .get("lx")
    .and_then(Json::as_array)
    .map(|items| items.iter().filter_map(|s| s.as_str().map(str::to_string)).collect());
  Ok(Field {
    kind,
    type_name,
    name: json.get("n").and_then(Json::as_str).map(str::to_string),
    affects_data: flag(json, "ad"),
    hidden: flag(json, "h"),
    hidden_true: flag(json, "ht"),
    localized: flag(json, "l"),
    default,
    fields: decode_fields(json.get("f"))?,
    tabs: decode_fields(json.get("tabs"))?,
    blocks: decode_blocks(json.get("b"))?,
    relation_to,
    has_many: flag(json, "m"),
    max_depth: json.get("md").and_then(Json::as_f64),
    lexical_active,
  })
}

/// `{ slug, fields, globalBlocks, collections, trashCollections }`
pub fn decode_plan(json: &Json) -> Result<CollectionPlan, String> {
  let strings = |key: &str| -> HashSet<String> {
    json.get(key).and_then(Json::as_array).into_iter().flatten().filter_map(|s| s.as_str().map(str::to_string)).collect()
  };
  Ok(CollectionPlan {
    slug: json.get("slug").and_then(Json::as_str).ok_or("plan without slug")?.to_string(),
    fields: decode_fields(json.get("fields"))?,
    global_blocks: decode_blocks(json.get("globalBlocks"))?.into_iter().collect(),
    collections: strings("collections"),
    trash_collections: strings("trashCollections"),
  })
}

fn registry() -> &'static Mutex<Vec<Arc<CollectionPlan>>> {
  static PLANS: OnceLock<Mutex<Vec<Arc<CollectionPlan>>>> = OnceLock::new();
  PLANS.get_or_init(Default::default)
}

/// Registers a plan for the process lifetime and returns its id.
pub fn register_plan(json: &str) -> Result<u32, String> {
  let json: Json = serde_json::from_str(json).map_err(|e| format!("invalid plan JSON: {e}"))?;
  let plan = Arc::new(decode_plan(&json)?);
  let mut plans = registry().lock().unwrap_or_else(|e| e.into_inner());
  plans.push(plan);
  Ok((plans.len() - 1) as u32)
}

pub fn plan(id: u32) -> Option<Arc<CollectionPlan>> {
  registry().lock().unwrap_or_else(|e| e.into_inner()).get(id as usize).cloned()
}
