//! Payload config lookups and small Payload utilities the drizzle operations call
//! (`payload.collections[slug].config`, `payload.globals.config.find(...)`,
//! `buildVersionCollectionFields` / `buildVersionGlobalFields`, `getFieldByPath`).

use payload_engine::error::{EngineError, Result};
use payload_engine::fields::{has_autosave_enabled, has_drafts_enabled};
use payload_engine::js::{JsVal, Obj};
use payload_engine::strings::to_snake_case;

fn type_error(message: impl Into<String>) -> EngineError {
  EngineError::new("TypeError", message)
}

fn reading(of: &JsVal, key: &str) -> EngineError {
  type_error(format!("Cannot read properties of {} (reading '{key}')", if of.is_null() { "null" } else { "undefined" }))
}

/// `this.payload.collections[slug].config`
pub fn collection_config<'g>(root: &'g JsVal, slug: &str) -> Result<&'g JsVal> {
  let entry = root.get("collections").get(slug);
  if entry.is_nullish() {
    return Err(reading(entry, "config"));
  }
  Ok(entry.get("config"))
}

/// `this.payload.globals.config.find((config) => config.slug === slug)`, followed by a read of
/// `globalConfig.slug` (a `TypeError` when no global matches).
pub fn global_config<'g>(root: &'g JsVal, slug: &str) -> Result<&'g JsVal> {
  root
    .get("config")
    .get("globals")
    .items()
    .find(|g| g.get("slug").as_str() == Some(slug))
    .ok_or_else(|| reading(&JsVal::Undefined, "slug"))
}

/// `slug` of an entity config as `toSnakeCase` input.
pub fn snake_slug(entity: &JsVal) -> Result<String> {
  match entity.get("slug") {
    JsVal::Str(s) => Ok(to_snake_case(s)),
    // to-snake-case calls `.toLowerCase()` on non-strings through to-no-case
    other => Err(reading(other, "toLowerCase")),
  }
}

/// `buildVersionCollectionFields(config, collection, true)`
pub fn version_collection_fields(config: &JsVal, collection: &JsVal) -> JsVal {
  payload_sql_find::utils::build_version_collection_fields(config, collection)
}

fn obj(entries: Vec<(&str, JsVal)>) -> JsVal {
  JsVal::obj(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect::<Obj>())
}

/// `buildVersionGlobalFields(config, global, true)` (payload/src/versions/buildGlobalFields.ts)
pub fn version_global_fields(config: &JsVal, global: &JsVal) -> JsVal {
  let admin_disabled = || obj(vec![("disabled", JsVal::Bool(true))]);
  let mut fields = vec![
    obj(vec![
      ("name", JsVal::str("version")),
      ("type", JsVal::str("group")),
      ("fields", global.get("fields").clone()),
      ("flattenedFields", global.get("flattenedFields").clone()),
    ]),
    obj(vec![
      ("name", JsVal::str("createdAt")),
      ("type", JsVal::str("date")),
      ("admin", admin_disabled()),
      ("index", JsVal::Bool(true)),
    ]),
    obj(vec![
      ("name", JsVal::str("updatedAt")),
      ("type", JsVal::str("date")),
      ("admin", admin_disabled()),
      ("index", JsVal::Bool(true)),
    ]),
  ];
  if has_drafts_enabled(global) {
    let localization = config.get("localization");
    if localization.truthy() {
      let options = localization
        .get("locales")
        .items()
        .map(|l| if let Some(s) = l.as_str() { JsVal::str(s) } else { l.get("code").clone() })
        .collect();
      fields.push(obj(vec![
        ("name", JsVal::str("publishedLocale")),
        ("type", JsVal::str("select")),
        ("admin", admin_disabled()),
        ("index", JsVal::Bool(true)),
        ("options", JsVal::arr(options)),
      ]));
    }
    fields.push(obj(vec![
      ("name", JsVal::str("latest")),
      ("type", JsVal::str("checkbox")),
      ("admin", admin_disabled()),
      ("index", JsVal::Bool(true)),
    ]));
    if has_autosave_enabled(global) {
      fields.push(obj(vec![("name", JsVal::str("autosave")), ("type", JsVal::str("checkbox")), ("index", JsVal::Bool(true))]));
    }
  }
  JsVal::arr(fields)
}

/// `getFieldByPath({ config, fields, includeRelationships: true, path })?.field`
/// (payload/src/utilities/getFieldByPath.ts).
pub fn field_by_path(config: &JsVal, fields: &JsVal, path: &str) -> Option<JsVal> {
  let mut current_fields = fields.clone();
  let mut current_field: Option<JsVal> = None;
  let mut segments: std::collections::VecDeque<&str> = path.split('.').collect();

  while let Some(segment) = segments.pop_front() {
    let field = current_fields.items().find(|f| f.get("name").as_str() == Some(segment))?.clone();

    if field.has("flattenedFields") {
      current_fields = field.get("flattenedFields").clone();
    }

    let field_type = field.get("type").as_str();
    if matches!(field_type, Some("relationship" | "upload")) && !matches!(field.get("relationTo"), JsVal::Arr(_)) {
      let relation_to = field.get("relationTo");
      let target = config.get("collections").items().find(|c| c.get("slug").strict_eq(relation_to));
      if let Some(flattened) = target.map(|c| c.get("flattenedFields")).filter(|f| f.truthy()) {
        current_fields = flattened.clone();
      }
      if segments.len() == 1 && segments[0] == "id" {
        return Some(field);
      }
    }

    if field.has("blocks") && !segments.is_empty() {
      let block_slug = segments[0];
      let block = config
        .get("blocks")
        .items()
        .find(|b| b.get("slug").as_str() == Some(block_slug))
        .or_else(|| {
          field.get("blocks").items().find(|b| !matches!(b, JsVal::Str(_)) && b.get("slug").as_str() == Some(block_slug))
        })
        .cloned();
      if let Some(block) = block {
        segments.pop_front();
        if segments.is_empty() {
          return None;
        }
        let rest: Vec<&str> = segments.into_iter().collect();
        return field_by_path(config, block.get("flattenedFields"), &rest.join("."));
      }
    }

    current_field = Some(field);
  }
  current_field
}
