//! JSON encodings used at the TS boundary and by the differential fixtures
//! (`test/__rs/core-query/encode.ts` is the TS twin).
//!
//! Data graphs (`where`, `select`, `policies`, ...) keep object identity:
//! `{ objects: [...], root }`, where an object referenced more than once is
//! stored once in `objects` and referenced as `{"$ref": id}` (ids assigned in
//! first-encounter order of a depth-first, key-ordered walk). Other markers:
//! `{"$undefined": true}`, `{"$num": "NaN" | "Infinity" | "-Infinity"}`,
//! `{"$date": iso | "Invalid Date"}`, and `{"$obj": {...}}` to escape plain
//! objects whose only key is a marker.
//!
//! Config values are encoded as trees in which objects belonging to the
//! decoded config graph are `{"$cfg": [key | index, ...]}` paths from the
//! config root, and functions are `{"$fn": id}`.

use std::collections::HashMap;
use std::rc::Rc;

use payload_engine::js::{JsVal, Obj, num_to_json};
use payload_sql_read::Val;
use payload_sql_read::date::{parse as parse_date, to_iso_string};
use payload_sql_read::value::JsObject;
use serde_json::{Map, Value as Json};

const MARKERS: [&str; 7] = ["$undefined", "$num", "$date", "$obj", "$ref", "$cfg", "$fn"];

fn marker(key: &str, value: Json) -> Json {
  let mut m = Map::new();
  m.insert(key.into(), value);
  Json::Object(m)
}

fn json_f64(n: &serde_json::Number) -> f64 {
  n.to_string().parse::<f64>().unwrap_or(f64::NAN)
}

fn single_marker(o: &Map<String, Json>) -> Option<(&str, &Json)> {
  if o.len() != 1 {
    return None;
  }
  let (k, v) = o.iter().next()?;
  MARKERS.contains(&k.as_str()).then_some((k.as_str(), v))
}

fn non_finite(v: &Json) -> f64 {
  match v.as_str() {
    Some("Infinity") => f64::INFINITY,
    Some("-Infinity") => f64::NEG_INFINITY,
    _ => f64::NAN,
  }
}

/// Decodes a data graph into fresh mutable values (shared objects stay shared).
pub fn decode_data(graph: &Json) -> Val {
  let objects = graph.get("objects").and_then(|o| o.as_array()).cloned().unwrap_or_default();
  let mut decoder = DataDecoder { objects: &objects, cache: vec![None; objects.len()] };
  decoder.decode(graph.get("root").unwrap_or(&Json::Null))
}

struct DataDecoder<'a> {
  objects: &'a [Json],
  cache: Vec<Option<Val>>,
}

impl DataDecoder<'_> {
  fn decode(&mut self, json: &Json) -> Val {
    match json {
      Json::Null => Val::Null,
      Json::Bool(b) => Val::Bool(*b),
      Json::Number(n) => Val::Num(json_f64(n)),
      Json::String(s) => Val::str(s),
      Json::Array(items) => Val::new_arr(items.iter().map(|v| self.decode(v)).collect()),
      Json::Object(o) => {
        if let Some((k, v)) = single_marker(o) {
          match k {
            "$undefined" | "$fn" | "$cfg" => return Val::Undefined,
            "$num" => return Val::Num(non_finite(v)),
            "$date" => return Val::Date(v.as_str().map(parse_date).unwrap_or(f64::NAN)),
            "$obj" => return self.plain(v.as_object().cloned().unwrap_or_default().iter()),
            "$ref" => return self.reference(v.as_u64().unwrap_or(u64::MAX) as usize),
            _ => {}
          }
        }
        self.plain(o.iter())
      }
    }
  }

  fn plain<'b>(&mut self, entries: impl Iterator<Item = (&'b String, &'b Json)>) -> Val {
    let mut obj = JsObject::new();
    for (k, v) in entries {
      obj.define(k.as_str(), self.decode(v));
    }
    Val::from_obj(obj)
  }

  /// Shared objects are created empty first so cycles resolve to the same value.
  fn reference(&mut self, id: usize) -> Val {
    if let Some(Some(v)) = self.cache.get(id) {
      return v.clone();
    }
    let Some(json) = self.objects.get(id).cloned() else { return Val::Undefined };
    let shell = match &json {
      Json::Array(_) => Val::new_arr(Vec::new()),
      _ => Val::new_obj(),
    };
    self.cache[id] = Some(shell.clone());
    match (&json, &shell) {
      (Json::Array(items), Val::Arr(a)) => {
        let decoded: Vec<Val> = items.iter().map(|v| self.decode(v)).collect();
        **a.borrow_mut() = decoded;
      }
      (Json::Object(o), Val::Obj(target)) => {
        let entries: Vec<(String, Json)> = match single_marker(o) {
          Some(("$obj", inner)) => inner.as_object().cloned().unwrap_or_default().into_iter().collect(),
          _ => o.clone().into_iter().collect(),
        };
        for (k, v) in entries {
          let value = self.decode(&v);
          target.borrow_mut().define(k.as_str(), value);
        }
      }
      _ => return self.decode(&json),
    }
    shell
  }
}

fn identity(v: &Val) -> Option<usize> {
  match v {
    Val::Obj(o) => Some(Rc::as_ptr(o) as *const () as usize),
    Val::Arr(a) => Some(Rc::as_ptr(a) as *const () as usize),
    _ => None,
  }
}

