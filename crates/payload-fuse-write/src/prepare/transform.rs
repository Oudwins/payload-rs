//! db-mongodb's `transform({ operation: 'write' })` (packages/db-mongodb/src/utilities/transform.ts)
//! on the heap, for non-localized configs: relationship ids to ObjectIds, `updatedAt`. Values
//! holding `$inc` / `$push` / `$addToSet` / `$remove` (the operator extraction of `updateOne`)
//! bail.

use payload_engine::bson::object_id_bytes_from_hex;

use super::Bail;
use super::heap::{Heap, Node, Ref, V};
use super::plan::{Field, Kind, RelationTo, WritePlan};

/// `transform({ data, fields, operation: 'write' })`; `now` is the clock reading for a missing
/// `updatedAt`, taken only when upstream takes it.
pub fn transform_write(
  plan: &WritePlan,
  heap: &mut Heap,
  fields: &[Field],
  data: Ref,
  now: &mut dyn FnMut() -> Result<f64, Bail>,
) -> Result<(), Bail> {
  traverse(plan, heap, fields, data, false)?;
  match heap.get(&V::Ref(data), "updatedAt") {
    V::Undef => {
      let iso = iso(now()?)?;
      heap.set(data, "updatedAt", V::str(&iso))?;
    }
    V::Null => heap.delete(data, "updatedAt"),
    _ => {}
  }
  Ok(())
}

pub fn iso(ms: f64) -> Result<String, Bail> {
  payload_engine::js::date_to_iso_string(ms).ok_or_else(|| Bail::new("clock:invalid"))
}

fn has_operator(heap: &Heap, value: &V, keys: &[&str]) -> bool {
  heap.is_obj(value) && keys.iter().any(|key| heap.has(value, key))
}

/// The operator also under a locale key (`{ en: { $push } }`).
fn has_locale_operator(heap: &Heap, value: &V, keys: &[&str]) -> bool {
  has_operator(heap, value, keys)
    || value.as_ref().and_then(|r| heap.obj(r)).is_some_and(|o| o.values().any(|v| has_operator(heap, v, keys)))
}

/// The rows payload's `traverseFields` visits for an array value: the rows of an array, and of
/// a localized array the rows of every key holding an array.
pub fn array_rows(heap: &Heap, value: &V, localized: bool) -> Vec<Ref> {
  let rows_of = |v: &V| v.as_ref().and_then(|r| heap.arr(r).cloned()).unwrap_or_default();
  let rows: Vec<V> = match value.as_ref() {
    Some(r) if heap.arr(r).is_some() => rows_of(value),
    Some(r) if localized => heap.obj(r).map(|o| o.values().flat_map(rows_of).collect()).unwrap_or_default(),
    _ => Vec::new(),
  };
  rows.into_iter().filter_map(|row| row.as_ref().filter(|r| heap.obj(*r).is_some())).collect()
}

/// The objects payload's `traverseFields` descends into for a group value: the group, or of a
/// localized group every truthy key's value (non-objects are skipped by the traversal itself).
pub fn group_refs(heap: &Heap, value: &V, localized: bool) -> Result<Vec<Ref>, Bail> {
  let Some(r) = value.as_ref().filter(|r| heap.obj(*r).is_some()) else {
    return Ok(Vec::new());
  };
  if !localized {
    return Ok(vec![r]);
  }
  let mut out = Vec::new();
  for item in heap.obj(r).into_iter().flat_map(|o| o.values()) {
    match item {
      V::Ref(rr) if heap.obj(*rr).is_some() => out.push(*rr),
      V::Ref(_) => return Err(Bail::new("transform:localeArray")),
      _ => {}
    }
  }
  Ok(out)
}

/// The block of a row (`typeof row.blockType === 'string'`, the field's own blocks).
pub fn block_of_row<'f>(heap: &Heap, field: &'f Field, row: Ref) -> Option<&'f super::plan::Block> {
  match heap.get(&V::Ref(row), "blockType") {
    V::Str(block_type) => field.block(&block_type),
    _ => None,
  }
}

/// stripFields' block lookup: `field.blocks.find((each) => each.slug === data.blockType)`.
pub fn block_of_row_loose<'f>(heap: &Heap, field: &'f Field, row: Ref) -> Result<Option<&'f super::plan::Block>, Bail> {
  match heap.get(&V::Ref(row), "blockType") {
    V::Str(block_type) => Ok(field.block(&block_type)),
    V::Undef | V::Null | V::Bool(_) | V::Num(_) => Ok(None),
    _ => Err(Bail::new("read:blockType")),
  }
}

