//! The JS-facing binding object, exposed by `payload-node` as `mongoLiveBinding()`
//! (crates/payload-node/src/mongo_live.rs) and wrapped by `packages/engine-rs/src/mongo-live`. It
//! shares the core runtime's thread-local state (executor, runtime host) and uses the core query
//! port's host (`combineQueries`), so `getCoreRuntime()` and `getCoreQueryBinding()` must have run.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Thrown};

use crate::host::{call, truthy, val};
use crate::reads::{self, AggregatePaginateArgs};
use crate::{bson, deps, host, session};

type Body<const N: usize> = fn([Local; N]) -> JsResult<Local>;

/// Version of the binding / host-helper contract with `packages/engine-rs/src/mongo-live`.
pub const API_VERSION: u32 = 1;

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
      let Thrown(e) = js::engine_error("payload mongo live engine panicked");
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

fn rejected(error: Local) -> JsResult<Local> {
  let (deferred, promise) = js::create_promise()?;
  js::reject_deferred(deferred, error);
  Ok(promise)
}

// init(host, options?): options.upstreamDeps forces upstream's TS query/transform/joins functions
export!(init, 2, |[host_obj, options]| {
  host::install(host_obj)?;
  let force = js::type_of(options).is_object_like() && truthy(js::get_named(options, "upstreamDeps")?);
  deps::set_force_upstream(force);
  Ok(js::undefined())
});

export_async!(find_export, 2, |[adapter, args]| reads::find(adapter, args));
export_async!(find_one_export, 2, |[adapter, args]| reads::find_one(adapter, args));
export_async!(count_export, 2, |[adapter, args]| reads::count(adapter, args));
export_async!(count_versions_export, 2, |[adapter, args]| reads::count_versions(adapter, args));
export_async!(count_global_versions_export, 2, |[adapter, args]| reads::count_global_versions(adapter, args));
export_async!(find_distinct_export, 2, |[adapter, args]| reads::find_distinct(adapter, args));
export_async!(find_global_export, 2, |[adapter, args]| reads::find_global(adapter, args));
export_async!(find_versions_export, 2, |[adapter, args]| reads::find_versions(adapter, args));
export_async!(find_global_versions_export, 2, |[adapter, args]| reads::find_global_versions(adapter, args));
export_async!(query_drafts_export, 2, |[adapter, args]| reads::query_drafts(adapter, args));

// aggregatePaginate({ adapter, collation, ... }) (the async arrow; destructured by the host)
export_async!(aggregate_paginate_export, 1, |[args]| {
  let d = call("aggregatePaginateArgs", &[args])?;
  let at = |i| val(js::get_element(d, i)?);
  reads::aggregate_paginate(AggregatePaginateArgs {
    adapter: at(0)?,
    collation: at(1)?,
    join_aggregation: at(2)?,
    limit: at(3)?,
    model: at(4)?,
    page: at(5)?,
    pagination: at(6)?,
    projection: at(7)?,
    query: at(8)?,
    session: at(9)?,
    sort: at(10)?,
    sort_aggregation: at(11)?,
    use_estimated_count: at(12)?,
  })
});

// shared helpers, exported for the helper differentials
export_async!(get_session_export, 2, |[db, req]| session::get_session(db, req));
export!(is_object_id_export, 1, |[v]| Ok(js::boolean(bson::is_object_id(v)?)));
export!(object_id_is_valid_export, 1, |[v]| Ok(js::boolean(bson::object_id_is_valid(v)?)));
export!(new_object_id_export, 1, |[v]| {
  if js::type_of(v) == js::Type::Undefined { bson::new_object_id(&[]) } else { bson::new_object_id(&[v]) }
});
export!(bson_class_of_export, 1, |[v]| {
  Ok(match bson::bson_class_of(v)? {
    Some(c) => js::string(c.name()),
    None => js::null(),
  })
});
export!(get_collection_export, 3, |[adapter, slug, versions]| {
  let c = crate::entity::get_collection(adapter, slug, truthy(versions))?;
  host::array_of(&[c.collection_config.get(), c.custom_id_type.get(), c.model.get()])
});
export!(get_global_export, 3, |[adapter, slug, versions]| {
  let g = crate::entity::get_global(adapter, slug, truthy(versions))?;
  host::array_of(&[g.global_config.get(), g.model.get()])
});
export!(now_iso_export, 0, |[]| crate::clock::now_iso());

// Which db-mongodb functions run a registered Rust port (the rest call upstream TS).
export!(ported_export, 0, |[]| {
  let names = ["buildQuery", "buildSortParam", "buildProjectionFromSelect", "transform", "buildJoinAggregation", "resolveJoins"];
  let o = js::object();
  for (name, ported) in names.iter().zip(deps::ported()) {
    js::set_named(o, name, js::boolean(ported))?;
  }
  Ok(o)
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
  add!("findOne", find_one_export);
  add!("count", count_export);
  add!("countVersions", count_versions_export);
  add!("countGlobalVersions", count_global_versions_export);
  add!("findDistinct", find_distinct_export);
  add!("findGlobal", find_global_export);
  add!("findVersions", find_versions_export);
  add!("findGlobalVersions", find_global_versions_export);
  add!("queryDrafts", query_drafts_export);
  add!("aggregatePaginate", aggregate_paginate_export);
  add!("getSession", get_session_export);
  add!("isObjectID", is_object_id_export);
  add!("objectIdIsValid", object_id_is_valid_export);
  add!("newObjectId", new_object_id_export);
  add!("bsonClassOf", bson_class_of_export);
  add!("getCollection", get_collection_export);
  add!("getGlobal", get_global_export);
  add!("nowISO", now_iso_export);
  add!("ported", ported_export);
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
