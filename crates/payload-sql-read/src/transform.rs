//! Port of `packages/drizzle/src/transform/read/*`: turns the nested rows
//! returned by drizzle's relational query (`db.query[table].findMany({ with })`)
//! into the Payload document shape.
//!
//! The TS code mutates the drizzle rows in place and reuses them as result
//! objects; this port does the same on [`Val`] so outputs (including key order,
//! leftover raw columns and shared objects) are identical.

use std::cell::RefCell;

use indexmap::IndexMap;
use payload_engine::error::{EngineError, Result};
use payload_engine::fields::{field_is_virtual, field_should_be_localized};
use payload_engine::js::JsVal;
use payload_engine::strings::{js_len, to_snake_case};

use crate::date::iso_from_string;
use crate::jsops::{
  js_to_number, json_parse, num_gt_js, num_to_string, parse_float, relative_index, string_to_number, to_number,
};
use crate::jsstr::JsStr;
use crate::props::{array_items, array_method_items, define, delete, destructure, get, has, push, set};
use crate::value::{JsObject, OBJECT_PROTOTYPE_KEYS, Val, js_key};

/// The parts of the drizzle adapter (`DrizzleAdapter`) the read transform uses.
pub struct ReadAdapter<'a> {
  /// `adapter.payload.config` (the sanitized config; only `localization` is read).
  /// The TS code reads both the `config` argument and `adapter.payload.config`,
  /// which every caller passes as the same object.
  pub config: &'a JsVal,
  /// `adapter.payload.blocks`: block slug -> `FlattenedBlock`.
  pub blocks: &'a JsVal,
  /// `adapter.payload.collections`: slug -> `{ customIDType }` (other keys ignored).
  pub collections: &'a JsVal,
  /// `adapter.tableNameMap`
  pub table_name_map: &'a IndexMap<String, String>,
  /// `adapter.blocksAsJSON`
  pub blocks_as_json: bool,
  /// `block[InternalBlockTableNameIndex]` (set while building the schema).
  pub block_table_name_index: &'a dyn Fn(&JsVal) -> Option<f64>,
}

/// Arguments of `transform({ adapter, config, data, fields, joinQuery, parentIsLocalized, tableName })`.
pub struct TransformArgs<'a> {
  /// The drizzle row (mutated, like in TS).
  pub data: Val,
  /// `FlattenedField[]`
  pub fields: &'a JsVal,
  pub join_query: &'a JsVal,
  pub parent_is_localized: bool,
  pub table_name: &'a str,
}

/// Looks up `block[InternalBlockTableNameIndex]` in a schema built from the same config graph.
///
/// The index is keyed by object identity: `fields`/`blocks` passed to [`transform`] must come
/// from the graph the `RawSchema` was built from, and that graph must outlive the schema (the
/// integration contract keeps one decoded graph per adapter instance). Covered end to end by
/// tests/schema_linked.rs.
pub fn schema_block_index(
  index: &std::collections::HashMap<usize, u32>,
) -> impl Fn(&JsVal) -> Option<f64> + '_ {
  move |block| block.identity().and_then(|id| index.get(&id)).map(|n| f64::from(*n))
}

/// `createPathMap` (utilities/createRelationshipMap.ts): a plain JS object keyed by
/// `row.path`. Like in JS it inherits `Object.prototype`, so a path such as
/// `constructor` finds the inherited function and `.push` throws a TypeError.
/// Rows keep their `path` key (the TS code deletes it from an unused copy).
fn create_path_map(rows: &Val) -> Result<Val> {
  let map = Val::new_obj();
  if let Some(rows) = array_items(rows) {
    for row in rows {
      let path = get(&row, "path")?.to_js_str();
      if !get(&map, &path)?.truthy() {
        set(&map, &path, Val::new_arr(Vec::new()))?;
      }
      push(&get(&map, &path)?, row)?;
    }
  }
  Ok(map)
}

