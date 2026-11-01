//! Small Payload utilities used by the find module, ported 1:1.

use payload_engine::fields::{has_autosave_enabled, has_drafts_enabled};
use indexmap::IndexMap;
use payload_engine::error::Result;
use payload_engine::js::JsVal;
use payload_sql_query::WhereVal;

fn obj(entries: Vec<(&str, JsVal)>) -> JsVal {
  JsVal::obj(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

/// `typeof value === 'object'` (true for `null`, like JS).
pub fn is_typeof_object(value: &JsVal) -> bool {
  value.is_object_like()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectMode {
  Include,
  Exclude,
}

/// `getSelectMode` (payload/src/utilities/getSelectMode.ts)
pub fn get_select_mode(select: &JsVal) -> SelectMode {
  if let Some(o) = select.as_obj() {
    for value in o.values() {
      if matches!(value, JsVal::Bool(false)) {
        return SelectMode::Exclude;
      }
      if value.is_object_like() {
        return get_select_mode(value);
      }
    }
  }
  SelectMode::Include
}

/// `buildVersionCollectionFields(config, collection, true)`
/// (payload/src/versions/buildCollectionFields.ts)
pub fn build_version_collection_fields(config: &JsVal, collection: &JsVal) -> JsVal {
  let admin_disabled = || obj(vec![("disabled", JsVal::Bool(true))]);
  let version_fields: Vec<JsVal> = collection
    .get("fields")
    .items()
    .filter(|f| !f.has("name") || f.get("name").as_str() != Some("id"))
    .cloned()
    .collect();
  let version_flattened: Vec<JsVal> =
    collection.get("flattenedFields").items().filter(|f| f.get("name").as_str() != Some("id")).cloned().collect();
  let mut fields = vec![
    obj(vec![
      ("name", JsVal::str("parent")),
      ("type", JsVal::str("relationship")),
      ("index", JsVal::Bool(true)),
      ("relationTo", collection.get("slug").clone()),
    ]),
    obj(vec![
      ("name", JsVal::str("version")),
      ("type", JsVal::str("group")),
      ("fields", JsVal::arr(version_fields)),
      ("flattenedFields", JsVal::arr(version_flattened)),
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
  if has_drafts_enabled(collection) {
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
    if has_autosave_enabled(collection) {
      fields.push(obj(vec![
        ("name", JsVal::str("autosave")),
        ("type", JsVal::str("checkbox")),
        ("index", JsVal::Bool(true)),
      ]));
    }
  }
  JsVal::arr(fields)
}

/// `getQueryDraftsSort` (payload/src/versions/drafts/getQueryDraftsSort.ts)
pub fn get_query_drafts_sort(collection_config: &JsVal, sort: &JsVal) -> JsVal {
  let mut sort = sort.clone();
  if !sort.truthy() {
    let default_sort = collection_config.get("defaultSort");
    sort = if default_sort.truthy() { default_sort.clone() } else { JsVal::str("-createdAt") };
  }
  if let JsVal::Str(s) = &sort {
    sort = JsVal::arr(vec![JsVal::Str(s.clone())]);
  }
  JsVal::arr(
    sort
      .items()
      .map(|field| {
        let field = field.to_js_string();
        let (order_by, direction) = match field.strip_prefix('-') {
          Some(rest) => (rest.to_string(), "-"),
          None => (field.clone(), ""),
        };
        if order_by == "id" {
          JsVal::str(format!("{direction}parent"))
        } else {
          JsVal::str(format!("{direction}version.{order_by}"))
        }
      })
      .collect(),
  )
}

/// `appendVersionToQueryKey` (payload/src/versions/drafts/appendVersionToQueryKey.ts).
///
/// Works on [`WhereVal`] so engine-built wheres keep their internal values
/// (raw constraints) as typed variants.
pub fn append_version_to_query_key(query: &WhereVal) -> Result<WhereVal> {
  // `(query: Where = {})`
  if matches!(query, WhereVal::Js(JsVal::Undefined)) {
    return Ok(WhereVal::Obj(Vec::new()));
  }
  append_version_with_id_path(query)
}

fn append_version_with_id_path(query: &WhereVal) -> Result<WhereVal> {
  // `{ ...res, [key]: val }`: a repeated key keeps its first position.
  let mut out: IndexMap<String, WhereVal> = IndexMap::new();
  for (key, val) in query.entries()? {
    let lower = key.to_lowercase();
    if lower == "and" || lower == "or" {
      if let Some(items) = val.as_items() {
        let items = items.iter().map(append_version_with_id_path).collect::<Result<Vec<_>>>()?;
        out.insert(lower, WhereVal::Arr(items));
        continue;
      }
    }
    let new_key = if key == "id" { "parent".to_string() } else { format!("version.{key}") };
    out.insert(new_key, val);
  }
  Ok(WhereVal::Obj(out.into_iter().collect()))
}

/// `combineQueries` (payload/src/database/combineQueries.ts)
pub fn combine_queries(where_: &WhereVal, access: &JsVal) -> WhereVal {
  let where_truthy = match where_ {
    WhereVal::Js(v) => v.truthy(),
    _ => true,
  };
  if !where_truthy && !access.truthy() {
    return WhereVal::Obj(Vec::new());
  }
  let mut and = Vec::new();
  if where_truthy {
    and.push(where_.clone());
  }
  // hasWhereAccessResult
  if access.truthy() && access.is_object_like() {
    and.push(WhereVal::Js(access.clone()));
  }
  WhereVal::obj(vec![("and", WhereVal::Arr(and))])
}

pub struct FieldByPath {
  pub field: JsVal,
  pub localized_path: String,
  pub path_has_localized: bool,
}

/// `getFieldByPath` (payload/src/utilities/getFieldByPath.ts) without
/// `config`/`includeRelationships` (as used by the find module).
pub fn get_field_by_path(fields: &JsVal, path: &str, localized_path: &str) -> Option<FieldByPath> {
  let mut current_fields = fields.clone();
  let mut current_field: Option<JsVal> = None;
  let mut segments: std::collections::VecDeque<&str> = path.split('.').collect();
  let mut path_has_localized = false;
  let mut localized_path = localized_path.to_string();

  while let Some(segment) = segments.pop_front() {
    localized_path =
      format!("{}{segment}", if localized_path.is_empty() { String::new() } else { format!("{localized_path}.") });
    let field = current_fields.items().find(|f| f.get("name").as_str() == Some(segment))?.clone();
    if field.get("localized").truthy() {
      path_has_localized = true;
      localized_path = format!("{localized_path}.<locale>");
    }
    if field.has("flattenedFields") {
      current_fields = field.get("flattenedFields").clone();
    }
    if field.has("blocks") && !segments.is_empty() {
      let block_slug = segments[0];
      let block = field.get("blocks").items().find(|b| !matches!(b, JsVal::Str(_)) && b.get("slug").as_str() == Some(block_slug));
      if let Some(block) = block {
        segments.pop_front();
        localized_path = format!("{localized_path}.{block_slug}");
        if segments.is_empty() {
          return None;
        }
        let rest: Vec<&str> = segments.into_iter().collect();
        return get_field_by_path(block.get("flattenedFields"), &rest.join("."), &localized_path);
      }
    }
    current_field = Some(field);
  }
  current_field.map(|field| FieldByPath { field, localized_path, path_has_localized })
}

/// JS `Object.keys` order for keys inserted in `keys` order: integer-like
/// keys first in ascending numeric order, then the others in insertion order.
pub fn js_object_key_order(keys: Vec<String>) -> Vec<String> {
  let is_index = |k: &str| {
    !k.is_empty()
      && k.bytes().all(|b| b.is_ascii_digit())
      && (k == "0" || !k.starts_with('0'))
      && k.parse::<u64>().is_ok_and(|n| n < 4_294_967_295)
  };
  let mut seen = indexmap::IndexSet::new();
  for k in keys {
    seen.insert(k);
  }
  let mut ints: Vec<String> = seen.iter().filter(|k| is_index(k)).cloned().collect();
  ints.sort_by_key(|k| k.parse::<u64>().unwrap_or(0));
  ints.extend(seen.into_iter().filter(|k| !is_index(k)));
  ints
}

/// `for (const key in value)` paired with `value[key]`: own enumerable keys of
/// objects (JS order, which the decoded graph keeps), indices of arrays and of
/// strings (one per UTF-16 code unit; a lone surrogate half becomes U+FFFD),
/// nothing for `null`, `undefined` and other primitives.
pub fn js_for_in_entries(value: &JsVal) -> Vec<(String, JsVal)> {
  match value {
    JsVal::Obj(o) => o.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
    JsVal::Arr(a) => a.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
    JsVal::Str(s) => s
      .encode_utf16()
      .enumerate()
      .map(|(i, unit)| {
        let ch = char::decode_utf16([unit]).next().and_then(|c| c.ok()).unwrap_or('\u{FFFD}');
        (i.to_string(), JsVal::str(ch.to_string()))
      })
      .collect(),
    _ => Vec::new(),
  }
}

/// `Object.keys(value)` paired with `value[key]`; like [`js_for_in_entries`]
/// but `null` / `undefined` throw `TypeError: Cannot convert undefined or null to object`.
pub fn js_object_entries(value: &JsVal) -> Result<Vec<(String, JsVal)>> {
  if value.is_nullish() {
    return Err(payload_engine::error::EngineError::new("TypeError", "Cannot convert undefined or null to object"));
  }
  Ok(js_for_in_entries(value))
}

/// `Object.keys(value).length` for a value that is not `null` / `undefined`.
pub fn js_object_keys_len(value: &JsVal) -> usize {
  match value {
    JsVal::Obj(o) => o.len(),
    JsVal::Arr(a) => a.len(),
    JsVal::Str(s) => s.encode_utf16().count(),
    _ => 0,
  }
}
