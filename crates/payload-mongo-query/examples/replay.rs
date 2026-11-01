//! `replay <fixture.json[.gz]> <out.json>`: replays a fixture (see `tests/replay/mod.rs`) and writes
//! `{ cases: [{ id, kind, failure, result | error }], total, failed }` with the Rust outputs in the
//! boundary encoding, so `test/__rs/mongo-query/corpus.int.spec.ts` can run the Rust filters
//! through mongoose (result-level check).

#[path = "../tests/replay/mod.rs"]
mod replay;

fn main() {
  let mut args = std::env::args().skip(1);
  let (Some(input), Some(out)) = (args.next(), args.next()) else {
    eprintln!("usage: replay <fixture.json[.gz]> <out.json>");
    std::process::exit(2);
  };
  let fx = replay::load(std::path::Path::new(&input));
  // `replay <fixture> - <case id>`: print one case (args, TS result / error, host ops, Rust output)
  if out == "-" {
    let id: i64 = args.next().and_then(|s| s.parse().ok()).expect("case id");
    let case = fx.cases.iter().find(|c| c["id"].as_i64() == Some(id)).expect("case");
    let decode = |g: &serde_json::Value| payload_engine::js::decode_graph_bson(g).map(|v| format!("{v:?}")).unwrap_or_default();
    println!("kind: {}\nargs: {}", case["kind"], decode(&case["args"]));
    println!("ts result: {}\nts error: {}", decode(&case["result"]), case["error"]);
    for op in case["hostOps"].as_array().into_iter().flatten() {
      println!("host op: {}\n  -> {} {}", decode(&op["request"]), decode(&op["result"]), op["error"]);
    }
    if !case["argsAfter"].is_null() {
      println!("ts argsAfter: {}", decode(&case["argsAfter"]));
    }
    let outcome = replay::run_case(&fx, case);
    println!("rust: {}\nfailure: {:?}", outcome.output, outcome.failure);
    return;
  }
  let mut cases = Vec::new();
  let mut failed = 0;
  for case in &fx.cases {
    let outcome = replay::run_case(&fx, case);
    if outcome.failure.is_some() {
      failed += 1;
    }
    let mut entry = outcome.output;
    entry["id"] = outcome.id;
    entry["kind"] = serde_json::Value::String(outcome.kind);
    entry["failure"] = outcome.failure.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null);
    cases.push(entry);
  }
  let total = cases.len();
  let report = serde_json::json!({ "cases": cases, "total": total, "failed": failed });
  std::fs::write(&out, serde_json::to_string(&report).expect("serialize report")).expect("write report");
  eprintln!("{}: {} cases, {} failed", fx.suite, total, failed);
}
