//! The JS-facing binding object, exposed by `payload-node` as `coreOpsBinding()`
//! (crates/payload-node/src/ops.rs) and wrapped by `packages/engine-rs/src/ops`. It shares the
//! core runtime's thread-local state (executor, runtime host, afterRead), so the runtime's `init`
//! must have run (`getCoreRuntime()`).

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use napi::sys;
use payload_core_runtime::executor::spawn;
use payload_core_runtime::js::{self, JsResult, Local, Thrown};

use crate::common::{self, AccessArgs};
use crate::{count, doc_access, find, find_by_id, find_distinct, find_version_by_id, find_versions, host};

type Body<const N: usize> = fn([Local; N]) -> JsResult<Local>;

/// Version of the binding / host-helper contract with `packages/engine-rs/src/ops`.
pub const API_VERSION: u32 = 3;

/// Runs an exported function body: sets the env, converts `Err(Thrown)` into a JS throw and
/// never lets a panic cross the FFI boundary.
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
      let Thrown(e) = js::engine_error("payload core operations panicked");
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

/// An export of an upstream `async` function: anything thrown before its task starts rejects the
/// returned promise instead of throwing at the call site.
macro_rules! export_async {
  ($name:ident, $n:literal, $body:expr) => {
    export!($name, $n, |args: [Local; $n]| {
      let body: Body<$n> = $body;
      match body(args) {
        Ok(p) => Ok(p),
        Err(Thrown(e)) => rejected(e.get()),
      }
    });
  };
}

/// `Promise.reject(error)` (native promise).
fn rejected(error: Local) -> JsResult<Local> {
  let (deferred, promise) = js::create_promise()?;
  js::reject_deferred(deferred, error);
  Ok(promise)
}

export!(init, 1, |[host_obj]| {
  host::install(host_obj)?;
  Ok(js::undefined())
});

export_async!(find_export, 1, |[args]| find::find(args));
export_async!(find_by_id_export, 1, |[args]| find_by_id::find_by_id(args));
export_async!(count_export, 1, |[args]| count::count(args));
export_async!(count_versions_export, 1, |[args]| count::count_versions(args));
export_async!(find_distinct_export, 1, |[args]| find_distinct::find_distinct(args));
export_async!(find_versions_export, 1, |[args]| find_versions::find_versions(args));
export_async!(find_version_by_id_export, 1, |[args]| find_version_by_id::find_version_by_id(args));
export_async!(doc_access_export, 1, |[args]| doc_access::doc_access(args));

// executeAccess({ id, slug, data, disableErrors, isReadingStaticFile = false, req }, access)
export_async!(execute_access_export, 2, |[args, access]| {
  let args = js::Val::from_local(args)?;
  let access = js::Val::from_local(access)?;
  spawn(async move {
    // The parameter destructuring is part of the async function: a throw rejects.
    let d = host::call("executeAccessArgs", &[args.get()])?;
    let a = AccessArgs {
      id: common::at(d, 0)?,
      slug: common::at(d, 1)?,
      data: common::at(d, 2)?,
      disable_errors: common::at(d, 3)?,
      is_reading_static_file: common::at(d, 4)?,
      req: common::at(d, 5)?,
    };
    common::execute_access_body(a, access).await
  })
});

// sanitizeSortQuery({ fields, sort })
export!(sanitize_sort_query_export, 1, |[args]| {
  let d = host::call("sanitizeSortQueryArgs", &[args])?;
  common::sanitize_sort_query(js::get_element(d, 0)?, js::get_element(d, 1)?)
});

/// Builds the binding object.
pub fn create() -> JsResult<Local> {
  let o = js::object();
  macro_rules! add {
    ($js:literal, $f:ident) => {
      js::set_named(o, $js, js::create_function($js, $f, ptr::null_mut()))?;
    };
  }
  add!("init", init);
  add!("find", find_export);
  add!("findByID", find_by_id_export);
  add!("count", count_export);
  add!("countVersions", count_versions_export);
  add!("findDistinct", find_distinct_export);
  add!("findVersions", find_versions_export);
  add!("findVersionByID", find_version_by_id_export);
  add!("docAccess", doc_access_export);
  add!("executeAccess", execute_access_export);
  add!("sanitizeSortQuery", sanitize_sort_query_export);
  // The host helper set this build expects (packages/engine-rs/src/ops/host.ts checks it).
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