fn traverse(plan: &WritePlan, heap: &mut Heap, fields: &[Field], container: Ref, parent_localized: bool) -> Result<(), Bail> {
  let target = V::Ref(container);
  for field in fields {
    let name = field.name.as_deref().unwrap_or_default();
    let localized = plan.localized_here(field, parent_localized);
    let child_localized = parent_localized || field.localized;
    match field.kind {
      Kind::Number => {
        if has_operator(heap, &heap.get(&target, name), &["$inc"]) {
          return Err(Bail::new("transform:$inc"));
        }
      }
      Kind::Relationship => {
        let value = heap.get(&target, name);
        if field.has_many && has_locale_operator(heap, &value, &["$push", "$remove"]) {
          return Err(Bail::new("transform:$push"));
        }
        if !value.truthy() {
          continue;
        }
        if localized {
          // `for (const { code } of locales)`: each truthy locale value
          let Some(r) = value.as_ref().filter(|r| heap.obj(*r).is_some()) else {
            if heap.is_arr(&value) {
              return Err(Bail::new("transform:localeArray"));
            }
            continue;
          };
          for code in &plan.localization.as_ref().map(|l| l.locale_codes.clone()).unwrap_or_default() {
            let item = heap.get(&value, code);
            if item.truthy() {
              let result = sanitize_relationship(plan, heap, field, &item)?;
              heap.set(r, code, result)?;
            }
          }
        } else {
          let result = sanitize_relationship(plan, heap, field, &value)?;
          heap.set(container, name, result)?;
        }
      }
      Kind::Array => {
        let value = heap.get(&target, name);
        if has_locale_operator(heap, &value, &["$push"]) {
          return Err(Bail::new("transform:$push"));
        }
        for r in array_rows(heap, &value, localized) {
          traverse(plan, heap, &field.fields, r, child_localized)?;
        }
      }
      // a named tab (payload's `traverseFields`, `fillEmpty: false`): skipped unless its value is
      // an object, then like a group
      Kind::Group | Kind::Tab if field.affects_data() => {
        let value = heap.get(&target, name);
        for r in group_refs(heap, &value, localized)? {
          traverse(plan, heap, &field.fields, r, child_localized)?;
        }
      }
      Kind::Blocks => {
        let value = heap.get(&target, name);
        for r in array_rows(heap, &value, localized) {
          if let Some(block) = block_of_row(heap, field, r) {
            traverse(plan, heap, &block.fields, r, child_localized)?;
          }
        }
      }
      // rows, collapsibles, unnamed tabs and unnamed groups: the parent's `ref`
      Kind::Row | Kind::Collapsible | Kind::Tab | Kind::Group => traverse(plan, heap, &field.fields, container, parent_localized)?,
      Kind::Tabs => traverse(plan, heap, &field.tabs, container, parent_localized)?,
      _ => {}
    }
  }
  Ok(())
}

/// `config.collections.find(({ slug }) => slug === relationTo)` (only the collections the plan
/// knows are looked up; another existing slug is not modelled).
fn related_custom_id<'p>(plan: &'p WritePlan, slug: &str) -> Result<&'p Option<String>, Bail> {
  plan.relations.get(slug).ok_or_else(|| Bail::new("transform:unknownCollection"))
}

/// `convertRelationshipValue({ operation: 'write' })`.
fn convert(plan: &WritePlan, slug: &str, value: &V) -> Result<V, Bail> {
  if related_custom_id(plan, slug)?.is_some() {
    return Ok(value.clone());
  }
  match value {
    V::Str(s) => object_id_bytes_from_hex(s).map(V::Oid).ok_or_else(|| Bail::new("transform:objectId")),
    other => Ok(other.clone()),
  }
}

fn is_valid_relation_object(heap: &Heap, value: &V) -> bool {
  heap.is_obj(value) && heap.has(value, "relationTo") && heap.has(value, "value")
}

fn relation_object(plan: &WritePlan, heap: &mut Heap, value: &V) -> Result<Option<V>, Bail> {
  let relation_to = heap.get(value, "relationTo");
  let Some(slug) = relation_to.as_str() else {
    return Err(Bail::new("transform:relationTo"));
  };
  if !plan.relations.contains_key(slug) {
    return Err(Bail::new("transform:unknownCollection"));
  }
  let converted = convert(plan, slug, &heap.get(value, "value"))?;
  let out = heap.new_obj();
  heap.set(out, "relationTo", relation_to.clone())?;
  heap.set(out, "value", converted)?;
  Ok(Some(V::Ref(out)))
}

/// `sanitizeRelationship({ operation: 'write' })`: the value that replaces `ref[field.name]`.
fn sanitize_relationship(plan: &WritePlan, heap: &mut Heap, field: &Field, value: &V) -> Result<V, Bail> {
  let single = match &field.relation_to {
    RelationTo::One(slug) => Some(slug.as_str()),
    _ => None,
  };
  if let Some(items) = value.as_ref().and_then(|r| heap.arr(r).cloned()) {
    let mut out = Vec::with_capacity(items.len());
    for item in items {
      if item.is_nullish() {
        out.push(item);
        continue;
      }
      if is_valid_relation_object(heap, &item) {
        out.push(relation_object(plan, heap, &item)?.unwrap_or(item));
        continue;
      }
      out.push(match single {
        Some(slug) => convert(plan, slug, &item)?,
        None => item,
      });
    }
    return Ok(V::Ref(heap.alloc(Node::Arr(out))));
  }
  if is_valid_relation_object(heap, value) {
    return Ok(relation_object(plan, heap, value)?.unwrap_or_else(|| value.clone()));
  }
  match single {
    Some(slug) => convert(plan, slug, value),
    None => Ok(value.clone()),
  }
}
