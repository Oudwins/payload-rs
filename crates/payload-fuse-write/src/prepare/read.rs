//! db-mongodb's `transform({ operation: 'read' })` of a stored document plus
//! `sanitizeInternalFields`, on the heap, for the version data `saveVersion` copies (the
//! operation's own result is read by the fused read core, crates/payload-fuse-mongo).

use indexmap::IndexMap;
use std::rc::Rc;

use payload_engine::bson::object_id_to_hex;
use payload_mongo_driver::mongodb::bson::{Bson, Document};

use super::Bail;
use super::heap::{Heap, Node, Ref, V};
use super::plan::{Field, Kind, RelationTo, WritePlan};
use super::transform::iso;

/// The stored document as JS sees it after the driver decodes it.
pub fn import_bson(heap: &mut Heap, value: &Bson) -> Result<V, Bail> {
  Ok(match value {
    Bson::Null => V::Null,
    Bson::Boolean(b) => V::Bool(*b),
    Bson::Int32(n) => V::Num(f64::from(*n)),
    Bson::Int64(n) if n.unsigned_abs() <= (1u64 << 53) => V::Num(*n as f64),
    Bson::Double(n) => V::Num(*n),
    Bson::String(s) => V::str(s),
    Bson::ObjectId(oid) => V::Oid(oid.bytes()),
    Bson::DateTime(dt) => V::Date(dt.timestamp_millis() as f64),
    Bson::Array(items) => {
      let mut out = Vec::with_capacity(items.len());
      for item in items {
        out.push(import_bson(heap, item)?);
      }
      V::Ref(heap.alloc(Node::Arr(out)))
    }
    Bson::Document(doc) => V::Ref(import_document(heap, doc)?),
    _ => return Err(Bail::new("read:bsonType")),
  })
}

pub fn import_document(heap: &mut Heap, doc: &Document) -> Result<Ref, Bail> {
  let mut out = IndexMap::with_capacity(doc.len());
  for (key, value) in doc {
    if super::heap::is_array_index(key) || key == "__proto__" {
      return Err(Bail::new("read:key"));
    }
    out.insert(Rc::from(key.as_str()), import_bson(heap, value)?);
  }
  Ok(heap.alloc(Node::Obj(out)))
}

/// `sanitizeInternalFields(transform(read)(doc))`: the stored document as upstream's operation
/// holds it (`resultWithLocales`).
pub fn read_document(plan: &WritePlan, heap: &mut Heap, doc: &Document) -> Result<Ref, Bail> {
  let data = import_document(heap, doc)?;
  let target = V::Ref(data);
  heap.delete(data, "__v");
  let underscore_id = heap.get(&target, "_id");
  let id = if underscore_id.truthy() { underscore_id } else { heap.get(&target, "id") };
  heap.set(data, "id", id)?;
  heap.delete(data, "_id");
  if let V::Oid(bytes) = heap.get(&target, "id") {
    heap.set(data, "id", V::str(&object_id_to_hex(&bytes)))?;
  }
  if !plan.allow_additional_keys {
    strip_fields(heap, &plan.fields, data, &["id", "globalType"])?;
  }
  sanitize(plan, heap, &plan.fields, data)?;
  Ok(data)
}

/// The data names of `flattenAllFields(fields)` at one level.
fn flattened<'f>(fields: &'f [Field], out: &mut Vec<&'f Field>) {
  for field in fields {
    match field.kind {
      Kind::Row | Kind::Collapsible => flattened(&field.fields, out),
      Kind::Tabs => {
        for tab in &field.tabs {
          flattened(&tab.fields, out);
        }
      }
      _ if field.affects_data() => out.push(field),
      _ => {}
    }
  }
}

