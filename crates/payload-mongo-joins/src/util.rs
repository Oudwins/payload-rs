//! JS semantics the ported modules rely on (property reads that throw on `null` / `undefined`,
//! `ToPropertyKey`, `+` / `*` / `<`, object key order) and the small Payload helpers they import
//! (`buildVersionCollectionFields`, `getQueryDraftsSort`, `combineQueries`,
//! `appendVersionToQueryKey`, `flattenWhereToOperators`, `getFieldByPath`).

use std::sync::Arc;

use payload_engine::error::{EngineError, Result};
use payload_engine::fields::{has_autosave_enabled, has_drafts_enabled};
use payload_engine::js::{JsVal, Obj, TypedValue, num_to_js_string};
use payload_sql_read::jsops::string_to_number;

/// A plain object from `(key, value)` pairs, keys in JS order.
pub fn obj<K: Into<String>>(entries: impl IntoIterator<Item = (K, JsVal)>) -> JsVal {
  let mut out = Obj::new();
  for (key, value) in entries {
    set_key(&mut out, key.into(), value);
  }
  JsVal::obj(out)
}

pub fn s(value: impl Into<Arc<str>>) -> JsVal {
  JsVal::str(value)
}

pub fn num(value: f64) -> JsVal {
  JsVal::Num(value)
}

/// Whether `key` is an array index (`CanonicalNumericIndexString` < 2^32 - 1): such keys come
/// first in JS property order, ascending.
pub fn is_array_index(key: &str) -> bool {
  !key.is_empty()
    && key.bytes().all(|b| b.is_ascii_digit())
    && (key == "0" || !key.starts_with('0'))
    && key.parse::<u64>().is_ok_and(|n| n < 4_294_967_295)
}

/// `object[key] = value` on a plain object: an existing key keeps its position, a new array index
/// goes among the other indices in ascending order, any other new key goes last.
pub fn set_key(o: &mut Obj, key: String, value: JsVal) {
  if let Some(slot) = o.get_mut(&key) {
    *slot = value;
    return;
  }
  if is_array_index(&key) {
    let n = key.parse::<u64>().unwrap_or(0);
    let position = o
      .keys()
      .position(|k| !is_array_index(k) || k.parse::<u64>().unwrap_or(0) > n)
      .unwrap_or(o.len());
    o.shift_insert(position, key, value);
  } else {
    o.insert(key, value);
  }
}

/// `Object.keys(value)` for an object (JS order), `TypeError` for `null` / `undefined`.
pub fn object_keys(value: &JsVal) -> Result<Vec<String>> {
  Ok(object_entries(value)?.into_iter().map(|(k, _)| k).collect())
}

/// `Object.entries(value)`: own enumerable string keys in JS order (array / string indices for
/// arrays and strings, nothing for other primitives and typed values), `TypeError` for `null` /
/// `undefined`.
pub fn object_entries(value: &JsVal) -> Result<Vec<(String, JsVal)>> {
  match value {
    JsVal::Undefined | JsVal::Null => {
      Err(EngineError::new("TypeError", "Cannot convert undefined or null to object"))
    }
    JsVal::Obj(o) => {
      let mut index: Vec<(String, JsVal)> =
        o.iter().filter(|(k, _)| is_array_index(k)).map(|(k, v)| (k.clone(), v.clone())).collect();
      index.sort_by_key(|(k, _)| k.parse::<u64>().unwrap_or(0));
      index.extend(o.iter().filter(|(k, _)| !is_array_index(k)).map(|(k, v)| (k.clone(), v.clone())));
      Ok(index)
    }
    JsVal::Arr(a) => Ok(a.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect()),
    JsVal::Str(text) => Ok(
      text
        .encode_utf16()
        .enumerate()
        .map(|(i, unit)| (i.to_string(), s(String::from_utf16_lossy(&[unit]))))
        .collect(),
    ),
    _ => Ok(Vec::new()),
  }
}

