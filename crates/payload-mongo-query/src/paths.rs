//! payload's `getLocalizedPaths` (database/getLocalizedPaths.ts) and `getFieldByPath`
//! (utilities/getFieldByPath.ts, without `config` / `includeRelationships`, as the MongoDB adapter
//! calls it) on decoded config values. Only what the MongoDB adapter reads of a `PathToQuery` is
//! kept (`invalid` / `hidden` handling does not change its results).

use payload_engine::error::{EngineError, Result};
use payload_engine::fields::field_should_be_localized;
use payload_engine::js::JsVal;

use crate::QueryCx;
use crate::js::{JsObj, get, template, type_error};

/// `PathToQuery` (the parts the adapter reads).
#[derive(Clone, Debug)]
pub struct PathToQuery {
  pub collection_slug: Option<String>,
  pub complete: bool,
  /// The matched field (`undefined` when no field matched).
  pub field: JsVal,
  pub fields: JsVal,
  pub path: String,
}

/// `fields.find((field) => field.name === name)`, `TypeError` when `fields` is not an array.
pub fn find_field(fields: &JsVal, name: &str) -> Result<JsVal> {
  match fields {
    JsVal::Arr(a) => {
      for each in a.iter() {
        if get(each, "name")?.as_str() == Some(name) {
          return Ok(each.clone());
        }
      }
      Ok(JsVal::Undefined)
    }
    JsVal::Undefined | JsVal::Null => {
      Err(type_error(format!("Cannot read properties of {} (reading 'find')", fields.to_js_string())))
    }
    _ => Err(type_error("fields.find is not a function")),
  }
}

fn synthetic_field(name: &str, ty: JsVal) -> JsVal {
  JsObj::new().with("name", JsVal::str(name)).with("type", ty).into_val()
}

pub struct LocalizedPathsArgs<'a> {
  pub collection_slug: Option<&'a str>,
  pub fields: &'a JsVal,
  pub global_slug: Option<&'a str>,
  pub incoming_path: &'a str,
  pub locale: &'a JsVal,
  pub parent_is_localized: bool,
}

/// `getLocalizedPaths`
pub fn get_localized_paths(cx: &QueryCx, args: &LocalizedPathsArgs) -> Result<Vec<PathToQuery>> {
  // (recurses once per relationship hop of the path)
  let _depth = cx.enter()?;
  let path_segments: Vec<&str> = args.incoming_path.split('.').collect();
  let localization = cx.localization().clone();

  let mut paths = vec![PathToQuery {
    collection_slug: args.collection_slug.map(str::to_owned),
    complete: false,
    field: JsVal::Undefined,
    fields: args.fields.clone(),
    path: String::new(),
  }];

  let mut i = 0;
  while i < path_segments.len() {
    let segment = path_segments[i];
    // `paths.find(({ complete }) => !complete)`: the first entry until a return
    let Some(last) = paths.iter_mut().find(|p| !p.complete) else {
      i += 1;
      continue;
    };
    let mut current_path = if last.path.is_empty() { segment.to_owned() } else { format!("{}.{segment}", last.path) };

    let mut parent_is_localized = args.parent_is_localized;
    let matched_field;

    if !last.field.is_nullish() && get(&last.field, "type")?.as_str() == Some("blocks") {
      if segment == "blockType" {
        matched_field = synthetic_field("blockType", JsVal::str("text"));
      } else {
        let mut found = JsVal::Undefined;
        for block in get(&last.field, "blocks")?.items() {
          let block = match block {
            JsVal::Str(slug) => cx.env.blocks.get(slug).clone(),
            other => other.clone(),
          };
          found = find_field(&get(&block, "flattenedFields")?, segment)?;
          if found.truthy() {
            break;
          }
        }
        matched_field = found;
      }
    } else {
      let fields_to_search = if last.field.truthy() && last.field.has("flattenedFields") {
        last.field.get("flattenedFields").clone()
      } else {
        last.fields.clone()
      };
      parent_is_localized =
        args.parent_is_localized || (!last.field.is_nullish() && last.field.get("localized").truthy());
      matched_field = find_field(&fields_to_search, segment)?;
    }

    last.field = matched_field.clone();

    if current_path == "globalType" && args.global_slug.is_some_and(|s| !s.is_empty()) {
      last.path = current_path;
      last.complete = true;
      last.field = synthetic_field("globalType", JsVal::str("text"));
      return Ok(paths);
    }

    if current_path == "relationTo" {
      last.path = current_path;
      last.complete = true;
      let options = cx.env.collections.as_obj().map(|o| o.keys().map(|k| JsVal::str(k.as_str())).collect()).unwrap_or_default();
      last.field = JsObj::new()
        .with("name", JsVal::str("relationTo"))
        .with("type", JsVal::str("select"))
        .with("options", JsVal::arr(options))
        .into_val();
      return Ok(paths);
    }

    if !matched_field.truthy() && current_path == "id" && i == path_segments.len() - 1 {
      last.path = current_path;
      last.field = synthetic_field("id", cx.env.default_id_type.clone());
      last.complete = true;
      return Ok(paths);
    }

    if !matched_field.truthy() {
      last.path = current_path;
      return Ok(paths);
    }

    let next_segment = path_segments.get(i + 1).copied();
    let current_field_is_localized = field_should_be_localized(&matched_field, parent_is_localized);
    let next_segment_is_locale = localization.truthy()
      && next_segment.is_some_and(|s| get(&localization, "localeCodes").is_ok_and(|codes| codes.items().any(|c| c.as_str() == Some(s))))
      && current_field_is_localized;

    if next_segment_is_locale {
      i += 1;
      current_path = format!("{current_path}.{}", next_segment.unwrap_or_default());
    } else if localization.truthy() && current_field_is_localized {
      current_path = format!("{current_path}.{}", template(args.locale));
    }

    let field_type = get(&matched_field, "type")?;
    match field_type.as_str().unwrap_or("") {
      ty @ ("join" | "relationship" | "upload") => {
        if ty != "join" && get(&matched_field, "relationTo")?.as_str().is_none() {
          last.path = path_segments.join(".");
          let tail = path_segments.last().copied().unwrap_or_default();
          let name = get(&matched_field, "name")?;
          if name.as_str() == Some(tail) || tail == "relationTo" || tail == "value" {
            last.complete = true;
          }
        } else {
          last.complete = true;
          last.path = current_path;

          let start = if next_segment_is_locale { i + 2 } else { i + 1 };
          let nested_path_to_query = path_segments.get(start..).map(|s| s.join(".")).unwrap_or_default();

          if !nested_path_to_query.is_empty() {
            let related_collection;
            if ty == "join" {
              let collection = get(&matched_field, "collection")?;
              if matches!(collection, JsVal::Arr(_)) {
                return Err(EngineError::api("Not supported"));
              }
              related_collection = get(cx.env.collections.get(&template(&collection)), "config")?;
              let join_on_field = get_field_by_path(&get(&related_collection, "flattenedFields")?, &get(&matched_field, "on")?)?
                .map(|f| f.field);
              if let Some(join_on_field) = join_on_field {
                let join_on_type = get(&join_on_field, "type")?;
                if matches!(join_on_type.as_str(), Some("relationship" | "upload"))
                  && matches!(get(&join_on_field, "relationTo")?, JsVal::Arr(_))
                {
                  return Err(EngineError::api("Not supported"));
                }
              }
            } else {
              let relation_to = get(&matched_field, "relationTo")?;
              related_collection = get(cx.env.collections.get(&template(&relation_to)), "config")?;
            }

            let slug = get(&related_collection, "slug")?;
            let related_fields = get(&related_collection, "flattenedFields")?;
            let slug_text = slug.as_str().map(str::to_owned);
            let remaining = get_localized_paths(
              cx,
              &LocalizedPathsArgs {
                collection_slug: slug_text.as_deref(),
                fields: &related_fields,
                global_slug: args.global_slug,
                incoming_path: &nested_path_to_query,
                locale: args.locale,
                parent_is_localized: false,
              },
            )?;
            paths.extend(remaining);
          }
          return Ok(paths);
        }
      }
      "json" | "richText" => {
        let upcoming = path_segments.get(i + 1..).map(|s| s.join(".")).unwrap_or_default();
        last.complete = true;
        last.path = if upcoming.is_empty() { current_path } else { format!("{current_path}.{upcoming}") };
        return Ok(paths);
      }
      _ => {
        if i + 1 == path_segments.len() {
          last.complete = true;
        }
        last.path = current_path;
      }
    }
    i += 1;
  }

  Ok(paths)
}

