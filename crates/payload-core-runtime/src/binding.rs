//! The JS-facing binding object. `payload-node` (and the `dev_addon` example) expose it as
//! `coreRuntimeBinding()`; `packages/engine-rs/src/runtime` wraps it.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use napi::sys;

use crate::js::{self, JsResult, Local, Thrown};
use crate::{after_read, bench, executor, host, probes};

type Body<const N: usize> = fn([Local; N]) -> JsResult<Local>;

/// Runs an exported function body: sets the env, converts `Err(Thrown)` into a JS throw and
/// never lets a panic cross the FFI boundary.
fn run<const N: usize>(
  env: sys::napi_env,
  info: sys::napi_callback_info,
  body: Body<N>,
) -> sys::napi_value {
  js::set_env(env);
  let (args, _) = js::callback_args::<N>(env, info);
  match catch_unwind(AssertUnwindSafe(|| body(args))) {
    Ok(Ok(v)) => v.0,
    Ok(Err(Thrown(e))) => {
      js::throw(e.get());
      ptr::null_mut()
    }
    Err(_) => {
      let Thrown(e) = js::engine_error("payload core runtime panicked");
      js::throw(e.get());
      ptr::null_mut()
    }
  }
}

macro_rules! export {
  ($name:ident, $n:literal, $body:expr) => {
    unsafe extern "C" fn $name(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
      run::<$n>(env, info, $body)
    }
  };
}

fn u32_arg(v: Local) -> u32 {
  js::get_f64(v) as u32
}

export!(init, 1, |[host_obj]| {
  host::install(host_obj)?;
  Ok(js::undefined())
});

export!(resume, 3, |[token, ok, value]| {
  executor::resume(u32_arg(token), js::get_bool(ok), value)?;
  Ok(js::undefined())
});

export!(after_read_export, 1, |[args]| after_read::after_read(args));

export!(after_read_traverse_fields_export, 1, |[destructured]| {
  after_read::traverse_fields_entry(destructured)?;
  Ok(js::undefined())
});

export!(stats, 0, |[]| {
  // `stats` calls are not engine work
  executor::uncount_entry();
  let (tasks, awaits) = executor::stats();
  let o = js::object();
  js::set_named(o, "tasks", js::number(tasks as f64))?;
  js::set_named(o, "awaits", js::number(awaits as f64))?;
  js::set_named(o, "entries", js::number(executor::entries() as f64))?;
  Ok(o)
});

export!(noop, 0, |[]| Ok(js::undefined()));

export!(probe_await_once, 1, |[v]| probes::await_once(v));
export!(probe_await_n, 2, |[v, n]| probes::await_n(v, u32_arg(n)));
export!(probe_await_tail, 2, |[p, v]| probes::await_tail(p, v));
export!(probe_del, 2, |[o, k]| {
  host::del(o, k)?;
  Ok(js::undefined())
});
export!(probe_set, 3, |[o, k, v]| {
  host::set(o, k, v)?;
  Ok(js::undefined())
});
export!(probe_literal, 2, |[k, v]| {
  let name = js::get_string(k).unwrap_or_default();
  js::object_literal(&[(name.as_str(), v), ("after", js::number(1.0))])
});
export!(probe_array_literal, 2, |[a, b]| js::array_literal(&[a, b]));
export!(probe_call_fn, 2, |[f, expr]| {
  let expr = js::get_string(expr).unwrap_or_default();
  host::call_fn(f, js::undefined(), &[], &expr)
});
export!(probe_object_keys, 1, |[o]| host::object_keys(o));
export!(probe_has, 2, |[o, k]| Ok(js::boolean(host::has(o, k)?)));
export!(probe_is_array, 1, |[v]| Ok(js::boolean(host::array_is_array(v)?)));
export!(probe_push, 2, |[arr, v]| host::push(arr, v, "arr.push"));
export!(probe_closure, 2, |[f, counter]| probes::closure_probe(f, counter));
export!(probe_arrow, 1, |[n]| probes::arrow_probe(u32_arg(n)));
export!(probe_counted_closure, 0, |[]| probes::counted_closure());
export!(probe_live_closures, 0, |[]| Ok(js::number(probes::live_closures() as f64)));
export!(probe_nest, 2, |[n, leaf]| probes::nest(u32_arg(n), leaf));
export!(probe_nest_call, 2, |[n, leaf]| probes::nest_call(u32_arg(n), leaf));

export!(bench_call_js, 2, |[f, n]| Ok(js::number(bench::call_js(f, u32_arg(n))?)));
export!(bench_get_property, 3, |[o, k, n]| {
  Ok(js::number(bench::get_property(o, k, u32_arg(n))?))
});
export!(bench_set_property, 3, |[o, k, n]| {
  Ok(js::number(bench::set_property(o, k, u32_arg(n))?))
});
export!(bench_persist, 2, |[o, n]| Ok(js::number(bench::persist(o, u32_arg(n))?)));
export!(bench_sequential_awaits, 2, |[v, n]| bench::sequential_awaits(v, u32_arg(n)));
export!(bench_spawn_sync_tasks, 1, |[n]| Ok(js::number(bench::spawn_sync_tasks(u32_arg(n))?)));
export!(bench_json_round_trip, 1, |[s]| bench::json_round_trip(s));
export!(bench_tsfn, 2, |[f, n]| {
  bench::tsfn_round_trips(f, u32_arg(n))?;
  Ok(js::undefined())
});

