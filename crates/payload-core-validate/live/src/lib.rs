//! Payload's default field validators (`packages/payload/src/fields/validations.ts`) on live JS
//! values, built on the payload-core-runtime (RUST_CORE_DESIGN.md, strategy B).
//!
//! Every validator reads the caller's objects through Node-API at the point the TS reads them,
//! and the async ones are Rust `async` tasks on the runtime executor that await exactly where the
//! TS awaits. Values mutated while a validator awaits (`filterOptions`, `payloadDataLoader.find`)
//! are therefore seen like TS sees them, `Date`s / `ObjectId`s / class instances keep their
//! prototypes, method calls go to the real methods, and V8 raises its own `TypeError`s.
//!
//! Porting rules:
//! - the parameter destructuring of each validator is the host's `args.<name>` helper, a copy of
//!   the TS pattern (same reads, defaults and V8 messages), called where TS destructures (inside
//!   the async function for async validators, so a throw is a rejection);
//! - arrow-function arguments (`.some(...)`, `.filter(...)`, ...) are Rust closures passed to the
//!   real JS methods ([`ops::with_callback`]);
//! - JS builtins whose results depend on V8 internals (`ToPrimitive`, `ToString`, `Date.parse`,
//!   `JSON.stringify`, the email regex, `bson-objectid`) and the message-building expressions
//!   are host helpers copied verbatim from the TS;
//! - no `Local` is kept across an `.await`.
//!
//! The binding object (`validateBinding()` of the `payload-node` addon) exposes `init(host)` and
//! one function per validator with the upstream `(value, options)` arguments
//! (`validateBlocksFilterOptions(args)`). It shares the core runtime's executor:
//! `coreRuntimeBinding().init(...)` must have run first (the TS glue does that).

use std::cell::RefCell;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::rc::Rc;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Persist, Thrown};

mod async_validators;
pub mod ops;
mod validators;

/// JS helpers the validators call (`packages/engine-rs/src/validate/validations.ts`).
pub struct VHost {
  pub is_array: Persist,
  pub lt: Persist,
  pub gt: Persist,
  pub template: Persist,
  pub string: Persist,
  pub number: Persist,
  pub parse_float: Persist,
  pub date_parse: Persist,
  pub object_id_is_valid: Persist,
  pub object_id_hex: Persist,
  pub email_test: Persist,
  pub find_collection: Persist,
  pub object_keys_length: Persist,
  pub validate_json_schema: Persist,
  pub invalid_relationships_message: Persist,
  pub invalid_selections_message: Persist,
  pub duplicates_message: Persist,
  pub join: Persist,
  pub type_error: Persist,
  pub error: Persist,
  pub for_of: Persist,
  pub iterator: Persist,
  pub continue_marker: Persist,
  pub args: Args,
}

/// The parameter destructuring of each validator: `(value, options) => [bindings...]`.
pub struct Args {
  pub text: Persist,
  pub password: Persist,
  pub confirm_password: Persist,
  pub email: Persist,
  pub username: Persist,
  pub textarea: Persist,
  pub code: Persist,
  pub json: Persist,
  pub checkbox: Persist,
  pub date: Persist,
  pub number: Persist,
  pub array: Persist,
  pub validate_blocks_filter_options: Persist,
  pub blocks: Persist,
  pub relationship: Persist,
  pub validate_filter_options: Persist,
  pub select: Persist,
  pub radio: Persist,
  pub point: Persist,
}

thread_local! {
  static VHOST: RefCell<Option<Rc<VHost>>> = const { RefCell::new(None) };
}

pub fn vhost() -> JsResult<Rc<VHost>> {
  VHOST.with(|h| h.borrow().clone()).ok_or_else(|| js::engine_error("validate binding not initialized"))
}

