//! napi binding of the SQLite engine (`packages/engine-rs/ENGINE_CONTRACT.md`):
//!
//! ```ts
//! class SqliteEngine {
//!   static create(graphJson: string, optionsJson: string, callFunction: (id: number, argJson: string) => string): SqliteEngine
//!   rawSchema(): string
//!   setLiveSchema(descriptionJson: string): void
//!   attachClient(clientId: number): void
//!   call(method: string, argsJson: string, connId: number, contextJson?: string): Promise<string>
//! }
//! ```
//!
//! `call` runs the method statement by statement ([`payload_sql_engine::stepped`]): the first step
//! runs synchronously inside `call` (like the synchronous start of the TS method), every later
//! step from a microtask (`queueMicrotask`), and the promise is settled from the step that
//! finishes. Each statement runs on the ordered `payload-sqlite` queue of `connId` (the adapter's
//! client or the active transaction), on that connection, while the JS thread waits, like the
//! synchronous statements of the `libsql` binding; concurrent calls therefore interleave at
//! statement granularity in await order instead of running as one atomic job each. Errors reject
//! with an `Error` whose message is the JSON of the engine error.

use std::cell::Cell;
use std::ptr;
use std::rc::Rc;
use std::sync::Arc;

use napi::bindgen_prelude::{FnArgs, Function, FunctionRef, Object, ToNapiValue};
use napi::{Env, JsValue, Result, sys};
use napi_derive::napi;
use payload_engine::error::EngineError;
use payload_engine::host::Host;
use payload_engine::js::{JsVal, decode_graph};
use payload_sql_engine::SqliteEngine as Engine;
use payload_sql_engine::stepped::{Step, SteppedCall};
use payload_sqlite::worker;
use serde_json::Value as Json;

type CallbackRef = FunctionRef<FnArgs<(u32, String)>, String>;

/// Engine errors reject with an `Error` whose message is the boundary JSON
/// ([`payload_sql_engine::error_json`]).
fn to_napi_error(error: EngineError) -> napi::Error {
  napi::Error::new(napi::Status::GenericFailure, payload_sql_engine::error_json(&error).to_string())
}

/// Calls registered JS functions through `callFunction(id, argJson)`, which returns the result
/// encoded with `serializeForEngine` (or `{ $hostError }` when the function threw).
struct CallbackHost<'a, 'env> {
  callback: &'a Function<'env, FnArgs<(u32, String)>, String>,
}

impl Host for CallbackHost<'_, '_> {
  fn call(&self, id: u32, arg: &Json) -> payload_engine::error::Result<JsVal> {
    let result = self
      .callback
      .call((id, arg.to_string()).into())
      .map_err(|e| EngineError::new("HostError", e.reason.clone()))?;
    let graph: Json = serde_json::from_str(&result)
      .map_err(|e| EngineError::internal(format!("invalid host function result: {e}")))?;
    if graph.get("$hostError").is_some() {
      return Err(EngineError::new("HostError", format!("JS function {id} threw")));
    }
    decode_graph(&graph)
  }
}

fn parse_json(input: &str, what: &str) -> std::result::Result<Json, EngineError> {
  serde_json::from_str(input).map_err(|e| EngineError::internal(format!("invalid {what} JSON: {e}")))
}

/// `PAYLOAD_RS_ENGINE_ATOMIC=true` (read once): run every call as one atomic queue job, the
/// pre-stepping behaviour (diagnostics and timing comparisons only).
static ATOMIC_CALLS: std::sync::LazyLock<bool> =
  std::sync::LazyLock::new(|| std::env::var("PAYLOAD_RS_ENGINE_ATOMIC").is_ok_and(|v| v == "true"));

thread_local! {
  /// Set while the JS thread waits for a step: a JS function called by the step must not start
  /// another engine call (its first statement would wait for the connection the step holds).
  static IN_STEP: Cell<bool> = const { Cell::new(false) };
}

