//! napi binding of the MongoDB engine (`crates/payload-mongo-engine`,
//! packages/engine-rs/MONGO_ENGINE_CONTRACT.md "napi surface"):
//!
//! ```ts
//! class MongoEngine {
//!   static create(graphJson: string, optionsJson: string, callFunction: (id: number, argJson: string) => string): MongoEngine
//!   schemaDescription(): string
//!   call(method: string, argsJson: string, contextJson: string, host: (opJson: string) => Promise<string>): Promise<string>
//! }
//! ```
//!
//! `call` runs the method as a future polled on the JS thread: the first poll runs synchronously
//! inside `call` (like the synchronous start of the TS async method); every host op calls `host`
//! right away and the task is polled again from the reaction of the promise `host` returned, so
//! the method continues in the microtask where the TS `await` would continue. No threads.

use std::cell::{Cell, RefCell};
use std::ptr;
use std::rc::{Rc, Weak};
use std::sync::Arc;
use std::task::Poll;

use napi::bindgen_prelude::{FnArgs, Function, FunctionRef, Object, ToNapiValue, Unknown};
use napi::{Env, JsValue, Result, sys};
use napi_derive::napi;
use payload_engine::error::{EngineError, HostThrow};
use payload_engine::host::Host;
use payload_engine::js::{JsVal, decode_graph_typed, decode_value_bson, encode_value, encode_value_text};
use payload_mongo_engine::host::{LocalBoxFuture, MongoHost, MongoResult, Settlable, poll_once};
use payload_mongo_engine::wired::Wired;
use payload_mongo_engine::MongoEngine;
use serde_json::Value as Json;

type CallbackRef = FunctionRef<FnArgs<(u32, String)>, String>;
type HostRef = FunctionRef<String, Unknown<'static>>;

fn to_napi_error(error: EngineError) -> napi::Error {
  napi::Error::new(napi::Status::GenericFailure, error.to_json().to_string())
}

fn parse_json(input: &str, what: &str) -> std::result::Result<Json, EngineError> {
  serde_json::from_str(input).map_err(|e| EngineError::internal(format!("invalid {what} JSON: {e}")))
}

/// `callFunction(id, argJson)`: the argument in the `encode_value` encoding, the result in the
/// `serializeForEngine` encoding (decoded typed); `{ $hostError }` when the function threw.
struct FunctionHost {
  env: sys::napi_env,
  callback: Rc<CallbackRef>,
}

impl Host for FunctionHost {
  fn call(&self, id: u32, arg: &Json) -> payload_engine::error::Result<JsVal> {
    self.call_value(id, &JsVal::from_json(arg))
  }

  fn call_value(&self, id: u32, arg: &JsVal) -> payload_engine::error::Result<JsVal> {
    let env = Env::from_raw(self.env);
    let callback = self
      .callback
      .borrow_back(&env)
      .map_err(|e| EngineError::internal(format!("engine host callback is gone: {}", e.reason)))?;
    let result = callback
      .call((id, encode_value(arg).to_string()).into())
      .map_err(|e| EngineError::new("HostError", e.reason.clone()))?;
    let graph: Json = serde_json::from_str(&result)
      .map_err(|e| EngineError::internal(format!("invalid host function result: {e}")))?;
    if graph.get("$hostError").is_some() {
      return Err(EngineError::new("HostError", format!("JS function {id} threw")));
    }
    decode_graph_typed(&graph)
  }
}

#[napi(js_name = "MongoEngine")]
pub struct MongoEngineJs {
  engine: Arc<MongoEngine<Wired>>,
  callback: Rc<CallbackRef>,
}

#[napi]
impl MongoEngineJs {
  /// Decodes the graph once (`serializeForEngine({ config, collections, blocks })`); kept for the
  /// engine's lifetime with `optionsJson` (the adapter options fixed at construction).
  #[napi(factory)]
  pub fn create(
    graph_json: String,
    options_json: String,
    call_function: Function<FnArgs<(u32, String)>, String>,
  ) -> Result<Self> {
    let engine = (|| -> std::result::Result<_, EngineError> {
      let graph = parse_json(&graph_json, "graph")?;
      let options = parse_json(&options_json, "options")?;
      MongoEngine::create(&graph, |decoded| Wired::new(decoded, options))
    })()
    .map_err(to_napi_error)?;
    let callback = Rc::new(call_function.create_ref()?);
    Ok(Self { engine: Arc::new(engine), callback })
  }

  /// The schema description (`payload-mongo-schema`'s `Description::to_json`).
  #[napi]
  pub fn schema_description(&self, env: &Env) -> Result<String> {
    let functions = FunctionHost { env: env.raw(), callback: Rc::clone(&self.callback) };
    self.engine.schema_description(&functions).map(|json| json.to_string()).map_err(to_napi_error)
  }

