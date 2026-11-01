//! JS operations on live values with V8's semantics. Property reads go through the core
//! runtime's `host::get` (getters, proxies, prototype chain, V8's `TypeError`s on nullish
//! receivers); builtins whose results depend on V8 internals (`ToPrimitive`, `ToString`,
//! `Date.parse`, `JSON.stringify`, regexes, `bson-objectid`) are JS host helpers (see
//! `packages/engine-rs/src/validate/validations.ts`).

use std::cell::Cell;
use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use napi::sys;
use payload_core_runtime::host;
use payload_core_runtime::js::{self, JsResult, Local, Persist, Thrown, Type, Val, check};

use crate::vhost;

/// `o.key` / `o[key]` (`TypeError` on `undefined` / `null`, primitives boxed like JS).
pub fn get(o: Local, key: &str) -> JsResult<Local> {
  host::get_named(o, key)
}

/// `o[key]` with a computed key (`ToPropertyKey` by JS).
pub fn get_computed(o: Local, key: Local) -> JsResult<Local> {
  host::get(o, key)
}

/// `o?.key`
pub fn get_opt(o: Local, key: &str) -> JsResult<Local> {
  host::get_optional(o, js::key(key))
}

/// `o?.[key]`
pub fn get_opt_computed(o: Local, key: Local) -> JsResult<Local> {
  host::get_optional(o, key)
}

/// `o[index]`
pub fn get_index(o: Local, index: u32) -> JsResult<Local> {
  host::get(o, js::number(f64::from(index)))
}

/// `o[key] = value` (strict mode, `ToPropertyKey` after the right-hand side like V8).
pub fn set_computed(o: Local, key: Local, value: Local) -> JsResult<()> {
  host::set(o, key, value)
}

pub fn ty(v: Local) -> Type {
  js::type_of(v)
}

pub fn is_type(v: Local, t: Type) -> bool {
  js::type_of(v) == t
}

/// `typeof v === 'object'` (true for `null`).
pub fn is_typeof_object(v: Local) -> bool {
  js::type_of(v).is_typeof_object()
}

pub fn truthy(v: Local) -> bool {
  js::truthy(v)
}

pub fn is_nullish(v: Local) -> bool {
  matches!(js::type_of(v), Type::Undefined | Type::Null)
}

pub fn strict_eq(a: Local, b: Local) -> bool {
  js::strict_equals(a, b)
}

/// `v === 'literal'`
pub fn eq_str(v: Local, s: &str) -> bool {
  js::str_equals(v, s)
}

/// `v === n`
pub fn eq_num(v: Local, n: f64) -> bool {
  js::type_of(v) == Type::Number && js::get_f64(v) == n
}

/// `v === true`
pub fn is_true(v: Local) -> bool {
  js::type_of(v) == Type::Boolean && js::get_bool(v)
}

/// `v === false`
pub fn is_false(v: Local) -> bool {
  js::type_of(v) == Type::Boolean && !js::get_bool(v)
}

/// SameValueZero (`Map` keys).
pub fn same_value_zero(a: Local, b: Local) -> bool {
  if js::strict_equals(a, b) {
    return true;
  }
  js::type_of(a) == Type::Number && js::type_of(b) == Type::Number && js::get_f64(a).is_nan() && js::get_f64(b).is_nan()
}

/// `Array.isArray(v)` (true for proxies of arrays, which `napi_is_array` reports as false).
pub fn is_array(v: Local) -> JsResult<bool> {
  if js::is_array(v) {
    return Ok(true);
  }
  if js::type_of(v) != Type::Object {
    return Ok(false);
  }
  Ok(js::truthy(js::call(vhost()?.is_array.get(), js::undefined(), &[v])?))
}

/// `a < b`
pub fn lt(a: Local, b: Local) -> JsResult<bool> {
  if js::type_of(a) == Type::Number && js::type_of(b) == Type::Number {
    return Ok(js::get_f64(a) < js::get_f64(b));
  }
  Ok(js::truthy(js::call(vhost()?.lt.get(), js::undefined(), &[a, b])?))
}

/// `a > b`
pub fn gt(a: Local, b: Local) -> JsResult<bool> {
  if js::type_of(a) == Type::Number && js::type_of(b) == Type::Number {
    return Ok(js::get_f64(a) > js::get_f64(b));
  }
  Ok(js::truthy(js::call(vhost()?.gt.get(), js::undefined(), &[a, b])?))
}

/// `` `${v}` `` (template literal `ToString`: throws for symbols).
pub fn template(v: Local) -> JsResult<Local> {
  if js::type_of(v) == Type::String {
    return Ok(v);
  }
  js::call(vhost()?.template.get(), js::undefined(), &[v])
}