#[napi(js_name = "SqliteEngine")]
pub struct SqliteEngineJs {
  engine: Arc<Engine>,
  client_id: Option<u32>,
  callback: Rc<CallbackRef>,
}

#[napi]
impl SqliteEngineJs {
  /// Decodes the graph once and builds the raw schema; both live as long as the engine.
  #[napi(factory)]
  pub fn create(
    graph_json: String,
    options_json: String,
    call_function: Function<FnArgs<(u32, String)>, String>,
  ) -> Result<Self> {
    let host = CallbackHost { callback: &call_function };
    let engine = parse_json(&graph_json, "graph")
      .and_then(|graph| Ok((graph, parse_json(&options_json, "options")?)))
      .and_then(|(graph, options)| Engine::create(&host, &graph, &options))
      .map_err(to_napi_error)?;
    let callback = Rc::new(call_function.create_ref()?);
    Ok(Self { engine: Arc::new(engine), client_id: None, callback })
  }

  /// Same JSON as `buildRawSchema` (rawTables, rawRelations, tableNameMap, ...).
  #[napi]
  pub fn raw_schema(&self) -> String {
    self.engine.raw_schema_json().to_string()
  }

  /// The live schema after the schema hooks (`{ drizzle, rawTables? }`, see
  /// `SqliteEngine::set_live_schema`). Must be called before the first `call` (during `init`).
  #[napi]
  pub fn set_live_schema(&mut self, description_json: String) -> Result<()> {
    let description = parse_json(&description_json, "live schema").map_err(to_napi_error)?;
    let engine = Arc::get_mut(&mut self.engine).ok_or_else(|| {
      to_napi_error(EngineError::internal("setLiveSchema: engine calls are in progress"))
    })?;
    engine.set_live_schema(&description).map_err(to_napi_error)
  }

  /// Tells the engine which payload-sqlite client belongs to this adapter: `call` then rejects
  /// connection ids of another database file.
  #[napi]
  pub fn attach_client(&mut self, client_id: u32) {
    self.client_id = Some(client_id);
  }

  /// Runs one adapter method on `connId` (the client's or the active transaction's connection).
  /// `contextJson` (optional): the call context, `{ allowIDOnCreate, limitedBoundParameters,
  /// blocksAsJSON?, now, withMutations? }` (adapter properties read at call time, the caller's
  /// `Date.now()`, and whether the result is the `{ result, mutations }` envelope).
  #[napi(ts_return_type = "Promise<string>")]
  pub fn call<'env>(
    &self,
    env: &'env Env,
    method: String,
    args_json: String,
    conn_id: u32,
    context_json: Option<String>,
  ) -> Result<Object<'env>> {
    if *ATOMIC_CALLS {
      // diagnostic switch: the whole method as one job on the connection's queue
      let engine = Arc::clone(&self.engine);
      return crate::sqlite::queue_job(env, conn_id, move |session| {
        engine.call_json(&method, &args_json, context_json.as_deref(), session).map_err(to_napi_error)
      });
    }
    let (deferred, promise) = create_promise(env)?;
    let rejected = |error: EngineError| -> Result<Object<'env>> {
      settle(env, deferred, Err(error));
      Ok(promise)
    };
    if let Some(client) = self.client_id {
      if client != conn_id && !worker::same_queue(client, conn_id) {
        return rejected(EngineError::internal(format!(
          "connection {conn_id} does not belong to the adapter's client {client}"
        )));
      }
    }
    if IN_STEP.with(Cell::get) {
      return rejected(EngineError::internal(
        "payload-sql-engine: a JS function called during an engine statement cannot start another engine call",
      ));
    }
    let op = match SteppedCall::start(Arc::clone(&self.engine), method, args_json, context_json, conn_id) {
      Ok(op) => op,
      Err(error) => return rejected(error),
    };
    let pending = Rc::new(Pending { op, deferred: Cell::new(deferred), callback: Rc::clone(&self.callback) });
    drive(env, &pending);
    Ok(promise)
  }
}