/// The result of `getFieldByPath`.
#[derive(Clone, Debug)]
pub struct FieldByPath {
  pub field: JsVal,
  pub localized_path: String,
  pub path_has_localized: bool,
}

/// `getFieldByPath({ fields, path })` (`path` may be any value: `path.split` throws like JS).
pub fn get_field_by_path(fields: &JsVal, path: &JsVal) -> Result<Option<FieldByPath>> {
  let path = match path {
    JsVal::Str(s) => s.to_string(),
    JsVal::Undefined | JsVal::Null => {
      return Err(type_error(format!("Cannot read properties of {} (reading 'split')", path.to_js_string())));
    }
    _ => return Err(type_error("path.split is not a function")),
  };
  field_by_path(fields, &path, String::new())
}

fn field_by_path(fields: &JsVal, path: &str, mut localized_path: String) -> Result<Option<FieldByPath>> {
  let mut current_fields = fields.clone();
  let mut current_field: Option<JsVal> = None;
  let mut segments: std::collections::VecDeque<&str> = path.split('.').collect();
  let mut path_has_localized = false;

  while let Some(segment) = segments.pop_front() {
    localized_path = if localized_path.is_empty() { segment.to_owned() } else { format!("{localized_path}.{segment}") };
    let field = find_field(&current_fields, segment)?;
    if !field.truthy() {
      return Ok(None);
    }
    if get(&field, "localized")?.truthy() {
      path_has_localized = true;
      localized_path = format!("{localized_path}.<locale>");
    }
    if field.has("flattenedFields") {
      current_fields = field.get("flattenedFields").clone();
    }
    if field.has("blocks")
      && let Some(block_slug) = segments.front().copied()
    {
      let blocks = get(&field, "blocks")?;
      let block = match &blocks {
        JsVal::Arr(a) => {
          let mut found = None;
          for b in a.iter() {
            if b.as_str().is_none() && get(b, "slug")?.as_str() == Some(block_slug) {
              found = Some(b.clone());
              break;
            }
          }
          found
        }
        JsVal::Undefined | JsVal::Null => {
          return Err(type_error(format!("Cannot read properties of {} (reading 'find')", blocks.to_js_string())));
        }
        _ => return Err(type_error("field.blocks.find is not a function")),
      };
      if let Some(block) = block {
        segments.pop_front();
        localized_path = format!("{localized_path}.{block_slug}");
        if segments.is_empty() {
          return Ok(None);
        }
        let rest = segments.iter().copied().collect::<Vec<_>>().join(".");
        return field_by_path(&get(&block, "flattenedFields")?, &rest, localized_path);
      }
    }
    current_field = Some(field);
  }

  Ok(current_field.map(|field| FieldByPath { field, localized_path, path_has_localized }))
}
