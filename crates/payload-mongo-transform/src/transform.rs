//! `transform` (packages/db-mongodb/src/utilities/transform.ts) with the generic `traverseFields`
//! it runs on (packages/payload/src/utilities/traverseFields.ts, as called by `transform`:
//! `fillEmpty: false`, `leavesFirst: false`, and a callback that never returns truthy, so the
//! dotted-key fallback runs after every traversal of an object).
//!
//! Everything happens in place on [`Val`]s, in the order of the TS, including the partial
//! mutations made before an error is thrown.

use payload_engine::error::{EngineError, Result};
use payload_engine::fields::{field_affects_data, field_has_sub_fields, field_should_be_localized, tab_has_name};
use payload_engine::js::{JsVal, date_to_iso_string};

use crate::flatten::FlattenCache;
use crate::value::{Val, type_error, unsupported};

/// `operation` of `transform`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
  /// Sanitizes ObjectIDs and Dates to strings.
  Read,
  /// Sanitizes string relationships to ObjectIDs.
  Write,
}

/// What `transform` reads from the adapter (`adapter.payload.config` and the flattened-fields
/// cache, kept for the engine's lifetime).
pub struct TransformEnv {
  /// The sanitized config (`adapter.payload.config`): `collections`, `localization`, `blocks`.
  pub config: JsVal,
  flatten_cache: FlattenCache,
}

impl TransformEnv {
  pub fn new(config: JsVal) -> Self {
    TransformEnv { config, flatten_cache: FlattenCache::default() }
  }
}

/// The non-data arguments of `transform`.
pub struct TransformArgs<'a> {
  pub operation: Operation,
  /// `fields` (a `Field[]` array value).
  pub fields: &'a JsVal,
  /// `globalSlug` (only its truthiness and value are used).
  pub global_slug: Option<&'a JsVal>,
  /// `parentIsLocalized` (default `false`).
  pub parent_is_localized: bool,
  /// `validateRelationships` (default `true`).
  pub validate_relationships: bool,
  /// `adapter.useBigIntForNumberIDs`, read at call time.
  pub use_big_int_for_number_ids: bool,
  /// `adapter.allowAdditionalKeys`, read at call time.
  pub allow_additional_keys: bool,
  /// `Date.now()` for `new Date().toISOString()` (write: `updatedAt`), called once per document
  /// that gets a new `updatedAt`.
  pub now: &'a dyn Fn() -> f64,
}

/// `Date.now()` from the system clock.
pub fn system_now() -> f64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as f64)
    .unwrap_or(0.0)
}

/// The update operator objects `transform` fills (`$inc`, `$push`, `$addToSet`, `$pull`), as
/// passed by the caller (`undefined` when not passed).
#[derive(Clone, Debug, Default)]
pub struct Operators {
  pub inc: Val,
  pub push: Val,
  pub add_to_set: Val,
  pub pull: Val,
}

struct Cx<'a> {
  env: &'a TransformEnv,
  args: &'a TransformArgs<'a>,
  ops: &'a Operators,
  /// Nesting of `traverseFields` / `stripFields` calls (every expanded dotted key adds one).
  depth: std::cell::Cell<usize>,
}

/// Where V8 would long have thrown for the recursion (`traverseFields` recurses once per dotted
/// key it expands), the engine throws the same `RangeError` instead of exhausting its stack.
const MAX_TRAVERSAL_DEPTH: usize = 1000;

impl Cx<'_> {
  fn enter(&self) -> Result<DepthGuard<'_>> {
    if self.depth.get() >= MAX_TRAVERSAL_DEPTH {
      return Err(EngineError::new("RangeError", "Maximum call stack size exceeded"));
    }
    self.depth.set(self.depth.get() + 1);
    Ok(DepthGuard(&self.depth))
  }
}

struct DepthGuard<'a>(&'a std::cell::Cell<usize>);

impl Drop for DepthGuard<'_> {
  fn drop(&mut self) {
    self.0.set(self.0.get() - 1);
  }
}

/// `transform(args)`: mutates `data` (and the operator objects) in place. Returns the TS return
/// value (`null` for falsy data, `undefined` otherwise).
pub fn transform_val(env: &TransformEnv, args: &TransformArgs<'_>, data: &Val, ops: &Operators) -> Result<Val> {
  let cx = Cx { env, args, ops, depth: std::cell::Cell::new(0) };
  transform_one(&cx, data, args.parent_is_localized)
}

