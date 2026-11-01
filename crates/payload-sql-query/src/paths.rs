//! Ports of `queries/resolveRelationshipPath.ts` and payload's `utilities/getFieldByPath.ts`
//! (without the `config` / `includeRelationships` options, which the drizzle callers never pass).

use payload_engine::error::Result;
use payload_engine::js::JsVal;

use crate::adapter::QueryAdapter;

pub fn field_name(field: &JsVal) -> &JsVal {
  field.get("name")
}

pub fn field_type(field: &JsVal) -> &str {
  field.get("type").as_str().unwrap_or("")
}

/// `fields.find(({ name }) => name === segment)`; `None` segment mirrors `undefined`.
pub fn find_field<'a>(fields: &'a JsVal, segment: Option<&str>) -> Option<&'a JsVal> {
  fields.items().find(|f| match segment {
    Some(s) => f.get("name").as_str() == Some(s),
    None => f.get("name").is_undefined(),
  })
}

/// `appendFieldToStoragePath({ field, path })`
pub fn append_field_to_storage_path(field: &JsVal, path: &str) -> String {
  let name = crate::js_ops::js_string(field_name(field));
  let mut segments = if path.is_empty() { vec![name] } else { vec![path.strip_suffix('.').unwrap_or(path).to_string(), name] };
  if matches!(field_type(field), "array" | "blocks") {
    segments.push("%".into());
  }
  segments.join(".")
}

pub struct ResolvedRelationshipPath<'a> {
  pub field: &'a JsVal,
  pub is_localized: bool,
  pub locale: Option<String>,
  pub path: String,
}

/// `resolveRelationshipPath({ adapter, fields, locale, parentIsLocalized, path, pathPrefix })`
pub fn resolve_relationship_path<'a>(
  adapter: &QueryAdapter<'a>,
  fields: &'a JsVal,
  locale: Option<String>,
  parent_is_localized: bool,
  path: &str,
  path_prefix: &str,
) -> Result<Option<ResolvedRelationshipPath<'a>>> {
  let locale_codes = if adapter.localization().truthy() { adapter.locale_codes() } else { Vec::new() };
  let mut locale = locale;
  let mut current_field: Option<&'a JsVal> = None;
  let mut current_fields: Vec<&'a JsVal> = fields.items().collect();
  let mut is_localized = parent_is_localized;
  let mut resolved_path = path_prefix.to_string();

  for segment in path.split('.') {
    let field = current_fields.iter().copied().find(|f| f.get("name").as_str() == Some(segment));
    let Some(field) = field else {
      if is_localized && locale_codes.iter().any(|c| c == segment) {
        locale = Some(segment.to_string());
        continue;
      }
      return Ok(None);
    };

    current_field = Some(field);
    resolved_path = append_field_to_storage_path(field, &resolved_path);
    is_localized = is_localized || field.get("localized").truthy();

    if field.has("flattenedFields") {
      current_fields = field.get("flattenedFields").items().collect();
    } else if field_type(field) == "blocks" {
      let mut next = Vec::new();
      for block in field.get("blocks").items() {
        let block = if let Some(slug) = block.as_str() { adapter.blocks.get(slug) } else { block };
        if block.is_nullish() {
          return Err(crate::adapter::read_undefined("flattenedFields"));
        }
        next.extend(block.get("flattenedFields").items());
      }
      current_fields = next;
    } else {
      current_fields = Vec::new();
    }
  }

  match current_field {
    Some(f) if matches!(field_type(f), "relationship" | "upload") => {
      Ok(Some(ResolvedRelationshipPath { field: f, is_localized, locale, path: resolved_path }))
    }
    _ => Ok(None),
  }
}

/// payload `getFieldByPath({ fields, path })` (returns only the field).
pub fn get_field_by_path<'a>(fields: &'a JsVal, path: &str) -> Option<&'a JsVal> {
  let mut current_fields = fields;
  let mut current_field: Option<&'a JsVal> = None;
  let mut segments: Vec<&str> = path.split('.').collect();
  segments.reverse();

  while let Some(segment) = segments.pop() {
    let field = current_fields.items().find(|f| f.get("name").as_str() == Some(segment))?;

    if field.has("flattenedFields") {
      current_fields = field.get("flattenedFields");
    }

    if field.has("blocks") && !segments.is_empty() {
      let block_slug = *segments.last()?;
      let block = field
        .get("blocks")
        .items()
        .find(|b| b.as_str().is_none() && b.get("slug").as_str() == Some(block_slug));
      if let Some(block) = block {
        segments.pop();
        if segments.is_empty() {
          return None;
        }
        segments.reverse();
        return get_field_by_path(block.get("flattenedFields"), &segments.join("."));
      }
    }

    current_field = Some(field);
  }

  current_field
}
