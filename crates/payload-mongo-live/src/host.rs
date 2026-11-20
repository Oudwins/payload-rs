//! JS helpers of the Mongo live crates (`packages/engine-rs/src/mongo-live/host.ts`), installed by
//! the binding's `init(host)` after the core runtime (`getCoreRuntime()`) and the core query host
//! (`getCoreQueryBinding()`). Helpers are looked up by name on the host object. They exist for:
//! - object literals / spreads / closures handed to mongoose or user code (same key order, same
//!   evaluation order as the TS expression),
//! - JS built-ins whose exact semantics matter (`instanceof`, `new Date()`, `Promise.resolve`,
//!   `JSON.parse(JSON.stringify(...))`, operators on non-numbers),
//! - upstream utilities that are called rather than ported (`flattenWhereToOperators`,
//!   `buildVersionCollectionFields`, Payload error classes) and, until their live ports register
//!   in [`crate::deps`], the db-mongodb functions owned by the other live crates.
//!
//! Plus JS-semantic property operations every live crate shares (all go through
//! `payload_core_runtime::host`: getters, proxies, strict-mode writes, V8 error messages).

use std::cell::RefCell;
use std::rc::Rc;

use payload_core_runtime::host as rt;
use payload_core_runtime::js::{self, JsResult, Local, Persist, Thrown, Type, Val};

pub struct Host {
  pub obj: Persist,
}

thread_local! {
  static HOST: RefCell<Option<Rc<Host>>> = const { RefCell::new(None) };
}

/// Installs the JS host object (`createMongoLiveHost()` of packages/engine-rs/src/mongo-live).
pub fn install(obj: Local) -> JsResult<()> {
  let host = Host { obj: Persist::new(obj)? };
  HOST.with(|h| *h.borrow_mut() = Some(Rc::new(host)));
  Ok(())
}

pub fn host() -> JsResult<Rc<Host>> {
  HOST
    .with(|h| h.borrow().clone())
    .ok_or_else(|| js::engine_error("mongo live binding not initialized (call init first)"))
}

/// Calls the host helper `name` with `this === undefined`.
pub fn call(name: &str, args: &[Local]) -> JsResult<Local> {
  let h = host()?;
  let f = js::get_named(h.obj.get(), name)?;
  if js::type_of(f) != Type::Function {
    return Err(js::engine_error(&format!("mongo live host helper `{name}` is missing")));
  }
  js::call(f, js::undefined(), args)
}

/// [`call`], keeping the result across awaits.
pub fn call_val(name: &str, args: &[Local]) -> JsResult<Val> {
  Val::from_local(call(name, args)?)
}

/// Keeps a handle across awaits.
pub fn val(v: Local) -> JsResult<Val> {
  Val::from_local(v)
}

/// A JS value created by a helper, as a thrown error (the very object).
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

// ---------------------------------------------------------------------------------------------
// property operations (JS semantics)

/// `o.name` (TypeError on nullish like V8, primitive wrappers, getters, proxies).
pub fn get(o: Local, name: &str) -> JsResult<Local> {
  rt::get_named(o, name)
}

pub fn get_val(o: Local, name: &str) -> JsResult<Val> {
  Val::from_local(rt::get_named(o, name)?)
}

/// `o[k]` for any key value (ToPropertyKey applies).
pub fn get_key(o: Local, k: Local) -> JsResult<Local> {
  rt::get(o, k)
}

/// `o?.name`
pub fn opt(o: Local, name: &str) -> JsResult<Local> {
  rt::get_optional(o, js::key(name))
}

/// `o?.[k]`
pub fn get_key_optional(o: Local, k: Local) -> JsResult<Local> {
  rt::get_optional(o, k)
}

/// `o.name = v` (strict mode: throws on primitives, frozen objects, setter-less accessors).
pub fn set(o: Local, name: &str, v: Local) -> JsResult<()> {
  rt::set(o, js::key(name), v)
}

/// `o[k] = v` (strict mode).
pub fn set_key(o: Local, k: Local, v: Local) -> JsResult<()> {
  rt::set(o, k, v)
}

/// `delete o[k]` (strict mode: one [[Delete]], a false result throws V8's TypeError).
pub fn del(o: Local, k: Local) -> JsResult<()> {
  rt::del(o, k)
}

/// `name in o` (the operator's intrinsic TypeError for primitives).
pub fn has(o: Local, name: &str) -> JsResult<bool> {
  rt::has(o, js::key(name))
}

