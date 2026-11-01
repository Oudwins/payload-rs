//! JS helpers of the operations, installed by the binding's `init(host)` (the core runtime's own
//! host must be installed first: `getCoreRuntime()` does that, and the query port's host:
//! `coreQueryBinding().init`). Helpers are looked up by name on the host object
//! (`packages/engine-rs/src/ops/host.ts`). They exist for:
//! - object literals and spreads handed to user code or to upstream utilities (same key order and
//!   evaluation order as the TS expression),
//! - destructuring patterns (exact defaults, getter order and V8 error messages),
//! - upstream utilities that are called, not ported (`getEntityPermissions`, `sanitizeSelect`,
//!   `replaceWithDraftIfAvailable`, `checkFileAccess`, error classes, ...),
//! - JS built-ins whose exact semantics matter (`Array.isArray`, `Array.prototype.map`,
//!   `for...of`, `for...in`, `new Date(v).getTime()`).

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
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
  /// The `DONE` sentinel the loop helpers (`forOf`, `forIn`) return when a loop ends.
  pub done: Persist,
  /// Deliberate deviation for harness sensitivity checks (`RS_OPS_MUTANT`, see
  /// RUST_OPS_DESIGN.md). Only compiled with the `mutants` feature.
  #[cfg(feature = "mutants")]
  pub mutant: u32,
}

thread_local! {
  static HOST: RefCell<Option<Rc<Host>>> = const { RefCell::new(None) };
}

pub fn install(obj: Local) -> JsResult<()> {
  let after_read = js::get_named(obj, "afterRead")?;
  let after_read =
    if js::type_of(after_read) == Type::Function { Some(Persist::new(after_read)?) } else { None };
  let done = Persist::new(js::get_named(obj, "DONE")?)?;
  let mutant = js::get_named(obj, "mutant")?;
  let mutant = if js::type_of(mutant) == Type::Number { js::get_f64(mutant) as u32 } else { 0 };
  #[cfg(not(feature = "mutants"))]
  if mutant != 0 {
    return Err(js::engine_error("core ops: `mutant` needs an addon built with the `payload-core-ops/mutants` feature"));
  }
  let host = Host {
    obj: Persist::new(obj)?,
    after_read,
    done,
    #[cfg(feature = "mutants")]
    mutant,
  };
  HOST.with(|h| *h.borrow_mut() = Some(Rc::new(host)));
  Ok(())
}

pub fn host() -> JsResult<Rc<Host>> {
  HOST
    .with(|h| h.borrow().clone())
    .ok_or_else(|| js::engine_error("core ops binding not initialized"))
}

/// Whether the harness selected mutant `n` (always false without the `mutants` feature).
#[cfg(feature = "mutants")]
pub fn mutant(n: u32) -> bool {
  host().map(|h| h.mutant == n).unwrap_or(false)
}

