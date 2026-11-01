//! Port of `packages/drizzle/src/transform/write/traverseFields.ts`,
//! `array.ts` and `blocks.ts`.
//!
//! Like the TS code, the incoming `data` is mutated in place (array/block row
//! ids moved to `_uuid`, `_uuid` propagated into groups, localized
//! relationship objects replaced by their ids, dotted keys expanded).

use std::sync::Arc;

use indexmap::{IndexMap, IndexSet};
use payload_engine::error::{EngineError, Result};
use payload_engine::fields::{field_is_virtual, field_should_be_localized};
use payload_engine::js::{JsVal, Obj};
use payload_engine::strings::to_snake_case;

use crate::adapter::WriteAdapter;
use crate::field_path::expand_own_dotted_key;
use crate::js::{self, OBJECT_PROTOTYPE_KEYS, js_entry, js_insert, json_stringify, number_to_string, to_js_string, type_error};
use crate::small::{
  locale_truthy, locale_val, resolve_block_table_name, transform_numbers, transform_relationship, transform_selects,
  transform_texts,
};
use crate::types::{NestedRowToInsert, Row, RowValue, SqlExpr};

pub(crate) struct Ctx<'a> {
  pub adapter: &'a dyn WriteAdapter,
  /// `baseTableName`, constant for the whole transform.
  pub base_table_name: &'a str,
  /// `Date.now()` for auto `updatedAt` values.
  pub now: f64,
}

/// Accumulators shared by the whole traversal, including nested array and
/// block rows.
#[derive(Default)]
pub(crate) struct Shared {
  pub blocks: IndexMap<String, Vec<NestedRowToInsert>>,
  pub blocks_to_delete: IndexSet<String>,
  pub numbers: Vec<Obj>,
  pub numbers_to_delete: Vec<Obj>,
  pub relationships: Vec<Obj>,
  pub relationships_to_delete: Vec<Obj>,
  pub selects: IndexMap<String, Vec<Obj>>,
  pub texts: Vec<Obj>,
  pub texts_to_delete: Vec<Obj>,
}

/// Accumulators of the row currently being built (main row, array row or
/// block row).
pub(crate) struct Level<'a> {
  pub arrays: &'a mut IndexMap<String, Vec<NestedRowToInsert>>,
  pub arrays_to_push: &'a mut IndexMap<String, Vec<NestedRowToInsert>>,
  pub locales: &'a mut IndexMap<String, Row>,
  pub row: &'a mut Row,
  pub relationships_to_append: &'a mut Vec<Obj>,
}

#[derive(Clone, Copy)]
pub(crate) struct Args<'a> {
  pub column_prefix: &'a str,
  pub enable_atomic_writes: bool,
  pub field_prefix: &'a str,
  pub fields: &'a JsVal,
  pub forced_locale: Option<&'a str>,
  pub inside_array_or_block: bool,
  pub parent_is_localized: bool,
  pub parent_table_name: &'a str,
  pub path: &'a str,
  pub within_array_or_block_locale: Option<&'a str>,
}

fn missing_table_error() -> EngineError {
  type_error("Cannot read properties of undefined (reading '_uuid')")
}

fn for_each_items<'a>(v: &'a JsVal, name: &str) -> Result<&'a [JsVal]> {
  match v {
    JsVal::Arr(a) => Ok(a),
    JsVal::Null | JsVal::Undefined => {
      Err(type_error(format!("Cannot read properties of {} (reading 'forEach')", to_js_string(v))))
    }
    _ => Err(type_error(format!("{name}.forEach is not a function"))),
  }
}

/// `typeof value === 'object' && value !== null`
fn is_object(v: &JsVal) -> bool {
  matches!(v, JsVal::Obj(_) | JsVal::Arr(_))
}

/// `value && typeof value === 'object' && key in value`
fn has_op(v: &JsVal, key: &str) -> bool {
  matches!(v, JsVal::Obj(o) if o.contains_key(key))
}

/// `if (!locales[locale]) locales[locale] = {}` followed by `locales[locale]`.
/// `locales` is a plain object literal: keys inherited from `Object.prototype`
/// (`constructor`, `toString`, `__proto__`, ...) are truthy, so no locale row
/// is created and TS writes the values onto that inherited object instead,
/// where they never reach the `RowToInsert` (`None`).
fn ensure_locale<'m>(locales: &'m mut IndexMap<String, Row>, locale: &str) -> Option<&'m mut Row> {
  if !locales.contains_key(locale) && OBJECT_PROTOTYPE_KEYS.contains(&locale) {
    return None;
  }
  Some(js_entry(locales, locale))
}