fn transform_one(cx: &Cx<'_>, data: &Val, parent_is_localized: bool) -> Result<Val> {
  let _depth = cx.enter()?;
  if !data.truthy() {
    return Ok(Val::Null);
  }
  if data.is_array() {
    // `for (const item of data)`: the live array, re-reading its length; the recursive call does
    // not pass `parentIsLocalized` (upstream).
    let mut i = 0;
    while i < data.len() {
      let item = data.prop(&i.to_string())?;
      transform_one(cx, &item, false)?;
      i += 1;
    }
    return Ok(Val::Undefined);
  }
  let args = cx.args;

  if args.operation == Operation::Read {
    data.delete("__v")?;
    let id = data.prop("_id")?;
    let id = if id.truthy() { id } else { data.prop("id")? };
    data.set("id", id)?;
    data.delete("_id")?;
    let id = data.prop("id")?;
    if let Some(hex) = object_id_hex(&id)? {
      data.set("id", Val::Str(hex.into()))?;
    }
    if args.use_big_int_for_number_ids {
      let id = data.prop("id")?;
      if id.type_of() == "bigint" {
        data.set("id", bigint_to_number(&id))?;
      }
    }
    if !args.allow_additional_keys {
      let flattened = cx.env.flatten_cache.flatten(args.fields)?;
      strip_fields(cx, data, &flattened, false, &["id", "globalType"])?;
    }
  }

  if args.operation == Operation::Write
    && let Some(slug) = args.global_slug
    && slug.truthy()
  {
    data.set("globalType", import_config_primitive(slug)?)?;
  }

  traverse_fields(cx, args.fields, parent_is_localized, "", &Val::new_obj(), data)?;

  if args.operation == Operation::Write {
    let updated_at = data.prop("updatedAt")?;
    if updated_at.is_undefined() {
      let iso = date_to_iso_string((args.now)()).ok_or_else(|| EngineError::new("RangeError", "Invalid time value"))?;
      data.set("updatedAt", Val::Str(iso.into()))?;
    } else if matches!(updated_at, Val::Null) {
      data.delete("updatedAt")?;
    }
  }
  Ok(Val::Undefined)
}

/// A config primitive as data (`globalSlug`).
fn import_config_primitive(v: &JsVal) -> Result<Val> {
  crate::value::Importer::default().import(v)
}

/// `Number(bigint)`
fn bigint_to_number(v: &Val) -> Val {
  let digits = v.as_leaf().and_then(JsVal::as_bigint).map(|d| d.to_string()).unwrap_or_default();
  Val::Num(digits.parse::<f64>().unwrap_or(f64::NAN))
}

/// `isObjectID(value) ? value.toHexString() : undefined`
pub(crate) fn object_id_hex(v: &Val) -> Result<Option<String>> {
  if let Some(hex) = v.object_id_hex() {
    return Ok(Some(hex));
  }
  if let Val::Obj(_) = v
    && v.has("_bsontype")?
    && v.prop("_bsontype")?.as_str() == Some("ObjectId")
    && v.has("toHexString")?
    && v.prop("toHexString")?.type_of() == "function"
  {
    return Err(unsupported("an ObjectId-like plain object with a JS `toHexString` function"));
  }
  Ok(None)
}

/// A field config property used as a property key (`String(field.name)`).
fn key_of(v: &JsVal) -> String {
  match v {
    JsVal::Str(s) => s.to_string(),
    other => other.to_js_string(),
  }
}

fn field_type(field: &JsVal) -> &str {
  field.get("type").as_str().unwrap_or("")
}

fn localization_enabled(cx: &Cx<'_>) -> bool {
  cx.env.config.get("localization").truthy()
}

fn some_fields(fields: &JsVal) -> Result<&[JsVal]> {
  fields.as_arr().ok_or_else(|| type_error("fields.some is not a function"))
}

// ---------------------------------------------------------------------------------------------
// stripFields

