//! The write plan (FUSED_WRITES.md section 12.1), decoded from the JSON
//! `packages/engine-rs/src/fuse-write/writePlan.ts` builds.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use indexmap::IndexMap;
use serde_json::Value as Json;

use payload_core_validate::Validator;
use payload_engine::js::{JsVal, Obj as JsObj};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
  Array,
  Checkbox,
  Collapsible,
  Date,
  Email,
  Group,
  Number,
  Relationship,
  RichText,
  Row,
  Select,
  Tabs,
  Text,
  Textarea,
}

impl Kind {
  fn parse(s: &str) -> Option<Kind> {
    Some(match s {
      "array" => Kind::Array,
      "checkbox" => Kind::Checkbox,
      "collapsible" => Kind::Collapsible,
      "date" => Kind::Date,
      "email" => Kind::Email,
      "group" => Kind::Group,
      "number" => Kind::Number,
      "relationship" => Kind::Relationship,
      "richText" => Kind::RichText,
      "row" => Kind::Row,
      "select" => Kind::Select,
      "tabs" => Kind::Tabs,
      "text" => Kind::Text,
      "textarea" => Kind::Textarea,
      _ => return None,
    })
  }

  /// `field.type` as upstream writes it.
  pub fn name(self) -> &'static str {
    match self {
      Kind::Array => "array",
      Kind::Checkbox => "checkbox",
      Kind::Collapsible => "collapsible",
      Kind::Date => "date",
      Kind::Email => "email",
      Kind::Group => "group",
      Kind::Number => "number",
      Kind::Relationship => "relationship",
      Kind::RichText => "richText",
      Kind::Row => "row",
      Kind::Select => "select",
      Kind::Tabs => "tabs",
      Kind::Text => "text",
      Kind::Textarea => "textarea",
    }
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Authorship {
  CreatedBy,
  UpdatedBy,
}

impl Authorship {
  pub fn key(self) -> &'static str {
    match self {
      Authorship::CreatedBy => "createdBy",
      Authorship::UpdatedBy => "updatedBy",
    }
  }
}

/// Payload's own field hooks (`payloadOwnFunctions` kinds).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnHook {
  RowIdBeforeChange,
  AuthorshipBeforeValidate(Authorship),
  AuthorshipBeforeChange(Authorship),
}

impl OwnHook {
  fn parse(s: &str) -> Option<OwnHook> {
    Some(match s {
      "rowIdBeforeChange" => OwnHook::RowIdBeforeChange,
      "authorshipBeforeValidate:createdBy" => OwnHook::AuthorshipBeforeValidate(Authorship::CreatedBy),
      "authorshipBeforeValidate:updatedBy" => OwnHook::AuthorshipBeforeValidate(Authorship::UpdatedBy),
      "authorshipBeforeChange:createdBy" => OwnHook::AuthorshipBeforeChange(Authorship::CreatedBy),
      "authorshipBeforeChange:updatedBy" => OwnHook::AuthorshipBeforeChange(Authorship::UpdatedBy),
      _ => return None,
    })
  }
}

#[derive(Clone, Debug)]
pub enum DefaultValue {
  None,
  Static(JsVal),
  /// The registry's `rowIdDefaultValue`: `new ObjectId().toHexString()`.
  RowId,
}

#[derive(Clone, Debug)]
pub enum Validate {
  /// No `field.validate` (upstream validates nothing).
  None,
  /// A `() => true` stub.
  True,
  /// The default validator with the field properties it reads (`{ ...field, ...options }`).
  Default(Validator, JsVal),
}

/// `field.label` for `getTranslatedLabel`.
#[derive(Clone, Debug)]
pub enum Label {
  Absent,
  False,
  Str(String),
  Map(JsVal),
  /// A function label: an error on the field bails.
  Function,
}

#[derive(Clone, Debug)]
pub enum RelationTo {
  None,
  One(String),
  Many(Vec<String>),
}

/// A lexical node validation of richtext-lexical's own features.
#[derive(Clone, Debug)]
pub enum NodeValidation {
  /// `headingValidation({ enabledHeadingSizes })`: the allowed tags, in order.
  Heading(Vec<String>),
  List,
  ListItem,
}

/// A lexical editor whose features add no hooks (writePlan.ts `lexicalPlan`).
#[derive(Debug)]
pub struct Lexical {
  /// The editor hooks do their node bookkeeping (`req.context.internal.richText`).
  pub maps: bool,
  /// Node types whose validations are all ported.
  pub node_validations: HashMap<String, Vec<NodeValidation>>,
  /// Other node types with validations (a document holding one bails).
  pub validated: Vec<String>,
}

