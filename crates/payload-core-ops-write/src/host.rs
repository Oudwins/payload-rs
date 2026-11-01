//! JS helpers of the write operations, installed by the binding's `init(host)` (the core runtime's
//! host and the read operations' host must be installed first: `getCoreOpsWrite()` does that).
//! Helpers are looked up by name on the host object (`packages/engine-rs/src/ops-write/host.ts`).
//! They exist for the same reasons as the read operations' helpers (crates/payload-core-ops):
//! object literals handed to user code / upstream utilities (key and read order), destructuring
//! patterns, upstream utilities that are called rather than ported (uploads, versions, auth
//! crypto, locked documents, query utilities, error classes), and synchronous segments without
//! user callbacks.
//!
//! [`closure`] turns a Rust closure into a JS function (the operations' inner `async` arrows that
//! upstream utilities call back, e.g. `write` of `runCloudFileUpdate`).

use std::cell::RefCell;
use std::ffi::c_void;
use std::ptr;
use std::rc::Rc;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Persist, Thrown, Type, Val};

pub use payload_core_ops::host::{
  call_fn, element, get, get_key, get_val, has, is_false, is_nullish, is_typeof_object, iterable, map_array,
  opt, promise_all, set, thrown, val,
};

pub struct Host {
  pub obj: Persist,
  /// Field traversals to call instead of the Rust ports (`PAYLOAD_OPS_WRITE_TRAVERSALS=ts`):
  /// isolates the operations from the traversals in differential runs.
  pub traversals: Option<Persist>,
}

thread_local! {
  static HOST: RefCell<Option<Rc<Host>>> = const { RefCell::new(None) };
  static CALLS: RefCell<u64> = const { RefCell::new(0) };
}

pub fn install(obj: Local) -> JsResult<()> {
  let traversals = js::get_named(obj, "traversals")?;
  let traversals = if js::type_of(traversals) == Type::Object { Some(Persist::new(traversals)?) } else { None };
  let host = Host { obj: Persist::new(obj)?, traversals };
  HOST.with(|h| *h.borrow_mut() = Some(Rc::new(host)));
  Ok(())
}

pub fn host() -> JsResult<Rc<Host>> {
  HOST
    .with(|h| h.borrow().clone())
    .ok_or_else(|| js::engine_error("core write operations binding not initialized"))
}

/// Counts an operation served by this crate (`stats()` of the binding).
pub fn count_call() {
  CALLS.with(|c| *c.borrow_mut() += 1);
}

pub fn calls() -> u64 {
  CALLS.with(|c| *c.borrow())
}

/// Calls the host helper `name` with `this === undefined`.
pub fn call(name: &str, args: &[Local]) -> JsResult<Local> {
  let h = host()?;
  let f = js::get_named(h.obj.get(), name)?;
  if js::type_of(f) != Type::Function {
    return Err(js::engine_error(&format!("core write ops host helper `{name}` is missing")));
  }
  js::call(f, js::undefined(), args)
}

/// Calls the host helper `name` and keeps the result across awaits.
pub fn call_val(name: &str, args: &[Local]) -> JsResult<Val> {
  Val::from_local(call(name, args)?)
}

/// `throw <helper(args)>`: the helper builds the error (Payload error classes).
pub fn throw_from(name: &str, args: &[Local]) -> Thrown {
  match call(name, args) {
    Ok(e) => thrown(e),
    Err(t) => t,
  }
}

/// Element `i` of a helper's result array, kept across awaits.
pub fn at(arr: Local, i: u32) -> JsResult<Val> {
  Val::from_local(js::get_element(arr, i)?)
}

/// A field traversal (`beforeValidate`, `beforeChange`, `afterChange`, `afterRead`): the Rust port,
/// or the function the host supplied. Returns the traversal's promise.
pub fn traversal(name: &str, args: Local) -> JsResult<Local> {
  let h = host()?;
  if let Some(t) = &h.traversals {
    let f = js::get_named(t.get(), name)?;
    if js::type_of(f) == Type::Function {
      return js::call(f, js::undefined(), &[args]);
    }
  }
  match name {
    "beforeValidate" => payload_core_hooks_validate::before_validate::before_validate(args),
    "beforeChange" => payload_core_hooks_change::before_change::before_change(args),
    "afterChange" => payload_core_hooks_after::after_change::after_change(args),
    "afterRead" => payload_core_ops::host::after_read(args),
    _ => Err(js::engine_error(&format!("unknown traversal `{name}`"))),
  }
}

// ------------------------------------------------------------------------------------------------
// Rust closures as JS functions

type Closure = dyn Fn(&[Local]) -> JsResult<Local>;

const MAX_CLOSURE_ARGS: usize = 4;

unsafe extern "C" fn closure_trampoline(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
  js::set_env(env);
  let (args, data) = js::callback_args::<MAX_CLOSURE_ARGS>(env, info);
  if data.is_null() {
    return ptr::null_mut();
  }
  let f = unsafe { &*(data as *const Box<Closure>) };
  match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&args))) {
    Ok(Ok(v)) => v.0,
    Ok(Err(Thrown(e))) => {
      js::throw(e.get());
      ptr::null_mut()
    }
    Err(_) => {
      let Thrown(e) = js::engine_error("payload core write operations panicked");
      js::throw(e.get());
      ptr::null_mut()
    }
  }
}

unsafe extern "C" fn closure_finalize(_env: sys::napi_env, data: *mut c_void, _hint: *mut c_void) {
  if !data.is_null() {
    drop(unsafe { Box::from_raw(data as *mut Box<Closure>) });
  }
}

/// A JS function (`name`) that runs `f` with its (up to four) arguments. The closure is freed when
/// the function is garbage collected.
pub fn closure(name: &str, f: impl Fn(&[Local]) -> JsResult<Local> + 'static) -> JsResult<Local> {
  let boxed: Box<Box<Closure>> = Box::new(Box::new(f));
  let data = Box::into_raw(boxed) as *mut c_void;
  let func = js::create_function(name, closure_trampoline, data);
  let status = unsafe {
    sys::napi_add_finalizer(js::env(), func.0, data, Some(closure_finalize), ptr::null_mut(), ptr::null_mut())
  };
  if status != sys::Status::napi_ok {
    drop(unsafe { Box::from_raw(data as *mut Box<Closure>) });
    return Err(js::engine_error("could not create a closure function"));
  }
  Ok(func)
}

/// A shared mutable local of an operation (a `let` an inner arrow reassigns).
#[derive(Clone)]
pub struct Cell(Rc<RefCell<Val>>);

impl Cell {
  pub fn new(v: Val) -> Cell {
    Cell(Rc::new(RefCell::new(v)))
  }

  pub fn get(&self) -> Val {
    self.0.borrow().clone()
  }

  pub fn local(&self) -> Local {
    self.0.borrow().get()
  }

  pub fn set(&self, v: Val) {
    *self.0.borrow_mut() = v;
  }
}

/// `o[k] = v` for any key value (strict mode).
pub fn set_key(o: Local, k: Local, v: Local) -> JsResult<()> {
  payload_core_runtime::host::set(o, k, v)
}
