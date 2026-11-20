//! The read data methods of `@payloadcms/db-mongodb` (`find.ts`, `findOne.ts`, `count.ts`,
//! `countVersions.ts`, `countGlobalVersions.ts`, `findDistinct.ts`, `findGlobal.ts`,
//! `findVersions.ts`, `findGlobalVersions.ts`, `queryDrafts.ts`, `utilities/aggregatePaginate.ts`),
//! live. Each `pub fn` is the call of the TS `async function` (with `this` = the adapter): it returns
//! the promise of a spawned task; the parameter destructuring runs inside the task (a throw there
//! rejects), through a host helper with upstream's exact pattern.
//!
//! Every `await` of the TS is an `await_js` here, at the same point, also where the awaited value is
//! not a promise (engine review item 2). `Promise.all` is the JS one (fail-fast). The caller's
//! `where` / `sort` / `select` objects, `req`, the documents and the models are the live objects;
//! query / sort / projection / transform / join building mutate them in place exactly like upstream
//! (engine review item 5: nothing to report back).

use payload_core_query::live::where_query::combine_queries;
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::deps::{
  self, BuildJoinAggregationArgs, BuildProjectionFromSelectArgs, BuildQueryArgs, BuildSortParamArgs,
  ResolveJoinsArgs, TransformArgs,
};
use crate::entity::{Collection, Global, get_collection, get_global};
use crate::host::{
  add, array_of, call, call_method, call_val, get, get_key, gt, is_false, is_number, literal, mul,
  nullish_or, object_keys_length, opt, or_else, set, set_key, str_eq, sub, truthy, val,
};
use crate::session::get_session;

fn at(d: Local, i: u32) -> JsResult<Val> {
  val(js::get_element(d, i)?)
}

fn spawn_method(
  adapter: Local,
  args: Local,
  run: fn(Val, Val) -> std::pin::Pin<Box<dyn Future<Output = JsResult<Val>>>>,
) -> JsResult<Local> {
  let adapter = val(adapter)?;
  let args = val(args)?;
  spawn(run(adapter, args))
}

/// `hasNearConstraint = flattenWhereToOperators(where).some(...)` (the TS reads `where` once more
/// in its `if (where)` check, done by the caller).
fn has_near_constraint(where_: Local) -> JsResult<bool> {
  Ok(js::truthy(call("hasNearConstraint", &[where_])?))
}

/// `hasNearConstraint || !query || Object.keys(query).length === 0`
fn use_estimated_count(has_near: bool, query: Local) -> JsResult<bool> {
  Ok(has_near || !truthy(query) || object_keys_length(query)? == 0)
}

/// `if (this.collation) { ... target.collation = { locale: ..., ...this.collation } }`
fn apply_collation(this: Local, locale: Local, target: Local) -> JsResult<()> {
  if truthy(get(this, "collation")?) {
    set(target, "collation", call("collationOf", &[this, locale])?)?;
  }
  Ok(())
}

/// `this.disableIndexHints !== true`
fn index_hints_enabled(this: Local) -> JsResult<bool> {
  let v = get(this, "disableIndexHints")?;
  Ok(!(js::type_of(v) == js::Type::Boolean && js::get_bool(v)))
}

/// The `useCustomCountFn` branches of find / findVersions / findGlobalVersions (`with_else`: the
/// `else if (!useEstimatedCount && this.collation)` collation workaround branch; queryDrafts has none).
fn apply_custom_count_fn(
  this: Local,
  use_estimated: bool,
  query: Local,
  model: Local,
  pagination_options: Local,
  session: Local,
  with_else: bool,
) -> JsResult<()> {
  if !use_estimated && object_keys_length(query)? == 0 && index_hints_enabled(this)? {
    let f = call("customCountFn", &[model, query, pagination_options, session, js::boolean(true)])?;
    set(pagination_options, "useCustomCountFn", f)?;
  } else if with_else && !use_estimated && truthy(get(this, "collation")?) {
    let f = call("customCountFn", &[model, query, pagination_options, session, js::boolean(false)])?;
    set(pagination_options, "useCustomCountFn", f)?;
  }
  Ok(())
}

/// `if (limit >= 0) { paginationOptions.limit = limit; paginationOptions.options!.limit = limit;
/// if (limit === 0) paginationOptions.pagination = false }`
fn apply_limit(pagination_options: Local, limit: Local) -> JsResult<()> {
  let ge = if is_number(limit) {
    js::get_f64(limit) >= 0.0
  } else {
    js::truthy(call("binop", &[js::string(">="), limit, js::number(0.0)])?)
  };
  if ge {
    set(pagination_options, "limit", limit)?;
    set(get(pagination_options, "options")?, "limit", limit)?;
    if js::strict_equals(limit, js::number(0.0)) {
      set(pagination_options, "pagination", js::boolean(false))?;
    }
  }
  Ok(())
}

/// `transform({ adapter: this, data, fields, operation: 'read' })`
fn transform_read(this: &Val, data: Local, fields: Local) -> JsResult<()> {
  deps::transform(TransformArgs {
    add_to_set: Val::Undefined,
    inc: Val::Undefined,
    pull: Val::Undefined,
    push: Val::Undefined,
    adapter: this.clone(),
    data: val(data)?,
    fields: val(fields)?,
    global_slug: Val::Undefined,
    operation: val(js::string("read"))?,
    parent_is_localized: Val::Undefined,
    validate_relationships: Val::Undefined,
  })?;
  Ok(())
}

fn build_query(adapter: &Val, collection_slug: Val, fields: Val, global_slug: Val, locale: &Val, where_: Val) -> JsResult<Local> {
  deps::build_query(BuildQueryArgs {
    adapter: adapter.clone(),
    collection_slug,
    fields,
    global_slug,
    locale: locale.clone(),
    where_,
  })
}

fn build_projection(adapter: &Val, fields: Local, select: &Val) -> JsResult<Local> {
  deps::build_projection_from_select(BuildProjectionFromSelectArgs {
    adapter: adapter.clone(),
    fields: val(fields)?,
    select: select.clone(),
  })
}

// ---------------------------------------------------------------------------------------------
// find

/// `adapter.find(args)`
pub fn find(adapter: Local, args: Local) -> JsResult<Local> {
  spawn_method(adapter, args, |a, b| Box::pin(run_find(a, b)))
}

