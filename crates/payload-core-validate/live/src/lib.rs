//! Payload's default field validators (`packages/payload/src/fields/validations.ts`) on live JS
//! values (RUST_CORE_DESIGN.md, strategy B), exposed by the `payload-node` addon as
//! `validateBinding({ ObjectId, validateJSONSchema })`.
//!
//! The binding evaluates `shell.js`, which defines every validator with the upstream name,
//! parameter list and kind (sync arrow, async arrow, async function): parameter destructuring
//! and `await`s are the shell's, at the upstream positions, so sync validators stay synchronous
//! and async ones are real async functions with upstream's microtask ticks. Everything else in
//! the TS bodies runs here, in the natives the shell calls with the destructured bindings: every
//! read of `value` / options / `req` happens on the original objects at the point the TS makes
//! it, method calls go to the real methods, and V8 raises its own `TypeError`s.
//!
//! Porting rules:
//! - builtins whose results depend on V8 internals (`ToPrimitive` comparisons, `String` of
//!   symbols, `Number` of objects / bigints, `Date.parse`, `JSON.stringify` in the messages, the
//!   email regex, `bson-objectid`, `Object.keys`, `new Error`) are shell helpers copied from the
//!   TS; `ToString`, `ToNumber` of primitives, `parseFloat` and the `isNumber` / `isValidID`
//!   utilities are ported;
//! - array methods and `for...of` over JS arrays run the builtin's spec steps here only when the
//!   lookup the TS makes finds the realm's builtin (ops.rs), else the real method is called;
//! - object and array literals are CreateDataProperty definitions.
//!
//! Each `validateBinding` call evaluates its own shell with its own [`Cx`] (one per importing
//! module instance; never freed, like the module).

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Thrown, check};

mod async_validators;
mod ops;
mod validators;

pub use ops::{Cx, V};

const SHELL: &str = include_str!("shell.js");

type Native<const N: usize> = fn(&Cx, [V; N]) -> JsResult<Local>;

/// Calls `body` with the arguments of a shell call `(tags, ...args)`: `tags` packs the shell's
/// 4-bit `tag` of each argument (shell.js `run`). Sets the env, converts `Err(Thrown)` into a JS
/// throw, never lets a panic cross the FFI.
#[inline(always)]
fn run<const N: usize>(env: sys::napi_env, info: sys::napi_callback_info, body: Native<N>) -> sys::napi_value {
  js::set_env(env);
  let (raw, data) = js::callback_args::<10>(env, info);
  // SAFETY: every native is created by `natives` with a leaked `Cx` as its data.
  let cx = unsafe { &*(data as *const Cx) };
  let tags = ops::number_value(raw[0]).unwrap_or(0.0) as u64;
  let args: [V; N] = std::array::from_fn(|i| V::tagged(raw[i + 1], ((tags >> (4 * i)) & 15) as u8));
  finish(catch_unwind(AssertUnwindSafe(|| body(cx, args))))
}

fn finish(result: std::thread::Result<JsResult<Local>>) -> sys::napi_value {
  match result {
    Ok(Ok(v)) => v.0,
    Ok(Err(Thrown(e))) => {
      js::throw(e.get());
      ptr::null_mut()
    }
    Err(_) => {
      let Thrown(e) = js::engine_error("payload validator engine panicked");
      js::throw(e.get());
      ptr::null_mut()
    }
  }
}

macro_rules! natives {
  ($($js:literal => $name:ident[$n:literal] $path:path;)*) => {
    $(
      unsafe extern "C" fn $name(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
        run::<$n>(env, info, $path)
      }
    )*
    fn natives(cx: *const Cx) -> JsResult<Local> {
      let o = js::object();
      $(js::set_named(o, $js, js::create_function($js, $name, cx.cast_mut().cast()))?;)*
      Ok(o)
    }
  };
}

natives! {
  "text" => text_native[9] validators::text;
  "password" => password_native[6] validators::password;
  "confirmPassword" => confirm_password_native[4] validators::confirm_password;
  "email" => email_native[7] validators::email;
  "username" => username_native[7] validators::username;
  "textarea" => textarea_native[6] validators::textarea;
  "code" => code_native[3] validators::code;
  "json" => json_native[5] async_validators::json;
  "checkbox" => checkbox_native[3] validators::checkbox;
  "date" => date_native[6] validators::date;
  "richText" => rich_text_native[2] async_validators::rich_text;
  "number" => number_native[8] validators::number;
  "array" => array_native[5] validators::array;
  "allBlockSlugs" => all_block_slugs_native[1] async_validators::all_block_slugs;
  "blocksFilterResult" => blocks_filter_result_native[2] async_validators::blocks_filter_result;
  "blocks" => blocks_native[6] async_validators::blocks;
  "blocksInvalid" => blocks_invalid_native[2] async_validators::blocks_invalid;
  "relationship" => relationship_native[8] async_validators::relationship;
  "filterOptionsFind" => filter_options_find_native[6] async_validators::filter_options_find;
  "docIDs" => doc_ids_native[1] async_validators::doc_ids;
  "filterOptionsResult" => filter_options_result_native[5] async_validators::filter_options_result;
  "select" => select_native[5] async_validators::select;
  "radio" => radio_native[4] validators::radio;
  "point" => point_native[3] validators::point;
}

/// `bootstrap(host)` called by the shell: builds the binding's [`Cx`] and returns the natives.
unsafe extern "C" fn bootstrap(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
  js::set_env(env);
  let ([host], _) = js::callback_args::<1>(env, info);
  finish(catch_unwind(AssertUnwindSafe(|| {
    let cx: *const Cx = Box::into_raw(Box::new(Cx::new(host)?));
    natives(cx)
  })))
}

fn create(deps: Local) -> JsResult<Local> {
  let mut factory = ptr::null_mut();
  check(unsafe { sys::napi_run_script(js::env(), js::string(SHELL).0, &mut factory) })?;
  js::call(Local(factory), js::undefined(), &[js::create_function("bootstrap", bootstrap, ptr::null_mut()), deps])
}

/// Entry for addons: `validateBinding(deps)` → the validators object of a fresh shell.
///
/// # Safety
/// Must be called on the JS thread from inside a napi callback (`env` is that call's env).
pub unsafe fn create_binding(env: sys::napi_env, deps: sys::napi_value) -> sys::napi_value {
  js::set_env(env);
  finish(catch_unwind(AssertUnwindSafe(|| create(Local(deps)))))
}
