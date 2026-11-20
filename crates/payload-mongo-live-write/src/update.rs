//! `updateOne.ts`, `upsert.ts`, `updateMany.ts`, `updateGlobal.ts`, `updateVersion.ts`,
//! `updateGlobalVersion.ts`.

use crate::drive::{Body, wait};
use payload_core_runtime::js::{self, JsResult, Local, Val};
use payload_mongo_live::deps::{self, BuildProjectionFromSelectArgs, BuildQueryArgs, BuildSortParamArgs};
use payload_mongo_live::host::{call, get, get_val, is_false, is_number, or_else, truthy, val};
use payload_mongo_live::entity;

use crate::common::{handle_error, UpdateOperators, base_options, transform_read, transform_write};
use crate::helpers;

/// `adapter.updateOne(args)`
pub fn update_one(this: Val, args: Val) -> Body {
  Box::pin(update_one_body(this, args))
}

async fn update_one_body(this: Val, args: Val) -> JsResult<Val> {
  let [id, collection_slug, data, locale, options_args, req, returning, select, where_arg] =
    crate::common::destructure::<9>("updateOneArgs", &args)?;
  let entity::Collection { collection_config, model, .. } = entity::get_collection(this.get(), collection_slug.get(), false)?;
  let where_ = if truthy(id.get()) { helpers::call_val("idWhere", &[id.get()])? } else { where_arg };
  let fields = get_val(collection_config.get(), "fields")?;

  let query = {
    let flattened_fields = get_val(collection_config.get(), "flattenedFields")?;
    let p = deps::build_query(BuildQueryArgs {
      adapter: this.clone(),
      collection_slug: collection_slug.clone(),
      fields: flattened_fields,
      global_slug: Val::Undefined,
      locale: locale.clone(),
      where_,
    })?;
    wait(p).await?
  };

  let ops = UpdateOperators::new()?;
  transform_write(&this, &data, fields.clone(), None, Some(&ops))?;
  let update_data = ops.apply(data.clone())?;

  let base_options = if crate::mutant(4) {
    let session = wait(payload_mongo_live::session::get_session(this.get(), req.get())?).await?;
    let partial = helpers::call_val("spread", &[options_args.get()])?;
    helpers::call_val("finishOptions", &[partial.get(), session.get()])?
  } else {
    base_options(&this, &options_args, &req).await?
  };
  let find_options = find_options_after(&this, &collection_config, &select, &base_options)?;

  let outcome: JsResult<Option<Val>> = async {
    if is_false(returning.get()) {
      let p = helpers::call("modelUpdateOne", &[model.get(), query.get(), update_data.get(), base_options.get()])?;
      wait(p).await?;
      if !crate::mutant(5) {
        transform_read(&this, &data, fields.clone(), None)?;
      }
      Ok(None)
    } else {
      let p =
        helpers::call("modelFindOneAndUpdate", &[model.get(), query.get(), update_data.get(), find_options.get()])?;
      Ok(Some(wait(p).await?))
    }
  }
  .await;
  let result = match outcome {
    Ok(Some(result)) => result,
    Ok(None) => {
      if crate::mutant(5) {
        transform_read(&this, &data, fields, None)?;
      }
      return Ok(Val::Null);
    }
    Err(error) => return Err(handle_error(collection_slug.get(), error, js::undefined(), req.get())),
  };

  if !truthy(result.get()) {
    return Ok(Val::Null);
  }

  transform_read(&this, &result, fields, None)?;

  Ok(result)
}

/// `{ ...baseOptions, lean: true, projection: buildProjectionFromSelect({ adapter: this, fields:
/// <config>.flattenedFields, select }), returnDocument: 'after' }`
fn find_options_after(this: &Val, config: &Val, select: &Val, base_options: &Val) -> JsResult<Val> {
  let projection = projection(this, get_val(config.get(), "flattenedFields")?, select)?;
  helpers::call_val("findOptionsAfter", &[base_options.get(), projection])
}

/// `buildProjectionFromSelect({ adapter: this, fields, select })`
fn projection(this: &Val, fields: Val, select: &Val) -> JsResult<Local> {
  deps::build_projection_from_select(BuildProjectionFromSelectArgs { adapter: this.clone(), fields, select: select.clone() })
}