async fn run_find(this: Val, incoming: Val) -> JsResult<Val> {
  let d = call("findArgs", &[incoming.get()])?;
  let collection_slug = at(d, 0)?;
  let drafts_enabled = at(d, 1)?;
  let joins = at(d, 2)?;
  let limit = at(d, 3)?;
  let locale = at(d, 4)?;
  let page = at(d, 5)?;
  let pagination = at(d, 6)?;
  let projection = at(d, 7)?;
  let req = at(d, 8)?;
  let select = at(d, 9)?;
  let sort_arg = at(d, 10)?;
  let where_ = at(d, 11)?;

  let Collection { collection_config, model, .. } = get_collection(this.get(), collection_slug.get(), false)?;

  let mut has_near = false;
  if truthy(where_.get()) {
    has_near = has_near_constraint(where_.get())?;
  }

  let sort_aggregation = val(js::array())?;

  let mut sort = Val::Undefined;
  if !has_near {
    let config = val(get(get(this.get(), "payload")?, "config")?)?;
    let fields = val(get(collection_config.get(), "flattenedFields")?)?;
    let sort_value = val(or_else(sort_arg.get(), || get(collection_config.get(), "defaultSort"))?)?;
    let timestamps = val(or_else(get(collection_config.get(), "timestamps")?, || Ok(js::boolean(false)))?)?;
    sort = val(deps::build_sort_param(BuildSortParamArgs {
      adapter: this.clone(),
      config,
      fields,
      locale: locale.clone(),
      parent_is_localized: Val::Undefined,
      sort: sort_value,
      sort_aggregation: sort_aggregation.clone(),
      timestamps,
      versions: Val::Undefined,
    })?)?;
  }

  let fields = val(get(collection_config.get(), "flattenedFields")?)?;
  let p = build_query(&this, collection_slug.clone(), fields, Val::Undefined, &locale, where_.clone())?;
  let query = await_js(p).await?;

  let session = await_js(get_session(this.get(), req.get())?).await?;

  let use_estimated = use_estimated_count(has_near, query.get())?;
  let options = literal(&[("session", session.get())])?;
  let pagination_options = val(literal(&[
    ("lean", js::boolean(true)),
    ("leanWithId", js::boolean(true)),
    ("options", options),
    ("page", page.get()),
    ("pagination", pagination.get()),
    ("projection", projection.get()),
    ("sort", sort.get()),
    ("useEstimatedCount", js::boolean(use_estimated)),
  ])?)?;

  if truthy(select.get()) {
    let projection = build_projection(&this, get(collection_config.get(), "flattenedFields")?, &select)?;
    set(pagination_options.get(), "projection", projection)?;
  }

  apply_collation(this.get(), locale.get(), pagination_options.get())?;
  apply_custom_count_fn(
    this.get(),
    use_estimated,
    query.get(),
    model.get(),
    pagination_options.get(),
    session.get(),
    true,
  )?;
  apply_limit(pagination_options.get(), limit.get())?;

  let p = deps::build_join_aggregation(BuildJoinAggregationArgs {
    adapter: this.clone(),
    collection: collection_slug.clone(),
    collection_config: collection_config.clone(),
    drafts_enabled,
    joins: joins.clone(),
    locale: locale.clone(),
    projection: val(get(pagination_options.get(), "projection")?)?,
    query: query.clone(),
    versions: Val::Undefined,
  })?;
  let aggregate = await_js(p).await?;

  let result = paginate_or_aggregate(&this, &model, &query, &pagination_options, &aggregate, &sort_aggregation).await?;

  if !truthy(get(this.get(), "useJoinAggregations")?) {
    let p = deps::resolve_joins(ResolveJoinsArgs {
      adapter: this.clone(),
      collection_slug: collection_slug.clone(),
      docs: val(get(result.get(), "docs")?)?,
      joins: joins.clone(),
      locale: locale.clone(),
      projection: Val::Undefined,
      versions: Val::Undefined,
    })?;
    await_js(p).await?;
  }

  transform_read(&this, get(result.get(), "docs")?, get(collection_config.get(), "fields")?)?;

  Ok(result)
}

/// `if (aggregate.length > 0 || sortAggregation.length > 0) result = await aggregatePaginate({...})
/// else result = await Model.paginate(query, paginationOptions)` (find and queryDrafts).
async fn paginate_or_aggregate(
  this: &Val,
  model: &Val,
  query: &Val,
  pagination_options: &Val,
  aggregate: &Val,
  sort_aggregation: &Val,
) -> JsResult<Val> {
  let zero = js::number(0.0);
  let use_aggregate = gt(get(aggregate.get(), "length")?, zero)? || gt(get(sort_aggregation.get(), "length")?, zero)?;
  if use_aggregate {
    let po = pagination_options.get();
    let session = nullish_or(opt(get(po, "options")?, "session")?, || Ok(js::undefined()))?;
    let p = aggregate_paginate(AggregatePaginateArgs {
      adapter: this.clone(),
      collation: val(get(po, "collation")?)?,
      join_aggregation: aggregate.clone(),
      limit: val(get(po, "limit")?)?,
      model: model.clone(),
      page: val(get(po, "page")?)?,
      pagination: val(get(po, "pagination")?)?,
      projection: val(get(po, "projection")?)?,
      query: query.clone(),
      session: val(session)?,
      sort: val(get(po, "sort")?)?,
      sort_aggregation: sort_aggregation.clone(),
      use_estimated_count: val(get(po, "useEstimatedCount")?)?,
    })?;
    await_js(p).await
  } else {
    let p = call_method(model.get(), "paginate", &[query.get(), pagination_options.get()], "Model.paginate")?;
    await_js(p).await
  }
}

// ---------------------------------------------------------------------------------------------
// findOne

/// `adapter.findOne(args)`
pub fn find_one(adapter: Local, args: Local) -> JsResult<Local> {
  spawn_method(adapter, args, |a, b| Box::pin(run_find_one(a, b)))
}