  /// Runs one adapter method; database I/O through `host(opJson) => Promise<string>`.
  #[napi(ts_return_type = "Promise<string>")]
  pub fn call<'env>(
    &self,
    env: &'env Env,
    method: String,
    args_json: String,
    context_json: String,
    host: Function<String, Unknown<'static>>,
  ) -> Result<Object<'env>> {
    let (deferred, promise) = create_promise(env)?;
    let host_ref = Rc::new(host.create_ref()?);
    let task = Rc::new(Task {
      future: RefCell::new(None),
      deferred: Cell::new(deferred),
      polling: Cell::new(false),
      repoll: Cell::new(false),
      env: env.raw(),
    });
    let js_host: Rc<dyn MongoHost> = Rc::new(JsHost { env: env.raw(), host: host_ref, task: Rc::downgrade(&task) });
    let functions: Rc<dyn Host> = Rc::new(FunctionHost { env: env.raw(), callback: Rc::clone(&self.callback) });
    let future = self.engine.call(method, args_json, context_json, js_host, functions);
    *task.future.borrow_mut() = Some(future);
    poll_task(&task);
    Ok(promise)
  }
}

/// One `call` in progress.
struct Task {
  future: RefCell<Option<LocalBoxFuture<'static, std::result::Result<String, String>>>>,
  /// Null once settled.
  deferred: Cell<sys::napi_deferred>,
  polling: Cell<bool>,
  repoll: Cell<bool>,
  env: sys::napi_env,
}

/// Polls the call; settles its promise when it finished. A wake-up that arrives while the task is
/// being polled makes the running poll poll again.
fn poll_task(task: &Rc<Task>) {
  if task.polling.get() {
    task.repoll.set(true);
    return;
  }
  loop {
    task.polling.set(true);
    task.repoll.set(false);
    let polled = {
      let mut slot = task.future.borrow_mut();
      match slot.as_mut() {
        Some(future) => match poll_once(future) {
          Poll::Ready(result) => {
            *slot = None;
            Some(result)
          }
          Poll::Pending => None,
        },
        None => None,
      }
    };
    task.polling.set(false);
    if let Some(result) = polled {
      let deferred = task.deferred.replace(ptr::null_mut());
      if !deferred.is_null() {
        settle(&Env::from_raw(task.env), deferred, result);
      }
      return;
    }
    if !task.repoll.get() {
      return;
    }
  }
}

/// The host side of one call: every op calls `host(opJson)` now and settles from its promise.
struct JsHost {
  env: sys::napi_env,
  host: Rc<HostRef>,
  task: Weak<Task>,
}

impl MongoHost for JsHost {
  fn op(&self, request: JsVal) -> LocalBoxFuture<'static, MongoResult<JsVal>> {
    let (future, settler) = Settlable::new();
    if let Err(error) = self.issue(&request, settler.clone()) {
      settler.settle(Err(error));
    }
    Box::pin(future)
  }
}

impl JsHost {
  fn issue(&self, request: &JsVal, settler: payload_mongo_engine::host::Settler) -> std::result::Result<(), EngineError> {
    let env = Env::from_raw(self.env);
    let napi_error = |what: &str, e: napi::Error| EngineError::internal(format!("{what}: {}", e.reason));
    let host = self.host.borrow_back(&env).map_err(|e| napi_error("engine host op function is gone", e))?;
    let returned = host.call(encode_value_text(request)).map_err(|e| napi_error("host op function threw", e))?;
    let raw_env = self.env;
    let on_settled = |fulfilled: bool| {
      let settler = settler.clone();
      // the reactions keep the call alive until its op settles (nothing else holds the task)
      let task = self.task.upgrade();
      move |ctx: napi::bindgen_prelude::FunctionCallContext| -> Result<()> {
        let value = ctx.get::<Unknown>(0).ok().map(|v| v.raw());
        let result = match value {
          // SAFETY: JS thread; `v` is a live value of this callback scope.
          Some(v) if fulfilled => match unsafe { string_of(raw_env, v) } {
            Some(text) => decode_response(&text),
            None => Err(EngineError::internal("host op resolved with a non-string")),
          },
          // the rejection reason is an `Error` whose message is `{"error": ...}`
          Some(v) => match unsafe { error_message_of(raw_env, v) } {
            Some(text) => decode_response(&text),
            None => Err(EngineError::internal("host op rejected without an error message")),
          },
          None => Err(EngineError::internal("host op settled without a value")),
        };
        settler.settle(result);
        if let Some(task) = &task {
          poll_task(task);
        }
        Ok(())
      }
    };
    let on_fulfilled = env
      .create_function_from_closure::<(), (), _>("payloadMongoHostOpFulfilled", on_settled(true))
      .map_err(|e| napi_error("could not create a host op reaction", e))?;
    let on_rejected = env
      .create_function_from_closure::<(), (), _>("payloadMongoHostOpRejected", on_settled(false))
      .map_err(|e| napi_error("could not create a host op reaction", e))?;
    // SAFETY: JS thread, live env; `returned` is the value `host` returned; `then` is looked up on
    // it and called with it as `this` and the two reaction functions.
    unsafe {
      let raw = self.env;
      let mut then = ptr::null_mut();
      napi::check_status!(sys::napi_get_named_property(raw, returned.raw(), c"then".as_ptr(), &mut then))
        .map_err(|e| napi_error("host op result has no then", e))?;
      let mut kind = 0;
      napi::check_status!(sys::napi_typeof(raw, then, &mut kind)).map_err(|e| napi_error("typeof then", e))?;
      if kind != sys::ValueType::napi_function {
        return Err(EngineError::internal("host op function did not return a promise"));
      }
      let args = [on_fulfilled.raw(), on_rejected.raw()];
      let mut result = ptr::null_mut();
      napi::check_status!(sys::napi_call_function(raw, returned.raw(), then, args.len(), args.as_ptr(), &mut result))
        .map_err(|e| napi_error("promise.then threw", e))?;
    }
    Ok(())
  }
}