/// `value[key]` for any value: `length` / indices of strings and arrays, own properties of
/// objects, `undefined` otherwise; `TypeError` when `value` is `null` / `undefined`.
pub fn read(value: &JsVal, key: &str) -> Result<JsVal> {
  match value {
    JsVal::Undefined | JsVal::Null => Err(EngineError::new(
      "TypeError",
      format!(
        "Cannot read properties of {} (reading '{key}')",
        if value.is_null() { "null" } else { "undefined" }
      ),
    )),
    _ => Ok(get(value, key)),
  }
}

/// `value?.[key]`
pub fn opt_get(value: &JsVal, key: &str) -> JsVal {
  get(value, key)
}

/// `value[key]` for a value that is not `null` / `undefined` (`undefined` for those).
pub fn get(value: &JsVal, key: &str) -> JsVal {
  match value {
    JsVal::Arr(a) => {
      if key == "length" {
        return num(a.len() as f64);
      }
      if is_array_index(key) {
        return key.parse::<usize>().ok().and_then(|i| a.get(i).cloned()).unwrap_or_default();
      }
      JsVal::Undefined
    }
    JsVal::Str(text) => {
      if key == "length" {
        return num(text.encode_utf16().count() as f64);
      }
      if is_array_index(key) {
        let units: Vec<u16> = text.encode_utf16().collect();
        return key
          .parse::<usize>()
          .ok()
          .and_then(|i| units.get(i).map(|u| s(String::from_utf16_lossy(&[*u]))))
          .unwrap_or_default();
      }
      JsVal::Undefined
    }
    JsVal::Obj(_) => value.get(key).clone(),
    _ => JsVal::Undefined,
  }
}

/// `key in value` for an object (own keys; the values the ported code checks have no prototype
/// properties that matter).
pub fn in_op(key: &str, value: &JsVal) -> bool {
  matches!(value, JsVal::Obj(o) if o.contains_key(key))
}

/// `ToPropertyKey(value)` (= `String(value)` for everything but symbols).
pub fn property_key(value: &JsVal) -> String {
  value.to_js_string()
}

/// `` `${value}` ``
pub fn template(value: &JsVal) -> String {
  value.to_js_string()
}

/// `Array.isArray(value)`
pub fn is_array(value: &JsVal) -> bool {
  matches!(value, JsVal::Arr(_))
}

/// `a ?? b`
pub fn nullish_or(a: JsVal, b: impl FnOnce() -> Result<JsVal>) -> Result<JsVal> {
  if a.is_nullish() { b() } else { Ok(a) }
}

/// `a || b`
pub fn or_else(a: JsVal, b: impl FnOnce() -> Result<JsVal>) -> Result<JsVal> {
  if a.truthy() { Ok(a) } else { b() }
}

/// `value === text`
pub fn is_str(value: &JsVal, text: &str) -> bool {
  value.as_str() == Some(text)
}

/// The result of `ToPrimitive(value, 'number')` for the values the ported code compares and adds.
enum Primitive {
  Num(f64),
  Str(String),
  BigInt(Arc<str>),
}

fn to_primitive(value: &JsVal) -> Result<Primitive> {
  if let Some(typed) = value.typed() {
    return Ok(match typed {
      TypedValue::Date(ms) => Primitive::Num(ms),
      TypedValue::BigInt(d) => Primitive::BigInt(d),
    });
  }
  if value.as_host_object().is_some() {
    return Err(EngineError::internal("cannot convert a host object to a primitive"));
  }
  Ok(match value {
    JsVal::Undefined => Primitive::Num(f64::NAN),
    JsVal::Null => Primitive::Num(0.0),
    JsVal::Bool(b) => Primitive::Num(f64::from(u8::from(*b))),
    JsVal::Num(n) => Primitive::Num(*n),
    JsVal::Str(text) => Primitive::Str(text.to_string()),
    // `valueOf` returns the object itself, so `toString` decides (bson classes, arrays, objects).
    JsVal::Arr(_) | JsVal::Obj(_) => Primitive::Str(value.to_js_string()),
    JsVal::Fn(_) => return Err(EngineError::internal("cannot convert a function to a primitive")),
  })
}

