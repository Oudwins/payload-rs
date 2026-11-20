//! `deleteOne.ts`, `deleteMany.ts`, `deleteVersions.ts`.

use crate::drive::{Body, wait};
use payload_core_runtime::js::{self, JsResult, Val};
use payload_mongo_live::deps::{self, BuildProjectionFromSelectArgs, BuildQueryArgs};
use payload_mongo_live::entity;
use payload_mongo_live::error::api_error;
use payload_mongo_live::host::{call, get, get_val, is_false, truthy, val};
use payload_mongo_live::session;

use crate::common::{destructure, transform_read};
use crate::helpers;

/// `adapter.deleteOne(args)`
pub fn delete_one(this: Val, args: Val) -> Body {
  Box::pin(delete_one_body(this, args))
}

async fn delete_one_body(this: Val, args: Val) -> JsResult<Val> {
  let [collection_slug, req, returning, select, where_] = destructure::<5>("deleteOneArgs", &args)?;
  let entity::Collection { collection_config, model, .. } = entity::get_collection(this.get(), collection_slug.get(), false)?;

  let query = build_query(&this, collection_slug.clone(), get_val(collection_config.get(), "flattenedFields")?, Val::Undefined, where_)?;
  let query = wait(query.get()).await?;

  // { projection: buildProjectionFromSelect(...), session: await getSession(this, req) }
  let projection = val(deps::build_projection_from_select(BuildProjectionFromSelectArgs {
    adapter: this.clone(),
    fields: get_val(collection_config.get(), "flattenedFields")?,
    select,
  })?)?;
  let session = wait(session::get_session(this.get(), req.get())?).await?;
  let options = helpers::call_val("deleteOneOptions", &[projection.get(), session.get()])?;

  if is_false(returning.get()) {
    let p = helpers::call("modelDeleteOneLean", &[model.get(), query.get(), options.get()])?;
    wait(p).await?;
    return Ok(Val::Null);
  }

  let p = helpers::call("modelFindOneAndDeleteLean", &[model.get(), query.get(), options.get()])?;
  let doc = wait(p).await?;

  if !truthy(doc.get()) {
    return Ok(Val::Null);
  }

  transform_read(&this, &doc, get_val(collection_config.get(), "fields")?, None)?;

  Ok(doc)
}

/// `adapter.deleteMany(args)`
pub fn delete_many(this: Val, args: Val) -> Body {
  Box::pin(delete_many_body(this, args))
}

async fn delete_many_body(this: Val, args: Val) -> JsResult<Val> {
  let [collection_slug, req, where_] = destructure::<3>("deleteManyArgs", &args)?;
  let entity::Collection { collection_config, model, .. } = entity::get_collection(this.get(), collection_slug.get(), false)?;

  let query = build_query(&this, collection_slug.clone(), get_val(collection_config.get(), "flattenedFields")?, Val::Undefined, where_)?;
  let query = wait(query.get()).await?;

  let session = wait(session::get_session(this.get(), req.get())?).await?;
  let p = helpers::call("modelDeleteMany", &[model.get(), query.get(), session.get()])?;
  wait(p).await?;
  Ok(Val::Undefined)
}

/// `adapter.deleteVersions(args)`
pub fn delete_versions(this: Val, args: Val) -> Body {
  Box::pin(delete_versions_body(this, args))
}

async fn delete_versions_body(this: Val, args: Val) -> JsResult<Val> {
  let [collection_slug, global_slug, locale, req, where_] = destructure::<5>("deleteVersionsArgs", &args)?;

  let (fields, versions_model) = if truthy(global_slug.get()) {
    let g = entity::get_global(this.get(), global_slug.get(), true)?;
    let config = get(get(this.get(), "payload")?, "config")?;
    let fields = val(call("buildVersionGlobalFields", &[config, g.global_config.get(), js::boolean(true)])?)?;
    (fields, g.model)
  } else if truthy(collection_slug.get()) {
    let c = entity::get_collection(this.get(), collection_slug.get(), true)?;
    let config = get(get(this.get(), "payload")?, "config")?;
    let fields = val(call("buildVersionCollectionFields", &[config, c.collection_config.get(), js::boolean(true)])?)?;
    (fields, c.model)
  } else {
    return Err(api_error("Either collection or globalSlug must be passed."));
  };

  let query = build_query(&this, Val::Undefined, fields, locale, where_)?;
  let query = wait(query.get()).await?;

  let session = wait(session::get_session(this.get(), req.get())?).await?;

  let p = helpers::call("versionsModelDeleteMany", &[versions_model.get(), query.get(), session.get()])?;
  wait(p).await?;
  Ok(Val::Undefined)
}

/// `buildQuery({ adapter: this, [collectionSlug,] fields, [locale,] where })`: its promise.
fn build_query(this: &Val, collection_slug: Val, fields: Val, locale: Val, where_: Val) -> JsResult<Val> {
  val(deps::build_query(BuildQueryArgs {
    adapter: this.clone(),
    collection_slug,
    fields,
    global_slug: Val::Undefined,
    locale,
    where_,
  })?)
}
