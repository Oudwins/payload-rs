//! JS semantics and small Payload utilities the data methods use.

use std::sync::Arc;

use payload_engine::error::{EngineError, Result};
use payload_engine::fields::{has_autosave_enabled, has_drafts_enabled};
use payload_engine::js::{JsVal, Obj, date_to_iso_string, parse_iso_date};

pub fn obj<const N: usize>(entries: [(&str, JsVal); N]) -> JsVal {
  JsVal::obj(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

pub fn type_error(message: impl Into<String>) -> EngineError {
  EngineError::new("TypeError", message)
}

/// Whether `value` is a plain object/array the engine may mutate (not a `Date` / bson value / host
/// object, which are registered empty objects).
fn is_mutable_container(value: &JsVal) -> bool {
  matches!(value, JsVal::Obj(_)) && value.typed().is_none() && value.bson().is_none() && value.as_host_object().is_none()
}

/// The properties of a plain object, for mutation (copy-on-write if shared).
pub fn props_mut(value: &mut JsVal) -> Option<&mut Obj> {
  if !is_mutable_container(value) {
    return None;
  }
  match value {
    JsVal::Obj(o) => Some(&mut **Arc::make_mut(o)),
    _ => None,
  }
}

/// The items of an array, for mutation.
pub fn items_mut(value: &mut JsVal) -> Option<&mut Vec<JsVal>> {
  match value {
    JsVal::Arr(a) => Some(&mut **Arc::make_mut(a)),
    _ => None,
  }
}

/// `target[key] = value` (an existing key keeps its position, like JS). Assigning a property of a
/// primitive throws in strict mode code; of `null` / `undefined` it is a `TypeError` too.
pub fn set(target: &mut JsVal, key: &str, value: JsVal) -> Result<()> {
  if let Some(props) = props_mut(target) {
    props.insert(key.to_string(), value);
    return Ok(());
  }
  if let Some(items) = items_mut(target) {
    if let Ok(index) = key.parse::<usize>() {
      if index.to_string() == key {
        if index >= items.len() {
          items.resize(index + 1, JsVal::Undefined);
        }
        items[index] = value;
        return Ok(());
      }
    }
    return Err(EngineError::internal(format!("cannot set non-index property {key:?} of an array")));
  }
  Err(match target {
    JsVal::Undefined | JsVal::Null => {
      type_error(format!("Cannot set properties of {} (setting '{key}')", target.to_js_string()))
    }
    _ => type_error(format!("Cannot create property '{key}' on {} '{}'", target.type_of(), target.to_js_string())),
  })
}

/// `delete target[key]`
pub fn delete(target: &mut JsVal, key: &str) -> Result<()> {
  if let Some(props) = props_mut(target) {
    props.shift_remove(key);
    return Ok(());
  }
  match target {
    JsVal::Undefined | JsVal::Null => {
      Err(type_error(format!("Cannot convert undefined or null to object")))
    }
    _ => Ok(()),
  }
}

/// `target[key]` on a value that must not be `null` / `undefined` (property read `TypeError`).
pub fn read<'a>(target: &'a JsVal, key: &str) -> Result<&'a JsVal> {
  match target {
    JsVal::Undefined | JsVal::Null => {
      Err(type_error(format!("Cannot read properties of {} (reading '{key}')", target.to_js_string())))
    }
    _ => Ok(target.get(key)),
  }
}

/// `Object.keys(value)` (own enumerable string keys), `TypeError` for `null` / `undefined`.
pub fn object_keys(value: &JsVal) -> Result<Vec<String>> {
  Ok(match value {
    JsVal::Undefined | JsVal::Null => return Err(type_error("Cannot convert undefined or null to object")),
    JsVal::Obj(o) => o.keys().cloned().collect(),
    JsVal::Arr(a) => (0..a.len()).map(|i| i.to_string()).collect(),
    JsVal::Str(s) => (0..s.encode_utf16().count()).map(|i| i.to_string()).collect(),
    _ => Vec::new(),
  })
}

/// `Object.keys(value).length`
pub fn object_keys_len(value: &JsVal) -> Result<usize> {
  object_keys(value).map(|keys| keys.len())
}