/// `createBlocksMap` (utilities/createBlocksMap.ts): a plain JS object keyed by `row._path`
/// (`row._path in blocksMap` is also true for inherited `Object.prototype` keys).
fn create_blocks_map(data: &Val) -> Result<Val> {
  let map = Val::new_obj();
  let entries = data.as_obj().map(|o| o.borrow().entries()).unwrap_or_default();
  for (key, rows) in entries {
    if !key.starts_with("_blocks_") || rows.as_arr().is_none() {
      continue;
    }
    let mut block_type = key.replace_first("_blocks_", "");
    let parsed = block_type.split('_');
    if parsed.len() == 2 {
      let n = string_to_number(&parsed[1].to_lossy());
      if n.is_finite() && n.trunc() == n {
        block_type = parsed[0].clone();
      }
    }
    for row in array_items(&rows).unwrap_or_default() {
      if has(&row, "_path")? {
        let path = get(&row, "_path")?.to_js_str();
        if !has(&map, &path)? {
          set(&map, &path, Val::new_arr(Vec::new()))?;
        }
        set(&row, "blockType", Val::Str(block_type.clone()))?;
        push(&get(&map, &path)?, row.clone())?;
        delete(&row, "_path")?;
      }
    }
    delete(data, &key)?;
  }
  let own = map.as_obj().map(|o| o.borrow().entries()).unwrap_or_default();
  for (_, rows) in own {
    let Some(rows) = rows.as_arr() else { continue };
    let mut rows = rows.borrow_mut();
    crate::sort::v8_sort(&mut rows.0, |a, b| {
      match (get(a, "_order").unwrap_or_default(), get(b, "_order").unwrap_or_default()) {
        (Val::Num(x), Val::Num(y)) => x - y,
        _ => 0.0,
      }
    });
  }
  Ok(map)
}

struct State<'a> {
  adapter: &'a ReadAdapter<'a>,
  /// `BlocksMap` (plain object of path -> block rows)
  blocks: Val,
  /// Plain objects of path -> rows (see [`create_path_map`]).
  relationships: Val,
  texts: Val,
  numbers: Val,
  deletions: RefCell<Vec<(Val, String)>>,
  top_level_table_name: &'a str,
}

struct Traverse<'f> {
  current_table_name: Option<String>,
  data_ref: Val,
  field_prefix: String,
  fields: &'f JsVal,
  join_query: &'f JsVal,
  parent_is_localized: bool,
  path: String,
  table: Val,
  table_path: String,
  within_array_or_block_locale: Val,
}

fn opt_name(name: &Option<String>) -> &str {
  name.as_deref().unwrap_or("undefined")
}

/// `transform` (transform/read/index.ts)
pub fn transform(adapter: &ReadAdapter<'_>, args: TransformArgs<'_>) -> Result<Val> {
  let data = args.data;
  let mut relationships = Val::new_obj();
  let mut texts = Val::new_obj();
  let mut numbers = Val::new_obj();

  if has(&data, "_rels")? {
    relationships = create_path_map(&get(&data, "_rels")?)?;
    delete(&data, "_rels")?;
  }
  if has(&data, "_texts")? {
    texts = create_path_map(&get(&data, "_texts")?)?;
    delete(&data, "_texts")?;
  }
  if has(&data, "_numbers")? {
    numbers = create_path_map(&get(&data, "_numbers")?)?;
    delete(&data, "_numbers")?;
  }

  let blocks = create_blocks_map(&data)?;

  let state = State {
    adapter,
    blocks,
    relationships,
    texts,
    numbers,
    deletions: RefCell::new(Vec::new()),
    top_level_table_name: args.table_name,
  };

  let mut data_ref = JsObject::new();
  data_ref.define("id", get(&data, "id")?);

  let result = state.traverse(Traverse {
    current_table_name: Some(args.table_name.to_string()),
    data_ref: Val::from_obj(data_ref),
    field_prefix: String::new(),
    fields: args.fields,
    join_query: args.join_query,
    parent_is_localized: args.parent_is_localized,
    path: String::new(),
    table: data,
    table_path: String::new(),
    within_array_or_block_locale: Val::Undefined,
  })?;

  for (table, key) in state.deletions.take() {
    delete(&table, &key)?;
  }

  Ok(result)
}

fn field_type(field: &JsVal) -> &str {
  field.get("type").as_str().unwrap_or("")
}

/// A block found by `adapter.payload.blocks[row.blockType] ?? field.blocks.find(...)`.
enum FoundBlock {
  Config(JsVal),
  /// An inherited `Object.prototype` member of `adapter.payload.blocks` (a truthy
  /// built-in without `slug`/`flattenedFields`).
  Inherited,
  /// `undefined`
  Missing,
}

impl FoundBlock {
  fn truthy(&self) -> bool {
    match self {
      FoundBlock::Config(block) => block.truthy(),
      FoundBlock::Inherited => true,
      FoundBlock::Missing => false,
    }
  }
}

/// `obj[key]` on a plain config object (`adapter.payload.blocks` / `.collections`),
/// including inherited `Object.prototype` members.
enum JsLookup<'a> {
  Own(&'a JsVal),
  Inherited,
  Missing,
}

fn js_lookup<'a>(obj: &'a JsVal, key: &JsStr) -> Result<JsLookup<'a>> {
  if obj.is_nullish() {
    return Err(EngineError::new(
      "TypeError",
      format!("Cannot read properties of {} (reading '{key}')", if obj.is_null() { "null" } else { "undefined" }),
    ));
  }
  let Some(key) = key.as_str() else { return Ok(JsLookup::Missing) };
  if obj.has(key) {
    return Ok(JsLookup::Own(obj.get(key)));
  }
  Ok(if OBJECT_PROTOTYPE_KEYS.contains(&key) { JsLookup::Inherited } else { JsLookup::Missing })
}

