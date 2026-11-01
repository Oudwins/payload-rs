//! The pure utilities of packages/db-mongodb/src/utilities: `isObjectID.ts`, `handleError.ts`,
//! `getEntity.ts` (`getCollection`, `getGlobal`) and `getDBName.ts`.

use payload_engine::error::{EngineError, Result};
use payload_engine::host::Host;
use payload_engine::js::{JsVal, Obj};

use crate::value::OBJECT_PROTO;

/// `isObjectID(value)`: a bson `ObjectId`, or an object whose `_bsontype` is `'ObjectId'` and
/// whose `toHexString` is a function.
pub fn is_object_id(value: &JsVal) -> bool {
  if value.is_object_id() {
    return true;
  }
  value.truthy()
    && value.is_object_like()
    && value.has("_bsontype")
    && value.get("_bsontype").as_str() == Some("ObjectId")
    && value.has("toHexString")
    && value.get("toHexString").is_fn()
}

/// `handleError({ collection, error, global, req })` for an error the `try` block threw: a JS
/// value a host op threw (`EngineError::thrown`) is examined like upstream does; errors the engine
/// raised itself stand for JS errors without `code` (rethrown). Returns the error to throw: the
/// `ValidationError` of a duplicate-key error (`code === 11000`), otherwise `error` unchanged.
/// `localization` is `req?.payload?.config?.localization` (`None` without `req`).
///
/// The `ValidationError` is `{ name: 'ValidationError', message: '', data: { collection,
/// errors: [{ path }], global } }` (tree encoding; `collection` / `global` are
/// `{ $undefined: true }` when not given, like the keys of upstream's constructor argument).
/// `errors[].message` is left out: it is `req?.t ? req.t('error:valueMustBeUnique') : 'Value must
/// be unique'`, filled by the TS glue, which must call
/// `new ValidationError({ collection, errors, global }, req?.t)` (no `id`, no `req`, as upstream).
pub fn handle_host_error(error: EngineError, collection: Option<&str>, global: Option<&str>, localization: Option<&JsVal>) -> EngineError {
  let Some(thrown) = &error.thrown else {
    return error;
  };
  handle_error_parts(thrown.is_object, thrown.code.as_ref(), thrown.key_value.as_ref(), thrown.message.as_ref(), collection, global, localization)
    .unwrap_or(error)
}

/// [`handle_host_error`] for an error described by an object of its properties (`code`,
/// `keyValue`, `message`; a missing key is "not `in` error"). `None`: upstream rethrows `error`.
pub fn handle_error(error: &JsVal, collection: Option<&str>, global: Option<&str>, localization: Option<&JsVal>) -> Option<EngineError> {
  let prop = |key: &str| error.has(key).then(|| error.get(key).clone());
  handle_error_parts(
    error.truthy() && error.is_object_like(),
    prop("code").as_ref(),
    prop("keyValue").as_ref(),
    prop("message").as_ref(),
    collection,
    global,
    localization,
  )
}

fn handle_error_parts(
  is_object: bool,
  code: Option<&JsVal>,
  key_value: Option<&JsVal>,
  message: Option<&JsVal>,
  collection: Option<&str>,
  global: Option<&str>,
  localization: Option<&JsVal>,
) -> Option<EngineError> {
  if !is_object || !matches!(code, Some(JsVal::Num(n)) if *n == 11000.0) {
    return None;
  }
  let mut path: Option<String> = None;
  if let Some(key_value) = key_value.filter(|k| k.truthy() && k.is_object_like()) {
    path = Some(first_key(key_value).unwrap_or_default());
  } else if let Some(message) = message.and_then(JsVal::as_str) {
    path = extract_field_from_message(message);
  }
  if let Some(p) = &path
    && !p.is_empty()
  {
    path = Some(strip_locale_from_path(p, localization));
  }
  let undefined = || serde_json::json!({ "$undefined": true });
  let data = serde_json::json!({
    "collection": collection.map_or_else(undefined, |c| serde_json::json!(c)),
    "errors": [{ "path": path.unwrap_or_default() }],
    "global": global.map_or_else(undefined, |g| serde_json::json!(g)),
  });
  Some(EngineError::new("ValidationError", "").with_data(data))
}

