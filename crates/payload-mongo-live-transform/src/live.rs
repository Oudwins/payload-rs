//! JS-semantic operations on live values.
//!
//! Plain property reads / `in` checks on objects / `typeof` / truthiness / `===` go straight through
//! Node-API (they are the same [[Get]] / [[HasProperty]] operations the TS performs, proxies and
//! getters included, and none of them looks up a built-in). Every other upstream expression is a JS
//! helper of `helpers.js` compiled once per env ([`install`]), so built-ins are looked up and called
//! where the TS does (see the header of helpers.js).
//!
//! `for...in` / `for...of` loops whose body is Rust call back into Rust through [`with_callback`]:
//! the JS loop runs, every iteration calls the Rust closure, a closure error is thrown into the JS
//! loop (aborting it exactly like a TS throw, iterator `return()` included) and comes back out as
//! the same value. Those loop functions never reach user code. Callbacks that do reach user code
//! (`some` / `find` / `map` / `forEach` arguments) are JS closures of helpers.js calling the
//! stateless natives of [`crate::transform::NATIVES`], so user code may keep, re-enter and reflect
//! on them like on upstream's arrow functions.

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::rc::Rc;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Persist, Thrown, Type, Val};

const HELPERS_SOURCE: &str = include_str!("helpers.js");

macro_rules! helpers {
  ($($field:ident: $js:literal,)*) => {
    pub(crate) struct Helpers {
      $(pub $field: Persist,)*
    }

    fn load_helpers(obj: Local) -> JsResult<Helpers> {
      Ok(Helpers { $($field: Persist::new(js::get_named(obj, $js)?)?,)* })
    }
  };
}

helpers! {
  get: "get",
  set: "set",
  del: "del",
  has: "has",
  is_array: "isArray",
  for_in: "forIn",
  for_of: "forOf",
  less_than: "lessThan",
  to_property_string: "toPropertyString",
  not_a_function: "notAFunction",
  object: "object",
  destructure_transform_args: "destructureTransformArgs",
  config_of: "configOf",
  doc_state: "docState",
  flatten_all_fields: "flattenAllFields",
  to_number: "toNumber",
  now_iso_string: "nowISOString",
  top_reserved_keys: "topReservedKeys",
  new_reserved_keys: "newReservedKeys",
  strip_key_condition: "stripKeyCondition",
  field_value: "fieldValue",
  should_be_localized: "shouldBeLocalized",
  push_block_type: "pushBlockType",
  has_nested_fields: "hasNestedFields",
  locale_code_missing: "localeCodeMissing",
  is_rows_field: "isRowsField",
  is_array_field: "isArrayField",
  find_strip_block: "findStripBlock",
  filter_boolean: "filterBoolean",
  assign_filtered: "assignFiltered",
  traverse_fields: "traverseFields",
  run_callback_stack: "runCallbackStack",
  is_tabs_field: "isTabsField",
  named_tab: "namedTab",
  tab_ref_missing: "tabRefMissing",
  spread_tab: "spreadTab",
  tab_path: "tabPath",
  child_path: "childPath",
  has_sub_fields_or_blocks: "hasSubFieldsOrBlocks",
  named_field: "namedField",
  localized_group_condition: "localizedGroupCondition",
  affects_data: "affectsData",
  optional_name_path: "optionalNamePath",
  rows_condition: "rowsCondition",
  fields_condition: "fieldsCondition",
  named_path: "namedPath",
  is_block_row: "isBlockRow",
  find_row_block: "findRowBlock",
  optional_fields: "optionalFields",
  localized_or: "localizedOr",
  clear_empty_container: "clearEmptyContainer",
  inc_condition: "incCondition",
  is_inc_value: "isIncValue",
  path_key: "pathKey",
  locale_path_key: "localePathKey",
  delete_field_of: "deleteFieldOf",
  push_condition: "pushCondition",
  relationship_operation_condition: "relationshipOperationCondition",
  operation_value_condition: "operationValueCondition",
  localized_condition: "localizedCondition",
  has_operand: "hasOperand",
  locale_operations: "localeOperations",
  operand_items: "operandItems",
  items_of: "itemsOf",
  each: "each",
  in_operator: "in",
  process_relationship_values: "processRelationshipValues",
  date_condition: "dateCondition",
  is_date: "isDate",
  to_iso_string: "toISOString",
  set_field_of: "setFieldOf",
  relationship_type_condition: "relationshipTypeCondition",
  for_of_codes: "forOfCodes",
  is_join_field: "isJoinField",
  join_docs_condition: "joinDocsCondition",
  polymorphic_join_item: "polymorphicJoinItem",
  json_round_trip: "jsonRoundTrip",
  find_collection: "findCollection",
  map_relationship_values: "mapRelationshipValues",
  relation_object: "relationObject",
  custom_id_field: "customIDField",
  custom_id_is_number: "customIDIsNumber",
  new_object_id: "newObjectId",
  destructure_handle_error: "destructureHandleError",
  first_key: "firstKey",
  extract_field_from_message: "extractFieldFromMessage",
  last_index_of_dot: "lastIndexOfDot",
  substring_after_index: "substringAfterIndex",
  substring_to_index: "substringToIndex",
  validation_error_data: "validationErrorData",
  new_validation_error: "newValidationError",
  destructure_get_collection: "destructureGetCollection",
  destructure_get_global: "destructureGetGlobal",
  destructure_get_db_name: "destructureGetDBName",
  find_global: "findGlobal",
  new_api_error: "newAPIError",
  collection_entity: "collectionEntity",
  global_entity: "globalEntity",
}

