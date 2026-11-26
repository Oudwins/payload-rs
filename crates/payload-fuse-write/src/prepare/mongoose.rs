//! mongoose 9 on the heap: the document `new Model(data)` builds and `toObject` / the Node driver
//! serialize (`Model.create`), `castUpdate` for `findOneAndUpdate` / `updateMany`, and the
//! SchemaType casts (lib/cast/*.js, lib/schema/*.js), from the schema plan of `Model.schema`.
//! Anything mongoose would reject (a cast error, an enum violation at `save`) or that the plan does
//! not model bails.

use indexmap::IndexMap;

use payload_core_validate::date::{LocalTz, date_parse};
use payload_core_validate::js::{number_to_string, string_to_number};
use payload_engine::bson::object_id_bytes_from_hex;
use payload_mongo_driver::mongodb::bson::{Bson, DateTime, Document, oid::ObjectId};

use super::Bail;
use super::heap::{Heap, Node, V};
use super::plan::{Instance, Path, PathDefault, Schema};

/// A value as a mongoose document holds it.
#[derive(Clone, Debug)]
enum Cv {
  Undef,
  Null,
  Bool(bool),
  Num(f64),
  Str(String),
  Date(f64),
  Oid([u8; 12]),
  /// A `Mixed` path's value, as given.
  Mixed(V),
  Arr(Vec<Cv>),
  /// A subdocument and its schema's `minimize`.
  Doc(IndexMap<String, Cv>, bool),
}

fn cast_error(path: &str) -> Bail {
  Bail::new(format!("cast:{path}"))
}

/// `Model.create([data])`: the inserted document (`documents[0]`). `new_id` is the `_id`
/// default's reading.
pub fn build_insert(heap: &Heap, schema: &Schema, data: &V, new_id: &mut dyn FnMut() -> Result<[u8; 12], Bail>) -> Result<Document, Bail> {
  if heap.has(data, "id") || heap.has(data, "_id") {
    // the `id` virtual's setter writes `_id`; a given `_id` is cast, then kept
    return Err(Bail::new("insert:id"));
  }
  let mut doc = construct(heap, schema, data, true, Some(new_id))?;
  if let Some(key) = &schema.version_key {
    if !doc.contains_key(key) {
      doc.insert(key.clone(), Cv::Num(0.0));
    }
  }
  to_document(heap, &doc, schema.minimize)
}

/// The `new Constructor(obj)` of a (sub)document: the defaults mongoose applies before the
/// setters (static ones, arrays, and the top-level `_id`'s `auto` ObjectId, whose reading
/// `new_id` takes), `$set(obj)` with `getKeysInSchemaOrder`, the defaults it applies after the
/// setters (document arrays' array defaults), then the reorder by `schema.tree`.
fn construct(
  heap: &Heap,
  schema: &Schema,
  data: &V,
  validate_enums: bool,
  mut new_id: Option<&mut dyn FnMut() -> Result<[u8; 12], Bail>>,
) -> Result<IndexMap<String, Cv>, Bail> {
  if !schema.nested.is_empty() {
    return Err(Bail::new("schema:nested"));
  }
  let Some(obj) = data.as_ref().and_then(|r| heap.obj(r)) else {
    return Err(Bail::new("construct:notObject"));
  };
  let mut doc: IndexMap<String, Cv> = IndexMap::new();
  for (name, path) in &schema.paths {
    if name.contains('.') {
      return Err(Bail::new("schema:dottedPath"));
    }
    let default = match &path.default {
      PathDefault::Static(value) | PathDefault::Array(value) => value,
      PathDefault::Auto => {
        if let Some(new_id) = new_id.as_mut() {
          doc.insert(name.clone(), Cv::Oid(new_id()?));
        }
        continue;
      }
      PathDefault::None | PathDefault::AfterSetters(_) => continue,
    };
    let mut scratch = Heap::default();
    let value = scratch.import(default)?;
    let cast = cast_path(&scratch, path, name, &value, validate_enums)?;
    if !matches!(cast, Cv::Undef) {
      doc.insert(name.clone(), cast);
    }
  }
  let tree_keys = schema.tree.iter().filter(|key| obj.contains_key(key.as_str())).map(|k| k.as_str());
  let rest = obj.keys().map(|k| &**k).filter(|key| !schema.tree.iter().any(|t| t == key));
  let keys: Vec<&str> = tree_keys.chain(rest).collect();
  for key in keys {
    let value = obj.get(key).cloned().unwrap_or(V::Undef);
    if value.is_undef() && doc.get(key).is_some_and(|v| !matches!(v, Cv::Undef)) {
      // "Don't overwrite defaults with undefined keys"
      continue;
    }
    match schema.paths.get(key) {
      Some(path) => {
        let cast = cast_path(heap, path, key, &value, validate_enums)?;
        doc.insert(key.to_string(), cast);
      }
      None if key == "id" && schema.tree.iter().any(|t| t == "id") => {
        if !value.is_undef() {
          return Err(Bail::new("construct:idVirtual"));
        }
      }
      // strict: not a path of the schema
      None => {}
    }
  }
  // `applyDefaults(..., isBeforeSetters: false)`: function defaults that run after the setters
  for (name, path) in &schema.paths {
    let PathDefault::AfterSetters(default) = &path.default else {
      continue;
    };
    if doc.get(name).is_some_and(|value| !matches!(value, Cv::Undef)) {
      continue;
    }
    let mut scratch = Heap::default();
    let value = scratch.import(default)?;
    let cast = cast_path(&scratch, path, name, &value, validate_enums)?;
    if !matches!(cast, Cv::Undef) {
      doc.insert(name.clone(), cast);
    }
  }
  let mut ordered = IndexMap::with_capacity(doc.len());
  for key in &schema.tree {
    if let Some(value) = doc.shift_remove(key) {
      ordered.insert(key.clone(), value);
    }
  }
  ordered.extend(doc);
  Ok(ordered)
}

