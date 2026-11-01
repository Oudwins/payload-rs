//! JS helpers of the operations, installed by the binding's `init(host)` (the core runtime's own
//! host must be installed first: `getCoreRuntime()` does that). Helpers are looked up by name on
//! the host object (`packages/engine-rs/src/ops/host.ts`). They exist for:
//! - object literals handed to user code or to upstream utilities (same key order and
//!   evaluation order as the TS expression),
//! - destructuring patterns (exact defaults, getter order and V8 error messages),
//! - upstream utilities that are called, not ported (query/select/join utilities, error classes,
//!   `replaceWithDraftIfAvailable`, `checkFileAccess`, ...),
//! - synchronous segments without user callbacks (`Array#map` spreads, lock-status filtering).

use std::cell::RefCell;
use std::ptr;
use std::rc::Rc;

use napi::sys;
use payload_core_runtime::host as rt;
use payload_core_runtime::js::{self, JsResult, Local, Persist, Thrown, Type, Val};

pub struct Host {
  pub obj: Persist,
  /// `afterRead` to call instead of the Rust port (`PAYLOAD_OPS_AFTER_READ=ts`): isolates the
  /// operations from the traversal in differential runs.
  pub after_read: Option<Persist>,
  /// Deliberate deviation for harness sensitivity checks (`RS_OPS_MUTANT`, see
  /// RUST_OPS_DESIGN.md); 0 in normal use.
  pub mutant: u32,
}

thread_local! {
  static HOST: RefCell<Option<Rc<Host>>> = const { RefCell::new(None) };
}

pub fn install(obj: Local) -> JsResult<()> {
  let after_read = js::get_named(obj, "afterRead")?;
  let after_read =
    if js::type_of(after_read) == Type::Function { Some(Persist::new(after_read)?) } else { None };
  let mutant = js::get_named(obj, "mutant")?;
  let mutant = if js::type_of(mutant) == Type::Number { js::get_f64(mutant) as u32 } else { 0 };
  let host = Host { obj: Persist::new(obj)?, after_read, mutant };
  HOST.with(|h| *h.borrow_mut() = Some(Rc::new(host)));
  Ok(())
}

pub fn host() -> JsResult<Rc<Host>> {
  HOST
    .with(|h| h.borrow().clone())
    .ok_or_else(|| js::engine_error("core ops binding not initialized"))
}

/// Whether the harness selected mutant `n` (never in normal use).
pub fn mutant(n: u32) -> bool {
  host().map(|h| h.mutant == n).unwrap_or(false)
}

/// Calls the host helper `name` with `this === undefined`.
pub fn call(name: &str, args: &[Local]) -> JsResult<Local> {
  let h = host()?;
  let f = js::get_named(h.obj.get(), name)?;
  if js::type_of(f) != Type::Function {
    return Err(js::engine_error(&format!("core ops host helper `{name}` is missing")));
  }
  js::call(f, js::undefined(), args)
}

/// Calls the host helper `name` and keeps the result across awaits.
pub fn call_val(name: &str, args: &[Local]) -> JsResult<Val> {
  Val::from_local(call(name, args)?)
}

pub fn val(v: Local) -> JsResult<Val> {
  Val::from_local(v)
}

/// `o.name` with JS semantics (TypeError on nullish, primitive wrappers).
pub fn get(o: Local, name: &str) -> JsResult<Local> {
  rt::get_named(o, name)
}

pub fn get_val(o: Local, name: &str) -> JsResult<Val> {
  Val::from_local(rt::get_named(o, name)?)
}

/// `o?.name`
pub fn opt(o: Local, name: &str) -> JsResult<Local> {
  rt::get_optional(o, js::key(name))
}

/// `o[k]` for any key value.
pub fn get_key(o: Local, k: Local) -> JsResult<Local> {
  rt::get(o, k)
}

/// `o.name = v` (strict mode).
pub fn set(o: Local, name: &str, v: Local) -> JsResult<()> {
  rt::set(o, js::key(name), v)
}

/// `name in o` (TypeError for primitives, like the `in` operator).
pub fn has(o: Local, name: &str) -> JsResult<bool> {
  if js::type_of(o).is_object_like() {
    js::has_property(o, js::key(name))
  } else {
    Ok(js::truthy(call("hasIn", &[o, js::string(name)])?))
  }
}