/// `traverseFields`
pub(crate) fn traverse_fields(
  ctx: &Ctx<'_>,
  sh: &mut Shared,
  lvl: &mut Level<'_>,
  a: Args<'_>,
  data: &mut JsVal,
) -> Result<()> {
  let mut fields_matched = false;

  if let Some(RowValue::Value(uuid)) = lvl.row.get("_uuid")
    && uuid.truthy()
  {
    let uuid = uuid.clone();
    js::set(data, "_uuid", uuid)?;
  }

  let fields = a.fields.clone();
  for field in for_each_items(&fields, "fields")? {
    if field_is_virtual(field) {
      continue;
    }

    let name = to_js_string(field.get("name"));
    if !js::get(data, &name)?.is_undefined() {
      fields_matched = true;
    }

    let column_name = format!("{}{}", a.column_prefix, to_snake_case(&name));
    let field_name = format!("{}{}", a.field_prefix, name);
    let is_localized = field_should_be_localized(field, a.parent_is_localized);
    let field_type = field.get("type").as_str().unwrap_or("");
    let child_parent_is_localized = a.parent_is_localized || field.get("localized").truthy();
    let path = a.path;

    if field_type == "array" {
      let array_table_name = ctx.adapter.table_name(&format!("{}_{}", a.parent_table_name, column_name));
      let table_key = array_table_name.unwrap_or("undefined").to_string();
      let array_args = ArrayArgs {
        array_table_name,
        field,
        locale: None,
        parent_is_localized: child_parent_is_localized,
        path,
        within_array_or_block_locale: a.within_array_or_block_locale,
      };

      if is_localized {
        if let Some(value) = js::get_mut(data, &name)
          && is_object(value)
        {
          for locale_key in js::keys(value)? {
            let Some(locale_value) = js::get_mut(value, &locale_key) else { continue };
            let args = ArrayArgs {
              locale: Some(&locale_key),
              within_array_or_block_locale: Some(&locale_key),
              ..array_args
            };
            let (rows, push) = if has_op(locale_value, "$push") {
              let Some(push_data) = js::get_mut(locale_value, "$push") else { continue };
              (js::with_wrapped(push_data, |d| transform_array(ctx, sh, args, d))?, true)
            } else if matches!(locale_value, JsVal::Arr(_)) {
              (transform_array(ctx, sh, args, locale_value)?, false)
            } else {
              continue;
            };
            let target = if push { &mut *lvl.arrays_to_push } else { &mut *lvl.arrays };
            js_entry(target, &table_key).extend(rows);
          }
        }
      } else {
        let value = js::get(data, &name)?;
        let push = value.is_object_like() && js::has(value, "$push")?;
        let rows = match js::get_mut(data, &name) {
          Some(value) if push => match js::get_mut(value, "$push") {
            Some(push_data) => js::with_wrapped(push_data, |d| transform_array(ctx, sh, array_args, d))?,
            None => transform_array(ctx, sh, array_args, &mut JsVal::arr(vec![JsVal::Undefined]))?,
          },
          Some(value) => transform_array(ctx, sh, array_args, value)?,
          None => transform_array(ctx, sh, array_args, &mut JsVal::Undefined)?,
        };
        let target = if push { &mut *lvl.arrays_to_push } else { &mut *lvl.arrays };
        js_entry(target, &table_key).extend(rows);
      }
      continue;
    }

    if field_type == "blocks" && !ctx.adapter.blocks_as_json() {
      for block in for_each_items(field.get("blocks"), "field.blocks")? {
        let matched_block = match block.as_str() {
          Some(slug) => {
            ctx.adapter.config_blocks().items().find(|each| each.get("slug").as_str() == Some(slug)).cloned()
          }
          None => Some(block.clone()),
        };
        let matched_block = matched_block.unwrap_or(JsVal::Undefined);
        let slug = to_js_string(js::get(&matched_block, "slug")?);
        let original = ctx.adapter.table_name(&format!("{}_blocks_{}", ctx.base_table_name, to_snake_case(&slug)));
        sh.blocks_to_delete.insert(resolve_block_table_name(ctx.adapter, &matched_block, original));
      }

      let blocks_args = BlocksArgs {
        field,
        locale: None,
        parent_is_localized: child_parent_is_localized,
        path,
        within_array_or_block_locale: a.within_array_or_block_locale,
      };

      if is_localized {
        if let Some(value) = js::get_mut(data, &name)
          && is_object(value)
        {
          for locale_key in js::keys(value)? {
            if let Some(locale_data) = js::get_mut(value, &locale_key)
              && matches!(locale_data, JsVal::Arr(_))
            {
              let args = BlocksArgs {
                locale: Some(&locale_key),
                within_array_or_block_locale: Some(&locale_key),
                ..blocks_args
              };
              transform_blocks(ctx, sh, args, locale_data)?;
            }
          }
        }
      } else if let Some(value) = js::get_mut(data, &name)
        && matches!(value, JsVal::Arr(_))
      {
        transform_blocks(ctx, sh, blocks_args, value)?;
      }
      continue;
    }

    if field_type == "group" || field_type == "tab" {
      if is_object(js::get(data, &name)?) {
        let id = js::get(data, "id")?;
        let uuid = if id.truthy() { id.clone() } else { js::get(data, "_uuid")?.clone() };
        let column_prefix = format!("{column_name}_");
        let field_prefix = format!("{field_name}_");
        let child_path = format!("{path}{name}.");
        let child_fields = field.get("flattenedFields");
        let child_args = Args {
          column_prefix: &column_prefix,
          enable_atomic_writes: a.enable_atomic_writes,
          field_prefix: &field_prefix,
          fields: child_fields,
          forced_locale: a.forced_locale,
          inside_array_or_block: a.inside_array_or_block,
          parent_is_localized: child_parent_is_localized,
          parent_table_name: a.parent_table_name,
          path: &child_path,
          within_array_or_block_locale: a.within_array_or_block_locale,
        };
        let Some(group_data) = js::get_mut(data, &name) else { continue };

        if is_localized {
          for locale_key in js::keys(group_data)? {
            let Some(locale_data) = js::get_mut(group_data, &locale_key) else { continue };
            // preserve array ID if there is
            js::set(locale_data, "_uuid", uuid.clone())?;
            let args = Args {
              forced_locale: Some(&locale_key),
              within_array_or_block_locale: Some(&locale_key),
              ..child_args
            };
            traverse_fields(ctx, sh, lvl, args, locale_data)?;
          }
        } else {
          // preserve array ID if there is
          js::set(group_data, "_uuid", uuid)?;
          traverse_fields(ctx, sh, lvl, child_args, group_data)?;
        }
      }
      continue;
    }

    let mut field_data = js::get(data, &name)?.clone();

    if field_type == "relationship" || field_type == "upload" {
      let relationship_path = format!("{path}{name}");
      let has_many = field.has("hasMany") && field.get("hasMany").truthy();
      let field_localized = field.get("localized").truthy();
      let relation_to = field.get("relationTo");
      let polymorphic = matches!(relation_to, JsVal::Arr(_));

      let any_locale_op = |op: &str| -> Result<bool> {
        Ok(js::entries(&field_data)?.iter().any(|(_, locale_value)| has_op(locale_value, op)))
      };

      // Handle $push operation for relationship fields
      if field_data.truthy()
        && is_object(&field_data)
        && has_many
        && (js::has(&field_data, "$push")? || (field_localized && any_locale_op("$push")?))
      {
        let to_append = |locale: JsVal, item: JsVal, require_value: bool| {
          let mut row = js::obj([("locale", locale), ("path", JsVal::str(relationship_path.as_str())), ("value", item.clone())]);
          if polymorphic
            && has_op(&item, "relationTo")
            && (!require_value || has_op(&item, "value"))
          {
            js_insert(&mut row, "relationTo", item.get("relationTo").clone());
            js_insert(&mut row, "value", item.get("value").clone());
          } else if let Some(relation_to) = relation_to.as_str() {
            js_insert(&mut row, "relationTo", JsVal::str(relation_to));
            js_insert(&mut row, "value", item);
          }
          row
        };

        if field_localized {
          for (locale_key, locale_value) in js::entries(&field_data)? {
            if has_op(&locale_value, "$push") {
              let push = locale_value.get("$push");
              let items = match push {
                JsVal::Arr(items) => items.to_vec(),
                other => vec![other.clone()],
              };
              for item in items {
                lvl.relationships_to_append.push(to_append(JsVal::str(locale_key.as_str()), item, false));
              }
            }
          }
        } else {
          // Handle non-localized fields: { field: { $push: data } }
          let items = match field_data.get("$push") {
            JsVal::Arr(items) => items.to_vec(),
            other => vec![other.clone()],
          };
          let locale = if is_localized { locale_val(a.within_array_or_block_locale) } else { JsVal::Undefined };
          for item in items {
            lvl.relationships_to_append.push(to_append(locale.clone(), item, true));
          }
        }
        continue;
      }

      // Handle $remove operation for relationship fields
      if field_data.truthy()
        && is_object(&field_data)
        && has_many
        && (js::has(&field_data, "$remove")? || (field_localized && any_locale_op("$remove")?))
      {
        let to_delete = |locale: JsVal, item: JsVal| {
          let mut row = js::obj([("itemToRemove", item), ("locale", locale), ("path", JsVal::str(relationship_path.as_str()))]);
          // Store relationTo for simple relationships
          if let Some(relation_to) = relation_to.as_str() {
            js_insert(&mut row, "relationTo", JsVal::str(relation_to));
          }
          row
        };

        if field_localized {
          for (locale_key, locale_value) in js::entries(&field_data)? {
            if has_op(&locale_value, "$remove") {
              let items = match locale_value.get("$remove") {
                JsVal::Arr(items) => items.to_vec(),
                other => vec![other.clone()],
              };
              for item in items {
                sh.relationships_to_delete.push(to_delete(JsVal::str(locale_key.as_str()), item));
              }
            }
          }
        } else {
          // Handle non-localized fields: { field: { $remove: data } }
          let items = match field_data.get("$remove") {
            JsVal::Arr(items) => items.to_vec(),
            other => vec![other.clone()],
          };
          let locale = if is_localized { locale_val(a.within_array_or_block_locale) } else { JsVal::Undefined };
          for item in items {
            sh.relationships_to_delete.push(to_delete(locale.clone(), item));
          }
        }
        continue;
      }

      let path_val = JsVal::str(relationship_path.as_str());
      if is_localized && (polymorphic || has_many) {
        if field_data.is_object_like() {
          for (locale_key, locale_data) in js::entries(&field_data)? {
            if locale_data.is_null() {
              sh.relationships_to_delete
                .push(js::obj([("locale", JsVal::str(locale_key.as_str())), ("path", path_val.clone())]));
              continue;
            }
            let base_row = js::obj([("locale", JsVal::str(locale_key.as_str())), ("path", path_val.clone())]);
            transform_relationship(&base_row, &locale_data, field, &mut sh.relationships);
          }
        }
        continue;
      } else if polymorphic || has_many {
        if field_data.is_null() || field_data.as_arr().is_some_and(|a| a.is_empty()) {
          sh.relationships_to_delete.push(js::obj([("path", path_val)]));
          continue;
        }
        let base_row = js::obj([("locale", locale_val(a.within_array_or_block_locale)), ("path", path_val)]);
        transform_relationship(&base_row, &field_data, field, &mut sh.relationships);
        continue;
      } else if !is_localized && field_data.truthy() && js::has(&field_data, "id").unwrap_or(false) && field_data.get("id").truthy()
      {
        field_data = field_data.get("id").clone();
      } else if is_localized && field_data.is_object_like() {
        let locale_keys = js::keys(&field_data)?;
        if let Some(target) = js::get_mut(data, &name) {
          for locale_key in locale_keys {
            let locale_data = js::get(target, &locale_key)?.clone();
            if locale_data.truthy() && is_object(&locale_data) && js::has(&locale_data, "id")? && locale_data.get("id").truthy() {
              js::set(target, &locale_key, locale_data.get("id").clone())?;
            }
          }
        }
        field_data = js::get(data, &name)?.clone();
      }
    }

    if field_type == "text" && field.get("hasMany").truthy() {
      let text_path = JsVal::str(format!("{path}{name}"));
      if is_localized {
        if field_data.is_object_like() {
          for (locale_key, locale_data) in js::entries(&field_data)? {
            if let Some(items) = locale_data.as_arr() {
              let base_row = js::obj([("locale", JsVal::str(locale_key.as_str())), ("path", text_path.clone())]);
              if items.is_empty() {
                sh.texts_to_delete.push(base_row);
                continue;
              }
              transform_texts(&base_row, items, &mut sh.texts);
            }
          }
        }
      } else if let Some(items) = field_data.as_arr() {
        let base_row = js::obj([("locale", locale_val(a.within_array_or_block_locale)), ("path", text_path)]);
        if items.is_empty() {
          sh.texts_to_delete.push(base_row);
          continue;
        }
        transform_texts(&base_row, items, &mut sh.texts);
      }
      continue;
    }

    if field_type == "number" && field.get("hasMany").truthy() {
      let number_path = JsVal::str(format!("{path}{name}"));
      if is_localized {
        if field_data.is_object_like() {
          for (locale_key, locale_data) in js::entries(&field_data)? {
            if let Some(items) = locale_data.as_arr() {
              let base_row = js::obj([("locale", JsVal::str(locale_key.as_str())), ("path", number_path.clone())]);
              if items.is_empty() {
                sh.numbers_to_delete.push(base_row);
                continue;
              }
              transform_numbers(&base_row, items, &mut sh.numbers);
            }
          }
        }
      } else if let Some(items) = field_data.as_arr() {
        let base_row = js::obj([("locale", locale_val(a.within_array_or_block_locale)), ("path", number_path)]);
        if items.is_empty() {
          sh.numbers_to_delete.push(base_row);
          continue;
        }
        transform_numbers(&base_row, items, &mut sh.numbers);
      }
      continue;
    }

    if field_type == "select" && field.get("hasMany").truthy() {
      if field_data.is_undefined() {
        continue;
      }
      let select_table_name = ctx
        .adapter
        .table_name(&format!("{}_{}", a.parent_table_name, column_name))
        .unwrap_or("undefined")
        .to_string();
      js_entry(&mut sh.selects, &select_table_name);

      let id = if a.inside_array_or_block {
        let uuid = js::get(data, "_uuid")?;
        if uuid.truthy() { uuid.clone() } else { js::get(data, "id")?.clone() }
      } else {
        JsVal::Undefined
      };

      let mut new_rows = Vec::new();
      if is_localized {
        if is_object(&field_data) {
          for (locale_key, locale_data) in js::entries(&field_data)? {
            if matches!(locale_data, JsVal::Arr(_)) {
              new_rows.extend(transform_selects(&id, &locale_data, Some(&locale_key)));
            }
          }
        }
      } else if matches!(field_data, JsVal::Arr(_)) {
        new_rows.extend(transform_selects(&id, &field_data, a.within_array_or_block_locale));
      }
      js_entry(&mut sh.selects, &select_table_name).extend(new_rows);
      continue;
    }

    // (localeKey, value); `None` targets `row` or the forced locale.
    let mut values_to_transform: Vec<(Option<String>, JsVal)> = Vec::new();
    let mut forced_target: Option<&str> = None;

    if is_localized {
      if is_object(&field_data) {
        for (locale_key, locale_data) in js::entries(&field_data)? {
          ensure_locale(lvl.locales, &locale_key);
          values_to_transform.push((Some(locale_key), locale_data));
        }
      }
    } else {
      if let Some(forced) = a.forced_locale
        && locale_truthy(Some(forced))
      {
        ensure_locale(lvl.locales, forced);
        forced_target = Some(forced);
      }
      values_to_transform.push((None, field_data));
    }

    for (locale_key, value) in values_to_transform {
      let mut formatted = RowValue::Value(value.clone());

      if field_type == "date" {
        if field_name == "updatedAt" && value.is_null() {
          // If updatedAt is explicitly set to null, skip it entirely - don't add to row
          continue;
        } else if field_name == "updatedAt" && value.is_undefined() {
          formatted = RowValue::Value(JsVal::str(js::iso_string(ctx.now)?));
        } else if let JsVal::Num(n) = value
          && !n.is_nan()
        {
          formatted = RowValue::Value(JsVal::str(js::iso_string(n)?));
        }
      }

      if !value.is_undefined() {
        if value.truthy() && field_type == "point" && ctx.adapter.name() != "sqlite" {
          formatted = RowValue::Sql(SqlExpr::GeomFromGeoJson(json_stringify(&value).unwrap_or_default()));
        }

        if field_type == "text" && value.truthy() && value.as_str().is_none() {
          formatted = RowValue::Value(json_stringify(&value).map(JsVal::str).unwrap_or(JsVal::Undefined));
        }

        if field_type == "number"
          && value.truthy()
          && value.is_object_like()
          && js::has(&value, "$inc")?
          && let JsVal::Num(inc) = value.get("$inc")
        {
          if !a.enable_atomic_writes {
            return Err(EngineError::api("The passed data must not contain any nested fields for atomic writes"));
          }
          formatted = RowValue::Sql(SqlExpr::Raw(format!("{column_name} + {}", number_to_string(*inc))));
        }
      }

      if matches!(formatted, RowValue::Value(JsVal::Undefined)) {
        continue;
      }
      match (&locale_key, forced_target) {
        (Some(locale_key), _) if !locale_key.is_empty() => {
          if let Some(locale_row) = ensure_locale(lvl.locales, locale_key) {
            js_insert(locale_row, field_name.clone(), formatted)
          }
        }
        // `locales[fieldName] = value` for an empty locale key: not representable.
        (Some(_), _) => {}
        (None, Some(forced)) => {
          if let Some(locale_row) = ensure_locale(lvl.locales, forced) {
            js_insert(locale_row, field_name.clone(), formatted)
          }
        }
        (None, None) => js_insert(lvl.row, field_name.clone(), formatted),
      }
    }
  }

  // Handle dot-notation paths when no fields matched
  if !fields_matched {
    for key in js::keys(data)? {
      if expand_own_dotted_key(&key, data)? {
        traverse_fields(ctx, sh, lvl, a, data)?;
      }
    }
  }

  Ok(())
}

