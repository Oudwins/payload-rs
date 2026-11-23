//! Evaluation cost of typical compiled access functions (release build):
//!
//!   cargo run --release -p payload-fn-ir --example bench
use std::time::Instant;

use payload_fn_ir::lanes::{self, RequestSnapshot};
use payload_fn_ir::{Value, compile_standalone, evaluate};

fn main() {
  let cases = [
    ("anyone", "() => true"),
    ("authenticated", "({ req: { user } }) => Boolean(user)"),
    (
      "adminOrOwner (inline checkRole)",
      "({ req: { user } }) => { if (user && ['admin'].some((role) => user?.roles?.some((r) => r === role))) { return true } if (user?.id) { return { customer: { equals: user.id } } } return false }",
    ),
    (
      "authenticatedOrPublished",
      "({ req: { user } }) => { if (user) { return true } return { _status: { equals: 'published' } } }",
    ),
  ];
  let user = Value::from_json(&serde_json::json!({ "id": "abc", "roles": ["editor", "user"], "email": "a@b.c" }));
  let req = lanes::request(&RequestSnapshot { user, ..Default::default() });
  let args = [lanes::collection_access_args(Value::Undefined, "posts", Value::Undefined, req)];
  for (name, src) in cases {
    let id = compile_standalone(src).expect("compiles");
    let n = 1_000_000;
    for _ in 0..1000 {
      evaluate(id, &args).unwrap();
    }
    let start = Instant::now();
    for _ in 0..n {
      std::hint::black_box(evaluate(id, std::hint::black_box(&args)).unwrap());
    }
    let ns = start.elapsed().as_nanos() as f64 / n as f64;
    let start = Instant::now();
    for _ in 0..n {
      std::hint::black_box(payload_fn_ir::registry::is_active(std::hint::black_box(id)));
    }
    let lookup = start.elapsed().as_nanos() as f64 / n as f64;
    println!("{name}: {ns:.0} ns per evaluation (registry lookup {lookup:.0} ns)");
  }
}