/// `adapter.upsert(args)`: `return this.updateOne({ ..., options: { upsert: true }, ... })` (the
/// promise `this.updateOne` returns resolves the method's promise, like an `async` function's
/// `return`).
pub fn upsert(this: Val, args: Val) -> Body {
  Box::pin(async move {
    let [collection, data, locale, req, returning, select, where_] =
      crate::common::destructure::<7>("upsertArgs", &args)?;
    val(helpers::call_this(
      "upsertCall",
      this.get(),
      &[collection.get(), data.get(), locale.get(), req.get(), returning.get(), select.get(), where_.get()],
    )?)
  })
}

/// `adapter.updateMany(args)`
pub fn update_many(this: Val, args: Val) -> Body {
  Box::pin(update_many_body(this, args))
}

async fn update_many_body(this: Val, args: Val) -> JsResult<Val> {
  let [collection_slug, data, limit, locale, options_args, req, returning, select, sort_arg, where_] =
    crate::common::destructure::<10>("updateManyArgs", &args)?;

  let mut has_near_constraint = false;

  if truthy(where_.get()) {
    has_near_constraint = has_near(where_.get())?;
  }

  let entity::Collection { collection_config, model, .. } = entity::get_collection(this.get(), collection_slug.get(), false)?;

  let mut sort = Val::Undefined;
  if !has_near_constraint {
    let config = get_val(get(this.get(), "payload")?, "config")?;
    let fields = get_val(collection_config.get(), "flattenedFields")?;
    let sort_value = val(or_else(sort_arg.get(), || get(collection_config.get(), "defaultSort"))?)?;
    sort = val(deps::build_sort_param(BuildSortParamArgs {
      adapter: this.clone(),
      config,
      fields,
      locale: locale.clone(),
      parent_is_localized: Val::Undefined,
      sort: sort_value,
      sort_aggregation: Val::Undefined,
      timestamps: Val::Bool(true),
      versions: Val::Undefined,
    })?)?;
  }

  let mut query = {
    let flattened_fields = get_val(collection_config.get(), "flattenedFields")?;
    let p = deps::build_query(BuildQueryArgs {
      adapter: this.clone(),
      collection_slug: collection_slug.clone(),
      fields: flattened_fields,
      global_slug: Val::Undefined,
      locale: locale.clone(),
      where_: where_.clone(),
    })?;
    wait(p).await?
  };

  let ops = UpdateOperators::new()?;
  transform_write(&this, &data, get_val(collection_config.get(), "fields")?, None, Some(&ops))?;
  // `updateOps.$set = data; data = updateOps`
  let data = ops.apply(data)?;

  let base_options = base_options(&this, &options_args, &req).await?;
  let find_options = {
    let projection = projection(&this, get_val(collection_config.get(), "flattenedFields")?, &select)?;
    helpers::call_val("findOptionsLean", &[base_options.get(), projection])?
  };

  let outcome: JsResult<bool> = async {
    if is_number(limit.get()) && js::get_f64(limit.get()) > 0.0 {
      let p = helpers::call("modelFindIDs", &[model.get(), query.get(), find_options.get(), limit.get(), sort.get()])?;
      let documents_to_update = wait(p).await?;
      let length = get(documents_to_update.get(), "length")?;
      if is_number(length) && js::get_f64(length) == 0.0 {
        return Ok(true);
      }

      query = helpers::call_val("documentsToUpdateQuery", &[documents_to_update.get()])?;
    }

    let p = helpers::call("modelUpdateMany", &[model.get(), query.get(), data.get(), base_options.get()])?;
    wait(p).await?;
    Ok(false)
  }
  .await;
  match outcome {
    Ok(true) => return Ok(Val::Null),
    Ok(false) => {}
    Err(error) => return Err(handle_error(collection_slug.get(), error, js::undefined(), req.get())),
  }

  if is_false(returning.get()) {
    return Ok(Val::Null);
  }

  let p = helpers::call("modelFindSorted", &[model.get(), query.get(), find_options.get(), sort.get()])?;
  let result = wait(p).await?;

  transform_read(&this, &result, get_val(collection_config.get(), "fields")?, None)?;

  Ok(result)
}

