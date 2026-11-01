//! Port of `packages/payload/src/collections/operations/validate.ts` (`validateOperation` and its
//! private `validateOperationWithScopedRequest`).

use payload_core_ops::common::{AccessArgs, execute_access};
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::common::traverse;
use crate::host::{self, at, call, call_fn, call_val, get, get_val, val};
use crate::validation_lifecycle::{LifecycleArgs, run_validation_lifecycle};

/// `validateOperation(args)`: returns its promise.
pub fn validate(args: Local) -> JsResult<Local> {
  host::count_call();
  let args = val(args)?;
  spawn(async move {
    // const previousOperation = args.req.operation
    // args.req.operation = args.validationOperation ?? 'validate'
    let previous_operation = get_val(get(args.get(), "req")?, "operation")?;
    call("setValidationOperation", &[args.get()])?;

    // try { return await validateOperationWithScopedRequest(args) } finally { ... }
    let outcome = match spawn(scoped(args.clone())) {
      Ok(p) => await_js(p).await,
      Err(e) => Err(e),
    };
    host::set(get(args.get(), "req")?, "operation", previous_operation.get())?;
    outcome
  })
}

/// `validateOperationWithScopedRequest(args)`
async fn scoped(args: Val) -> JsResult<Val> {
  let d = call("validateArgs", &[args.get()])?;
  let id = at(d, 0)?;
  let collection = at(d, 1)?;
  let incoming_data = at(d, 2)?;
  let draft = at(d, 3)?;
  let on_validation_data = at(d, 4)?;
  let override_access = at(d, 5)?;
  let req = at(d, 6)?;
  let skip_access_control = at(d, 7)?;
  let skip_mutation_hooks = at(d, 8)?;
  let source_data = at(d, 9)?;
  let trash = at(d, 10)?;
  let validation_operation = at(d, 11)?;

  let cc = get_val(collection.get(), "config")?;

  let access_result = if !js::truthy(skip_access_control.get()) && !js::truthy(override_access.get()) {
    let slug = get_val(cc.get(), "slug")?;
    let access = get_val(get(cc.get(), "access")?, "validate")?;
    let mut a = AccessArgs::new(slug, Val::Undefined, req.clone());
    a.id = id.clone();
    a.data = incoming_data.clone();
    await_js(execute_access(a, access)?).await?
  } else {
    Val::Bool(true)
  };
  let has_where_policy = js::truthy(call("hasWhereAccessResult", &[access_result.get()])?);

  let id_is_undefined = id.is_undefined();
  if id_is_undefined && has_where_policy {
    return Err(host::throw_from("forbidden", &[get(req.get(), "t")?]));
  }

  let mut doc_with_locales = call_val("validateInitialDocWithLocales", &[source_data.get()])?;

  if !id_is_undefined && !js::truthy(source_data.get()) {
    let id_where = call_val("validateIdWhere", &[cc.get(), trash.get(), id.get()])?;
    let where_ = call_val("combineQueries", &[id_where.get(), access_result.get()])?;
    let query = call_val("findOneArgsOf", &[cc.get(), get(req.get(), "locale")?, req.get(), where_.get()])?;

    let mut stored_document = Val::Undefined;

    if js::truthy(draft.get()) && js::truthy(host::opt(get(cc.get(), "versions")?, "drafts")?) {
      let pr = {
        let db = get(get(req.get(), "payload")?, "db")?;
        let f = get(db, "queryDrafts")?;
        let a = call("validateQueryDraftsArgs", &[cc.get(), req.get(), where_.get()])?;
        call_fn(f, db, &[a], "req.payload.db.queryDrafts")?
      };
      let r = await_js(pr).await?;
      stored_document = val(host::get_key(get(r.get(), "docs")?, js::number(0.0))?)?;

      if !js::truthy(stored_document.get()) && has_where_policy {
        let pr = {
          let db = get(get(req.get(), "payload")?, "db")?;
          let f = get(db, "queryDrafts")?;
          let a = call("validateExistingVersionsArgs", &[cc.get(), req.get(), id_where.get()])?;
          call_fn(f, db, &[a], "req.payload.db.queryDrafts")?
        };
        let r = await_js(pr).await?;
        let existing = get(r.get(), "docs")?;
        if js::truthy(host::get_key(existing, js::number(0.0))?) {
          return Err(host::throw_from("forbidden", &[get(req.get(), "t")?]));
        }
      }
    }

    if !js::truthy(stored_document.get()) {
      let pr = {
        let db = get(get(req.get(), "payload")?, "db")?;
        let f = get(db, "findOne")?;
        let a = call("spreadWithReq", &[query.get(), req.get()])?;
        call_fn(f, db, &[a], "req.payload.db.findOne")?
      };
      let r = await_js(pr).await?;
      // (await ...) ?? undefined
      stored_document = if host::is_nullish(r.get()) { Val::Undefined } else { r };
    }

    if !js::truthy(stored_document.get()) && has_where_policy {
      return Err(host::throw_from("forbidden", &[get(req.get(), "t")?]));
    }
    if !js::truthy(stored_document.get()) {
      return Err(host::throw_from("notFound", &[get(req.get(), "t")?]));
    }

    doc_with_locales = call_val("deepCopyObjectSimple", &[stored_document.get()])?;
  }

  let original_doc = if id_is_undefined {
    doc_with_locales.clone()
  } else if !js::truthy(source_data.get()) {
    let ar = call("validateAfterReadArgs", &[cc.get(), req.get(), doc_with_locales.get(), draft.get()])?;
    traverse("afterRead", ar).await?
  } else {
    call_val("validateOriginalFromSource", &[req.get(), source_data.get(), doc_with_locales.get(), cc.get()])?
  };

  // return runValidationLifecycle({ id, beforeValidation, collection, ... }) (the promise, not
  // awaited: the async function adopts it)
  let callbacks = call("validateLifecycleCallbacks", &[cc.get(), id.get(), original_doc.get(), req.get()])?;
  let before_validation = get_val(callbacks, "beforeValidation")?;
  let validate_data = get_val(callbacks, "validateData")?;
  val(run_validation_lifecycle(LifecycleArgs {
    traverse: host::traversal,
    id,
    before_validation,
    collection: cc,
    doc_with_locales,
    global: Val::Null,
    incoming_data,
    on_validation_data,
    original_doc,
    override_access,
    req,
    skip_mutation_hooks,
    validate_data,
    validation_operation,
  })?)
}