fn primitive_to_number(p: &Primitive) -> Result<f64> {
  match p {
    Primitive::Num(n) => Ok(*n),
    Primitive::Str(text) => Ok(string_to_number(text)),
    Primitive::BigInt(_) => Err(EngineError::new("TypeError", "Cannot mix BigInt and other types, use explicit conversions")),
  }
}

/// `Number(value)` / unary `+value` (`TypeError` for a `bigint`).
pub fn to_number(value: &JsVal) -> Result<f64> {
  match to_primitive(value)? {
    Primitive::BigInt(_) => Err(EngineError::new("TypeError", "Cannot convert a BigInt value to a number")),
    p => primitive_to_number(&p),
  }
}

/// `a + b`
pub fn add(a: &JsVal, b: &JsVal) -> Result<JsVal> {
  let (pa, pb) = (to_primitive(a)?, to_primitive(b)?);
  match (&pa, &pb) {
    (Primitive::Str(x), _) => Ok(s(format!("{x}{}", primitive_string(&pb)))),
    (_, Primitive::Str(y)) => Ok(s(format!("{}{y}", primitive_string(&pa)))),
    (Primitive::BigInt(_), Primitive::BigInt(_)) => Err(EngineError::internal("bigint arithmetic is not supported")),
    _ => Ok(num(primitive_to_number(&pa)? + primitive_to_number(&pb)?)),
  }
}

fn primitive_string(p: &Primitive) -> String {
  match p {
    Primitive::Num(n) => num_to_js_string(*n),
    Primitive::Str(text) => text.clone(),
    Primitive::BigInt(d) => d.to_string(),
  }
}

fn numeric_operands(a: &JsVal, b: &JsVal) -> Result<(f64, f64)> {
  let (pa, pb) = (to_primitive(a)?, to_primitive(b)?);
  if matches!((&pa, &pb), (Primitive::BigInt(_), Primitive::BigInt(_))) {
    return Err(EngineError::internal("bigint arithmetic is not supported"));
  }
  Ok((primitive_to_number(&pa)?, primitive_to_number(&pb)?))
}

/// `a - b`
pub fn sub(a: &JsVal, b: &JsVal) -> Result<f64> {
  let (x, y) = numeric_operands(a, b)?;
  Ok(x - y)
}

/// `a * b`
pub fn mul(a: &JsVal, b: &JsVal) -> Result<f64> {
  let (x, y) = numeric_operands(a, b)?;
  Ok(x * y)
}

/// `a / b`
pub fn div(a: &JsVal, b: &JsVal) -> Result<f64> {
  let (x, y) = numeric_operands(a, b)?;
  Ok(x / y)
}

/// `IsLessThan(a, b)` (Abstract Relational Comparison): `Some(true / false)`, `None` for
/// `undefined` (a `NaN` operand).
fn less_than(a: &JsVal, b: &JsVal) -> Result<Option<bool>> {
  let (pa, pb) = (to_primitive(a)?, to_primitive(b)?);
  if let (Primitive::Str(x), Primitive::Str(y)) = (&pa, &pb) {
    return Ok(Some(x.encode_utf16().lt(y.encode_utf16())));
  }
  if let (Primitive::BigInt(x), Primitive::BigInt(y)) = (&pa, &pb) {
    return Ok(Some(bigint_lt(x, y)));
  }
  let bigint_as_number = |p: &Primitive| match p {
    Primitive::BigInt(d) => d.parse::<f64>().unwrap_or(f64::NAN),
    Primitive::Str(text) => string_to_number(text),
    Primitive::Num(n) => *n,
  };
  let (x, y) = (bigint_as_number(&pa), bigint_as_number(&pb));
  if x.is_nan() || y.is_nan() {
    return Ok(None);
  }
  Ok(Some(x < y))
}