thread_local! {
  static HELPERS: RefCell<Option<Rc<Helpers>>> = const { RefCell::new(None) };
}

/// Compiles the helpers for `deps = { APIError, flattenAllFields, Types, ValidationError }` (the
/// values `@payloadcms/db-mongodb` imports: payload's `APIError` / `ValidationError` /
/// `flattenAllFields` and mongoose's `Types`). Call once per env before any other function of this
/// crate; calling it again replaces the helpers.
pub fn install(deps: Local) -> JsResult<()> {
  let mut factory = ptr::null_mut();
  js::check(unsafe { sys::napi_run_script(js::env(), js::string(HELPERS_SOURCE).0, &mut factory) })?;
  let native = js::object();
  for (name, f) in crate::transform::NATIVES {
    js::set_named(native, name, js::create_function(name, *f, ptr::null_mut()))?;
  }
  let obj = js::call(Local(factory), js::undefined(), &[deps, native])?;
  let helpers = load_helpers(obj)?;
  HELPERS.with(|h| *h.borrow_mut() = Some(Rc::new(helpers)));

  let mut factory = ptr::null_mut();
  js::check(unsafe { sys::napi_run_script(js::env(), js::string(FAST_SOURCE).0, &mut factory) })?;
  let native = js::object();
  for (name, f) in crate::transform::FAST_NATIVES {
    js::set_named(native, name, js::create_function(name, *f, ptr::null_mut()))?;
  }
  let obj = js::call(Local(factory), js::undefined(), &[deps, native])?;
  let fast = Persist::new(js::get_named(obj, "transform")?)?;
  FAST.with(|f| *f.borrow_mut() = Some(Rc::new(fast)));
  let stats = Persist::new(js::get_named(obj, "stats")?)?;
  FAST_STATS.with(|f| *f.borrow_mut() = Some(Rc::new(stats)));
  Ok(())
}

const FAST_SOURCE: &str = include_str!("fast.js");

thread_local! {
  static FAST: RefCell<Option<Rc<Persist>>> = const { RefCell::new(None) };
  static FAST_STATS: RefCell<Option<Rc<Persist>>> = const { RefCell::new(None) };
}

/// fast.js `stats()`: `{ fastDocs, slowCalls, slowDocs }`.
pub(crate) fn fast_stats() -> JsResult<Local> {
  let stats = FAST_STATS
    .with(|f| f.borrow().clone())
    .ok_or_else(|| js::engine_error("payload-mongo-live-transform is not initialized (call init(deps) first)"))?;
  js::call(stats.get(), js::undefined(), &[])
}

/// fast.js `transform` (the live engine's entry, register.rs).
pub(crate) fn fast_transform() -> JsResult<Rc<Persist>> {
  FAST
    .with(|f| f.borrow().clone())
    .ok_or_else(|| js::engine_error("payload-mongo-live-transform is not initialized (call init(deps) first)"))
}

pub(crate) fn helpers() -> JsResult<Rc<Helpers>> {
  HELPERS
    .with(|h| h.borrow().clone())
    .ok_or_else(|| js::engine_error("payload-mongo-live-transform is not initialized (call init(deps) first)"))
}

/// Whether [`install`] ran on this thread.
pub fn is_installed() -> bool {
  HELPERS.with(|h| h.borrow().is_some())
}

pub(crate) fn call(f: &Persist, args: &[Local]) -> JsResult<Local> {
  js::call(f.get(), js::undefined(), args)
}

/// `helper(args)` tested for truthiness.
pub(crate) fn test(f: &Persist, args: &[Local]) -> JsResult<bool> {
  Ok(js::truthy(call(f, args)?))
}

/// `o[k]` for any `o` (TypeError on null / undefined, primitive wrappers for primitives).
pub(crate) fn get(h: &Helpers, o: Local, k: Local) -> JsResult<Local> {
  if js::type_of(o).is_object_like() { js::get_property(o, k) } else { call(&h.get, &[o, k]) }
}

