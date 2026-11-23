//! `transform({ operation: 'read' })` of packages/db-mongodb/src/utilities/transform.ts on decoded
//! documents, statement by statement in upstream's order (the header, `stripFields`, then payload's
//! `traverseFields` with the `sanitize` callback, read branches only), from a plan of the
//! collection's config.
//!
//! The plan is built in JS from the sanitized config (packages/engine-rs/src/mongo-driver/plan.ts),
//! which is immutable, so it is built once per fields array. Config shapes the plan builder cannot
//! represent exactly (non-string names, field names that are `Object.prototype` members, ...) make
//! the plan ineligible and the calls stay on the mongoose lane.
//!
//! Data shapes upstream would handle through JS semantics this model does not carry (enumerating
//! or reading properties of ObjectId / Date / other bson instances, arrays where objects are
//! traversed, dotted keys the traversal would expand) bail: the call is re-run on the mongoose
//! lane.

use serde_json::Value as Json;

use std::borrow::Cow;

use crate::value::{Bail, LaneResult, Obj, V, date_iso, object_id_hex};

pub type FieldsId = usize;
pub type BlockId = usize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldType {
  Array,
  Blocks,
  Collapsible,
  Date,
  Group,
  Join,
  Relationship,
  Row,
  Tab,
  Tabs,
  Upload,
  Other,
}

impl FieldType {
  fn parse(s: &str) -> Self {
    match s {
      "array" => Self::Array,
      "blocks" => Self::Blocks,
      "collapsible" => Self::Collapsible,
      "date" => Self::Date,
      "group" => Self::Group,
      "join" => Self::Join,
      "relationship" => Self::Relationship,
      "row" => Self::Row,
      "tab" => Self::Tab,
      "tabs" => Self::Tabs,
      "upload" => Self::Upload,
      _ => Self::Other,
    }
  }

  /// payload's `fieldHasSubFields`.
  fn has_sub_fields(self) -> bool {
    matches!(self, Self::Group | Self::Array | Self::Row | Self::Collapsible)
  }
}

#[derive(Debug)]
pub enum BlockRef {
  Slug(String),
  Inline(BlockId),
}

#[derive(Debug)]
pub struct Tab {
  /// `tab.name` when `'name' in tab && tab.name`.
  pub name: Option<String>,
  pub localized: bool,
  pub fields: FieldsId,
}

#[derive(Debug)]
pub struct Field {
  pub ty: FieldType,
  /// `field.name` when `'name' in field`.
  pub name: Option<String>,
  /// `fieldIsPresentationalOnly(field)` (`type === 'ui'`).
  pub is_ui: bool,
  pub localized: bool,
  /// `typeof field.relationTo === 'string'`: the related collection slug.
  pub relation_to: Option<String>,
  /// `Array.isArray(field.collection)` (join fields).
  pub join_collection_is_array: bool,
  /// `field.fields` when `'fields' in field`.
  pub fields: Option<FieldsId>,
  /// `field.flattenedFields` when `'flattenedFields' in field`.
  pub flattened: Option<FieldsId>,
  /// `'blocks' in field`.
  pub has_blocks: bool,
  pub blocks: Vec<BlockRef>,
  /// `field.tabs` when `field.type === 'tabs' && 'tabs' in field`.
  pub tabs: Option<Vec<Tab>>,
}

impl Field {
  fn key(&self) -> &str {
    self.name.as_deref().unwrap_or("undefined")
  }

  /// `fieldShouldBeLocalized({ field, parentIsLocalized })`.
  fn should_localize(&self, parent_is_localized: bool) -> bool {
    self.localized && !parent_is_localized
  }
}

#[derive(Debug)]
pub struct Block {
  pub slug: String,
  pub fields: FieldsId,
  pub flattened: Option<FieldsId>,
}

#[derive(Debug)]
pub struct Localization {
  pub locale_codes: Vec<String>,
  /// `config.localization.locales.map(({ code }) => code)`.
  pub locales: Vec<String>,
}