fn strip_fields(cx: &Cx<'_>, data: &Val, fields: &JsVal, parent_is_localized: bool, reserved_keys: &[&str]) -> Result<()> {
  let _depth = cx.enter()?;
  let config = &cx.env.config;
  for k in data.for_in_keys()? {
    // `for...in` skips keys deleted during the loop
    if !data.for_in_still_visits(&k)? {
      continue;
    }
    let is_field = some_fields(fields)?.iter().any(|field| field.get("name").as_str() == Some(k.as_str()));
    if !is_field && !reserved_keys.contains(&k.as_str()) {
      data.delete(&k)?;
    }
  }

  let fields = fields.as_arr().ok_or_else(|| type_error("fields is not iterable"))?;
  for field in fields {
    let mut reserved: Vec<&str> = Vec::new();
    let name = key_of(field.get("name"));
    let field_data = data.prop(&name)?;
    if !field_data.is_object() {
      continue;
    }
    let should_localize = field_should_be_localized(field, parent_is_localized);
    let ftype = field_type(field);
    if ftype == "blocks" {
      reserved.push("blockType");
    }
    if !(field.has("flattenedFields") || field.has("blocks")) {
      continue;
    }
    let nested_localized = parent_is_localized || field.get("localized").truthy();

    if should_localize && localization_enabled(cx) {
      let locale_codes = config.path(&["localization", "localeCodes"]);
      for locale_key in field_data.for_in_keys()? {
        if !field_data.for_in_still_visits(&locale_key)? {
          continue;
        }
        let is_locale = locale_codes
          .as_arr()
          .ok_or_else(|| type_error("Cannot read properties of undefined (reading 'some')"))?
          .iter()
          .any(|code| code.as_str() == Some(locale_key.as_str()));
        if !is_locale {
          field_data.delete(&locale_key)?;
          continue;
        }
        let locale_data = field_data.prop(&locale_key)?;
        if !locale_data.is_object() {
          continue;
        }
        if ftype == "array" || ftype == "blocks" {
          if !locale_data.is_array() {
            continue;
          }
          if strip_rows(cx, &locale_data, field, nested_localized, &reserved)? {
            field_data.set(&locale_key, filter_truthy(&locale_data))?;
          }
          continue;
        }
        strip_fields(cx, &locale_data, field.get("flattenedFields"), nested_localized, &reserved)?;
      }
      continue;
    }

    if ftype == "array" || ftype == "blocks" {
      if !field_data.is_array() {
        continue;
      }
      if strip_rows(cx, &field_data, field, nested_localized, &reserved)? {
        data.set(&name, filter_truthy(&field_data))?;
      }
      continue;
    }
    strip_fields(cx, &field_data, field.get("flattenedFields"), nested_localized, &reserved)?;
  }
  Ok(())
}

/// The row loop of `stripFields` for array / blocks data; returns `hasNull`.
fn strip_rows(cx: &Cx<'_>, rows: &Val, field: &JsVal, parent_is_localized: bool, reserved: &[&str]) -> Result<bool> {
  let mut has_null = false;
  let mut i = 0;
  while i < rows.len() {
    let index = i.to_string();
    i += 1;
    let row = rows.prop(&index)?;
    if !row.is_object() {
      rows.set(&index, Val::Null)?;
      has_null = true;
      continue;
    }
    let fields = if field_type(field) == "array" {
      field.get("flattenedFields").clone()
    } else {
      let block_type = row.prop("blockType")?;
      let block_or_slug = field
        .get("blocks")
        .as_arr()
        .ok_or_else(|| type_error("Cannot read properties of undefined (reading 'find')"))?
        .iter()
        .find(|each| {
          let slug = if each.as_str().is_some() { *each } else { each.get("slug") };
          block_type.strict_eq_js(slug)
        })
        .cloned();
      let maybe_block = match &block_or_slug {
        Some(JsVal::Str(slug)) => cx
          .env
          .config
          .get("blocks")
          .items()
          .find(|each| each.get("slug").as_str() == Some(slug))
          .cloned(),
        other => other.clone(),
      };
      match maybe_block {
        Some(block) if block.truthy() => block.get("flattenedFields").clone(),
        _ => {
          rows.set(&index, Val::Null)?;
          has_null = true;
          JsVal::Undefined
        }
      }
    };
    if !fields.truthy() {
      continue;
    }
    strip_fields(cx, &row, &fields, parent_is_localized, reserved)?;
  }
  Ok(has_null)
}

/// `array.filter(Boolean)`
fn filter_truthy(rows: &Val) -> Val {
  Val::new_arr(rows.items().into_iter().filter(Val::truthy).collect())
}

