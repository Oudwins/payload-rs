//! What a fused lane (work package A, packages/engine-rs/FUSE_CONTRACT.md) needs to evaluate a
//! compiled function from Rust: conversions from the core's [`JsVal`] trees and builders for the
//! argument objects Payload passes, in upstream's key order.
//!
//! ```ignore
//! let req = lanes::request(&lanes::RequestSnapshot { user: Value::from_js_val(&user), ..Default::default() });
//! let args = lanes::collection_access_args(Value::Undefined, "posts", Value::Undefined, req);
//! if !guard::lane_should_verify(id) {
//!   match payload_fn_ir::evaluate(id, &[args]) {
//!     Ok(v) => /* `v.truthy()`: allowed; an object: a where constraint (`v.to_js_val()`) */,
//!     Err(_) => /* bail: run the exact lane */,
//!   }
//! }
//! ```

use std::collections::HashMap;
use std::sync::Arc;

use payload_engine::js::JsVal;

use crate::value::{Object, OpaqueKind, Value};

const MAX_DEPTH: u32 = 200;

impl Value {
  /// Converts a core value. Shared containers stay shared (strict equality between two references
  /// to one object holds); typed values (dates, bigints, BSON), host objects and functions are
  /// opaque. Objects are closed.
  pub fn from_js_val(v: &JsVal) -> Value {
    Value::from_js_val_with(v, &|_| false)
  }

  /// [`Value::from_js_val`] where `is_opaque` also makes values opaque (a lane's placeholders
  /// for values it holds elsewhere).
  pub fn from_js_val_with(v: &JsVal, is_opaque: &dyn Fn(&JsVal) -> bool) -> Value {
    let mut shared = HashMap::new();
    from_js_val(v, &mut shared, 0, is_opaque)
  }

  /// Converts a result to a core value; `None` when it holds something without a core
  /// equivalent (a compiled function, a regexp, an opaque value, a partial object).
  pub fn to_js_val(&self) -> Option<JsVal> {
    Some(match self {
      Value::Undefined => JsVal::Undefined,
      Value::Null => JsVal::Null,
      Value::Bool(b) => JsVal::Bool(*b),
      Value::Number(n) => JsVal::Num(*n),
      Value::String(s) => JsVal::Str(s.clone()),
      Value::Array(items) => JsVal::arr(items.iter().map(Value::to_js_val).collect::<Option<_>>()?),
      Value::Object(o) => {
        if !o.closed || o.null_proto {
          return None;
        }
        let mut props = payload_engine::js::Obj::new();
        for (k, v) in &o.props {
          props.insert(k.to_string(), v.to_js_val()?);
        }
        JsVal::obj(props)
      }
      _ => return None,
    })
  }
}

fn from_js_val(v: &JsVal, shared: &mut HashMap<usize, Value>, depth: u32, is_opaque: &dyn Fn(&JsVal) -> bool) -> Value {
  if depth > MAX_DEPTH || v.typed().is_some() || v.bson().is_some() || v.as_host_object().is_some() || is_opaque(v) {
    return Value::Opaque(OpaqueKind::Object);
  }
  if let Some(id) = v.identity()
    && let Some(done) = shared.get(&id)
  {
    return done.clone();
  }
  let out = match v {
    JsVal::Undefined => Value::Undefined,
    JsVal::Null => Value::Null,
    JsVal::Bool(b) => Value::Bool(*b),
    JsVal::Num(n) => Value::Number(*n),
    JsVal::Str(s) => Value::String(s.clone()),
    JsVal::Arr(items) => Value::Array(Arc::new(items.iter().map(|i| from_js_val(i, shared, depth + 1, is_opaque)).collect())),
    JsVal::Obj(props) => {
      let mut o = Object::closed();
      for (k, val) in props.iter() {
        o.set(Arc::from(k.as_str()), from_js_val(val, shared, depth + 1, is_opaque));
      }
      Value::Object(Arc::new(o))
    }
    JsVal::Fn(_) => Value::Opaque(OpaqueKind::Function),
  };
  if let Some(id) = v.identity() {
    shared.insert(id, out.clone());
  }
  out
}