async fn run_find_one(this: Val, incoming: Val) -> JsResult<Val> {
  let d = call("findOneArgs", &[incoming.get()])?;
  let collection_slug = at(d, 0)?;
  let drafts_enabled = at(d, 1)?;
  let joins = at(d, 2)?;
  let locale = at(d, 3)?;
  let req = at(d, 4)?;
  let select = at(d, 5)?;
  let where_ = at(d, 6)?;

  let Collection { collection_config, model, .. } = get_collection(this.get(), collection_slug.get(), false)?;

  let fields = val(get(collection_config.get(), "flattenedFields")?)?;
  let p = build_query(&this, collection_slug.clone(), fields, Val::Undefined, &locale, where_)?;
  let query = await_js(p).await?;

  let projection = val(build_projection(&this, get(collection_config.get(), "flattenedFields")?, &select)?)?;

  let p = deps::build_join_aggregation(BuildJoinAggregationArgs {
    adapter: this.clone(),
    collection: collection_slug.clone(),
    collection_config: collection_config.clone(),
    drafts_enabled,
    joins: joins.clone(),
    locale: locale.clone(),
    projection: projection.clone(),
    query: query.clone(),
    versions: Val::Undefined,
  })?;
  let aggregate = await_js(p).await?;

  let session = await_js(get_session(this.get(), req.get())?).await?;
  let options = val(literal(&[("lean", js::boolean(true)), ("session", session.get())])?)?;

  let doc;
  if gt(get(aggregate.get(), "length")?, js::number(0.0))? {
    let p = aggregate_paginate(AggregatePaginateArgs {
      adapter: this.clone(),
      collation: Val::Undefined,
      join_aggregation: aggregate.clone(),
      limit: Val::Num(1.0),
      model: model.clone(),
      page: Val::Undefined,
      pagination: Val::Bool(false),
      projection: projection.clone(),
      query: query.clone(),
      session: session.clone(),
      sort: Val::Undefined,
      sort_aggregation: Val::Undefined,
      use_estimated_count: Val::Undefined,
    })?;
    let result = await_js(p).await?;
    // const { docs } = ...; doc = docs[0]
    doc = val(get_key(get(result.get(), "docs")?, js::number(0.0))?)?;
  } else {
    set(options.get(), "projection", projection.get())?;
    let p = call_method(model.get(), "findOne", &[query.get(), js::object(), options.get()], "Model.findOne")?;
    doc = await_js(p).await?;
  }

  if truthy(doc.get()) && !truthy(get(this.get(), "useJoinAggregations")?) {
    let p = deps::resolve_joins(ResolveJoinsArgs {
      adapter: this.clone(),
      collection_slug: collection_slug.clone(),
      docs: val(array_of(&[doc.get()])?)?,
      joins: joins.clone(),
      locale: locale.clone(),
      projection: Val::Undefined,
      versions: Val::Undefined,
    })?;
    await_js(p).await?;
  }

  if !truthy(doc.get()) {
    return Ok(Val::Null);
  }

  transform_read(&this, doc.get(), get(collection_config.get(), "fields")?)?;

  Ok(doc)
}

// ---------------------------------------------------------------------------------------------
// count, countVersions, countGlobalVersions

#[derive(Clone, Copy)]
enum CountKind {
  Collection,
  Versions,
  GlobalVersions,
}

/// `adapter.count(args)`
pub fn count(adapter: Local, args: Local) -> JsResult<Local> {
  spawn_method(adapter, args, |a, b| Box::pin(run_count(a, b, CountKind::Collection)))
}

/// `adapter.countVersions(args)`
pub fn count_versions(adapter: Local, args: Local) -> JsResult<Local> {
  spawn_method(adapter, args, |a, b| Box::pin(run_count(a, b, CountKind::Versions)))
}

/// `adapter.countGlobalVersions(args)`
pub fn count_global_versions(adapter: Local, args: Local) -> JsResult<Local> {
  spawn_method(adapter, args, |a, b| Box::pin(run_count(a, b, CountKind::GlobalVersions)))
}

async fn run_count(this: Val, incoming: Val, kind: CountKind) -> JsResult<Val> {
  let helper = match kind {
    CountKind::GlobalVersions => "countGlobalVersionsArgs",
    _ => "countArgs",
  };
  let d = call(helper, &[incoming.get()])?;
  let slug = at(d, 0)?;
  let locale = at(d, 1)?;
  let req = at(d, 2)?;
  let where_ = at(d, 3)?;

  let model;
  let mut collection_config = Val::Undefined;
  let mut global_config = Val::Undefined;
  match kind {
    CountKind::Collection | CountKind::Versions => {
      let c = get_collection(this.get(), slug.get(), matches!(kind, CountKind::Versions))?;
      collection_config = c.collection_config;
      model = c.model;
    }
    CountKind::GlobalVersions => {
      let g = get_global(this.get(), slug.get(), true)?;
      global_config = g.global_config;
      model = g.model;
    }
  }

  let mut has_near = false;
  if truthy(where_.get()) {
    has_near = has_near_constraint(where_.get())?;
  }

  let p = match kind {
    CountKind::Collection => {
      let fields = val(get(collection_config.get(), "flattenedFields")?)?;
      build_query(&this, slug.clone(), fields, Val::Undefined, &locale, where_.clone())?
    }
    CountKind::Versions => {
      let config = get(get(this.get(), "payload")?, "config")?;
      let fields = call_val("buildVersionCollectionFields", &[config, collection_config.get(), js::boolean(true)])?;
      build_query(&this, Val::Undefined, fields, Val::Undefined, &locale, where_.clone())?
    }
    CountKind::GlobalVersions => {
      let config = get(get(this.get(), "payload")?, "config")?;
      let fields = call_val("buildVersionGlobalFields", &[config, global_config.get(), js::boolean(true)])?;
      build_query(&this, Val::Undefined, fields, Val::Undefined, &locale, where_.clone())?
    }
  };
  let query = await_js(p).await?;

  let use_estimated = use_estimated_count(has_near, query.get())?;

  let session = await_js(get_session(this.get(), req.get())?).await?;
  let options = val(literal(&[("session", session.get())])?)?;

  apply_collation(this.get(), locale.get(), options.get())?;

  if !use_estimated && object_keys_length(query.get())? == 0 && index_hints_enabled(this.get())? {
    set(options.get(), "hint", literal(&[("_id", js::number(1.0))])?)?;
  }

  let p = if use_estimated {
    let session_options = literal(&[("session", get(options.get(), "session")?)])?;
    call_method(model.get(), "estimatedDocumentCount", &[session_options], "Model.estimatedDocumentCount")?
  } else {
    call_method(model.get(), "countDocuments", &[query.get(), options.get()], "Model.countDocuments")?
  };
  let result = await_js(p).await?;

  val(literal(&[("totalDocs", result.get())])?)
}