/// An engine call whose promise is not settled yet.
struct Pending {
  op: SteppedCall,
  /// Null once settled.
  deferred: Cell<sys::napi_deferred>,
  callback: Rc<CallbackRef>,
}

/// Runs the next step of `pending`; schedules the one after it from a microtask, or settles the
/// promise when the call finished. Never throws into JS: failures reject the promise.
fn drive(env: &Env, pending: &Rc<Pending>) {
  let step = match pending.callback.borrow_back(env) {
    Ok(callback) => {
      let host = CallbackHost { callback: &callback };
      IN_STEP.with(|s| s.set(true));
      let step = pending.op.resume(&host);
      IN_STEP.with(|s| s.set(false));
      step
    }
    Err(error) => Step::Done(Err(EngineError::internal(format!("engine host callback is gone: {}", error.reason)))),
  };
  let result = match step {
    Step::Yielded => match queue_step(env, pending) {
      Ok(()) => return,
      // the call thread ends once `pending` (and with it the call) is dropped
      Err(error) => Err(EngineError::internal(format!("could not schedule the next engine step: {}", error.reason))),
    },
    Step::Done(result) => result,
  };
  let deferred = pending.deferred.replace(ptr::null_mut());
  if !deferred.is_null() {
    settle(env, deferred, result);
  }
}

/// Schedules `drive(pending)` as a microtask: `resolvedPromise.then(step)`, a native promise job
/// (one microtask, like `queueMicrotask`, but not replaceable by fake timers).
fn queue_step(env: &Env, pending: &Rc<Pending>) -> Result<()> {
  let next = Rc::clone(pending);
  let step = env.create_function_from_closure::<(), (), _>("payloadSqlEngineStep", move |ctx| {
    drive(ctx.env, &next);
    Ok(())
  })?;
  let (deferred, promise) = create_promise(env)?;
  let raw = env.raw();
  // SAFETY: JS thread, live env; `deferred` is settled once, right here; `then` is called with
  // the promise as `this` and one function argument.
  unsafe {
    let mut undefined = ptr::null_mut();
    napi::check_status!(sys::napi_get_undefined(raw, &mut undefined))?;
    napi::check_status!(sys::napi_resolve_deferred(raw, deferred, undefined))?;
    let mut then = ptr::null_mut();
    napi::check_status!(sys::napi_get_named_property(raw, promise.raw(), c"then".as_ptr(), &mut then))?;
    let args = [step.raw()];
    let mut result = ptr::null_mut();
    napi::check_status!(sys::napi_call_function(raw, promise.raw(), then, args.len(), args.as_ptr(), &mut result))?;
  }
  Ok(())
}

fn create_promise(env: &Env) -> Result<(sys::napi_deferred, Object<'_>)> {
  let mut deferred = ptr::null_mut();
  let mut promise = ptr::null_mut();
  // SAFETY: called on the JS thread with a live env.
  napi::check_status!(unsafe { sys::napi_create_promise(env.raw(), &mut deferred, &mut promise) })?;
  Ok((deferred, Object::from_raw(env.raw(), promise)))
}

/// Resolves (with the result string) or rejects (with an `Error` carrying the boundary JSON)
/// `deferred`, synchronously on the JS thread.
fn settle(env: &Env, deferred: sys::napi_deferred, result: std::result::Result<String, EngineError>) {
  // SAFETY: JS thread, live env; `deferred` comes from `napi_create_promise` and is settled once.
  unsafe {
    match result {
      Ok(text) => match String::to_napi_value(env.raw(), text) {
        Ok(value) => {
          sys::napi_resolve_deferred(env.raw(), deferred, value);
        }
        Err(error) => reject(env, deferred, error),
      },
      Err(error) => reject(env, deferred, to_napi_error(error)),
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
