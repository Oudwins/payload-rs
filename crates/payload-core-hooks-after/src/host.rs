//! JS helpers specific to these traversals, installed by the binding's `init(host)` (the core
//! runtime's own host must be installed first: `getCoreRuntime()` does that). They exist for
//! operations whose exact JS semantics must not be re-implemented (object spread, `Object.keys`,
//! `for...of` over non-arrays with V8's error message) and to build the hook args object literals
//! in one call with upstream's key order.

use std::cell::RefCell;
use std::rc::Rc;

use payload_core_runtime::js::{self, JsResult, Local, Persist};

pub struct Host {
  /// `(o) => ({ ...o })`
  pub spread: Persist,
  /// `(o) => Object.keys(o).length`
  pub keys_length: Persist,
  /// Field `afterChange` hook args literal (afterChange/promise.ts).
  pub after_change_hook_args: Persist,
  /// Rich text editor `afterChange` hook args literal (afterChange/promise.ts).
  pub editor_after_change_hook_args: Persist,
  /// Field `beforeDuplicate` hook args literal (beforeDuplicate/promise.ts).
  pub before_duplicate_hook_args: Persist,
  /// `(hook, args) => hook(args)`: only used when `hook` is not callable, for V8's TypeError.
  pub call_hook: Persist,
  /// `for (const hook of field.hooks.afterChange)` over a non-array (collects or throws).
  pub field_after_change_hooks: Persist,
  /// `for (const hook of editor.hooks.afterChange)` over a non-array (collects or throws).
  pub editor_after_change_hooks: Persist,
  /// `for (const hook of field.hooks.beforeDuplicate)` over a non-array (collects or throws).
  pub field_before_duplicate_hooks: Persist,
  /// `for (const locale of localization.localeCodes)` over a non-array (collects or throws).
  pub locale_codes: Persist,
  /// `localization.localeCodes.forEach(...)` on a non-array: raises the TypeError.
  pub locale_codes_for_each: Persist,
}

thread_local! {
  static HOST: RefCell<Option<Rc<Host>>> = const { RefCell::new(None) };
}

pub fn install(obj: Local) -> JsResult<()> {
  let f = |name: &str| -> JsResult<Persist> { Persist::new(js::get_named(obj, name)?) };
  let host = Host {
    spread: f("spread")?,
    keys_length: f("keysLength")?,
    after_change_hook_args: f("afterChangeHookArgs")?,
    editor_after_change_hook_args: f("editorAfterChangeHookArgs")?,
    before_duplicate_hook_args: f("beforeDuplicateHookArgs")?,
    call_hook: f("callHook")?,
    field_after_change_hooks: f("fieldAfterChangeHooks")?,
    editor_after_change_hooks: f("editorAfterChangeHooks")?,
    field_before_duplicate_hooks: f("fieldBeforeDuplicateHooks")?,
    locale_codes: f("localeCodes")?,
    locale_codes_for_each: f("localeCodesForEach")?,
  };
  HOST.with(|h| *h.borrow_mut() = Some(Rc::new(host)));
  Ok(())
}

pub fn host() -> JsResult<Rc<Host>> {
  HOST
    .with(|h| h.borrow().clone())
    .ok_or_else(|| js::engine_error("core hooks (afterChange/beforeDuplicate) binding not initialized"))
}

pub fn call(f: &Persist, args: &[Local]) -> JsResult<Local> {
  js::call(f.get(), js::undefined(), args)
}