/// `flattenWhereToOperators(where).some((prop) => Object.keys(prop).some((key) => key === 'near'))`
/// (payload-mongo-live host helper: upstream's expression).
fn has_near(where_: Local) -> JsResult<bool> {
  Ok(truthy(call("hasNearConstraint", &[where_])?))
}

/// `adapter.updateGlobal(args)`
pub fn update_global(this: Val, args: Val) -> Body {
  Box::pin(update_global_body(this, args))
}

async fn update_global_body(this: Val, args: Val) -> JsResult<Val> {
  let [global_slug, data, options_args, req, returning, select] =
    crate::common::destructure::<6>("updateGlobalArgs", &args)?;
  let entity::Global { global_config, model } = entity::get_global(this.get(), global_slug.get(), false)?;

  let fields = get_val(global_config.get(), "fields")?;

  transform_write(&this, &data, fields.clone(), Some(&global_slug), None)?;

  let base_options = base_options(&this, &options_args, &req).await?;
  let find_options = find_options_after(&this, &global_config, &select, &base_options)?;

  if is_false(returning.get()) {
    let p = helpers::call("modelUpdateOneGlobal", &[model.get(), global_slug.get(), data.get(), base_options.get()])?;
    wait(p).await?;
    return Ok(Val::Null);
  }

  let p =
    helpers::call("modelFindOneAndUpdateGlobal", &[model.get(), global_slug.get(), data.get(), find_options.get()])?;
  let result = wait(p).await?;

  transform_read(&this, &result, fields, Some(&global_slug))?;

  Ok(result)
}

/// `adapter.updateVersion(args)`
pub fn update_version(this: Val, args: Val) -> Body {
  Box::pin(update_version_body(this, args, false))
}

/// `adapter.updateGlobalVersion(args)`
pub fn update_global_version(this: Val, args: Val) -> Body {
  Box::pin(update_version_body(this, args, true))
}

async fn update_version_body(this: Val, args: Val, is_global: bool) -> JsResult<Val> {
  let helper = if is_global { "updateGlobalVersionArgs" } else { "updateVersionArgs" };
  let [id, slug, locale, options_args, req, returning, select, version_data, where_] =
    crate::common::destructure::<9>(helper, &args)?;

  let (entity_config, model) = if is_global {
    let g = entity::get_global(this.get(), slug.get(), true)?;
    (g.global_config, g.model)
  } else {
    let c = entity::get_collection(this.get(), slug.get(), true)?;
    (c.collection_config, c.model)
  };

  let where_to_use = if truthy(where_.get()) { where_ } else { helpers::call_val("idWhere", &[id.get()])? };
  let builder = if is_global { "buildVersionGlobalFields" } else { "buildVersionCollectionFields" };
  let fields = {
    let config = get(get(this.get(), "payload")?, "config")?;
    val(call(builder, &[config, entity_config.get()])?)?
  };
  let flattened_fields = {
    let config = get(get(this.get(), "payload")?, "config")?;
    val(call(builder, &[config, entity_config.get(), js::boolean(true)])?)?
  };

  let query = {
    let p = deps::build_query(BuildQueryArgs {
      adapter: this.clone(),
      collection_slug: Val::Undefined,
      fields: flattened_fields.clone(),
      global_slug: Val::Undefined,
      locale: locale.clone(),
      where_: where_to_use,
    })?;
    wait(p).await?
  };

  transform_write(&this, &version_data, fields.clone(), None, None)?;

  let base_options = base_options(&this, &options_args, &req).await?;
  let find_options = {
    let projection = projection(&this, flattened_fields, &select)?;
    helpers::call_val("findOptionsAfter", &[base_options.get(), projection])?
  };

  if is_false(returning.get()) {
    let p = helpers::call("modelUpdateOne", &[model.get(), query.get(), version_data.get(), base_options.get()])?;
    wait(p).await?;
    return Ok(Val::Null);
  }

  let p = helpers::call("modelFindOneAndUpdate", &[model.get(), query.get(), version_data.get(), find_options.get()])?;
  let doc = wait(p).await?;

  if !truthy(doc.get()) {
    return Ok(Val::Null);
  }

  transform_read(&this, &doc, fields, None)?;

  Ok(doc)
}
