//! `buildSortParam` (with `relationshipSort`) and `getLocalizedSortProperty`.

use payload_engine::error::{EngineError, Result};
use payload_engine::fields::{field_affects_data, field_is_presentational_only, field_should_be_localized};
use payload_engine::js::JsVal;

use crate::QueryCx;
use crate::js::{JsObj, get, js_in, template, type_error};
use crate::paths::{find_field, get_field_by_path};

pub struct BuildSortArgs<'a> {
  pub fields: &'a JsVal,
  /// `locale` (`undefined` when not passed).
  pub locale: &'a JsVal,
  pub parent_is_localized: bool,
  /// `sort` as passed (`undefined`, a string, an array, ...). An array argument receives the
  /// fallback sort the TS pushes onto it (reported as a [`crate::Mutation`]).
  pub sort: &'a JsVal,
  /// `sortAggregation`: `Some` when the caller passes the array; `$lookup` stages are appended.
  pub sort_aggregation: Option<&'a mut Vec<JsVal>>,
  /// `timestamps` (truthiness).
  pub timestamps: bool,
}

/// `buildSortParam`: the mongo sort object (`{ [property]: 'asc' | 'desc' }`).
pub fn build_sort_param(cx: &QueryCx, args: BuildSortArgs) -> Result<JsVal> {
  let BuildSortArgs { fields, locale, parent_is_localized, sort, mut sort_aggregation, timestamps } = args;

  let mut sort = sort.clone();
  if !sort.truthy() {
    sort = JsVal::str(if timestamps { "-createdAt" } else { "-id" });
  }
  let argument_array = matches!(sort, JsVal::Arr(_)).then(|| sort.clone());
  if sort.as_str().is_some() {
    sort = JsVal::arr(vec![sort]);
  }
  let mut items: Vec<JsVal> = match &sort {
    JsVal::Arr(a) => a.to_vec(),
    _ => return Err(type_error("sort.some is not a function")),
  };

  // We use this flag to determine if the sort is unique or not to decide whether to add a fallback sort.
  let mut is_unique_sort = false;
  for item in &items {
    let found = get_field_by_path(fields, item)?;
    if let Some(found) = found
      && get(&found.field, "unique")?.truthy()
    {
      is_unique_sort = true;
      break;
    }
  }

  let fallback_sort = if timestamps { "-createdAt" } else { "-id" };
  let includes = |s: &str| items.iter().any(|i| i.as_str() == Some(s));
  let include_fallback_sort = !cx.env.disable_fallback_sort
    && !is_unique_sort
    && !(includes(fallback_sort) || includes(fallback_sort.replacen('-', "", 1).as_str()));

  if include_fallback_sort {
    if let Some(argument) = &argument_array {
      cx.mutated(argument, items.len().to_string(), JsVal::str(fallback_sort));
    }
    items.push(JsVal::str(fallback_sort));
  }

  let mut sorting = JsObj::new();
  for item in &items {
    let (sort_property, sort_direction) = match item {
      JsVal::Str(s) => match s.strip_prefix('-') {
        Some(rest) => (rest.to_owned(), "desc"),
        None => (s.to_string(), "asc"),
      },
      JsVal::Undefined | JsVal::Null => {
        return Err(type_error(format!("Cannot read properties of {} (reading 'indexOf')", item.to_js_string())));
      }
      JsVal::Arr(a) => {
        if a.first().is_some_and(|first| first.as_str() == Some("-")) {
          return Err(type_error("item.substring is not a function"));
        }
        return Err(if sort_aggregation.is_some() {
          type_error("path.split is not a function")
        } else {
          type_error("sortProperty.split is not a function")
        });
      }
      _ => return Err(type_error("item.indexOf is not a function")),
    };

    if sort_property == "id" {
      sorting.set("_id", JsVal::str(sort_direction));
      continue;
    }

    if let Some(sort_aggregation) = sort_aggregation.as_deref_mut() {
      let sort_rel_property = relationship_sort(cx, fields, locale, &sort_property, "", sort_aggregation)?;
      if let Some(property) = sort_rel_property {
        sorting.set(property, JsVal::str(sort_direction));
        continue;
      }
    }

    let segments: Vec<String> = sort_property.split('.').map(str::to_owned).collect();
    let localized_property = get_localized_sort_property(cx, fields, locale, parent_is_localized, None, &segments)?;
    sorting.set(localized_property, JsVal::str(sort_direction));
  }

  Ok(sorting.into_val())
}

