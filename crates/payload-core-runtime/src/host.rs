//! JS helpers the runtime calls for operations whose exact JS semantics (error messages,
//! strict-mode behaviour, spread/`Object.values` coercions, Payload error classes, population)
//! must not be re-implemented, plus JS-semantic property operations.

use std::cell::RefCell;
use std::rc::Rc;

use crate::js::{self, JsResult, Local, Persist, Type};

pub struct Host {
  pub obj: Persist,
  pub get: Persist,
  pub set: Persist,
  pub del: Persist,
  pub object_values: Persist,
  pub object_entries: Persist,
  pub spread_with_id: Persist,
  pub tabs_as_fields: Persist,
  pub parse_depth: Persist,
  pub get_select_mode: Persist,
  pub get_block_select: Persist,
  pub deep_copy: Persist,
  pub missing_editor_prop: Persist,
  pub new_error: Persist,
  pub promise_all: Persist,
  pub relationship_population_promise: Persist,
  pub virtual_field_population_promise: Persist,
  pub desc_cache: Persist,
  pub hook_args: Persist,
  pub leaf_run: Persist,
  pub call_field_hook: Persist,
  pub call_editor_hook: Persist,
  pub call_read_access: Persist,
  pub push_relationship_population: Persist,
  pub push_virtual_field_population: Persist,
  pub after_read_args: Persist,
  pub greater_than: Persist,
  pub path_segments: Persist,
  pub push_settled: Persist,
  pub leaf_rows: Persist,
}

thread_local! {
  static HOST: RefCell<Option<Rc<Host>>> = const { RefCell::new(None) };
}

pub fn install(obj: Local) -> JsResult<()> {
  let f = |name: &str| -> JsResult<Persist> { Persist::new(js::get_named(obj, name)?) };
  // `awaitValue` / `thenReturn` are the binding's own compiled helpers
  // (`executor::install_native_await`, done when the binding is created); a host's are ignored.
  let host = Host {
    obj: Persist::new(obj)?,
    get: f("get")?,
    set: f("set")?,
    del: f("del")?,
    object_values: f("objectValues")?,
    object_entries: f("objectEntries")?,
    spread_with_id: f("spreadWithID")?,
    tabs_as_fields: f("tabsAsFields")?,
    parse_depth: f("parseDepth")?,
    get_select_mode: f("getSelectMode")?,
    get_block_select: f("getBlockSelect")?,
    deep_copy: f("deepCopyObjectSimple")?,
    missing_editor_prop: f("missingEditorProp")?,
    new_error: f("newError")?,
    promise_all: f("promiseAll")?,
    relationship_population_promise: f("relationshipPopulationPromise")?,
    virtual_field_population_promise: f("virtualFieldPopulationPromise")?,
    desc_cache: f("descCache")?,
    hook_args: f("hookArgs")?,
    leaf_run: f("leafRun")?,
    call_field_hook: f("callFieldHook")?,
    call_editor_hook: f("callEditorHook")?,
    call_read_access: f("callReadAccess")?,
    push_relationship_population: f("pushRelationshipPopulation")?,
    push_virtual_field_population: f("pushVirtualFieldPopulation")?,
    after_read_args: f("afterReadArgs")?,
    greater_than: f("greaterThan")?,
    path_segments: f("pathSegments")?,
    push_settled: f("pushSettled")?,
    leaf_rows: f("leafRows")?,
  };
  HOST.with(|h| *h.borrow_mut() = Some(Rc::new(host)));
  Ok(())
}

pub fn host() -> JsResult<Rc<Host>> {
  HOST
    .with(|h| h.borrow().clone())
    .ok_or_else(|| js::engine_error("core runtime not initialized"))
}

pub fn call_host(f: &Persist, args: &[Local]) -> JsResult<Local> {
  js::call(f.get(), js::undefined(), args)
}

/// `o[k]` with JS semantics for any `o` (TypeError on null/undefined, primitive wrappers).
pub fn get(o: Local, k: Local) -> JsResult<Local> {
  if js::type_of(o).is_object_like() {
    js::get_property(o, k)
  } else {
    call_host(&host()?.get, &[o, k])
  }
}

pub fn get_named(o: Local, name: &str) -> JsResult<Local> {
  get(o, js::key(name))
}

/// `o?.[k]`
pub fn get_optional(o: Local, k: Local) -> JsResult<Local> {
  match js::type_of(o) {
    Type::Undefined | Type::Null => Ok(js::undefined()),
    _ => get(o, k),
  }
}

/// `o[k] = v` in strict mode (module code): throws on primitives and on failed writes
/// (frozen objects, setter-less accessors). `napi_set_property` is sloppy-mode and silently
/// ignores failed writes, so writes always go through the host's strict-mode setter.
pub fn set(o: Local, k: Local, v: Local) -> JsResult<()> {
  call_host(&host()?.set, &[o, k, v]).map(|_| ())
}

/// `delete o[k]` in strict mode: ONE [[Delete]] (one `deleteProperty` trap call on a proxy); a
/// false result throws V8's TypeError, like the TS `delete` in module code. (`napi_delete_property`
/// is sloppy and cannot be followed by a strict retry without running the trap twice.)
pub fn del(o: Local, k: Local) -> JsResult<()> {
  call_host(&host()?.del, &[o, k]).map(|_| ())
}

