//! Own `__proto__` keys survive the `serializeForEngine` wire format into the decoded graph and
//! back out (review-query-write-upsert #1): `JSON.parse('{"__proto__":{"equals":"x"}}')` is a
//! `where` with one own key, not an empty object. The input is what
//! `packages/engine-rs/src/serialize.ts` emits for these values (test/__rs/schema/serialize.int.spec.ts
//! checks the TS side of the same values).

use payload_engine::js::{JsVal, decode_graph};
use serde_json::{Value as Json, json};

/// `serializeForEngine({ where, a: shared, b: shared, only, esc })` with
/// `where = JSON.parse('{"__proto__":{"equals":"x"}}')`, `shared = JSON.parse('{"__proto__":1}')`,
/// `only = JSON.parse('{"__proto__":{"$date":1}}')`, `esc = { $date: 'x' }`.
const SERIALIZED: &str = r#"{"objects":[{"__proto__":1}],"root":{"where":{"__proto__":{"equals":"x"}},"a":{"$ref":0},"b":{"$ref":0},"only":{"__proto__":{"$obj":{"$date":1}}},"esc":{"$obj":{"$date":"x"}}}}"#;

#[test]
fn own_proto_keys_are_plain_keys() {
  let graph: Json = serde_json::from_str(SERIALIZED).unwrap();
  let root = decode_graph(&graph).expect("decode");

  let where_ = root.get("where");
  assert!(where_.has("__proto__"), "own __proto__ key of `where` lost");
  assert_eq!(where_.get("__proto__").get("equals").as_str(), Some("x"));

  let (a, b) = (root.get("a"), root.get("b"));
  assert!(a.has("__proto__"));
  assert_eq!(a.identity(), b.identity(), "shared object decoded twice");

  // a reserved-key-only object below an own `__proto__` key stays a plain object
  let inner = root.get("only").get("__proto__");
  assert!(inner.has("$date"));
  assert!(inner.as_date().is_none());
  assert!(root.get("esc").as_date().is_none());
  assert_eq!(root.get("esc").get("$date").as_str(), Some("x"));

  assert_eq!(where_.to_json(), json!({ "__proto__": { "equals": "x" } }));
  assert!(matches!(root.get("where"), JsVal::Obj(_)));
}
