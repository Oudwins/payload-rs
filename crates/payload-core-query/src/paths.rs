//! `utilities/getFieldByPath.ts` and `database/getLocalizedPaths.ts`.

use payload_engine::fields::field_should_be_localized;
use payload_engine::js::{JsVal, Obj};
use payload_sql_read::Val;

use crate::config::QueryConfig;
use crate::js::{JsError, JsResult, is_safe_field_path};

/// `value[key]` on a config value, throwing like V8 for nullish receivers.
pub fn cfg_get<'a>(v: &'a JsVal, key: &str) -> JsResult<&'a JsVal> {
  match v {
    JsVal::Undefined | JsVal::Null => Err(JsError::type_error(format!(
      "Cannot read properties of {} (reading '{key}')",
      v.to_js_string()
    ))),
    JsVal::Arr(a) => Ok(key.parse::<usize>().ok().and_then(|i| a.get(i)).unwrap_or(&JsVal::Undefined)),
    other => Ok(other.get(key)),
  }
}

/// `fields.find((each) => each.name === name)`
pub fn find_field(fields: &JsVal, name: &str) -> JsResult<Option<JsVal>> {
  let items = match fields {
    JsVal::Arr(a) => a,
    JsVal::Undefined | JsVal::Null => {
      return Err(JsError::type_error(format!(
        "Cannot read properties of {} (reading 'find')",
        fields.to_js_string()
      )));
    }
    _ => return Err(JsError::type_error("fields.find is not a function")),
  };
  for each in items.iter() {
    if cfg_get(each, "name")?.as_str() == Some(name) {
      return Ok(Some(each.clone()));
    }
  }
  Ok(None)
}

fn synthetic_field(entries: Vec<(&str, JsVal)>) -> JsVal {
  let mut o = Obj::new();
  for (k, v) in entries {
    o.insert(k.to_string(), v);
  }
  JsVal::obj(o)
}

fn is_relationship_or_upload(field: &JsVal) -> bool {
  matches!(field.get("type").as_str(), Some("relationship" | "upload"))
}

#[derive(Clone, Debug)]
pub struct FieldByPath {
  pub field: JsVal,
  pub localized_path: String,
  pub path_has_localized: bool,
}

/// `getFieldByPath({ config, fields, includeRelationships, localizedPath, path })`
pub fn get_field_by_path(
  config: Option<&JsVal>,
  fields: &JsVal,
  include_relationships: bool,
  localized_path: &str,
  path: &str,
) -> JsResult<Option<FieldByPath>> {
  let mut current_fields = fields.clone();
  let mut current_field: Option<JsVal> = None;
  let mut segments: std::collections::VecDeque<String> = path.split('.').map(str::to_string).collect();
  let mut localized_path = localized_path.to_string();
  let mut path_has_localized = false;

  while let Some(segment) = segments.pop_front() {
    localized_path = if localized_path.is_empty() { segment.clone() } else { format!("{localized_path}.{segment}") };
    let Some(field) = find_field(&current_fields, &segment)? else {
      return Ok(None);
    };

    if field.get("localized").truthy() {
      path_has_localized = true;
      localized_path = format!("{localized_path}.<locale>");
    }

    if field.has("flattenedFields") {
      current_fields = field.get("flattenedFields").clone();
    }

    if let Some(config) = config
      && include_relationships
      && is_relationship_or_upload(&field)
      && !matches!(field.get("relationTo"), JsVal::Arr(_))
    {
      let relation_to = field.get("relationTo");
      let collections = cfg_get(config, "collections")?;
      let found = collections.items().find(|e| e.get("slug").strict_eq(relation_to));
      if let Some(flattened) = found.map(|c| c.get("flattenedFields")).filter(|f| f.truthy()) {
        current_fields = flattened.clone();
      }
      if segments.len() == 1 && segments[0] == "id" {
        return Ok(Some(FieldByPath { field, localized_path, path_has_localized }));
      }
    }

    if field.has("blocks") && !segments.is_empty() {
      let block_slug = segments[0].clone();
      let from_config = config
        .map(|c| c.get("blocks"))
        .filter(|b| !b.is_nullish())
        .and_then(|blocks| blocks.items().find(|b| b.get("slug").as_str() == Some(&block_slug)).cloned());
      let block = match from_config {
        Some(b) => Some(b),
        None => {
          let blocks = field.get("blocks");
          if blocks.is_nullish() {
            return Err(JsError::type_error(format!(
              "Cannot read properties of {} (reading 'find')",
              blocks.to_js_string()
            )));
          }
          blocks.items().find(|b| !matches!(b, JsVal::Str(_)) && b.get("slug").as_str() == Some(&block_slug)).cloned()
        }
      };

      if let Some(block) = block {
        segments.pop_front();
        localized_path = format!("{localized_path}.{block_slug}");
        if segments.is_empty() {
          return Ok(None);
        }
        let rest = segments.iter().cloned().collect::<Vec<_>>().join(".");
        return get_field_by_path(config, block.get("flattenedFields"), include_relationships, &localized_path, &rest);
      }
    }

    current_field = Some(field);
  }

  Ok(current_field.map(|field| FieldByPath { field, localized_path, path_has_localized }))
}