/// Decodes a JS snapshot sent as JSON text (`packages/engine-rs/src/compile/snapshot.ts`
/// `typedSnapshot`): `null`, booleans, strings and numbers other than `-0` are themselves; every
/// other value is a `[tag, payload]` pair: `["u"]` undefined, `["n", "NaN" | "Infinity" |
/// "-Infinity" | "-0"]`, `["a", [items]]`, `["o" | "z" | "p", [[key, value], ...]]` (closed, closed
/// with a `null` prototype, partial object), `["h", [[name, value], ...]]` (headers), `["x",
/// "object" | "function" | "primitive"]` (opaque). `None`: not such an encoding.
pub fn from_typed(v: &JsVal) -> Option<Value> {
  from_typed_at(v, 0)
}

fn from_typed_at(v: &JsVal, depth: u32) -> Option<Value> {
  if depth > MAX_DEPTH {
    return None;
  }
  let items = match v {
    JsVal::Null => return Some(Value::Null),
    JsVal::Bool(b) => return Some(Value::Bool(*b)),
    JsVal::Num(n) => return Some(Value::Number(*n)),
    JsVal::Str(s) => return Some(Value::String(s.clone())),
    JsVal::Arr(items) => items,
    _ => return None,
  };
  let payload = items.get(1);
  Some(match (items.first()?.as_str()?, items.len()) {
    ("u", 1) => Value::Undefined,
    ("n", 2) => Value::Number(match payload?.as_str()? {
      "NaN" => f64::NAN,
      "Infinity" => f64::INFINITY,
      "-Infinity" => f64::NEG_INFINITY,
      "-0" => -0.0,
      _ => return None,
    }),
    ("a", 2) => Value::Array(Arc::new(payload?.as_arr()?.iter().map(|item| from_typed_at(item, depth + 1)).collect::<Option<_>>()?)),
    (tag @ ("o" | "z" | "p"), 2) => {
      let mut o = Object { closed: tag != "p", null_proto: tag == "z", ..Object::default() };
      for (k, value) in typed_entries(payload)? {
        o.set(k, from_typed_at(value, depth + 1)?);
      }
      Value::Object(Arc::new(o))
    }
    ("h", 2) => {
      let entries = typed_entries(payload)?
        .into_iter()
        .map(|(k, value)| Some((k, value.as_str().map(Arc::from)?)))
        .collect::<Option<Vec<_>>>()?;
      Value::Headers(Arc::new(crate::value::HeadersValue { entries }))
    }
    ("x", 2) => Value::Opaque(match payload?.as_str()? {
      "object" => OpaqueKind::Object,
      "function" => OpaqueKind::Function,
      "primitive" => OpaqueKind::Primitive,
      _ => return None,
    }),
    _ => return None,
  })
}

/// `[[key, value], ...]` of a typed snapshot.
fn typed_entries(payload: Option<&JsVal>) -> Option<Vec<(Arc<str>, &JsVal)>> {
  payload?
    .as_arr()?
    .iter()
    .map(|pair| match pair.as_arr()? {
      [JsVal::Str(k), value] => Some((k.clone(), value)),
      _ => None,
    })
    .collect()
}

/// What a lane knows about the request (`packages/engine-rs/src/compile/snapshot.ts`
/// `capturedRequest`). Every field is the value JS would read (`Value::Undefined` when absent).
#[derive(Clone, Debug)]
pub struct RequestSnapshot {
  pub user: Value,
  /// `req.headers` ([`headers`]).
  pub headers: Value,
  /// `req.method` (`GET`, ...; `undefined` for Local API requests).
  pub method: Value,
  /// `req.operation` (set by the validate operations).
  pub operation: Value,
  pub locale: Value,
  pub fallback_locale: Value,
  pub context: Value,
  pub query: Value,
  /// `req.payload.config.baseAccess` (sanitized config: constant per Payload instance).
  pub base_access: Value,
  /// `req.payload.config.admin.user`.
  pub admin_user: Value,
}

