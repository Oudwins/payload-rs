//! `updateJobs.ts`

use crate::drive::{Body, wait};
use payload_core_runtime::js::{self, JsResult, Val};
use payload_mongo_live::deps::{self, BuildQueryArgs, BuildSortParamArgs};
use payload_mongo_live::entity;
use payload_mongo_live::host::{del, get, get_val, has, is_false, is_number, is_string, is_typeof_object, opt, or_else, truthy, val};

use crate::common::{handle_error, UpdateOperators, destructure, session_options, transform_read, transform_write};
use crate::helpers;

/// `adapter.updateJobs(args)`
pub fn update_jobs(this: Val, args: Val) -> Body {
  Box::pin(update_jobs_body(this, args))
}

async fn update_jobs_body(this: Val, args: Val) -> JsResult<Val> {
  let [id, data, limit, req, returning, sort_arg, where_arg] = destructure::<7>("updateJobsArgs", &args)?;

  // !(data?.log as object[])?.length && !(data.log && typeof data.log === 'object' && '$push' in data.log)
  // (each `data.log` is its own read: `log` may be an accessor; `typeof null === 'object'`)
  let keep_log = truthy(opt(opt(data.get(), "log")?, "length")?) || if crate::mutant(7) {
    let log = get(data.get(), "log")?;
    truthy(log) && is_typeof_object(log) && has(log, "$push")?
  } else {
    truthy(get(data.get(), "log")?)
      && (if crate::mutant(10) {
        // mutant 10: `typeof null === 'object'` not implemented (the pre-fix check)
        js::type_of(get(data.get(), "log")?) == js::Type::Object
      } else {
        is_typeof_object(get(data.get(), "log")?)
      })
      && {
      let log = get(data.get(), "log")?;
      has(log, "$push")?
    }
  };
  if !keep_log {
    del(data.get(), js::string("log"))?;
  }

  let where_ = if truthy(id.get()) { helpers::call_val("idWhere", &[id.get()])? } else { where_arg };

  let entity::Collection { collection_config, model, .. } =
    entity::get_collection(this.get(), js::string("payload-jobs"), false)?;

  let sort = {
    let config = get_val(get(this.get(), "payload")?, "config")?;
    let fields = get_val(collection_config.get(), "flattenedFields")?;
    let sort_value = val(or_else(sort_arg.get(), || get(collection_config.get(), "defaultSort"))?)?;
    val(deps::build_sort_param(BuildSortParamArgs {
      adapter: this.clone(),
      config,
      fields,
      locale: Val::Undefined,
      parent_is_localized: Val::Undefined,
      sort: sort_value,
      sort_aggregation: Val::Undefined,
      timestamps: Val::Bool(true),
      versions: Val::Undefined,
    })?)?
  };

  let query = {
    let collection_slug = get_val(collection_config.get(), "slug")?;
    let fields = get_val(collection_config.get(), "flattenedFields")?;
    let p = deps::build_query(BuildQueryArgs {
      adapter: this.clone(),
      collection_slug,
      fields,
      global_slug: Val::Undefined,
      locale: Val::Undefined,
      where_,
    })?;
    wait(p).await?
  };

  let ops = UpdateOperators::new()?;
  transform_write(&this, &data, get_val(collection_config.get(), "fields")?, None, Some(&ops))?;
  let update_data = ops.apply(data.clone())?;

  let base_options = session_options(&this, &req).await?;
  let find_options = helpers::call_val("findOptionsJobs", &[base_options.get()])?;

  // `let result: Job[] = []`; `Ok(None)` = an early `return null` inside the try
  let outcome: JsResult<Option<Val>> = async {
    if truthy(id.get()) {
      if is_false(returning.get()) {
        let p = helpers::call("modelUpdateOne", &[model.get(), query.get(), update_data.get(), base_options.get()])?;
        wait(p).await?;
        transform_read(&this, &data, get_val(collection_config.get(), "fields")?, None)?;

        return Ok(None);
      }
      let p =
        helpers::call("modelFindOneAndUpdate", &[model.get(), query.get(), update_data.get(), find_options.get()])?;
      let doc = wait(p).await?;
      return Ok(Some(helpers::call_val("wrapDoc", &[doc.get()])?));
    }

    if is_number(limit.get()) && js::get_f64(limit.get()) == 1.0 {
      // Select, update, and return one job atomically in a single database call.
      let p = helpers::call(
        "modelFindOneAndUpdateSorted",
        &[model.get(), query.get(), update_data.get(), find_options.get(), returning.get(), sort.get()],
      )?;
      let doc = wait(p).await?;

      if is_false(returning.get()) {
        return Ok(None);
      }

      return Ok(Some(helpers::call_val("wrapDoc", &[doc.get()])?));
    }

    if is_number(limit.get()) && js::get_f64(limit.get()) > 1.0 {
      let p = helpers::call("modelFindIDs", &[model.get(), query.get(), find_options.get(), limit.get(), sort.get()])?;
      let candidates = wait(p).await?;

      let length = get(candidates.get(), "length")?;
      if is_number(length) && js::get_f64(length) == 0.0 {
        return Ok(None);
      }

      let candidate_ids = helpers::call_val("candidateIDs", &[candidates.get()])?;

      if is_string(get(data.get(), "processingToken")?) {
        // `processingToken` identifies this claim update.
        let claim_query = helpers::call("claimQuery", &[query.get(), candidate_ids.get()])?;
        let p = helpers::call("modelUpdateMany", &[model.get(), claim_query, update_data.get(), base_options.get()])?;
        wait(p).await?;

        if is_false(returning.get()) {
          return Ok(None);
        }

        let claimed_jobs_query = helpers::call("claimedJobsQuery", &[candidate_ids.get(), data.get()])?;
        let p = helpers::call("modelFindSorted", &[model.get(), claimed_jobs_query, find_options.get(), sort.get()])?;
        return Ok(Some(wait(p).await?));
      }

      let limited_update_query = helpers::call_val("limitedUpdateQuery", &[candidate_ids.get()])?;
      let p =
        helpers::call("modelUpdateMany", &[model.get(), limited_update_query.get(), update_data.get(), base_options.get()])?;
      wait(p).await?;

      if is_false(returning.get()) {
        return Ok(None);
      }

      let p =
        helpers::call("modelFindSorted", &[model.get(), limited_update_query.get(), find_options.get(), sort.get()])?;
      return Ok(Some(wait(p).await?));
    }

    let p = helpers::call("modelUpdateMany", &[model.get(), query.get(), update_data.get(), base_options.get()])?;
    wait(p).await?;

    if is_false(returning.get()) {
      return Ok(None);
    }

    let p = helpers::call("modelFindSorted", &[model.get(), query.get(), find_options.get(), sort.get()])?;
    Ok(Some(wait(p).await?))
  }
  .await;

  let result = match outcome {
    Ok(Some(result)) => result,
    Ok(None) => return Ok(Val::Null),
    Err(error) => {
      // `handleError({ collection: collectionConfig.slug, error, req })`
      let slug = match get(collection_config.get(), "slug") {
        Ok(slug) => slug,
        Err(thrown) => return Err(thrown),
      };
      return Err(handle_error(slug, error, js::undefined(), req.get()));
    }
  };

  transform_read(&this, &result, get_val(collection_config.get(), "fields")?, None)?;

  Ok(result)
}