/// `PathToQuery`
#[derive(Clone, Debug)]
pub struct PathToQuery {
  pub collection_slug: JsVal,
  pub complete: bool,
  pub field: JsVal,
  pub fields: JsVal,
  pub global_slug: JsVal,
  pub invalid: bool,
  pub parent_is_localized: Option<bool>,
  pub path: String,
}

pub struct LocalizedPathsArgs<'a> {
  pub collection_slug: JsVal,
  pub fields: &'a JsVal,
  pub global_slug: JsVal,
  pub incoming_path: &'a str,
  /// `locale` (`req.locale`), interpolated with `String()`.
  pub locale: &'a Val,
  pub override_access: bool,
  pub parent_is_localized: Option<bool>,
  pub show_hidden_fields: bool,
}

/// `getLocalizedPaths(...)`
pub fn get_localized_paths(payload: &QueryConfig, args: LocalizedPathsArgs<'_>) -> JsResult<Vec<PathToQuery>> {
  let LocalizedPathsArgs {
    collection_slug,
    fields,
    global_slug,
    incoming_path,
    locale,
    override_access,
    parent_is_localized,
    show_hidden_fields,
  } = args;
  let path_segments: Vec<&str> = incoming_path.split('.').collect();
  let localization_config = payload.localization();

  let mut paths = vec![PathToQuery {
    collection_slug,
    complete: false,
    field: JsVal::Undefined,
    fields: fields.clone(),
    global_slug: global_slug.clone(),
    invalid: false,
    parent_is_localized,
    path: String::new(),
  }];

  let mut i = 0usize;
  while i < path_segments.len() {
    let segment = path_segments[i];

    if let Some(idx) = paths.iter().position(|p| !p.complete) {
      let last_path = paths[idx].path.clone();
      let mut current_path = if last_path.is_empty() { segment.to_string() } else { format!("{last_path}.{segment}") };
      let mut parent_localized = parent_is_localized == Some(true);
      let mut matched_field = JsVal::Undefined;

      let last_field = paths[idx].field.clone();
      if last_field.get("type").as_str() == Some("blocks") {
        if segment == "blockType" {
          matched_field = synthetic_field(vec![("name", JsVal::str("blockType")), ("type", JsVal::str("text"))]);
        } else {
          for block_ref in cfg_get(&last_field, "blocks")?.items() {
            let block = match block_ref {
              JsVal::Str(slug) => payload.blocks.get(&**slug).cloned().unwrap_or(JsVal::Undefined),
              other => other.clone(),
            };
            matched_field = find_field(cfg_get(&block, "flattenedFields")?, segment)?.unwrap_or(JsVal::Undefined);
            if matched_field.truthy() {
              break;
            }
          }
        }
      } else {
        let fields_to_search = if last_field.is_object_like() && !last_field.is_null() && last_field.has("flattenedFields") {
          last_field.get("flattenedFields").clone()
        } else {
          paths[idx].fields.clone()
        };
        parent_localized = parent_localized || last_field.get("localized").truthy();
        matched_field = find_field(&fields_to_search, segment)?.unwrap_or(JsVal::Undefined);
      }

      paths[idx].field = matched_field.clone();

      if current_path == "globalType" && global_slug.truthy() {
        let p = &mut paths[idx];
        p.path = current_path;
        p.complete = true;
        p.field = synthetic_field(vec![("name", JsVal::str("globalType")), ("type", JsVal::str("text"))]);
        return Ok(paths);
      }

      if current_path == "relationTo" {
        let options = payload.collections.keys().map(|k| JsVal::str(k.as_str())).collect();
        let p = &mut paths[idx];
        p.path = current_path;
        p.complete = true;
        p.field = synthetic_field(vec![
          ("name", JsVal::str("relationTo")),
          ("type", JsVal::str("select")),
          ("options", JsVal::arr(options)),
        ]);
        return Ok(paths);
      }

      if !matched_field.truthy() && current_path == "id" && i == path_segments.len() - 1 {
        let p = &mut paths[idx];
        p.path = current_path;
        p.field = synthetic_field(vec![("name", JsVal::str("id")), ("type", payload.default_id_type.clone())]);
        p.complete = true;
        return Ok(paths);
      }

      if matched_field.truthy() {
        if matched_field.has("hidden") && matched_field.get("hidden").truthy() && !override_access && !show_hidden_fields {
          paths[idx].invalid = true;
        }

        let next_segment = path_segments.get(i + 1).copied();
        let current_field_is_localized = field_should_be_localized(&matched_field, parent_localized);

        let next_segment_is_locale = localization_config.truthy()
          && locale_codes_include(localization_config, next_segment)?
          && current_field_is_localized;

        if next_segment_is_locale {
          i += 1;
          current_path = format!("{current_path}.{}", next_segment.unwrap_or("undefined"));
        } else if localization_config.truthy() && current_field_is_localized {
          current_path = format!("{current_path}.{}", locale.to_js_string());
        }

        let field_type = matched_field.get("type").as_str().unwrap_or("");
        match field_type {
          "join" | "relationship" | "upload" => {
            if field_type != "join" && !matches!(matched_field.get("relationTo"), JsVal::Str(_)) {
              let p = &mut paths[idx];
              p.path = path_segments.join(".");
              let last = path_segments.last().copied().unwrap_or("");
              let name_matches = matched_field.get("name").as_str() == Some(last);
              if !(name_matches || last == "relationTo" || last == "value") {
                p.invalid = true;
              } else {
                p.complete = true;
              }
            } else {
              paths[idx].complete = true;
              paths[idx].path = current_path.clone();

              let start = if next_segment_is_locale { i + 2 } else { i + 1 };
              let nested_path_to_query = path_segments.get(start..).map(|s| s.join(".")).unwrap_or_default();

              if !nested_path_to_query.is_empty() {
                let related_collection = if field_type == "join" {
                  let collection = matched_field.get("collection");
                  if matches!(collection, JsVal::Arr(_)) {
                    return Err(JsError::api("Not supported"));
                  }
                  let related = collection_config(payload, &collection.to_js_string())?;
                  let on = matched_field.get("on");
                  let on_path = match on {
                    JsVal::Str(s) => s.to_string(),
                    JsVal::Undefined | JsVal::Null => {
                      return Err(JsError::type_error(format!(
                        "Cannot read properties of {} (reading 'split')",
                        on.to_js_string()
                      )));
                    }
                    _ => return Err(JsError::type_error("path.split is not a function")),
                  };
                  let join_on_field =
                    get_field_by_path(None, related.get("flattenedFields"), false, "", &on_path)?.map(|r| r.field);
                  if let Some(join_on_field) = join_on_field
                    && is_relationship_or_upload(&join_on_field)
                    && matches!(join_on_field.get("relationTo"), JsVal::Arr(_))
                  {
                    return Err(JsError::api("Not supported"));
                  }
                  related
                } else {
                  collection_config(payload, &matched_field.get("relationTo").to_js_string())?
                };

                let remaining = get_localized_paths(
                  payload,
                  LocalizedPathsArgs {
                    collection_slug: related_collection.get("slug").clone(),
                    fields: related_collection.get("flattenedFields"),
                    global_slug: global_slug.clone(),
                    incoming_path: &nested_path_to_query,
                    locale,
                    override_access: false,
                    parent_is_localized: Some(false),
                    show_hidden_fields,
                  },
                )?;
                paths.extend(remaining);
              }

              return Ok(paths);
            }
          }
          "json" | "richText" => {
            let upcoming_segments = path_segments.get(i + 1..).map(|s| s.join(".")).unwrap_or_default();
            if path_segments.iter().any(|s| !is_safe_field_path(s)) {
              paths[idx].invalid = true;
            }
            let p = &mut paths[idx];
            p.complete = true;
            p.path = if upcoming_segments.is_empty() { current_path } else { format!("{current_path}.{upcoming_segments}") };
            return Ok(paths);
          }
          _ => {
            if i + 1 == path_segments.len() {
              paths[idx].complete = true;
            }
            paths[idx].path = current_path;
          }
        }
      } else {
        let p = &mut paths[idx];
        p.invalid = true;
        p.path = current_path;
        return Ok(paths);
      }
    }
    i += 1;
  }

  Ok(paths)
}

/// `payload.collections[slug]!.config`
pub fn collection_config(payload: &QueryConfig, slug: &str) -> JsResult<JsVal> {
  payload
    .collection(slug)
    .cloned()
    .ok_or_else(|| JsError::type_error("Cannot read properties of undefined (reading 'config')"))
}

/// `localizationConfig.localeCodes.includes(nextSegment)`
fn locale_codes_include(localization: &JsVal, next: Option<&str>) -> JsResult<bool> {
  let codes = cfg_get(localization, "localeCodes")?;
  if codes.is_nullish() {
    return Err(JsError::type_error(format!(
      "Cannot read properties of {} (reading 'includes')",
      codes.to_js_string()
    )));
  }
  Ok(codes.items().any(|c| match next {
    Some(s) => c.as_str() == Some(s),
    None => c.is_undefined(),
  }))
}