/// A JS value created by a helper, as a thrown error.
pub fn thrown(e: Local) -> Thrown {
  match Val::from_local(e) {
    Ok(v) => Thrown(v),
    Err(t) => t,
  }
}

/// `throw <helper(args)>`: the helper builds the error (Payload error classes, TypeErrors).
pub fn throw_from(name: &str, args: &[Local]) -> Thrown {
  match call(name, args) {
    Ok(e) => thrown(e),
    Err(t) => t,
  }
}

/// `v === false`
pub fn is_false(v: Local) -> bool {
  js::type_of(v) == Type::Boolean && !js::get_bool(v)
}

/// `v === undefined || v === null`
pub fn is_nullish(v: Local) -> bool {
  matches!(js::type_of(v), Type::Undefined | Type::Null)
}

/// `typeof v === 'object'` (true for `null`).
pub fn is_typeof_object(v: Local) -> bool {
  js::type_of(v).is_typeof_object()
}

/// `f(...args)` called as `expr(...)`: non-callables throw V8's `TypeError: <expr> is not a
/// function`.
pub fn call_fn(f: Local, this: Local, args: &[Local], expr: &str) -> JsResult<Local> {
  if js::type_of(f) == Type::Function {
    js::call(f, this, args)
  } else {
    Err(throw_from("notAFunction", &[js::string(expr)]))
  }
}

/// `afterRead(args)`: the Rust port, or the TS function the host supplied.
pub fn after_read(args: Local) -> JsResult<Local> {
  let h = host()?;
  match &h.after_read {
    Some(f) => js::call(f.get(), js::undefined(), &[args]),
    None => payload_core_runtime::after_read::after_read(args),
  }
}

/// `Promise.all(promises)`
pub fn promise_all(promises: Local) -> JsResult<Local> {
  rt::call_host(&rt::host()?.promise_all, &[promises])
}

/// The value `for (const x of v)` iterates: arrays as they are (iterated by index with a live
/// length, like the default array iterator), other iterables collected by `[...v]` (V8's error
/// for non-iterables).
pub fn iterable(v: Local) -> JsResult<Val> {
  if js::is_array(v) { Val::from_local(v) } else { call_val("spreadIterable", &[v]) }
}

/// Element `i` of an array being iterated (`undefined` past the end).
pub fn element(arr: Local, i: u32) -> JsResult<Local> {
  js::get_element(arr, i)
}

fn has_element(arr: Local, i: u32) -> JsResult<bool> {
  let mut r = false;
  js::check(unsafe { sys::napi_has_element(js::env(), arr.0, i, &mut r) })?;
  Ok(r)
}

/// `docs.map(f)` where `f` is an `async` arrow (spawned by the caller): returns the JS array of
/// the callback results. Holes are skipped and kept as holes, like `Array.prototype.map`.
/// `expr` is the source text of `docs` for V8's TypeError when it is not an array.
pub fn map_array(docs: Local, expr: &str, mut f: impl FnMut(Local) -> JsResult<Local>) -> JsResult<Local> {
  if !js::is_array(docs) {
    return Err(throw_from("mapGuard", &[docs, js::string(expr)]));
  }
  let len = js::array_length(docs);
  let out = js::array();
  for i in 0..len {
    if !has_element(docs, i)? {
      continue;
    }
    let item = js::get_element(docs, i)?;
    let mapped = f(item)?;
    js::set_element(out, i, mapped)?;
  }
  if js::array_length(out) != len {
    js::set_named(out, "length", js::number(f64::from(len)))?;
  }
  Ok(out)
}

/// `v instanceof Promise` (native promises only).
pub fn is_promise(v: Local) -> bool {
  let mut r = false;
  unsafe { sys::napi_is_promise(js::env(), v.0, &mut r) };
  r
}

/// A JS string from UTF-16 code units.
pub fn string_utf16(units: &[u16]) -> Local {
  let mut v = ptr::null_mut();
  unsafe { sys::napi_create_string_utf16(js::env(), units.as_ptr(), units.len() as isize, &mut v) };
  Local(v)
}
