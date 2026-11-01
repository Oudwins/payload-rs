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
//! Each native is a specialized entry point `(tags, ...strings, ...bindings)`:
//! - the tag word packs the `typeof` / truthiness (and for `relationship` / `upload` values the
//!   `Array.isArray` answer) of the first 7 bindings, 4 bits each (shell.js `pk` / `atag`): pure
//!   facts the shell already holds, so the natives need no Node-API call to classify them
//!   (`text`, `number` and `relationship` take `minRows` / `maxRows` last; the ones past the 7th
//!   are unclassified until the branch that uses them, `Cx::classify`);
//! - the strings are the property keys and literals of the native's common path (keys.rs),
//!   written into the shell's call sites from the `natives!` table below (`shell_source`), so
//!   no key is created per call.
//!
//! Porting rules:
//! - builtins whose results depend on V8 internals (`ToPrimitive` comparisons, `String` of
//!   symbols, `Number` of objects / bigints, `Date.parse`, `JSON.stringify` in the messages, the
//!   email regex, `bson-objectid`, `Object.keys`, `new Error`) are shell helpers copied from the
//!   TS; `ToString`, `ToNumber` and comparisons of primitives, `parseFloat` and the `isNumber` /
//!   `isValidID` utilities are ported;
//! - array methods the TS calls are looked up as the TS does and the builtin found is called
//!   with an engine callback (ops.rs); `for...of` over a JS array is a JS loop of the shell with
//!   an engine body; over an engine-created `[value]` literal the default iterator is checked and
//!   the loop runs here;
//! - object and array literals are CreateDataProperty definitions.
//!
//! Each `validateBinding` call evaluates its own shell with its own [`Cx`] (one per importing
//! module instance; never freed, like the module).

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::sync::OnceLock;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Thrown, check};

mod async_validators;
mod keys;
mod ops;
mod validators;

use keys::{K, KeyList};
pub use ops::{Cx, V};

const SHELL: &str = include_str!("shell.js");

/// Upper bound of `1 + strings + bindings` of a native (checked per native at compile time).
const MAX_ARGS: usize = 32;

type Native<const N: usize> = fn(&Cx, [V; N]) -> JsResult<Local>;

/// Calls `body` with the bindings of a shell call `(tags, ...strings, ...bindings)`.
/// Sets the env and the call's strings ([`Cx::k`]), converts `Err(Thrown)` into a JS throw,
/// never lets a panic cross the FFI.
#[inline(always)]
fn run<const N: usize>(
  env: sys::napi_env,
  info: sys::napi_callback_info,
  keys: &'static KeyList,
  body: Native<N>,
) -> sys::napi_value {
  js::set_env(env);
  let mut argv = [ptr::null_mut(); MAX_ARGS];
  let mut argc = 1 + keys.keys.len() + N;
  let mut data = ptr::null_mut();
  // Arguments the shell did not pass are `undefined` (and tagged 0).
  unsafe { sys::napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), ptr::null_mut(), &mut data) };
  // SAFETY: every native is created by `natives` with a leaked `Cx` as its data.
  let cx = unsafe { &*(data as *const Cx) };
  let tags = cx.u32_value(Local(argv[0]));
  let base = 1 + keys.keys.len();
  // The first 7 bindings are tagged by the shell; the natives classify the others where they
  // use them (`Cx::classify`).
  let args: [V; N] = std::array::from_fn(|i| {
    let v = Local(argv[base + i]);
    if i < 7 { V::tagged(v, ((tags >> (4 * i)) & 15) as u8) } else { V::unclassified(v) }
  });
  let frame = ops::Frame { keys: argv[1..].as_ptr(), count: keys.keys.len().min(argc.saturating_sub(1)), map: &keys.map };
  let previous = cx.enter(&frame);
  let result = catch_unwind(AssertUnwindSafe(|| body(cx, args)));
  cx.leave(previous);
  finish(result)
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
  ($($js:literal => $name:ident[$n:literal] $path:path, [$($key:ident),*];)*) => {
    $(
      unsafe extern "C" fn $name(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
        const _: () = assert!(1 + <[K]>::len(&[$(K::$key),*]) + $n <= MAX_ARGS);
        static KEYS: KeyList = KeyList::new(&[$(K::$key),*]);
        run::<$n>(env, info, &KEYS, $path)
      }
    )*

    fn natives(cx: *const Cx) -> JsResult<Local> {
      let o = js::object();
      js::set_named(o, "callback", js::create_function("", engine_callback, cx.cast_mut().cast()))?;
      $(js::set_named(o, $js, js::create_function($js, $name, cx.cast_mut().cast()))?;)*
      Ok(o)
    }

    /// The strings each native receives, for the shell's `/*K:<native>*/` markers.
    const KEY_LISTS: &[(&str, &[K])] = &[$(($js, &[$(K::$key),*])),*];
  };
}

