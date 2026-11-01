//! JSON encoding of JS values that keeps what `JSON.stringify` loses.
//!
//! Used for the transform input/output across the TS boundary and by the
//! golden fixtures (`test/__rs/read/capture/encode.ts` is the TS twin):
//! - `{"$undefined": true}`: `undefined` (own property, array item or root),
//!   also functions (inherited built-ins such as `{}.constructor`)
//! - `{"$num": "NaN" | "Infinity" | "-Infinity"}`: non-finite numbers
//! - `{"$date": "<ISO string>" | "Invalid Date"}`: `Date` instances
//! - `{"$obj": {...}}`: a plain object whose only key is one of the markers
//! - `{"$cycle": true}`: a reference back to an ancestor (output side only)
//!
//! Objects/arrays are encoded as trees (shared references are duplicated).
//! The text form is plain JSON as produced by `JSON.stringify`, including
//! `\udXXX` escapes for lone surrogates, which decode losslessly (see
//! [`crate::json`] and [`crate::jsstr`]). Own `"__proto__"` keys stay own keys.

use std::collections::HashSet;
use std::rc::Rc;

use payload_engine::error::Result;
use payload_engine::js::num_to_json;
use serde_json::{Map, Value as Json};

use crate::date::{parse_js as parse_date, to_iso_string};
use crate::jsstr::JsStr;
use crate::value::{Builtin, JsObject, Val};

const MARKERS: [&str; 6] = ["$undefined", "$num", "$date", "$obj", "$cycle", "$ref"];

/// Parses encoded JSON text into a fresh mutable value.
pub fn decode_text(text: &str) -> Result<Val> {
  Ok(decode(&crate::json::parse(text)?))
}

/// Encodes a value as JSON text (see module docs).
pub fn encode_text(value: &Val) -> Result<String> {
  let tree = encode(value)?;
  Ok(crate::json::stringify(&tree)?.unwrap_or_else(|| "null".into()))
}

/// Interprets the markers of a parsed (plain) encoded tree into a fresh mutable value
/// (iterative, so nesting depth is unbounded like in V8).
pub fn decode(tree: &Val) -> Val {
  enum Work {
    Enter(Val),
    Arr(usize),
    Obj(Vec<JsStr>),
  }
  let mut work = vec![Work::Enter(tree.clone())];
  let mut out: Vec<Val> = Vec::new();
  while let Some(item) = work.pop() {
    match item {
      Work::Enter(value) => match &value {
        Val::Arr(a) => {
          let items = a.borrow().to_vec();
          work.push(Work::Arr(items.len()));
          work.extend(items.into_iter().rev().map(Work::Enter));
        }
        Val::Obj(o) => {
          let mut entries = o.borrow().entries();
          if entries.len() == 1 {
            let (k, v) = &entries[0];
            match k.as_str() {
              Some("$undefined" | "$cycle") => {
                out.push(Val::Undefined);
                continue;
              }
              Some("$num") => {
                out.push(Val::Num(match v.as_js_str().and_then(JsStr::as_str) {
                  Some("Infinity") => f64::INFINITY,
                  Some("-Infinity") => f64::NEG_INFINITY,
                  _ => f64::NAN,
                }));
                continue;
              }
              Some("$date") => {
                out.push(Val::Date(v.as_js_str().map(parse_date).unwrap_or(f64::NAN)));
                continue;
              }
              Some("$obj") => entries = v.as_obj().map(|o| o.borrow().entries()).unwrap_or_default(),
              _ => {}
            }
          }
          let (keys, values): (Vec<JsStr>, Vec<Val>) = entries.into_iter().unzip();
          work.push(Work::Obj(keys));
          work.extend(values.into_iter().rev().map(Work::Enter));
        }
        _ => out.push(value),
      },
      Work::Arr(n) => {
        let items = out.split_off(out.len() - n);
        out.push(Val::new_arr(items));
      }
      Work::Obj(keys) => {
        let values = out.split_off(out.len() - keys.len());
        let mut obj = JsObject::new();
        for (k, v) in keys.iter().zip(values) {
          obj.define(k, v);
        }
        out.push(Val::from_obj(obj));
      }
    }
  }
  out.pop().unwrap_or_default()
}

