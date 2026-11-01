//! JS helpers the runtime calls for operations whose exact JS semantics (error messages,
//! strict-mode behaviour, spread/`Object.values` coercions, Payload error classes, population)
//! must not be re-implemented, plus JS-semantic property operations.

use std::cell::RefCell;
use std::rc::Rc;

use crate::executor;
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
  executor::install_await_helper(js::get_named(obj, "awaitValue")?)?;
  executor::install_then_return_helper(js::get_named(obj, "thenReturn")?)?;
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

/// `delete o[k]` in strict mode.
pub fn del(o: Local, k: Local) -> JsResult<()> {
  if js::type_of(o).is_object_like() && js::delete_property(o, k)? {
    return Ok(());
  }
  call_host(&host()?.del, &[o, k]).map(|_| ())
}

/// `Object.values(o)` (returns a JS array).
pub fn object_values(o: Local) -> JsResult<Local> {
  call_host(&host()?.object_values, &[o])
}

/// `Object.entries(o)` (returns a JS array of `[key, value]` pairs).
pub fn object_entries(o: Local) -> JsResult<Local> {
  call_host(&host()?.object_entries, &[o])
}

/// Engine-created `new Error(message)` (same class and message as the TS reference).
pub fn new_error(message: &str) -> JsResult<js::Thrown> {
  let e = call_host(&host()?.new_error, &[js::string(message)])?;
  Ok(js::Thrown(js::Val::from_local(e)?))
}