/// `schemaType.applySetters(value)` (no setters): nullish kept, otherwise `cast`.
fn cast_path(heap: &Heap, path: &Path, name: &str, value: &V, validate_enums: bool) -> Result<Cv, Bail> {
  match value {
    V::Undef => return Ok(Cv::Undef),
    V::Null => return Ok(Cv::Null),
    _ => {}
  }
  let cast = match path.instance {
    Instance::String => Cv::Str(cast_string(heap, value).ok_or_else(|| cast_error(name))?),
    Instance::Number => cast_number(value).ok_or_else(|| cast_error(name))?,
    Instance::Boolean => Cv::Bool(cast_boolean(value).ok_or_else(|| cast_error(name))?),
    Instance::Date => cast_date(value).ok_or_else(|| cast_error(name))?,
    Instance::ObjectId => Cv::Oid(cast_object_id(value).ok_or_else(|| cast_error(name))?),
    Instance::Mixed => Cv::Mixed(value.clone()),
    Instance::Embedded => {
      let sub = path.sub.as_deref().ok_or_else(|| Bail::new("schema:embedded"))?;
      if !heap.is_obj(value) {
        return Err(cast_error(name));
      }
      Cv::Doc(construct(heap, sub, value, validate_enums, None)?, sub.minimize)
    }
    Instance::Array => {
      let items: Vec<V> = match value.as_ref().and_then(|r| heap.arr(r)) {
        Some(items) => items.clone(),
        None if path.doc_array => return Err(cast_error(name)),
        // `castNonArrays`: `[value]`
        None => vec![value.clone()],
      };
      let mut out = Vec::with_capacity(items.len());
      if path.doc_array {
        let sub = path.sub.as_deref().ok_or_else(|| Bail::new("schema:docArray"))?;
        for item in items {
          out.push(if !item.truthy() {
            raw(&item)
          } else if heap.is_obj(&item) {
            // `getConstructor(Constructor, value)`: the embedded discriminator of `value[key]`
            let schema = match &path.discriminator_key {
              Some(key) => match heap.get(&item, key) {
                V::Str(value) => path.discriminators.get(&*value).unwrap_or(sub),
                V::Undef | V::Null => sub,
                _ => return Err(Bail::new("cast:discriminatorValue")),
              },
              None => sub,
            };
            Cv::Doc(construct(heap, schema, &item, validate_enums, None)?, schema.minimize)
          } else {
            return Err(cast_error(name));
          });
        }
      } else {
        let element = path.element.as_deref().ok_or_else(|| Bail::new("schema:array"))?;
        for item in items {
          out.push(cast_path(heap, element, name, &item, validate_enums)?);
        }
      }
      Cv::Arr(out)
    }
  };
  if validate_enums {
    if let (Some(values), Cv::Str(s)) = (&path.enum_values, &cast) {
      if !values.iter().any(|v| v.as_str() == Some(s.as_str())) {
        return Err(Bail::new(format!("enum:{name}")));
      }
    }
  }
  Ok(cast)
}

/// A falsy document array element, kept as is.
fn raw(value: &V) -> Cv {
  match value {
    V::Undef => Cv::Undef,
    V::Null => Cv::Null,
    V::Bool(b) => Cv::Bool(*b),
    V::Num(n) => Cv::Num(*n),
    V::Str(s) => Cv::Str(s.to_string()),
    other => Cv::Mixed(other.clone()),
  }
}

