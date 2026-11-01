//! `serializeForEngine` (packages/engine-rs/src/serialize.ts) reads inherited and non-enumerable
//! properties (class instance getters, ...) only for the property names the Rust engine reads,
//! listed in its `engineReadKeys`. This test keeps that list in sync with the engine sources: every
//! literal property name read through `.get("k")`, `.has("k")`, `.path(&["a", "b"])` or the
//! `drafts_option(entity, "k")` helper in `crates/*/src` must be listed.
//!
//! `ENGINE_READ_KEYS_PRINT=1` prints the complete list.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
  for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
    let path = entry.path();
    if path.is_dir() {
      rust_files(&path, out);
    } else if path.extension().is_some_and(|e| e == "rs") {
      out.push(path);
    }
  }
}

fn is_identifier(s: &str) -> bool {
  let mut chars = s.chars();
  chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
    && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// The string literal starting at `text` (just after its opening quote).
fn literal(text: &str) -> Option<&str> {
  text.find('"').map(|end| &text[..end]).filter(|s| is_identifier(s))
}

fn keys_read_in(source: &str, keys: &mut BTreeSet<String>) {
  for pattern in [".get(\"", ".has(\"", "drafts_option(entity, \""] {
    for (i, _) in source.match_indices(pattern) {
      keys.extend(literal(&source[i + pattern.len()..]).map(str::to_string));
    }
  }
  for (i, _) in source.match_indices("path(&[") {
    let rest = &source[i + "path(&[".len()..];
    let list = &rest[..rest.find(']').unwrap_or(0)];
    for part in list.split(',') {
      if let Some(key) = part.trim().strip_prefix('"').and_then(|p| p.strip_suffix('"')) {
        if is_identifier(key) {
          keys.insert(key.to_string());
        }
      }
    }
  }
}

fn listed_keys(serialize_ts: &str) -> BTreeSet<String> {
  let start = serialize_ts.find("// engine-read-keys:start").expect("engine-read-keys:start marker in serialize.ts");
  let end = serialize_ts.find("// engine-read-keys:end").expect("engine-read-keys:end marker in serialize.ts");
  serialize_ts[start..end]
    .split('\'')
    .skip(1)
    .step_by(2)
    .map(str::to_string)
    .collect()
}

#[test]
fn engine_read_keys_cover_engine_sources() {
  let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
  let mut files = Vec::new();
  for entry in std::fs::read_dir(root.join("crates")).expect("crates dir").flatten() {
    rust_files(&entry.path().join("src"), &mut files);
  }
  assert!(!files.is_empty(), "no engine sources found");
  let mut read = BTreeSet::new();
  for file in &files {
    keys_read_in(&std::fs::read_to_string(file).expect("read source"), &mut read);
  }
  if std::env::var("ENGINE_READ_KEYS_PRINT").as_deref() == Ok("1") {
    println!("{}", read.iter().map(|k| format!("'{k}',")).collect::<Vec<_>>().join("\n"));
  }
  let serialize_ts = std::fs::read_to_string(root.join("packages/engine-rs/src/serialize.ts")).expect("serialize.ts");
  let listed = listed_keys(&serialize_ts);
  let missing: Vec<_> = read.difference(&listed).collect();
  assert!(
    missing.is_empty(),
    "add these property names the engine reads to `engineReadKeys` in packages/engine-rs/src/serialize.ts: {missing:?}"
  );
  eprintln!("{} engine read keys listed, {} read in {} files", listed.len(), read.len(), files.len());
}
