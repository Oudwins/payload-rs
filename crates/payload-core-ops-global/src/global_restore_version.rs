//! Port of `packages/payload/src/globals/operations/restoreVersion.ts`
//! (`restoreVersionOperation`).

use payload_core_ops::common::AccessArgs;
use payload_core_runtime::executor::spawn;
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::common::{
  access, await_helper, commit_transaction, config_hooks, db, init_transaction, kill_transaction, local_api, throw_t,
};
use crate::host::{ForOf, call, call_val, g, gv, loop_body, path, set, truthy, unpack, val};

/// `restoreVersionOperation(args)`: returns its promise.
pub fn restore_version(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run(args))
}

async fn run(args: Val) -> JsResult<Val> {
  let mut args = args;
  let [id, depth, draft, global_config, override_access, populate, show_hidden_fields, req, fallback_locale, locale, payload] =
    unpack::<11>(call("globalRestoreVersionArgs", &[args.get()])?)?;

  let body: JsResult<Val> = async {
    let should_commit = truthy(&init_transaction(&req).await?);

    // beforeOperation - Global
    args = config_hooks(&global_config, "beforeOperation", "globalConfig", args.clone(), |args| {
      call(
        "globalBeforeOperationReqArgs",
        &[args, req.get(), global_config.get(), js::string("restoreVersion"), override_access.get()],
      )
    })
    .await?;

    // Retrieve original raw version
    let read_versions_access_result = if truthy(&override_access) {
      Val::Bool(true)
    } else {
      let slug = gv(&global_config, "slug")?;
      let read_versions = path(&global_config, &["access", "readVersions"])?;
      access(AccessArgs::new(slug, Val::Undefined, req.clone()), read_versions).await?
    };

    let version_fields = call_val("globalVersionFields", &[payload.get(), global_config.get()])?;
    let where_ = call_val("combineQueries", &[call("idWhere", &[id.get()])?, read_versions_access_result.get()])?;

    call("sanitizeWhereQuery", &[version_fields.get(), payload.get(), where_.get()])?;

    let found = db(&payload, "findGlobalVersions", || {
      call("globalRestoreFindArgs", &[global_config.get(), req.get(), where_.get()])
    })
    .await?;
    let [version_docs] = unpack::<1>(call("awaitedProps", &[found.get(), js::string("docs")])?)?;

    if js::truthy(call("isEmptyList", &[version_docs.get()])?) {
      if js::truthy(call("hasWhereAccessResult", &[read_versions_access_result.get()])?) {
        return Err(throw_t("forbidden", &req));
      }
      return Err(throw_t("notFound", &req));
    }

    let raw_version = val(crate::host::get(version_docs.get(), "0")?)?;

    // Patch globalType onto version doc
    let version = val(g(&raw_version, "version")?)?;
    set(version.get(), "globalType", g(&global_config, "slug")?)?;

    // Overwrite draft status if draft is true
    if truthy(&draft) {
      set(g(&raw_version, "version")?, "_status", js::string("draft"))?;
    }

    let restored_statuses = call_val("restoredStatusesToAuthorize", &[raw_version.get()])?;

    let update_access_results = val(js::array())?;

    if truthy(&override_access) {
      call("pushValue", &[update_access_results.get(), js::boolean(true)])?;
    } else {
      let statuses_to_authorize = call_val("statusesToAuthorize", &[restored_statuses.get()])?;
      let mut statuses = ForOf::of(statuses_to_authorize.get(), "statusesToAuthorize")?;
      while let Some(status) = statuses.next()? {
        let status = val(status)?;
        let body = async {
          let slug = gv(&global_config, "slug")?;
          let mut a = AccessArgs::new(slug, Val::Undefined, req.clone());
          a.data = call_val("statusData", &[status.get()])?;
          let update = path(&global_config, &["access", "update"])?;
          let result = access(a, update).await?;
          call("pushValue", &[update_access_results.get(), result.get()])?;
          Ok(())
        };
        loop_body(&statuses, body).await?;
      }
    }

    // fetch previousDoc
    let previous_doc = local_api(&payload, "findGlobal", || {
      call("restorePreviousDocArgs", &[global_config.get(), depth.get(), req.get()])
    })
    .await?;

    set(g(&req, "context")?, "isRestoringVersion", js::boolean(true))?;

    // Update global
    let mut results = ForOf::of(update_access_results.get(), "updateAccessResults")?;
    while let Some(update_access_result) = results.next()? {
      let update_access_result = val(update_access_result)?;
      let body = async {
        if !js::truthy(call("hasWhereAccessResult", &[update_access_result.get()])?) {
          return Ok(());
        }

        let constrained_global = db(&payload, "findGlobal", || {
          call("restoreFindGlobalArgs", &[global_config.get(), req.get(), update_access_result.get(), js::boolean(true)])
        })
        .await?;

        if !js::truthy(call("hasKeys", &[constrained_global.get()])?) {
          return Err(throw_t("forbidden", &req));
        }
        Ok(())
      };
      loop_body(&results, body).await?;
    }

    let global = db(&payload, "findGlobal", || {
      call("restoreFindGlobalArgs", &[global_config.get(), req.get(), js::undefined(), js::boolean(false)])
    })
    .await?;

    let mut result = gv(&raw_version, "version")?;

    if truthy(&global) || truthy(&draft) {
      // Ensure updatedAt date is always updated
      call("stampUpdatedAt", &[result.get()])?;
      if !truthy(&draft) {
        result = db(&payload, "updateGlobal", || {
          call("restoreWriteArgs", &[global_config.get(), result.get(), req.get()])
        })
        .await?;
      }
    } else {
      result = db(&payload, "createGlobal", || {
        call("restoreWriteArgs", &[global_config.get(), result.get(), req.get()])
      })
      .await?;
    }

    result = await_helper("globalRestoreSaveVersion", &[result.get(), draft.get(), global_config.get(), payload.get(), req.get()]).await?;

    result = call_val("withGlobalSlug", &[result.get(), global_config.get()])?;

    // afterRead - Fields
    result = await_helper(
      "globalRestoreAfterRead",
      &[
        req.get(),
        depth.get(),
        result.get(),
        fallback_locale.get(),
        global_config.get(),
        locale.get(),
        override_access.get(),
        populate.get(),
        show_hidden_fields.get(),
      ],
    )
    .await?;

    // afterRead - Global
    result = config_hooks(&global_config, "afterRead", "globalConfig", result, |doc| {
      call("globalReadHookArgs", &[req.get(), doc, global_config.get(), override_access.get()])
    })
    .await?;

    // afterChange - Fields
    result = await_helper("globalAfterChange", &[req.get(), result.get(), result.get(), global_config.get(), previous_doc.get()]).await?;

    // afterChange - Global
    result = config_hooks(&global_config, "afterChange", "globalConfig", result, |doc| {
      call(
        "globalAfterChangeHookArgs",
        &[req.get(), doc, doc, global_config.get(), override_access.get(), previous_doc.get()],
      )
    })
    .await?;

    if should_commit {
      commit_transaction(&req).await?;
    }

    Ok(result)
  }
  .await;

  match body {
    Ok(v) => Ok(v),
    Err(error) => {
      kill_transaction(&req).await?;
      Err(error)
    }
  }
}
