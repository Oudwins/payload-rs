//! The JS-facing binding object, exposed as `coreQueryBinding()` by `payload-node`. Every export
//! has the upstream signature (one args object, or `combineQueries(where, access)`); the async
//! ones return the promise of their task. `test/__rs/core-query/glue.ts` wraps it.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use napi::sys;
use payload_core_runtime::executor::spawn;
use payload_core_runtime::js::{self, JsResult, Local, Thrown};

use super::host::{self, call, truthy, val};
use super::join::{JoinQueryArgs, sanitize_join_query_body};
use super::paths::{FieldByPathArgs, LocalizedPathArg, LocalizedPathsArgs, get_field_by_path, get_localized_paths};
use super::validate::{
  QueryPathsArgs, SearchParamArgs, SortQueryArgs, validate_query_paths_body, validate_search_param_body,
  validate_sort_query_body,
};
use super::where_query::{combine_queries, prefix_where_paths, sanitize_where_query};

type Body<const N: usize> = fn([Local; N]) -> JsResult<Local>;

fn run<const N: usize>(env: sys::napi_env, info: sys::napi_callback_info, body: Body<N>) -> sys::napi_value {
  js::set_env(env);
  payload_core_runtime::executor::count_entry();
  let (args, _) = js::callback_args::<N>(env, info);
  match catch_unwind(AssertUnwindSafe(|| body(args))) {
    Ok(Ok(v)) => v.0,
    Ok(Err(Thrown(e))) => {
      js::throw(e.get());
      ptr::null_mut()
    }
    Err(_) => {
      let Thrown(e) = js::engine_error("payload core query engine panicked");
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

export!(init, 1, |[host_obj]| {
  host::install(host_obj)?;
  Ok(js::undefined())
});

// The async functions destructure their parameter inside the task (a throwing getter rejects).
export!(validate_query_paths_export, 1, |[args]| {
  let args = val(args)?;
  spawn(async move {
    let h = host::host()?;
    let destructured = call(&h.validate_query_paths_args, &[args.get()])?;
    validate_query_paths_body(QueryPathsArgs::from_array(destructured)?).await
  })
});

export!(validate_search_param_export, 1, |[args]| {
  let args = val(args)?;
  spawn(async move {
    let h = host::host()?;
    let destructured = call(&h.validate_search_param_args, &[args.get()])?;
    validate_search_param_body(SearchParamArgs::from_array(destructured)?).await
  })
});

export!(validate_sort_query_export, 1, |[args]| {
  let args = val(args)?;
  spawn(async move {
    let h = host::host()?;
    let destructured = call(&h.validate_sort_query_args, &[args.get()])?;
    validate_sort_query_body(SortQueryArgs::from_array(destructured)?).await
  })
});

export!(sanitize_join_query_export, 1, |[args]| {
  let args = val(args)?;
  spawn(async move {
    let h = host::host()?;
    let destructured = call(&h.sanitize_join_query_args, &[args.get()])?;
    sanitize_join_query_body(JoinQueryArgs::from_array(destructured)?).await
  })
});

export!(get_localized_paths_export, 1, |[args]| {
  let h = host::host()?;
  let a = call(&h.get_localized_paths_args, &[args])?;
  let e = |i| js::get_element(a, i);
  let paths = get_localized_paths(&LocalizedPathsArgs {
    collection_slug: e(0)?,
    fields: e(1)?,
    global_slug: e(2)?,
    incoming_path: e(3)?,
    locale: e(4)?,
    override_access: truthy(e(5)?),
    parent_is_localized: e(6)?,
    payload: e(7)?,
    show_hidden_fields: truthy(e(8)?),
  })?;
  let out = js::array();
  for (i, p) in paths.iter().enumerate() {
    js::set_element(out, i as u32, p.to_js()?)?;
  }
  Ok(out)
});

export!(get_field_by_path_export, 1, |[args]| {
  let h = host::host()?;
  let a = call(&h.get_field_by_path_args, &[args])?;
  let e = |i| js::get_element(a, i);
  let found = get_field_by_path(&FieldByPathArgs {
    config: e(0)?,
    fields: e(1)?,
    include_relationships: truthy(e(2)?),
    localized_path: LocalizedPathArg::Raw(e(3)?),
    path: e(4)?,
  })?;
  match found {
    Some(f) => f.to_js(),
    None => Ok(js::null()),
  }
});

export!(sanitize_where_query_export, 1, |[args]| {
  let h = host::host()?;
  let a = call(&h.sanitize_where_query_args, &[args])?;
  let e = |i| js::get_element(a, i);
  sanitize_where_query(e(0)?, e(1)?, e(2)?)?;
  Ok(js::undefined())
});

export!(combine_queries_export, 2, |[where_, access]| combine_queries(where_, access));

export!(prefix_where_paths_export, 1, |[args]| {
  let h = host::host()?;
  let a = call(&h.prefix_where_paths_args, &[args])?;
  prefix_where_paths(js::get_element(a, 0)?, js::get_element(a, 1)?)
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
  add!("validateQueryPaths", validate_query_paths_export);
  add!("validateSearchParam", validate_search_param_export);
  add!("validateSortQuery", validate_sort_query_export);
  add!("sanitizeJoinQuery", sanitize_join_query_export);
  add!("getLocalizedPaths", get_localized_paths_export);
  add!("getFieldByPath", get_field_by_path_export);
  add!("sanitizeWhereQuery", sanitize_where_query_export);
  add!("combineQueries", combine_queries_export);
  add!("prefixWherePaths", prefix_where_paths_export);
  Ok(o)
}

/// Entry for addons: `env` is the env of the current napi call.
///
/// # Safety
/// Must be called on the JS thread from inside a napi callback.
pub unsafe fn create_binding(env: sys::napi_env) -> sys::napi_value {
  js::set_env(env);
  js::register_env_cleanup(env);
  match create() {
    Ok(v) => v.0,
    Err(Thrown(e)) => {
      js::throw(e.get());
      ptr::null_mut()
    }
  }
}
