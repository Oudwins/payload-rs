//! `validateUniqueConstraints` of the all-locales publish validation (ops.rs
//! `validate_all_locales`; collections/operations/utilities/validateUniqueConstraints.ts): which
//! `fieldValueExists` lookups a pass makes. The lookups read the database (a `payload.find` per
//! unique value, outside the operation's transaction, `limit: 2`); the prepare stays pure and
//! returns them, the operation drivers run them before any statement and bail on a conflict (the
//! exact lane then throws upstream's `ValidationError`).

use payload_engine::js::{JsVal, Obj as JsObj};

use super::Bail;
use super::plan::{Field, Kind};
use super::user_fn::deep_merge;

/// One `fieldValueExists({ field: path, locale, value })` of a pass.
#[derive(Clone, Debug)]
pub struct UniqueLookup {
  pub path: String,
  pub locale: String,
  pub value: JsVal,
}

/// The lookups of one pass: `traverseFields` (`fillEmpty: false`) over
/// `deepMergeWithSourceArraysIgnoringUndefined(originalDoc, processedData)`, one per unique field
/// with a value that is not `null` / `undefined`, in traversal order.
pub fn pass_lookups(fields: &[Field], original_doc: &JsVal, processed: &JsVal, locale: &str, out: &mut Vec<UniqueLookup>) -> Result<(), Bail> {
  let merged = deep_merge(original_doc, &without_undefined(processed))?;
  collect(fields, &merged, "", locale, out)
}

/// `removeUndefinedProperties` (payload utilities/deepMerge.ts): arrays mapped, plain objects
/// without their `undefined` properties, anything else as it is.
fn without_undefined(value: &JsVal) -> JsVal {
  if is_special(value) {
    return value.clone();
  }
  match value {
    JsVal::Arr(items) => JsVal::arr(items.iter().map(without_undefined).collect()),
    JsVal::Obj(props) => {
      let mut out = JsObj::new();
      for (key, item) in props.iter() {
        if !item.is_undefined() {
          out.insert(key.clone(), without_undefined(item));
        }
      }
      JsVal::obj(out)
    }
    _ => value.clone(),
  }
}

fn is_special(value: &JsVal) -> bool {
  value.typed().is_some() || value.bson().is_some() || value.as_host_object().is_some()
}

/// One level of upstream's `traverseFields` with `validateUniqueConstraints`' callback on `level`
/// (an object). Shapes whose traversal the prepare does not follow bail: rows of arrays / blocks
/// and localized groups / tabs holding a unique field, dotted keys (the traversal's
/// `expandOwnDottedKey` fallback runs at every level).
fn collect(fields: &[Field], level: &JsVal, parent_path: &str, locale: &str, out: &mut Vec<UniqueLookup>) -> Result<(), Bail> {
  let Some(props) = level.as_obj().filter(|_| !is_special(level)) else {
    return Ok(());
  };
  if props.keys().any(|key| key.contains('.')) {
    return Err(Bail::new("drafts:localizedPublish:unique:dotted"));
  }
  for field in fields {
    if field.affects_data() && field.unique {
      let name = field.name.as_deref().unwrap_or_default();
      let value = level.get(name);
      if !value.is_nullish() {
        out.push(UniqueLookup { path: format!("{parent_path}{name}"), locale: locale.to_string(), value: value.clone() });
      }
    }
    if !field.has_unique_below() {
      continue;
    }
    match field.kind {
      Kind::Tabs => collect(&field.tabs, level, parent_path, locale, out)?,
      Kind::Group | Kind::Tab if field.name.is_some() => {
        let name = field.name.as_deref().unwrap_or_default();
        let value = level.get(name);
        if !value.truthy() {
          continue;
        }
        if field.localized || matches!(value, JsVal::Arr(_)) || is_special(value) {
          return Err(Bail::new("drafts:localizedPublish:unique:group"));
        }
        collect(&field.fields, value, &format!("{parent_path}{name}."), locale, out)?;
      }
      Kind::Array | Kind::Blocks => {
        // rows (or locale-keyed rows) holding unique fields: not followed
        let name = field.name.as_deref().unwrap_or_default();
        let value = level.get(name);
        let is_empty = value.as_arr().is_some_and(<[JsVal]>::is_empty);
        if value.is_object_like() && !is_empty {
          return Err(Bail::new("drafts:localizedPublish:unique:rows"));
        }
      }
      _ => collect(&field.fields, level, parent_path, locale, out)?,
    }
  }
  Ok(())
}

impl Field {
  /// Whether a field under this one (not this one itself) is `unique`.
  fn has_unique_below(&self) -> bool {
    self.fields.iter().any(Field::has_unique)
      || self.tabs.iter().any(Field::has_unique)
      || self.blocks.iter().any(|b| b.fields.iter().any(Field::has_unique))
  }
}
