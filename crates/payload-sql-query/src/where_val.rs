//! The `where` input of the query builder.
//!
//! In TS, engine-internal values inside a `where` are unforgeable: `rawConstraint(...)` is tagged
//! with a private `Symbol`, `sql.raw(...)` is a drizzle class instance and `DistinctSymbol` is a
//! `Symbol`. User input (JSON, `qs` query strings) can never produce them. [`WhereVal`] keeps that
//! guarantee in Rust: user data is always [`WhereVal::Js`], and the internal values are separate
//! enum variants that only engine code can construct. No `JsVal` shape is ever interpreted as one.

use payload_engine::error::Result;
use payload_engine::js::{JsVal, Obj};

use crate::adapter::type_error;
use crate::sql::Sql;

#[derive(Clone, Debug)]
pub enum WhereVal {
  /// Plain JS data (user input). Never contains an internal value.
  Js(JsVal),
  /// A plain object built by engine code around internal values, e.g. the join traversal's
  /// `{ [on]: { equals: rawConstraint(...) } }`.
  Obj(Vec<(String, WhereVal)>),
  /// An array built by engine code, e.g. findDistinct's `{ and: [where, ...] }`.
  Arr(Vec<WhereVal>),
  /// `rawConstraint(sql.raw(...))`: the comparison's right-hand side is this SQL.
  RawConstraint(Sql),
  /// drizzle's `DistinctSymbol` (findDistinct).
  Distinct,
}

impl Default for WhereVal {
  fn default() -> Self {
    WhereVal::Js(JsVal::Undefined)
  }
}

impl From<JsVal> for WhereVal {
  fn from(v: JsVal) -> Self {
    WhereVal::Js(v)
  }
}

/// `true` for a canonical array index key (`"0"`, `"17"`, not `"01"`), which JS orders first.
fn is_array_index(key: &str) -> bool {
  !key.is_empty()
    && key.bytes().all(|b| b.is_ascii_digit())
    && (key == "0" || !key.starts_with('0'))
    && key.parse::<u64>().is_ok_and(|n| n < u32::MAX as u64)
}

/// Own enumerable keys in JS order: array indices ascending, then the rest in insertion order.
pub fn js_ordered<T>(entries: impl Iterator<Item = (String, T)>) -> Vec<(String, T)> {
  let (mut indices, rest): (Vec<_>, Vec<_>) = entries.partition(|(k, _)| is_array_index(k));
  indices.sort_by_key(|(k, _)| k.parse::<u64>().unwrap_or(u64::MAX));
  indices.extend(rest);
  indices
}

/// `Object.entries(value)` for any JS value (`TypeError` for `null` / `undefined`).
pub fn js_entries(v: &JsVal) -> Result<Vec<(String, JsVal)>> {
  match v {
    JsVal::Obj(o) => Ok(js_ordered(o.iter().map(|(k, v)| (k.clone(), v.clone())))),
    JsVal::Arr(a) => Ok(a.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect()),
    JsVal::Null | JsVal::Undefined => Err(type_error("Cannot convert undefined or null to object")),
    JsVal::Str(s) => Ok(s.encode_utf16().enumerate().map(|(i, c)| (i.to_string(), JsVal::str(String::from_utf16_lossy(&[c])))).collect()),
    _ => Ok(Vec::new()),
  }
}

impl WhereVal {
  /// `rawConstraint(sql.raw(text))`
  pub fn raw_constraint(text: impl Into<String>) -> Self {
    WhereVal::RawConstraint(Sql::raw(text))
  }

  /// A plain object built from `(key, value)` pairs.
  pub fn obj(entries: Vec<(impl Into<String>, WhereVal)>) -> Self {
    WhereVal::Obj(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())
  }

  pub fn as_js(&self) -> Option<&JsVal> {
    match self {
      WhereVal::Js(v) => Some(v),
      _ => None,
    }
  }

  /// `typeof value === 'object'` (`null` included; the raw constraint is a plain object).
  pub fn is_typeof_object(&self) -> bool {
    match self {
      WhereVal::Js(v) => matches!(v, JsVal::Null | JsVal::Obj(_) | JsVal::Arr(_)),
      WhereVal::Obj(_) | WhereVal::Arr(_) | WhereVal::RawConstraint(_) => true,
      WhereVal::Distinct => false,
    }
  }