// ---------------------------------------------------------------------------------------------
// traverseFields

fn traverse_fields(
  cx: &Cx<'_>,
  fields: &JsVal,
  parent_is_localized: bool,
  parent_path: &str,
  parent_ref: &Val,
  r: &Val,
) -> Result<()> {
  let _depth = cx.enter()?;
  // The fallback re-runs `traverseFields` with the same arguments for every dotted key it expands,
  // from inside its `Object.keys(ref).forEach`. That recursion is emulated with a heap stack of
  // the pending `forEach` loops (key snapshot, position): same order of effects, no native stack.
  let mut pending: Vec<(Vec<String>, usize)> = Vec::new();
  'call: loop {
    traverse_fields_pass(cx, fields, parent_is_localized, parent_path, parent_ref, r)?;
    if r.is_object() {
      if pending.len() >= MAX_TRAVERSAL_DEPTH {
        return Err(EngineError::new("RangeError", "Maximum call stack size exceeded"));
      }
      pending.push((r.own_keys()?, 0));
    }
    while let Some((keys, position)) = pending.last_mut() {
      while *position < keys.len() {
        let key = std::mem::take(&mut keys[*position]);
        *position += 1;
        if expand_own_dotted_key(&key, r)? {
          continue 'call;
        }
      }
      pending.pop();
    }
    return Ok(());
  }
}

/// The `fields.some(...)` part of `traverseFields` (callbacks and recursion into sub-fields).
fn traverse_fields_pass(
  cx: &Cx<'_>,
  fields: &JsVal,
  parent_is_localized: bool,
  parent_path: &str,
  parent_ref: &Val,
  r: &Val,
) -> Result<()> {
  for field in some_fields(fields)? {
    if !r.is_object() {
      continue;
    }
    sanitize(cx, field, parent_is_localized, parent_path, parent_ref, r)?;

    let mut current_ref = r.clone();
    let mut current_parent_ref = parent_ref.clone();
    let ftype = field_type(field);

    if ftype == "tabs" && field.has("tabs") {
      let tabs = field.get("tabs").as_arr().ok_or_else(|| type_error("field.tabs is not iterable"))?;
      for tab in tabs {
        let tab_is_localized = field_should_be_localized(tab, parent_is_localized);
        let mut tab_ref = r.clone();
        if tab.has("name") && tab.get("name").truthy() {
          let tab_name = key_of(tab.get("name"));
          let value = r.prop(&tab_name)?;
          if !value.is_object() {
            continue;
          }
          // the callback for `{ ...tab, type: 'tab' }` changes nothing in `transform`
          tab_ref = tab_ref.prop(&tab_name)?;
          if tab_is_localized {
            for key in tab_ref.for_in_keys()? {
              if !tab_ref.for_in_still_visits(&key)? {
                continue;
              }
              let locale_ref = tab_ref.prop(&key)?;
              if locale_ref.is_object() {
                traverse_fields(
                  cx,
                  tab.get("fields"),
                  true,
                  &format!("{parent_path}{tab_name}."),
                  &current_parent_ref,
                  &locale_ref,
                )?;
              }
            }
          }
        }
        if !tab_is_localized {
          let path = if tab_has_name(tab) { format!("{parent_path}{}.", key_of(tab.get("name"))) } else { parent_path.to_string() };
          traverse_fields(cx, tab.get("fields"), parent_is_localized, &path, &current_parent_ref, &tab_ref)?;
        }
      }
      continue;
    }

    if ftype == "tab" || field_has_sub_fields(field) || ftype == "blocks" {
      let has_name = field.has("name") && field.get("name").truthy();
      let name = key_of(field.get("name"));
      if has_name {
        current_parent_ref = current_ref.clone();
        let value = r.prop(&name)?;
        if !value.truthy() {
          continue;
        }
        current_ref = value;
      }
      let should_localize = field_should_be_localized(field, parent_is_localized);

      if (ftype == "tab" || ftype == "group") && should_localize && current_ref.is_object() {
        if field_affects_data(field) {
          let path = if field.get("name").truthy() { format!("{parent_path}{name}.") } else { parent_path.to_string() };
          for key in current_ref.for_in_keys()? {
            if !current_ref.for_in_still_visits(&key)? {
              continue;
            }
            let locale_ref = current_ref.prop(&key)?;
            if locale_ref.truthy() {
              traverse_fields(cx, field.get("fields"), true, &path, &current_parent_ref, &locale_ref)?;
            }
          }
        } else {
          // upstream passes no `parentPath` here (it defaults to '')
          traverse_fields(cx, field.get("fields"), parent_is_localized, "", &current_parent_ref, &current_ref)?;
        }
        continue;
      }

      if (ftype == "blocks" || ftype == "array") && current_ref.is_object() {
        if should_localize {
          if current_ref.is_array() {
            traverse_rows(cx, &current_ref, field, true, parent_path, &current_parent_ref)?;
          } else {
            for key in current_ref.for_in_keys()? {
              if !current_ref.for_in_still_visits(&key)? {
                continue;
              }
              let locale_data = current_ref.prop(&key)?;
              if !locale_data.is_array() {
                continue;
              }
              traverse_rows(cx, &locale_data, field, true, parent_path, &current_parent_ref)?;
            }
          }
        } else if current_ref.is_array() {
          traverse_rows(cx, &current_ref, field, parent_is_localized, parent_path, &current_parent_ref)?;
        }
      } else if current_ref.is_object() && field.has("fields") {
        let path = if has_name { format!("{parent_path}{name}.") } else { parent_path.to_string() };
        traverse_fields(cx, field.get("fields"), parent_is_localized, &path, &current_parent_ref, &current_ref)?;
      }
    }
  }

  Ok(())
}

