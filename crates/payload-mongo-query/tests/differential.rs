//! Differential test against the TS `@payloadcms/db-mongodb` query builders.
//!
//! Replays every case recorded by `test/__rs/mongo-query` (generated corpora and captures of
//! upstream int runs, `test/__rs/mongo-query/fixtures/*.json.gz`) through the Rust port: exact typed
//! result / error, host op sequence and argument mutations (see `replay/mod.rs`).
//!
//! `RS_MONGO_QUERY_FIXTURES` overrides the fixture directory, `RS_MONGO_QUERY_SUITE` selects one
//! fixture (file stem), `RS_MONGO_QUERY_VERBOSE=1` prints every failure.

mod replay;

use std::collections::BTreeMap;
use std::path::PathBuf;

#[test]
fn replays_recorded_ts_cases() {
  let dir = std::env::var("RS_MONGO_QUERY_FIXTURES")
    .map(PathBuf::from)
    .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/__rs/mongo-query/fixtures"));
  let only = std::env::var("RS_MONGO_QUERY_SUITE").ok();
  let verbose = std::env::var("RS_MONGO_QUERY_VERBOSE").as_deref() == Ok("1");

  let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
    .map(|d| d.flatten().map(|e| e.path()).collect())
    .unwrap_or_default();
  files.retain(|p| p.to_string_lossy().ends_with(".json.gz") || p.to_string_lossy().ends_with(".json"));
  files.sort();
  if let Some(only) = &only {
    files.retain(|p| p.file_name().is_some_and(|n| n.to_string_lossy().split('.').next() == Some(only.as_str())));
  }
  assert!(!files.is_empty(), "no fixtures in {} (record them with test/__rs/mongo-query/run.sh)", dir.display());

  let mut total = 0usize;
  let mut failed = 0usize;
  let mut by_kind: BTreeMap<String, (usize, usize)> = BTreeMap::new();
  for file in &files {
    let fx = replay::load(file);
    let mut file_failed = 0;
    for case in &fx.cases {
      let outcome = replay::run_case(&fx, case);
      total += 1;
      let entry = by_kind.entry(outcome.kind.clone()).or_default();
      entry.0 += 1;
      if let Some(failure) = &outcome.failure {
        failed += 1;
        file_failed += 1;
        entry.1 += 1;
        if verbose || file_failed <= 5 {
          eprintln!("[{}] case {} ({}): {failure}", fx.suite, outcome.id, outcome.kind);
        }
      }
    }
    eprintln!("{}: {} cases, {} failed", file.display(), fx.cases.len(), file_failed);
  }
  for (kind, (n, f)) in &by_kind {
    eprintln!("  {kind}: {n} cases, {f} failed");
  }
  eprintln!("total: {total} cases, {failed} failed");
  assert!(total > 0, "no cases replayed");
  assert_eq!(failed, 0, "{failed} of {total} cases differ from the TS");
}
