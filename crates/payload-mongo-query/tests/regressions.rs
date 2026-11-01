//! Hand-written cases next to the recorded differential (`differential.rs`).

use std::task::{Context, Poll, Waker};

use payload_engine::error::{EngineError, Result};
use payload_engine::js::{JsVal, Obj};
use payload_mongo_query::{
  BuildQueryArgs, LocalBoxFuture, ModelOp, QueryCx, QueryEnv, QueryHost, build_projection_from_select, build_query,
};

struct NoDatabase;

impl QueryHost for NoDatabase {
  fn model_op(&self, _op: &ModelOp) -> LocalBoxFuture<'static, Result<JsVal>> {
    Box::pin(async { Err(EngineError::internal("no database")) })
  }

  fn collection_name(&self, slug: &str) -> Result<JsVal> {
    Ok(JsVal::str(slug))
  }
}

fn obj(entries: Vec<(&str, JsVal)>) -> JsVal {
  JsVal::obj(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect::<Obj>())
}

fn block_on<T>(mut future: LocalBoxFuture<'_, T>) -> T {
  let mut cx = Context::from_waker(Waker::noop());
  loop {
    if let Poll::Ready(v) = future.as_mut().poll(&mut cx) {
      return v;
    }
  }
}

/// V8 throws `RangeError: Maximum call stack size exceeded` for absurdly nested wheres / selects;
/// the port must throw too instead of overflowing the native stack.
#[test]
fn deeply_nested_where_and_select_throw_range_error() {
  // on a 2 MiB stack (less than the Node main thread the engine runs on)
  std::thread::Builder::new().stack_size(2 << 20).spawn(nested).expect("spawn").join().expect("no stack overflow");
}

fn nested() {
  let fields = JsVal::arr(vec![obj(vec![("name", JsVal::str("title")), ("type", JsVal::str("text"))])]);
  let root = obj(vec![
    ("config", obj(vec![("localization", JsVal::Bool(false))])),
    ("collections", obj(vec![])),
    ("blocks", obj(vec![])),
    ("defaultIDType", JsVal::str("text")),
  ]);
  let host = NoDatabase;
  let cx = QueryCx::new(QueryEnv::from_root(&root, false), &host);

  let mut where_ = obj(vec![("title", obj(vec![("equals", JsVal::str("x"))]))]);
  for _ in 0..50_000 {
    where_ = obj(vec![("and", JsVal::arr(vec![where_]))]);
  }
  let args = BuildQueryArgs { collection_slug: None, fields: &fields, global_slug: None, locale: &JsVal::Undefined, where_: &where_ };
  let error = block_on(Box::pin(build_query(&cx, args))).expect_err("nested where");
  assert_eq!((error.name.as_str(), error.message.as_str()), ("RangeError", "Maximum call stack size exceeded"));

  let mut select = JsVal::Bool(true);
  for _ in 0..50_000 {
    select = obj(vec![("title", select)]);
  }
  let error = build_projection_from_select(&cx, &fields, &select).expect_err("nested select");
  assert_eq!(error.name, "RangeError");

  // a shallow where still works
  let shallow = obj(vec![("and", JsVal::arr(vec![obj(vec![("title", obj(vec![("equals", JsVal::str("x"))]))])]))]);
  let args = BuildQueryArgs { where_: &shallow, ..args };
  let filter = block_on(Box::pin(build_query(&cx, args))).expect("shallow where");
  assert!(filter.get("$and").as_arr().is_some_and(|a| a.len() == 1));
}
