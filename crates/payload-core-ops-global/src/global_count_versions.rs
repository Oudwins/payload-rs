//! Port of `packages/payload/src/globals/operations/countGlobalVersions.ts`
//! (`countGlobalVersionsOperation`).

use payload_core_ops::common::AccessArgs;
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::common::{access, config_hooks, db};
use crate::host::{call, call_val, gv, is_false, path, truthy, unpack, val};

/// `countGlobalVersionsOperation(args)`: returns its promise.
pub fn count_global_versions(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run(args))
}

async fn run(args: Val) -> JsResult<Val> {
  let [disable_errors, global, override_access, where_, req, payload] =
    unpack::<6>(call("countGlobalVersionsArgs", &[args.get()])?)?;

  // beforeOperation - Global
  config_hooks(&global, "beforeOperation", "global", args, |args| {
    call(
      "globalBeforeOperationReqArgs",
      &[args, req.get(), global.get(), js::string("countVersions"), override_access.get()],
    )
  })
  .await?;

  // Access
  let mut access_result = Val::Undefined;
  if !truthy(&override_access) {
    let slug = gv(&global, "slug")?;
    let read_versions = path(&global, &["access", "readVersions"])?;
    access_result = access(AccessArgs::new(slug, disable_errors.clone(), req.clone()), read_versions).await?;

    // If errors are disabled, and access returns false, return empty results
    if is_false(access_result.get()) {
      return call_val("emptyCountResult", &[]);
    }
  }

  let full_where = call_val("combineQueries", &[where_.get(), access_result.get()])?;

  let version_fields = call_val("globalVersionFields", &[payload.get(), global.get()])?;

  call("sanitizeWhereQuery", &[version_fields.get(), payload.get(), full_where.get()])?;

  let p = call(
    "validateQueryPathsGlobal",
    &[global.get(), override_access.get(), req.get(), version_fields.get(), where_.get()],
  )?;
  await_js(p).await?;

  let result = db(&payload, "countGlobalVersions", || {
    call("countGlobalVersionsDbArgs", &[global.get(), req.get(), full_where.get()])
  })
  .await?;

  Ok(result)
}
