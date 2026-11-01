//! Port of `packages/drizzle/src/transform/write/types.ts`.
//!
//! Plain records (`relationships`, `texts`, `selects`, `*ToDelete`, ...) are
//! kept as ordered JS objects ([`Obj`]) so key presence (`locale: undefined`
//! vs. no `locale` key) and key order match the TS objects exactly.

use indexmap::{IndexMap, IndexSet};
use payload_engine::js::{JsVal, Obj};
use serde_json::{Map, Value as Json, json};

use crate::js::number_to_string;

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

const RESERVED_KEYS: [&str; 6] = ["$fn", "$num", "$obj", "$ref", "$undefined", "$sql"];

/// Encodes a JS value in the engine JSON format of `serializeForEngine`
/// (`{"$undefined":true}`, `{"$num":"NaN"}`, `{"$obj":{...}}` escapes).
pub fn encode_value(v: &JsVal) -> Json {
  match v {
    JsVal::Undefined => json!({ "$undefined": true }),
    JsVal::Null => Json::Null,
    JsVal::Bool(b) => Json::Bool(*b),
    JsVal::Num(n) => {
      if n.is_finite() {
        // arbitrary_precision keeps the JS formatting of the number.
        serde_json::from_str(&number_to_string(*n)).unwrap_or(Json::Null)
      } else {
        json!({ "$num": number_to_string(*n) })
      }
    }
    JsVal::Str(s) => Json::String(s.to_string()),
    JsVal::Arr(a) => Json::Array(a.iter().map(encode_value).collect()),
    JsVal::Obj(o) => {
      let out: Map<String, Json> = o.iter().map(|(k, v)| (k.clone(), encode_value(v))).collect();
      if out.len() == 1 && RESERVED_KEYS.contains(&out.keys().next().map(String::as_str).unwrap_or("")) {
        json!({ "$obj": out })
      } else {
        Json::Object(out)
      }
    }
    JsVal::Fn(id) => json!({ "$fn": id }),
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

impl RowToInsert {
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