/// `relationshipSort`
fn relationship_sort(
  cx: &QueryCx,
  fields: &JsVal,
  locale: &JsVal,
  path: &str,
  previous_field: &str,
  sort_aggregation: &mut Vec<JsVal>,
) -> Result<Option<String>> {
  let mut current_fields = fields.clone();
  let segments: Vec<&str> = path.split('.').collect();
  if segments.len() < 2 {
    return Ok(None);
  }

  for (i, segment) in segments.iter().enumerate() {
    let field = find_field(&current_fields, segment)?;
    if !field.truthy() {
      return Ok(None);
    }

    if js_in("fields", &field)? {
      current_fields = get(&field, "flattenedFields")?;
      continue;
    }

    let ty = get(&field, "type")?;
    if !(matches!(ty.as_str(), Some("relationship" | "upload")) && i != segments.len() - 1) {
      continue;
    }

    let relationship_path = segments[..=i].join(".");
    let next_path = &segments[i + 1..];
    let Some(relationship_field_result) = get_field_by_path(fields, &JsVal::str(relationship_path))? else {
      return Ok(None);
    };
    if !js_in("relationTo", &relationship_field_result.field)? {
      return Ok(None);
    }
    let relation_to = get(&relationship_field_result.field, "relationTo")?;
    let Some(relation_to) = relation_to.as_str() else { return Ok(None) };

    let collection = cx.collection(relation_to);
    if !collection.truthy() {
      return Err(EngineError::api(format!(
        "ERROR: Failed to retrieve collection with the slug \"{relation_to}\". Does not exist."
      )));
    }
    let collection_config = get(collection, "config")?;

    let mut localized_relationship_path = relationship_field_result.localized_path.clone();
    if locale.truthy() && relationship_field_result.path_has_localized {
      localized_relationship_path = localized_relationship_path.replacen("<locale>", &template(locale), 1);
    }

    if next_path.join(".") == "id" {
      return Ok(Some(format!("{previous_field}{localized_relationship_path}")));
    }

    let as_ = format!("__{previous_field}{localized_relationship_path}");
    let from = cx.host.collection_name(relation_to)?;
    let lookup = JsObj::new()
      .with("as", JsVal::str(as_.as_str()))
      .with("foreignField", JsVal::str("_id"))
      .with("from", from)
      .with("localField", JsVal::str(format!("{previous_field}{localized_relationship_path}")));
    sort_aggregation.push(JsObj::new().with("$lookup", lookup.into_val()).into_val());

    let collection_fields = get(&collection_config, "flattenedFields")?;
    if next_path.len() > 1 {
      let next_res =
        relationship_sort(cx, &collection_fields, locale, &next_path.join("."), &format!("{as_}."), sort_aggregation)?;
      if let Some(next_res) = next_res {
        return Ok(Some(next_res));
      }
      return Ok(Some(format!("{as_}.{}", next_path.join("."))));
    }

    let next_field = get_field_by_path(&collection_fields, &JsVal::str(next_path[0]))?;
    if let Some(next_field) = next_field
      && next_field.path_has_localized
      && locale.truthy()
    {
      return Ok(Some(format!("{as_}.{}", next_field.localized_path.replacen("<locale>", &template(locale), 1))));
    }

    return Ok(Some(format!("{as_}.{}", next_path[0])));
  }

  Ok(None)
}