/// `Object.keys(value)[0]`
fn first_key(value: &JsVal) -> Option<String> {
  match value {
    JsVal::Obj(o) => o.keys().next().cloned(),
    JsVal::Arr(a) => (!a.is_empty()).then(|| "0".to_string()),
    _ => None,
  }
}

/// `extractFieldFromMessage`: the first match of `/index:\s*(.*?)_/`, `null` when it is empty.
pub fn extract_field_from_message(message: &str) -> Option<String> {
  let mut search = message;
  while let Some(at) = search.find("index:") {
    let rest = &search[at + "index:".len()..];
    let rest = rest.trim_start_matches(is_js_whitespace);
    // `.` does not match line terminators: the lazy group stops at the first `_` before one
    let mut capture = None;
    for (i, c) in rest.char_indices() {
      if c == '_' {
        capture = Some(&rest[..i]);
        break;
      }
      if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
        break;
      }
    }
    if let Some(capture) = capture {
      return (!capture.is_empty()).then(|| capture.to_string());
    }
    // `\s*` backtracks, but a shorter whitespace run cannot reach a `_` either: try the next `index:`
    search = &search[at + 1..];
  }
  None
}

/// JS `\s` (WhiteSpace and LineTerminator).
fn is_js_whitespace(c: char) -> bool {
  matches!(
    c,
    '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
  )
}

/// `stripLocaleFromPath(path, req)`
fn strip_locale_from_path(path: &str, localization: Option<&JsVal>) -> String {
  let Some(localization) = localization.filter(|l| l.truthy()) else {
    return path.to_string();
  };
  let Some(dot) = path.rfind('.') else {
    return path.to_string();
  };
  let last = &path[dot + 1..];
  if localization.get("localeCodes").items().any(|code| code.as_str() == Some(last)) {
    return path[..dot].to_string();
  }
  path.to_string()
}

/// Which mongoose model map an entity's model lives in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelKind {
  /// `adapter.collections[slug]`
  Collections,
  /// `adapter.versions[slug]`
  Versions,
  /// `adapter.globals` (one model for every global)
  Globals,
}

/// A mongoose model reference (resolved on the JS side at op time).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelRef {
  pub kind: ModelKind,
  /// `None` for [`ModelKind::Globals`].
  pub slug: Option<String>,
}

/// The result of `getCollection`.
#[derive(Clone, Debug)]
pub struct CollectionEntity {
  pub collection_config: JsVal,
  pub custom_id_type: JsVal,
  pub model: ModelRef,
}

/// `obj[key]` of a plain object map, where inherited `Object.prototype` members are not modelled.
fn own_entry<'a>(map: &'a JsVal, key: &str) -> Result<&'a JsVal> {
  if !map.has(key) && OBJECT_PROTO.contains(&key) {
    return Err(EngineError::internal(format!("mongo engine: entity slug '{key}' (an Object.prototype member) is not supported")));
  }
  Ok(map.get(key))
}

/// `getCollection({ adapter, collectionSlug, versions })`. `collections` is
/// `adapter.payload.collections` (`{ [slug]: { config, customIDType } }`); `has_model` says
/// whether `adapter.collections[slug]` / `adapter.versions[slug]` is set.
pub fn get_collection(
  collections: &JsVal,
  collection_slug: &str,
  versions: bool,
  has_model: impl Fn(ModelKind, &str) -> bool,
) -> Result<CollectionEntity> {
  let collection = own_entry(collections, collection_slug)?;
  if !collection.truthy() {
    return Err(EngineError::api(format!(
      "ERROR: Failed to retrieve collection with the slug \"{collection_slug}\". Does not exist."
    )));
  }
  let kind = if versions { ModelKind::Versions } else { ModelKind::Collections };
  if !has_model(kind, collection_slug) {
    return Err(EngineError::api(if versions {
      format!("ERROR: Failed to retrieve collection version model with the slug \"{collection_slug}\". Does not exist.")
    } else {
      format!("ERROR: Failed to retrieve collection model with the slug \"{collection_slug}\". Does not exist.")
    }));
  }
  Ok(CollectionEntity {
    collection_config: collection.get("config").clone(),
    custom_id_type: collection.get("customIDType").clone(),
    model: ModelRef { kind, slug: Some(collection_slug.to_string()) },
  })
}