fn bigint_lt(x: &str, y: &str) -> bool {
  let (nx, ny) = (x.starts_with('-'), y.starts_with('-'));
  if nx != ny {
    return nx;
  }
  let (dx, dy) = (x.trim_start_matches('-'), y.trim_start_matches('-'));
  let magnitude_lt = (dx.len(), dx) < (dy.len(), dy);
  let magnitude_gt = (dx.len(), dx) > (dy.len(), dy);
  if nx { magnitude_gt } else { magnitude_lt }
}

/// `a < b`
pub fn lt(a: &JsVal, b: &JsVal) -> Result<bool> {
  Ok(less_than(a, b)? == Some(true))
}

/// `a > b`
pub fn gt(a: &JsVal, b: &JsVal) -> Result<bool> {
  Ok(less_than(b, a)? == Some(true))
}

/// `String.prototype.replace(pattern, replacement)` with a string pattern: the first occurrence,
/// with the `$$`, `$&`, `` $` `` and `$'` replacement patterns.
pub fn replace_first(text: &str, pattern: &str, replacement: &str) -> String {
  let Some(at) = text.find(pattern) else { return text.to_string() };
  let (before, after) = (&text[..at], &text[at + pattern.len()..]);
  let mut out = String::with_capacity(text.len() + replacement.len());
  out.push_str(before);
  let mut chars = replacement.chars().peekable();
  while let Some(c) = chars.next() {
    if c != '$' {
      out.push(c);
      continue;
    }
    match chars.peek() {
      Some('$') => {
        chars.next();
        out.push('$');
      }
      Some('&') => {
        chars.next();
        out.push_str(pattern);
      }
      Some('`') => {
        chars.next();
        out.push_str(before);
      }
      Some('\'') => {
        chars.next();
        out.push_str(after);
      }
      _ => out.push('$'),
    }
  }
  out.push_str(after);
  out
}

/// `text.replace(/^_+/, '')`
pub fn trim_leading_underscores(text: &str) -> &str {
  text.trim_start_matches('_')
}

/// `object[key] = value` in strict mode code, on an object the ported code owns.
pub fn assign(target: &mut JsVal, key: &str, value: JsVal) -> Result<()> {
  match target {
    JsVal::Undefined | JsVal::Null => Err(EngineError::new(
      "TypeError",
      format!("Cannot set properties of {} (setting '{key}')", if target.is_null() { "null" } else { "undefined" }),
    )),
    JsVal::Str(_) | JsVal::Num(_) | JsVal::Bool(_) => Err(EngineError::new(
      "TypeError",
      format!("Cannot create property '{key}' on {} '{}'", target.type_of(), target.to_js_string()),
    )),
    JsVal::Obj(_) if target.typed().is_some() || target.bson().is_some() || target.as_host_object().is_some() => {
      Err(EngineError::internal(format!("setting '{key}' on a non-plain object is not supported")))
    }
    JsVal::Obj(o) => {
      set_key(&mut **Arc::make_mut(o), key.to_string(), value);
      Ok(())
    }
    JsVal::Arr(_) | JsVal::Fn(_) => {
      Err(EngineError::internal(format!("setting '{key}' on an array or function is not supported")))
    }
  }
}

/// Mutable access to a property of a plain object (copy-on-write).
pub fn prop_mut<'a>(target: &'a mut JsVal, key: &str) -> Option<&'a mut JsVal> {
  match target {
    JsVal::Obj(o) => Arc::make_mut(o).get_mut(key),
    _ => None,
  }
}

/// `{ ...value }` of a plain object (own enumerable properties, JS order).
pub fn spread(value: &JsVal) -> Result<Obj> {
  let mut out = Obj::new();
  if value.is_nullish() {
    return Ok(out);
  }
  for (k, v) in object_entries(value)? {
    set_key(&mut out, k, v);
  }
  Ok(out)
}