/// lib/cast/string.js
fn cast_string(heap: &Heap, value: &V) -> Option<String> {
  match value {
    V::Str(s) => Some(s.to_string()),
    V::Num(n) => Some(number_to_string(*n)),
    V::Bool(b) => Some(b.to_string()),
    V::Oid(bytes) => Some(payload_engine::bson::object_id_to_hex(bytes)),
    V::Ref(_) if heap.is_obj(value) => match heap.get(value, "_id") {
      V::Str(s) => Some(s.to_string()),
      _ => None,
    },
    _ => None,
  }
}

/// lib/cast/number.js
fn cast_number(value: &V) -> Option<Cv> {
  let n = match value {
    V::Str(s) if s.is_empty() => return Some(Cv::Null),
    V::Str(s) => string_to_number(s),
    V::Bool(b) => f64::from(u8::from(*b)),
    V::Num(n) => *n,
    V::Date(ms) => *ms,
    _ => return None,
  };
  if n.is_nan() { None } else { Some(Cv::Num(n)) }
}

/// lib/cast/boolean.js (`convertToTrue` / `convertToFalse`, SameValueZero).
fn cast_boolean(value: &V) -> Option<bool> {
  match value {
    V::Bool(b) => Some(*b),
    V::Str(s) => match &**s {
      "true" | "1" | "yes" => Some(true),
      "false" | "0" | "no" => Some(false),
      _ => None,
    },
    V::Num(n) if *n == 1.0 => Some(true),
    V::Num(n) if *n == 0.0 => Some(false),
    _ => None,
  }
}

/// `TimeClip`
fn time_clip(ms: f64) -> f64 {
  if !ms.is_finite() || ms.abs() > 8.64e15 { f64::NAN } else { ms.trunc() + 0.0 }
}

struct ProcessTz;

impl LocalTz for ProcessTz {
  fn local_to_utc(&self, local_ms: i64) -> f64 {
    payload_core_validate::tz::local_to_utc(local_ms)
  }
}

/// lib/cast/date.js
fn cast_date(value: &V) -> Option<Cv> {
  let ms = match value {
    V::Str(s) if s.is_empty() => return Some(Cv::Null),
    V::Date(ms) => *ms,
    V::Num(n) => time_clip(*n),
    V::Str(s) => {
      let n = string_to_number(s);
      if !n.is_nan() && (n >= 275761.0 || n < -271820.0) { time_clip(n) } else { time_clip(date_parse(s, &ProcessTz)) }
    }
    _ => return None,
  };
  if ms.is_nan() { None } else { Some(Cv::Date(ms)) }
}

/// lib/cast/objectid.js
fn cast_object_id(value: &V) -> Option<[u8; 12]> {
  match value {
    V::Oid(bytes) => Some(*bytes),
    V::Str(s) => object_id_bytes_from_hex(s),
    _ => None,
  }
}

/// js-bson's number encoding: Int32 for safe integers in range (not `-0`), Double otherwise.
fn number(n: f64) -> Bson {
  let is_int32 = n.fract() == 0.0 && n >= i32::MIN as f64 && n <= i32::MAX as f64 && !(n == 0.0 && n.is_sign_negative());
  if is_int32 { Bson::Int32(n as i32) } else { Bson::Double(n) }
}

fn date(ms: f64) -> Bson {
  Bson::DateTime(DateTime::from_millis(ms as i64))
}

/// `toObject` of a (sub)document: `undefined` properties dropped, and with `minimize` (the
/// document's schema option, inherited by everything below a minimizing subdocument) empty
/// objects too (not inside arrays).
fn to_document(heap: &Heap, doc: &IndexMap<String, Cv>, minimize: bool) -> Result<Document, Bail> {
  let mut out = Document::new();
  for (key, value) in doc {
    if let Some(bson) = to_bson(heap, value, false, minimize)? {
      if minimize && matches!(&bson, Bson::Document(d) if d.is_empty()) {
        continue;
      }
      out.insert(key.clone(), bson);
    }
  }
  Ok(out)
}

/// `toObject` and the driver's serializer (`undefined` array elements are written as null).
fn to_bson(heap: &Heap, value: &Cv, in_array: bool, minimize: bool) -> Result<Option<Bson>, Bail> {
  Ok(Some(match value {
    Cv::Undef if in_array => Bson::Null,
    Cv::Undef => return Ok(None),
    Cv::Null => Bson::Null,
    Cv::Bool(b) => Bson::Boolean(*b),
    Cv::Num(n) => number(*n),
    Cv::Str(s) => Bson::String(s.clone()),
    Cv::Date(ms) => date(*ms),
    Cv::Oid(bytes) => Bson::ObjectId(ObjectId::from_bytes(*bytes)),
    Cv::Mixed(v) => return heap_to_bson_minimized(heap, v, in_array, minimize),
    Cv::Arr(items) => {
      let mut out = Vec::with_capacity(items.len());
      for item in items {
        out.push(to_bson(heap, item, true, minimize)?.unwrap_or(Bson::Null));
      }
      Bson::Array(out)
    }
    // `$toObject` recomputes `minimize` per subdocument from its own schema unless the caller
    // passed it (`_calledWithOptions`; the save path passes none)
    Cv::Doc(doc, own) => Bson::Document(to_document(heap, doc, *own)?),
  }))
}