impl Default for RequestSnapshot {
  fn default() -> Self {
    RequestSnapshot {
      user: Value::Null,
      headers: headers(std::iter::empty::<(&str, &str)>()),
      method: Value::Undefined,
      operation: Value::Undefined,
      locale: Value::Undefined,
      fallback_locale: Value::Undefined,
      context: Value::object(vec![]),
      query: Value::object(vec![]),
      base_access: Value::Undefined,
      admin_user: Value::Undefined,
    }
  }
}

/// `req` as compiled functions see it: a partial object (reading anything not captured bails).
pub fn request(r: &RequestSnapshot) -> Value {
  let config = Value::partial_object(vec![
    ("admin", Value::partial_object(vec![("user", r.admin_user.clone())])),
    ("baseAccess", r.base_access.clone()),
  ]);
  Value::partial_object(vec![
    ("context", r.context.clone()),
    ("fallbackLocale", r.fallback_locale.clone()),
    ("headers", r.headers.clone()),
    ("locale", r.locale.clone()),
    ("method", r.method.clone()),
    ("operation", r.operation.clone()),
    ("payload", Value::partial_object(vec![("config", config)])),
    ("query", r.query.clone()),
    ("user", r.user.clone()),
  ])
}

/// A `Headers` snapshot from raw request header pairs, as the Fetch `Headers` iterator presents
/// them: lower-case names sorted, values of one name combined with `, ` (`set-cookie` kept apart).
pub fn headers<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Value {
  let mut combined: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
  for (k, v) in pairs {
    combined.entry(k.to_ascii_lowercase()).or_default().push(v.trim_matches(|c| c == ' ' || c == '\t').to_string());
  }
  let mut entries = vec![];
  for (k, values) in combined {
    if k == "set-cookie" {
      for v in values {
        entries.push((Arc::from(k.as_str()), Arc::from(v.as_str())));
      }
    } else {
      entries.push((Arc::from(k.as_str()), Arc::from(values.join(", ").as_str())));
    }
  }
  Value::Headers(Arc::new(crate::value::HeadersValue { entries }))
}

/// The no-op `skipCompilation` Payload passes (a function the IR does not look into).
pub fn skip_compilation() -> Value {
  Value::Opaque(OpaqueKind::Function)
}

/// `executeAccess`'s args of a collection / global access function:
/// `{ id, slug, data, isReadingStaticFile, req, skipCompilation }`.
pub fn collection_access_args(id: Value, slug: &str, data: Value, req: Value) -> Value {
  Value::object(vec![
    ("id", id),
    ("slug", Value::str(slug)),
    ("data", data),
    ("isReadingStaticFile", Value::Bool(false)),
    ("req", req),
    ("skipCompilation", skip_compilation()),
  ])
}

/// The args of a field `access.read` in afterRead (collection fields):
/// `{ id, blockData, collection, data, doc, req, siblingData, skipCompilation }`. `collection` is
/// the collection config: pass a partial object of what the lane knows (e.g. `{ slug }`), or
/// `Value::Opaque(OpaqueKind::Object)`.
pub fn field_read_access_args(
  id: Value,
  block_data: Value,
  collection: Value,
  doc: Value,
  req: Value,
  sibling_data: Value,
) -> Value {
  Value::object(vec![
    ("id", id),
    ("blockData", block_data),
    ("collection", collection),
    ("data", doc.clone()),
    ("doc", doc),
    ("req", req),
    ("siblingData", sibling_data),
    ("skipCompilation", skip_compilation()),
  ])
}
