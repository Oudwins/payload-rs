//! Port of `packages/payload/src/collections/operations/docAccess.ts` (`docAccessOperation`).

use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Type, Val};

use crate::common::at;
use crate::host::{call, call_val, get, is_nullish, opt, val};

/// `docAccessOperation(args)`: returns its promise.
pub fn doc_access(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run(args))
}

async fn run(args: Val) -> JsResult<Val> {
  let d = call("docAccessArgs", &[args.get()])?;
  let id = at(d, 0)?;
  let config = at(d, 1)?;
  let data = at(d, 2)?;
  let req = at(d, 3)?;

  // [...allOperations]
  let collection_operations = call_val("allOperations", &[])?;

  // config.auth && typeof config.auth.maxLoginAttempts !== 'undefined' && config.auth.maxLoginAttempts !== 0
  if js::truthy(get(config.get(), "auth")?)
    && js::type_of(get(get(config.get(), "auth")?, "maxLoginAttempts")?) != Type::Undefined
    && !js::strict_equals(get(get(config.get(), "auth")?, "maxLoginAttempts")?, js::number(0.0))
  {
    call("pushOperation", &[collection_operations.get(), js::string("unlock")])?;
  }

  if js::truthy(get(config.get(), "versions")?) {
    call("pushOperation", &[collection_operations.get(), js::string("readVersions")])?;
  }

  let p = call("getEntityPermissions", &[id.get(), data.get(), config.get(), collection_operations.get(), req.get()])?;
  let result = await_js(p).await?;

  let sanitized_permissions = call("sanitizeCollectionPermissions", &[config.get(), result.get()])?;

  // sanitizedPermissions?.collections?.[config.slug]
  let collections = opt(sanitized_permissions, "collections")?;
  let collection_permissions = if is_nullish(collections) {
    js::undefined()
  } else {
    let slug = get(config.get(), "slug")?;
    payload_core_runtime::host::get(collections, slug)?
  };
  if is_nullish(collection_permissions) {
    return call_val("emptyPermissions", &[]);
  }
  val(collection_permissions)
}
