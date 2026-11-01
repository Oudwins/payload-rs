//! Replays the golden fixtures captured from the TS `transform` (see
//! test/__rs/read/capture/recorder.ts for the format) through the Rust port in
//! several process time zones and asserts the outputs are identical
//! (order-sensitive deep equality on the encoded values, error class names for
//! calls that throw). Expectations per zone: see tests/common/mod.rs.
//!
//! Fixtures here carry pruned config graphs and read the block table index from
//! `__rsBlockTableNameIndex`; tests/schema_linked.rs covers the production
//! `schema_block_index` path.

mod common;

use common::{Overlays, at, compare, fixtures_dir, graph, index, items, json_files, load, string, tree, use_time_zone, zones};
use indexmap::IndexMap;
use payload_engine::js::JsVal;
use payload_sql_read::encoding::{decode, to_serde};
use payload_sql_read::{ReadAdapter, TransformArgs, transform};

struct Context {
  config: JsVal,
  blocks: JsVal,
  collections: JsVal,
  table_name_map: IndexMap<String, String>,
  blocks_as_json: bool,
}

fn block_index(block: &JsVal) -> Option<f64> {
  block.get("__rsBlockTableNameIndex").as_num()
}

#[test]
fn replay_fixtures() {
  let dir = fixtures_dir();
  let files = json_files(&dir);
  assert!(!files.is_empty(), "no fixtures in {}", dir.display());
  let zones = zones();
  let overlays = Overlays::load();

  let only = std::env::var("RS_READ_ONLY").ok();
  let (mut total, mut passed) = (0usize, 0usize);
  let mut per_zone: IndexMap<String, (usize, usize)> = IndexMap::new();
  let mut failures: Vec<String> = Vec::new();

  for file in &files {
    let name = file.file_stem().unwrap_or_default().to_string_lossy().to_string();
    if only.as_ref().is_some_and(|o| !o.split(',').any(|n| n == name)) {
      continue;
    }
    let fixture = load(file);
    let capture_zone = string(&at(&fixture, "timeZone"));
    assert!(!capture_zone.is_empty(), "{name}: fixture has no timeZone (re-capture or run capture/prune.mjs --stamp-time-zone)");
    let contexts: Vec<Context> = items(&at(&fixture, "contexts"))
      .iter()
      .map(|c| Context {
        config: graph(&at(c, "config")),
        blocks: graph(&at(c, "blocks")),
        collections: JsVal::from_json(&to_serde(&at(c, "collections")).expect("collections")),
        table_name_map: at(c, "tableNameMap")
          .as_obj()
          .map(|m| m.borrow().entries().into_iter().map(|(k, v)| (k.to_string(), string(&v))).collect())
          .unwrap_or_default(),
        blocks_as_json: matches!(at(c, "blocksAsJSON"), payload_sql_read::Val::Bool(true)),
      })
      .collect();
    let fields: Vec<JsVal> = items(&at(&fixture, "fields")).iter().map(graph).collect();
    let calls = items(&at(&fixture, "calls"));

    for zone in &zones {
      use_time_zone(zone);
      let (mut file_total, mut file_passed) = (0usize, 0usize);
      for (i, call) in calls.iter().enumerate() {
        file_total += 1;
        let expected = match overlays.expected(&name, &capture_zone, zone, calls.len(), i, call) {
          Ok(expected) => expected,
          Err(message) => {
            failures.push(format!("{name} [{zone}]: {message}"));
            break;
          }
        };
        let ctx = &contexts[index(&at(call, "context"))];
        let adapter = ReadAdapter {
          config: &ctx.config,
          blocks: &ctx.blocks,
          collections: &ctx.collections,
          table_name_map: &ctx.table_name_map,
          blocks_as_json: ctx.blocks_as_json,
          block_table_name_index: &block_index,
        };
        let join_query = tree(&at(call, "joinQuery"));
        let table_name = string(&at(call, "tableName"));
        let result = transform(
          &adapter,
          TransformArgs {
            data: decode(&at(call, "data")),
            fields: &fields[index(&at(call, "fields"))],
            join_query: &join_query,
            parent_is_localized: tree(&at(call, "parentIsLocalized")).truthy(),
            table_name: &table_name,
          },
        );
        match compare(&expected, result) {
          None => file_passed += 1,
          Some(f) => failures.push(format!("{name}#{i} [{zone}] ({table_name}): {f}")),
        }
      }
      println!("{name} [{zone}]: {file_passed}/{file_total}");
      let entry = per_zone.entry(zone.clone()).or_default();
      entry.0 += file_passed;
      entry.1 += file_total;
      total += file_total;
      passed += file_passed;
    }
  }

  for (zone, (ok, all)) in &per_zone {
    println!("ZONE {zone}: {ok}/{all}");
  }
  println!("TOTAL: {passed}/{total} fixture calls match ({} zones)", zones.len());
  for f in failures.iter().take(30) {
    println!("MISMATCH {f}");
  }
  assert!(failures.is_empty(), "{} of {total} fixture calls differ", failures.len());
}