/// `traverseArrayOrBlocksField` with `fillEmpty: false`.
fn traverse_rows(
  cx: &Cx<'_>,
  data: &Val,
  field: &JsVal,
  parent_is_localized: bool,
  parent_path: &str,
  parent_ref: &Val,
) -> Result<()> {
  let ftype = field_type(field);
  let nested_localized = parent_is_localized || field.get("localized").truthy();
  let path = format!("{parent_path}{}.", key_of(field.get("name")));
  let mut i = 0;
  while i < data.len() {
    let row = data.prop(&i.to_string())?;
    i += 1;
    let mut fields = JsVal::Undefined;
    let block_type = if ftype == "blocks" && !row.is_nullish() { row.prop("blockType")? } else { Val::Undefined };
    if ftype == "blocks" && block_type.as_str().is_some() {
      let block = cx
        .env
        .config
        .get("blocks")
        .items()
        .find(|b| block_type.strict_eq_js(b.get("slug")))
        .cloned()
        .or_else(|| {
          field.get("blocks").items().find(|b| b.as_str().is_none() && block_type.strict_eq_js(b.get("slug"))).cloned()
        });
      fields = block.map(|b| b.get("fields").clone()).unwrap_or_default();
    } else if ftype == "array" {
      fields = field.get("fields").clone();
    }
    if fields.truthy() {
      traverse_fields(cx, &fields, nested_localized, &path, parent_ref, &row)?;
    }
  }
  Ok(())
}

/// `expandOwnDottedKey({ key, target })` (packages/payload/src/utilities/fieldPath.ts).
fn expand_own_dotted_key(key: &str, target: &Val) -> Result<bool> {
  if !target.has_own(key)? || !key.contains('.') {
    return Ok(false);
  }
  if key.split('.').any(|segment| segment == "__proto__") {
    target.delete(key)?;
    return Ok(false);
  }
  let dot = key.find('.').unwrap_or(0);
  let field_name = &key[..dot];
  let remaining_path = &key[dot + 1..];
  if !target.has_own(field_name)? || !target.prop(field_name)?.truthy() {
    set_own_property(target, field_name, Val::new_obj())?;
  }
  let nested = target.prop(field_name)?;
  set_own_property(&nested, remaining_path, target.prop(key)?)?;
  target.delete(key)?;
  Ok(true)
}

/// `setOwnProperty({ key, target, value })`: `Reflect.set` for own / absent keys, otherwise an
/// own data property shadowing the inherited one (both an own property here).
fn set_own_property(target: &Val, key: &str, value: Val) -> Result<()> {
  if !target.is_object() && !matches!(target, Val::Builtin(_)) && target.type_of() != "function" {
    // `key in target` on a primitive
    target.has(key)?;
  }
  if key == "__proto__" {
    return Err(unsupported("setOwnProperty of `__proto__`"));
  }
  target.set(key, value)
}

// ---------------------------------------------------------------------------------------------
// the `sanitize` callback

