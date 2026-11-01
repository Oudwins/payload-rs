//! Port of `packages/drizzle/src/transform/write/types.ts`.
//!
//! Plain records (`relationships`, `texts`, `selects`, `*ToDelete`, ...) are
//! kept as ordered JS objects ([`Obj`]) so key presence (`locale: undefined`
//! vs. no `locale` key) and key order match the TS objects exactly.

use indexmap::{IndexMap, IndexSet};
use payload_engine::js::{JsVal, Obj};
use serde_json::{Map, Value as Json, json};

/// A drizzle `SQL` value produced by the transform instead of plain data.
#[derive(Clone, Debug, PartialEq)]
pub enum SqlExpr {
  /// `sql.raw(text)`, e.g. `"count + 1"` for `{ $inc: 1 }`.
  Raw(String),
  /// `` sql`ST_GeomFromGeoJSON(${geoJSON})` `` (non-sqlite point fields).
  GeomFromGeoJson(String),
}

/// A value in `row` / `locales[locale]`.
#[derive(Clone, Debug)]
pub enum RowValue {
  Value(JsVal),
  Sql(SqlExpr),
}

pub type Row = IndexMap<String, RowValue>;

/// `ArrayRowToInsert` and `BlockRowToInsert` (identical shapes).
#[derive(Clone, Debug, Default)]
pub struct NestedRowToInsert {
  pub arrays: IndexMap<String, Vec<NestedRowToInsert>>,
  pub arrays_to_push: IndexMap<String, Vec<NestedRowToInsert>>,
  pub locales: IndexMap<String, Row>,
  pub row: Row,
}

pub type ArrayRowToInsert = NestedRowToInsert;
pub type BlockRowToInsert = NestedRowToInsert;

/// `RowToInsert`
#[derive(Clone, Debug, Default)]
pub struct RowToInsert {
  pub arrays: IndexMap<String, Vec<ArrayRowToInsert>>,
  pub arrays_to_push: IndexMap<String, Vec<ArrayRowToInsert>>,
  pub blocks: IndexMap<String, Vec<BlockRowToInsert>>,
  pub blocks_to_delete: IndexSet<String>,
  pub locales: IndexMap<String, Row>,
  pub numbers: Vec<Obj>,
  /// `NumberToDelete`: `{ locale?, path }`
  pub numbers_to_delete: Vec<Obj>,
  pub relationships: Vec<Obj>,
  /// `RelationshipToAppend`: `{ locale?, path, value, relationTo? }`
  pub relationships_to_append: Vec<Obj>,
  /// `RelationshipToDelete`: `{ itemToRemove?, locale?, path, relationTo? }`
  pub relationships_to_delete: Vec<Obj>,
  pub row: Row,
  pub selects: IndexMap<String, Vec<Obj>>,
  pub texts: Vec<Obj>,
  /// `TextToDelete`: `{ locale?, path }`
  pub texts_to_delete: Vec<Obj>,
}

/// Encodes a JS value in the engine JSON format of `serializeForEngine` / `deserializeFromEngine`
/// (`payload_engine::js::encode_value`: `{"$undefined":true}`, `{"$num":"NaN"}`, `{"$date":...}`,
/// `{"$bigint":"1"}`, `{"$obj":{...}}` escapes). Plain objects whose only key is `$sql` are
/// escaped too, so they never read as the `{"$sql": [...]}` of an [`SqlExpr`].
pub fn encode_value(v: &JsVal) -> Json {
  escape_sql_key(payload_engine::js::encode_value(v))
}

/// Wraps every plain object `{"$sql": ...}` of an engine-encoded tree in `{"$obj": ...}`.
fn escape_sql_key(json: Json) -> Json {
  match json {
    Json::Array(items) => Json::Array(items.into_iter().map(escape_sql_key).collect()),
    Json::Object(o) => {
      let marker = (o.len() == 1).then(|| o.keys().next().cloned()).flatten();
      match marker.as_deref() {
        // the escaped object's own entries are user values
        Some("$obj") => {
          let inner = o.into_iter().next().map(|(_, v)| v).unwrap_or(Json::Null);
          let inner = match inner {
            Json::Object(entries) => Json::Object(entries.into_iter().map(|(k, v)| (k, escape_sql_key(v))).collect()),
            other => other,
          };
          json!({ "$obj": inner })
        }
        Some("$undefined" | "$num" | "$date" | "$bigint" | "$fn" | "$ref") => Json::Object(o),
        _ => {
          let out: Map<String, Json> = o.into_iter().map(|(k, v)| (k, escape_sql_key(v))).collect();
          if out.len() == 1 && out.contains_key("$sql") { json!({ "$obj": out }) } else { Json::Object(out) }
        }
      }
    }
    other => other,
  }
}

impl SqlExpr {
  /// `{"$sql": [chunks]}`: string chunks as `{"str": ...}`, params as values.
  pub fn encode(&self) -> Json {
    match self {
      SqlExpr::Raw(s) => json!({ "$sql": [{ "str": s }] }),
      SqlExpr::GeomFromGeoJson(p) => json!({ "$sql": [{ "str": "ST_GeomFromGeoJSON(" }, p, { "str": ")" }] }),
    }
  }
}

impl RowValue {
  pub fn encode(&self) -> Json {
    match self {
      RowValue::Value(v) => encode_value(v),
      RowValue::Sql(s) => s.encode(),
    }
  }

  pub fn as_value(&self) -> Option<&JsVal> {
    match self {
      RowValue::Value(v) => Some(v),
      RowValue::Sql(_) => None,
    }
  }
}

pub fn encode_row(row: &Row) -> Json {
  Json::Object(row.iter().map(|(k, v)| (k.clone(), v.encode())).collect())
}

