//! Port of `packages/payload/src/fields/hooks/beforeValidate/*` (index.ts, traverseFields.ts,
//! promise.ts, getFallbackValue.ts) on the payload-core-runtime (RUST_CORE_DESIGN.md, strategy B).
//!
//! The binding object (`hooksBeforeValidateBinding()` of the `payload-node` addon) exposes
//! `init(host)`, `beforeValidate(args)` and `traverseFields(args)`. It shares the runtime's
//! executor, slot table and host (`coreRuntimeBinding().init(...)` must have run first; the TS glue
//! in `packages/engine-rs/src/runtime/beforeValidate` does that).

use std::cell::RefCell;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::rc::Rc;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Persist, Thrown};

pub mod before_validate;

/// JS helpers specific to beforeValidate: upstream utilities called at the same point as the TS
/// (`unflattenData`, `stripNullRows`, `getExistingRowDoc`, `cloneDataFromOriginalDoc`), JS
/// builtins whose exact semantics must not be re-implemented (`parseFloat`, `String#trim`,
/// `JSON.parse`, spread), and the hook args object literals (same key order and shape).
pub struct BvHost {
  pub unflatten_data: Persist,
  pub strip_null_rows: Persist,
  pub get_existing_row_doc: Persist,
  pub clone_data_from_original_doc: Persist,
  pub parse_float: Persist,
  pub trim: Persist,
  pub json_parse: Persist,
  pub spread_parse_value: Persist,
  pub hook_args: Persist,
  pub editor_hook_args: Persist,
  /// payload's `skipCompilation` (utilities/skipCompilation.ts), passed in field access args.
  pub skip_compilation: Persist,
  /// `traverseFields` over a run of leaf fields: pushes upstream's `promise()` of each (a JS
  /// `async` function, see `before_validate::is_leaf`) into the traversal's promises array.
  pub before_validate_leaves: Persist,
  /// `traverseFields(...)` for a fields array made only of leaf fields: upstream's
  /// `traverseFields.ts` body (a JS `async` function) calling the leaf `promise()` per field.
  pub before_validate_leaf_traversal: Persist,
}

thread_local! {
  static BV_HOST: RefCell<Option<Rc<BvHost>>> = const { RefCell::new(None) };
}

fn install(obj: Local) -> JsResult<()> {
  let f = |name: &str| -> JsResult<Persist> { Persist::new(js::get_named(obj, name)?) };
  let host = BvHost {
    unflatten_data: f("unflattenData")?,
    strip_null_rows: f("stripNullRows")?,
    get_existing_row_doc: f("getExistingRowDoc")?,
    clone_data_from_original_doc: f("cloneDataFromOriginalDoc")?,
    parse_float: f("parseFloat")?,
    trim: f("trim")?,
    json_parse: f("jsonParse")?,
    spread_parse_value: f("spreadParseValue")?,
    hook_args: f("hookArgs")?,
    editor_hook_args: f("editorHookArgs")?,
    skip_compilation: f("skipCompilation")?,
    before_validate_leaves: f("beforeValidateLeaves")?,
    before_validate_leaf_traversal: f("beforeValidateLeafTraversal")?,
  };
  BV_HOST.with(|h| *h.borrow_mut() = Some(Rc::new(host)));
  Ok(())
}

pub fn bv_host() -> JsResult<Rc<BvHost>> {
  BV_HOST
    .with(|h| h.borrow().clone())
    .ok_or_else(|| js::engine_error("beforeValidate binding not initialized"))
}

type Body<const N: usize> = fn([Local; N]) -> JsResult<Local>;

/// Sets the env, converts `Err(Thrown)` into a JS throw, never lets a panic cross the FFI.
fn run<const N: usize>(env: sys::napi_env, info: sys::napi_callback_info, body: Body<N>) -> sys::napi_value {
  js::set_env(env);
  let (args, _) = js::callback_args::<N>(env, info);
  match catch_unwind(AssertUnwindSafe(|| body(args))) {
    Ok(Ok(v)) => v.0,
    Ok(Err(Thrown(e))) => {
      js::throw(e.get());
      ptr::null_mut()
    }
    Err(_) => {
      let Thrown(e) = js::engine_error("payload beforeValidate engine panicked");
      js::throw(e.get());
      ptr::null_mut()
    }
  }
}

macro_rules! export {
  ($name:ident, $n:literal, $body:expr) => {
    unsafe extern "C" fn $name(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
      run::<$n>(env, info, $body)
    }
  };
}

export!(init_export, 1, |[host_obj]| {
  install(host_obj)?;
  Ok(js::undefined())
});

export!(before_validate_export, 1, |[args]| before_validate::before_validate(args));

export!(traverse_fields_export, 1, |[args]| before_validate::traverse_fields_entry(args));

fn create() -> JsResult<Local> {
  let o = js::object();
  js::set_named(o, "init", js::create_function("init", init_export, ptr::null_mut()))?;
  js::set_named(
    o,
    "beforeValidate",
    js::create_function("beforeValidate", before_validate_export, ptr::null_mut()),
  )?;
  js::set_named(
    o,
    "traverseFields",
    js::create_function("traverseFields", traverse_fields_export, ptr::null_mut()),
  )?;
  Ok(o)
}

/// Entry for addons: builds the binding object.
///
/// # Safety
/// Must be called on the JS thread from inside a napi callback (`env` is that call's env).
pub unsafe fn create_binding(env: sys::napi_env) -> sys::napi_value {
  js::set_env(env);
  match create() {
    Ok(v) => v.0,
    Err(Thrown(e)) => {
      js::throw(e.get());
      ptr::null_mut()
    }
  }
}
