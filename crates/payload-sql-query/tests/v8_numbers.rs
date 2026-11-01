//! Differential test of the query builder's `Number()` / `parseInt` / `parseFloat` against the
//! real V8 (Node): cases come from test/__rs/read/capture/v8-builtins.mjs (`number` mode), run
//! with `node` at test time. Fails when node is unavailable or no case was compared.

use std::path::PathBuf;

use payload_engine::js::JsVal;
use payload_sql_query::js_ops::{number_to_string, parse_float, parse_int, string_to_number};
use serde_json::Value as Json;

fn number_text(n: f64) -> String {
  if n == 0.0 && n.is_sign_negative() { "-0".into() } else { number_to_string(n) }
}

#[test]
fn numbers_match_v8() {
  let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/__rs/read/capture/v8-builtins.mjs");
  let out = std::process::Command::new("node")
    .arg(&script)
    .arg("number")
    .output()
    .unwrap_or_else(|e| panic!("node is required for the V8 differential test: {e}"));
  assert!(out.status.success(), "node {} number failed: {}", script.display(), String::from_utf8_lossy(&out.stderr));
  let cases: Vec<Json> = serde_json::from_slice(&out.stdout).expect("case JSON");
  assert!(!cases.is_empty(), "node produced zero cases");

  let mut failures = Vec::new();
  let mut compared = 0;
  for case in &cases {
    let input = case["input"].as_str().expect("string input");
    let js = JsVal::str(input);
    for (name, expected, actual) in [
      ("Number", &case["value"], string_to_number(input)),
      ("parseInt", &case["parseInt"], parse_int(&js)),
      ("parseFloat", &case["parseFloat"], parse_float(&js)),
    ] {
      compared += 1;
      let actual = number_text(actual);
      if expected.as_str() != Some(actual.as_str()) {
        failures.push(format!("{name}({input:?}): expected {expected}, got {actual}"));
      }
    }
  }
  println!("{}/{compared} conversions match V8", compared - failures.len());
  for f in failures.iter().take(30) {
    println!("MISMATCH {f}");
  }
  assert!(compared > 0, "compared zero cases");
  assert!(failures.is_empty(), "{} of {compared} conversions differ from V8", failures.len());
}