thread_local! {
  static PROXY_DOC: std::cell::RefCell<serde_json::Value> = const { std::cell::RefCell::new(serde_json::Value::Null) };
}

export!(bench_proxy_load, 1, |[s]| {
  let text = js::get_string(s).unwrap_or_default();
  let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| js::engine_error(&e.to_string()))?;
  PROXY_DOC.with(|d| *d.borrow_mut() = v);
  Ok(js::undefined())
});

export!(bench_proxy_get, 1, |[k]| {
  let key = js::get_string(k).unwrap_or_default();
  Ok(PROXY_DOC.with(|d| bench::proxy_get(&d.borrow(), &key)))
});

// Probes Node-API behaviour the runtime depends on (see RUST_CORE_DESIGN.md).
export!(probe, 2, |[value, frozen]| {
  let out = js::object();
  // napi_create_reference on primitives (strings, symbols, bigints)
  let ok = js::Persist::new(value).is_ok();
  js::set_named(out, "refOk", js::boolean(ok))?;
  // napi_set_property / napi_delete_property on a frozen object
  let key = js::string("x");
  let set = js::set_property(frozen, key, js::number(1.0));
  js::set_named(out, "setFrozenOk", js::boolean(set.is_ok()))?;
  if let Err(Thrown(e)) = set {
    js::set_named(out, "setFrozenError", e.get())?;
  }
  let del = js::delete_property(frozen, js::string("y"));
  match del {
    Ok(b) => js::set_named(out, "deleteFrozenResult", js::boolean(b))?,
    Err(Thrown(e)) => js::set_named(out, "deleteFrozenError", e.get())?,
  }
  Ok(out)
});

/// Version of the host-helper contract between the core runtime family (this crate and the field
/// hook crates built into the same addon: payload-core-hooks-validate, -change, -after) and
/// `packages/engine-rs/src/runtime`, which checks it at load.
pub const API_VERSION: u32 = 2;

/// Builds the binding object.
pub fn create() -> JsResult<Local> {
  let o = js::object();
  macro_rules! add {
    ($js:literal, $f:ident) => {
      js::set_named(o, $js, js::create_function($js, $f, ptr::null_mut()))?;
    };
  }
  add!("init", init);
  add!("resume", resume);
  // `awaitValue(value, token)`: the native-await helper every JS-side `await f(...)` host helper
  // must use (executor::install_native_await); `thenReturn` likewise.
  let helpers = executor::install_native_await(js::get_named(o, "resume")?)?;
  js::define_named(o, "awaitValue", js::get_element(helpers, 0)?)?;
  js::define_named(o, "thenReturn", js::get_element(helpers, 1)?)?;
  add!("afterRead", after_read_export);
  add!("afterReadTraverseFields", after_read_traverse_fields_export);
  add!("stats", stats);
  add!("noop", noop);
  add!("probe", probe);
  let probes = js::object();
  macro_rules! probe {
    ($js:literal, $f:ident) => {
      js::set_named(probes, $js, js::create_function($js, $f, ptr::null_mut()))?;
    };
  }
  probe!("awaitOnce", probe_await_once);
  probe!("awaitN", probe_await_n);
  probe!("awaitTail", probe_await_tail);
  probe!("del", probe_del);
  probe!("set", probe_set);
  probe!("literal", probe_literal);
  probe!("arrayLiteral", probe_array_literal);
  probe!("callFn", probe_call_fn);
  probe!("objectKeys", probe_object_keys);
  probe!("has", probe_has);
  probe!("isArray", probe_is_array);
  probe!("push", probe_push);
  probe!("closure", probe_closure);
  probe!("arrow", probe_arrow);
  probe!("countedClosure", probe_counted_closure);
  probe!("liveClosures", probe_live_closures);
  probe!("nest", probe_nest);
  probe!("nestCall", probe_nest_call);
  js::set_named(o, "probes", probes)?;
  add!("benchCallJs", bench_call_js);
  add!("benchGetProperty", bench_get_property);
  add!("benchSetProperty", bench_set_property);
  add!("benchPersist", bench_persist);
  add!("benchSequentialAwaits", bench_sequential_awaits);
  add!("benchSpawnSyncTasks", bench_spawn_sync_tasks);
  add!("benchJsonRoundTrip", bench_json_round_trip);
  add!("benchTsfn", bench_tsfn);
  add!("benchProxyLoad", bench_proxy_load);
  add!("benchProxyGet", bench_proxy_get);
  js::set_named(o, "apiVersion", js::number(f64::from(API_VERSION)))?;
  Ok(o)
}

/// Entry for addons: `env` is the env of the current napi call.
///
/// # Safety
/// Must be called on the JS thread from inside a napi callback.
pub unsafe fn create_binding(env: sys::napi_env) -> sys::napi_value {
  js::set_env(env);
  js::register_env_cleanup(env);
  match create() {
    Ok(v) => v.0,
    Err(Thrown(e)) => {
      js::throw(e.get());
      ptr::null_mut()
    }
  }
}