fn flattened_fields(block: &FoundBlock) -> Result<&JsVal> {
  let fields = match block {
    FoundBlock::Config(block) => block.get("flattenedFields"),
    _ => &JsVal::Undefined,
  };
  if fields.as_arr().is_none() {
    return Err(EngineError::new("TypeError", "Cannot read properties of undefined (reading 'reduce')"));
  }
  Ok(fields)
}

fn group_fields(field: &JsVal) -> Result<&JsVal> {
  let fields = field.get("flattenedFields");
  if fields.as_arr().is_none() {
    return Err(EngineError::new("TypeError", "Cannot read properties of undefined (reading 'reduce')"));
  }
  Ok(fields)
}

/// `toSnakeCase(value)` (the `to-snake-case` package throws for non-strings).
fn snake(v: &JsVal) -> Result<String> {
  match v {
    JsVal::Str(s) => Ok(to_snake_case(s)),
    JsVal::Undefined | JsVal::Null => Err(EngineError::new(
      "TypeError",
      format!("Cannot read properties of {} (reading 'toLowerCase')", if v.is_null() { "null" } else { "undefined" }),
    )),
    _ => Err(EngineError::new("TypeError", "string.toLowerCase is not a function")),
  }
}

/// `Object.entries(value)` (own enumerable string-keyed properties).
fn object_entries(v: &Val) -> Result<Vec<(JsStr, Val)>> {
  Ok(match v {
    Val::Obj(o) => o.borrow().entries(),
    Val::Arr(a) => a.borrow().iter().enumerate().map(|(i, v)| (JsStr::from(i.to_string()), v.clone())).collect(),
    Val::Str(s) => s
      .units()
      .iter()
      .enumerate()
      .map(|(i, u)| (JsStr::from(i.to_string()), Val::Str(JsStr::from_units(&[*u]))))
      .collect(),
    Val::Undefined | Val::Null => {
      return Err(EngineError::new("TypeError", "Cannot convert undefined or null to object"));
    }
    _ => Vec::new(),
  })
}

/// Shared `ref[field.name][locale] = result` / `ref[field.name] = result` tail of the hasMany helpers.
fn assign_result(ref_: &Val, name: &str, locale: Option<&JsStr>, result: Val) -> Result<()> {
  match locale {
    Some(locale) if !locale.is_empty() => set(&get(ref_, name)?, locale, result),
    _ => set(ref_, name, result),
  }
}

/// `Object.entries(relation).find(([key, val]) => val !== null && !['id', 'locale', 'order', 'parent', 'path'].includes(key) && matchedLocale)`
fn find_poly_relation(relation: &Val, matched_locale: bool) -> Result<Option<(JsStr, Val)>> {
  Ok(object_entries(relation)?.into_iter().find(|(key, val)| {
    !matches!(val, Val::Null)
      && !matches!(key.as_str(), Some("id" | "locale" | "order" | "parent" | "path"))
      && matched_locale
  }))
}

fn poly_value(key: &JsStr, value: Val) -> Val {
  let mut obj = JsObject::new();
  obj.define("relationTo", Val::Str(key.replace_first("ID", "")));
  obj.define("value", value);
  Val::from_obj(obj)
}

/// `transformRelationship` (transform/read/relationship.ts). `relations` is whatever
/// the path map holds for the path (an array, or an inherited built-in).
fn transform_relationship(
  field: &JsVal,
  locale: Option<&JsStr>,
  ref_: &Val,
  relations: &Val,
  within: &Val,
) -> Result<()> {
  let name = field.get("name").to_js_string();
  let relation_to = field.get("relationTo");
  let mut result = Val::Undefined;

  if !field.has("hasMany") || matches!(field.get("hasMany"), JsVal::Bool(false)) {
    let mut relation = get(relations, "0")?;
    if within.truthy() {
      relation = Val::Undefined;
      for rel in array_method_items(relations, "find")? {
        if get(&rel, "locale")?.strict_eq(within) {
          relation = rel;
          break;
        }
      }
    }
    if relation.truthy() && relation_to.as_arr().is_some() {
      if let Some((key, value)) = find_poly_relation(&relation, true)? {
        result = poly_value(&key, value);
      }
    }
  } else {
    let transformed = Val::new_arr(Vec::new());
    for relation in array_method_items(relations, "forEach")? {
      let mut matched_locale = true;
      if within.truthy() {
        matched_locale = get(&relation, "locale")?.strict_eq(within);
      }
      if relation_to.as_arr().is_none() {
        let related = get(&relation, &format!("{}ID", relation_to.to_js_string()))?;
        if related.truthy() && matched_locale {
          push(&transformed, related)?;
        }
      } else if let Some((key, value)) = find_poly_relation(&relation, matched_locale)? {
        push(&transformed, poly_value(&key, value))?;
      }
    }
    result = transformed;
  }

  assign_result(ref_, &name, locale, result)
}

