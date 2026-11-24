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
  traverse(plan, heap, fields, data)?;
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

fn traverse(plan: &WritePlan, heap: &mut Heap, fields: &[Field], container: Ref) -> Result<(), Bail> {
  let target = V::Ref(container);
  for field in fields {
    let name = field.name.as_deref().unwrap_or_default();
    match field.kind {
      Kind::Number => {
        if has_operator(heap, &heap.get(&target, name), &["$inc"]) {
          return Err(Bail::new("transform:$inc"));
        }
      }
      Kind::Relationship => {
        let value = heap.get(&target, name);
        if field.has_many && has_operator(heap, &value, &["$push", "$remove"]) {
          return Err(Bail::new("transform:$push"));
        }
        if value.truthy() {
          let result = sanitize_relationship(plan, heap, field, &value)?;
          heap.set(container, name, result)?;
        }
      }
      Kind::Array => {
        let value = heap.get(&target, name);
        if has_operator(heap, &value, &["$push"]) {
          return Err(Bail::new("transform:$push"));
        }
        if let Some(rows) = value.as_ref().and_then(|r| heap.arr(r).cloned()) {
          for row in rows {
            if let Some(r) = row.as_ref().filter(|r| heap.obj(*r).is_some()) {
              traverse(plan, heap, &field.fields, r)?;
            }
          }
        }
      }
      Kind::Group => {
        if let Some(r) = heap.get(&target, name).as_ref().filter(|r| heap.obj(*r).is_some()) {
          traverse(plan, heap, &field.fields, r)?;
        }
      }
      Kind::Row | Kind::Collapsible => traverse(plan, heap, &field.fields, container)?,
      Kind::Tabs => {
        for tab in &field.tabs {
          traverse(plan, heap, &tab.fields, container)?;
        }
      }
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
