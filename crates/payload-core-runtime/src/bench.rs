//! Micro-benchmarks used by RUST_CORE_DESIGN.md to compare interop strategies.
//! All timings are wall clock nanoseconds measured on the Rust side.

use std::ffi::c_void;
use std::ptr;
use std::sync::mpsc;
use std::time::Instant;

use napi::sys;

use crate::executor::{await_js, spawn};
use crate::js::{self, JsResult, Local, Val};

/// Rust → JS: calls `func()` `n` times synchronously.
pub fn call_js(func: Local, n: u32) -> JsResult<f64> {
  let start = Instant::now();
  let undef = js::undefined();
  for _ in 0..n {
    let scope = js::HandleScope::open();
    js::call(func, undef, &[])?;
    drop(scope);
  }
  Ok(start.elapsed().as_nanos() as f64)
}

/// `obj[key]` through napi, `n` times.
pub fn get_property(obj: Local, key: Local, n: u32) -> JsResult<f64> {
  let start = Instant::now();
  for _ in 0..n {
    let scope = js::HandleScope::open();
    js::get_property(obj, key)?;
    drop(scope);
  }
  Ok(start.elapsed().as_nanos() as f64)
}

/// `obj[key] = i` through napi, `n` times.
pub fn set_property(obj: Local, key: Local, n: u32) -> JsResult<f64> {
  let start = Instant::now();
  for i in 0..n {
    let scope = js::HandleScope::open();
    js::set_property(obj, key, js::number(i as f64))?;
    drop(scope);
  }
  Ok(start.elapsed().as_nanos() as f64)
}

/// Persistent reference create + read + delete, `n` times.
pub fn persist(obj: Local, n: u32) -> JsResult<f64> {
  let start = Instant::now();
  for _ in 0..n {
    let scope = js::HandleScope::open();
    let p = js::Persist::new(obj)?;
    p.get();
    drop(p);
    drop(scope);
  }
  Ok(start.elapsed().as_nanos() as f64)
}

/// Spawns one engine task that performs `n` sequential JS awaits of `value`.
/// Resolves with the elapsed nanoseconds.
pub fn sequential_awaits(value: Local, n: u32) -> JsResult<Local> {
  let value = Val::from_local(value)?;
  spawn(async move {
    let start = Instant::now();
    for _ in 0..n {
      await_js(value.get()).await?;
    }
    Ok(Val::Num(start.elapsed().as_nanos() as f64))
  })
}

/// Spawns `n` engine tasks that complete synchronously (the cost of one `promise()` per field).
pub fn spawn_sync_tasks(n: u32) -> JsResult<f64> {
  let start = Instant::now();
  let arr = js::array();
  for i in 0..n {
    let p = spawn(async { Ok(Val::Undefined) })?;
    js::set_element(arr, i, p)?;
  }
  Ok(start.elapsed().as_nanos() as f64)
}

/// serde_json parse + serialize of a document (strategy A sync-back cost, Rust half).
pub fn json_round_trip(text: Local) -> JsResult<Local> {
  let s = js::get_string(text).unwrap_or_default();
  let parsed: serde_json::Value =
    serde_json::from_str(&s).map_err(|e| js::engine_error(&e.to_string()))?;
  let out = serde_json::to_string(&parsed).map_err(|e| js::engine_error(&e.to_string()))?;
  Ok(js::string(&out))
}

/// Strategy C: a JS Proxy trap reading from a Rust-owned document. Returns `doc[key]` converted
/// to a JS value (only scalar values and nested objects as fresh handles).
pub fn proxy_get(doc: &serde_json::Value, key: &str) -> Local {
  match doc.get(key) {
    None | Some(serde_json::Value::Null) => js::undefined(),
    Some(serde_json::Value::Bool(b)) => js::boolean(*b),
    Some(serde_json::Value::Number(n)) => js::number(n.as_f64().unwrap_or(f64::NAN)),
    Some(serde_json::Value::String(s)) => js::string(s),
    Some(_) => js::object(),
  }
}

struct TsfnContext {
  func: sys::napi_ref,
}

struct TsfnMessage {
  /// `Some` = round trip request (signal when JS calls `done`), `None` = final result.
  done: Option<mpsc::SyncSender<()>>,
  elapsed_ns: f64,
}

unsafe extern "C" fn tsfn_call_js(
  env: sys::napi_env,
  _js_cb: sys::napi_value,
  context: *mut c_void,
  data: *mut c_void,
) {
  if env.is_null() {
    return;
  }
  js::set_env(env);
  let ctx = unsafe { &*(context as *const TsfnContext) };
  let msg = unsafe { Box::from_raw(data as *mut TsfnMessage) };
  let mut func = ptr::null_mut();
  unsafe { sys::napi_get_reference_value(env, ctx.func, &mut func) };
  let args = match msg.done {
    Some(sender) => {
      let data = Box::into_raw(Box::new(sender)) as *mut c_void;
      [js::create_function("done", tsfn_done, data), js::undefined()]
    }
    None => [js::null(), js::number(msg.elapsed_ns)],
  };
  let _ = js::call(Local(func), js::undefined(), &args);
}

unsafe extern "C" fn tsfn_done(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
  let (_, data) = js::callback_args::<0>(env, info);
  if !data.is_null() {
    // One-shot: the sender is dropped after signalling.
    let sender = unsafe { Box::from_raw(data as *mut mpsc::SyncSender<()>) };
    let _ = sender.send(());
  }
  ptr::null_mut()
}

/// Worker thread → JS → worker round trips through a ThreadsafeFunction, `n` times. `func` is
/// called as `func(done)` per round trip (it must call `done()`, synchronously or later) and
/// finally as `func(null, elapsedNs)`.
pub fn tsfn_round_trips(func: Local, n: u32) -> JsResult<()> {
  let env = js::env();
  let mut func_ref = ptr::null_mut();
  js::check(unsafe { sys::napi_create_reference(env, func.0, 1, &mut func_ref) })?;
  let context = Box::into_raw(Box::new(TsfnContext { func: func_ref })) as *mut c_void;
  let mut tsfn = ptr::null_mut();
  let name = js::string("payloadCoreRuntimeBench");
  js::check(unsafe {
    sys::napi_create_threadsafe_function(
      env,
      ptr::null_mut(),
      ptr::null_mut(),
      name.0,
      0,
      1,
      ptr::null_mut(),
      None,
      context,
      Some(tsfn_call_js),
      &mut tsfn,
    )
  })?;
  let tsfn_addr = tsfn as usize;
  std::thread::spawn(move || {
    let tsfn = tsfn_addr as sys::napi_threadsafe_function;
    let start = Instant::now();
    for _ in 0..n {
      let (tx, rx) = mpsc::sync_channel(1);
      let msg = Box::into_raw(Box::new(TsfnMessage { done: Some(tx), elapsed_ns: 0.0 }));
      unsafe {
        sys::napi_call_threadsafe_function(
          tsfn,
          msg as *mut c_void,
          sys::ThreadsafeFunctionCallMode::blocking,
        )
      };
      if rx.recv().is_err() {
        break;
      }
    }
    let elapsed_ns = start.elapsed().as_nanos() as f64;
    let msg = Box::into_raw(Box::new(TsfnMessage { done: None, elapsed_ns }));
    unsafe {
      sys::napi_call_threadsafe_function(
        tsfn,
        msg as *mut c_void,
        sys::ThreadsafeFunctionCallMode::blocking,
      );
      sys::napi_release_threadsafe_function(tsfn, sys::ThreadsafeFunctionReleaseMode::release);
    }
  });
  Ok(())
}
