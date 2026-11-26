//! JS helpers of the global and auth operations, installed by the binding's `init(host)`
//! (`packages/engine-rs/src/ops-global/host.ts`). The core runtime's host and the collection
//! operations' host (payload-core-ops: `executeAccess`, `buildBeforeOperation`,
//! `buildAfterOperation`, `notAFunction`, ...) must be installed first: `getOpsGlobal()` does
//! that through `getCoreOps()`.
//!
//! Helpers exist for the same reasons as in payload-core-ops: object literals handed to user code
//! or upstream utilities (key order, property-read order), destructuring patterns (defaults,
//! getter order, V8 messages), upstream utilities that are called rather than ported (crypto,
//! JWT, cookies, email, query/select utilities, error classes) and synchronous segments without
//! user callbacks.

use std::cell::RefCell;

use payload_core_runtime::js::{self, JsResult, Local, Persist, Thrown, Type, Val};

pub use payload_core_ops::host::{
  ForOf, call_fn, get, get_val, is_false, is_nullish, is_typeof_object, loop_body, map_array, opt, promise_all, set,
  thrown, val,
};

type HelperCache = std::collections::HashMap<String, Persist, std::hash::BuildHasherDefault<js::FnvHasher>>;

thread_local! {
  static HOST: RefCell<Option<Persist>> = const { RefCell::new(None) };
  /// Helpers already looked up by [`call`] (the host object is engine-internal and never changes).
  static HELPERS: RefCell<HelperCache> = RefCell::new(HelperCache::default());
}

pub fn install(obj: Local) -> JsResult<()> {
  let host = Persist::new(obj)?;
  HOST.with(|h| *h.borrow_mut() = Some(host));
  HELPERS.with(|c| c.borrow_mut().clear());
  Ok(())
}

/// Calls the host helper `name` with `this === undefined`.
pub fn call(name: &str, args: &[Local]) -> JsResult<Local> {
  if let Some(f) = HELPERS.with(|c| c.borrow().get(name).map(Persist::get)) {
    return js::call_unguarded(f, js::undefined(), args);
  }
  let f = HOST.with(|h| match h.borrow().as_ref() {
    Some(host) => js::get_named(host.get(), name),
    None => Err(js::engine_error("core global/auth operations binding not initialized")),
  })?;
  if js::type_of(f) != Type::Function {
    return Err(js::engine_error(&format!("core global/auth operations host helper `{name}` is missing")));
  }
  let persisted = Persist::new(f)?;
  HELPERS.with(|c| c.borrow_mut().insert(name.to_string(), persisted));
  js::call_unguarded(f, js::undefined(), args)
}

/// Calls the host helper `name` and keeps the result across awaits.
pub fn call_val(name: &str, args: &[Local]) -> JsResult<Val> {
  Val::from_local(call(name, args)?)
}

/// `throw <helper(args)>`: the helper builds the error (Payload error classes, TypeErrors).
pub fn throw_from(name: &str, args: &[Local]) -> Thrown {
  match call(name, args) {
    Ok(e) => thrown(e),
    Err(t) => t,
  }
}

/// The elements of an array a destructuring helper returned.
pub fn unpack<const N: usize>(arr: Local) -> JsResult<[Val; N]> {
  let mut out = Vec::with_capacity(N);
  for i in 0..N {
    out.push(Val::from_local(js::get_element(arr, i as u32)?)?);
  }
  out.try_into().map_err(|_| js::engine_error("core global/auth operations: unpack"))
}

/// `o.name` of a kept value.
pub fn g(o: &Val, name: &str) -> JsResult<Local> {
  get(o.get(), name)
}

/// `o.name` of a kept value, kept.
pub fn gv(o: &Val, name: &str) -> JsResult<Val> {
  get_val(o.get(), name)
}

/// `o.a.b...` of a kept value, kept.
pub fn path(o: &Val, names: &[&str]) -> JsResult<Val> {
  let mut v = o.get();
  for name in names {
    v = get(v, name)?;
  }
  val(v)
}

/// `!!v`
pub fn truthy(v: &Val) -> bool {
  js::truthy(v.get())
}

/// `v === true`
pub fn is_true(v: Local) -> bool {
  js::type_of(v) == Type::Boolean && js::get_bool(v)
}

/// `obj.name(...args)`: the method is read first, then the args are built, then it is called with
/// `this === obj`.
pub fn method(obj: Local, name: &str, expr: &str, args: impl FnOnce() -> JsResult<Local>) -> JsResult<Local> {
  let f = get(obj, name)?;
  let a = args()?;
  call_fn(f, obj, &[a], expr)
}
