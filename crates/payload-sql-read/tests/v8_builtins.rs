//! Differential tests of the V8 builtins ported in this crate against the real V8 (Node): cases
//! and expected results come from test/__rs/read/capture/v8-builtins.mjs (seeded PRNG plus edge
//! cases), run with `node` at test time. Every test fails when node is unavailable or no case
//! was compared.

use std::path::PathBuf;

use payload_sql_read::Val;
use payload_sql_read::json::{parse, parse_js, stringify};
use payload_sql_read::jsops::{parse_float, string_to_number, to_number};
use payload_sql_read::props::{array_items, get, set};
use payload_sql_read::sort::v8_sort;

fn cases(mode: &str) -> Vec<Val> {
  let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/__rs/read/capture/v8-builtins.mjs");
  let out = std::process::Command::new("node")
    .arg(&script)
    .arg(mode)
    .output()
    .unwrap_or_else(|e| panic!("node is required for the V8 differential tests: {e}"));
  assert!(out.status.success(), "node {} {mode} failed: {}", script.display(), String::from_utf8_lossy(&out.stderr));
  let text = String::from_utf8(out.stdout).expect("utf8 output");
  let cases = array_items(&parse(&text).expect("case JSON")).expect("case array");
  assert!(!cases.is_empty(), "{mode}: node produced zero cases");
  cases
}

fn at(v: &Val, key: &str) -> Val {
  get(v, key).unwrap_or_default()
}

fn text(v: &Val) -> String {
  v.as_js_str().map(|s| s.to_lossy().into_owned()).unwrap_or_default()
}

/// `String(number)` with `-0` kept apart (the encoding of the generator).
fn number_text(n: f64) -> String {
  if n == 0.0 && n.is_sign_negative() { "-0".into() } else { payload_sql_read::jsops::num_to_string(n) }
}

fn report(mode: &str, total: usize, failures: &[String]) {
  println!("{mode}: {}/{total} match V8", total - failures.len());
  for f in failures.iter().take(30) {
    println!("MISMATCH {f}");
  }
  assert!(total > 0, "{mode}: compared zero cases");
  assert!(failures.is_empty(), "{mode}: {} of {total} cases differ from V8", failures.len());
}

#[test]
fn json_parse_matches_v8() {
  let cases = cases("json-parse");
  let mut failures = Vec::new();
  for case in &cases {
    let input = at(case, "input");
    let input = input.as_js_str().expect("string input");
    let actual = match parse_js(input) {
      Ok(v) => Ok(stringify(&v).expect("stringify").unwrap_or_default()),
      Err(e) => Err(format!("{}: {}", e.name, e.message)),
    };
    let expected = match at(case, "error") {
      Val::Undefined => Ok(text(&at(case, "ok"))),
      e => Err(text(&e)),
    };
    if actual != expected {
      failures.push(format!("{:?}: expected {expected:?}, got {actual:?}", input.to_lossy()));
    }
  }
  report("JSON.parse", cases.len(), &failures);
}

#[test]
fn number_of_string_matches_v8() {
  let cases = cases("number");
  let mut failures = Vec::new();
  for case in &cases {
    let input = text(&at(case, "input"));
    let expected = text(&at(case, "value"));
    let actual = number_text(string_to_number(&input));
    if actual != expected {
      failures.push(format!("Number({input:?}): expected {expected}, got {actual}"));
    }
    let expected = text(&at(case, "parseFloat"));
    let actual = number_text(parse_float(&input));
    if actual != expected {
      failures.push(format!("parseFloat({input:?}): expected {expected}, got {actual}"));
    }
  }
  report("Number(string)", cases.len(), &failures);
}

#[test]
fn number_of_object_matches_v8() {
  let cases = cases("number-object");
  let mut failures = Vec::new();
  for case in &cases {
    let input = text(&at(case, "input"));
    let value = parse(&input).expect("valid JSON input");
    let actual = match to_number(&value) {
      Ok(n) => Ok(number_text(n)),
      Err(e) => Err(format!("{}: {}", e.name, e.message)),
    };
    let expected = match at(case, "error") {
      Val::Undefined => Ok(text(&at(case, "value"))),
      e => Err(text(&e)),
    };
    if actual != expected {
      failures.push(format!("Number(JSON.parse({input:?})): expected {expected:?}, got {actual:?}"));
    }
  }
  report("Number(object)", cases.len(), &failures);
}

/// `createBlocksMap`'s `blocks.sort(...)` comparator over rows with arbitrary `_order` cells.
#[test]
fn blocks_sort_matches_v8() {
  let cases = cases("sort");
  let mut failures = Vec::new();
  for (case_index, case) in cases.iter().enumerate() {
    let orders = array_items(&at(case, "orders")).expect("orders");
    let mut rows: Vec<Val> = Vec::with_capacity(orders.len());
    for (index, order) in orders.iter().enumerate() {
      let row = Val::new_obj();
      set(&row, "index", Val::Num(index as f64)).expect("set index");
      let order = match order {
        Val::Str(s) if s.as_str() == Some("undefined") => None,
        Val::Str(s) if s.as_str() == Some("NaN") => Some(Val::Num(f64::NAN)),
        Val::Obj(_) => Some(at(order, "s")),
        other => Some(other.clone()),
      };
      if let Some(order) = order {
        set(&row, "_order", order).expect("set _order");
      }
      rows.push(row);
    }
    v8_sort(&mut rows, |a, b| match (at(a, "_order"), at(b, "_order")) {
      (Val::Num(x), Val::Num(y)) => x - y,
      _ => 0.0,
    });
    let actual: Vec<usize> = rows.iter().map(|r| if let Val::Num(n) = at(r, "index") { n as usize } else { usize::MAX }).collect();
    let expected: Vec<usize> = array_items(&at(case, "sorted"))
      .expect("sorted")
      .iter()
      .map(|v| if let Val::Num(n) = v { *n as usize } else { usize::MAX })
      .collect();
    if actual != expected {
      failures.push(format!("case {case_index} (length {}): first difference at {:?}", orders.len(), actual.iter().zip(&expected).position(|(a, b)| a != b)));
    }
  }
  report("Array.prototype.sort", cases.len(), &failures);
}