/// `stripFields` (no localization, no blocks).
fn strip_fields(heap: &mut Heap, fields: &[Field], data: Ref, reserved: &[&str]) -> Result<(), Bail> {
  let mut level = Vec::new();
  flattened(fields, &mut level);
  for key in heap.keys(data) {
    if !level.iter().any(|f| f.name.as_deref() == Some(&*key)) && !reserved.contains(&&*key) {
      heap.delete(data, &key);
    }
  }
  for field in level {
    let name = field.name.as_deref().unwrap_or_default();
    let value = heap.get(&V::Ref(data), name);
    if !value.truthy() || !Heap::is_object_like(&value) {
      continue;
    }
    match field.kind {
      Kind::Array => {
        let Some(r) = value.as_ref() else { continue };
        let Some(rows) = heap.arr(r).cloned() else { continue };
        let mut has_null = false;
        let mut kept = rows.clone();
        for (i, row) in rows.iter().enumerate() {
          match row.as_ref().filter(|rr| heap.obj(*rr).is_some()) {
            Some(rr) if row.truthy() => strip_fields(heap, &field.fields, rr, &[])?,
            _ if !row.truthy() || !Heap::is_object_like(row) => {
              kept[i] = V::Null;
              has_null = true;
            }
            _ => return Err(Bail::new("read:row")),
          }
        }
        if has_null {
          let filtered: Vec<V> = kept.into_iter().filter(V::truthy).collect();
          let new = heap.alloc(Node::Arr(filtered));
          heap.set(data, name, V::Ref(new))?;
        } else if let Some(arr) = heap.arr_mut(r) {
          *arr = kept;
        }
      }
      Kind::Group => {
        let Some(r) = value.as_ref().filter(|r| heap.obj(*r).is_some()) else {
          return Err(Bail::new("read:group"));
        };
        strip_fields(heap, &field.fields, r, &[])?;
      }
      _ => {}
    }
  }
  Ok(())
}

/// The `sanitize` callback of the read transform over `traverseFields`.
fn sanitize(plan: &WritePlan, heap: &mut Heap, fields: &[Field], data: Ref) -> Result<(), Bail> {
  let target = V::Ref(data);
  for field in fields {
    let name = field.name.as_deref().unwrap_or_default();
    match field.kind {
      Kind::Date => {
        if let V::Date(ms) = heap.get(&target, name) {
          heap.set(data, name, V::str(&iso(ms)?))?;
        }
      }
      Kind::Relationship => {
        let value = heap.get(&target, name);
        if value.truthy() {
          let result = relationship(plan, heap, field, &value)?;
          heap.set(data, name, result)?;
        }
      }
      Kind::Array => {
        if let Some(rows) = heap.get(&target, name).as_ref().and_then(|r| heap.arr(r).cloned()) {
          for row in rows {
            if let Some(r) = row.as_ref().filter(|r| heap.obj(*r).is_some()) {
              sanitize(plan, heap, &field.fields, r)?;
            }
          }
        }
      }
      Kind::Group => {
        if let Some(r) = heap.get(&target, name).as_ref().filter(|r| heap.obj(*r).is_some()) {
          sanitize(plan, heap, &field.fields, r)?;
        }
      }
      Kind::Row | Kind::Collapsible => sanitize(plan, heap, &field.fields, data)?,
      Kind::Tabs => {
        for tab in &field.tabs {
          sanitize(plan, heap, &tab.fields, data)?;
        }
      }
      _ => {}
    }
  }
  Ok(())
}

fn read_id(value: &V) -> V {
  match value {
    V::Oid(bytes) => V::str(&object_id_to_hex(bytes)),
    other => other.clone(),
  }
}

fn relation_object(plan: &WritePlan, heap: &mut Heap, value: &V) -> Result<Option<V>, Bail> {
  if !(heap.is_obj(value) && heap.has(value, "relationTo") && heap.has(value, "value")) {
    return Ok(None);
  }
  let relation_to = heap.get(value, "relationTo");
  match relation_to.as_str() {
    Some(slug) if plan.relations.contains_key(slug) => {}
    _ => return Err(Bail::new("read:relationTo")),
  }
  let converted = read_id(&heap.get(value, "value"));
  let out = heap.new_obj();
  heap.set(out, "relationTo", relation_to)?;
  heap.set(out, "value", converted)?;
  Ok(Some(V::Ref(out)))
}

/// `sanitizeRelationship({ operation: 'read' })`.
fn relationship(plan: &WritePlan, heap: &mut Heap, field: &Field, value: &V) -> Result<V, Bail> {
  let single = matches!(field.relation_to, RelationTo::One(_));
  if let Some(items) = value.as_ref().and_then(|r| heap.arr(r).cloned()) {
    let mut out = Vec::with_capacity(items.len());
    for item in items {
      if item.is_nullish() {
        out.push(item);
        continue;
      }
      if let Some(relation) = relation_object(plan, heap, &item)? {
        out.push(relation);
        continue;
      }
      out.push(if single { read_id(&item) } else { item });
    }
    return Ok(V::Ref(heap.alloc(Node::Arr(out))));
  }
  if let Some(relation) = relation_object(plan, heap, value)? {
    return Ok(relation);
  }
  Ok(if single { read_id(value) } else { value.clone() })
}