/// `String(v)`
pub fn string(v: Local) -> JsResult<Local> {
  if js::type_of(v) == Type::String {
    return Ok(v);
  }
  js::call(vhost()?.string.get(), js::undefined(), &[v])
}

/// `Number(v)` as a Rust number.
pub fn number(v: Local) -> JsResult<f64> {
  if js::type_of(v) == Type::Number {
    return Ok(js::get_f64(v));
  }
  Ok(js::get_f64(js::call(vhost()?.number.get(), js::undefined(), &[v])?))
}

/// `parseFloat(v)`
pub fn parse_float(v: Local) -> JsResult<Local> {
  js::call(vhost()?.parse_float.get(), js::undefined(), &[v])
}

/// `ObjectId.isValid(v)` (`bson-objectid`)
pub fn object_id_is_valid(v: Local) -> JsResult<bool> {
  Ok(js::truthy(js::call(vhost()?.object_id_is_valid.get(), js::undefined(), &[v])?))
}

/// `new ObjectId(v).toHexString()`
pub fn object_id_hex(v: Local) -> JsResult<Local> {
  js::call(vhost()?.object_id_hex.get(), js::undefined(), &[v])
}

/// `` `${a}${b}` `` for an engine string `b`.
pub fn concat(a: Local, b: &str) -> JsResult<Local> {
  let a = template(a)?;
  let mut units = js::get_string_utf16(a).unwrap_or_default();
  units.extend(b.encode_utf16());
  Ok(string_utf16(&units))
}

/// `` `${a}${b}` `` for an engine string `a`.
pub fn prefix(a: &str, b: Local) -> JsResult<Local> {
  let b = template(b)?;
  let mut units: Vec<u16> = a.encode_utf16().collect();
  units.extend(js::get_string_utf16(b).unwrap_or_default());
  Ok(string_utf16(&units))
}

fn string_utf16(units: &[u16]) -> Local {
  let mut v = ptr::null_mut();
  unsafe { sys::napi_create_string_utf16(js::env(), units.as_ptr(), units.len() as isize, &mut v) };
  Local(v)
}

/// A JS exception created by the engine with the realm's `TypeError` (V8's message text).
pub fn type_error(message: &str) -> Thrown {
  match vhost().and_then(|h| js::call(h.type_error.get(), js::undefined(), &[js::string(message)])) {
    Ok(e) => match Val::from_local(e) {
      Ok(v) => Thrown(v),
      Err(e) => e,
    },
    Err(e) => e,
  }
}

/// `new Error(message)`
pub fn error(message: &str) -> Thrown {
  match vhost().and_then(|h| js::call(h.error.get(), js::undefined(), &[js::string(message)])) {
    Ok(e) => match Val::from_local(e) {
      Ok(v) => Thrown(v),
      Err(e) => e,
    },
    Err(e) => e,
  }
}

/// Calls `func` (already evaluated as the callee `expr`, its arguments evaluated after it) with
/// `this`; V8's `TypeError` when it is not callable.
pub fn call(func: Local, this: Local, args: &[Local], expr: &str) -> JsResult<Local> {
  if js::type_of(func) != Type::Function {
    return Err(type_error(&format!("{expr} is not a function")));
  }
  js::call(func, this, args)
}

/// `receiver.method(...args)`: `expr` is the receiver's source text (`filteredOptions`).
pub fn call_method(receiver: Local, method: &str, args: &[Local], expr: &str) -> JsResult<Local> {
  let func = get(receiver, method)?;
  call(func, receiver, args, &format!("{expr}.{method}"))
}

/// `t(key)` / `t(key, vars)`: the destructured `req.t`, called as a plain function.
pub fn t(t: Local, key: &str, vars: Option<Local>) -> JsResult<Local> {
  match vars {
    Some(vars) => call(t, js::undefined(), &[js::string(key), vars], "t"),
    None => call(t, js::undefined(), &[js::string(key)], "t"),
  }
}

/// An object literal: keys in source order.
pub fn object(entries: &[(&str, Local)]) -> JsResult<Local> {
  let o = js::object();
  for (key, value) in entries {
    js::set_named(o, key, *value)?;
  }
  Ok(o)
}

/// An array literal.
pub fn array(items: &[Local]) -> JsResult<Local> {
  let a = js::array();
  for (i, item) in items.iter().enumerate() {
    js::set_element(a, i as u32, *item)?;
  }
  Ok(a)
}

/// `arr.push(value)` on an engine-created array.
pub fn push(arr: Local, value: Local) -> JsResult<()> {
  js::push(arr, value)
}

/// `.length` of an engine-created array.
pub fn len(arr: Local) -> u32 {
  js::array_length(arr)
}