/// `transformHasManyText` / `transformHasManyNumber` (transform/read/hasManyText.ts, hasManyNumber.ts)
fn transform_has_many_scalar(
  field: &JsVal,
  locale: Option<&JsStr>,
  ref_: &Val,
  rows: &Val,
  within: &Val,
  key: &str,
  to_number_if_string: bool,
) -> Result<()> {
  let convert = |v: Val| match v {
    Val::Str(s) if to_number_if_string => Val::Num(string_to_number(&s.to_lossy())),
    other => other,
  };
  let mut result = Vec::new();
  if within.truthy() {
    for row in array_method_items(rows, "reduce")? {
      let row_locale = destructure(&row, "locale")?;
      let value = get(&row, key)?;
      if row_locale.strict_eq(within) {
        result.push(convert(value));
      }
    }
  } else {
    for row in array_method_items(rows, "map")? {
      result.push(convert(destructure(&row, key)?));
    }
  }
  assign_result(ref_, &field.get("name").to_js_string(), locale, Val::new_arr(result))
}

/// `rows.forEach(row => { if (typeof row.locale === 'string') { if (!byLocale[row.locale]) byLocale[row.locale] = []; byLocale[row.locale].push(row) } })`
/// followed by `Object.entries(byLocale)` (`relationsByLocale`, `textsByLocale`, `numbersByLocale`).
fn group_by_locale(rows: &Val) -> Result<Vec<(JsStr, Val)>> {
  let by_locale = Val::new_obj();
  for row in array_method_items(rows, "forEach")? {
    if let Val::Str(locale) = get(&row, "locale")? {
      if !get(&by_locale, &locale)?.truthy() {
        set(&by_locale, &locale, Val::new_arr(Vec::new()))?;
      }
      push(&get(&by_locale, &locale)?, row.clone())?;
    }
  }
  Ok(by_locale.as_obj().map(|o| o.borrow().entries()).unwrap_or_default())
}