pub(crate) fn get_named(h: &Helpers, o: Local, name: &str) -> JsResult<Local> {
  get(h, o, js::key(name))
}

/// `o?.[k]`
pub(crate) fn get_optional(h: &Helpers, o: Local, name: &str) -> JsResult<Local> {
  match js::type_of(o) {
    Type::Undefined | Type::Null => Ok(js::undefined()),
    _ => get_named(h, o, name),
  }
}

/// `k in o` (V8's TypeError when `o` is not an object).
pub(crate) fn has(h: &Helpers, o: Local, k: Local) -> JsResult<bool> {
  if js::type_of(o).is_object_like() { js::has_property(o, k) } else { test(&h.has, &[k, o]) }
}

pub(crate) fn has_named(h: &Helpers, o: Local, name: &str) -> JsResult<bool> {
  has(h, o, js::key(name))
}

/// `o[k] = v` in strict mode.
pub(crate) fn set(h: &Helpers, o: Local, k: Local, v: Local) -> JsResult<()> {
  call(&h.set, &[o, k, v]).map(|_| ())
}

pub(crate) fn set_named(h: &Helpers, o: Local, name: &str, v: Local) -> JsResult<()> {
  set(h, o, js::key(name), v)
}

/// `delete o[k]` in strict mode.
pub(crate) fn del(h: &Helpers, o: Local, k: Local) -> JsResult<()> {
  call(&h.del, &[o, k]).map(|_| ())
}

pub(crate) fn del_named(h: &Helpers, o: Local, name: &str) -> JsResult<()> {
  del(h, o, js::key(name))
}

/// `typeof v === 'object'` (true for null).
pub(crate) fn is_typeof_object(v: Local) -> bool {
  matches!(js::type_of(v), Type::Object | Type::Null | Type::External)
}

/// `v && typeof v === 'object'`
pub(crate) fn is_object(v: Local) -> bool {
  matches!(js::type_of(v), Type::Object | Type::External) && js::truthy(v)
}

pub(crate) fn is_nullish(v: Local) -> bool {
  matches!(js::type_of(v), Type::Undefined | Type::Null)
}

/// `Array.isArray(v)`, through the global `Array.isArray` at call time.
pub(crate) fn is_array(h: &Helpers, v: Local) -> JsResult<bool> {
  test(&h.is_array, &[v])
}

/// `typeof v === 'string' && v === s`
pub(crate) fn is_str(v: Local, s: &str) -> bool {
  js::str_equals(v, s)
}

/// `` `${v}` `` as UTF-16 code units.
pub(crate) fn to_string_utf16(h: &Helpers, v: Local) -> JsResult<Vec<u16>> {
  if let Some(units) = js::get_string_utf16(v) {
    return Ok(units);
  }
  let s = call(&h.to_property_string, &[v])?;
  Ok(js::get_string_utf16(s).unwrap_or_default())
}

pub(crate) fn string_utf16(units: &[u16]) -> Local {
  let mut v = ptr::null_mut();
  unsafe { sys::napi_create_string_utf16(js::env(), units.as_ptr(), units.len() as isize, &mut v) };
  Local(v)
}

pub(crate) fn utf16(s: &str) -> Vec<u16> {
  s.encode_utf16().collect()
}

/// Elements of a fresh array literal a helper returned (destructured parameters): own data
/// elements, reading them is not observable.
pub(crate) fn elements<const N: usize>(arr: Local) -> JsResult<[Local; N]> {
  let mut out = [js::undefined(); N];
  for (i, slot) in out.iter_mut().enumerate() {
    *slot = js::get_element(arr, i as u32)?;
  }
  Ok(out)
}

/// `a < b` for a loop counter and a length (`Number` fast path).
pub(crate) fn less_than(h: &Helpers, i: u32, len: Local) -> JsResult<bool> {
  if js::type_of(len) == Type::Number {
    return Ok(f64::from(i) < js::get_f64(len));
  }
  test(&h.less_than, &[js::number(f64::from(i)), len])
}

/// Calls `obj[name]()` (the property is read once, `this` is `obj`). When the value is not
/// callable, throws V8's `TypeError: <expression> is not a function`.
pub(crate) fn call_method(h: &Helpers, obj: Local, name: &str, expression: &str, args: &[Local]) -> JsResult<Local> {
  let f = get_named(h, obj, name)?;
  if js::type_of(f) != Type::Function {
    let e = call(&h.not_a_function, &[js::string(expression)])?;
    return Err(Thrown(Val::from_local(e)?));
  }
  js::call(f, obj, args)
}