#[derive(Debug)]
pub struct Plan {
  pub arrays: Vec<Vec<Field>>,
  pub blocks: Vec<Block>,
  /// `config.blocks`, in order.
  pub config_blocks: Vec<BlockId>,
  /// `config.collections` slugs, in order.
  pub collections: Vec<String>,
  pub localization: Option<Localization>,
  /// The `fields` argument of `transform` (traversal).
  pub fields: FieldsId,
  /// `flattenAllFields({ fields })` (`stripFields`).
  pub flattened: FieldsId,
  /// Per fields array (same ids as `arrays`): what the transform consults of it.
  pub indexes: Vec<FieldsIndex>,
}

/// Derived once per fields array (pure functions of the plan): the names `stripFields` keeps, and
/// the only fields whose `stripFields` / traversal steps can have an effect (all others only read
/// their value and continue).
#[derive(Debug, Default)]
pub struct FieldsIndex {
  /// `field.name` of every named field, sorted (membership of `fields.some((f) => f.name === k)`).
  pub names: Vec<String>,
  /// Fields `stripFields` descends into (`'flattenedFields' in field || 'blocks' in field`).
  pub strip_containers: Vec<usize>,
  /// Fields `sanitize` or the traversal act on (date / relationship / upload / join, tabs, tab,
  /// group, array, row, collapsible, blocks).
  pub traverse_active: Vec<usize>,
}

impl FieldsIndex {
  fn of(fields: &[Field]) -> FieldsIndex {
    let mut names: Vec<String> = fields.iter().filter_map(|field| field.name.clone()).collect();
    names.sort();
    names.dedup();
    let strip_containers =
      (0..fields.len()).filter(|&i| fields[i].flattened.is_some() || fields[i].has_blocks).collect();
    let traverse_active = (0..fields.len())
      .filter(|&i| {
        let ty = fields[i].ty;
        matches!(
          ty,
          FieldType::Date
            | FieldType::Relationship
            | FieldType::Upload
            | FieldType::Join
            | FieldType::Tabs
            | FieldType::Tab
            | FieldType::Blocks
        ) || ty.has_sub_fields()
      })
      .collect();
    FieldsIndex { names, strip_containers, traverse_active }
  }

  pub fn has_name(&self, key: &str) -> bool {
    self.names.binary_search_by(|name| name.as_str().cmp(key)).is_ok()
  }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Flags {
  pub allow_additional_keys: bool,
}

fn plan_error(what: &str) -> String {
  format!("invalid transform plan: {what}")
}

fn json_usize(v: Option<&Json>, what: &str) -> Result<usize, String> {
  v.and_then(Json::as_u64).map(|n| n as usize).ok_or_else(|| plan_error(what))
}

fn json_bool(v: Option<&Json>) -> bool {
  v.and_then(Json::as_bool).unwrap_or(false)
}

fn json_string(v: Option<&Json>) -> Option<String> {
  v.and_then(Json::as_str).map(str::to_string)
}

fn json_strings(v: Option<&Json>, what: &str) -> Result<Vec<String>, String> {
  v.and_then(Json::as_array)
    .ok_or_else(|| plan_error(what))?
    .iter()
    .map(|s| s.as_str().map(str::to_string).ok_or_else(|| plan_error(what)))
    .collect()
}

impl Plan {
  pub fn parse(text: &str) -> Result<Plan, String> {
    let json: Json = serde_json::from_str(text).map_err(|e| plan_error(&e.to_string()))?;
    let arrays = json
      .get("fieldsArrays")
      .and_then(Json::as_array)
      .ok_or_else(|| plan_error("fieldsArrays"))?
      .iter()
      .map(|fields| {
        fields
          .as_array()
          .ok_or_else(|| plan_error("fields"))?
          .iter()
          .map(parse_field)
          .collect::<Result<Vec<_>, _>>()
      })
      .collect::<Result<Vec<_>, _>>()?;
    let blocks = json
      .get("blocks")
      .and_then(Json::as_array)
      .ok_or_else(|| plan_error("blocks"))?
      .iter()
      .map(|block| {
        Ok(Block {
          slug: json_string(block.get("slug")).ok_or_else(|| plan_error("block slug"))?,
          fields: json_usize(block.get("fields"), "block fields")?,
          flattened: block.get("flattened").and_then(Json::as_u64).map(|n| n as usize),
        })
      })
      .collect::<Result<Vec<_>, String>>()?;
    let config_blocks = json
      .get("configBlocks")
      .and_then(Json::as_array)
      .ok_or_else(|| plan_error("configBlocks"))?
      .iter()
      .map(|id| json_usize(Some(id), "configBlocks"))
      .collect::<Result<Vec<_>, _>>()?;
    let localization = match json.get("localization") {
      Some(Json::Object(_)) => {
        let loc = &json["localization"];
        Some(Localization {
          locale_codes: json_strings(loc.get("localeCodes"), "localeCodes")?,
          locales: json_strings(loc.get("locales"), "locales")?,
        })
      }
      _ => None,
    };
    let indexes = arrays.iter().map(|fields| FieldsIndex::of(fields)).collect();
    let plan = Plan {
      collections: json_strings(json.get("collections"), "collections")?,
      config_blocks,
      fields: json_usize(json.get("fields"), "fields")?,
      flattened: json_usize(json.get("flattened"), "flattened")?,
      indexes,
      localization,
      arrays,
      blocks,
    };
    plan.check()?;
    Ok(plan)
  }

