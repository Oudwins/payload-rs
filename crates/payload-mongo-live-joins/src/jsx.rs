//! JS-semantic operations on live values (property reads/writes with V8's errors, object literals
//! built with CreateDataProperty, template literals, relational/arithmetic operators, `for...of`,
//! native callbacks for array methods). Helpers whose exact semantics are the language's are run
//! by V8 (`helpers.js`, compiled once per env with `napi_run_script`); control flow stays in Rust.

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::rc::Rc;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Persist, Thrown, Type, Val};

const HELPERS_SOURCE: &str = include_str!("helpers.js");

thread_local! {
  static HELPERS: RefCell<Option<(usize, Rc<Persist>)>> = const { RefCell::new(None) };
}

/// The helper object of the current env.
pub fn helpers() -> JsResult<Local> {
  let env = js::env() as usize;
  if let Some(h) = HELPERS.with(|h| h.borrow().as_ref().filter(|(e, _)| *e == env).map(|(_, p)| p.clone())) {
    return Ok(h.get());
  }
  let mut out = ptr::null_mut();
  js::check(unsafe { sys::napi_run_script(js::env(), js::string(HELPERS_SOURCE).0, &mut out) })?;
  let p = Rc::new(Persist::new(Local(out))?);
  HELPERS.with(|h| *h.borrow_mut() = Some((env, p)));
  Ok(Local(out))
}

/// Calls helper `name` with `this === undefined`.
pub fn call(name: &str, args: &[Local]) -> JsResult<Local> {
  let f = js::get_named(helpers()?, name)?;
  js::call(f, js::undefined(), args)
}

pub fn val(v: Local) -> JsResult<Val> {
  Val::from_local(v)
}

// Property operations, calls and operators are the shared live helpers (one implementation).
pub use payload_mongo_live::host::{
  add, call_fn, call_method, gt, is_array, mul, opt, promise_all, sub, get, get_key as get_k, set, set_key as set_k,
};

fn data_property(name: sys::napi_value, value: sys::napi_value) -> sys::napi_property_descriptor {
  sys::napi_property_descriptor {
    utf8name: ptr::null(),
    name,
    method: None,
    getter: None,
    setter: None,
    value,
    attributes: sys::PropertyAttributes::writable
      | sys::PropertyAttributes::enumerable
      | sys::PropertyAttributes::configurable,
    data: ptr::null_mut(),
  }
}

/// CreateDataPropertyOrThrow(o, k, v): an object-literal entry (no setters, `__proto__` is an own key).
pub fn define(o: Local, k: Local, v: Local) -> JsResult<()> {
  let desc = data_property(k.0, v.0);
  js::check(unsafe { sys::napi_define_properties(js::env(), o.0, 1, &desc) })
}

/// An object literal with literal keys, values already evaluated in source order.
pub fn obj(entries: &[(&str, Local)]) -> JsResult<Local> {
  let o = js::object();
  for (k, v) in entries {
    define(o, js::key(k), *v)?;
  }
  Ok(o)
}

/// An object literal with computed keys.
pub fn obj_k(entries: &[(Local, Local)]) -> JsResult<Local> {
  let o = js::object();
  for (k, v) in entries {
    define(o, *k, *v)?;
  }
  Ok(o)
}

/// An array literal.
pub fn arr(items: &[Local]) -> JsResult<Local> {
  let a = js::array();
  for (i, item) in items.iter().enumerate() {
    js::set_element(a, i as u32, *item)?;
  }
  Ok(a)
}

/// `arr.push(v)` on an engine-created array.
pub fn push(a: Local, v: Local) -> JsResult<()> {
  js::push(a, v)
}

pub fn s(text: &str) -> Local {
  js::string(text)
}

pub fn num(n: f64) -> Local {
  js::number(n)
}

pub fn truthy(v: Local) -> bool {
  js::truthy(v)
}

pub fn nullish(v: Local) -> bool {
  matches!(js::type_of(v), Type::Undefined | Type::Null)
}

pub fn is_undefined(v: Local) -> bool {
  js::type_of(v) == Type::Undefined
}

pub fn is_string(v: Local) -> bool {
  js::type_of(v) == Type::String
}

pub fn is_number(v: Local) -> bool {
  js::type_of(v) == Type::Number
}

/// `v === false`
pub fn is_false(v: Local) -> bool {
  js::type_of(v) == Type::Boolean && !js::get_bool(v)
}

/// `v === 'text'`
pub fn eq_str(v: Local, text: &str) -> bool {
  js::type_of(v) == Type::String && js::get_string_utf16(v).is_some_and(|u| u.iter().copied().eq(text.encode_utf16()))
}

/// `a === b`
pub fn strict_eq(a: Local, b: Local) -> bool {
  js::strict_equals(a, b)
}