/// `k in o` for any key value (ToPropertyKey applies).
pub fn has_key(o: Local, k: Local) -> JsResult<bool> {
  rt::has(o, k)
}

/// `Object.keys(o).length`: the current global `Object.keys` (read and called once, at this
/// point), then a [[Get]] of `length` on whatever it returned. Only for `=== 0` / `> 0` tests:
/// the result is 0 iff the length value `=== 0`, and `u32::MAX` for a length that is not a
/// non-negative integer number (a replaced `Object.keys` may return anything).
pub fn object_keys_length(o: Local) -> JsResult<u32> {
  let len = get(object_keys(o)?, "length")?;
  if js::type_of(len) != Type::Number {
    return Ok(u32::MAX);
  }
  let n = js::get_f64(len);
  Ok(if n == 0.0 { 0 } else if n >= 1.0 && n.fract() == 0.0 && n < f64::from(u32::MAX) { n as u32 } else { u32::MAX })
}

/// `Object.keys(o)`: the current global `Object.keys`, read and called once, at this point (a
/// patched or replaced `Object.keys` runs like upstream). For `Object.keys(<expr>)` whose argument
/// has effects, evaluate [`global_method`]`("Object", "keys")` first, then the argument.
pub fn object_keys(o: Local) -> JsResult<Local> {
  rt::object_keys(o)
}

pub use rt::{Method, global, global_method, method};

// ---------------------------------------------------------------------------------------------
// calls

/// `obj.name(...args)`: the method is read from `obj` and called with `this === obj`; a
/// non-callable throws V8's `TypeError: <expr> is not a function` (`expr` = the TS source text,
/// e.g. `Model.paginate`).
pub fn call_method(obj: Local, name: &str, args: &[Local], expr: &str) -> JsResult<Local> {
  let f = get(obj, name)?;
  call_fn(f, obj, args, expr)
}

/// `f(...args)` evaluated as `expr(...)` with `this`. A non-callable `f` throws the realm's
/// intrinsic `TypeError: <expr> is not a function` (what V8 throws for the TS call; a replaced
/// `globalThis.TypeError` is not used).
pub fn call_fn(f: Local, this: Local, args: &[Local], expr: &str) -> JsResult<Local> {
  rt::call_fn(f, this, args, expr)
}

/// The intrinsic `TypeError` V8 itself throws (`x is not a function`, `Cannot read properties of
/// ...`). Where the TS source says `new TypeError(...)`, use [`construct_global`] instead.
pub fn intrinsic_type_error(message: &str) -> Thrown {
  js::type_error(message)
}

/// `new <Global>(...args)` with the current global binding `name` (`new TypeError(msg)`,
/// `new Error(msg)` written in the TS source): the constructor is read at this point.
pub fn construct_global(name: &str, args: &[Local]) -> JsResult<Local> {
  let ctor = global(name)?;
  construct(ctor, args, name)
}

/// `new ctor(...args)`; a non-constructor throws the intrinsic `TypeError: <expr> is not a
/// constructor`.
pub fn construct(ctor: Local, args: &[Local], expr: &str) -> JsResult<Local> {
  if js::type_of(ctor) != Type::Function {
    return Err(js::type_error(&format!("{expr} is not a constructor")));
  }
  js::construct(ctor, args)
}

/// `Promise.all(array)` (the global `Promise.all` at call time, through the core runtime's host).
pub fn promise_all(array: Local) -> JsResult<Local> {
  rt::call_host(&rt::host()?.promise_all, &[array])
}

/// A fresh array literal `[a, b, ...]` (CreateDataProperty per element: setters inherited from
/// `Array.prototype` / `Object.prototype` never run).
pub fn array_of(items: &[Local]) -> JsResult<Local> {
  js::array_literal(items)
}

/// A fresh object literal `{ k1: v1, k2: v2, ... }`: key order as given, own `undefined` values
/// kept, each property defined with CreateDataProperty like a literal (setters inherited from
/// `Object.prototype` never run, and cannot drop the property). Assignments into an EXISTING
/// object are [`set`] (strict [[Set]]).
pub fn literal(entries: &[(&str, Local)]) -> JsResult<Local> {
  js::object_literal(entries)
}

/// `o[k] = v` defined as an own data property (CreateDataProperty: `{ ...a, [k]: v }`, literal
/// keys computed at runtime, `Array.prototype.map` results). Not an assignment: see [`set_key`].
pub fn define_key(o: Local, k: Local, v: Local) -> JsResult<()> {
  js::define_property(o, k, v)
}