  fn check(&self) -> Result<(), String> {
    let array_ok = |id: usize| id < self.arrays.len();
    if !array_ok(self.fields) || !array_ok(self.flattened) {
      return Err(plan_error("root ids"));
    }
    for block in &self.blocks {
      if !array_ok(block.fields) || block.flattened.is_some_and(|id| !array_ok(id)) {
        return Err(plan_error("block ids"));
      }
    }
    if self.config_blocks.iter().any(|&id| id >= self.blocks.len()) {
      return Err(plan_error("config block ids"));
    }
    for fields in &self.arrays {
      for field in fields {
        let ids = field.fields.iter().chain(field.flattened.iter());
        let tab_ids = field.tabs.iter().flatten().map(|tab| &tab.fields);
        if ids.chain(tab_ids).any(|&id| !array_ok(id)) {
          return Err(plan_error("field ids"));
        }
        if field
          .blocks
          .iter()
          .any(|block| matches!(block, BlockRef::Inline(id) if *id >= self.blocks.len()))
        {
          return Err(plan_error("inline block ids"));
        }
      }
    }
    Ok(())
  }

  fn config_block(&self, slug: &str) -> Option<&Block> {
    self.config_blocks.iter().map(|&id| &self.blocks[id]).find(|block| block.slug == slug)
  }

