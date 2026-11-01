//! The `rawSchema()` output: the same JSON as napi `buildRawSchema` (crates/payload-node/src/schema.rs),
//! computed for the schema an engine retains.

use std::collections::HashMap;

use payload_engine::js::{JsVal, encode_value};
use payload_engine::sql::schema::{RawSchema, find_identity_paths};
use serde_json::{Value as Json, json};

pub fn raw_schema_output(root: &JsVal, schema: &RawSchema) -> Json {
  let mut out = schema.to_json();
  let block_indexes: Vec<Json> = find_identity_paths(root, &schema.block_table_name_index)
    .into_iter()
    .map(|(path, index)| json!([path, index]))
    .collect();
  if let Some(o) = out.as_object_mut() {
    // `Map` entries as pairs: a JSON object would reorder integer-like keys when parsed in JS.
    let table_name_map = schema.table_name_map.iter().map(|(k, v)| json!([k, v])).collect();
    o.insert("tableNameMap".into(), Json::Array(table_name_map));
    o.insert("blockTableNameIndexes".into(), Json::Array(block_indexes));
    o.insert("rawTableKeys".into(), json!(schema.raw_tables.keys().collect::<Vec<_>>()));
    o.insert("columnDefaults".into(), Json::Array(column_defaults(root, schema)));
  }
  out
}

/// `[table, column, { path } | { value }]` for the column defaults whose JS value the column JSON
/// does not reproduce.
fn column_defaults(root: &JsVal, schema: &RawSchema) -> Vec<Json> {
  let needs_js_value = |v: &JsVal| match v {
    JsVal::Obj(_) | JsVal::Arr(_) => true,
    JsVal::Num(n) => !n.is_finite(),
    _ => false,
  };
  let mut ids: Vec<usize> =
    schema.column_defaults.values().flat_map(|columns| columns.values()).filter_map(JsVal::identity).collect();
  ids.sort_unstable();
  ids.dedup();
  let tagged: HashMap<usize, u32> = ids.iter().enumerate().map(|(i, id)| (*id, i as u32)).collect();
  let paths: HashMap<usize, Vec<String>> =
    find_identity_paths(root, &tagged).into_iter().map(|(path, i)| (ids[i as usize], path)).collect();
  let mut out = Vec::new();
  for (table, columns) in &schema.column_defaults {
    for (column, value) in columns {
      if !needs_js_value(value) {
        continue;
      }
      let source = match value.identity().and_then(|id| paths.get(&id)) {
        Some(path) => json!({ "path": path }),
        None => json!({ "value": encode_value(value) }),
      };
      out.push(json!([table, column, source]));
    }
  }
  out
}