#[derive(Clone, Copy)]
pub(crate) struct ArrayArgs<'a> {
  pub array_table_name: Option<&'a str>,
  pub field: &'a JsVal,
  pub locale: Option<&'a str>,
  pub parent_is_localized: bool,
  pub path: &'a str,
  pub within_array_or_block_locale: Option<&'a str>,
}

/// `transformArray` (array.ts)
pub(crate) fn transform_array(
  ctx: &Ctx<'_>,
  sh: &mut Shared,
  a: ArrayArgs<'_>,
  data: &mut JsVal,
) -> Result<Vec<NestedRowToInsert>> {
  let mut new_rows = Vec::new();
  let array_table_name = a.array_table_name.ok_or_else(missing_table_error)?;
  let has_uuid = ctx.adapter.table_has_uuid(array_table_name).ok_or_else(missing_table_error)?;

  let JsVal::Arr(rows) = data else { return Ok(new_rows) };
  let rows = Arc::make_mut(rows);
  let field_name = to_js_string(a.field.get("name"));

  for (i, array_row) in rows.iter_mut().enumerate() {
    let mut new_row = NestedRowToInsert::default();
    new_row.row.insert("_order".into(), RowValue::Value(JsVal::Num((i + 1) as f64)));

    // If we have declared a _uuid field on arrays, that means the ID has to be
    // unique, and our ids within arrays are not unique. So move the ID to a
    // uuid field for storage and allow the database to generate a serial id.
    if has_uuid {
      let id = js::get(array_row, "id")?.clone();
      js_insert(&mut new_row.row, "_uuid", RowValue::Value(id));
      js::delete(array_row, "id")?;
    }

    // `newRow.locales[locale] = { _locale: locale }`: assigning an object to
    // `__proto__` replaces the prototype instead of creating an own entry.
    if let Some(locale) = a.locale
      && locale_truthy(a.locale)
      && locale != "__proto__"
    {
      let mut locale_row = Row::new();
      locale_row.insert("_locale".into(), RowValue::Value(JsVal::str(locale)));
      js_insert(&mut new_row.locales, locale, locale_row);
    }

    if field_should_be_localized(a.field, a.parent_is_localized) && locale_truthy(a.locale) {
      js_insert(&mut new_row.row, "_locale", RowValue::Value(locale_val(a.locale)));
    }

    if locale_truthy(a.within_array_or_block_locale) {
      js_insert(&mut new_row.row, "_locale", RowValue::Value(locale_val(a.within_array_or_block_locale)));
    }

    let path = format!("{}{}.{}.", a.path, field_name, i);
    let mut relationships_to_append = Vec::new();
    let NestedRowToInsert { arrays, arrays_to_push, locales, row } = &mut new_row;
    let mut lvl = Level { arrays, arrays_to_push, locales, row, relationships_to_append: &mut relationships_to_append };
    let args = Args {
      column_prefix: "",
      enable_atomic_writes: false,
      field_prefix: "",
      fields: a.field.get("flattenedFields"),
      forced_locale: None,
      inside_array_or_block: true,
      parent_is_localized: a.parent_is_localized || a.field.get("localized").truthy(),
      parent_table_name: array_table_name,
      path: &path,
      within_array_or_block_locale: a.within_array_or_block_locale,
    };
    traverse_fields(ctx, sh, &mut lvl, args, array_row)?;

    new_rows.push(new_row);
  }

  Ok(new_rows)
}