/// `getGlobal({ adapter, globalSlug, versions })`. `config` is `adapter.payload.config`;
/// `has_model` as for [`get_collection`] (only asked for versions). The non-versions model is
/// `adapter.globals` (which may be unset, as upstream returns it).
pub fn get_global(
  config: &JsVal,
  global_slug: &str,
  versions: bool,
  has_model: impl Fn(ModelKind, &str) -> bool,
) -> Result<(JsVal, ModelRef)> {
  let global_config = config
    .get("globals")
    .as_arr()
    .ok_or_else(|| EngineError::new("TypeError", "Cannot read properties of undefined (reading 'find')"))?
    .iter()
    .find(|each| each.get("slug").as_str() == Some(global_slug))
    .cloned();
  let Some(global_config) = global_config.filter(JsVal::truthy) else {
    return Err(EngineError::api(format!(
      "ERROR: Failed to retrieve global with the slug \"{global_slug}\". Does not exist."
    )));
  };
  if versions {
    if !has_model(ModelKind::Versions, global_slug) {
      return Err(EngineError::api(format!(
        "ERROR: Failed to retrieve global version model with the slug \"{global_slug}\". Does not exist."
      )));
    }
    return Ok((global_config, ModelRef { kind: ModelKind::Versions, slug: Some(global_slug.to_string()) }));
  }
  Ok((global_config, ModelRef { kind: ModelKind::Globals, slug: None }))
}

/// `target` of `getDBName`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DbNameTarget {
  DbName,
  EnumName,
}

/// `getDBName({ config, target, versions })`. A function `dbName` / `enumName` is called with
/// `{}` through `host`. Returns the (possibly non-string) result like upstream.
pub fn get_db_name(host: &dyn Host, config: &JsVal, target: DbNameTarget, versions: bool) -> Result<JsVal> {
  let name = config.get("name");
  let slug = config.get("slug");
  let mut custom = config.get(match target {
    DbNameTarget::DbName => "dbName",
    DbNameTarget::EnumName => "enumName",
  });
  if !custom.truthy() && target == DbNameTarget::EnumName {
    custom = config.get("dbName");
  }
  let mut result = if custom.truthy() {
    match custom {
      JsVal::Fn(id) => host.call_value(*id, &JsVal::obj(Obj::new()))?,
      other => other.clone(),
    }
  } else if !name.is_nullish() {
    name.clone()
  } else if !slug.is_nullish() {
    slug.clone()
  } else {
    JsVal::Null
  };
  if versions {
    result = JsVal::str(format!("_{}_versions", result.to_js_string()));
  }
  if !result.truthy() {
    return Err(EngineError::api(format!(
      "Assertion for DB name of {} {} was failed.",
      name.to_js_string(),
      slug.to_js_string()
    )));
  }
  Ok(result)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn extracts_index_names() {
    assert_eq!(
      extract_field_from_message("E11000 duplicate key error collection: db.users index: email_1 dup key").as_deref(),
      Some("email")
    );
    assert_eq!(extract_field_from_message("index: _1"), None);
    assert_eq!(extract_field_from_message("index:  title.en_1").as_deref(), Some("title.en"));
    assert_eq!(extract_field_from_message("no index here"), None);
    assert_eq!(extract_field_from_message("index: a\nb_1 index: c_1").as_deref(), Some("c"));
  }

  #[test]
  fn duplicate_key_errors_become_validation_errors() {
    let localization = JsVal::from_json(&serde_json::json!({ "localeCodes": ["en", "es"] }));
    let error = JsVal::from_json(&serde_json::json!({ "code": 11000, "keyValue": { "slug.en": "a" }, "message": "x" }));
    let e = handle_error(&error, Some("posts"), None, Some(&localization)).expect("validation error");
    assert_eq!(e.name, "ValidationError");
    assert_eq!(
      e.data,
      Some(serde_json::json!({ "collection": "posts", "errors": [{ "path": "slug" }], "global": { "$undefined": true } }))
    );
    let other = JsVal::from_json(&serde_json::json!({ "code": "11000", "message": "x" }));
    assert!(handle_error(&other, None, None, None).is_none());
  }
}