  fn has_collection(&self, slug: &str) -> bool {
    self.collections.iter().any(|s| s == slug)
  }
}

fn parse_field(field: &Json) -> Result<Field, String> {
  let ty = FieldType::parse(field.get("type").and_then(Json::as_str).unwrap_or(""));
  let blocks = match field.get("blocks").and_then(Json::as_array) {
    Some(blocks) => blocks
      .iter()
      .map(|block| match (block.get("slug").and_then(Json::as_str), block.get("block")) {
        (Some(slug), _) => Ok(BlockRef::Slug(slug.to_string())),
        (None, Some(id)) => Ok(BlockRef::Inline(json_usize(Some(id), "block ref")?)),
        _ => Err(plan_error("block ref")),
      })
      .collect::<Result<Vec<_>, _>>()?,
    None => Vec::new(),
  };
  let tabs = match field.get("tabs").and_then(Json::as_array) {
    Some(tabs) => Some(
      tabs
        .iter()
        .map(|tab| {
          Ok(Tab {
            fields: json_usize(tab.get("fields"), "tab fields")?,
            localized: json_bool(tab.get("localized")),
            name: json_string(tab.get("name")),
          })
        })
        .collect::<Result<Vec<_>, String>>()?,
    ),
    None => None,
  };
  Ok(Field {
    ty,
    is_ui: field.get("type").and_then(Json::as_str) == Some("ui"),
    name: json_string(field.get("name")),
    localized: json_bool(field.get("localized")),
    relation_to: json_string(field.get("relationTo")),
    join_collection_is_array: json_bool(field.get("joinCollectionIsArray")),
    fields: field.get("fields").and_then(Json::as_u64).map(|n| n as usize),
    flattened: field.get("flattened").and_then(Json::as_u64).map(|n| n as usize),
    has_blocks: json_bool(field.get("hasBlocks")),
    blocks,
    tabs,
  })
}

/// The id handling of a read (`doc.id = String(doc._id)` of mongoose-paginate-v2's `leanWithId`
/// before transform, when the read went through `Model.paginate`).
#[derive(Debug, Clone, Copy)]
pub struct ReadShape {
  pub lean_with_id: bool,
}

/// `transform({ adapter, data: doc, fields, operation: 'read' })` on one document.
pub fn transform_read<'a>(plan: &Plan, flags: Flags, shape: ReadShape, doc: &mut Obj<'a>) -> LaneResult<()> {
  if shape.lean_with_id && doc.get("_id").is_some_and(V::truthy) {
    // `doc.id = String(doc._id)`: transform overwrites the value below (the `_id` is truthy);
    // only the key's position remains
    if !doc.has("id") {
      doc.set("id", V::Undefined);
    }
  }
  doc.delete("__v");
  let id = match doc.get("_id") {
    Some(id) if id.truthy() => id.clone(),
    _ => doc.get("id").cloned().unwrap_or(V::Undefined),
  };
  doc.set("id", id);
  doc.delete("_id");
  if let Some(V::ObjectId(bytes)) = doc.get("id") {
    let hex = object_id_hex(bytes);
    doc.set("id", V::Str(Cow::Owned(hex)));
  }
  if !flags.allow_additional_keys {
    strip_fields(plan, doc, plan.flattened, false, &["id", "globalType"])?;
  }
  traverse_fields(plan, plan.fields, false, doc)
}

/// The plain object `value` holds (decoded), or a bail: upstream would enumerate / read the
/// properties of an array or a bson instance here.
fn obj_mut<'v, 'a>(value: &'v mut V<'a>, what: &'static str) -> LaneResult<&'v mut Obj<'a>> {
  value.obj_mut()?.ok_or(Bail(what))
}

/// `stripFields` (transform.ts).
fn strip_fields<'a>(
  plan: &Plan,
  data: &mut Obj<'a>,
  fields_id: FieldsId,
  parent_is_localized: bool,
  reserved_keys: &[&str],
) -> LaneResult<()> {
  let fields = &plan.arrays[fields_id];
  let index = &plan.indexes[fields_id];
  data.0.retain(|(k, _)| index.has_name(k) || reserved_keys.contains(&k.as_ref()));

  for &field_index in &index.strip_containers {
    let field = &fields[field_index];
    let mut reserved: Vec<&str> = Vec::new();
    let key = field.key();
    let Some(field_data) = data.get_mut(key) else {
      continue;
    };
    if !field_data.truthy() || !field_data.is_object_type() {
      continue;
    }
    let should_localize = field.should_localize(parent_is_localized);
    if field.ty == FieldType::Blocks {
      reserved.push("blockType");
    }
    if !(field.flattened.is_some() || field.has_blocks) {
      continue;
    }
    let child_localized = parent_is_localized || field.localized;
    let is_rows = matches!(field.ty, FieldType::Array | FieldType::Blocks);

    if let (true, Some(localization)) = (should_localize, plan.localization.as_ref()) {
      let field_data = obj_mut(field_data, "localized container is not an object")?;
      field_data.0.retain(|(locale, _)| localization.locale_codes.iter().any(|code| code == locale));
      for (_, locale_data) in field_data.0.iter_mut() {
        if !locale_data.truthy() || !locale_data.is_object_type() {
          continue;
        }
        if is_rows {
          let Some(rows) = locale_data.arr_mut()? else {
            continue;
          };
          if strip_rows(plan, field, rows, child_localized, &reserved)? {
            rows.retain(V::truthy);
          }
          continue;
        }
        let Some(flattened) = field.flattened else {
          return Err(Bail("container without flattenedFields"));
        };
        strip_fields(plan, obj_mut(locale_data, "container is not an object")?, flattened, child_localized, &reserved)?;
      }
      continue;
    }

    if is_rows {
      let Some(rows) = field_data.arr_mut()? else {
        continue;
      };
      if strip_rows(plan, field, rows, child_localized, &reserved)? {
        // `data[field.name] = fieldData.filter(Boolean)` (same key, same position)
        rows.retain(V::truthy);
      }
      continue;
    }
    let Some(flattened) = field.flattened else {
      return Err(Bail("container without flattenedFields"));
    };
    strip_fields(plan, obj_mut(field_data, "container is not an object")?, flattened, child_localized, &reserved)?;
  }
  Ok(())
}