/// Converts the outcome of a native body into the napi return value (errors become the pending
/// JS exception, panics an engine `Error`).
pub(crate) fn finish(result: std::thread::Result<JsResult<Local>>) -> sys::napi_value {
  match result {
    Ok(Ok(v)) => v.0,
    Ok(Err(Thrown(e))) => {
      // release the engine's reference (a primitive's slot) before the exception is pending:
      // slot cleanup calls into JS, which a pending exception would abort
      let value = e.get();
      drop(e);
      js::throw(value);
      ptr::null_mut()
    }
    Err(_) => {
      let Thrown(e) = js::engine_error("payload-mongo-live-transform panicked");
      js::throw(e.get());
      ptr::null_mut()
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Rust bodies of internal JS loops

type CallbackDyn<'a> = dyn FnMut(Local) -> JsResult<()> + 'a;
type Callback = CallbackDyn<'static>;

thread_local! {
  /// Loop bodies currently on the Rust stack: `(token, closure)`. Only the loop helpers of this
  /// module hold the JS functions (user code never sees them), and the entry is removed when
  /// [`with_callback`] returns.
  static CALLBACKS: RefCell<Vec<(usize, Option<*mut Callback>)>> = const { RefCell::new(Vec::new()) };
  static NEXT_TOKEN: Cell<usize> = const { Cell::new(1) };
}

unsafe extern "C" fn trampoline(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
  let (args, data) = js::callback_args::<1>(env, info);
  let token = data as usize;
  let f = CALLBACKS.with(|c| {
    let mut c = c.borrow_mut();
    c.iter_mut().rev().find(|(t, _)| *t == token).and_then(|(_, f)| f.take())
  });
  let Some(f) = f else {
    let Thrown(e) = js::engine_error("payload-mongo-live-transform: loop body called outside its loop");
    js::throw(e.get());
    return ptr::null_mut();
  };
  let result = catch_unwind(AssertUnwindSafe(|| unsafe { (*f)(args[0]) }));
  CALLBACKS.with(|c| {
    if let Some(entry) = c.borrow_mut().iter_mut().rev().find(|(t, _)| *t == token) {
      entry.1 = Some(f);
    }
  });
  finish(result.map(|r| r.map(|()| js::undefined())))
}

/// Runs `body` with a JS function that calls `f(arg0)`. Errors `f` returns are thrown into the
/// calling JS code.
fn with_callback<R>(f: &mut CallbackDyn<'_>, body: impl FnOnce(Local) -> JsResult<R>) -> JsResult<R> {
  let token = NEXT_TOKEN.with(|t| {
    let v = t.get();
    t.set(v.wrapping_add(1).max(1));
    v
  });
  // SAFETY: the entry is removed before `f`'s borrow ends (below), and the trampoline only calls
  // closures that are still registered.
  let raw: *mut Callback = unsafe { std::mem::transmute::<*mut CallbackDyn<'_>, *mut Callback>(f as *mut CallbackDyn<'_>) };
  CALLBACKS.with(|c| c.borrow_mut().push((token, Some(raw))));
  struct Unregister(usize);
  impl Drop for Unregister {
    fn drop(&mut self) {
      let _ = CALLBACKS.try_with(|c| c.borrow_mut().retain(|(t, _)| *t != self.0));
    }
  }
  let _guard = Unregister(token);
  let func = js::create_function("", trampoline, token as *mut c_void);
  body(func)
}

/// `loop_helper(subject, (item) => body(item))` for the `for...in` / `for...of` helpers.
pub(crate) fn run_loop(helper: &Persist, subject: Local, mut body: impl FnMut(Local) -> JsResult<()>) -> JsResult<()> {
  with_callback(&mut |item| body(item), |cb| call(helper, &[subject, cb]).map(|_| ()))
}

/// `for (const k in o) body(k)`
pub(crate) fn for_in(h: &Helpers, o: Local, body: impl FnMut(Local) -> JsResult<()>) -> JsResult<()> {
  run_loop(&h.for_in, o, body)
}

/// `for (const item of iterable) body(item)` (the real iterator protocol, `return()` included).
pub(crate) fn for_of(h: &Helpers, iterable: Local, body: impl FnMut(Local) -> JsResult<()>) -> JsResult<()> {
  run_loop(&h.for_of, iterable, body)
}

/// `isObjectID(value)` (packages/db-mongodb/src/utilities/isObjectID.ts)
pub fn is_object_id(value: Local) -> JsResult<bool> {
  if !is_object(value) {
    return Ok(false);
  }
  if !js::has_property(value, js::key("_bsontype"))? {
    return Ok(false);
  }
  if !is_str(js::get_named(value, "_bsontype")?, "ObjectId") {
    return Ok(false);
  }
  if !js::has_property(value, js::key("toHexString"))? {
    return Ok(false);
  }
  Ok(js::type_of(js::get_named(value, "toHexString")?) == Type::Function)
}