/// `a ?? b` (b evaluated lazily by the caller)
pub fn coalesce(a: Local, b: impl FnOnce() -> JsResult<Local>) -> JsResult<Local> {
  if nullish(a) { b() } else { Ok(a) }
}


fn utf16(v: Local) -> Option<Vec<u16>> {
  js::get_string_utf16(v)
}

fn string_utf16(units: &[u16]) -> Local {
  let mut v = ptr::null_mut();
  unsafe { sys::napi_create_string_utf16(js::env(), units.as_ptr(), units.len() as isize, &mut v) };
  Local(v)
}

/// A template literal over evaluated parts (ToString left to right; strings concatenated exactly).
pub fn tpl(parts: &[Local]) -> JsResult<Local> {
  if parts.iter().all(|p| is_string(*p)) {
    let mut out: Vec<u16> = Vec::new();
    for p in parts {
      out.extend(utf16(*p).unwrap_or_default());
    }
    return Ok(string_utf16(&out));
  }
  call("tpl", parts)
}

/// Rust copy of a JS string value (engine-side comparisons only).
pub fn rust_string(v: Local) -> Option<String> {
  js::get_string(v)
}


fn arith(name: &str, a: Local, b: Local, f: fn(f64, f64) -> f64) -> JsResult<Local> {
  if is_number(a) && is_number(b) {
    return Ok(js::number(f(js::get_f64(a), js::get_f64(b))));
  }
  call(name, &[a, b])
}

/// `a < b`
pub fn lt(a: Local, b: Local) -> JsResult<bool> {
  if is_number(a) && is_number(b) {
    return Ok(js::get_f64(a) < js::get_f64(b));
  }
  Ok(js::truthy(call("lt", &[a, b])?))
}





/// `a / b`
pub fn div(a: Local, b: Local) -> JsResult<Local> {
  arith("div", a, b, |x, y| x / y)
}

/// `a == b`
pub fn loose_eq(a: Local, b: Local) -> JsResult<bool> {
  if is_number(a) && is_number(b) {
    return Ok(js::get_f64(a) == js::get_f64(b));
  }
  Ok(js::truthy(call("looseEq", &[a, b])?))
}

/// `Object.keys(o)`
pub fn keys(o: Local) -> JsResult<Local> {
  call("keys", &[o])
}

/// `Object.entries(o)`
pub fn entries(o: Local) -> JsResult<Local> {
  call("entries", &[o])
}

/// `Object.values(o)`
pub fn values(o: Local) -> JsResult<Local> {
  call("values", &[o])
}



/// `new C(...args)`
pub fn construct(ctor: Local, args: &[Local]) -> JsResult<Local> {
  let mut out = ptr::null_mut();
  let raw = args.as_ptr().cast::<sys::napi_value>();
  js::check(unsafe { sys::napi_new_instance(js::env(), ctor.0, args.len(), raw, &mut out) })?;
  Ok(Local(out))
}

/// An error to throw, or the error its construction threw.
pub type ThrownResult = JsResult<Thrown>;

/// ToPropertyKey(v) for a computed key (strings and symbols as they are).
pub fn prop_key(v: Local) -> JsResult<Local> {
  match js::type_of(v) {
    Type::String | Type::Symbol => Ok(v),
    Type::Number => call("str", &[v]),
    _ => call("str", &[v]),
  }
}

/// Element `i` of an engine array of `N` destructured values, as [`Val`]s.
pub fn elements<const N: usize>(a: Local) -> JsResult<[Val; N]> {
  let mut out: [Val; N] = std::array::from_fn(|_| Val::Undefined);
  for (i, slot) in out.iter_mut().enumerate() {
    *slot = val(js::get_element(a, i as u32)?)?;
  }
  Ok(out)
}

/// A JS value as a thrown error.
pub fn thrown(e: Local) -> Thrown {
  match Val::from_local(e) {
    Ok(v) => Thrown(v),
    Err(t) => t,
  }
}

/// `new Error(message)` (V8's `Error` of the current realm).
pub fn error(message: &str) -> Thrown {
  match call("newError", &[s(message)]) {
    Ok(e) => thrown(e),
    Err(t) => t,
  }
}


// ---------------------------------------------------------------------------------------------
// loops

/// `for (const x of v)` whose body awaits: plain arrays by index with a live length (the default
/// array iterator), everything else through the `forOf` generator helper (V8's iterator
/// protocol). Holds only [`Val`]s, so it survives the body's awaits.
pub enum ForOf {
  Array { arr: Val, index: u32 },
  Iter(Val),
}