thread_local! {
  /// `(k, o) => k in o`, compiled once per thread (strict mode).
  static HAS_IN: RefCell<Option<Persist>> = const { RefCell::new(None) };
}

/// `k in o`: [[HasProperty]] for objects (proxy `has` traps run); for a primitive `o` the
/// operator's own intrinsic `TypeError` (`Cannot use 'in' operator to search for ...`), exactly
/// as V8 formats it.
pub fn has(o: Local, k: Local) -> JsResult<bool> {
  if js::type_of(o).is_object_like() {
    return js::has_property(o, k);
  }
  let helper = match HAS_IN.with(|h| h.borrow().as_ref().map(|p| p.get())) {
    Some(f) => f,
    None => {
      let f = js::run_script("'use strict'; (k, o) => k in o")?;
      let p = Persist::new(f)?;
      HAS_IN.with(|h| *h.borrow_mut() = Some(p));
      f
    }
  };
  Ok(js::truthy(js::call(helper, js::undefined(), &[k, o])?))
}

/// The current value of the global binding `name` (`Object`, `Array`, `Promise`, ...), read now:
/// what an identifier reference to a global built-in evaluates to in module code (one [[Get]] on
/// the global object; replaced or patched globals are seen, like upstream).
pub fn global(name: &str) -> JsResult<Local> {
  js::get_named(js::global(), name)
}

/// A method reference evaluated the way the TS evaluates `Recv.method` before the arguments of
/// `Recv.method(...args)`: `recv` is read first, then `method` on it; call it with [`Method::call`]
/// after evaluating the arguments.
pub struct Method {
  pub this: Local,
  pub func: Local,
}

impl Method {
  /// `this.func(...args)`; a non-callable `func` throws V8's intrinsic `TypeError: <expr> is not a
  /// function` (`expr` = the TS callee text, e.g. `Object.keys`).
  pub fn call(&self, args: &[Local], expr: &str) -> JsResult<Local> {
    call_fn(self.func, self.this, args, expr)
  }
}

/// `Global.method` evaluated now (`Object.keys`, `Array.isArray`, `Number.isNaN`, ...): reads the
/// global `name`, then its property `method` (TypeError on a nullish global like V8).
pub fn global_method(name: &str, method: &str) -> JsResult<Method> {
  let this = global(name)?;
  let func = get_named(this, method)?;
  Ok(Method { this, func })
}

/// `recv.method` evaluated now (for `recv.method(...args)`; `recv` may be a primitive: string
/// methods are looked up like JS does, with the primitive as `this` of the call).
pub fn method(recv: Local, name: &str) -> JsResult<Method> {
  Ok(Method { this: recv, func: get_named(recv, name)? })
}

/// `f(...args)` with `this`, as the TS call expression `expr(...)`: a non-callable throws the
/// intrinsic `TypeError: <expr> is not a function`.
pub fn call_fn(f: Local, this: Local, args: &[Local], expr: &str) -> JsResult<Local> {
  if js::type_of(f) == Type::Function {
    js::call(f, this, args)
  } else {
    Err(js::not_a_function(expr))
  }
}

/// `recv.name(...args)` where the arguments have no side effects of their own (already evaluated
/// values): method read, then the call. `expr` is the TS callee text (`docs.push`).
pub fn call_method(recv: Local, name: &str, args: &[Local], expr: &str) -> JsResult<Local> {
  method(recv, name)?.call(args, expr)
}

/// `Object.keys(o)` with the current global `Object.keys` (read at call time, called once).
pub fn object_keys(o: Local) -> JsResult<Local> {
  global_method("Object", "keys")?.call(&[o], "Object.keys")
}

/// `Array.isArray(v)` with the current global (read at call time, called once).
pub fn array_is_array(v: Local) -> JsResult<bool> {
  Ok(js::truthy(global_method("Array", "isArray")?.call(&[v], "Array.isArray")?))
}

/// `arr.push(value)` through `arr`'s own `push` lookup (patched `Array.prototype.push`, own
/// `push` methods and frozen arrays behave like the TS). `expr` = the TS callee text
/// (`fieldPromises.push`).
pub fn push(arr: Local, value: Local, expr: &str) -> JsResult<Local> {
  call_method(arr, "push", &[value], expr)
}

/// `Object.values(o)` with the current global `Object.values` (returns what it returns). For
/// `Object.values(<expr>)` whose argument expression has effects, evaluate
/// `global_method("Object", "values")` first, then the argument, then call.
pub fn object_values(o: Local) -> JsResult<Local> {
  global_method("Object", "values")?.call(&[o], "Object.values")
}

/// `Object.entries(o)` with the current global `Object.entries` (see [`object_values`]).
pub fn object_entries(o: Local) -> JsResult<Local> {
  global_method("Object", "entries")?.call(&[o], "Object.entries")
}

/// Engine-created `new Error(message)` (same class and message as the TS reference).
pub fn new_error(message: &str) -> JsResult<js::Thrown> {
  let e = call_host(&host()?.new_error, &[js::string(message)])?;
  Ok(js::Thrown(js::Val::from_local(e)?))
}