fn admin_disabled() -> JsVal {
  obj([("disabled", JsVal::Bool(true))])
}

/// `buildVersionCollectionFields(config, collection, flatten)`
/// (payload/src/versions/buildCollectionFields.ts)
pub fn build_version_collection_fields(config: &JsVal, collection: &JsVal, flatten: bool) -> Result<JsVal> {
  let mut version = vec![
    ("name", s("version")),
    ("type", s("group")),
    (
      "fields",
      JsVal::arr(
        read(collection, "fields")?
          .items()
          .filter(|field| !(field.has("name") && is_str(field.get("name"), "id")))
          .cloned()
          .collect(),
      ),
    ),
  ];
  if flatten {
    version.push((
      "flattenedFields",
      JsVal::arr(
        read(collection, "flattenedFields")?.items().filter(|each| !is_str(each.get("name"), "id")).cloned().collect(),
      ),
    ));
  }
  let mut fields = vec![
    obj([("name", s("parent")), ("type", s("relationship")), ("index", JsVal::Bool(true)), ("relationTo", collection.get("slug").clone())]),
    obj(version),
    obj([("name", s("createdAt")), ("type", s("date")), ("admin", admin_disabled()), ("index", JsVal::Bool(true))]),
    obj([("name", s("updatedAt")), ("type", s("date")), ("admin", admin_disabled()), ("index", JsVal::Bool(true))]),
  ];
  if has_drafts_enabled(collection) {
    let localization = config.get("localization");
    if localization.truthy() {
      let options = read(localization, "locales")?
        .items()
        .map(|locale| if let JsVal::Str(_) = locale { locale.clone() } else { locale.get("code").clone() })
        .collect();
      fields.push(obj([
        ("name", s("publishedLocale")),
        ("type", s("select")),
        ("admin", admin_disabled()),
        ("index", JsVal::Bool(true)),
        ("options", JsVal::arr(options)),
      ]));
    }
    fields.push(obj([("name", s("latest")), ("type", s("checkbox")), ("admin", admin_disabled()), ("index", JsVal::Bool(true))]));
    if has_autosave_enabled(collection) {
      fields.push(obj([("name", s("autosave")), ("type", s("checkbox")), ("index", JsVal::Bool(true))]));
    }
  }
  Ok(JsVal::arr(fields))
}

/// `getQueryDraftsSort({ collectionConfig, sort })` (payload/src/versions/drafts/getQueryDraftsSort.ts)
pub fn get_query_drafts_sort(collection_config: &JsVal, sort: &JsVal) -> Result<JsVal> {
  let mut sort = sort.clone();
  if !sort.truthy() {
    let default_sort = collection_config.get("defaultSort");
    sort = if default_sort.truthy() { default_sort.clone() } else { s("-createdAt") };
  }
  if let JsVal::Str(_) = sort {
    sort = JsVal::arr(vec![sort]);
  }
  let JsVal::Arr(items) = &sort else {
    return Err(EngineError::new("TypeError", "sort.map is not a function"));
  };
  let mut out = Vec::with_capacity(items.len());
  for field in items.iter() {
    // `field[0] === '-'` / `field.substring(1)` on the string the caller passed
    let text = match field {
      JsVal::Str(text) => text.to_string(),
      _ => return Err(EngineError::internal("getQueryDraftsSort: non-string sort entries are not supported")),
    };
    let (order_by, direction) = match text.strip_prefix('-') {
      Some(rest) => (rest.to_string(), "-"),
      None => (text.clone(), ""),
    };
    out.push(if order_by == "id" { s(format!("{direction}parent")) } else { s(format!("{direction}version.{order_by}")) });
  }
  Ok(JsVal::arr(out))
}

/// `appendVersionToQueryKey(query)` (payload/src/versions/drafts/appendVersionToQueryKey.ts)
pub fn append_version_to_query_key(query: &JsVal) -> Result<JsVal> {
  if query.is_undefined() {
    return Ok(JsVal::obj(Obj::new()));
  }
  append_version_with_id_path(query)
}

