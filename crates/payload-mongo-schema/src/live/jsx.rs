//! JS-semantic operations on live values for the model building: property reads/writes with V8's
//! errors (the core runtime's host), object literals built with CreateDataProperty, template
//! literals, `for...of`, native callbacks for array methods. Helpers whose exact semantics are the
//! language's run in V8 (`helpers.js`, compiled once per env with `napi_run_script`).

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::rc::Rc;

use napi::sys;
use payload_core_runtime::host as rt;
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

/// `o.name` (getters, proxies, V8's TypeError on nullish)
pub fn get(o: Local, name: &str) -> JsResult<Local> {
  rt::get_named(o, name)
}

/// `o[k]`
pub fn get_k(o: Local, k: Local) -> JsResult<Local> {
  rt::get(o, k)
}

/// `o?.name`
pub fn opt(o: Local, name: &str) -> JsResult<Local> {
  rt::get_optional(o, js::key(name))
}

/// `o?.[k]`
pub fn opt_k(o: Local, k: Local) -> JsResult<Local> {
  rt::get_optional(o, k)
}

/// `o[k] = v` (strict mode)
pub fn set_k(o: Local, k: Local, v: Local) -> JsResult<()> {
  rt::set(o, k, v)
}

/// `o.name = v` (strict mode)
pub fn set(o: Local, name: &str, v: Local) -> JsResult<()> {
  rt::set(o, js::key(name), v)
}

/// `Array.isArray(v)` (also true for proxies of arrays)
pub fn is_array(v: Local) -> JsResult<bool> {
  if js::is_array(v) {
    return Ok(true);
  }
  if js::type_of(v) != Type::Object {
    return Ok(false);
  }
  Ok(js::truthy(call("isArray", &[v])?))
}

/// `f(...args)` evaluated as `<expr>(...)` with `this`: non-callables throw V8's TypeError.
pub fn call_fn(f: Local, this: Local, args: &[Local], expr: &str) -> JsResult<Local> {
  if js::type_of(f) == Type::Function {
    js::call(f, this, args)
  } else {
    Err(thrown(call("notAFunction", &[s(expr)])?))
  }
}

/// `o.name(...args)` (`this === o`); `expr` = the TS source text of `o.name`.
pub fn call_method(o: Local, name: &str, args: &[Local], expr: &str) -> JsResult<Local> {
  let f = get(o, name)?;
  call_fn(f, o, args, expr)
}

/// `a > b`
pub fn gt(a: Local, b: Local) -> JsResult<bool> {
  if is_number(a) && is_number(b) {
    return Ok(js::get_f64(a) > js::get_f64(b));
  }
  Ok(js::truthy(call("gt", &[a, b])?))
}

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

/// `v === true`
pub fn is_true(v: Local) -> bool {
  js::type_of(v) == Type::Boolean && js::get_bool(v)
}

/// Rust copy of an engine-made JS string (helper results).
pub fn rust_string_of(v: Local) -> String {
  js::get_string(v).unwrap_or_default()
}

/// `v === 'text'`
pub fn eq_str(v: Local, text: &str) -> bool {
  js::type_of(v) == Type::String && js::get_string_utf16(v).is_some_and(|u| u.iter().copied().eq(text.encode_utf16()))
}

/// `a === b`
pub fn strict_eq(a: Local, b: Local) -> bool {
  js::strict_equals(a, b)
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
    _ => call("tpl", &[v]),
  }
}

/// A global binding (`Number`, `String`, `Boolean`, `Date`), read when evaluated.
pub fn global(name: &str) -> JsResult<Local> {
  js::get_named(js::global(), name)
}


/// A JS value as a thrown error.
pub fn thrown(e: Local) -> Thrown {
  match Val::from_local(e) {
    Ok(v) => Thrown(v),
    Err(t) => t,
  }
}



// ---------------------------------------------------------------------------------------------
// loops

/// `for (const x of <expr>)` with a synchronous body.
pub fn for_of_sync(v: Local, expr: &str, mut f: impl FnMut(Local) -> JsResult<()>) -> JsResult<()> {
  if js::is_array(v) {
    // the default array iterator: live length, `Get` per index
    let mut i = 0;
    while i < js::array_length(v) {
      let item = js::get_element(v, i)?;
      i += 1;
      f(item)?;
    }
    return Ok(());
  }
  with_cb(&mut |args| {
    f(args[0])?;
    Ok(js::undefined())
  }, |cb| call("forOfSync", &[v, s(expr), cb]))
  .map(|_| ())
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
    None => Err(js::engine_error("mongo live schema: a callback was called after the call it was passed to returned")),
    Some(Err(())) => Err(js::engine_error("mongo live schema: a callback was called re-entrantly")),
    Some(Ok(f)) => {
      let r = catch_unwind(AssertUnwindSafe(|| unsafe { (*f)(&args) }));
      CALLBACKS.with(|m| {
        if let Some(e) = m.borrow_mut().iter_mut().find(|e| e.id == id) {
          e.busy = false;
        }
      });
      r.unwrap_or_else(|_| Err(js::engine_error("mongo live schema panicked")))
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