/// `getLocalizedSortProperty` (`config` is `payload.config`).
pub fn get_localized_sort_property(
  cx: &QueryCx,
  fields: &JsVal,
  locale: &JsVal,
  parent_is_localized: bool,
  incoming_result: Option<&str>,
  incoming_segments: &[String],
) -> Result<String> {
  let config = cx.env.config;
  let localization = config.get("localization");
  // If localization is not enabled, accept exactly what is sent in
  if !localization.truthy() {
    return Ok(incoming_segments.join("."));
  }

  let mut segments: std::collections::VecDeque<String> = incoming_segments.iter().cloned().collect();
  let first_segment = segments.pop_front();

  let mut matched_field = JsVal::Undefined;
  let candidates = match fields {
    JsVal::Arr(a) => a.to_vec(),
    JsVal::Undefined | JsVal::Null => {
      return Err(type_error(format!("Cannot read properties of {} (reading 'find')", fields.to_js_string())));
    }
    _ => return Err(type_error("fields.find is not a function")),
  };
  for field in &candidates {
    if field_affects_data(field) && first_segment.as_deref().is_some_and(|s| get(field, "name").ok().and_then(|n| n.as_str().map(|n| n == s)).unwrap_or(false)) {
      matched_field = field.clone();
      break;
    }
  }

  if matched_field.truthy() && !field_is_presentational_only(&matched_field) {
    let mut next_fields: Option<JsVal> = None;
    let mut next_parent_is_localized = parent_is_localized;
    let mut remaining: std::collections::VecDeque<String> = segments.clone();
    let name = template(&get(&matched_field, "name")?);
    let mut localized_segment = name.clone();

    if field_should_be_localized(&matched_field, parent_is_localized) {
      // Check to see if next segment is a locale
      if !segments.is_empty() && remaining.front().is_some_and(|s| !s.is_empty()) {
        let next = remaining.front().cloned().unwrap_or_default();
        let next_segment_is_locale = get(localization, "localeCodes")?.items().any(|c| c.as_str() == Some(next.as_str()));
        // If next segment is locale, remove it from remaining segments
        // and use it to localize the current segment
        if next_segment_is_locale {
          remaining.pop_front();
          localized_segment = format!("{name}.{next}");
        }
      } else {
        // If no more segments, but field is localized, use default locale
        localized_segment = format!("{name}.{}", template(locale));
      }
    }

    let ty = get(&matched_field, "type")?;
    let ty = ty.as_str().unwrap_or_default();

    // If there are subfields, pass them through
    if matches!(ty, "tab" | "group" | "array") {
      next_fields = Some(get(&matched_field, "flattenedFields")?);
      if !next_parent_is_localized {
        next_parent_is_localized = get(&matched_field, "localized")?.truthy();
      }
    }

    if ty == "blocks" {
      let mut flattened = Vec::new();
      for block in get(&matched_field, "blocks")?.items() {
        let block = match block {
          JsVal::Str(slug) => {
            let mut found = JsVal::Undefined;
            for b in config.get("blocks").items() {
              if get(b, "slug")?.as_str() == Some(slug) {
                found = b.clone();
                break;
              }
            }
            found
          }
          other => other.clone(),
        };
        if !block.truthy() {
          continue;
        }
        for block_field in get(&block, "flattenedFields")?.items() {
          let keep = if field_affects_data(block_field) {
            let block_field_name = get(block_field, "name")?;
            block_field_name.as_str() != Some("blockType") && block_field_name.as_str() != Some("blockName")
          } else {
            true
          };
          if keep {
            flattened.push(block_field.clone());
          }
        }
      }
      next_fields = Some(JsVal::arr(flattened));
    }

    let result = match incoming_result {
      Some(incoming) if !incoming.is_empty() => format!("{incoming}.{localized_segment}"),
      _ => localized_segment,
    };

    if let Some(next_fields) = next_fields {
      let remaining: Vec<String> = remaining.into_iter().collect();
      return get_localized_sort_property(cx, &next_fields, locale, next_parent_is_localized, Some(&result), &remaining);
    }

    return Ok(result);
  }

  Ok(incoming_segments.join("."))
}
