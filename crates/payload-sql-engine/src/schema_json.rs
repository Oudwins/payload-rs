//! The `rawSchema()` output: the same JSON as napi `buildRawSchema` (crates/payload-node/src/schema.rs),
//! computed for the schema an engine retains.

use std::collections::HashMap;

use payload_engine::js::{JsVal, encode_value};
use payload_engine::sql::schema::{RawSchema, find_identity_paths};
use serde_json::{Value as Json, json};

pub fn raw_schema_output(root: &JsVal, schema: &RawSchema) -> Json {
  let mut out = schema.to_json();
  let block_indexes = block_table_name_indexes(root, schema);
  if let Some(o) = out.as_object_mut() {
    // `Map` entries as pairs: a JSON object would reorder integer-like keys when parsed in JS.
    let table_name_map = schema.table_name_map.iter().map(|(k, v)| json!([k, v])).collect();
    o.insert("tableNameMap".into(), Json::Array(table_name_map));
    o.insert("blockTableNameIndexes".into(), Json::Array(block_indexes));
    o.insert("rawTableKeys".into(), json!(schema.raw_tables.keys().collect::<Vec<_>>()));
    o.insert("columnDefaults".into(), Json::Array(column_defaults(root, schema)));
    o.insert("undefinedProperties".into(), Json::Array(undefined_properties(schema)));
  }
  out
}

/// `raw_schema_output(root, schema).to_string()`, written straight from the schema (no JSON copy
/// of its tables).
pub fn raw_schema_text(root: &JsVal, schema: &RawSchema) -> String {
  fn write<T: serde::Serialize + ?Sized>(out: &mut Vec<u8>, value: &T) {
    serde_json::to_writer(&mut *out, value).expect("JSON values serialize");
  }
  let mut out: Vec<u8> = Vec::with_capacity(64 * 1024);
  out.extend_from_slice(br#"{"rawTables":{"#);
  // keys still holding `undefined` are dropped, like `JSON.stringify`
  for (i, (key, table)) in schema.raw_tables.iter().filter_map(|(k, t)| t.as_ref().map(|t| (k, t))).enumerate() {
    if i > 0 {
      out.push(b',');
    }
    write(&mut out, key);
    out.extend_from_slice(br#":{"name":"#);
    write(&mut out, &table.name);
    out.extend_from_slice(br#","columns":"#);
    write(&mut out, &table.columns);
    out.extend_from_slice(br#","foreignKeys":"#);
    write(&mut out, &table.foreign_keys);
    out.extend_from_slice(br#","indexes":"#);
    write(&mut out, &table.indexes);
    out.push(b'}');
  }
  out.extend_from_slice(br#"},"rawRelations":"#);
  write(&mut out, &schema.raw_relations);
  out.extend_from_slice(br#","tableNameMap":"#);
  // `Map` entries as pairs: a JSON object would reorder integer-like keys when parsed in JS.
  write(&mut out, &schema.table_name_map.iter().collect::<Vec<_>>());
  out.extend_from_slice(br#","indexes":"#);
  write(&mut out, &schema.indexes);
  out.extend_from_slice(br#","foreignKeys":"#);
  write(&mut out, &schema.foreign_keys);
  out.extend_from_slice(br#","fieldConstraints":"#);
  write(&mut out, &schema.field_constraints);
  out.extend_from_slice(br#","blockTableNameIndexes":"#);
  write(&mut out, &block_table_name_indexes(root, schema));
  out.extend_from_slice(br#","rawTableKeys":"#);
  write(&mut out, &schema.raw_tables.keys().collect::<Vec<_>>());
  out.extend_from_slice(br#","columnDefaults":"#);
  write(&mut out, &column_defaults(root, schema));
  out.extend_from_slice(br#","undefinedProperties":"#);
  write(&mut out, &undefined_properties(schema));
  out.push(b'}');
  String::from_utf8(out).expect("serde_json writes UTF-8")
}

fn block_table_name_indexes(root: &JsVal, schema: &RawSchema) -> Vec<Json> {
  find_identity_paths(root, &schema.block_table_name_index)
    .into_iter()
    .map(|(path, index)| json!([path, index]))
    .collect()
}

/// Paths (below `rawTables`) of the own properties holding `undefined` that JSON drops: the
/// `unique` key of the indexes built for fields (`traverseFields.ts`: `unique = disableUnique !==
/// true && field.unique`) and for collection compound indexes (`build.ts`: `unique: disableUnique
/// ? false : index.unique`). Both are stored under their own (deduplicated) name and always end
/// with `unique`; every other index is stored under a fixed key (`_orderIdx`, `parentIdx`, ...)
/// that never equals its generated name, or has a boolean `unique`. So an index whose key is its
/// `name` and that has no `unique` key had `unique: undefined` as its last own key.
fn undefined_properties(schema: &RawSchema) -> Vec<Json> {
  let mut out = Vec::new();
  for (table_key, table) in &schema.raw_tables {
    let Some(table) = table else { continue };
    for (index_key, index) in &table.indexes {
      let Some(index) = index.as_object() else { continue };
      if !index.contains_key("unique") && index.get("name").and_then(Json::as_str) == Some(index_key.as_str()) {
        out.push(json!([table_key, "indexes", index_key, "unique"]));
      }
    }
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