fn append_version_with_id_path(query: &JsVal) -> Result<JsVal> {
  let mut out = Obj::new();
  for (key, value) in object_entries(query)? {
    let lower = key.to_lowercase();
    if (lower == "and" || lower == "or") && is_array(&value) {
      let items = value.items().map(append_version_with_id_path).collect::<Result<Vec<_>>>()?;
      set_key(&mut out, lower, JsVal::arr(items));
      continue;
    }
    let new_key = if key == "id" { "parent".to_string() } else { format!("version.{key}") };
    set_key(&mut out, new_key, value);
  }
  Ok(JsVal::obj(out))
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
  if access.truthy() && access.is_object_like() {
    and.push(access.clone());
  }
  obj([("and", JsVal::arr(and))])
}

/// `{ latest: { equals: true } }`
pub fn latest_equals_true() -> JsVal {
  obj([("latest", obj([("equals", JsVal::Bool(true))]))])
}

/// `flattenWhereToOperators(query)` (payload/src/database/flattenWhereToOperators.ts)
pub fn flatten_where_to_operators(query: &JsVal) -> Result<Vec<JsVal>> {
  let mut out = Vec::new();
  for (key, value) in object_entries(query)? {
    if (key == "and" || key == "or") && is_array(&value) {
      for sub in value.items() {
        out.extend(flatten_where_to_operators(sub)?);
      }
    } else {
      out.push(value);
    }
  }
  Ok(out)
}

/// `flattenWhereToOperators(where).some((prop) => Object.keys(prop).some((key) => key === 'near'))`
pub fn has_near_constraint(where_: &JsVal) -> Result<bool> {
  for prop in flatten_where_to_operators(where_)? {
    if object_keys(&prop)?.iter().any(|k| k == "near") {
      return Ok(true);
    }
  }
  Ok(false)
}

/// `fieldShouldBeLocalized({ field, parentIsLocalized })`
pub fn field_should_be_localized(field: &JsVal, parent_is_localized: &JsVal) -> bool {
  field.has("localized") && field.get("localized").truthy() && !parent_is_localized.truthy()
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
) -> Result<Option<FieldByPath>> {
  let mut current_fields = fields.clone();
  let mut current_field: Option<JsVal> = None;
  let mut segments: std::collections::VecDeque<String> = path.split('.').map(str::to_string).collect();
  let mut path_has_localized = false;
  let mut localized_path = localized_path.to_string();

  while let Some(segment) = segments.pop_front() {
    localized_path = if localized_path.is_empty() { segment.clone() } else { format!("{localized_path}.{segment}") };
    let Some(field) = find_by_name(&current_fields, &segment)? else { return Ok(None) };

    if field.get("localized").truthy() {
      path_has_localized = true;
      localized_path.push_str(".<locale>");
    }
    if field.has("flattenedFields") {
      current_fields = field.get("flattenedFields").clone();
    }
    if let Some(config) = config.filter(|c| c.truthy())
      && include_relationships
      && is_relationship_or_upload(&field)
      && !is_array(field.get("relationTo"))
    {
      let relation_to = field.get("relationTo");
      let flattened = read(config, "collections")?
        .items()
        .find(|e| e.get("slug").strict_eq(relation_to))
        .map(|c| c.get("flattenedFields").clone())
        .unwrap_or_default();
      if flattened.truthy() {
        current_fields = flattened;
      }
      if segments.len() == 1 && segments[0] == "id" {
        return Ok(Some(FieldByPath { field, localized_path, path_has_localized }));
      }
    }
    if field.has("blocks") && !segments.is_empty() {
      let block_slug = segments[0].clone();
      let config_block = config
        .map(|c| c.get("blocks"))
        .and_then(|blocks| blocks.items().find(|b| is_str(b.get("slug"), &block_slug)).cloned());
      let block = match config_block {
        Some(block) => Some(block),
        None => read(&field, "blocks")?
          .items()
          .find(|b| !matches!(b, JsVal::Str(_)) && is_str(b.get("slug"), &block_slug))
          .cloned(),
      };
      if let Some(block) = block {
        segments.pop_front();
        localized_path = format!("{localized_path}.{block_slug}");
        if segments.is_empty() {
          return Ok(None);
        }
        let rest: Vec<String> = segments.into_iter().collect();
        return get_field_by_path(config, block.get("flattenedFields"), include_relationships, &localized_path, &rest.join("."));
      }
    }
    current_field = Some(field);
  }
  Ok(current_field.map(|field| FieldByPath { field, localized_path, path_has_localized }))
}