/// `arr.push(v)` through `arr`'s `push` (patched `Array.prototype.push`, own `push`, frozen arrays
/// throw like upstream); `expr` = the TS callee text (`docs.push`).
pub fn push(arr: Local, v: Local, expr: &str) -> JsResult<Local> {
  rt::push(arr, v, expr)
}

// ---------------------------------------------------------------------------------------------
// value tests

pub fn truthy(v: Local) -> bool {
  js::truthy(v)
}

/// `v === undefined || v === null`
pub fn is_nullish(v: Local) -> bool {
  matches!(js::type_of(v), Type::Undefined | Type::Null)
}

pub fn is_undefined(v: Local) -> bool {
  js::type_of(v) == Type::Undefined
}

/// `typeof v === 'number'`
pub fn is_number(v: Local) -> bool {
  js::type_of(v) == Type::Number
}

/// `typeof v === 'string'`
pub fn is_string(v: Local) -> bool {
  js::type_of(v) == Type::String
}

/// `typeof v === 'object'` (true for `null`).
pub fn is_typeof_object(v: Local) -> bool {
  js::type_of(v).is_typeof_object()
}

/// `v === false`
pub fn is_false(v: Local) -> bool {
  js::type_of(v) == Type::Boolean && !js::get_bool(v)
}

/// `v === true`
pub fn is_true(v: Local) -> bool {
  js::type_of(v) == Type::Boolean && js::get_bool(v)
}

/// `v === <string literal>`
pub fn str_eq(v: Local, lit: &str) -> bool {
  js::str_equals(v, lit)
}

/// `Array.isArray(v)`: the current global `Array.isArray`, read and called once, at this point
/// (true for proxies of arrays, throws for revoked proxies, a patched global runs like upstream).
pub fn is_array(v: Local) -> JsResult<bool> {
  rt::array_is_array(v)
}

/// Engine-internal "is this a real JS array" test with no JS-observable effect (no global read,
/// no proxy trap). Only for decisions the TS does not make through `Array.isArray`.
pub fn is_array_intrinsic(v: Local) -> bool {
  js::is_array(v)
}

// ---------------------------------------------------------------------------------------------
// operators (exact JS semantics: numbers natively, anything else through the host, so `"2" + 1`,
// `valueOf` calls and their order are V8's)

fn binop(op: &str, a: Local, b: Local) -> JsResult<Local> {
  call("binop", &[js::string(op), a, b])
}

fn numbers(a: Local, b: Local) -> Option<(f64, f64)> {
  (is_number(a) && is_number(b)).then(|| (js::get_f64(a), js::get_f64(b)))
}

/// `a + b`
pub fn add(a: Local, b: Local) -> JsResult<Local> {
  match numbers(a, b) {
    Some((x, y)) => Ok(js::number(x + y)),
    None => binop("+", a, b),
  }
}

/// `a - b`
pub fn sub(a: Local, b: Local) -> JsResult<Local> {
  match numbers(a, b) {
    Some((x, y)) => Ok(js::number(x - y)),
    None => binop("-", a, b),
  }
}

/// `a * b`
pub fn mul(a: Local, b: Local) -> JsResult<Local> {
  match numbers(a, b) {
    Some((x, y)) => Ok(js::number(x * y)),
    None => binop("*", a, b),
  }
}

/// `a > b`
pub fn gt(a: Local, b: Local) -> JsResult<bool> {
  match numbers(a, b) {
    Some((x, y)) => Ok(x > y),
    None => Ok(js::truthy(binop(">", a, b)?)),
  }
}

/// `a ?? b` where `b` is only evaluated when needed.
pub fn nullish_or(a: Local, b: impl FnOnce() -> JsResult<Local>) -> JsResult<Local> {
  if is_nullish(a) { b() } else { Ok(a) }
}

/// `a || b` where `b` is only evaluated when needed.
pub fn or_else(a: Local, b: impl FnOnce() -> JsResult<Local>) -> JsResult<Local> {
  if truthy(a) { Ok(a) } else { b() }
}

/// `v === undefined ? default() : v` (a destructuring default).
pub fn default_of(v: Local, default: impl FnOnce() -> JsResult<Local>) -> JsResult<Local> {
  if is_undefined(v) { default() } else { Ok(v) }
}
