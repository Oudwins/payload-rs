//! The JS-facing binding object, exposed by `payload-node` as `mongoLiveWriteBinding()`
//! (crates/payload-node/src/mongo_live_write.rs). It shares the core runtime's and payload-mongo-live's
//! thread-local state, so `coreRuntimeBinding()` and the payload-mongo-live binding (its host) must
//! be initialized first on the same addon.
//!
//! Each method export is a JS `async function <upstream name>(args)` ([`crate::drive`]) that takes
//! the adapter as `this`, like the upstream `async function method(this: MongooseAdapter, args)`:
//! install it as `adapter[name] = binding[name]` (upsert's `this.updateOne(...)` then reaches
//! whatever `updateOne` the adapter has, user overrides included). Its body runs the Rust port and
//! performs the port's awaits itself.

use std::cell::Cell;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Thrown, Val};

use crate::drive::{self, Body};
use crate::{create, delete, helpers, update, update_jobs};

type Method = fn(Val, Val) -> Body;

/// Methods in binding order: adapter property, the upstream function's `name` (updateJobs.ts
/// exports `async function updateMany`), the port.
pub const METHODS: [(&str, &str, Method); 14] = [
  ("create", "create", create::create),
  ("createGlobal", "createGlobal", create::create_global),
  ("createGlobalVersion", "createGlobalVersion", create::create_global_version),
  ("createVersion", "createVersion", create::create_version),
  ("deleteMany", "deleteMany", delete::delete_many),
  ("deleteOne", "deleteOne", delete::delete_one),
  ("deleteVersions", "deleteVersions", delete::delete_versions),
  ("updateGlobal", "updateGlobal", update::update_global),
  ("updateGlobalVersion", "updateGlobalVersion", update::update_global_version),
  ("updateJobs", "updateMany", update_jobs::update_jobs),
  ("updateMany", "updateMany", update::update_many),
  ("updateOne", "updateOne", update::update_one),
  ("updateVersion", "updateVersion", update::update_version),
  ("upsert", "upsert", update::upsert),
];

thread_local! {
  static CALLS: [Cell<u64>; 14] = const { [const { Cell::new(0) }; 14] };
}

/// Version of the binding contract (method set, `this` convention, `stats()` shape).
pub const API_VERSION: u32 = 1;

fn guard(body: impl FnOnce() -> JsResult<Local>, what: &str) -> sys::napi_value {
  match catch_unwind(AssertUnwindSafe(body)) {
    Ok(Ok(v)) => v.0,
    Ok(Err(Thrown(e))) => {
      // release the handle before throwing: dropping a slot-held primitive (a thrown string)
      // makes a napi call, which must not run with the exception pending
      let value = e.get();
      drop(e);
      js::throw(value);
      ptr::null_mut()
    }
    Err(_) => {
      let Thrown(e) = js::engine_error(&format!("payload mongo live write {what} panicked"));
      js::throw(e.get());
      ptr::null_mut()
    }
  }
}

/// `start(index, this, args)` of the wrappers: counts the call and starts the method body.
unsafe extern "C" fn start(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
  js::set_env(env);
  let ([index, this, args], _) = js::callback_args::<3>(env, info);
  let index = js::get_f64(index) as usize;
  let Some(&(name, _, method)) = METHODS.get(index) else {
    return guard(|| Err(js::engine_error("mongo live write: unknown method index")), "start");
  };
  CALLS.with(|c| c[index].set(c[index].get() + 1));
  guard(|| drive::start(method(Val::from_local(this)?, Val::from_local(args)?)), name)
}

/// `resume(token, ok, value)` of the wrappers.
unsafe extern "C" fn resume(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
  js::set_env(env);
  let ([token, ok, value], _) = js::callback_args::<3>(env, info);
  guard(|| drive::resume(js::get_f64(token) as u32, js::get_bool(ok), value), "resume")
}

/// `task()` of the wrappers.
unsafe extern "C" fn task(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
  js::set_env(env);
  let _ = js::callback_args::<0>(env, info);
  js::number(drive::last() as f64).0
}

/// `init(options?)`: checks that payload-mongo-live's host is installed and compiles the helpers.
/// `options.mutant` (debug builds only) selects a deliberately wrong behaviour ([`crate::mutant`])
/// for the mutation runs of the differential.
unsafe extern "C" fn init(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
  js::set_env(env);
  let ([options], _) = js::callback_args::<1>(env, info);
  guard(
    || {
      // the shared host must be installed (payload-mongo-live binding `init`)
      payload_mongo_live::host::host()?;
      helpers::ensure()?;
      let mutant = if js::type_of(options) == js::Type::Object { js::get_named(options, "mutant")? } else { js::undefined() };
      crate::set_mutant(if js::type_of(mutant) == js::Type::Number { js::get_f64(mutant) as u32 } else { 0 });
      Ok(js::undefined())
    },
    "init",
  )
}

unsafe extern "C" fn stats(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
  js::set_env(env);
  // `stats` calls are not engine work
  js::uncount_entry();
  let _ = js::callback_args::<0>(env, info);
  guard(
    || {
      let o = js::object();
      CALLS.with(|c| -> JsResult<()> {
        for (i, (name, _, _)) in METHODS.iter().enumerate() {
          js::set_named(o, name, js::number(c[i].get() as f64))?;
        }
        Ok(())
      })?;
      Ok(o)
    },
    "stats",
  )
}

/// Builds the binding object: the 14 async wrappers (compiled once per binding object), `init`,
/// `stats`, `apiVersion`.
pub fn create() -> JsResult<Local> {
  let names: Vec<(&str, &str)> = METHODS.iter().map(|(property, name, _)| (*property, *name)).collect();
  let source = js::string(&drive::wrapper_source(&names));
  let mut factory = ptr::null_mut();
  js::check(unsafe { sys::napi_run_script(js::env(), source.0, &mut factory) })?;
  let natives = [
    js::create_function("start", start, ptr::null_mut()),
    js::create_function("resume", resume, ptr::null_mut()),
    js::create_function("task", task, ptr::null_mut()),
  ];
  let wrappers = js::call(Local(factory), js::undefined(), &natives)?;
  let o = js::object();
  for (name, _, _) in METHODS.iter() {
    js::set_named(o, name, js::get_named(wrappers, name)?)?;
  }
  js::set_named(o, "init", js::create_function("init", init, ptr::null_mut()))?;
  js::set_named(o, "stats", js::create_function("stats", stats, ptr::null_mut()))?;
  js::set_named(o, "apiVersion", js::number(f64::from(API_VERSION)))?;
  Ok(o)
}

/// Entry for addons: `env` is the env of the current napi call.
///
/// # Safety
/// Must be called on the JS thread from inside a napi callback.
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