natives! {
  "text" => text_native[9] validators::text, [DefaultMaxTextLength];
  "password" => password_native[6] validators::password, [DefaultMaxTextLength];
  "confirmPassword" => confirm_password_native[4] validators::confirm_password, [Password];
  "email" => email_native[7] validators::email,
    [Config, Auth, LoginWithUsername, RequireUsername, RequireEmail, Username];
  "username" => username_native[7] validators::username,
    [Config, Auth, LoginWithUsername, RequireUsername, RequireEmail, Email, DefaultMaxTextLength];
  "textarea" => textarea_native[6] validators::textarea, [DefaultMaxTextLength];
  "code" => code_native[3] validators::code, [];
  "json" => json_native[5] async_validators::json, [];
  "checkbox" => checkbox_native[3] validators::checkbox, [];
  "date" => date_native[6] validators::date, [ToString];
  "richText" => rich_text_native[2] async_validators::rich_text, [Editor, Validate];
  "number" => number_native[8] validators::number, [];
  "array" => array_native[5] validators::array, [];
  "allBlockSlugs" => all_block_slugs_native[1] async_validators::all_block_slugs, [Map, Filter, BlockType];
  "blocksFilterResult" => blocks_filter_result_native[2] async_validators::blocks_filter_result,
    [Includes, Push, AllBlockSlugs, AllowedBlockSlugs, InvalidBlockSlugs];
  "blocks" => blocks_native[6] async_validators::blocks, [];
  "blocksInvalid" => blocks_invalid_native[2] async_validators::blocks_invalid, [];
  "relationship" => relationship_native[8] async_validators::relationship,
    [Filter, RelationTo, Value, Collections, CustomIDType, Db, DefaultIDType];
  "filterOptionsFind" => filter_options_find_native[6] async_validators::filter_options_find,
    [ForEach, Value, Push, Id, In, And, Collection, Depth, DisableErrors, Limit, OverrideAccess, Pagination, Req, Where];
  "docIDs" => doc_ids_native[1] async_validators::doc_ids, [Docs, Map, Id];
  "filterOptionsResult" => filter_options_result_native[5] async_validators::filter_options_result,
    [Filter, RelationTo, Value, Find, IndexOf];
  "select" => select_native[5] async_validators::select, [SomeKey, Value];
  "radio" => radio_native[4] validators::radio, [SomeKey, Value];
  "point" => point_native[3] validators::point, [Length];
}

/// The shell's `callback` (passed to builtin array methods): runs the closure the engine set
/// around the helper call that passes it (ops.rs `with_engine_callback`).
unsafe extern "C" fn engine_callback(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
  js::set_env(env);
  let mut argc = 1;
  let mut argv = [ptr::null_mut(); 1];
  let mut data = ptr::null_mut();
  unsafe { sys::napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), ptr::null_mut(), &mut data) };
  // SAFETY: created by `natives` with the binding's leaked `Cx` as its data.
  let cx = unsafe { &*(data as *const Cx) };
  finish(match cx.engine_closure() {
    // SAFETY: the closure outlives the helper call it was set around (`with_engine_callback`).
    Some(f) => catch_unwind(AssertUnwindSafe(|| unsafe { (*f)(Local(argv[0])) })),
    None => Ok(Err(js::engine_error("payload validator callback called outside a validator"))),
  })
}

/// `shell.js` with each `/*K:<native>*/` marker replaced by the native's strings (`, 'a', 'b'`).
fn shell_source() -> Result<&'static str, String> {
  static SOURCE: OnceLock<Result<String, String>> = OnceLock::new();
  SOURCE
    .get_or_init(|| {
      let mut source = SHELL.to_string();
      for (native, keys) in KEY_LISTS {
        // Every call site `n<Native>(` carries the marker: the strings come before the bindings.
        let marker = format!("/*K:{native}*/");
        let mut chars = native.chars();
        let callee: String = chars.next().map(|c| c.to_ascii_uppercase()).into_iter().chain(chars).collect();
        let calls = source.matches(&format!("n{callee}(")).count();
        if calls == 0 || source.matches(&marker).count() != calls {
          return Err(format!("payload validator shell: every n{callee}( call needs a {marker} marker"));
        }
        let strings: String = keys.iter().map(|k| format!(", '{}'", keys::NAMES[*k as usize])).collect();
        source = source.replace(&marker, &strings);
      }
      if source.contains("/*K:") {
        return Err("payload validator shell: marker of an unknown native".to_string());
      }
      Ok(source)
    })
    .as_deref()
    .map_err(Clone::clone)
}

/// `bootstrap(host)` called by the shell: builds the binding's [`Cx`] and returns the natives.
unsafe extern "C" fn bootstrap(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
  js::set_env(env);
  let ([host], _) = js::callback_args::<1>(env, info);
  finish(catch_unwind(AssertUnwindSafe(|| {
    let cx: *const Cx = Box::into_raw(Box::new(Cx::new(env, host)?));
    natives(cx)
  })))
}

fn create(deps: Local) -> JsResult<Local> {
  let source = shell_source().map_err(|message| js::engine_error(&message))?;
  let mut factory = ptr::null_mut();
  check(unsafe { sys::napi_run_script(js::env(), js::string(source).0, &mut factory) })?;
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