fn sanitize(cx: &Cx<'_>, field: &JsVal, parent_is_localized: bool, parent_path: &str, parent_ref: &Val, r: &Val) -> Result<()> {
  if !r.is_object() {
    return Ok(());
  }
  let ops = cx.ops;
  let config = &cx.env.config;
  let write = cx.args.operation == Operation::Write;
  let read = cx.args.operation == Operation::Read;
  let ftype = field_type(field);
  let name = key_of(field.get("name"));
  let localized = || localization_enabled(cx) && field_should_be_localized(field, parent_is_localized);
  let path = format!("{parent_path}{name}");
  let is_relationship = ftype == "relationship" || ftype == "upload";
  let has_many = field.has("hasMany") && field.get("hasMany").truthy();

  if ops.inc.truthy() && ftype == "number" && write && r.has(&name)? && r.prop(&name)?.truthy() {
    let value = r.prop(&name)?;
    if value.is_object() && value.has("$inc")? && value.prop("$inc")?.type_of() == "number" {
      ops.inc.set(&path, value.prop("$inc")?)?;
      r.delete(&name)?;
      clear_empty_container(parent_ref, r)?;
    }
  }

  if ops.push.truthy() && ftype == "array" && write && r.has(&name)? && r.prop(&name)?.truthy() {
    let value = r.prop(&name)?;
    if value.is_object() && (value.has("$push")? || (localized() && some_locale_has(&value, "$push")?)) {
      if localized() {
        let mut has_locale_operations = false;
        for (locale_key, locale_value) in value.entries()? {
          if locale_value.is_object() && locale_value.has("$push")? {
            has_locale_operations = true;
            let push = locale_value.prop("$push")?;
            let key = format!("{path}.{locale_key}");
            if push.is_array() {
              ops.push.set(&key, Val::obj_from(vec![("$each", push)]))?;
            } else if push.type_of() == "object" {
              ops.push.set(&key, push)?;
            }
          }
        }
        if has_locale_operations {
          r.delete(&name)?;
          clear_empty_container(parent_ref, r)?;
        }
      } else if value.has("$push")? {
        let push = value.prop("$push")?;
        if push.is_array() {
          ops.push.set(&path, Val::obj_from(vec![("$each", push)]))?;
        } else if push.type_of() == "object" {
          ops.push.set(&path, push)?;
        }
        r.delete(&name)?;
        clear_empty_container(parent_ref, r)?;
      }
    }
  }

  for (target, operand, wrapper) in [(&ops.add_to_set, "$push", "$each"), (&ops.pull, "$remove", "$in")] {
    if target.truthy() && is_relationship && has_many && write && r.has(&name)? && r.prop(&name)?.truthy() {
      let value = r.prop(&name)?;
      if value.is_object() && (value.has(operand)? || (localized() && some_locale_has(&value, operand)?)) {
        if localized() {
          let mut has_locale_operations = false;
          for (locale_key, locale_value) in value.entries()? {
            if locale_value.is_object() && locale_value.has(operand)? {
              has_locale_operations = true;
              let items = as_items(locale_value.prop(operand)?);
              let processed = process_relationship_values(cx, &items, field)?;
              target.set(&format!("{path}.{locale_key}"), Val::obj_from(vec![(wrapper, processed)]))?;
            }
          }
          if has_locale_operations {
            r.delete(&name)?;
            clear_empty_container(parent_ref, r)?;
          }
        } else if value.has(operand)? {
          let items = as_items(value.prop(operand)?);
          let processed = process_relationship_values(cx, &items, field)?;
          target.set(&path, Val::obj_from(vec![(wrapper, processed)]))?;
          r.delete(&name)?;
          clear_empty_container(parent_ref, r)?;
        }
      }
    }
  }

  if ftype == "date" && read && r.has(&name)? && r.prop(&name)?.truthy() {
    if localized() {
      let field_ref = r.prop(&name)?;
      if !field_ref.is_object() {
        return Ok(());
      }
      let codes = config.path(&["localization", "localeCodes"]);
      for locale in codes.as_arr().ok_or_else(|| type_error("config.localization.localeCodes is not iterable"))? {
        let locale_key = key_of(locale);
        sanitize_date(&name, Some((locale, &locale_key)), &field_ref, field_ref.prop(&locale_key)?)?;
      }
    } else {
      sanitize_date(&name, None, r, r.prop(&name)?)?;
    }
  }

  if is_relationship || (read && ftype == "join") {
    if !r.prop(&name)?.truthy() {
      return Ok(());
    }
    if localized() {
      let locales = config.path(&["localization", "locales"]);
      let field_ref = r.prop(&name)?;
      if field_ref.type_of() != "object" {
        return Ok(());
      }
      for locale in locales.as_arr().ok_or_else(|| type_error("config.localization.locales is not iterable"))? {
        if locale.is_nullish() {
          return Err(type_error(format!("Cannot destructure property 'code' of '{}' as it is {}.", key_of(locale), key_of(locale))));
        }
        let code = locale.get("code");
        let code_key = key_of(code);
        let value = field_ref.prop(&code_key)?;
        if value.truthy() {
          sanitize_relationship(cx, field, Some((code, &code_key)), &field_ref, value)?;
        }
      }
    } else {
      sanitize_relationship(cx, field, None, r, r.prop(&name)?)?;
    }
  }
  Ok(())
}