/// `{ ...value }` entries appended / overwritten into `target` (own enumerable properties; strings
/// spread their indices; other primitives nothing).
pub fn spread_into(target: &mut Obj, value: &JsVal) {
  match value {
    JsVal::Obj(o) if is_mutable_container(value) => {
      for (k, v) in o.iter() {
        target.insert(k.clone(), v.clone());
      }
    }
    JsVal::Arr(a) => {
      for (i, v) in a.iter().enumerate() {
        target.insert(i.to_string(), v.clone());
      }
    }
    JsVal::Str(s) => {
      for (i, unit) in s.encode_utf16().enumerate() {
        target.insert(i.to_string(), JsVal::str(String::from_utf16_lossy(&[unit])));
      }
    }
    _ => {}
  }
}

/// `ToNumber(value)` for the values the methods compare (`limit >= 0`, ...).
pub fn to_number(value: &JsVal) -> f64 {
  match value {
    JsVal::Undefined => f64::NAN,
    JsVal::Null => 0.0,
    JsVal::Bool(b) => f64::from(u8::from(*b)),
    JsVal::Num(n) => *n,
    JsVal::Str(s) => string_to_number(s),
    _ => match value.as_date() {
      Some(ms) => ms,
      None => match value.as_arr() {
        Some([]) => 0.0,
        Some([single]) if !matches!(single, JsVal::Arr(_) | JsVal::Obj(_)) => match single {
          JsVal::Undefined | JsVal::Null => 0.0,
          other => string_to_number(&other.to_js_string()),
        },
        _ => f64::NAN,
      },
    },
  }
}

/// `StringToNumber`
fn string_to_number(s: &str) -> f64 {
  let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
  if t.is_empty() {
    return 0.0;
  }
  let radix = |digits: &str, radix: u32| -> f64 {
    if digits.is_empty() {
      return f64::NAN;
    }
    digits.chars().try_fold(0f64, |acc, c| c.to_digit(radix).map(|d| acc * f64::from(radix) + f64::from(d))).unwrap_or(f64::NAN)
  };
  if let Some(rest) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
    return radix(rest, 16);
  }
  if let Some(rest) = t.strip_prefix("0o").or_else(|| t.strip_prefix("0O")) {
    return radix(rest, 8);
  }
  if let Some(rest) = t.strip_prefix("0b").or_else(|| t.strip_prefix("0B")) {
    return radix(rest, 2);
  }
  match t {
    "Infinity" | "+Infinity" => return f64::INFINITY,
    "-Infinity" => return f64::NEG_INFINITY,
    _ => {}
  }
  let valid = t.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'));
  if !valid {
    return f64::NAN;
  }
  t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `a >= b` for a value and a number (`limit >= 0`).
pub fn ge_num(value: &JsVal, n: f64) -> bool {
  if let JsVal::Str(_) | JsVal::Num(_) | JsVal::Bool(_) | JsVal::Null | JsVal::Undefined = value {
    return to_number(value) >= n;
  }
  if value.as_bigint().is_some() {
    return value.as_bigint().and_then(|d| d.parse::<f64>().ok()).is_some_and(|v| v >= n);
  }
  to_number(value) >= n
}

/// `a > b` for a value and a number.
pub fn gt_num(value: &JsVal, n: f64) -> bool {
  if value.as_bigint().is_some() {
    return value.as_bigint().and_then(|d| d.parse::<f64>().ok()).is_some_and(|v| v > n);
  }
  to_number(value) > n
}

/// `value === n`
pub fn is_num(value: &JsVal, n: f64) -> bool {
  matches!(value, JsVal::Num(v) if *v == n)
}

/// `Date.now()` from the system clock.
pub fn system_now() -> f64 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// `new Date().toISOString()` for `now`.
pub fn now_iso(now: f64) -> Result<String> {
  date_to_iso_string(now).ok_or_else(|| EngineError::new("RangeError", "Invalid time value"))
}

/// `new Date(value)` for the values the methods pass (a `Date`, a string, a number, `null`,
/// `undefined`).
pub fn new_date(value: &JsVal) -> JsVal {
  let time_clip = |ms: f64| if ms.is_finite() && ms.abs() <= 8.64e15 { ms.trunc() + 0.0 } else { f64::NAN };
  let ms = match value {
    JsVal::Undefined => f64::NAN,
    JsVal::Null => 0.0,
    JsVal::Bool(b) => f64::from(u8::from(*b)),
    JsVal::Num(n) => *n,
    JsVal::Str(s) => parse_iso_date(s).unwrap_or(f64::NAN),
    _ => match value.as_date() {
      Some(ms) => ms,
      None => to_number(value),
    },
  };
  JsVal::date(time_clip(ms))
}

