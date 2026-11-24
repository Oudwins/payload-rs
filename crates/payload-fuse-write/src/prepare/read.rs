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
    strip_fields(plan, heap, &plan.fields, data, &["id", "globalType"], false)?;
  }
  sanitize(plan, heap, &plan.fields, data, false)?;
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

/// `stripFields` (no blocks).
fn strip_fields(plan: &WritePlan, heap: &mut Heap, fields: &[Field], data: Ref, reserved: &[&str], parent_localized: bool) -> Result<(), Bail> {
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
    if !matches!(field.kind, Kind::Array | Kind::Group | Kind::Blocks) {
      continue;
    }
    let child_localized = parent_localized || field.localized;
    if plan.localized_here(field, parent_localized) {
      let codes = plan.localization.as_ref().map(|l| l.locale_codes.clone()).unwrap_or_default();
      let Some(r) = value.as_ref().filter(|r| heap.obj(*r).is_some()) else {
        return Err(Bail::new("read:localeArray"));
      };
      for key in heap.keys(r) {
        if !codes.iter().any(|c| c == &*key) {
          heap.delete(r, &key);
          continue;
        }
        let locale_value = heap.get(&value, &key);
        if !locale_value.truthy() || !Heap::is_object_like(&locale_value) {
          continue;
        }
        strip_value(plan, heap, field, r, &key, &locale_value, child_localized)?;
      }
      continue;
    }
    strip_value(plan, heap, field, data, name, &value, child_localized)?;
  }
  Ok(())
}

/// `stripFields` of one array or group value (`holder[key]`).
fn strip_value(plan: &WritePlan, heap: &mut Heap, field: &Field, holder: Ref, key: &str, value: &V, child_localized: bool) -> Result<(), Bail> {
  match field.kind {
    Kind::Array | Kind::Blocks => {
      let Some(r) = value.as_ref() else { return Ok(()) };
      let Some(rows) = heap.arr(r).cloned() else { return Ok(()) };
      let mut has_null = false;
      let mut kept = rows.clone();
      for (i, row) in rows.iter().enumerate() {
        match row.as_ref().filter(|rr| heap.obj(*rr).is_some()) {
          Some(rr) if field.kind == Kind::Blocks => match super::transform::block_of_row_loose(heap, field, rr)? {
            Some(block) => strip_fields(plan, heap, &block.fields, rr, &["blockType"], child_localized)?,
            None => {
              kept[i] = V::Null;
              has_null = true;
            }
          },
          Some(rr) if row.truthy() => strip_fields(plan, heap, &field.fields, rr, &[], child_localized)?,
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
        heap.set(holder, key, V::Ref(new))?;
      } else if let Some(arr) = heap.arr_mut(r) {
        *arr = kept;
      }
    }
    Kind::Group => {
      let Some(r) = value.as_ref().filter(|r| heap.obj(*r).is_some()) else {
        return Err(Bail::new("read:group"));
      };
      strip_fields(plan, heap, &field.fields, r, &[], child_localized)?;
    }
    _ => {}
  }
  Ok(())
}

/// The `sanitize` callback of the read transform over `traverseFields`.
fn sanitize(plan: &WritePlan, heap: &mut Heap, fields: &[Field], data: Ref, parent_localized: bool) -> Result<(), Bail> {
  let target = V::Ref(data);
  let codes = plan.localization.as_ref().map(|l| l.locale_codes.clone()).unwrap_or_default();
  for field in fields {
    let name = field.name.as_deref().unwrap_or_default();
    let localized = plan.localized_here(field, parent_localized);
    let child_localized = parent_localized || field.localized;
    match field.kind {
      Kind::Date => {
        let value = heap.get(&target, name);
        if !value.truthy() {
          continue;
        }
        if localized {
          let Some(r) = value.as_ref().filter(|r| heap.obj(*r).is_some()) else {
            continue;
          };
          for code in &codes {
            if let V::Date(ms) = heap.get(&value, code) {
              heap.set(r, code, V::str(&iso(ms)?))?;
            }
          }
        } else if let V::Date(ms) = value {
          heap.set(data, name, V::str(&iso(ms)?))?;
        }
      }
      Kind::Relationship => {
        let value = heap.get(&target, name);
        if !value.truthy() {
          continue;
        }
        if localized {
          let Some(r) = value.as_ref().filter(|r| heap.obj(*r).is_some()) else {
            continue;
          };
          for code in &codes {
            let item = heap.get(&value, code);
            if item.truthy() {
              let result = relationship(plan, heap, field, &item)?;
              heap.set(r, code, result)?;
            }
          }
        } else {
          let result = relationship(plan, heap, field, &value)?;
          heap.set(data, name, result)?;
        }
      }
      Kind::Array => {
        let value = heap.get(&target, name);
        for r in super::transform::array_rows(heap, &value, localized) {
          sanitize(plan, heap, &field.fields, r, child_localized)?;
        }
      }
      Kind::Group => {
        let value = heap.get(&target, name);
        for r in super::transform::group_refs(heap, &value, localized)? {
          sanitize(plan, heap, &field.fields, r, child_localized)?;
        }
      }
      Kind::Blocks => {
        let value = heap.get(&target, name);
        for r in super::transform::array_rows(heap, &value, localized) {
          if let Some(block) = super::transform::block_of_row(heap, field, r) {
            sanitize(plan, heap, &block.fields, r, child_localized)?;
          }
        }
      }
      Kind::Row | Kind::Collapsible => sanitize(plan, heap, &field.fields, data, parent_localized)?,
      Kind::Tabs => {
        for tab in &field.tabs {
          sanitize(plan, heap, &tab.fields, data, parent_localized)?;
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