/// `Array.isArray(x) ? x : [x]`
fn as_items(v: Val) -> Val {
  if v.is_array() { v } else { Val::new_arr(vec![v]) }
}

/// `Object.values(value).some((localeValue) => localeValue && typeof localeValue === 'object' && key in localeValue)`
fn some_locale_has(value: &Val, key: &str) -> Result<bool> {
  for (_, locale_value) in value.entries()? {
    if locale_value.is_object() && locale_value.has(key)? {
      return Ok(true);
    }
  }
  Ok(false)
}

/// `clearEmptyContainer()`: sets the key of `parentRef` holding `ref` to `undefined` when `ref`
/// has no own keys left.
fn clear_empty_container(parent_ref: &Val, r: &Val) -> Result<()> {
  if !parent_ref.is_object() || !r.is_object() {
    return Ok(());
  }
  if !r.own_keys()?.is_empty() {
    return Ok(());
  }
  for key in parent_ref.own_keys()? {
    if parent_ref.prop(&key)?.strict_eq(r) {
      // `if (containerKey)`: an empty key is falsy
      if !key.is_empty() {
        parent_ref.set(&key, Val::Undefined)?;
      }
      break;
    }
  }
  Ok(())
}

fn sanitize_date(name: &str, locale: Option<(&JsVal, &str)>, r: &Val, value: Val) -> Result<()> {
  if !value.truthy() {
    return Ok(());
  }
  let value = match value.as_leaf().and_then(JsVal::as_date) {
    Some(ms) => Val::Str(date_to_iso_string(ms).ok_or_else(|| EngineError::new("RangeError", "Invalid time value"))?.into()),
    None => value,
  };
  match locale {
    Some((code, key)) if code.truthy() => r.set(key, value),
    _ => r.set(name, value),
  }
}

/// `config.collections?.find(({ slug }) => slug === value)`
fn find_collection<'c>(config: &'c JsVal, matches: impl Fn(&JsVal) -> bool) -> Option<&'c JsVal> {
  config.get("collections").items().find(|c| matches(c.get("slug")))
}

/// `isValidRelationObject(value)`
fn is_valid_relation_object(v: &Val) -> Result<bool> {
  Ok(v.is_object() && v.has("relationTo")? && v.has("value")?)
}

fn relation_object(cx: &Cx<'_>, val: &Val, related: &JsVal) -> Result<Val> {
  let relation_to = val.prop("relationTo")?;
  let value = convert_relationship_value(cx, related, val.prop("value")?)?;
  Ok(Val::obj_from(vec![("relationTo", relation_to), ("value", value)]))
}

/// `processRelationshipValues(items, field, ...)`
fn process_relationship_values(cx: &Cx<'_>, items: &Val, field: &JsVal) -> Result<Val> {
  let config = &cx.env.config;
  let relation_to = field.get("relationTo");
  let mut out = Vec::new();
  for item in items.items() {
    // `items.map(...)` keeps holes without calling the callback
    if item.is_hole() {
      out.push(item);
      continue;
    }
    if relation_to.as_arr().is_some() && is_valid_relation_object(&item)? {
      let target = item.prop("relationTo")?;
      match find_collection(config, |slug| target.strict_eq_js(slug)) {
        Some(related) => out.push(relation_object(cx, &item, related)?),
        None => out.push(item),
      }
      continue;
    }
    if relation_to.as_str().is_some()
      && let Some(related) = find_collection(config, |slug| slug.strict_eq(relation_to))
    {
      out.push(convert_relationship_value(cx, related, item)?);
      continue;
    }
    out.push(item);
  }
  Ok(Val::new_arr(out))
}