impl ForOf {
  /// `for (const x of <expr>)` over `v` (`expr`: source text for `<expr> is not iterable`).
  pub fn of(v: Local, expr: &str) -> JsResult<ForOf> {
    if js::is_array(v) {
      return Ok(ForOf::Array { arr: Val::from_local(v)?, index: 0 });
    }
    Ok(ForOf::Iter(val(call("forOf", &[v, s(expr)])?)?))
  }

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
      ForOf::Iter(generator) => {
        let done = js::get_named(helpers()?, "DONE")?;
        let item = call("next", &[generator.get(), done])?;
        Ok((!js::strict_equals(item, done)).then_some(item))
      }
    }
  }

  /// IteratorClose after a throw in the body.
  pub fn close(&self) {
    if let ForOf::Iter(generator) = self {
      let _ = call("closeLoop", &[generator.get()]);
    }
  }
}

/// `for (const x of <expr>)` with a synchronous body; `f` returns `true` to `break`.
pub fn for_of_sync(v: Local, expr: &str, mut f: impl FnMut(Local) -> JsResult<bool>) -> JsResult<()> {
  if js::is_array(v) {
    // the default array iterator: live length, `Get` per index
    let mut i = 0;
    while i < js::array_length(v) {
      let item = js::get_element(v, i)?;
      i += 1;
      if f(item)? {
        break;
      }
    }
    return Ok(());
  }
  with_cb(&mut |args| Ok(js::boolean(f(args[0])?)), |cb| call("forOfSync", &[v, s(expr), cb])).map(|_| ())
}

// ---------------------------------------------------------------------------------------------
// native callbacks

type CbFn = dyn FnMut(&[Local; 4]) -> JsResult<Local>;

struct Entry {
  id: usize,
  f: *mut CbFn,
  busy: bool,
}

thread_local! {
  static CALLBACKS: RefCell<Vec<Entry>> = const { RefCell::new(Vec::new()) };
  static NEXT_ID: Cell<usize> = const { Cell::new(1) };
}

struct Guard(usize);

impl Drop for Guard {
  fn drop(&mut self) {
    CALLBACKS.with(|m| m.borrow_mut().retain(|e| e.id != self.0));
  }
}

/// Runs `body` with a fresh JS function that calls `f` with its first four arguments (the TS
/// arrow passed to an array method). `f` is only callable while `body` runs; a retained function
/// throws afterwards.
pub fn with_cb<'f, R>(f: &mut (dyn FnMut(&[Local; 4]) -> JsResult<Local> + 'f), body: impl FnOnce(Local) -> JsResult<R>) -> JsResult<R> {
  let id = NEXT_ID.with(|n| {
    let id = n.get();
    n.set(id.wrapping_add(1).max(1));
    id
  });
  // SAFETY: the entry is removed by `_guard` before `f` goes out of scope; the trampoline only
  // dereferences registered entries.
  let f: *mut CbFn = unsafe { std::mem::transmute::<&mut (dyn FnMut(&[Local; 4]) -> JsResult<Local> + 'f), *mut CbFn>(f) };
  CALLBACKS.with(|m| m.borrow_mut().push(Entry { id, f, busy: false }));
  let _guard = Guard(id);
  let func = js::create_function("", trampoline, id as *mut c_void);
  body(func)
}

unsafe extern "C" fn trampoline(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
  js::set_env(env);
  let (args, data) = js::callback_args::<4>(env, info);
  let id = data as usize;
  let entry = CALLBACKS.with(|m| {
    let mut m = m.borrow_mut();
    let e = m.iter_mut().find(|e| e.id == id)?;
    if e.busy {
      return Some(Err(()));
    }
    e.busy = true;
    Some(Ok(e.f))
  });
  let result = match entry {
    None => Err(js::engine_error("mongo live engine: a callback was called after the call it was passed to returned")),
    Some(Err(())) => Err(js::engine_error("mongo live engine: a callback was called re-entrantly")),
    Some(Ok(f)) => {
      let r = catch_unwind(AssertUnwindSafe(|| unsafe { (*f)(&args) }));
      CALLBACKS.with(|m| {
        if let Some(e) = m.borrow_mut().iter_mut().find(|e| e.id == id) {
          e.busy = false;
        }
      });
      r.unwrap_or_else(|_| Err(js::engine_error("mongo live engine panicked")))
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

/// `<expr>.<method>(arrow)` where `arrow` is `f`: the method is read from the value and called
/// with a native callback, so proxies, patched methods, holes and V8's errors are upstream's.
pub fn array_method(target: Local, method: &str, expr: &str, f: &mut (dyn FnMut(&[Local; 4]) -> JsResult<Local> + '_)) -> JsResult<Local> {
  let m = get(target, method)?;
  if js::type_of(m) != Type::Function {
    return Err(thrown(call("notAFunction", &[s(&format!("{expr}.{method}"))])?));
  }
  with_cb(f, |cb| js::call(m, target, &[cb]))
}