/// The rows loop of `stripFields` for array / blocks data; returns `hasNull`.
fn strip_rows<'a>(
  plan: &Plan,
  field: &Field,
  rows: &mut [V<'a>],
  child_localized: bool,
  reserved: &[&str],
) -> LaneResult<bool> {
  let mut has_null = false;
  for row in rows.iter_mut() {
    if !row.truthy() || !row.is_object_type() {
      *row = V::Null;
      has_null = true;
      continue;
    }
    let row_obj = obj_mut(row, "row is not an object")?;
    let fields = if field.ty == FieldType::Array {
      // `fields = field.flattenedFields` (`if (!fields) continue`)
      field.flattened
    } else {
      // `field.blocks.find((each) => (typeof each === 'string' ? each : each.slug) === data.blockType)`
      let block_type = row_obj.get("blockType");
      let found = field.blocks.iter().find(|each| {
        let slug = match each {
          BlockRef::Slug(slug) => slug.as_str(),
          BlockRef::Inline(id) => plan.blocks[*id].slug.as_str(),
        };
        block_type.and_then(V::as_str) == Some(slug)
      });
      let maybe_block = match found {
        Some(BlockRef::Slug(slug)) => plan.config_block(slug),
        Some(BlockRef::Inline(id)) => Some(&plan.blocks[*id]),
        None => None,
      };
      match maybe_block {
        // `fields = maybeBlock.flattenedFields` (undefined: the row is skipped)
        Some(block) => block.flattened,
        None => {
          *row = V::Null;
          has_null = true;
          None
        }
      }
    };
    let Some(fields) = fields else {
      continue;
    };
    let row_obj = obj_mut(row, "row is not an object")?;
    strip_fields(plan, row_obj, fields, child_localized, reserved)?;
  }
  Ok(has_null)
}