#[cfg(not(feature = "mutants"))]
#[inline(always)]
pub fn mutant(_n: u32) -> bool {
  false
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

/// `typeof v === 'string'`
pub fn is_string(v: Local) -> bool {
  js::type_of(v) == Type::String
}

/// `Array.isArray(v)`: also true for proxies of arrays (`napi_is_array` is not), and throws for
/// revoked proxies, like the built-in.
pub fn is_array(v: Local) -> JsResult<bool> {
  if js::is_array(v) {
    return Ok(true);
  }
  if js::type_of(v) != Type::Object {
    return Ok(false);
  }
  Ok(js::truthy(call("isArray", &[v])?))
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

/// A JS string from UTF-16 code units.
pub fn string_utf16(units: &[u16]) -> Local {
  let mut v = ptr::null_mut();
  unsafe { sys::napi_create_string_utf16(js::env(), units.as_ptr(), units.len() as isize, &mut v) };
  Local(v)
}

// ---------------------------------------------------------------------------------------------
// loops

/// The value `for (const x of v)` iterates, for callers that loop by index: plain arrays as they
/// are, anything else collected by `[...v]` up front. Prefer [`ForOf`] (lazy, exact for proxies
/// and iterables); kept for the write / global operation crates.
pub fn iterable(v: Local) -> JsResult<Val> {
  if js::is_array(v) { Val::from_local(v) } else { call_val("spreadIterable", &[v]) }
}

/// Element `i` of an array being iterated by index (`undefined` past the end).
pub fn element(arr: Local, i: u32) -> JsResult<Local> {
  js::get_element(arr, i)
}

/// A `for (const x of v)` loop. Plain arrays are iterated by index with a live length (what the
/// default array iterator does); anything else (proxies of arrays, iterables) through a host
/// generator that contains the loop itself (`forOf`), so the iterator protocol, proxy traps and
/// errors are V8's. Keeps only [`Val`]s, so it survives the loop body's awaits.
pub enum ForOf {
  Array { arr: Val, index: u32 },
  Iter(Val),
}

impl ForOf {
  /// `for (const x of v)` (a non-iterable `v` throws `v is not iterable`; see [`ForOf::of`]).
  pub fn new(v: Local) -> JsResult<ForOf> {
    Self::start(v, js::undefined())
  }

  /// `for (const x of <expr>)` over `v`: `expr` is the TS source text, for V8's
  /// `<expr> is not iterable`.
  pub fn of(v: Local, expr: &str) -> JsResult<ForOf> {
    Self::start(v, js::string(expr))
  }

  fn start(v: Local, expr: Local) -> JsResult<ForOf> {
    if js::is_array(v) {
      return Ok(ForOf::Array { arr: Val::from_local(v)?, index: 0 });
    }
    Ok(ForOf::Iter(call_val("forOf", &[v, expr])?))
  }

  /// The next item, or `None` when the loop is done.
  pub fn next(&mut self) -> JsResult<Option<Local>> {
    match self {
      ForOf::Array { arr, index } => {
        if *index >= js::array_length(arr.get()) {
          return Ok(None);
        }
        let item = js::get_element(arr.get(), *index)?;
        *index += 1;
        Ok(Some(item))
      }
      ForOf::Iter(generator) => next_of(generator),
    }
  }

  /// The loop body completed abruptly (a throw): `IteratorClose` of the iterator (calls its
  /// `return`, errors of that call are ignored like for a throw completion).
  pub fn close(&self) {
    if let ForOf::Iter(generator) = self {
      let _ = call("closeLoop", &[generator.get()]);
    }
  }
}

/// A `for (const key in o)` loop through the host generator `forIn` (V8's key snapshot and
/// deletion checks).
pub struct ForIn(Val);

impl ForIn {
  pub fn new(o: Local) -> JsResult<ForIn> {
    Ok(ForIn(call_val("forIn", &[o])?))
  }

  pub fn next(&self) -> JsResult<Option<Local>> {
    next_of(&self.0)
  }
}

fn next_of(generator: &Val) -> JsResult<Option<Local>> {
  let item = call("next", &[generator.get()])?;
  Ok((!js::strict_equals(item, host()?.done.get())).then_some(item))
}

/// Runs a loop body, closing the loop when it throws.
pub async fn loop_body<F: Future<Output = JsResult<()>>>(l: &ForOf, body: F) -> JsResult<()> {
  let r = body.await;
  if r.is_err() {
    l.close();
  }
  r
}

// ---------------------------------------------------------------------------------------------
// Array.prototype.map

type MapFn = dyn FnMut(Local) -> JsResult<Local>;

struct MapEntry {
  id: usize,
  f: *mut MapFn,
  busy: bool,
}

thread_local! {
  static MAPS: RefCell<Vec<MapEntry>> = const { RefCell::new(Vec::new()) };
  static NEXT_MAP_ID: Cell<usize> = const { Cell::new(1) };
}

struct MapGuard(usize);

impl Drop for MapGuard {
  fn drop(&mut self) {
    MAPS.with(|m| m.borrow_mut().retain(|e| e.id != self.0));
  }
}

/// `array.map(callback)` evaluated as the TS expression `<expr>.map(...)`: `map` is read from the
/// value and called with a native callback that runs `f` for each element, so proxies, patched
/// `map` / `Symbol.species`, holes and V8's errors for a missing `map` are exactly upstream's.
/// `f` runs synchronously inside the `map` call (an `async` arrow is a spawned task whose
/// synchronous prefix runs there).
pub fn map_array(array: Local, expr: &str, f: impl FnMut(Local) -> JsResult<Local>) -> JsResult<Local> {
  with_callback("mapWith", &[array, js::string(expr)], f)
}

/// Calls the host helper `name` with `args` plus a native callback (last argument) that runs `f`
/// with its first argument, e.g. `filterWith: (array, callback) => array.filter(callback)`: the
/// built-in drives the loop, `f` is the arrow's body. `f` may only be called while the helper
/// runs.
pub fn with_callback(name: &str, args: &[Local], mut f: impl FnMut(Local) -> JsResult<Local>) -> JsResult<Local> {
  let id = NEXT_MAP_ID.with(|n| {
    let id = n.get();
    n.set(id.wrapping_add(1).max(1));
    id
  });
  let f: &mut (dyn FnMut(Local) -> JsResult<Local> + '_) = &mut f;
  // SAFETY: the entry is removed by `_guard` before `f` (declared earlier) is dropped; the
  // callback only dereferences entries that are still registered.
  let f: *mut MapFn =
    unsafe { std::mem::transmute::<&mut (dyn FnMut(Local) -> JsResult<Local> + '_), *mut MapFn>(f) };
  MAPS.with(|m| m.borrow_mut().push(MapEntry { id, f, busy: false }));
  let _guard = MapGuard(id);
  let callback = js::create_function("", map_callback, id as *mut c_void);
  let mut all = args.to_vec();
  all.push(callback);
  call(name, &all)
}

unsafe extern "C" fn map_callback(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
  js::set_env(env);
  let ([item], data) = js::callback_args::<1>(env, info);
  let id = data as usize;
  let entry = MAPS.with(|m| {
    let mut m = m.borrow_mut();
    let e = m.iter_mut().find(|e| e.id == id)?;
    if e.busy {
      return Some(Err(()));
    }
    e.busy = true;
    Some(Ok(e.f))
  });
  let result = match entry {
    None => Err(js::engine_error("core ops: a callback was called after the call it was passed to returned (unsupported)")),
    Some(Err(())) => Err(js::engine_error("core ops: a callback was called re-entrantly (unsupported)")),
    Some(Ok(f)) => {
      // SAFETY: registered entries point to a live closure (see `map_array`); `busy` prevents a
      // second mutable borrow.
      let r = catch_unwind(AssertUnwindSafe(|| unsafe { (*f)(item) }));
      MAPS.with(|m| {
        if let Some(e) = m.borrow_mut().iter_mut().find(|e| e.id == id) {
          e.busy = false;
        }
      });
      r.unwrap_or_else(|_| Err(js::engine_error("payload core operations panicked")))
    }
  };
  match result {
    Ok(v) => v.0,
    Err(Thrown(e)) => {
      js::throw(e.get());
      ptr::null_mut()
    }
  }
}