/// Element of the array a destructuring helper returned.
pub fn arg(args: Local, index: u32) -> JsResult<Local> {
  js::get_element(args, index)
}

pub fn val(v: Local) -> JsResult<Val> {
  Val::from_local(v)
}

// ---------------------------------------------------------------------------------------------
// Callbacks

type Callback = dyn Fn(&[Local]) -> JsResult<Local>;

/// Heap cell behind a callback function: points at the Rust closure while it may be called.
struct CallbackCell(Cell<Option<*const Callback>>);

unsafe extern "C" fn callback_trampoline(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
  js::set_env(env);
  let (args, data) = js::callback_args::<3>(env, info);
  let cell = unsafe { &*(data as *const CallbackCell) };
  let result = match cell.0.get() {
    // SAFETY: the pointer is cleared before the closure it points at goes out of scope.
    Some(f) => catch_unwind(AssertUnwindSafe(|| unsafe { (*f)(&args) }))
      .unwrap_or_else(|_| Err(js::engine_error("payload validator callback panicked"))),
    None => Err(js::engine_error("payload validator callback called after the validator returned")),
  };
  match result {
    Ok(v) => v.0,
    Err(Thrown(e)) => {
      js::throw(e.get());
      ptr::null_mut()
    }
  }
}

unsafe extern "C" fn free_callback_cell(_env: sys::napi_env, data: *mut c_void, _hint: *mut c_void) {
  drop(unsafe { Box::from_raw(data as *mut CallbackCell) });
}

struct ClearOnDrop(*const CallbackCell);

impl Drop for ClearOnDrop {
  fn drop(&mut self) {
    // SAFETY: the function holding the cell is referenced by the current handle scope, so its
    // finalizer (which frees the cell) can't have run yet.
    unsafe { (*self.0).0.set(None) };
  }
}

/// Runs `body` with a JS function that calls `f` (an arrow function argument of the TS, e.g. the
/// `.some(...)` callback). `f` runs in its own napi callback scope: its arguments and the
/// handles it creates are only valid until it returns (keep a `Val` to use them later). The function only calls `f` until `body` returns: builtins call it
/// synchronously; a retained function throws afterwards instead of touching freed memory.
pub fn with_callback<'f, R>(
  f: &'f (dyn Fn(&[Local]) -> JsResult<Local> + 'f),
  body: impl FnOnce(Local) -> JsResult<R>,
) -> JsResult<R> {
  // SAFETY: lifetime erasure; the pointer is cleared by `ClearOnDrop` before `f` is dropped.
  let f: *const Callback = unsafe {
    std::mem::transmute::<&'f (dyn Fn(&[Local]) -> JsResult<Local> + 'f), &'static Callback>(f)
  };
  let cell = Box::into_raw(Box::new(CallbackCell(Cell::new(Some(f)))));
  let _clear = ClearOnDrop(cell);
  let func = js::create_function("", callback_trampoline, cell.cast());
  check(unsafe {
    sys::napi_add_finalizer(js::env(), func.0, cell.cast(), Some(free_callback_cell), ptr::null_mut(), ptr::null_mut())
  })?;
  body(func)
}

/// `for (const item of items) { ... }` without awaits in the body: `f` returns `None` to continue
/// or `Some(value)` to leave the loop (a `return` of the enclosing function). Uses JS `for...of`
/// (iterator protocol, `IteratorClose` on early exit).
pub fn for_of(items: Local, f: &dyn Fn(Local) -> JsResult<Option<Local>>) -> JsResult<Option<Local>> {
  let h = vhost()?;
  let cont = h.continue_marker.get();
  let callback = |args: &[Local]| -> JsResult<Local> { Ok(f(args[0])?.unwrap_or(cont)) };
  let result = with_callback(&callback, |cb| js::call(h.for_of.get(), js::undefined(), &[items, cb]))?;
  Ok(if js::strict_equals(result, h.continue_marker.get()) { None } else { Some(result) })
}

/// The iterator of a `for...of` whose body awaits: the host's `iterator(items)` does
/// `GetIterator` once and returns a step function (`IteratorStep` + `IteratorValue`, the
/// continue marker when done).
pub struct ForOf(Val);

impl ForOf {
  pub fn new(items: Local) -> JsResult<ForOf> {
    Ok(ForOf(Val::from_local(js::call(vhost()?.iterator.get(), js::undefined(), &[items])?)?))
  }

  /// The next item, `None` when done.
  pub fn step(&self) -> JsResult<Option<Local>> {
    let h = vhost()?;
    let value = js::call(self.0.get(), js::undefined(), &[])?;
    Ok(if js::strict_equals(value, h.continue_marker.get()) { None } else { Some(value) })
  }
}

/// A persistent handle kept on the host (`Persist` re-exported for the host struct).
pub type Handle = Persist;