/// A heap value as `clone` + the driver serialize it; under `cloneObject({ minimize })` empty
/// objects are dropped (not array elements).
fn heap_to_bson_minimized(heap: &Heap, value: &V, in_array: bool, minimize: bool) -> Result<Option<Bson>, Bail> {
  Ok(Some(match value {
    V::Undef if in_array => Bson::Null,
    V::Undef => return Ok(None),
    V::Null => Bson::Null,
    V::Bool(b) => Bson::Boolean(*b),
    V::Num(n) => number(*n),
    V::Str(s) => Bson::String(s.to_string()),
    V::Date(ms) if ms.is_nan() => return Err(Bail::new("bson:invalidDate")),
    V::Date(ms) => date(*ms),
    V::Oid(bytes) => Bson::ObjectId(ObjectId::from_bytes(*bytes)),
    V::Ref(r) => match heap.node(*r) {
      Node::Arr(items) => {
        let mut out = Vec::with_capacity(items.len());
        for item in items {
          out.push(heap_to_bson_minimized(heap, item, true, minimize)?.unwrap_or(Bson::Null));
        }
        Bson::Array(out)
      }
      Node::Obj(props) => {
        let mut out = Document::new();
        for (key, item) in props {
          if let Some(bson) = heap_to_bson_minimized(heap, item, false, minimize)? {
            if minimize && matches!(&bson, Bson::Document(d) if d.is_empty()) {
              continue;
            }
            out.insert(key.to_string(), bson);
          }
        }
        if minimize && !in_array && out.is_empty() {
          return Ok(None);
        }
        Bson::Document(out)
      }
    },
  }))
}

/// `castUpdate(schema, data)` of `Model.findOneAndUpdate(query, data)`: the `$set` sugar (keys in
/// reverse order), each value cast like `castUpdateVal` / `castForQuery` (no enum validation:
/// update validators are off), strict and virtual paths dropped.
pub fn cast_set_update(heap: &Heap, schema: &Schema, data: &V) -> Result<Document, Bail> {
  let Some(obj) = data.as_ref().and_then(|r| heap.obj(r)) else {
    return Err(Bail::new("update:notObject"));
  };
  if !schema.nested.is_empty() {
    return Err(Bail::new("schema:nested"));
  }
  let mut set: IndexMap<String, Cv> = IndexMap::new();
  let keys: Vec<&str> = obj.keys().map(|k| &**k).rev().collect();
  for key in &keys {
    if key.starts_with('$') || key.contains('.') || *key == "_id" {
      return Err(Bail::new("update:key"));
    }
  }
  for key in keys {
    let value = obj.get(key).cloned().unwrap_or(V::Undef);
    let Some(path) = schema.paths.get(key) else {
      // strict: an unknown or virtual path is dropped
      continue;
    };
    let cast = match path.instance {
      Instance::Embedded if heap.is_obj(&value) => {
        if heap.has(&value, "$each") {
          return Err(Bail::new("update:$each"));
        }
        let sub = path.sub.as_deref().ok_or_else(|| Bail::new("schema:embedded"))?;
        Cv::Doc(construct(heap, sub, &value, false, None)?, sub.minimize)
      }
      Instance::Array if heap.is_obj(&value) => return Err(Bail::new("update:arrayObject")),
      _ => cast_path(heap, path, key, &value, false)?,
    };
    if matches!(cast, Cv::Undef) {
      continue;
    }
    set.insert(key.to_string(), cast);
  }
  let mut update = Document::new();
  update.insert("$set", to_document(heap, &set, false)?);
  Ok(update)
}

/// The document `findOneAndUpdate` returns: `stored` with the `$set` applied (MongoDB: existing
/// fields replaced in place, new fields appended in lexicographic order of their names).
pub fn apply_set(stored: &Document, update: &Document) -> Result<Document, Bail> {
  let set = update.get_document("$set").map_err(|_| Bail::new("update:$set"))?;
  let mut out = stored.clone();
  let mut added: Vec<(&String, &Bson)> = Vec::new();
  for (key, value) in set {
    if out.contains_key(key) {
      out.insert(key.clone(), value.clone());
    } else {
      added.push((key, value));
    }
  }
  added.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
  for (key, value) in added {
    out.insert(key.clone(), value.clone());
  }
  Ok(out)
}
