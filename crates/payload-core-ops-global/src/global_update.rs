//! Port of `packages/payload/src/globals/operations/update.ts` (`updateOperation`).
//!
//! Control flow, awaits, access, the global hook loops, transactions and every adapter / traversal
//! call are here; the synchronous all-locales publication bookkeeping segments (no user callbacks)
//! are JS helpers holding upstream's statements (see `packages/engine-rs/src/ops-global/host.ts`).

use payload_core_ops::common::AccessArgs;
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::common::{
  access, await_helper, commit_transaction, config_hooks, db, init_transaction, kill_transaction,
};
use crate::host::{call, call_val, g, gv, path, set, throw_from, truthy, unpack, val};

/// `updateOperation(args)`: returns its promise.
pub fn update(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run(args))
}

async fn run(args: Val) -> JsResult<Val> {
  let mut args = args;
  let [req, initial_global_config, initial_intent] = unpack::<3>(call("globalUpdatePrelude", &[args.get()])?)?;

  let body: JsResult<Val> = async {
    // const shouldCommit = !args.disableTransaction && (await initTransaction(req))
    let should_commit =
      if truthy(&gv(&args, "disableTransaction")?) { false } else { truthy(&init_transaction(&req).await?) };

    // beforeOperation - Global
    args = config_hooks(&initial_global_config, "beforeOperation", "initialGlobalConfig", args.clone(), |args| {
      call("globalBeforeOperationArgsUpdate", &[args, initial_global_config.get(), js::string("update")])
    })
    .await?;

    let [
      slug,
      autosave,
      depth,
      draft_arg,
      global_config,
      override_access,
      override_lock,
      populate,
      publish_all_locales_arg,
      fallback_locale,
      locale,
      payload,
      config,
      incoming_select,
      show_hidden_fields,
      unpublish_all_locales_arg,
    ] = unpack::<16>(call("globalUpdateArgs", &[args.get()])?)?;

    let mut data = gv(&args, "data")?;

    let [publish_all_locales, unpublish_all_locales, all_locales_publication_status, is_saving_draft, submitted_top_level_field_names] =
      unpack::<5>(call(
        "globalUpdatePublication",
        &[
          publish_all_locales_arg.get(),
          unpublish_all_locales_arg.get(),
          draft_arg.get(),
          global_config.get(),
          locale.get(),
          config.get(),
          data.get(),
          initial_intent.get(),
        ],
      )?)?;
    let is_saving_draft = truthy(&is_saving_draft);

    // 1. Retrieve and execute access
    let access_results = if !truthy(&override_access) {
      let slug = gv(&global_config, "slug")?;
      let update = path(&global_config, &["access", "update"])?;
      let mut a = AccessArgs::new(slug, Val::Undefined, req.clone());
      a.data = data.clone();
      access(a, update).await?
    } else {
      Val::Bool(true)
    };

    // Retrieve document
    let query = if truthy(&override_access) { Val::Undefined } else { access_results.clone() };

    // 2. Retrieve document
    let global_version_result = await_helper(
      "globalLatestVersion",
      &[
        slug.get(),
        global_config.get(),
        publish_all_locales.get(),
        unpublish_all_locales.get(),
        locale.get(),
        payload.get(),
        req.get(),
        query.get(),
      ],
    )
    .await?;
    let [_global, global_exists, global_json] = unpack::<3>(call(
      "globalUpdateCurrent",
      &[access_results.get(), global_version_result.get(), req.get()],
    )?)?;

    let original_doc = await_helper(
      "globalUpdateOriginalAfterRead",
      &[req.get(), global_json.get(), draft_arg.get(), fallback_locale.get(), global_config.get(), locale.get(), show_hidden_fields.get()],
    )
    .await?;

    // Handle potentially locked global documents
    await_helper("globalCheckLockStatus", &[slug.get(), override_lock.get(), req.get()]).await?;

    // beforeValidate - Fields
    let [status_field_access, on_field_access] = unpack::<2>(call("statusFieldAccessCell", &[])?)?;
    let publication_field_policy_doc = call_val(
      "publicationHookDoc",
      &[original_doc.get(), global_json.get(), data.get(), all_locales_publication_status.get(), js::undefined()],
    )?;

    data = await_helper(
      "globalBeforeValidate",
      &[
        req.get(),
        data.get(),
        original_doc.get(),
        publication_field_policy_doc.get(),
        global_config.get(),
        on_field_access.get(),
        override_access.get(),
      ],
    )
    .await?;

    let publication_hook_doc = call_val(
      "publicationHookDoc",
      &[original_doc.get(), global_json.get(), data.get(), all_locales_publication_status.get(), status_field_access.get()],
    )?;

    // beforeValidate - Global
    data = config_hooks(&global_config, "beforeValidate", "globalConfig", data, |data| {
      call(
        "globalChangeHookArgs",
        &[req.get(), data, global_config.get(), publication_hook_doc.get(), override_access.get()],
      )
    })
    .await?;

    // beforeChange - Global
    data = config_hooks(&global_config, "beforeChange", "globalConfig", data, |data| {
      call(
        "globalChangeHookArgs",
        &[req.get(), data, global_config.get(), publication_hook_doc.get(), override_access.get()],
      )
    })
    .await?;

    // beforeChange - Fields
    let [publication_data, status_field_value, before_change] = unpack::<3>(call(
      "globalBeforeChange",
      &[
        data.get(),
        req.get(),
        publication_hook_doc.get(),
        global_json.get(),
        submitted_top_level_field_names.get(),
        global_config.get(),
        js::boolean(is_saving_draft),
      ],
    )?)?;
    let mut result = await_js(before_change.get()).await?;

    let has_authorized_publication_status = call_val(
      "globalUpdateStatusAfterChange",
      &[
        result.get(),
        publication_data.get(),
        status_field_access.get(),
        status_field_value.get(),
        all_locales_publication_status.get(),
        global_json.get(),
        config.get(),
        global_config.get(),
      ],
    )?;

    // Handle Localized Data Merging
    let mut localized_publish_data = Val::Null;

    if js::truthy(call("hasLocalizationAndVersions", &[config.get(), global_config.get()])?) {
      if js::truthy(call("hasLocalizeStatusEnabled", &[global_config.get()])?) {
        if truthy(&has_authorized_publication_status) {
          let mut accessible_locale_codes = path(&config, &["localization", "localeCodes"])?;

          if js::truthy(g(&val(g(&config, "localization")?)?, "filterAvailableLocales")?) {
            let filtered_locales = await_helper("filterAvailableLocales", &[config.get(), req.get()]).await?;
            accessible_locale_codes = call_val("localeCodesOf", &[filtered_locales.get()])?;
          }

          call("publishLocaleStatuses", &[result.get(), accessible_locale_codes.get(), unpublish_all_locales.get()])?;
        } else if !is_saving_draft && js::truthy(call("isLocalePublished", &[result.get(), locale.get()])?) {
          let current_global = db(&payload, "findGlobal", || {
            call("globalFindAllLocalesArgs", &[global_config.get(), req.get(), query.get()])
          })
          .await?;

          localized_publish_data = call_val(
            "globalLocalizedPublishData",
            &[config.get(), current_global.get(), global_config.get(), locale.get(), result.get()],
          )?;
        }
      }
    }

    if js::truthy(call(
      "shouldValidateAllLocales",
      &[config.get(), global_config.get(), publish_all_locales.get(), unpublish_all_locales.get(), has_authorized_publication_status.get()],
    )?) {
      let validation_result = await_helper(
        "globalValidateLocaleKeyed",
        &[
          global_config.get(),
          result.get(),
          override_access.get(),
          req.get(),
          payload.get(),
          global_json.get(),
          publication_hook_doc.get(),
          locale.get(),
        ],
      )
      .await?;

      if !js::truthy(g(&validation_result, "valid")?) {
        let errors = g(&validation_result, "errors")?;
        return Err(throw_from("globalValidationError", &[errors, global_config.get(), req.get()]));
      }
    }

    let data_to_update = call_val("spreadEither", &[localized_publish_data.get(), result.get()])?;

    // Update
    let select = call_val("selectRead", &[global_config.get(), req.get(), incoming_select.get(), js::string("update")])?;

    let mut result_with_locales = result.clone();

    if !is_saving_draft {
      let now = call_val("stampDates", &[data_to_update.get()])?;

      if truthy(&global_exists) {
        result_with_locales = db(&payload, "updateGlobal", || {
          call("globalWriteArgs", &[slug.get(), data_to_update.get(), req.get(), select.get(), js::boolean(true)])
        })
        .await?;
      } else {
        result_with_locales = db(&payload, "createGlobal", || {
          call("globalWriteArgs", &[slug.get(), data_to_update.get(), req.get(), select.get(), js::boolean(false)])
        })
        .await?;
      }

      set(result_with_locales.get(), "updatedAt", now.get())?;

      if truthy(&localized_publish_data) {
        // Keep full locale payload for version writes during single-locale publish.
        result_with_locales = call_val("localizedPublishResult", &[result.get(), result_with_locales.get(), now.get()])?;
      }
    }

    // Create version
    if js::truthy(g(&global_config, "versions")?) {
      let global_type = call_val("destructureGlobalType", &[result_with_locales.get()])?;
      result_with_locales = await_helper(
        "globalSaveVersion",
        &[
          autosave.get(),
          result_with_locales.get(),
          js::boolean(is_saving_draft),
          global_config.get(),
          payload.get(),
          req.get(),
          select.get(),
          unpublish_all_locales.get(),
          js::string("update"),
        ],
      )
      .await?;

      result_with_locales = call_val("withGlobalType", &[result_with_locales.get(), global_type.get()])?;
    }

    // Execute globalType field if not selected
    call("stripGlobalType", &[select.get(), result_with_locales.get()])?;

    // afterRead - Fields
    result = await_helper(
      "globalUpdateAfterRead",
      &[
        req.get(),
        depth.get(),
        result_with_locales.get(),
        draft_arg.get(),
        global_config.get(),
        locale.get(),
        override_access.get(),
        populate.get(),
        select.get(),
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
    result = await_helper(
      "globalAfterChange",
      &[req.get(), data.get(), result.get(), global_config.get(), original_doc.get()],
    )
    .await?;

    // afterChange - Global
    result = config_hooks(&global_config, "afterChange", "globalConfig", result, |doc| {
      call(
        "globalAfterChangeHookArgs",
        &[req.get(), data.get(), doc, global_config.get(), override_access.get(), original_doc.get()],
      )
    })
    .await?;

    // Return results
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
