//! Deep JSON never aborts the process: V8's `JSON.parse` accepts any nesting depth (its parser is
//! iterative), so a json column can hold values nested far deeper than a native stack allows
//! recursion. `parse_to_js`, `Val::from_js`, `Val::to_js`, `encode_value_text` and dropping the
//! values are iterative; this runs them on 100k levels on 8 MB (the JS main thread) and 16 MB (the
//! engine's call threads) stacks, and on a 256 KB stack with 1M levels.

use payload_engine::js::{JsVal, encode_value_text};
use payload_sql_read::Val;
use payload_sql_read::json::parse_to_js;

/// `[{"a":[{"a": ... 1 ... }]}]`-style nesting of `depth` containers.
fn nested(depth: usize, open: &str, close: &str, leaf: &str) -> String {
  let mut text = String::with_capacity(depth * (open.len() + close.len()) + leaf.len());
  for _ in 0..depth {
    text.push_str(open);
  }
  text.push_str(leaf);
  for _ in 0..depth {
    text.push_str(close);
  }
  text
}

fn depth_of(value: &JsVal) -> usize {
  let mut depth = 0;
  let mut current = value.clone();
  loop {
    let next = match &current {
      JsVal::Arr(a) => a.first().cloned(),
      JsVal::Obj(o) => o.values().next().cloned(),
      _ => None,
    };
    match next {
      Some(next) => {
        depth += 1;
        current = next;
      }
      None => return depth,
    }
  }
}

fn on_stack(bytes: usize, f: impl FnOnce() + Send + 'static) {
  std::thread::Builder::new().stack_size(bytes).spawn(f).expect("spawn").join().expect("no panic");
}

fn round_trip(depth: usize) {
  for (open, close, leaf, levels) in [
    ("[", "]", "1", depth),
    ("{\"a\":", "}", "true", depth),
    ("[{\"a\":", "}]", "\"x\\u00e9\"", depth * 2),
  ] {
    let text = nested(depth, open, close, leaf);
    let parsed = parse_to_js(&text).expect("deep JSON parses");
    assert_eq!(depth_of(&parsed), levels);
    // the read transform's mutable copy and back
    let copy = Val::from_js(&parsed);
    let back = copy.to_js();
    drop(copy);
    assert_eq!(depth_of(&back), levels);
    // the result encoding: plain JSON values encode as themselves (`\u00e9` is written as `é`)
    let encoded = encode_value_text(&back);
    assert_eq!(encoded, text.replace("\\u00e9", "é"));
    drop(parsed);
    drop(back);
  }
}

#[test]
fn hundred_thousand_levels_on_an_8_mb_stack() {
  on_stack(8 << 20, || round_trip(100_000));
}

#[test]
fn hundred_thousand_levels_on_a_16_mb_stack() {
  on_stack(16 << 20, || round_trip(100_000));
}

#[test]
fn a_million_levels_on_a_small_stack() {
  on_stack(256 << 10, || round_trip(1_000_000));
}

/// Errors of deep invalid input are V8's `SyntaxError`s (the UTF-16 parser is iterative too).
#[test]
fn deep_invalid_json_is_a_syntax_error() {
  on_stack(8 << 20, || {
    let text = format!("{}1{}", "[".repeat(100_000), "]".repeat(99_999));
    let err = parse_to_js(&text).expect_err("unbalanced");
    assert_eq!(err.name, "SyntaxError");
    assert!(err.message.starts_with("Expected ',' or ']' after array element"), "{}", err.message);
  });
}

/// The direct parser and the UTF-16 parser agree (values, key order, duplicate keys, numbers,
/// escapes, lone surrogates as U+FFFD).
#[test]
fn direct_parse_matches_the_utf16_parser() {
  for text in [
    r#"{"b":1,"2":2,"a":3,"1":4,"b":5,"__proto__":{"x":[]}}"#,
    r#"[1e400,-1e400,-0,0.1,1E-7,123456789012345678901234567890]"#,
    r#" [ "a\"b\\c\/d\b\f\n\r\t", "\ud83d\ude00", "\ud83d", "x\udc00y", "é😀" ] "#,
    r#"{"4294967295":1,"4294967294":2,"01":3,"0":4}"#,
    "[]",
    "{}",
    "null",
    "\"\"",
  ] {
    let direct = parse_to_js(text).expect(text);
    let reference = payload_sql_read::json::parse(text).expect(text).to_js();
    assert_eq!(encode_value_text(&direct), encode_value_text(&reference), "{text}");
  }
  for bad in ["", "[1,]", "01", "1.", "\"\t\"", "{\"a\" 1}", "[1] x", "'a'", "\"\\x\"", "+1", "NaN", "[\"\\u12\"]", "tru", "-"] {
    let direct = parse_to_js(bad).expect_err(bad);
    let reference = payload_sql_read::json::parse(bad).expect_err(bad);
    assert_eq!((direct.name, direct.message), (reference.name, reference.message), "{bad}");
  }
}

/// `cargo test --release -p payload-sql-read --test deep_json -- --ignored --nocapture`: time to
/// parse a ~500 KB Lexical-like document into an engine value.
#[test]
#[ignore]
fn parse_speed() {
  let node = r#"{"type":"paragraph","version":1,"format":"","indent":0,"direction":"ltr","children":[{"type":"text","text":"Lorem ipsum dolor sit amet, consectetur adipiscing elit","format":0,"detail":0,"mode":"normal","style":"","version":1}]}"#;
  let text = format!(r#"{{"root":{{"type":"root","children":[{}]}}}}"#, vec![node; 2500].join(","));
  let runs = 20;
  let start = std::time::Instant::now();
  for _ in 0..runs {
    drop(parse_to_js(&text).expect("parse"));
  }
  let direct = start.elapsed() / runs;
  let start = std::time::Instant::now();
  for _ in 0..runs {
    drop(payload_sql_read::json::parse(&text).expect("parse").to_js());
  }
  let via_val = start.elapsed() / runs;
  let start = std::time::Instant::now();
  for _ in 0..runs {
    let json: serde_json::Value = serde_json::from_str(&text).expect("parse");
    drop(JsVal::from_json(&json));
  }
  let serde = start.elapsed() / runs;
  eprintln!("{} KB: parse_to_js {direct:?}, parse + to_js {via_val:?}, serde + from_json {serde:?}", text.len() / 1024);
}