/// Encodes a data graph (see module docs); the exact inverse of the TS encoder.
pub fn encode_data(root: &Val) -> Json {
  let mut counts: HashMap<usize, u32> = HashMap::new();
  count(root, &mut counts);
  let mut enc = DataEncoder { counts, ids: HashMap::new(), objects: Vec::new() };
  let root = enc.encode(root);
  let mut out = Map::new();
  out.insert("objects".into(), Json::Array(enc.objects.into_iter().map(|o| o.unwrap_or(Json::Null)).collect()));
  out.insert("root".into(), root);
  Json::Object(out)
}

fn children(v: &Val) -> Vec<Val> {
  match v {
    Val::Obj(o) => o.borrow().entries().into_iter().map(|(_, v)| v).collect(),
    Val::Arr(a) => a.borrow().to_vec(),
    _ => Vec::new(),
  }
}

fn count(v: &Val, counts: &mut HashMap<usize, u32>) {
  let Some(id) = identity(v) else { return };
  let seen = counts.entry(id).or_insert(0);
  *seen += 1;
  if *seen > 1 {
    return;
  }
  for child in children(v) {
    count(&child, counts);
  }
}

struct DataEncoder {
  counts: HashMap<usize, u32>,
  ids: HashMap<usize, usize>,
  objects: Vec<Option<Json>>,
}

impl DataEncoder {
  fn encode(&mut self, v: &Val) -> Json {
    match v {
      Val::Undefined => marker("$undefined", Json::Bool(true)),
      Val::Null => Json::Null,
      Val::Bool(b) => Json::Bool(*b),
      Val::Num(n) if !n.is_finite() => marker("$num", Json::String(payload_engine::js::num_to_js_string(*n))),
      Val::Num(n) => num_to_json(*n),
      Val::Str(s) => Json::String(s.to_lossy().into_owned()),
      Val::Builtin(_) => marker("$undefined", Json::Bool(true)),
      Val::Date(t) => marker("$date", Json::String(to_iso_string(*t).unwrap_or_else(|_| "Invalid Date".into()))),
      Val::Obj(_) | Val::Arr(_) => {
        let id = identity(v).unwrap_or(0);
        if self.counts.get(&id).copied().unwrap_or(0) > 1 {
          if let Some(idx) = self.ids.get(&id) {
            return marker("$ref", Json::from(*idx));
          }
          let idx = self.objects.len();
          self.objects.push(None);
          self.ids.insert(id, idx);
          let container = self.container(v);
          self.objects[idx] = Some(container);
          return marker("$ref", Json::from(idx));
        }
        self.container(v)
      }
    }
  }

  fn container(&mut self, v: &Val) -> Json {
    match v {
      Val::Arr(a) => {
        let items = a.borrow().to_vec();
        Json::Array(items.iter().map(|i| self.encode(i)).collect())
      }
      Val::Obj(o) => {
        let entries = o.borrow().entries();
        let mut out = Map::new();
        for (k, v) in &entries {
          out.insert(k.to_lossy().into_owned(), self.encode(v));
        }
        if out.len() == 1 && out.keys().next().is_some_and(|k| MARKERS.contains(&k.as_str())) {
          marker("$obj", Json::Object(out))
        } else {
          Json::Object(out)
        }
      }
      _ => Json::Null,
    }
  }
}

/// Resolves a `$cfg` path in the config root.
pub fn resolve_cfg_path<'a>(root: &'a JsVal, path: &[Json]) -> Option<&'a JsVal> {
  let mut cur = root;
  for seg in path {
    cur = match (cur, seg) {
      (JsVal::Arr(a), Json::Number(n)) => a.get(n.as_u64()? as usize)?,
      (JsVal::Obj(o), Json::String(k)) => o.get(k)?,
      _ => return None,
    };
  }
  Some(cur)
}

/// Decodes a config value tree (see module docs) against the config root.
pub fn decode_cfg(json: &Json, root: &JsVal) -> JsVal {
  match json {
    Json::Null => JsVal::Null,
    Json::Bool(b) => JsVal::Bool(*b),
    Json::Number(n) => JsVal::Num(json_f64(n)),
    Json::String(s) => JsVal::str(s.as_str()),
    Json::Array(items) => JsVal::arr(items.iter().map(|v| decode_cfg(v, root)).collect()),
    Json::Object(o) => {
      if let Some((k, v)) = single_marker(o) {
        match k {
          "$undefined" => return JsVal::Undefined,
          "$num" => return JsVal::Num(non_finite(v)),
          "$fn" => return JsVal::Fn(v.as_u64().unwrap_or(0) as u32),
          "$cfg" => {
            let path = v.as_array().cloned().unwrap_or_default();
            return resolve_cfg_path(root, &path).cloned().unwrap_or(JsVal::Undefined);
          }
          "$date" => return JsVal::str(v.as_str().unwrap_or("")),
          "$obj" => {
            let mut obj = Obj::new();
            for (k, v) in v.as_object().into_iter().flatten() {
              obj.insert(k.clone(), decode_cfg(v, root));
            }
            return JsVal::obj(obj);
          }
          _ => {}
        }
      }
      let mut obj = Obj::new();
      for (k, v) in o {
        obj.insert(k.clone(), decode_cfg(v, root));
      }
      JsVal::obj(obj)
    }
  }
}
