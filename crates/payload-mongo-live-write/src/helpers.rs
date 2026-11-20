//! The JS helpers of `helpers.js`: compiled with `napi_run_script` the first time a method runs in
//! an env and kept for the life of the thread. They need nothing from the host (each one is a single
//! upstream expression over its arguments).

use std::cell::RefCell;
use std::ptr;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Persist, Type, Val};

const SOURCE: &str = include_str!("helpers.js");

thread_local! {
  static HELPERS: RefCell<Option<Persist>> = const { RefCell::new(None) };
}

fn helpers() -> JsResult<Local> {
  if let Some(h) = HELPERS.with(|h| h.borrow().as_ref().map(Persist::get)) {
    return Ok(h);
  }
  let source = js::string(SOURCE);
  let mut out = ptr::null_mut();
  js::check(unsafe { sys::napi_run_script(js::env(), source.0, &mut out) })?;
  let object = Local(out);
  if js::type_of(object) != Type::Object {
    return Err(js::engine_error("mongo live write helpers did not evaluate to an object"));
  }
  let persisted = Persist::new(object)?;
  HELPERS.with(|h| *h.borrow_mut() = Some(persisted));
  Ok(object)
}

/// Compiles the helpers now (binding `init`), so a syntax error shows up at load.
pub fn ensure() -> JsResult<()> {
  helpers().map(|_| ())
}

/// Calls helper `name` with `this === undefined`.
pub fn call(name: &str, args: &[Local]) -> JsResult<Local> {
  call_this(name, js::undefined(), args)
}

/// Calls helper `name` with `this` (the helpers that evaluate `this.payload...` / `this.updateOne`).
pub fn call_this(name: &str, this: Local, args: &[Local]) -> JsResult<Local> {
  let f = js::get_named(helpers()?, name)?;
  if js::type_of(f) != Type::Function {
    return Err(js::engine_error(&format!("mongo live write helper `{name}` is missing")));
  }
  js::call(f, this, args)
}

/// [`call`], keeping the result across awaits.
pub fn call_val(name: &str, args: &[Local]) -> JsResult<Val> {
  Val::from_local(call(name, args)?)
}