/// payload's `traverseFields` (utilities/traverseFields.ts) with `fillEmpty: false`, not
/// `leavesFirst`, and transform's `sanitize` as the callback (which never returns truthy, so every
/// level ends with the dotted-key fallback).
fn traverse_fields<'a>(plan: &Plan, fields_id: FieldsId, parent_is_localized: bool, r#ref: &mut Obj<'a>) -> LaneResult<()> {
  let fields = &plan.arrays[fields_id];
  for &field_index in &plan.indexes[fields_id].traverse_active {
    let field = &fields[field_index];
    sanitize(plan, field, parent_is_localized, r#ref)?;

    if field.ty == FieldType::Tabs {
      if let Some(tabs) = &field.tabs {
        for tab in tabs {
          let tab_is_localized = tab.localized && !parent_is_localized;
          match &tab.name {
            Some(name) => {
              let Some(tab_ref) = r#ref.get_mut(name) else {
                continue;
              };
              if !tab_ref.truthy() || !tab_ref.is_object_type() {
                continue;
              }
              // the callback for `{ ...tab, type: 'tab' }` does nothing on reads
              if tab_is_localized {
                let tab_ref = obj_mut(tab_ref, "localized tab is not an object")?;
                for (_, locale_ref) in tab_ref.0.iter_mut() {
                  if locale_ref.truthy() && locale_ref.is_object_type() {
                    let locale_ref = obj_mut(locale_ref, "tab locale is not an object")?;
                    traverse_fields(plan, tab.fields, true, locale_ref)?;
                  }
                }
              } else {
                let tab_ref = obj_mut(tab_ref, "tab is not an object")?;
                traverse_fields(plan, tab.fields, parent_is_localized, tab_ref)?;
              }
            }
            None => {
              if !tab_is_localized {
                traverse_fields(plan, tab.fields, parent_is_localized, r#ref)?;
              }
            }
          }
        }
        continue;
      }
    }

    if field.ty == FieldType::Tab || field.ty.has_sub_fields() || field.ty == FieldType::Blocks {
      match field.name.as_deref().filter(|name| !name.is_empty()) {
        Some(name) => {
          let Some(value) = r#ref.get_mut(name) else {
            continue;
          };
          if !value.truthy() {
            continue;
          }
          traverse_container(plan, field, parent_is_localized, value)?;
        }
        None => {
          // `currentRef = ref`: traversed in place
          let mut holder = V::Obj(std::mem::take(r#ref));
          let result = traverse_container(plan, field, parent_is_localized, &mut holder);
          if let V::Obj(obj) = holder {
            *r#ref = obj;
          }
          result?;
        }
      }
    }
  }

  // Fallback: dot-notation keys of this level would be expanded (and traversed again)
  if r#ref.0.iter().any(|(key, _)| key.contains('.')) {
    return Err(Bail("dotted key"));
  }
  Ok(())
}

/// The container part of `traverseFields` for one field, `current` being `currentRef`.
fn traverse_container<'a>(plan: &Plan, field: &Field, parent_is_localized: bool, current: &mut V<'a>) -> LaneResult<()> {
  let should_localize = field.should_localize(parent_is_localized);
  if matches!(field.ty, FieldType::Tab | FieldType::Group) && should_localize && current.is_object_type() {
    let Some(fields) = field.fields else {
      return Err(Bail("group without fields"));
    };
    // fieldAffectsData: 'name' in field && !presentational
    if field.name.is_some() && !field.is_ui {
      let current = obj_mut(current, "localized group is not an object")?;
      for (_, locale_ref) in current.0.iter_mut() {
        if !locale_ref.is_object_type() {
          // a primitive `ref`: every field returns early, no fallback
          continue;
        }
        if !locale_ref.truthy() {
          continue;
        }
        let locale_ref = obj_mut(locale_ref, "group locale is not a plain object")?;
        traverse_fields(plan, fields, true, locale_ref)?;
      }
    } else {
      traverse_fields(plan, fields, parent_is_localized, obj_mut(current, "group is not an object")?)?;
    }
    return Ok(());
  }

  if matches!(field.ty, FieldType::Blocks | FieldType::Array) && current.is_object_type() {
    if should_localize {
      if current.is_array() {
        let rows = current.arr_mut()?.expect("array");
        traverse_rows(plan, field, rows, true)?;
      } else {
        let locales = obj_mut(current, "localized rows container")?;
        for (_, locale_data) in locales.0.iter_mut() {
          if let Some(rows) = if locale_data.is_array() { locale_data.arr_mut()? } else { None } {
            traverse_rows(plan, field, rows, true)?;
          }
        }
      }
    } else if current.is_array() {
      let rows = current.arr_mut()?.expect("array");
      traverse_rows(plan, field, rows, parent_is_localized)?;
    }
    return Ok(());
  }

  if current.is_object_type() {
    if let Some(fields) = field.fields {
      traverse_fields(plan, fields, parent_is_localized, obj_mut(current, "container is not an object")?)?;
    }
  }
  Ok(())
}

