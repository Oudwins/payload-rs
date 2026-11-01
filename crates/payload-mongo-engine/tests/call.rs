//! `MongoEngine::call` end to end on a small graph with a synchronous host: argument / context
//! decoding, host op requests, the `{ result, mutations }` envelope and the error JSON.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use payload_engine::error::{EngineError, HostThrow};
use payload_engine::host::NoHost;
use payload_engine::js::{JsVal, decode_value_bson, encode_value};
use payload_mongo_engine::host::{LocalBoxFuture, MongoHost, MongoResult, Settlable, run_to_completion};
use payload_mongo_engine::wired::Wired;
use payload_mongo_engine::MongoEngine;
use serde_json::{Value as Json, json};

type Responder = Box<dyn Fn(&Json) -> MongoResult<JsVal>>;

struct TestHost {
  requests: RefCell<Vec<Json>>,
  respond: Responder,
}

impl MongoHost for TestHost {
  fn op(&self, request: JsVal) -> LocalBoxFuture<'static, MongoResult<JsVal>> {
    let request = encode_value(&request);
    let response = (self.respond)(&request);
    self.requests.borrow_mut().push(request);
    Box::pin(Settlable::settled(response))
  }
}

fn engine() -> Arc<MongoEngine<Wired>> {
  let posts = json!({
    "slug": "posts",
    "fields": [{ "name": "title", "type": "text", "unique": true }],
    "flattenedFields": [{ "name": "title", "type": "text", "unique": true }],
    "timestamps": true,
    "joins": {},
    "polymorphicJoins": [],
    "versions": false,
  });
  let graph = json!({
    "objects": [],
    "root": {
      "blocks": {},
      "collections": { "posts": { "config": posts, "customIDType": { "$undefined": true } } },
      "config": { "collections": [posts], "globals": [], "localization": false, "blocks": [] },
    },
  });
  Arc::new(MongoEngine::create(&graph, |g| Wired::new(g, json!({}))).expect("engine"))
}

fn context(has_req: bool) -> String {
  json!({
    "adapter": { "allowAdditionalKeys": false, "allowIDOnCreate": false, "disableIndexHints": false, "useJoinAggregations": true },
    "hasReq": has_req,
    "models": { "collections": { "posts": "posts" }, "versions": {} },
    "now": 0,
    "withMutations": true,
  })
  .to_string()
}

fn run(engine: &Arc<MongoEngine<Wired>>, method: &str, args: Json, has_req: bool, host: Rc<TestHost>) -> Result<String, String> {
  let future = engine.call(method.into(), args.to_string(), context(has_req), host, Rc::new(NoHost));
  run_to_completion(future).expect("finished")
}

#[test]
fn count_without_filter_uses_the_estimated_count_and_the_session() {
  let engine = engine();
  let host = Rc::new(TestHost {
    requests: RefCell::new(Vec::new()),
    respond: Box::new(|request| match request["op"].as_str() {
      Some("getSession") => Ok(JsVal::host_object(7)),
      _ => Ok(JsVal::Num(5.0)),
    }),
  });
  let result = run(&engine, "count", json!({ "collection": "posts", "where": {} }), true, Rc::clone(&host)).expect("ok");
  assert_eq!(serde_json::from_str::<Json>(&result).expect("json"), json!({ "result": { "totalDocs": 5 }, "mutations": [] }));
  assert_eq!(
    *host.requests.borrow(),
    vec![
      json!({ "op": "getSession" }),
      json!({
        "op": "model",
        "model": { "kind": "collections", "slug": "posts" },
        "method": "estimatedDocumentCount",
        "args": [{ "session": { "$hostObject": 7 } }],
      }),
    ]
  );
}

#[test]
fn no_req_means_no_get_session_op() {
  let engine = engine();
  let host = Rc::new(TestHost { requests: RefCell::new(Vec::new()), respond: Box::new(|_| Ok(JsVal::Num(0.0))) });
  run(&engine, "count", json!({ "collection": "posts" }), false, Rc::clone(&host)).expect("ok");
  assert!(host.requests.borrow().iter().all(|r| r["op"] != "getSession"));
  assert_eq!(host.requests.borrow()[0]["args"], json!([{ "session": { "$undefined": true } }]));
}

#[test]
fn duplicate_key_becomes_a_validation_error_with_the_data_mutations() {
  let engine = engine();
  let host = Rc::new(TestHost {
    requests: RefCell::new(Vec::new()),
    respond: Box::new(|request| match request["method"].as_str() {
      Some("create") => Err(EngineError::host_throw(
        "MongoServerError",
        HostThrow {
          handle: 3,
          is_object: true,
          message: Some(JsVal::str("E11000 duplicate key error")),
          code: Some(JsVal::Num(11000.0)),
          key_value: Some(decode_value_bson(&json!({ "title": "a" })).expect("value")),
        },
      )),
      _ => Ok(JsVal::Undefined),
    }),
  });
  let error = run(&engine, "create", json!({ "collection": "posts", "data": { "title": "a" } }), false, Rc::clone(&host))
    .expect_err("fails");
  let error: Json = serde_json::from_str(&error).expect("json");
  assert_eq!(error["name"], "ValidationError");
  assert_eq!(error["data"]["errors"], json!([{ "path": "title" }]));
  assert_eq!(error["data"]["collection"], "posts");
  // `createdAt` / `updatedAt` stamped with the context clock before the insert failed
  assert_eq!(
    error["mutations"],
    json!([[["data"], { "title": "a", "createdAt": "1970-01-01T00:00:00.000Z", "updatedAt": "1970-01-01T00:00:00.000Z" }]])
  );
  let create = &host.requests.borrow()[0];
  assert_eq!(create["post"], "toObject");
  assert_eq!(create["args"][1], json!({ "session": { "$undefined": true }, "timestamps": false }));
}

#[test]
fn other_host_errors_are_rethrown_by_handle() {
  let engine = engine();
  let host = Rc::new(TestHost {
    requests: RefCell::new(Vec::new()),
    respond: Box::new(|_| {
      Err(EngineError::host_throw(
        "CastError",
        HostThrow { handle: 9, is_object: true, message: Some(JsVal::str("Cast to ObjectId failed")), code: None, key_value: None },
      ))
    }),
  });
  let error = run(&engine, "deleteMany", json!({ "collection": "posts", "where": {} }), false, host).expect_err("fails");
  assert_eq!(serde_json::from_str::<Json>(&error).expect("json"), json!({ "rethrow": 9 }));
}

#[test]
fn unknown_collection_is_an_api_error() {
  let engine = engine();
  let host = Rc::new(TestHost { requests: RefCell::new(Vec::new()), respond: Box::new(|_| Ok(JsVal::Undefined)) });
  let error = run(&engine, "find", json!({ "collection": "nope" }), false, Rc::clone(&host)).expect_err("fails");
  let error: Json = serde_json::from_str(&error).expect("json");
  assert_eq!(error["name"], "APIError");
  assert_eq!(error["message"], "ERROR: Failed to retrieve collection with the slug \"nope\". Does not exist.");
  assert!(host.requests.borrow().is_empty());
}