/// `flattenWhereToOperators(where).some((prop) => Object.keys(prop).some((key) => key === 'near'))`
pub fn has_near_constraint(where_: &JsVal) -> Result<bool> {
  let mut operators = Vec::new();
  flatten_where_to_operators(where_, &mut operators)?;
  for prop in operators {
    if object_keys(&prop)?.iter().any(|k| k == "near") {
      return Ok(true);
    }
  }
  Ok(false)
}

/// `flattenWhereToOperators` (payload/src/database/flattenWhereToOperators.ts)
fn flatten_where_to_operators(query: &JsVal, out: &mut Vec<JsVal>) -> Result<()> {
  if query.is_nullish() {
    return Err(type_error("Cannot convert undefined or null to object"));
  }
  let entries: Vec<(String, JsVal)> = match query {
    JsVal::Obj(o) => o.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
    JsVal::Arr(a) => a.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
    JsVal::Str(s) => s.chars().enumerate().map(|(i, c)| (i.to_string(), JsVal::str(c.to_string()))).collect(),
    _ => Vec::new(),
  };
  for (key, value) in entries {
    if (key == "and" || key == "or") && matches!(value, JsVal::Arr(_)) {
      for sub in value.items() {
        flatten_where_to_operators(sub, out)?;
      }
    } else {
      out.push(value);
    }
  }
  Ok(())
}

/// `combineQueries(where, access)` (payload/src/database/combineQueries.ts)
pub fn combine_queries(where_: &JsVal, access: &JsVal) -> JsVal {
  if !where_.truthy() && !access.truthy() {
    return JsVal::obj(Obj::new());
  }
  let mut and = Vec::new();
  if where_.truthy() {
    and.push(where_.clone());
  }
  // hasWhereAccessResult
  if access.truthy() && access.type_of() == "object" {
    and.push(access.clone());
  }
  obj([("and", JsVal::arr(and))])
}

/// `{ name, type, admin: { disabled: true }, index: true }`-style meta fields of the version
/// schemas (`buildVersionCollectionFields` / `buildVersionGlobalFields`).
fn version_meta_fields(config: &JsVal, entity: &JsVal) -> Vec<JsVal> {
  let admin_disabled = || obj([("disabled", JsVal::Bool(true))]);
  let mut fields = vec![
    obj([
      ("name", JsVal::str("createdAt")),
      ("type", JsVal::str("date")),
      ("admin", admin_disabled()),
      ("index", JsVal::Bool(true)),
    ]),
    obj([
      ("name", JsVal::str("updatedAt")),
      ("type", JsVal::str("date")),
      ("admin", admin_disabled()),
      ("index", JsVal::Bool(true)),
    ]),
  ];
  if has_drafts_enabled(entity) {
    let localization = config.get("localization");
    if localization.truthy() {
      let options = localization
        .get("locales")
        .items()
        .map(|l| if let Some(s) = l.as_str() { JsVal::str(s) } else { l.get("code").clone() })
        .collect();
      fields.push(obj([
        ("name", JsVal::str("publishedLocale")),
        ("type", JsVal::str("select")),
        ("admin", admin_disabled()),
        ("index", JsVal::Bool(true)),
        ("options", JsVal::arr(options)),
      ]));
    }
    fields.push(obj([
      ("name", JsVal::str("latest")),
      ("type", JsVal::str("checkbox")),
      ("admin", admin_disabled()),
      ("index", JsVal::Bool(true)),
    ]));
    if has_autosave_enabled(entity) {
      fields.push(obj([("name", JsVal::str("autosave")), ("type", JsVal::str("checkbox")), ("index", JsVal::Bool(true))]));
    }
  }
  fields
}

/// `buildVersionCollectionFields(config, collection, flatten)`
pub fn build_version_collection_fields(config: &JsVal, collection: &JsVal, flatten: bool) -> JsVal {
  let mut version = Obj::new();
  version.insert("name".into(), JsVal::str("version"));
  version.insert("type".into(), JsVal::str("group"));
  version.insert(
    "fields".into(),
    JsVal::arr(
      collection.get("fields").items().filter(|f| !f.has("name") || f.get("name").as_str() != Some("id")).cloned().collect(),
    ),
  );
  if flatten {
    version.insert(
      "flattenedFields".into(),
      JsVal::arr(collection.get("flattenedFields").items().filter(|f| f.get("name").as_str() != Some("id")).cloned().collect()),
    );
  }
  let mut fields = vec![
    obj([
      ("name", JsVal::str("parent")),
      ("type", JsVal::str("relationship")),
      ("index", JsVal::Bool(true)),
      ("relationTo", collection.get("slug").clone()),
    ]),
    JsVal::obj(version),
  ];
  fields.extend(version_meta_fields(config, collection));
  JsVal::arr(fields)
}