/// `traverseArrayOrBlocksField` with `fillEmpty: false`.
fn traverse_rows<'a>(plan: &Plan, field: &Field, rows: &mut [V<'a>], parent_is_localized: bool) -> LaneResult<()> {
  let child_localized = parent_is_localized || field.localized;
  for row in rows.iter_mut() {
    let fields = if field.ty == FieldType::Blocks {
      let block_type = if row.is_plain_object() {
        obj_mut(row, "row")?.get("blockType").and_then(V::as_str).map(str::to_string)
      } else if matches!(row, V::ObjectId(_) | V::Date(_) | V::Opaque(_)) {
        return Err(Bail("bson value as block row"));
      } else {
        None
      };
      match block_type {
        Some(block_type) => {
          // `config?.blocks?.find(...) ?? field.blocks.find((b) => typeof b !== 'string' && ...)`
          let block = plan.config_block(&block_type).or_else(|| {
            field.blocks.iter().find_map(|each| match each {
              BlockRef::Inline(id) if plan.blocks[*id].slug == block_type => Some(&plan.blocks[*id]),
              _ => None,
            })
          });
          block.map(|block| block.fields)
        }
        None => None,
      }
    } else if field.ty == FieldType::Array {
      field.fields
    } else {
      None
    };
    let Some(fields) = fields else {
      continue;
    };
    if row.is_plain_object() {
      traverse_fields(plan, fields, child_localized, obj_mut(row, "row")?)?;
    } else if !matches!(row, V::Undefined | V::Null | V::Bool(_) | V::Num(_) | V::Int(_) | V::Str(_)) {
      // primitives: every field returns early, no fallback
      return Err(Bail("row is not a plain object"));
    }
  }
  Ok(())
}

/// The read branches of transform's `sanitize` callback.
fn sanitize<'a>(plan: &Plan, field: &Field, parent_is_localized: bool, r#ref: &mut Obj<'a>) -> LaneResult<()> {
  let localization = plan.localization.as_ref();
  let should_localize = localization.is_some() && field.should_localize(parent_is_localized);
  match field.ty {
    FieldType::Date => {
      let Some(value) = r#ref.get_mut(field.key()) else {
        return Ok(());
      };
      if !value.truthy() {
        return Ok(());
      }
      if should_localize {
        if !value.is_object_type() {
          return Ok(());
        }
        let field_ref = obj_mut(value, "localized date is not an object")?;
        for locale in &localization.expect("localized").locale_codes {
          if let Some(locale_value) = field_ref.get_mut(locale) {
            sanitize_date(locale_value)?;
          }
        }
      } else {
        sanitize_date(value)?;
      }
    }
    FieldType::Relationship | FieldType::Upload | FieldType::Join => {
      let Some(value) = r#ref.get_mut(field.key()) else {
        return Ok(());
      };
      if !value.truthy() {
        return Ok(());
      }
      if should_localize {
        if !value.is_object_type() {
          return Ok(());
        }
        let field_ref = obj_mut(value, "localized relationship is not an object")?;
        for code in &localization.expect("localized").locales {
          if let Some(locale_value) = field_ref.get_mut(code) {
            if locale_value.truthy() {
              sanitize_relationship(plan, field, locale_value)?;
            }
          }
        }
      } else {
        sanitize_relationship(plan, field, value)?;
      }
    }
    _ => {}
  }
  Ok(())
}

/// `sanitizeDate` (the value is truthy): Dates become ISO strings, anything else is assigned back
/// unchanged.
fn sanitize_date(value: &mut V<'_>) -> LaneResult<()> {
  if !value.truthy() {
    return Ok(());
  }
  if let V::Date(ms) = value {
    *value = V::Str(Cow::Owned(date_iso(*ms).ok_or(Bail("invalid date"))?));
  }
  Ok(())
}

/// `isValidRelationObject` (plain objects with own `relationTo` and `value`).
fn is_relation_object(value: &mut V<'_>) -> LaneResult<bool> {
  if !value.is_plain_object() {
    return Ok(false);
  }
  let obj = value.obj_mut()?.expect("object");
  Ok(obj.has("relationTo") && obj.has("value"))
}