#[derive(Debug)]
pub struct Field {
  pub kind: Kind,
  pub name: Option<String>,
  pub required: bool,
  pub has_many: bool,
  pub relation_to: RelationTo,
  pub default: DefaultValue,
  pub before_validate: Vec<OwnHook>,
  pub before_change: Vec<OwnHook>,
  /// `field.access.create` / `.update` is set (a function): only runs without `overrideAccess`.
  pub access: bool,
  pub validate: Validate,
  pub label: Label,
  pub fields: Vec<Field>,
  pub tabs: Vec<Tab>,
  pub lexical: Option<Lexical>,
}

#[derive(Debug)]
pub struct Tab {
  pub label: Label,
  pub fields: Vec<Field>,
}

impl Field {
  /// payload's `fieldAffectsData`.
  pub fn affects_data(&self) -> bool {
    self.name.is_some() && !matches!(self.kind, Kind::Row | Kind::Collapsible | Kind::Tabs)
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Instance {
  String,
  Number,
  Boolean,
  Date,
  ObjectId,
  Mixed,
  Array,
  Embedded,
}

#[derive(Clone, Debug)]
pub enum PathDefault {
  None,
  Static(JsVal),
  /// mongoose's array default (`[].concat(default)`), run before setters.
  Array(JsVal),
  /// `_id`'s `auto` ObjectId default, run after setters.
  Auto,
}

#[derive(Debug)]
pub struct Path {
  pub instance: Instance,
  pub default: PathDefault,
  pub enum_values: Option<Vec<JsVal>>,
  /// Document arrays and single nested subdocuments.
  pub sub: Option<Box<Schema>>,
  pub doc_array: bool,
  /// The element of a primitive array.
  pub element: Option<Box<Path>>,
}

#[derive(Debug)]
pub struct Schema {
  pub tree: Vec<String>,
  pub paths: IndexMap<String, Path>,
  pub nested: Vec<String>,
  pub version_key: Option<String>,
  pub minimize: bool,
}

#[derive(Debug)]
pub struct Versions {
  pub max: f64,
  pub fields: Vec<Field>,
  pub schema: Schema,
}

#[derive(Debug)]
pub struct WritePlan {
  pub slug: String,
  pub timestamps: bool,
  pub allow_additional_keys: bool,
  pub allow_id_on_create: bool,
  pub fields: Vec<Field>,
  /// `{ [slug]: customIDType }` of the collections relationship fields reach.
  pub relations: HashMap<String, Option<String>>,
  pub schema: Schema,
  pub versions: Option<Versions>,
  /// `req.payload.config` as the validators read it (`defaultMaxTextLength`).
  pub validate_config: JsVal,
  /// `req.payload.collections` as the validators read it (`{ [slug]: { config, customIDType } }`).
  pub validate_collections: JsVal,
  /// `req.payload.db.defaultIDType`.
  pub default_id_type: JsVal,
}

fn bad(what: &str) -> String {
  format!("writePlan:{what}")
}

pub fn decode(text: &str) -> Result<WritePlan, String> {
  let json: Json = serde_json::from_str(text).map_err(|e| bad(&e.to_string()))?;
  if json.get("v").and_then(Json::as_u64) != Some(1) {
    return Err(bad("version"));
  }
  let flag = |key: &str| json.get(key).and_then(Json::as_bool).unwrap_or(false);
  let slug = json.get("slug").and_then(Json::as_str).ok_or_else(|| bad("slug"))?.to_string();
  let fields = decode_fields(json.get("fields"))?;
  let mut relations = HashMap::new();
  let mut collections = JsObj::new();
  if let Some(Json::Object(map)) = json.get("relations") {
    for (related, entry) in map {
      let custom = entry.get("customIDType").and_then(Json::as_str).map(str::to_string);
      collections.insert(related.clone(), collection_entry(related, custom.as_deref()));
      relations.insert(related.clone(), custom);
    }
  }
  if !collections.contains_key(&slug) {
    collections.insert(slug.clone(), collection_entry(&slug, None));
  }
  let mut config = JsObj::new();
  if let Some(n) = json.get("defaultMaxTextLength").and_then(Json::as_f64) {
    config.insert("defaultMaxTextLength".to_string(), JsVal::Num(n));
  }
  let versions = match json.get("versions") {
    None | Some(Json::Null) => None,
    Some(v) => Some(Versions {
      max: v.get("max").and_then(Json::as_f64).ok_or_else(|| bad("versions.max"))?,
      fields: decode_fields(v.get("fields"))?,
      schema: decode_schema(v.get("schema").ok_or_else(|| bad("versions.schema"))?)?,
    }),
  };
  Ok(WritePlan {
    allow_additional_keys: flag("allowAdditionalKeys"),
    allow_id_on_create: flag("allowIDOnCreate"),
    default_id_type: json.get("defaultIDType").map(JsVal::from_json).unwrap_or_default(),
    fields,
    relations,
    schema: decode_schema(json.get("schema").ok_or_else(|| bad("schema"))?)?,
    slug,
    timestamps: flag("timestamps"),
    validate_collections: JsVal::obj(collections),
    validate_config: JsVal::obj(config),
    versions,
  })
}

/// `req.payload.collections[slug]` as the validators read it: `config.auth` (`email`) and
/// `customIDType` (`relationship`). Auth collections are not eligible, so `auth` is `false`.
fn collection_entry(slug: &str, custom_id_type: Option<&str>) -> JsVal {
  let mut config = JsObj::new();
  config.insert("auth".to_string(), JsVal::Bool(false));
  config.insert("slug".to_string(), JsVal::str(slug));
  let mut entry = JsObj::new();
  entry.insert("config".to_string(), JsVal::obj(config));
  entry.insert("customIDType".to_string(), custom_id_type.map(JsVal::str).unwrap_or_default());
  JsVal::obj(entry)
}

fn decode_label(json: Option<&Json>) -> Label {
  match json {
    None => Label::Absent,
    Some(Json::Bool(false)) => Label::False,
    Some(Json::String(s)) => Label::Str(s.clone()),
    Some(map @ Json::Object(_)) => Label::Map(JsVal::from_json(map)),
    Some(_) => Label::Function,
  }
}

fn decode_fields(json: Option<&Json>) -> Result<Vec<Field>, String> {
  let Some(Json::Array(items)) = json else {
    return Err(bad("fields"));
  };
  items.iter().map(decode_field).collect()
}

fn decode_hooks(json: Option<&Json>) -> Result<Vec<OwnHook>, String> {
  match json {
    None => Ok(Vec::new()),
    Some(Json::Array(items)) => {
      items.iter().map(|item| item.as_str().and_then(OwnHook::parse).ok_or_else(|| bad("hook"))).collect()
    }
    Some(_) => Err(bad("hooks")),
  }
}

fn decode_field(json: &Json) -> Result<Field, String> {
  let kind = json.get("t").and_then(Json::as_str).and_then(Kind::parse).ok_or_else(|| bad("field.t"))?;
  let flag = |key: &str| json.get(key).is_some_and(|v| v.as_u64() == Some(1) || v.as_bool() == Some(true));
  let default = if flag("rowId") {
    DefaultValue::RowId
  } else {
    match json.get("d") {
      Some(value) => DefaultValue::Static(JsVal::from_json(value)),
      None => DefaultValue::None,
    }
  };
  let validate = match json.get("val") {
    None => Validate::None,
    Some(Json::Bool(true)) => Validate::True,
    Some(Json::String(name)) => {
      let validator = Validator::from_name(name).ok_or_else(|| bad("field.val"))?;
      Validate::Default(validator, json.get("vo").map(JsVal::from_json).unwrap_or_else(|| JsVal::obj(JsObj::new())))
    }
    Some(_) => return Err(bad("field.val")),
  };
  let relation_to = match json.get("r") {
    None => RelationTo::None,
    Some(Json::String(s)) => RelationTo::One(s.clone()),
    Some(Json::Array(items)) => {
      RelationTo::Many(items.iter().map(|s| s.as_str().map(str::to_string).ok_or_else(|| bad("field.r"))).collect::<Result<_, _>>()?)
    }
    Some(_) => return Err(bad("field.r")),
  };
  let hooks = json.get("hooks");
  let fields = match json.get("f") {
    Some(f) => decode_fields(Some(f))?,
    None => Vec::new(),
  };
  let tabs = match json.get("tabs") {
    Some(Json::Array(tabs)) => tabs
      .iter()
      .map(|tab| Ok(Tab { fields: decode_fields(tab.get("f"))?, label: decode_label(tab.get("label")) }))
      .collect::<Result<_, String>>()?,
    Some(_) => return Err(bad("field.tabs")),
    None => Vec::new(),
  };
  let lexical = match json.get("lx") {
    Some(lx) => Some(Lexical {
      maps: lx.get("maps").and_then(Json::as_bool).ok_or_else(|| bad("field.lx"))?,
      node_validations: match lx.get("nodeValidations") {
        Some(Json::Object(map)) => map
          .iter()
          .map(|(node_type, list)| {
            let Json::Array(items) = list else { return Err(bad("field.lx")) };
            let validations = items
              .iter()
              .map(|item| match item.get("validation").and_then(Json::as_str) {
                Some("heading") => match item.get("allowed") {
                  Some(Json::Array(tags)) => Ok(NodeValidation::Heading(
                    tags.iter().map(|t| t.as_str().map(str::to_string).ok_or_else(|| bad("field.lx"))).collect::<Result<_, _>>()?,
                  )),
                  _ => Err(bad("field.lx")),
                },
                Some("list") => Ok(NodeValidation::List),
                Some("listItem") => Ok(NodeValidation::ListItem),
                _ => Err(bad("field.lx")),
              })
              .collect::<Result<_, _>>()?;
            Ok((node_type.clone(), validations))
          })
          .collect::<Result<_, String>>()?,
        _ => return Err(bad("field.lx")),
      },
      validated: match lx.get("validated") {
        Some(Json::Array(items)) => items.iter().map(|s| s.as_str().map(str::to_string).ok_or_else(|| bad("field.lx"))).collect::<Result<_, _>>()?,
        _ => return Err(bad("field.lx")),
      },
    }),
    None if kind == Kind::RichText => return Err(bad("field.lx")),
    None => None,
  };
  Ok(Field {
    access: flag("access"),
    before_change: decode_hooks(hooks.and_then(|h| h.get("beforeChange")))?,
    before_validate: decode_hooks(hooks.and_then(|h| h.get("beforeValidate")))?,
    default,
    fields,
    has_many: flag("m"),
    kind,
    label: decode_label(json.get("label")),
    lexical,
    name: json.get("n").and_then(Json::as_str).map(str::to_string),
    relation_to,
    required: flag("req"),
    tabs,
    validate,
  })
}

fn decode_schema(json: &Json) -> Result<Schema, String> {
  let strings = |key: &str| -> Result<Vec<String>, String> {
    match json.get(key) {
      Some(Json::Array(items)) => items.iter().map(|s| s.as_str().map(str::to_string).ok_or_else(|| bad(key))).collect(),
      _ => Err(bad(key)),
    }
  };
  let Some(Json::Array(items)) = json.get("paths") else {
    return Err(bad("schema.paths"));
  };
  let mut paths = IndexMap::new();
  for item in items {
    let name = item.get("p").and_then(Json::as_str).ok_or_else(|| bad("path.p"))?;
    paths.insert(name.to_string(), decode_path(item)?);
  }
  Ok(Schema {
    minimize: json.get("minimize").and_then(Json::as_bool).unwrap_or(true),
    nested: strings("nested")?,
    paths,
    tree: strings("tree")?,
    version_key: json.get("versionKey").and_then(Json::as_str).map(str::to_string),
  })
}

fn decode_path(json: &Json) -> Result<Path, String> {
  let instance = match json.get("i").and_then(Json::as_str) {
    Some("String") => Instance::String,
    Some("Number") => Instance::Number,
    Some("Boolean") => Instance::Boolean,
    Some("Date") => Instance::Date,
    Some("ObjectId") => Instance::ObjectId,
    Some("Mixed") => Instance::Mixed,
    Some("Array") => Instance::Array,
    Some("Embedded") => Instance::Embedded,
    _ => return Err(bad("path.i")),
  };
  let default = match json.get("d") {
    None => PathDefault::None,
    Some(Json::String(s)) if s == "auto" => PathDefault::Auto,
    Some(d) => match (d.get("s"), d.get("arr")) {
      (Some(s), None) => PathDefault::Static(JsVal::from_json(s)),
      (None, Some(a)) => PathDefault::Array(JsVal::from_json(a)),
      _ => return Err(bad("path.d")),
    },
  };
  let enum_values = match json.get("enum") {
    Some(Json::Array(items)) => Some(items.iter().map(JsVal::from_json).collect()),
    _ => None,
  };
  let sub = match json.get("sub") {
    Some(sub) => Some(Box::new(decode_schema(sub)?)),
    None => None,
  };
  let element = match json.get("el") {
    Some(el) => Some(Box::new(decode_path(el)?)),
    None => None,
  };
  Ok(Path {
    doc_array: json.get("k").and_then(Json::as_str) == Some("docArray"),
    default,
    element,
    enum_values,
    instance,
    sub,
  })
}

fn registry() -> &'static Mutex<Vec<Arc<WritePlan>>> {
  static REGISTRY: OnceLock<Mutex<Vec<Arc<WritePlan>>>> = OnceLock::new();
  REGISTRY.get_or_init(|| Mutex::new(Vec::new()))
}

/// Registers a write plan (its JSON text), returns its id.
pub fn register_write_plan(json: &str) -> Result<u32, String> {
  let plan = decode(json)?;
  let mut plans = registry().lock().unwrap_or_else(|e| e.into_inner());
  plans.push(Arc::new(plan));
  Ok((plans.len() - 1) as u32)
}

pub fn write_plan(id: u32) -> Option<Arc<WritePlan>> {
  registry().lock().unwrap_or_else(|e| e.into_inner()).get(id as usize).cloned()
}