/// Encodes a value into a plain tree (see module docs). Iterative; a reference back
/// to an ancestor becomes `$cycle`, like `encodeTree`'s `stack.includes(value)`.
pub fn encode(value: &Val) -> Result<Val> {
  enum Work {
    Enter(Val),
    Arr(usize),
    Obj(Vec<JsStr>, bool),
  }
  let mut work = vec![Work::Enter(value.clone())];
  let mut out: Vec<Val> = Vec::new();
  let mut ancestors: Vec<usize> = Vec::new();
  let mut on_path: HashSet<usize> = HashSet::new();
  while let Some(item) = work.pop() {
    match item {
      Work::Enter(value) => match &value {
        Val::Arr(a) => {
          let id = Rc::as_ptr(a) as *const () as usize;
          if !on_path.insert(id) {
            out.push(marker("$cycle", Val::Bool(true)));
            continue;
          }
          ancestors.push(id);
          let items = a.borrow().to_vec();
          work.push(Work::Arr(items.len()));
          work.extend(items.into_iter().rev().map(Work::Enter));
        }
        Val::Obj(o) => {
          let id = Rc::as_ptr(o) as *const () as usize;
          if !on_path.insert(id) {
            out.push(marker("$cycle", Val::Bool(true)));
            continue;
          }
          ancestors.push(id);
          let entries = o.borrow().entries();
          let is_marker_only = entries.len() == 1 && entries[0].0.as_str().is_some_and(|k| MARKERS.contains(&k));
          let (keys, values): (Vec<JsStr>, Vec<Val>) = entries.into_iter().unzip();
          work.push(Work::Obj(keys, is_marker_only));
          work.extend(values.into_iter().rev().map(Work::Enter));
        }
        leaf => out.push(encode_leaf(leaf)),
      },
      Work::Arr(n) => {
        let items = out.split_off(out.len() - n);
        out.push(Val::new_arr(items));
        if let Some(id) = ancestors.pop() {
          on_path.remove(&id);
        }
      }
      Work::Obj(keys, is_marker_only) => {
        let values = out.split_off(out.len() - keys.len());
        let mut obj = JsObject::new();
        for (k, v) in keys.iter().zip(values) {
          obj.define(k, v);
        }
        let obj = Val::from_obj(obj);
        out.push(if is_marker_only { marker("$obj", obj) } else { obj });
        if let Some(id) = ancestors.pop() {
          on_path.remove(&id);
        }
      }
    }
  }
  Ok(out.pop().unwrap_or_default())
}

fn marker(key: &str, value: Val) -> Val {
  let mut m = JsObject::new();
  m.define(key, value);
  Val::from_obj(m)
}

fn encode_leaf(value: &Val) -> Val {
  match value {
    Val::Undefined | Val::Builtin(Builtin::Function(_)) => marker("$undefined", Val::Bool(true)),
    Val::Builtin(Builtin::ObjectPrototype) => Val::new_obj(),
    Val::Num(n) if n.is_nan() => marker("$num", Val::str("NaN")),
    Val::Num(n) if n.is_infinite() => marker("$num", Val::str(if *n > 0.0 { "Infinity" } else { "-Infinity" })),
    Val::Date(t) => marker("$date", Val::str(&to_iso_string(*t).unwrap_or_else(|_| "Invalid Date".into()))),
    other => other.clone(),
  }
}

/// Order-sensitive deep equality of two plain encoded trees (numbers compared
/// as f64, strings by code units, object keys compared in order). Returns the
/// path of the first difference.
pub fn first_difference(expected: &Val, actual: &Val) -> Option<String> {
  diff_at(expected, actual, "$")
}

fn show(v: &Val) -> String {
  encode_text(v).unwrap_or_else(|e| e.to_string())
}

fn diff_at(expected: &Val, actual: &Val, path: &str) -> Option<String> {
  match (expected, actual) {
    (Val::Arr(a), Val::Arr(b)) => {
      let (a, b) = (a.borrow(), b.borrow());
      if a.len() != b.len() {
        return Some(format!("{path}: array length {} != {}", a.len(), b.len()));
      }
      a.iter().zip(b.iter()).enumerate().find_map(|(i, (x, y))| diff_at(x, y, &format!("{path}[{i}]")))
    }
    (Val::Obj(a), Val::Obj(b)) => {
      let (a, b) = (a.borrow().entries(), b.borrow().entries());
      let ka: Vec<&JsStr> = a.iter().map(|(k, _)| k).collect();
      let kb: Vec<&JsStr> = b.iter().map(|(k, _)| k).collect();
      if ka != kb {
        return Some(format!("{path}: keys {ka:?} != {kb:?}"));
      }
      a.iter().zip(b.iter()).find_map(|((k, x), (_, y))| diff_at(x, y, &format!("{path}.{k}")))
    }
    (a, b) if a.strict_eq(b) => None,
    (a, b) => Some(format!("{path}: {} != {}", show(a), show(b))),
  }
}

/// Converts a plain parsed tree to `serde_json` (`None` when a string or key is
/// ill-formed UTF-16, which `serde_json` cannot represent).
pub fn to_serde(tree: &Val) -> Option<Json> {
  Some(match tree {
    Val::Null => Json::Null,
    Val::Bool(b) => Json::Bool(*b),
    Val::Num(n) => num_to_json(*n),
    Val::Str(s) => Json::String(s.as_str()?.to_string()),
    Val::Arr(a) => Json::Array(a.borrow().iter().map(to_serde).collect::<Option<_>>()?),
    Val::Obj(o) => {
      let mut m = Map::new();
      for (k, v) in o.borrow().entries() {
        m.insert(k.as_str()?.to_string(), to_serde(&v)?);
      }
      Json::Object(m)
    }
    _ => return None,
  })
}