// ---------------------------------------------------------------------------------------------
// findGlobal

/// `adapter.findGlobal(args)`
pub fn find_global(adapter: Local, args: Local) -> JsResult<Local> {
  spawn_method(adapter, args, |a, b| Box::pin(run_find_global(a, b)))
}

async fn run_find_global(this: Val, incoming: Val) -> JsResult<Val> {
  let d = call("findGlobalArgs", &[incoming.get()])?;
  let global_slug = at(d, 0)?;
  let locale = at(d, 1)?;
  let req = at(d, 2)?;
  let select = at(d, 3)?;
  let where_ = at(d, 4)?;

  let Global { global_config, model } = get_global(this.get(), global_slug.get(), false)?;

  let fields = val(get(global_config.get(), "flattenedFields")?)?;

  let global_type = literal(&[("globalType", literal(&[("equals", global_slug.get())])?)])?;
  let combined = val(combine_queries(global_type, where_.get())?)?;
  let p = build_query(&this, Val::Undefined, fields.clone(), global_slug.clone(), &locale, combined)?;
  let query = await_js(p).await?;

  // { lean: true, select: buildProjectionFromSelect(...), session: await getSession(this, req) }
  let projection = val(build_projection(&this, fields.get(), &select)?)?;
  let session = await_js(get_session(this.get(), req.get())?).await?;
  let options = literal(&[("lean", js::boolean(true)), ("select", projection.get()), ("session", session.get())])?;

  let p = call_method(model.get(), "findOne", &[query.get(), js::object(), options], "Model.findOne")?;
  let doc = await_js(p).await?;

  if !truthy(doc.get()) {
    return Ok(Val::Null);
  }

  transform_read(&this, doc.get(), get(global_config.get(), "fields")?)?;

  Ok(doc)
}

// ---------------------------------------------------------------------------------------------
// findVersions, findGlobalVersions

/// `adapter.findVersions(args)`
pub fn find_versions(adapter: Local, args: Local) -> JsResult<Local> {
  spawn_method(adapter, args, |a, b| Box::pin(run_find_versions(a, b, false)))
}

/// `adapter.findGlobalVersions(args)`
pub fn find_global_versions(adapter: Local, args: Local) -> JsResult<Local> {
  spawn_method(adapter, args, |a, b| Box::pin(run_find_versions(a, b, true)))
}