  /// `value && Object.keys(value).length > 0` as `buildQuery` checks its `where`.
  pub fn has_keys(&self) -> bool {
    match self {
      WhereVal::Js(v) => match v {
        JsVal::Obj(o) => !o.is_empty(),
        JsVal::Arr(a) => !a.is_empty(),
        JsVal::Str(s) => !s.is_empty(),
        _ => false,
      },
      WhereVal::Obj(e) => !e.is_empty(),
      WhereVal::Arr(a) => !a.is_empty(),
      // `{ type, value }`
      WhereVal::RawConstraint(_) => true,
      WhereVal::Distinct => false,
    }
  }

  /// `Array.isArray(value)`: the items.
  pub fn as_items(&self) -> Option<Vec<WhereVal>> {
    match self {
      WhereVal::Js(JsVal::Arr(a)) => Some(a.iter().cloned().map(WhereVal::Js).collect()),
      WhereVal::Arr(a) => Some(a.clone()),
      _ => None,
    }
  }

  /// `Object.entries(value)`.
  ///
  /// A raw constraint's own keys are `type` (a `Symbol`) and `value` (a drizzle `SQL`
  /// instance); as a `where` or path-operator object neither yields a constraint
  /// (`Symbol` is not an object, `SQL` has no operator keys), so they are omitted here.
  pub fn entries(&self) -> Result<Vec<(String, WhereVal)>> {
    match self {
      WhereVal::Js(v) => Ok(js_entries(v)?.into_iter().map(|(k, v)| (k, WhereVal::Js(v))).collect()),
      WhereVal::Obj(e) => Ok(js_ordered(e.iter().cloned())),
      WhereVal::Arr(a) => Ok(a.iter().cloned().enumerate().map(|(i, v)| (i.to_string(), v)).collect()),
      WhereVal::RawConstraint(_) | WhereVal::Distinct => Ok(Vec::new()),
    }
  }

  /// `value[key]` for the plain-object variants.
  pub fn get(&self, key: &str) -> WhereVal {
    match self {
      WhereVal::Js(v) => WhereVal::Js(v.get(key).clone()),
      WhereVal::Obj(e) => e.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.clone()).unwrap_or_default(),
      _ => WhereVal::default(),
    }
  }

  /// `isNestedRelationshipQuery(value)`: a plain object (raw constraints included).
  pub fn is_plain_object(&self) -> bool {
    match self {
      WhereVal::Js(v) => v.as_obj().is_some(),
      WhereVal::Obj(_) | WhereVal::RawConstraint(_) => true,
      WhereVal::Arr(_) | WhereVal::Distinct => false,
    }
  }

  pub fn is_raw_constraint(&self) -> bool {
    matches!(self, WhereVal::RawConstraint(_))
  }

  pub fn is_distinct(&self) -> bool {
    matches!(self, WhereVal::Distinct)
  }

  /// The value as plain JS data for code that only inspects its shape (`typeof`,
  /// `Array.isArray`, `String(value)`, `relationTo` lookups).
  ///
  /// Internal values become a fresh empty object, which answers every such check like the TS
  /// value does (truthy, not an array, no `relationTo`, `String()` is `[object Object]`). The
  /// view is never interpreted as SQL: raw constraints are only ever read from the typed variant.
  pub fn view(&self) -> JsVal {
    match self {
      WhereVal::Js(v) => v.clone(),
      WhereVal::Obj(e) => JsVal::obj(e.iter().map(|(k, v)| (k.clone(), v.view())).collect::<Obj>()),
      WhereVal::Arr(a) => JsVal::arr(a.iter().map(WhereVal::view).collect()),
      WhereVal::RawConstraint(_) | WhereVal::Distinct => JsVal::obj(Obj::new()),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn js_key_order() {
    let keys: Vec<String> =
      js_ordered(["b", "10", "a", "2", "01", "4294967295", "0"].iter().map(|k| (k.to_string(), ()))).into_iter().map(|(k, _)| k).collect();
    assert_eq!(keys, ["0", "2", "10", "b", "a", "01", "4294967295"]);
  }
}