/// `value` as a string, `None` when it is not one.
unsafe fn string_of(env: sys::napi_env, value: sys::napi_value) -> Option<String> {
  let mut kind = 0;
  // SAFETY: caller guarantees a live env and value on the JS thread.
  unsafe {
    if sys::napi_typeof(env, value, &mut kind) != sys::Status::napi_ok || kind != sys::ValueType::napi_string {
      return None;
    }
    <String as napi::bindgen_prelude::FromNapiValue>::from_napi_value(env, value).ok()
  }
}

/// `value.message` when it is a string.
unsafe fn error_message_of(env: sys::napi_env, value: sys::napi_value) -> Option<String> {
  let mut kind = 0;
  // SAFETY: caller guarantees a live env and value on the JS thread.
  unsafe {
    if sys::napi_typeof(env, value, &mut kind) != sys::Status::napi_ok || kind != sys::ValueType::napi_object {
      return None;
    }
    let mut message = ptr::null_mut();
    if sys::napi_get_named_property(env, value, c"message".as_ptr(), &mut message) != sys::Status::napi_ok {
      return None;
    }
    string_of(env, message)
  }
}

/// `{"ok": <tree>}` or `{"error": { handle, isObject, name?, message?, code?, keyValue? }}` (a key is
/// present iff it is `in` the thrown value; values are trees).
fn decode_response(text: &str) -> MongoResult<JsVal> {
  let json = parse_json(text, "host op response")?;
  if let Some(ok) = json.get("ok") {
    return decode_value_bson(ok);
  }
  let Some(error) = json.get("error") else {
    return Err(EngineError::internal(format!("malformed host op response: {text}")));
  };
  let handle = error
    .get("handle")
    .and_then(Json::as_u64)
    .and_then(|h| u32::try_from(h).ok())
    .ok_or_else(|| EngineError::internal(format!("host op error without handle: {text}")))?;
  let is_object = error.get("isObject").and_then(Json::as_bool).unwrap_or(false);
  let prop = |key: &str| error.get(key).map(decode_value_bson).transpose();
  let name = match prop("name")? {
    Some(JsVal::Str(name)) => name.to_string(),
    _ => "Error".to_string(),
  };
  Err(EngineError::host_throw(
    name,
    HostThrow { handle, is_object, message: prop("message")?, code: prop("code")?, key_value: prop("keyValue")? },
  ))
}

fn create_promise(env: &Env) -> Result<(sys::napi_deferred, Object<'_>)> {
  let mut deferred = ptr::null_mut();
  let mut promise = ptr::null_mut();
  // SAFETY: called on the JS thread with a live env.
  napi::check_status!(unsafe { sys::napi_create_promise(env.raw(), &mut deferred, &mut promise) })?;
  Ok((deferred, Object::from_raw(env.raw(), promise)))
}

/// Resolves with the result JSON, or rejects with an `Error` whose message is the error JSON.
fn settle(env: &Env, deferred: sys::napi_deferred, result: std::result::Result<String, String>) {
  // SAFETY: JS thread, live env; `deferred` comes from `napi_create_promise` and is settled once.
  unsafe {
    match result {
      Ok(text) => match String::to_napi_value(env.raw(), text) {
        Ok(value) => {
          sys::napi_resolve_deferred(env.raw(), deferred, value);
        }
        Err(error) => reject(env, deferred, error),
      },
      Err(json) => reject(env, deferred, napi::Error::new(napi::Status::GenericFailure, json)),
    }
  }
}

unsafe fn reject(env: &Env, deferred: sys::napi_deferred, error: napi::Error) {
  let value = match env.create_error(error) {
    Ok(object) => object.raw(),
    Err(_) => {
      let mut undefined = ptr::null_mut();
      // SAFETY: JS thread, live env.
      unsafe { sys::napi_get_undefined(env.raw(), &mut undefined) };
      undefined
    }
  };
  // SAFETY: see `settle`.
  unsafe { sys::napi_reject_deferred(env.raw(), deferred, value) };
}