fn encode_locales(locales: &IndexMap<String, Row>) -> Json {
  Json::Object(locales.iter().map(|(k, v)| (k.clone(), encode_row(v))).collect())
}

fn encode_objs(rows: &[Obj]) -> Json {
  Json::Array(rows.iter().map(|o| encode_value(&JsVal::obj(o.clone()))).collect())
}

fn encode_nested_map(map: &IndexMap<String, Vec<NestedRowToInsert>>) -> Json {
  Json::Object(map.iter().map(|(k, rows)| (k.clone(), Json::Array(rows.iter().map(|r| r.encode()).collect()))).collect())
}

impl NestedRowToInsert {
  /// Engine JSON with the TS keys (`arrays`, `arraysToPush`, `locales`, `row`).
  pub fn encode(&self) -> Json {
    json!({
      "arrays": encode_nested_map(&self.arrays),
      "arraysToPush": encode_nested_map(&self.arrays_to_push),
      "locales": encode_locales(&self.locales),
      "row": encode_row(&self.row),
    })
  }
}

fn map_row(row: &mut Row, f: &mut dyn FnMut(&JsVal) -> JsVal) {
  for value in row.values_mut() {
    if let RowValue::Value(v) = value {
      *v = f(v);
    }
  }
}

fn map_objs(rows: &mut [Obj], f: &mut dyn FnMut(&JsVal) -> JsVal) {
  for row in rows {
    for value in row.values_mut() {
      *value = f(value);
    }
  }
}

fn map_nested(map: &mut IndexMap<String, Vec<NestedRowToInsert>>, f: &mut dyn FnMut(&JsVal) -> JsVal) {
  for rows in map.values_mut() {
    for row in rows {
      row.map_values(f);
    }
  }
}

impl NestedRowToInsert {
  /// Replaces every plain value of the row (and of nested rows).
  pub(crate) fn map_values(&mut self, f: &mut dyn FnMut(&JsVal) -> JsVal) {
    map_nested(&mut self.arrays, f);
    map_nested(&mut self.arrays_to_push, f);
    for row in self.locales.values_mut() {
      map_row(row, f);
    }
    map_row(&mut self.row, f);
  }
}

impl RowToInsert {
  /// Replaces every plain value of the rows and records.
  pub(crate) fn map_values(&mut self, f: &mut dyn FnMut(&JsVal) -> JsVal) {
    map_nested(&mut self.arrays, f);
    map_nested(&mut self.arrays_to_push, f);
    map_nested(&mut self.blocks, f);
    for row in self.locales.values_mut() {
      map_row(row, f);
    }
    map_objs(&mut self.numbers, f);
    map_objs(&mut self.numbers_to_delete, f);
    map_objs(&mut self.relationships, f);
    map_objs(&mut self.relationships_to_append, f);
    map_objs(&mut self.relationships_to_delete, f);
    map_row(&mut self.row, f);
    for rows in self.selects.values_mut() {
      map_objs(rows, f);
    }
    map_objs(&mut self.texts, f);
    map_objs(&mut self.texts_to_delete, f);
  }

  /// Engine JSON with the same keys and key order as the TS `RowToInsert`
  /// (`blocksToDelete` as an array, SQL values as `{"$sql": [...]}`).
  pub fn encode(&self) -> Json {
    json!({
      "arrays": encode_nested_map(&self.arrays),
      "arraysToPush": encode_nested_map(&self.arrays_to_push),
      "blocks": encode_nested_map(&self.blocks),
      "blocksToDelete": self.blocks_to_delete.iter().collect::<Vec<_>>(),
      "locales": encode_locales(&self.locales),
      "numbers": encode_objs(&self.numbers),
      "numbersToDelete": encode_objs(&self.numbers_to_delete),
      "relationships": encode_objs(&self.relationships),
      "relationshipsToAppend": encode_objs(&self.relationships_to_append),
      "relationshipsToDelete": encode_objs(&self.relationships_to_delete),
      "row": encode_row(&self.row),
      "selects": Json::Object(self.selects.iter().map(|(k, v)| (k.clone(), encode_objs(v))).collect()),
      "texts": encode_objs(&self.texts),
      "textsToDelete": encode_objs(&self.texts_to_delete),
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// User objects shaped like engine markers stay plain objects (`deserializeFromEngine` would
  /// otherwise turn `{"$bigint":"0"}` into `0n`); typed values use their markers.
  #[test]
  fn reserved_keys_are_escaped() {
    let obj1 = |k: &str, v: JsVal| JsVal::obj(Obj::from([(k.to_string(), v)]));
    for key in ["$bigint", "$date", "$fn", "$num", "$obj", "$ref", "$undefined", "$sql"] {
      let user = obj1(key, JsVal::str("0"));
      assert_eq!(encode_value(&user), json!({ "$obj": { key: "0" } }), "{key}");
      assert_eq!(encode_value(&obj1("nested", user.clone())), json!({ "nested": { "$obj": { key: "0" } } }), "{key}");
    }
    assert_eq!(encode_value(&obj1("$obj", obj1("$sql", JsVal::Num(1.0)))), json!({ "$obj": { "$obj": { "$obj": { "$sql": 1 } } } }));
    assert_eq!(encode_value(&JsVal::date(0.0)), json!({ "$date": "1970-01-01T00:00:00.000Z" }));
    assert_eq!(encode_value(&JsVal::date(f64::NAN)), json!({ "$date": null }));
    assert_eq!(encode_value(&JsVal::bigint("12")), json!({ "$bigint": "12" }));
    assert_eq!(encode_value(&JsVal::Num(f64::NAN)), json!({ "$num": "NaN" }));
    assert_eq!(encode_value(&JsVal::Undefined), json!({ "$undefined": true }));
  }
}