#[derive(Clone, Copy)]
pub(crate) struct BlocksArgs<'a> {
  pub field: &'a JsVal,
  pub locale: Option<&'a str>,
  pub parent_is_localized: bool,
  pub path: &'a str,
  pub within_array_or_block_locale: Option<&'a str>,
}

/// `adapter.payload.blocks[blockType]` (last block with the slug wins).
fn payload_block(adapter: &dyn WriteAdapter, block_type: &str) -> Option<JsVal> {
  let found = adapter.config_blocks().items().rev().find(|b| b.get("slug").as_str() == Some(block_type)).cloned();
  found.or_else(|| OBJECT_PROTOTYPE_KEYS.contains(&block_type).then(|| JsVal::obj(Obj::new())))
}

/// `transformBlocks` (blocks.ts)
pub(crate) fn transform_blocks(ctx: &Ctx<'_>, sh: &mut Shared, a: BlocksArgs<'_>, data: &mut JsVal) -> Result<()> {
  let JsVal::Arr(rows) = data else { return Ok(()) };
  let rows = Arc::make_mut(rows);
  let field_name = to_js_string(a.field.get("name"));

  for (i, block_row) in rows.iter_mut().enumerate() {
    let Some(block_type_raw) = js::get(block_row, "blockType")?.as_str().map(str::to_string) else { continue };

    let matched_block = payload_block(ctx.adapter, &block_type_raw).or_else(|| {
      a.field
        .get("blocks")
        .items()
        .find(|block| block.as_str().is_none() && block.get("slug").as_str() == Some(block_type_raw.as_str()))
        .cloned()
    });
    let Some(matched_block) = matched_block else { continue };
    let block_type = to_snake_case(&block_type_raw);

    let mut new_row = NestedRowToInsert::default();
    new_row.row.insert("_order".into(), RowValue::Value(JsVal::Num((i + 1) as f64)));
    new_row.row.insert("_path".into(), RowValue::Value(JsVal::str(format!("{}{}", a.path, field_name))));

    if field_should_be_localized(a.field, a.parent_is_localized) && locale_truthy(a.locale) {
      js_insert(&mut new_row.row, "_locale", RowValue::Value(locale_val(a.locale)));
    }
    if locale_truthy(a.within_array_or_block_locale) {
      js_insert(&mut new_row.row, "_locale", RowValue::Value(locale_val(a.within_array_or_block_locale)));
    }

    let original = ctx.adapter.table_name(&format!("{}_blocks_{}", ctx.base_table_name, block_type));
    let block_table_name = resolve_block_table_name(ctx.adapter, &matched_block, original);

    js_entry(&mut sh.blocks, &block_table_name);

    let has_uuid = ctx.adapter.table_has_uuid(&block_table_name).ok_or_else(missing_table_error)?;

    // Same as arrays: move the non-unique ID to `_uuid`.
    if has_uuid {
      let id = js::get(block_row, "id")?.clone();
      js_insert(&mut new_row.row, "_uuid", RowValue::Value(id));
      js::delete(block_row, "id")?;
    }

    let path = format!("{}{}.{}.", a.path, field_name, i);
    let mut relationships_to_append = Vec::new();
    {
      let NestedRowToInsert { arrays, arrays_to_push, locales, row } = &mut new_row;
      let mut lvl = Level { arrays, arrays_to_push, locales, row, relationships_to_append: &mut relationships_to_append };
      let args = Args {
        column_prefix: "",
        enable_atomic_writes: false,
        field_prefix: "",
        fields: matched_block.get("flattenedFields"),
        forced_locale: None,
        inside_array_or_block: true,
        parent_is_localized: a.parent_is_localized || a.field.get("localized").truthy(),
        parent_table_name: &block_table_name,
        path: &path,
        within_array_or_block_locale: a.within_array_or_block_locale,
      };
      traverse_fields(ctx, sh, &mut lvl, args, block_row)?;
    }

    js_entry(&mut sh.blocks, &block_table_name).push(new_row);
  }

  Ok(())
}