/// `buildVersionGlobalFields(config, global, flatten)`
pub fn build_version_global_fields(config: &JsVal, global: &JsVal, flatten: bool) -> JsVal {
  let mut version = Obj::new();
  version.insert("name".into(), JsVal::str("version"));
  version.insert("type".into(), JsVal::str("group"));
  version.insert("fields".into(), global.get("fields").clone());
  if flatten {
    version.insert("flattenedFields".into(), global.get("flattenedFields").clone());
  }
  let mut fields = vec![JsVal::obj(version)];
  fields.extend(version_meta_fields(config, global));
  JsVal::arr(fields)
}

pub struct FieldByPath {
  pub field: JsVal,
  pub localized_path: String,
  pub path_has_localized: bool,
}

/// `getFieldByPath({ config, fields, includeRelationships, localizedPath, path })`
/// (payload/src/utilities/getFieldByPath.ts)
pub fn get_field_by_path(
  config: Option<&JsVal>,
  fields: &JsVal,
  include_relationships: bool,
  localized_path: &str,
  path: &str,
) -> Option<FieldByPath> {
  let mut current_fields = fields.clone();
  let mut current_field: Option<JsVal> = None;
  let mut segments: std::collections::VecDeque<String> = path.split('.').map(str::to_string).collect();
  let mut path_has_localized = false;
  let mut localized_path = localized_path.to_string();
  while let Some(segment) = segments.pop_front() {
    localized_path = if localized_path.is_empty() { segment.clone() } else { format!("{localized_path}.{segment}") };
    let field = current_fields.items().find(|each| each.get("name").as_str() == Some(segment.as_str()))?.clone();
    if field.get("localized").truthy() {
      path_has_localized = true;
      localized_path = format!("{localized_path}.<locale>");
    }
    if field.has("flattenedFields") {
      current_fields = field.get("flattenedFields").clone();
    }
    let field_type = field.get("type").as_str().unwrap_or("");
    if let Some(config) = config {
      if include_relationships
        && (field_type == "relationship" || field_type == "upload")
        && !matches!(field.get("relationTo"), JsVal::Arr(_))
      {
        let relation_to = field.get("relationTo");
        let flattened = config
          .get("collections")
          .items()
          .find(|e| e.get("slug").strict_eq(relation_to))
          .map(|c| c.get("flattenedFields").clone())
          .unwrap_or_default();
        if flattened.truthy() {
          current_fields = flattened;
        }
        if segments.len() == 1 && segments[0] == "id" {
          return Some(FieldByPath { field, localized_path, path_has_localized });
        }
      }
    }
    if field.has("blocks") && !segments.is_empty() {
      let block_slug = segments[0].clone();
      let from_config = config.and_then(|c| {
        c.get("blocks").as_arr().and_then(|blocks| blocks.iter().find(|b| b.get("slug").as_str() == Some(block_slug.as_str())))
      });
      let block = from_config.cloned().or_else(|| {
        field
          .get("blocks")
          .items()
          .find(|b| !matches!(b, JsVal::Str(_)) && b.get("slug").as_str() == Some(block_slug.as_str()))
          .cloned()
      });
      if let Some(block) = block {
        segments.pop_front();
        localized_path = format!("{localized_path}.{block_slug}");
        if segments.is_empty() {
          return None;
        }
        let rest: Vec<String> = segments.into_iter().collect();
        return get_field_by_path(config, block.get("flattenedFields"), include_relationships, &localized_path, &rest.join("."));
      }
    }
    current_field = Some(field);
  }
  current_field.map(|field| FieldByPath { field, localized_path, path_has_localized })
}

/// `JSON.parse(JSON.stringify(value))` of a value read from the database.
pub fn json_round_trip(value: &JsVal) -> Result<JsVal> {
  match value {
    // `JSON.stringify(undefined)` is `undefined`, and `JSON.parse(undefined)` a SyntaxError
    JsVal::Undefined => Err(EngineError::new("SyntaxError", "\"undefined\" is not valid JSON")),
    _ => Ok(JsVal::from_json(&value.try_to_json()?)),
  }
}

/// `String(value)` for error messages built with template literals.
pub fn js_string(value: &JsVal) -> String {
  value.to_js_string()
}