/// `fields.find((each) => each.name === name)` (`TypeError` when `fields` is not an array).
pub fn find_by_name(fields: &JsVal, name: &str) -> Result<Option<JsVal>> {
  match fields {
    JsVal::Arr(items) => Ok(items.iter().find(|f| is_str(f.get("name"), name)).cloned()),
    JsVal::Undefined | JsVal::Null => {
      read(fields, "find")?;
      Ok(None)
    }
    _ => Err(EngineError::new("TypeError", "fields.find is not a function")),
  }
}

pub fn is_relationship_or_upload(field: &JsVal) -> bool {
  matches!(field.get("type").as_str(), Some("relationship" | "upload"))
}

/// Rewrites a value so its object keys are in JS order (array indices first, ascending): what a
/// JS object built from it holds. Used before comparing results with recorded JS values.
pub fn js_key_order(value: &JsVal) -> JsVal {
  if value.typed().is_some() || value.bson().is_some() || value.as_host_object().is_some() {
    return value.clone();
  }
  match value {
    JsVal::Arr(a) => JsVal::arr(a.iter().map(js_key_order).collect()),
    JsVal::Obj(o) => {
      let mut out = Obj::new();
      for (k, v) in o.iter() {
        set_key(&mut out, k.clone(), js_key_order(v));
      }
      JsVal::obj(out)
    }
    other => other.clone(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn set_key_orders_indices_first() {
    let mut o = Obj::new();
    set_key(&mut o, "b".into(), num(1.0));
    set_key(&mut o, "10".into(), num(2.0));
    set_key(&mut o, "2".into(), num(3.0));
    set_key(&mut o, "b".into(), num(4.0));
    assert_eq!(o.keys().cloned().collect::<Vec<_>>(), vec!["2", "10", "b"]);
  }

  #[test]
  fn relational_comparison() {
    assert!(lt(&s("a"), &s("b")).unwrap());
    assert!(!lt(&JsVal::Undefined, &num(1.0)).unwrap());
    assert!(!gt(&JsVal::Undefined, &num(1.0)).unwrap());
    assert!(lt(&num(2.0), &s("10")).unwrap());
    assert!(!lt(&s("2"), &s("10")).unwrap());
    // U+FF61 sorts after U+1F600 by UTF-16 code units, before it by code points
    assert!(lt(&s("\u{1F600}"), &s("\u{FF61}")).unwrap());
    assert!(lt(&JsVal::date(1.0), &JsVal::date(2.0)).unwrap());
  }

  #[test]
  fn add_follows_js() {
    assert_eq!(add(&s("5"), &num(1.0)).unwrap().as_str(), Some("51"));
    assert_eq!(add(&num(5.0), &num(1.0)).unwrap().as_num(), Some(6.0));
    assert_eq!(add(&JsVal::Undefined, &num(1.0)).unwrap().as_num().map(f64::is_nan), Some(true));
  }

  #[test]
  fn replace_patterns() {
    assert_eq!(replace_first("a.<locale>.b.<locale>", "<locale>", "en"), "a.en.b.<locale>");
    assert_eq!(replace_first("a.<locale>", "<locale>", "$&$$"), "a.<locale>$");
    assert_eq!(replace_first("a.<locale>", "<locale>", "undefined"), "a.undefined");
  }
}