async fn run_find_versions(this: Val, incoming: Val, is_global: bool) -> JsResult<Val> {
  let helper = if is_global { "findGlobalVersionsArgs" } else { "findVersionsArgs" };
  let d = call(helper, &[incoming.get()])?;
  let slug = at(d, 0)?;
  let limit = at(d, 1)?;
  let locale = at(d, 2)?;
  let page = at(d, 3)?;
  let pagination = at(d, 4)?;
  let req = at(d, 5)?;
  let select = at(d, 6)?;
  let sort_arg = at(d, 7)?;
  let where_ = at(d, 8)?;

  let model;
  let entity_config;
  // findGlobalVersions builds `versionFields` right after `getGlobal`
  let mut version_fields = Val::Undefined;
  if is_global {
    let g = get_global(this.get(), slug.get(), true)?;
    model = g.model;
    entity_config = g.global_config;
    let config = get(get(this.get(), "payload")?, "config")?;
    version_fields = call_val("buildVersionGlobalFields", &[config, entity_config.get(), js::boolean(true)])?;
  } else {
    let c = get_collection(this.get(), slug.get(), true)?;
    model = c.model;
    entity_config = c.collection_config;
  }

  let mut has_near = false;
  if truthy(where_.get()) {
    has_near = has_near_constraint(where_.get())?;
  }

  let mut sort = Val::Undefined;
  if !has_near {
    let config = val(get(get(this.get(), "payload")?, "config")?)?;
    let fields = if is_global { version_fields.clone() } else { val(get(entity_config.get(), "flattenedFields")?)? };
    let sort_value = val(or_else(sort_arg.get(), || Ok(js::string("-updatedAt")))?)?;
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

  let fields = if is_global {
    version_fields.clone()
  } else {
    let config = get(get(this.get(), "payload")?, "config")?;
    call_val("buildVersionCollectionFields", &[config, entity_config.get(), js::boolean(true)])?
  };

  let p = build_query(&this, Val::Undefined, fields.clone(), Val::Undefined, &locale, where_.clone())?;
  let query = await_js(p).await?;

  let session = await_js(get_session(this.get(), req.get())?).await?;
  // typeof page === 'number' && page > 1 ? (page - 1) * (limit || 0) : undefined
  let skip = if is_number(page.get()) && js::get_f64(page.get()) > 1.0 {
    let limit_or_zero = or_else(limit.get(), || Ok(js::number(0.0)))?;
    mul(sub(page.get(), js::number(1.0))?, limit_or_zero)?
  } else {
    js::undefined()
  };
  let options = literal(&[("limit", limit.get()), ("session", session.get()), ("skip", skip)])?;

  let use_estimated = use_estimated_count(has_near, query.get())?;
  let projection = build_projection(&this, fields.get(), &select)?;
  let pagination_options = val(literal(&[
    ("lean", js::boolean(true)),
    ("leanWithId", js::boolean(true)),
    ("limit", limit.get()),
    ("options", options),
    ("page", page.get()),
    ("pagination", pagination.get()),
    ("projection", projection),
    ("sort", sort.get()),
    ("useEstimatedCount", js::boolean(use_estimated)),
  ])?)?;

  apply_collation(this.get(), locale.get(), pagination_options.get())?;
  apply_custom_count_fn(
    this.get(),
    use_estimated,
    query.get(),
    model.get(),
    pagination_options.get(),
    session.get(),
    true,
  )?;
  apply_limit(pagination_options.get(), limit.get())?;

  let p = call_method(model.get(), "paginate", &[query.get(), pagination_options.get()], "Model.paginate")?;
  let result = await_js(p).await?;

  let config = get(get(this.get(), "payload")?, "config")?;
  let read_fields = if is_global {
    call("buildVersionGlobalFields", &[config, entity_config.get()])?
  } else {
    call("buildVersionCollectionFields", &[config, entity_config.get()])?
  };
  let read_fields = val(read_fields)?;
  transform_read(&this, get(result.get(), "docs")?, read_fields.get())?;

  Ok(result)
}

// ---------------------------------------------------------------------------------------------
// queryDrafts

/// `adapter.queryDrafts(args)`
pub fn query_drafts(adapter: Local, args: Local) -> JsResult<Local> {
  spawn_method(adapter, args, |a, b| Box::pin(run_query_drafts(a, b)))
}

async fn run_query_drafts(this: Val, incoming: Val) -> JsResult<Val> {
  let d = call("queryDraftsArgs", &[incoming.get()])?;
  let collection_slug = at(d, 0)?;
  let joins = at(d, 1)?;
  let limit = at(d, 2)?;
  let locale = at(d, 3)?;
  let page = at(d, 4)?;
  let pagination = at(d, 5)?;
  let req = at(d, 6)?;
  let select = at(d, 7)?;
  let sort_arg = at(d, 8)?;
  let where_ = at(d, 9)?;

  let Collection { collection_config, model, .. } = get_collection(this.get(), collection_slug.get(), true)?;

  // `let hasNearConstraint` (undefined unless `where` is truthy)
  let mut has_near = false;
  if truthy(where_.get()) {
    has_near = has_near_constraint(where_.get())?;
  }

  let config = get(get(this.get(), "payload")?, "config")?;
  let fields = call_val("buildVersionCollectionFields", &[config, collection_config.get(), js::boolean(true)])?;

  let sort_aggregation = val(js::array())?;
  let mut sort = Val::Undefined;
  if !has_near {
    let config = val(get(get(this.get(), "payload")?, "config")?)?;
    let sort_value = val(or_else(sort_arg.get(), || get(collection_config.get(), "defaultSort"))?)?;
    sort = val(deps::build_sort_param(BuildSortParamArgs {
      adapter: this.clone(),
      config,
      fields: fields.clone(),
      locale: locale.clone(),
      parent_is_localized: Val::Undefined,
      sort: sort_value,
      sort_aggregation: sort_aggregation.clone(),
      timestamps: Val::Bool(true),
      versions: Val::Bool(true),
    })?)?;
  }

  let latest = literal(&[("latest", literal(&[("equals", js::boolean(true))])?)])?;
  let combined_where = val(combine_queries(latest, where_.get())?)?;

  let p = build_query(&this, Val::Undefined, fields.clone(), Val::Undefined, &locale, combined_where)?;
  let version_query = await_js(p).await?;

  let projection = val(build_projection(&this, fields.get(), &select)?)?;

  let session = await_js(get_session(this.get(), req.get())?).await?;
  let options = literal(&[("session", session.get())])?;

  let use_estimated = use_estimated_count(has_near, version_query.get())?;
  let pagination_options = val(literal(&[
    ("lean", js::boolean(true)),
    ("leanWithId", js::boolean(true)),
    ("options", options),
    ("page", page.get()),
    ("pagination", pagination.get()),
    ("projection", projection.get()),
    ("sort", sort.get()),
    ("useEstimatedCount", js::boolean(use_estimated)),
  ])?)?;

  apply_collation(this.get(), locale.get(), pagination_options.get())?;
  apply_custom_count_fn(
    this.get(),
    use_estimated,
    version_query.get(),
    model.get(),
    pagination_options.get(),
    session.get(),
    false,
  )?;

  // if (limit && limit > 0)
  if truthy(limit.get()) && gt(limit.get(), js::number(0.0))? {
    set(pagination_options.get(), "limit", limit.get())?;
    set(get(pagination_options.get(), "options")?, "limit", limit.get())?;
  }

  let p = deps::build_join_aggregation(BuildJoinAggregationArgs {
    adapter: this.clone(),
    collection: collection_slug.clone(),
    collection_config: collection_config.clone(),
    drafts_enabled: Val::Undefined,
    joins: joins.clone(),
    locale: locale.clone(),
    projection: projection.clone(),
    query: version_query.clone(),
    versions: Val::Bool(true),
  })?;
  let aggregate = await_js(p).await?;

  let result =
    paginate_or_aggregate(&this, &model, &version_query, &pagination_options, &aggregate, &sort_aggregation).await?;

  if !truthy(get(this.get(), "useJoinAggregations")?) {
    let p = deps::resolve_joins(ResolveJoinsArgs {
      adapter: this.clone(),
      collection_slug: collection_slug.clone(),
      docs: val(get(result.get(), "docs")?)?,
      joins: joins.clone(),
      locale: locale.clone(),
      projection: Val::Undefined,
      versions: Val::Bool(true),
    })?;
    await_js(p).await?;
  }

  let config = get(get(this.get(), "payload")?, "config")?;
  let read_fields = val(call("buildVersionCollectionFields", &[config, collection_config.get()])?)?;
  transform_read(&this, get(result.get(), "docs")?, read_fields.get())?;

  // for (let i = 0; i < result.docs.length; i++) { const id = result.docs[i].parent;
  //   result.docs[i] = result.docs[i].version ?? {}; result.docs[i].id = id }
  let mut i = 0u32;
  loop {
    let index = js::number(f64::from(i));
    let length = get(get(result.get(), "docs")?, "length")?;
    if !gt(length, index)? {
      break;
    }
    let id = get(get_key(get(result.get(), "docs")?, index)?, "parent")?;
    let id = val(id)?;
    let docs = get(result.get(), "docs")?;
    let version = nullish_or(get(get_key(get(result.get(), "docs")?, index)?, "version")?, || Ok(js::object()))?;
    set_key(docs, index, version)?;
    set(get_key(get(result.get(), "docs")?, index)?, "id", id.get())?;
    i += 1;
  }

  Ok(result)
}

// ---------------------------------------------------------------------------------------------
// aggregatePaginate

/// `aggregatePaginate({ adapter, collation, joinAggregation, limit, Model, page, pagination,
/// projection, query, session, sort, sortAggregation, useEstimatedCount })` (async arrow).
pub struct AggregatePaginateArgs {
  pub adapter: Val,
  pub collation: Val,
  pub join_aggregation: Val,
  pub limit: Val,
  pub model: Val,
  pub page: Val,
  pub pagination: Val,
  pub projection: Val,
  pub query: Val,
  pub session: Val,
  pub sort: Val,
  pub sort_aggregation: Val,
  pub use_estimated_count: Val,
}

/// Calls `aggregatePaginate(args)`: its promise.
pub fn aggregate_paginate(a: AggregatePaginateArgs) -> JsResult<Local> {
  spawn(run_aggregate_paginate(a))
}

async fn run_aggregate_paginate(a: AggregatePaginateArgs) -> JsResult<Val> {
  let query = a.query.get();
  let aggregation = array_of(&[literal(&[("$match", query)])?])?;

  let sort_aggregation = a.sort_aggregation.get();
  if truthy(sort_aggregation) && gt(get(sort_aggregation, "length")?, js::number(0.0))? {
    call("pushEach", &[aggregation, sort_aggregation])?;
  }

  let sort = a.sort.get();
  if truthy(sort) {
    call("pushSortStage", &[aggregation, sort])?;
  }

  let page = a.page.get();
  let limit = a.limit.get();
  if truthy(page) {
    // { $skip: (page - 1) * (limit ?? 0) }
    let skip = mul(sub(page, js::number(1.0))?, nullish_or(limit, || Ok(js::number(0.0)))?)?;
    js::push(aggregation, literal(&[("$skip", skip)])?)?;
  }

  if truthy(limit) {
    js::push(aggregation, literal(&[("$limit", limit)])?)?;
  }

  let join_aggregation = a.join_aggregation.get();
  if truthy(join_aggregation) {
    call("pushEach", &[aggregation, join_aggregation])?;
  }

  let projection = a.projection.get();
  if truthy(projection) {
    js::push(aggregation, literal(&[("$project", projection)])?)?;
  }
  let aggregation = val(aggregation)?;

  let mut count_promise = call_val("resolvedNull", &[])?;

  let pagination = a.pagination.get();
  if !is_false(pagination) && truthy(limit) {
    let model = a.model.get();
    if truthy(a.use_estimated_count.get()) {
      count_promise = val(call_method(model, "estimatedDocumentCount", &[query], "Model.estimatedDocumentCount")?)?;
    } else {
      let hint_enabled = {
        let v = get(a.adapter.get(), "disableIndexHints")?;
        !(js::type_of(v) == js::Type::Boolean && js::get_bool(v))
      };
      let use_hint = hint_enabled && object_keys_length(query)? == 0;
      let options = call("countOptions", &[a.collation.get(), a.session.get(), js::boolean(use_hint)])?;
      count_promise = val(call_method(model, "countDocuments", &[query, options], "Model.countDocuments")?)?;
    }
  }

  let docs_promise = call_method(
    a.model.get(),
    "aggregate",
    &[aggregation.get(), literal(&[("collation", a.collation.get()), ("session", a.session.get())])?],
    "Model.aggregate",
  )?;
  let all = promise_all_of(&[docs_promise, count_promise.get()])?;
  let settled = await_js(all).await?;
  // const [docs, countResult] = ...
  let pair = call("destructurePair", &[settled.get()])?;
  let docs = at(pair, 0)?;
  let count_result = at(pair, 1)?;

  let count = if js::type_of(count_result.get()) == js::Type::Null {
    val(get(docs.get(), "length")?)?
  } else {
    count_result.clone()
  };

  let page = a.page.get();
  let limit = a.limit.get();
  let pagination = a.pagination.get();
  let page_is_number = is_number(page);
  let limit_is_number = is_number(limit);

  // pagination !== false && typeof limit === 'number' && limit !== 0 ? Math.ceil(count / limit) : 1
  let total_pages = if !is_false(pagination) && limit_is_number && js::get_f64(limit) != 0.0 {
    call("ceilDiv", &[count.get(), limit])?
  } else {
    js::number(1.0)
  };
  let total_pages = val(total_pages)?;

  let has_prev_page = page_is_number && !is_false(pagination) && js::get_f64(page) > 1.0;
  let has_next_page = page_is_number && !is_false(pagination) && gt(total_pages.get(), page)?;
  let paging_counter = if page_is_number && !is_false(pagination) && limit_is_number {
    add(mul(sub(page, js::number(1.0))?, limit)?, js::number(1.0))?
  } else {
    js::number(1.0)
  };

  let limit_value = nullish_or(limit, || Ok(js::number(0.0)))?;
  let next_page = if has_next_page { add(page, js::number(1.0))? } else { js::null() };
  let prev_page = if has_prev_page { sub(page, js::number(1.0))? } else { js::null() };

  val(literal(&[
    ("docs", docs.get()),
    ("hasNextPage", js::boolean(has_next_page)),
    ("hasPrevPage", js::boolean(has_prev_page)),
    ("limit", limit_value),
    ("nextPage", next_page),
    ("page", page),
    ("pagingCounter", paging_counter),
    ("prevPage", prev_page),
    ("totalDocs", count.get()),
    ("totalPages", total_pages.get()),
  ])?)
}

/// `Promise.all([a, b, ...])` over a fresh array literal.
fn promise_all_of(items: &[Local]) -> JsResult<Local> {
  crate::host::promise_all(array_of(items)?)
}

// ---------------------------------------------------------------------------------------------
// findDistinct

/// `adapter.findDistinct(args)`
pub fn find_distinct(adapter: Local, args: Local) -> JsResult<Local> {
  spawn_method(adapter, args, |a, b| Box::pin(run_find_distinct(a, b)))
}

async fn run_find_distinct(this: Val, args: Val) -> JsResult<Val> {
  let Collection { collection_config, model, .. } =
    get_collection(this.get(), get(args.get(), "collection")?, false)?;

  // const { where = {} } = args
  let where_ = val(call("whereOf", &[args.get()])?)?;

  let mut sort_aggregation = val(js::array())?;

  let sort = {
    let config = val(get(get(this.get(), "payload")?, "config")?)?;
    let fields = val(get(collection_config.get(), "flattenedFields")?)?;
    let locale = val(get(args.get(), "locale")?)?;
    let sort_value = val(nullish_or(get(args.get(), "sort")?, || get(args.get(), "field"))?)?;
    val(deps::build_sort_param(BuildSortParamArgs {
      adapter: this.clone(),
      config,
      fields,
      locale,
      parent_is_localized: Val::Undefined,
      sort: sort_value,
      sort_aggregation: sort_aggregation.clone(),
      timestamps: Val::Bool(true),
      versions: Val::Undefined,
    })?)?
  };

  let p = {
    // { adapter: this, collectionSlug: args.collection, fields, locale: args.locale, where }
    let collection = val(get(args.get(), "collection")?)?;
    let fields = val(get(collection_config.get(), "flattenedFields")?)?;
    let locale = val(get(args.get(), "locale")?)?;
    build_query(&this, collection, fields, Val::Undefined, &locale, where_.clone())?
  };
  let query = await_js(p).await?;

  // getFieldByPath({ config, fields, includeRelationships: true, path: args.field })
  let field_path_result = {
    let config = get(get(this.get(), "payload")?, "config")?;
    let fields = get(collection_config.get(), "flattenedFields")?;
    let path = get(args.get(), "field")?;
    val(call("getFieldByPath", &[config, fields, path])?)?
  };
  let mut field_path = val(get(args.get(), "field")?)?;
  if truthy(opt(field_path_result.get(), "pathHasLocalized")?) && truthy(get(args.get(), "locale")?) {
    let localized_path = get(field_path_result.get(), "localizedPath")?;
    field_path = val(call("replaceLocale", &[localized_path, get(args.get(), "locale")?])?)?;
  }

  // const page = args.page || 1
  let page = val(or_else(get(args.get(), "page")?, || Ok(js::number(1.0)))?)?;

  // let sortProperty = Object.keys(sort)[0]; const sortDirection = sort[sortProperty] === 'asc' ? 1 : -1
  let mut sort_property = val(js::get_element(crate::host::object_keys(sort.get())?, 0)?)?;
  let sort_direction = if str_eq(get_key(sort.get(), sort_property.get())?, "asc") { 1.0 } else { -1.0 };

  let mut current_fields = val(get(collection_config.get(), "flattenedFields")?)?;
  let mut found_field = Val::Null;
  let mut rels: Vec<(Val, Val)> = Vec::new();
  let mut temp_path = val(js::string(""))?;
  let mut inside_relation = false;

  let segments = val(call_method(get(args.get(), "field")?, "split", &[js::string(".")], "args.field.split")?)?;

  let mut i = 0u32;
  loop {
    if !gt(get(segments.get(), "length")?, js::number(f64::from(i)))? {
      break;
    }
    let segment = get_key(segments.get(), js::number(f64::from(i)))?;
    let field = call("findByName", &[current_fields.get(), segment])?;
    if !rels.is_empty() {
      inside_relation = true;
    }

    if !truthy(field) {
      break;
    }

    temp_path = if truthy(temp_path.get()) {
      val(call("templateDot", &[temp_path.get(), get(field, "name")?])?)?
    } else {
      val(get(field, "name")?)?
    };

    if crate::host::has(field, "flattenedFields")? {
      current_fields = val(get(field, "flattenedFields")?)?;
      i += 1;
      continue;
    }

    let field_type = get(field, "type")?;
    if (str_eq(field_type, "relationship") || str_eq(get(field, "type")?, "upload"))
      && js::type_of(get(field, "relationTo")?) == js::Type::String
    {
      // i === segments.length - 2 && segments[i + 1] === 'id'
      let length = get(segments.get(), "length")?;
      let is_second_to_last = js::strict_equals(js::number(f64::from(i)), sub(length, js::number(2.0))?);
      if is_second_to_last && str_eq(get_key(segments.get(), js::number(f64::from(i + 1)))?, "id") {
        found_field = val(field)?;
        field_path = temp_path.clone();
        break;
      }
      let relation_to = val(get(field, "relationTo")?)?;
      rels.push((temp_path.clone(), relation_to.clone()));
      // this.payload.collections[field.relationTo]?.config.flattenedFields
      let collections = get(get(this.get(), "payload")?, "collections")?;
      let related = get_key(collections, get(field, "relationTo")?)?;
      current_fields = if crate::host::is_nullish(related) {
        Val::Undefined
      } else {
        val(get(get(related, "config")?, "flattenedFields")?)?
      };
      i += 1;
      continue;
    }
    found_field = val(field)?;
    i += 1;
  }

  // const resolvedField = foundField || fieldPathResult?.field
  let resolved_field = or_else(found_field.get(), || opt(field_path_result.get(), "field"))?;
  // const isHasManyValue = resolvedField && 'hasMany' in resolvedField && resolvedField
  let is_has_many_value = truthy(resolved_field) && crate::host::has(resolved_field, "hasMany")?;

  let mut relation_lookup = Val::Null;

  if !inside_relation {
    rels.clear();
  }

  if !rels.is_empty() {
    let last_field_path = rels.last().map(|r| r.0.clone()).unwrap_or(Val::Undefined);
    sort_property = val(call("stripRelationPrefix", &[sort_property.get(), last_field_path.get()])?)?;
    relation_lookup = val(js::array())?;
    for (rel_field_path, relation_to) in &rels {
      sort_aggregation = val(call("withoutLookup", &[sort_aggregation.get(), rel_field_path.get()])?)?;
      let foreign = get_collection(this.get(), relation_to.get(), false)?;
      // const relatedAccess = args.relatedAccess?.[fieldPath]
      let related_access = crate::host::get_key_optional(get(args.get(), "relatedAccess")?, rel_field_path.get())?;
      let related_access = val(related_access)?;
      let related_access_query = if truthy(related_access.get()) {
        let fields = val(get(foreign.collection_config.get(), "flattenedFields")?)?;
        let locale = val(get(args.get(), "locale")?)?;
        let p = build_query(&this, relation_to.clone(), fields, Val::Undefined, &locale, related_access.clone())?;
        await_js(p).await?
      } else {
        Val::Null
      };
      call(
        "pushRelationLookup",
        &[relation_lookup.get(), rel_field_path.get(), foreign.model.get(), related_access_query.get()],
      )?;
    }
  }

  // let $unwind = ''; let $group = null; if (...) {...} else if (isHasManyValue) {...}
  let mut unwind = val(js::string(""))?;
  let mut group = Val::Null;
  let lookup_first = {
    let sa = sort_aggregation.get();
    // isHasManyValue && sortAggregation.length && sortAggregation[0] && '$lookup' in sortAggregation[0]
    is_has_many_value
      && truthy(get(sa, "length")?)
      && truthy(get_key(sa, js::number(0.0))?)
      && crate::host::has(get_key(sa, js::number(0.0))?, "$lookup")?
  };
  if lookup_first {
    let first_as = || -> JsResult<Local> {
      get(get(get_key(sort_aggregation.get(), js::number(0.0))?, "$lookup")?, "as")
    };
    let path = template("$", first_as()?, "")?;
    unwind = val(literal(&[("path", path), ("preserveNullAndEmptyArrays", js::boolean(true))])?)?;
    let field = template("$", first_as()?, "._id")?;
    let sort = template("$", sort_property.get(), "")?;
    group = val(literal(&[("_id", literal(&[("_field", field), ("_sort", sort)])?)])?)?;
  } else if is_has_many_value {
    let path = template("$", get(args.get(), "field")?, "")?;
    unwind = val(literal(&[("path", path), ("preserveNullAndEmptyArrays", js::boolean(true))])?)?;
  }

  if !truthy(group.get()) {
    // { _id: `$${fieldPath}`, ...(sortProperty === fieldPath ? {} : { _sort: { $max: `$${sortProperty}` } }) }
    let id = template("$", field_path.get(), "")?;
    group = if js::strict_equals(sort_property.get(), field_path.get()) {
      val(literal(&[("_id", id)])?)?
    } else {
      let max = template("$", sort_property.get(), "")?;
      val(literal(&[("_id", id), ("_sort", literal(&[("$max", max)])?)])?)?
    };
  }

  // { $sort: getSortAggregation({ fieldPath, hasSortAggregationAndHasMany, sortDirection, sortProperty }) },
  // evaluated after the spreads of the pipeline literal
  let sort_stage = || -> JsResult<Local> {
    let has_sort_aggregation_and_has_many = is_has_many_value && truthy(get(sort_aggregation.get(), "length")?);
    let same = js::strict_equals(sort_property.get(), field_path.get());
    let resolved = match (has_sort_aggregation_and_has_many, same) {
      (true, true) => "_id._field",
      (true, false) => "_id._sort",
      (false, true) => "_id",
      (false, false) => "_sort",
    };
    literal(&[("$sort", literal(&[(resolved, js::number(sort_direction))])?)])
  };
  let pipeline = val(distinct_pipeline(&query, &sort_aggregation, &relation_lookup, &unwind, &group, sort_stage)?)?;

  let session = await_js(get_session(this.get(), get(args.get(), "req")?)?).await?;

  if truthy(get(args.get(), "limit")?) {
    // pipeline.push({ $skip: (page - 1) * args.limit }); pipeline.push({ $limit: args.limit })
    let skip = mul(sub(page.get(), js::number(1.0))?, get(args.get(), "limit")?)?;
    call_method(pipeline.get(), "push", &[literal(&[("$skip", skip)])?], "pipeline.push")?;
    call_method(pipeline.get(), "push", &[literal(&[("$limit", get(args.get(), "limit")?)])?], "pipeline.push")?;

    let count_stage = || literal(&[("$count", js::string("count"))]);
    let count_pipeline = distinct_pipeline(&query, &sort_aggregation, &relation_lookup, &unwind, &group, count_stage)?;
    let p = call("aggregateCount", &[model.get(), count_pipeline, session.get()])?;
    let total_docs = await_js(p).await?;

    let limit = get(args.get(), "limit")?;
    let total_pages = val(call("ceilDiv", &[total_docs.get(), limit])?)?;
    let has_prev_page = gt(page.get(), js::number(1.0))?;
    let has_next_page = gt(total_pages.get(), page.get())?;
    let paging_counter = add(mul(sub(page.get(), js::number(1.0))?, get(args.get(), "limit")?)?, js::number(1.0))?;
    let paging_counter = val(paging_counter)?;
    let limit_value = val(get(args.get(), "limit")?)?;
    let next_page = val(if has_next_page { add(page.get(), js::number(1.0))? } else { js::null() })?;
    let prev_page = val(if has_prev_page { sub(page.get(), js::number(1.0))? } else { js::null() })?;

    // values: await getValues()
    let p = call("distinctGetValues", &[model.get(), pipeline.get(), session.get(), args.get()])?;
    let values = await_js(p).await?;

    return val(literal(&[
      ("hasNextPage", js::boolean(has_next_page)),
      ("hasPrevPage", js::boolean(has_prev_page)),
      ("limit", limit_value.get()),
      ("nextPage", next_page.get()),
      ("page", page.get()),
      ("pagingCounter", paging_counter.get()),
      ("prevPage", prev_page.get()),
      ("totalDocs", total_docs.get()),
      ("totalPages", total_pages.get()),
      ("values", values.get()),
    ])?);
  }

  let p = call("distinctGetValues", &[model.get(), pipeline.get(), session.get(), args.get()])?;
  let values = await_js(p).await?;

  val(literal(&[
    ("hasNextPage", js::boolean(false)),
    ("hasPrevPage", js::boolean(false)),
    ("limit", js::number(0.0)),
    ("page", js::number(1.0)),
    ("pagingCounter", js::number(1.0)),
    ("totalDocs", get(values.get(), "length")?),
    ("totalPages", js::number(1.0)),
    ("values", values.get()),
  ])?)
}

/// `[{ $match: query }, ...(sortAggregation.length > 0 ? sortAggregation : []),
/// ...(relationLookup?.length ? relationLookup : []), ...($unwind ? [{ $unwind }] : []), { $group },
/// last]` (findDistinct's pipeline and count pipeline).
fn distinct_pipeline(
  query: &Val,
  sort_aggregation: &Val,
  relation_lookup: &Val,
  unwind: &Val,
  group: &Val,
  last: impl FnOnce() -> JsResult<Local>,
) -> JsResult<Local> {
  let pipeline = array_of(&[literal(&[("$match", query.get())])?])?;
  if gt(get(sort_aggregation.get(), "length")?, js::number(0.0))? {
    call("pushEach", &[pipeline, sort_aggregation.get()])?;
  }
  let lookup = relation_lookup.get();
  if !crate::host::is_nullish(lookup) && truthy(get(lookup, "length")?) {
    call("pushEach", &[pipeline, lookup])?;
  }
  if truthy(unwind.get()) {
    js::push(pipeline, literal(&[("$unwind", unwind.get())])?)?;
  }
  js::push(pipeline, literal(&[("$group", group.get())])?)?;
  js::push(pipeline, last()?)?;
  Ok(pipeline)
}

/// `` `${prefix}${value}${suffix}` `` (template literal: ToString of `value` in JS).
fn template(prefix: &str, value: Local, suffix: &str) -> JsResult<Local> {
  call("template", &[js::string(prefix), value, js::string(suffix)])
}
