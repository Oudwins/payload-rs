//! Port of `packages/payload/src/globals/operations/docAccess.ts` (`docAccessOperation`).

use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::host::{call, call_val, g, unpack, val};

/// `docAccessOperation(args)`: returns its promise.
pub fn doc_access(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run(args))
}

async fn run(args: Val) -> JsResult<Val> {
  let [data, global_config, req] = unpack::<3>(call("globalDocAccessArgs", &[args.get()])?)?;

  let global_operations = call_val("globalOperations", &[])?;

  if js::truthy(g(&global_config, "versions")?) {
    call("pushReadVersions", &[global_operations.get()])?;
  }

  let p = call(
    "globalEntityPermissions",
    &[data.get(), global_config.get(), global_operations.get(), req.get()],
  )?;
  let result = await_js(p).await?;

  call_val("globalSanitizePermissions", &[global_config.get(), result.get()])
}
