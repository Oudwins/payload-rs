//! JS helpers specific to the beforeChange port, installed by the binding's `init`. Each one is
//! either a Payload utility the TS code calls (deep merge, flattenValidationData,
//! validateBlocksFilterOptions, isolateObjectProperty, ValidationError, ...) or an expression of
//! `promise.ts` copied verbatim (label building, object literals with their key order) so its
//! evaluation order and V8 error messages stay identical.

use std::cell::RefCell;
use std::rc::Rc;

use payload_core_runtime::host as rt;
use payload_core_runtime::js::{self, JsResult, Local, Persist, Thrown, Type, Val};

pub struct ChangeHost {
  pub hook_args: Persist,
  pub editor_hook_args: Persist,
  pub validate_options: Persist,
  pub locale_context: Persist,
  pub locales_in: Persist,
  pub isolate_locale: Persist,
  pub deep_merge: Persist,
  pub try_json_parse: Persist,
  pub validate_blocks_filter_options: Persist,
  pub blocks_filter_options_errors: Persist,
  pub label_field: Persist,
  pub label_field_error: Persist,
  pub label_array_row: Persist,
  pub label_block_row: Persist,
  pub label_collapsible: Persist,
  pub label_group: Persist,
  pub label_tab: Persist,
  pub label_tabs: Persist,
  pub label_editor: Persist,
  pub record_new_doc: Persist,
  pub validation_error: Persist,
  pub merge_locale_action: Persist,
  pub in_op: Persist,
  pub parse_float: Persist,
  pub object_prototype: Persist,
  /// `traverseFields` over a run of leaf fields: pushes upstream's `promise()` of each (a JS
  /// `async` function) into the traversal's promises array.
  pub before_change_leaves: Persist,
  /// `traverseFields(...)` for a fields array made only of leaf fields: upstream's
  /// `traverseFields.ts` body (a JS `async` function) calling the leaf `promise()` per field.
  pub before_change_leaf_traversal: Persist,
}

thread_local! {
  static HOST: RefCell<Option<Rc<ChangeHost>>> = const { RefCell::new(None) };
}

pub fn install(obj: Local) -> JsResult<()> {
  let f = |name: &str| -> JsResult<Persist> { Persist::new(js::get_named(obj, name)?) };
  let host = ChangeHost {
    hook_args: f("hookArgs")?,
    editor_hook_args: f("editorHookArgs")?,
    validate_options: f("validateOptions")?,
    locale_context: f("localeContext")?,
    locales_in: f("localesIn")?,
    isolate_locale: f("isolateLocale")?,
    deep_merge: f("deepMergeWithSourceArrays")?,
    try_json_parse: f("tryJSONParse")?,
    validate_blocks_filter_options: f("validateBlocksFilterOptions")?,
    blocks_filter_options_errors: f("blocksFilterOptionsErrors")?,
    label_field: f("labelField")?,
    label_field_error: f("labelFieldError")?,
    label_array_row: f("labelArrayRow")?,
    label_block_row: f("labelBlockRow")?,
    label_collapsible: f("labelCollapsible")?,
    label_group: f("labelGroup")?,
    label_tab: f("labelTab")?,
    label_tabs: f("labelTabs")?,
    label_editor: f("labelEditor")?,
    record_new_doc: f("recordNewDoc")?,
    validation_error: f("validationError")?,
    merge_locale_action: f("mergeLocaleAction")?,
    in_op: f("inOp")?,
    parse_float: f("parseFloat")?,
    object_prototype: f("objectPrototype")?,
    before_change_leaves: f("beforeChangeLeaves")?,
    before_change_leaf_traversal: f("beforeChangeLeafTraversal")?,
  };
  HOST.with(|h| *h.borrow_mut() = Some(Rc::new(host)));
  Ok(())
}

pub fn change_host() -> JsResult<Rc<ChangeHost>> {
  HOST
    .with(|h| h.borrow().clone())
    .ok_or_else(|| js::engine_error("beforeChange binding not initialized"))
}

/// `key in obj` (TypeError for primitives, like the operator).
pub fn in_op(key: Local, obj: Local) -> JsResult<bool> {
  if js::type_of(obj).is_object_like() {
    return js::has_property(obj, key);
  }
  let r = rt::call_host(&change_host()?.in_op, &[key, obj])?;
  Ok(js::truthy(r))
}

/// `new TypeError(message)` (engine-created; same class and message as V8 would throw).
pub fn type_error(message: &str) -> Thrown {
  let mut err = std::ptr::null_mut();
  unsafe {
    napi::sys::napi_create_type_error(
      js::env(),
      std::ptr::null_mut(),
      js::string(message).0,
      &mut err,
    )
  };
  Thrown(Val::from_local(Local(err)).unwrap_or(Val::Undefined))
}

/// A call expression `callee(...args)`: V8 throws `TypeError: <callee text> is not a function`
/// for non-callables before evaluating anything else.
pub fn call_fn(callee_text: &str, f: Local, this: Local, args: &[Local]) -> JsResult<Local> {
  if js::type_of(f) != Type::Function {
    return Err(type_error(&format!("{callee_text} is not a function")));
  }
  js::call(f, this, args)
}