fn install(obj: Local) -> JsResult<()> {
  let f = |name: &str| -> JsResult<Persist> { Persist::new(js::get_named(obj, name)?) };
  let args = js::get_named(obj, "args")?;
  let a = |name: &str| -> JsResult<Persist> { Persist::new(js::get_named(args, name)?) };
  let host = VHost {
    is_array: f("isArray")?,
    lt: f("lt")?,
    gt: f("gt")?,
    template: f("template")?,
    string: f("String")?,
    number: f("Number")?,
    parse_float: f("parseFloat")?,
    date_parse: f("dateParse")?,
    object_id_is_valid: f("objectIdIsValid")?,
    object_id_hex: f("objectIdHex")?,
    email_test: f("emailTest")?,
    find_collection: f("findCollection")?,
    object_keys_length: f("objectKeysLength")?,
    validate_json_schema: f("validateJSONSchema")?,
    invalid_relationships_message: f("invalidRelationshipsMessage")?,
    invalid_selections_message: f("invalidSelectionsMessage")?,
    duplicates_message: f("duplicatesMessage")?,
    join: f("join")?,
    type_error: f("typeError")?,
    error: f("error")?,
    for_of: f("forOf")?,
    iterator: f("iterator")?,
    continue_marker: f("continueMarker")?,
    args: Args {
      text: a("text")?,
      password: a("password")?,
      confirm_password: a("confirmPassword")?,
      email: a("email")?,
      username: a("username")?,
      textarea: a("textarea")?,
      code: a("code")?,
      json: a("json")?,
      checkbox: a("checkbox")?,
      date: a("date")?,
      number: a("number")?,
      array: a("array")?,
      validate_blocks_filter_options: a("validateBlocksFilterOptions")?,
      blocks: a("blocks")?,
      relationship: a("relationship")?,
      validate_filter_options: a("validateFilterOptions")?,
      select: a("select")?,
      radio: a("radio")?,
      point: a("point")?,
    },
  };
  VHOST.with(|h| *h.borrow_mut() = Some(Rc::new(host)));
  Ok(())
}

/// The validators by name, for Rust callers (`validate(name, value, options)`): the result
/// (`true`, the `t` result, ...) for sync validators, a promise for async ones; `Err` is what
/// the validator throws synchronously.
pub fn validate(name: &str, value: Local, options: Local) -> JsResult<Local> {
  match name {
    "text" => validators::text(value, options),
    "slug" => validators::slug(),
    "password" => validators::password(value, options),
    "confirmPassword" => validators::confirm_password(value, options),
    "email" => validators::email(value, options),
    "username" => validators::username(value, options),
    "textarea" => validators::textarea(value, options),
    "code" => validators::code(value, options),
    "json" => async_validators::json(value, options),
    "checkbox" => validators::checkbox(value, options),
    "date" => validators::date(value, options),
    "richText" => async_validators::rich_text(value, options),
    "number" => validators::number(value, options),
    "array" => validators::array_validator(value, options),
    "blocks" => async_validators::blocks(value, options),
    "upload" | "relationship" => async_validators::relationship(value, options),
    "select" => async_validators::select(value, options),
    "radio" => validators::radio(value, options),
    "point" => validators::point(value, options),
    other => Err(js::engine_error(&format!("unknown validator {other}"))),
  }
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
      let Thrown(e) = js::engine_error("payload validator engine panicked");
      js::throw(e.get());
      ptr::null_mut()
    }
  }
}

macro_rules! exports {
  ($($js:literal => $name:ident[$n:literal]($($arg:ident),*) $body:expr;)*) => {
    $(
      unsafe extern "C" fn $name(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
        run::<$n>(env, info, |[$($arg),*]| $body)
      }
    )*
    fn create() -> JsResult<Local> {
      let o = js::object();
      $(js::set_named(o, $js, js::create_function($js, $name, ptr::null_mut()))?;)*
      Ok(o)
    }
  };
}

exports! {
  "init" => init_export[1](host_obj) { install(host_obj)?; Ok(js::undefined()) };
  "text" => text_export[2](value, options) validators::text(value, options);
  "slug" => slug_export[0]() validators::slug();
  "password" => password_export[2](value, options) validators::password(value, options);
  "confirmPassword" => confirm_password_export[2](value, options) validators::confirm_password(value, options);
  "email" => email_export[2](value, options) validators::email(value, options);
  "username" => username_export[2](value, options) validators::username(value, options);
  "textarea" => textarea_export[2](value, options) validators::textarea(value, options);
  "code" => code_export[2](value, options) validators::code(value, options);
  "json" => json_export[2](value, options) async_validators::json(value, options);
  "checkbox" => checkbox_export[2](value, options) validators::checkbox(value, options);
  "date" => date_export[2](value, options) validators::date(value, options);
  "richText" => rich_text_export[2](value, options) async_validators::rich_text(value, options);
  "number" => number_export[2](value, options) validators::number(value, options);
  "array" => array_export[2](value, options) validators::array_validator(value, options);
  "validateBlocksFilterOptions" => validate_blocks_filter_options_export[1](args)
    async_validators::validate_blocks_filter_options(args);
  "blocks" => blocks_export[2](value, options) async_validators::blocks(value, options);
  "upload" => upload_export[2](value, options) async_validators::relationship(value, options);
  "relationship" => relationship_export[2](value, options) async_validators::relationship(value, options);
  "select" => select_export[2](value, options) async_validators::select(value, options);
  "radio" => radio_export[2](value, options) validators::radio(value, options);
  "point" => point_export[2](value, options) validators::point(value, options);
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