/// `convertRelationshipValue` (read).
fn convert_relationship_value(value: V<'_>) -> V<'_> {
  match value {
    V::ObjectId(bytes) => V::Str(Cow::Owned(object_id_hex(&bytes))),
    other => other,
  }
}

/// `{ relationTo: val.relationTo, value: convertRelationshipValue(...) }` when `val.relationTo`
/// names a collection.
fn convert_relation_object<'a>(plan: &Plan, obj: &Obj<'a>) -> Option<V<'a>> {
  let relation_to = obj.get("relationTo")?;
  if !plan.has_collection(relation_to.as_str()?) {
    return None;
  }
  let value = obj.get("value").cloned().unwrap_or(V::Undefined);
  Some(V::Obj(Obj(vec![
    (Cow::Borrowed("relationTo"), relation_to.clone()),
    (Cow::Borrowed("value"), convert_relationship_value(value)),
  ])))
}

/// `sanitizeRelationship` (read); `value` is `ref[key]` and receives the result.
fn sanitize_relationship<'a>(plan: &Plan, field: &Field, value: &mut V<'a>) -> LaneResult<()> {
  if field.ty == FieldType::Join {
    if value.is_plain_object() {
      let join = value.obj_mut()?.expect("object");
      if let Some(docs) = join.get_mut("docs") {
        if let Some(docs) = if docs.is_array() { docs.arr_mut()? } else { None } {
          for item in docs.iter_mut() {
            if let V::ObjectId(bytes) = item {
              *item = V::Str(Cow::Owned(object_id_hex(bytes)));
            } else if field.join_collection_is_array && item.truthy() {
              *item = json_round_trip(item)?;
            }
          }
        }
      }
    } else if matches!(value, V::ObjectId(_) | V::Date(_) | V::Opaque(_)) {
      return Err(Bail("bson value as join value"));
    }
    return Ok(());
  }

  let related = field.relation_to.as_deref().filter(|slug| plan.has_collection(slug));
  if value.is_array() {
    let items = value.arr_mut()?.expect("array");
    for item in items.iter_mut() {
      if matches!(item, V::Null | V::Undefined) {
        continue;
      }
      if is_relation_object(item)? {
        if let Some(converted) = convert_relation_object(plan, item.obj_mut()?.expect("object")) {
          *item = converted;
          continue;
        }
      }
      if related.is_some() {
        let taken = std::mem::replace(item, V::Undefined);
        *item = convert_relationship_value(taken);
      }
    }
  } else if is_relation_object(value)? {
    if let Some(converted) = convert_relation_object(plan, value.obj_mut()?.expect("object")) {
      *value = converted;
    }
    // otherwise `relatedCollection` was reassigned to the (missing) polymorphic one: unchanged
  } else if related.is_some() {
    let taken = std::mem::replace(value, V::Undefined);
    *value = convert_relationship_value(taken);
  }
  Ok(())
}

/// `JSON.parse(JSON.stringify(value))`.
fn json_round_trip<'a>(value: &mut V<'a>) -> LaneResult<V<'a>> {
  value.materialize()?;
  Ok(match value {
    V::Undefined => V::Undefined,
    V::Null => V::Null,
    V::Bool(b) => V::Bool(*b),
    V::Num(n) => {
      if n.is_finite() {
        V::Num(*n)
      } else {
        V::Null
      }
    }
    V::Int(i) => V::Int(*i),
    V::Str(s) => V::Str(s.clone()),
    V::ObjectId(bytes) => V::Str(Cow::Owned(object_id_hex(bytes))),
    V::Date(ms) => match date_iso(*ms) {
      Some(iso) => V::Str(Cow::Owned(iso)),
      None => V::Null,
    },
    V::Arr(items) => {
      let mut out = Vec::with_capacity(items.len());
      for item in items.iter_mut() {
        out.push(match json_round_trip(item)? {
          V::Undefined => V::Null,
          other => other,
        });
      }
      V::Arr(out)
    }
    V::Obj(obj) => {
      let mut out = Obj::default();
      for (key, item) in obj.0.iter_mut() {
        match json_round_trip(item)? {
          V::Undefined => {}
          other => out.0.push((key.clone(), other)),
        }
      }
      V::Obj(out)
    }
    V::Opaque(kind) => return Err(Bail(kind)),
    V::RawDoc(_) | V::RawArr(_) => unreachable!("materialized"),
  })
}