impl State<'_> {
  fn localization(&self) -> &JsVal {
    self.adapter.config.get("localization")
  }

  /// `adapter.payload.config.localization && adapter.payload.config.localization.localeCodes`
  fn locale_codes(&self) -> JsVal {
    let localization = self.localization();
    if localization.truthy() { localization.get("localeCodes").clone() } else { localization.clone() }
  }

  fn locale_code_list(&self) -> Result<Vec<JsVal>> {
    let codes = self.localization().get("localeCodes");
    codes
      .as_arr()
      .map(<[JsVal]>::to_vec)
      .ok_or_else(|| EngineError::new("TypeError", "Cannot read properties of undefined (reading 'reduce')"))
  }

  /// `adapter.payload.blocks[row.blockType] ?? field.blocks.find(...)`
  fn find_block(&self, field: &JsVal, block_type: &Val) -> Result<FoundBlock> {
    match js_lookup(self.adapter.blocks, &block_type.to_js_str())? {
      JsLookup::Own(block) if !block.is_nullish() => return Ok(FoundBlock::Config(block.clone())),
      JsLookup::Inherited => return Ok(FoundBlock::Inherited),
      _ => {}
    }
    let blocks = field.get("blocks");
    let Some(blocks) = blocks.as_arr() else {
      return Err(EngineError::new("TypeError", "Cannot read properties of undefined (reading 'find')"));
    };
    for block in blocks {
      if matches!(block, JsVal::Str(_)) {
        continue;
      }
      if block.is_nullish() {
        return Err(EngineError::new(
          "TypeError",
          format!("Cannot read properties of {} (reading 'slug')", if block.is_null() { "null" } else { "undefined" }),
        ));
      }
      if Val::from_js(block.get("slug")).strict_eq(block_type) {
        return Ok(FoundBlock::Config(block.clone()));
      }
    }
    Ok(FoundBlock::Missing)
  }

  /// `resolveBlockTableName(block, adapter.tableNameMap.get(`${topLevelTableName}_blocks_${toSnakeCase(block.slug)}`))`
  fn block_table_name(&self, block: &FoundBlock) -> Result<Option<String>> {
    let block = match block {
      FoundBlock::Missing => {
        return Err(EngineError::new("TypeError", "Cannot read properties of undefined (reading 'slug')"));
      }
      FoundBlock::Inherited => return Err(snake(&JsVal::Undefined).expect_err("undefined slug")),
      FoundBlock::Config(block) => block,
    };
    let original = self
      .adapter
      .table_name_map
      .get(&format!("{}_blocks_{}", self.top_level_table_name, snake(block.get("slug"))?))
      .cloned();
    Ok(match (self.adapter.block_table_name_index)(block) {
      Some(index) if index != 0.0 && !index.is_nan() => {
        Some(format!("{}_{}", opt_name(&original), num_to_string(index)))
      }
      _ => original,
    })
  }

  fn defer_delete(&self, table: &Val, key: &str) {
    self.deletions.borrow_mut().push((table.clone(), key.to_string()));
  }

  /// `traverseFields` (transform/read/traverseFields.ts)
  fn traverse(&self, a: Traverse<'_>) -> Result<Val> {
    let sanitized_path = if a.path.is_empty() { String::new() } else { format!("{}.", a.path) };
    let locale_codes = self.locale_codes();
    let result = a.data_ref.clone();
    let table = &a.table;
    let within = &a.within_array_or_block_locale;

    let Some(fields) = a.fields.as_arr() else {
      return Err(EngineError::new("TypeError", "fields.reduce is not a function"));
    };

    for field in fields {
      if field_is_virtual(field) {
        continue;
      }
      let name = field.get("name").to_js_string();
      let field_name = format!("{}{}", a.field_prefix, name);
      let mut field_data = get(table, &field_name)?;
      let localized_field_data = Val::new_obj();
      let mut values_to_transform: Vec<(Val, Val)> = Vec::new();

      if !a.field_prefix.is_empty() {
        self.defer_delete(table, &field_name);
      }

      let is_localized = field_should_be_localized(field, a.parent_is_localized);
      let child_parent_is_localized = a.parent_is_localized || field.get("localized").truthy();
      let ty = field_type(field);

      if ty == "array" {
        let array_table_name = self
          .adapter
          .table_name_map
          .get(&format!("{}_{}{}", opt_name(&a.current_table_name), a.table_path, snake(field.get("name"))?))
          .cloned();
        let relation_name = if field.get("dbName").truthy() && js_len(&field_name) > 63 {
          format!("_{}", opt_name(&array_table_name))
        } else {
          field_name.clone()
        };
        field_data = get(table, &relation_name)?;

        if let Some(rows) = array_items(&field_data) {
          let sub_fields = field.get("flattenedFields");
          if is_localized {
            let array_result = Val::new_obj();
            for row in rows {
              let Val::Str(locale) = get(&row, "_locale")? else { continue };
              if !get(&array_result, &locale)?.truthy() {
                set(&array_result, &locale, Val::new_arr(Vec::new()))?;
              }
              let data = Val::new_obj();
              delete(&row, "_locale")?;
              if get(&row, "_uuid")?.truthy() {
                set(&row, "id", get(&row, "_uuid")?)?;
                delete(&row, "_uuid")?;
              }
              let order = to_number(&get(&row, "_order")?)? - 1.0;
              let row_result = self.traverse(Traverse {
                current_table_name: array_table_name.clone(),
                data_ref: data,
                field_prefix: String::new(),
                fields: sub_fields,
                join_query: &JsVal::Undefined,
                parent_is_localized: child_parent_is_localized,
                path: format!("{sanitized_path}{name}.{}", num_to_string(order)),
                table: row.clone(),
                table_path: String::new(),
                within_array_or_block_locale: Val::Str(locale.clone()),
              })?;
              if has(&row_result, "_order")? {
                delete(&row_result, "_order")?;
              }
              push(&get(&array_result, &locale)?, row_result)?;
            }
            set(&result, &name, array_result)?;
          } else {
            let acc = Val::new_arr(Vec::new());
            for (i, row) in rows.into_iter().enumerate() {
              if get(&row, "_uuid")?.truthy() {
                set(&row, "id", get(&row, "_uuid")?)?;
                delete(&row, "_uuid")?;
              }
              if has(&row, "_order")? {
                delete(&row, "_order")?;
              }
              if !within.truthy() || within.strict_eq(&get(&row, "_locale")?) {
                if get(&row, "_locale")?.truthy() {
                  delete(&row, "_locale")?;
                }
                let item = self.traverse(Traverse {
                  current_table_name: array_table_name.clone(),
                  data_ref: row.clone(),
                  field_prefix: String::new(),
                  fields: sub_fields,
                  join_query: &JsVal::Undefined,
                  parent_is_localized: child_parent_is_localized,
                  path: format!("{sanitized_path}{name}.{i}"),
                  table: row.clone(),
                  table_path: String::new(),
                  within_array_or_block_locale: within.clone(),
                })?;
                push(&acc, item)?;
              }
            }
            set(&result, &name, acc)?;
          }
        }
        continue;
      }

      if ty == "blocks" && !self.adapter.blocks_as_json {
        let block_field_path = format!("{sanitized_path}{name}");
        let Some(rows) = array_items(&get(&self.blocks, &block_field_path)?) else {
          continue;
        };

        if is_localized {
          let by_locale = Val::new_obj();
          set(&result, &name, by_locale.clone())?;
          for row in &rows {
            if get(row, "_uuid")?.truthy() {
              set(row, "id", get(row, "_uuid")?)?;
              delete(row, "_uuid")?;
            }
            if let Val::Str(locale) = get(row, "_locale")? {
              if !get(&by_locale, &locale)?.truthy() {
                set(&by_locale, &locale, Val::new_arr(Vec::new()))?;
              }
              push(&get(&by_locale, &locale)?, row.clone())?;
              delete(row, "_locale")?;
            }
          }

          let entries = by_locale.as_obj().map(|o| o.borrow().entries()).unwrap_or_default();
          for (locale, localized_blocks) in entries {
            let mut mapped = Vec::new();
            for row in array_items(&localized_blocks).unwrap_or_default() {
              let block = self.find_block(field, &get(&row, "blockType")?)?;
              let table_name = self.block_table_name(&block)?;
              if block.truthy() {
                let order = to_number(&get(&row, "_order")?)? - 1.0;
                let block_result = self.traverse(Traverse {
                  current_table_name: table_name,
                  data_ref: row.clone(),
                  field_prefix: String::new(),
                  fields: flattened_fields(&block)?,
                  join_query: &JsVal::Undefined,
                  parent_is_localized: child_parent_is_localized,
                  path: format!("{block_field_path}.{}", num_to_string(order)),
                  table: row.clone(),
                  table_path: String::new(),
                  within_array_or_block_locale: Val::Str(locale.clone()),
                })?;
                delete(&block_result, "_order")?;
                mapped.push(block_result);
              } else {
                mapped.push(Val::new_obj());
              }
            }
            set(&by_locale, &locale, Val::new_arr(mapped))?;
          }
        } else {
          let localization = self.adapter.config.get("localization");
          if within.truthy() && localization.truthy() {
            for locale in self.locale_code_list()? {
              let mut locale_index = 0.0;
              for row in &rows {
                if get(row, "_locale")?.strict_eq_js(&locale) {
                  set(row, "_index", Val::Num(locale_index))?;
                  locale_index += 1.0;
                }
              }
            }
          }

          let acc = Val::new_arr(Vec::new());
          for (index, row) in rows.iter().enumerate() {
            let mut i = index as f64;
            delete(row, "_order")?;
            if get(row, "_uuid")?.truthy() {
              set(row, "id", get(row, "_uuid")?)?;
              delete(row, "_uuid")?;
            }
            let block_type = get(row, "blockType")?;
            if !block_type.is_string() {
              continue;
            }
            let block = self.find_block(field, &block_type)?;
            if block.truthy() {
              if !within.truthy() || within.strict_eq(&get(row, "_locale")?) {
                if get(row, "_locale")?.truthy() {
                  delete(row, "_locale")?;
                }
                if let Val::Num(n) = get(row, "_index")? {
                  i = n;
                  delete(row, "_index")?;
                }
                let table_name = self.block_table_name(&block)?;
                let item = self.traverse(Traverse {
                  current_table_name: table_name,
                  data_ref: row.clone(),
                  field_prefix: String::new(),
                  fields: flattened_fields(&block)?,
                  join_query: &JsVal::Undefined,
                  parent_is_localized: child_parent_is_localized,
                  path: format!("{block_field_path}.{}", num_to_string(i)),
                  table: row.clone(),
                  table_path: String::new(),
                  within_array_or_block_locale: within.clone(),
                })?;
                push(&acc, item)?;
              }
            } else {
              push(&acc, Val::new_obj())?;
            }
          }
          set(&result, &name, acc)?;
        }
        continue;
      }

      if (ty == "relationship" || ty == "upload")
        && (field.get("relationTo").as_arr().is_some() || field.get("hasMany").truthy())
      {
        let relation_path_match = get(&self.relationships, &format!("{sanitized_path}{name}"))?;
        if !relation_path_match.truthy() {
          if field.has("hasMany") && field.get("hasMany").truthy() {
            let localization = self.adapter.config.get("localization");
            if is_localized && localization.truthy() && localization.get("locales").truthy() {
              let obj = Val::new_obj();
              define(&obj, &js_key(localization.get("defaultLocale")), Val::new_arr(Vec::new()))?;
              set(&result, &name, obj)?;
            } else {
              set(&result, &name, Val::new_arr(Vec::new()))?;
            }
          }
          continue;
        }

        if is_localized {
          set(&result, &name, Val::new_obj())?;
          for (locale, relations) in group_by_locale(&relation_path_match)? {
            transform_relationship(field, Some(&locale), &result, &relations, &Val::Undefined)?;
          }
        } else {
          transform_relationship(field, None, &result, &relation_path_match, within)?;
        }
        continue;
      }

      if ty == "join" {
        let join_key = format!("{}{}", a.field_prefix.replace('_', "."), name);
        let query = if a.join_query.is_nullish() { &JsVal::Undefined } else { a.join_query.get(&join_key) };
        let count = query.get("count").clone();
        let limit = match query.get("limit") {
          JsVal::Undefined => match field.get("defaultLimit") {
            JsVal::Undefined | JsVal::Null => JsVal::Num(10.0),
            other => other.clone(),
          },
          other => other.clone(),
        };

        if let Val::Str(s) = &field_data {
          field_data = json_parse(s)?;
        }

        let mut field_result = Val::Undefined;
        if let Some(rows) = array_items(&field_data) {
          let localization = self.adapter.config.get("localization");
          if is_localized && localization.truthy() {
            let join_result = Val::new_obj();
            for code in self.locale_code_list()? {
              let mut entry = JsObject::new();
              entry.define("docs", Val::new_arr(Vec::new()));
              entry.define("hasNextPage", Val::Bool(false));
              set(&join_result, &js_key(&code), Val::from_obj(entry))?;
            }
            for row in rows {
              if let Val::Str(locale) = get(&row, "locale")? {
                push(&get(&get(&join_result, &locale)?, "docs")?, get(&row, "id")?)?;
              }
            }
            let keys = join_result.as_obj().map(|o| o.borrow().keys()).unwrap_or_default();
            for locale in keys {
              let entry = get(&join_result, &locale)?;
              let docs = array_items(&get(&entry, "docs")?).unwrap_or_default();
              set(&entry, "hasNextPage", Val::Bool(num_gt_js(docs.len() as f64, &limit)))?;
              let end = if limit.is_undefined() { docs.len() } else { relative_index(js_to_number(&limit), docs.len()) };
              set(&entry, "docs", Val::new_arr(docs[..end].to_vec()))?;
            }
            field_result = join_result;
          } else {
            let has_next_page = !matches!(limit, JsVal::Num(n) if n == 0.0) && num_gt_js(rows.len() as f64, &limit);
            let selected = if has_next_page {
              let end = relative_index(js_to_number(&limit), rows.len());
              &rows[..end]
            } else {
              &rows[..]
            };
            let mut docs = Vec::with_capacity(selected.len());
            for row in selected {
              let id = destructure(row, "id")?;
              let relation_to = get(row, "relationTo")?;
              let mut doc = JsObject::new();
              if relation_to.truthy() {
                doc.define("relationTo", relation_to);
                doc.define("value", id);
              } else {
                doc.define("id", id);
              }
              docs.push(Val::from_obj(doc));
            }
            let mut obj = JsObject::new();
            obj.define("docs", Val::new_arr(docs));
            obj.define("hasNextPage", Val::Bool(has_next_page));
            field_result = Val::from_obj(obj);
          }
        }

        if count.truthy() {
          let count_value = get(table, &format!("{field_name}_count"))?;
          if !count_value.is_undefined() {
            let mut value = to_number(&count_value)?;
            if value.is_nan() {
              value = 0.0;
            }
            set(&field_result, "totalDocs", Val::Num(value))?;
          }
        }

        set(&result, &name, field_result)?;
        continue;
      }

      let is_text_many = ty == "text" && field.get("hasMany").truthy();
      let is_number_many = ty == "number" && field.get("hasMany").truthy();
      if is_text_many || is_number_many {
        let (map, key) = if is_text_many { (&self.texts, "text") } else { (&self.numbers, "number") };
        let path_match = get(map, &format!("{sanitized_path}{name}"))?;
        if !path_match.truthy() {
          if is_localized && locale_codes.truthy() {
            let obj = Val::new_obj();
            let codes = locale_codes
              .as_arr()
              .ok_or_else(|| EngineError::new("TypeError", "localeCodes.map is not a function"))?;
            for code in codes {
              define(&obj, &js_key(code), Val::new_arr(Vec::new()))?;
            }
            set(&result, &name, obj)?;
          } else {
            set(&result, &name, Val::new_arr(Vec::new()))?;
          }
          continue;
        }

        if is_localized {
          set(&result, &name, Val::new_obj())?;
          for (locale, rows) in group_by_locale(&path_match)? {
            transform_has_many_scalar(field, Some(&locale), &result, &rows, &Val::Undefined, key, is_number_many)?;
          }
        } else {
          transform_has_many_scalar(field, None, &result, &path_match, within, key, is_number_many)?;
        }
        continue;
      }

      if ty == "select" && field.get("hasMany").truthy() {
        if let Some(rows) = array_items(&field_data) {
          if is_localized {
            let select_result = Val::new_obj();
            for row in rows {
              if let Val::Str(locale) = get(&row, "locale")? {
                if !get(&select_result, &locale)?.truthy() {
                  set(&select_result, &locale, Val::new_arr(Vec::new()))?;
                }
                push(&get(&select_result, &locale)?, get(&row, "value")?)?;
              }
            }
            set(&result, &name, select_result)?;
          } else {
            let mut values = Vec::new();
            for row in rows {
              if within.truthy() && !destructure(&row, "locale")?.strict_eq(within) {
                continue;
              }
              values.push(destructure(&row, "value")?);
            }
            set(&result, &name, Val::new_arr(values))?;
          }
        }
        continue;
      }

      let locales = get(table, "_locales")?;
      if is_localized && locales.as_arr().is_some() {
        if array_items(&locales).unwrap_or_default().is_empty() && locale_codes.truthy() {
          let codes = locale_codes
            .as_arr()
            .ok_or_else(|| EngineError::new("TypeError", "localeCodes.forEach is not a function"))?;
          for code in codes {
            let mut row = JsObject::new();
            row.define("_locale", Val::from_js(code));
            push(&locales, Val::from_obj(row))?;
          }
        }
        for locale_row in array_items(&locales).unwrap_or_default() {
          // `{ ...table, ...localeRow }`
          let mut copy = table.as_obj().map(|o| o.borrow().spread()).unwrap_or_default();
          if !locale_row.is_nullish() {
            for (k, v) in object_entries(&locale_row)? {
              copy.define(&k, v);
            }
          }
          values_to_transform.push((localized_field_data.clone(), Val::from_obj(copy)));
        }
      } else {
        values_to_transform.push((result.clone(), table.clone()));
      }

      for (ref_, table) in values_to_transform {
        let field_data = get(&table, &field_name)?;
        let locale = get(&table, "_locale")?;
        let mut val = field_data.clone();

        match ty {
          "date" => {
            if let Val::Str(s) = &field_data {
              val = Val::str(&iso_from_string(s)?);
            }
          }
          "group" | "tab" => {
            let group_field_prefix = format!("{}{}_", a.field_prefix, name);
            let ref_key = if is_localized && locale.truthy() { locale.to_js_str() } else { JsStr::from(name.as_str()) };
            if is_localized && locale.truthy() {
              delete(&table, "_locale")?;
            }
            let within_next = if locale.truthy() { locale.clone() } else { within.clone() };
            let group_result = self.traverse(Traverse {
              current_table_name: a.current_table_name.clone(),
              data_ref: Val::new_obj(),
              field_prefix: group_field_prefix,
              fields: group_fields(field)?,
              join_query: a.join_query,
              parent_is_localized: child_parent_is_localized,
              path: format!("{sanitized_path}{name}"),
              table: table.clone(),
              table_path: format!("{}{}_", a.table_path, snake(field.get("name"))?),
              within_array_or_block_locale: within_next,
            })?;
            set(&ref_, &ref_key, group_result)?;
            continue;
          }
          "number" => {
            if let Val::Str(s) = &field_data {
              // Lone surrogates are never white space or numeric, so U+FFFD parses the same.
              val = Val::Num(parse_float(&s.to_lossy()));
            }
          }
          "point" => {
            if let Val::Str(s) = &field_data {
              val = json_parse(s)?;
            }
          }
          "relationship" | "upload" => {
            if let JsVal::Str(relation_to) = field.get("relationTo") {
              if val.truthy() {
                let is_number_id = match js_lookup(self.adapter.collections, &JsStr::from(&**relation_to))? {
                  JsLookup::Own(collection) if !collection.is_nullish() => {
                    collection.get("customIDType").as_str() == Some("number")
                  }
                  // An inherited built-in has no `customIDType`.
                  JsLookup::Inherited => false,
                  JsLookup::Own(collection) => {
                    return Err(EngineError::new(
                      "TypeError",
                      format!(
                        "Cannot read properties of {} (reading 'customIDType')",
                        if collection.is_null() { "null" } else { "undefined" }
                      ),
                    ));
                  }
                  JsLookup::Missing => {
                    return Err(EngineError::new(
                      "TypeError",
                      "Cannot read properties of undefined (reading 'customIDType')",
                    ));
                  }
                };
                if is_number_id {
                  val = Val::Num(to_number(&val)?);
                }
              }
            }
          }
          _ => {}
        }

        if let Val::Str(locale) = &locale {
          set(&ref_, locale, val)?;
        } else {
          set(&result, &name, val)?;
        }
      }

      if localized_field_data.as_obj().is_some_and(|o| !o.borrow().is_empty()) {
        set(&result, &name, localized_field_data)?;
      }
    }

    if get(table, "_locales")?.as_arr().is_some() {
      self.defer_delete(table, "_locales");
    }

    Ok(result)
  }
}
