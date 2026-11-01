//! Production-path replay: for each fixture in test/__rs/read/fixtures/schema-linked
//! (captured with `RS_READ_SCHEMA_LINKED=1`, see capture/recorder.ts) the config,
//! `payload.collections`, `payload.blocks` and every `fields` array passed to
//! `transform` are ONE decoded graph. The test builds the `RawSchema` from that
//! graph with `payload_engine::sql::schema::build_raw_schema` and replays the
//! calls with `table_name_map` and `schema_block_index(&schema.block_table_name_index)`
//! taken from it (object-identity lookups, exactly as the adapter will do), in
//! several process time zones.
//!
//! It also checks the Rust schema against the TS adapter: the same `tableNameMap`
//! and the same `block[InternalBlockTableNameIndex]` on the same block objects.

mod common;

use std::cell::Cell;
use std::collections::HashMap;

use common::{Overlays, at, compare, fixtures_dir, graph, index, items, json_files, load, string, tree, use_time_zone, zones};
use indexmap::IndexMap;
use payload_engine::host::NoHost;
use payload_engine::js::JsVal;
use payload_engine::sql::schema::{SchemaInput, SchemaOptions, build_raw_schema, find_identity_paths, resolve_path};
use payload_sql_read::encoding::{decode, to_serde};
use payload_sql_read::{ReadAdapter, TransformArgs, schema_block_index, transform};

#[test]
fn replay_schema_linked_fixtures() {
  let dir = fixtures_dir().join("schema-linked");
  let files = json_files(&dir);
  assert!(!files.is_empty(), "no schema-linked fixtures in {}", dir.display());
  let zones = zones();
  let overlays = Overlays::load();
  let (mut total, mut passed, mut nonzero_index_lookups, mut recorded_nonzero) = (0usize, 0usize, 0usize, 0usize);
  let mut failures = Vec::new();

  for file in &files {
    let stem = file.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let name = format!("schema-linked/{stem}");
    let fixture = load(file);
    let capture_zone = string(&at(&fixture, "timeZone"));

    struct Linked {
      root: JsVal,
      table_name_map: IndexMap<String, String>,
      block_index: HashMap<usize, u32>,
      blocks_as_json: bool,
    }
    let contexts: Vec<Linked> = items(&at(&fixture, "contexts"))
      .iter()
      .map(|c| {
        let root = graph(&at(c, "graph"));
        let options = SchemaOptions::from_json(&to_serde(&at(c, "schemaOptions")).expect("schemaOptions"));
        let blocks_as_json = options.blocks_as_json;
        let schema = build_raw_schema(
          &NoHost,
          SchemaInput {
            config: root.get("config"),
            collections: root.get("collections"),
            blocks: root.get("blocks"),
            block_table_name_index: HashMap::new(),
          },
          options,
        )
        .unwrap_or_else(|e| panic!("{name}: build_raw_schema failed: {e}"));

        // tableNameMap: identical to the TS adapter's.
        let ts_map: IndexMap<String, String> = at(c, "tableNameMap")
          .as_obj()
          .map(|m| m.borrow().entries().into_iter().map(|(k, v)| (k.to_string(), string(&v))).collect())
          .unwrap_or_default();
        let mut rs_sorted: Vec<_> = schema.table_name_map.iter().collect();
        let mut ts_sorted: Vec<_> = ts_map.iter().collect();
        rs_sorted.sort();
        ts_sorted.sort();
        assert_eq!(rs_sorted, ts_sorted, "{name}: Rust tableNameMap differs from the TS adapter's");

        // block[InternalBlockTableNameIndex]: same objects, same values.
        let recorded = items(&at(c, "blockIndexes"));
        for entry in &recorded {
          let pair = items(entry);
          let path: Vec<String> = items(&pair[0]).iter().map(string).collect();
          let expected = index(&pair[1]) as u32;
          let block = resolve_path(&root, &path).unwrap_or_else(|| panic!("{name}: no object at {path:?}"));
          let actual = block.identity().and_then(|id| schema.block_table_name_index.get(&id)).copied();
          assert_eq!(actual, Some(expected), "{name}: block index at {}", path.join("."));
          recorded_nonzero += usize::from(expected != 0);
        }
        let reachable_nonzero = find_identity_paths(&root, &schema.block_table_name_index)
          .into_iter()
          .filter(|(_, index)| *index != 0)
          .count();
        let recorded_nonzero_here = recorded.iter().filter(|e| index(&items(e)[1]) != 0).count();
        assert_eq!(reachable_nonzero, recorded_nonzero_here, "{name}: Rust sets block indexes TS did not");

        Linked { root, table_name_map: schema.table_name_map, block_index: schema.block_table_name_index, blocks_as_json }
      })
      .collect();
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
        let lookups = Cell::new(0usize);
        let production_lookup = schema_block_index(&ctx.block_index);
        let counting_lookup = |block: &JsVal| {
          let found = production_lookup(block);
          if found.is_some_and(|n| n != 0.0) {
            lookups.set(lookups.get() + 1);
          }
          found
        };
        let adapter = ReadAdapter {
          config: ctx.root.get("config"),
          blocks: ctx.root.get("blocks"),
          collections: ctx.root.get("collections"),
          table_name_map: &ctx.table_name_map,
          blocks_as_json: ctx.blocks_as_json,
          block_table_name_index: &counting_lookup,
        };
        let fields = ctx.root.get("fields").as_arr().expect("graph.fields")[index(&at(call, "fields"))].clone();
        let join_query = tree(&at(call, "joinQuery"));
        let table_name = string(&at(call, "tableName"));
        let result = transform(
          &adapter,
          TransformArgs {
            data: decode(&at(call, "data")),
            fields: &fields,
            join_query: &join_query,
            parent_is_localized: tree(&at(call, "parentIsLocalized")).truthy(),
            table_name: &table_name,
          },
        );
        nonzero_index_lookups += lookups.get();
        match compare(&expected, result) {
          None => file_passed += 1,
          Some(f) => failures.push(format!("{name}#{i} [{zone}] ({table_name}): {f}")),
        }
      }
      println!("{name} [{zone}]: {file_passed}/{file_total}");
      total += file_total;
      passed += file_passed;
    }
  }

  println!(
    "TOTAL: {passed}/{total} schema-linked calls match ({} zones); {recorded_nonzero} non-zero block indexes \
     matched TS; {nonzero_index_lookups} non-zero schema_block_index lookups",
    zones.len()
  );
  for f in failures.iter().take(30) {
    println!("MISMATCH {f}");
  }
  assert!(failures.is_empty(), "{} of {total} schema-linked calls differ", failures.len());
  if recorded_nonzero > 0 {
    assert!(nonzero_index_lookups > 0, "no call resolved a block table name through a non-zero schema index");
  }
}