/// `convertRelationshipValue({ relatedCollection, value, ... })`
fn convert_relationship_value(cx: &Cx<'_>, related: &JsVal, value: Val) -> Result<Val> {
  let fields = related.get("fields");
  let custom_id_field = fields
    .as_arr()
    .ok_or_else(|| type_error("Cannot read properties of undefined (reading 'find')"))?
    .iter()
    .find(|f| field_affects_data(f) && f.get("name").as_str() == Some("id"));

  if cx.args.operation == Operation::Read {
    if let Some(hex) = object_id_hex(&value)? {
      return Ok(Val::Str(hex.into()));
    }
    if custom_id_field.is_some_and(|f| f.get("type").as_str() == Some("number"))
      && value.type_of() == "bigint"
      && cx.args.use_big_int_for_number_ids
    {
      return Ok(bigint_to_number(&value));
    }
    return Ok(value);
  }

  if custom_id_field.is_some() {
    return Ok(value);
  }
  if let Some(s) = value.as_str() {
    return match JsVal::object_id_from_hex(s) {
      Some(id) => Ok(Val::object_id(id)),
      None if cx.args.validate_relationships => Err(bson_error()),
      None => Ok(value),
    };
  }
  Ok(value)
}

/// The `BSONError` `new ObjectId(string)` throws for a string that is not 24 hex digits (bson 7).
pub fn bson_error() -> EngineError {
  EngineError::new("BSONError", "input must be a 24 character hex string, 12 byte Uint8Array, or an integer")
}

fn sanitize_relationship(cx: &Cx<'_>, field: &JsVal, locale: Option<(&JsVal, &str)>, r: &Val, value: Val) -> Result<()> {
  let config = &cx.env.config;
  if field_type(field) == "join" {
    if cx.args.operation == Operation::Read && value.is_object() && value.has("docs")? && value.prop("docs")?.is_array() {
      let mut i = 0;
      loop {
        let docs = value.prop("docs")?;
        if i >= docs.len() {
          break;
        }
        let index = i.to_string();
        i += 1;
        let item = docs.prop(&index)?;
        if let Some(hex) = object_id_hex(&item)? {
          docs.set(&index, Val::Str(hex.into()))?;
        } else if field.get("collection").as_arr().is_some() && item.truthy() {
          let parsed = crate::value::json_round_trip(&item)?;
          if parsed.is_undefined() {
            // JSON.parse(undefined)
            return Err(EngineError::new("SyntaxError", "\"undefined\" is not valid JSON"));
          }
          docs.set(&index, parsed)?;
        }
      }
    }
    return Ok(());
  }

  let relation_to = field.get("relationTo");
  let has_many_relations = relation_to.as_str().is_none();
  let mut related = if has_many_relations { None } else { find_collection(config, |slug| slug.strict_eq(relation_to)) };

  let result = if value.is_array() {
    let mut out = Vec::new();
    for val in value.items() {
      // `value.map(...)` keeps holes; `null` / `undefined` entries are returned as they are
      if val.is_nullish() {
        out.push(val);
        continue;
      }
      if is_valid_relation_object(&val)? {
        let target = val.prop("relationTo")?;
        if let Some(single) = find_collection(config, |slug| target.strict_eq_js(slug)) {
          out.push(relation_object(cx, &val, single)?);
          continue;
        }
      }
      if let Some(related) = related {
        out.push(convert_relationship_value(cx, related, val)?);
        continue;
      }
      out.push(val);
    }
    Val::new_arr(out)
  } else if is_valid_relation_object(&value)? {
    let target = value.prop("relationTo")?;
    related = find_collection(config, |slug| target.strict_eq_js(slug));
    match related {
      Some(related) => relation_object(cx, &value, related)?,
      None => value,
    }
  } else if let Some(related) = related {
    convert_relationship_value(cx, related, value)?
  } else {
    value
  };

  match locale {
    Some((code, key)) if code.truthy() => r.set(key, result),
    _ => r.set(&key_of(field.get("name")), result),
  }
}
