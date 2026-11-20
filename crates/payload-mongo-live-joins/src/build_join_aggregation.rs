//! `buildJoinAggregation` (packages/db-mongodb/src/utilities/buildJoinAggregation.ts) on the live
//! objects: same reads, same object literals (evaluation order, shared stages), awaits exactly at
//! `await buildQuery(...)` / `await JoinModel.buildQuery(...)`.

use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use payload_mongo_live::deps::{self as live_deps, BuildJoinAggregationArgs, BuildQueryArgs, BuildSortParamArgs};
use payload_mongo_live::entity;

use crate::deps;
use crate::jsx::{
  self, ForOf, arr, call_fn, call_method, eq_str, for_of_sync, get, get_k, gt, is_array, is_false, keys, mul, num,
  nullish, obj, obj_k, opt, prop_key, push, s, strict_eq, sub, tpl, truthy, val,
};

/// `buildJoinAggregation(args)` called with an args object (the binding): the parameter
/// destructuring runs inside the async function, like upstream's.
pub fn build_join_aggregation(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(async move {
    let d = jsx::call("buildJoinAggregationArgs", &[args.get()])?;
    let [adapter, collection, collection_config, drafts_enabled, joins, locale, projection, versions] =
      jsx::elements::<8>(d)?;
    body(Args { adapter, collection, collection_config, drafts_enabled, joins, locale, projection, versions }).await
  })
}

/// `buildJoinAggregation({ ... })` as registered in `payload_mongo_live::deps` (the caller's args
/// literal is fresh, so destructuring it is not observable).
pub fn build_join_aggregation_native(a: BuildJoinAggregationArgs) -> JsResult<Local> {
  let args = Args {
    adapter: a.adapter,
    collection: a.collection,
    collection_config: a.collection_config,
    drafts_enabled: a.drafts_enabled,
    joins: a.joins,
    locale: a.locale,
    projection: a.projection,
    versions: a.versions,
  };
  spawn(async move { body(args).await })
}

/// `getCollection({ adapter, collectionSlug })` (shared live port): `[collectionConfig, Model]`.
fn get_collection(adapter: Local, collection_slug: Local) -> JsResult<(Local, Local)> {
  let c = entity::get_collection(adapter, collection_slug, false)?;
  Ok((c.collection_config.get(), c.model.get()))
}

struct Args {
  adapter: Val,
  collection: Val,
  collection_config: Val,
  drafts_enabled: Val,
  joins: Val,
  locale: Val,
  projection: Val,
  versions: Val,
}

async fn body(a: Args) -> JsResult<Val> {

  if !truthy(get(a.adapter.get(), "useJoinAggregations")?) {
    return val(js::array());
  }
  let cc = a.collection_config.get();
  let no_joins = {
    let k = keys(get(cc, "joins")?)?;
    js::array_length(k) == 0 && jsx::loose_eq(get(get(cc, "polymorphicJoins")?, "length")?, num(0.0))?
  };
  if no_joins || is_false(a.joins.get()) {
    return val(js::array());
  }

  let collection_config_of = |adapter: Local, collection: Local, key: &str| -> JsResult<Local> {
    let entry = get_k(get(get(adapter, "payload")?, "collections")?, collection)?;
    opt(opt(entry, "config")?, key)
  };
  let join_config = val(collection_config_of(a.adapter.get(), a.collection.get(), "joins")?)?;
  if !truthy(join_config.get()) {
    let message = tpl(&[s("Could not retrieve sanitized join config for "), a.collection.get(), s(".")])?;
    return Err(deps::api_error(message)?);
  }
  let aggregate = val(js::array())?;
  let polymorphic = collection_config_of(a.adapter.get(), a.collection.get(), "polymorphicJoins")?;
  if !truthy(polymorphic) {
    let message = tpl(&[s("Could not retrieve sanitized polymorphic joins config for "), a.collection.get(), s(".")])?;
    return Err(deps::api_error(message)?);
  }

  let mut l = ForOf::of(polymorphic, "polymorphicJoinsConfig")?;
  while let Some(join) = l.next()? {
    let join = val(join)?;
    if let Err(e) = polymorphic_join(&a, &aggregate, join).await {
      l.close();
      return Err(e);
    }
  }

  let slugs = val(keys(join_config.get())?)?;
  let mut i = 0;
  while i < js::array_length(slugs.get()) {
    let slug = js::get_element(slugs.get(), i)?;
    i += 1;
    let joins_list = get_k(join_config.get(), slug)?;
    if !truthy(joins_list) {
      let message =
        tpl(&[s("Failed to retrieve array of joins for "), slug, s(" in collectio "), a.collection.get()])?;
      return Err(deps::api_error(message)?);
    }
    let mut l = ForOf::of(joins_list, "joinsList")?;
    while let Some(join) = l.next()? {
      let join = val(join)?;
      if let Err(e) = regular_join(&a, &aggregate, join).await {
        l.close();
        return Err(e);
      }
    }
  }
  Ok(aggregate)
}

/// `joins?.[join.joinPath]` (the key is not evaluated when `joins` is nullish)
fn join_query_of(joins: Local, join: Local) -> JsResult<Local> {
  if nullish(joins) { Ok(js::undefined()) } else { get_k(joins, get(join, "joinPath")?) }
}

/// `{ [key]: value }`
fn single(key: Local, value: Local) -> JsResult<Local> {
  obj_k(&[(prop_key(key)?, value)])
}

/// `sort[Object.keys(sort)[0]] === 'asc' ? 1 : -1` with the key
fn sort_property(sort: Local) -> JsResult<(Val, f64)> {
  let property = js::get_element(keys(sort)?, 0)?;
  let direction = if eq_str(get_k(sort, property)?, "asc") { 1.0 } else { -1.0 };
  Ok((val(property)?, direction))
}

async fn polymorphic_join(a: &Args, aggregate: &Val, join: Val) -> JsResult<()> {
  let projection = a.projection.get();
  if truthy(projection) && !truthy(get_k(projection, get(join.get(), "joinPath")?)?) {
    return Ok(());
  }
  if is_false(join_query_of(a.joins.get(), join.get())?) {
    return Ok(());
  }
  let src = join_query_of(a.joins.get(), join.get())?;
  let src = if truthy(src) { src } else { js::object() };
  let d = jsx::call("polymorphicJoinQuery", &[src, join.get(), a.collection_config.get()])?;
  let [count, limit_join, page, sort_join, where_join] = jsx::elements::<5>(d)?;

  let aggregated_fields = js::array();
  let adapter = a.adapter.get();
  for_of_sync(get(get(join.get(), "field")?, "collection")?, "join.field.collection", |collection_slug| {
    let collection_config = get_collection(adapter, collection_slug)?.0;
    for_of_sync(get(collection_config, "flattenedFields")?, "collectionConfig.flattenedFields", |field| {
      let mut found = false;
      for i in 0..js::array_length(aggregated_fields) {
        let each = js::get_element(aggregated_fields, i)?;
        if strict_eq(get(each, "name")?, get(field, "name")?) {
          found = true;
          break;
        }
      }
      if !found {
        push(aggregated_fields, field)?;
      }
      Ok(false)
    })?;
    Ok(false)
  })?;

  let config = get(get(adapter, "payload")?, "config")?;
  let fields = val(aggregated_fields)?;
  let sort = val(live_deps::build_sort_param(BuildSortParamArgs {
    adapter: a.adapter.clone(),
    config: val(config)?,
    fields: fields.clone(),
    locale: a.locale.clone(),
    parent_is_localized: Val::Undefined,
    sort: sort_join,
    sort_aggregation: Val::Undefined,
    timestamps: Val::Bool(true),
    versions: Val::Undefined,
  })?)?;
  let query = live_deps::build_query(BuildQueryArgs {
    adapter: a.adapter.clone(),
    collection_slug: Val::Undefined,
    fields,
    global_slug: Val::Undefined,
    locale: a.locale.clone(),
    where_: where_join,
  })?;
  let match_ = await_js(query).await?;

  let (sort_property, sort_direction) = sort_property(sort.get())?;
  let sp = sort_property.get();
  let project_sort = !eq_str(sp, "_id") && !eq_str(sp, "relationTo");
  let aliases = js::array();
  let as_ = get(join.get(), "joinPath")?;
  let adapter = a.adapter.get();
  let aggregate = aggregate.get();
  let (count, limit_join, page) = (count.get(), limit_join.get(), page.get());

  for_of_sync(get(get(join.get(), "field")?, "collection")?, "join.field.collection", |collection_slug| {
    let alias = tpl(&[as_, s(".docs."), collection_slug])?;
    push(aliases, alias)?;
    let add_fields = obj(&[("$addFields", obj(&[("relationTo", obj(&[("$literal", collection_slug)])?)])?)])?;
    let on = tpl(&[s("$"), get(get(join.get(), "field")?, "on")?])?;
    let expr = obj(&[("$expr", obj(&[("$eq", arr(&[on, s("$$root_id_")])?)])?)])?;
    let match_stage = obj(&[("$match", obj(&[("$and", arr(&[expr, match_.get()])?)])?)])?;
    let base_pipeline = [add_fields, match_stage];
    let join_model = get_collection(adapter, collection_slug)?.1;

    let from = get(get(join_model, "collection")?, "name")?;
    let let_ = obj(&[("root_id_", s("$_id"))])?;
    let pipeline = arr(&base_pipeline)?;
    push(pipeline, obj(&[("$sort", single(sp, num(sort_direction))?)])?)?;
    if gt(limit_join, num(0.0))? {
      let limit = if truthy(page) { mul(page, limit_join)? } else { limit_join };
      push(pipeline, obj(&[("$limit", limit)])?)?;
    }
    let project = obj(&[("value", s("$_id"))])?;
    if project_sort {
      jsx::define(project, prop_key(sp)?, num(1.0))?;
    }
    jsx::define(project, js::key("relationTo"), num(1.0))?;
    push(pipeline, obj(&[("$project", project)])?)?;
    let lookup = obj(&[("as", alias), ("from", from), ("let", let_), ("pipeline", pipeline)])?;
    push(aggregate, obj(&[("$lookup", lookup)])?)?;

    if truthy(count) {
      let as_count = tpl(&[as_, s(".totalDocs."), alias])?;
      let from = get(get(join_model, "collection")?, "name")?;
      let let_ = obj(&[("root_id_", s("$_id"))])?;
      let pipeline = arr(&[base_pipeline[0], base_pipeline[1], obj(&[("$count", s("result"))])?])?;
      let lookup = obj(&[("as", as_count), ("from", from), ("let", let_), ("pipeline", pipeline)])?;
      push(aggregate, obj(&[("$lookup", lookup)])?)?;
    }
    Ok(false)
  })?;

  // { $addFields: { [`${as}.docs`]: { $concatArrays: aliases.map((alias) => `$${alias}`) } } }
  let key = tpl(&[as_, s(".docs")])?;
  let concat = js::array();
  for i in 0..js::array_length(aliases) {
    push(concat, tpl(&[s("$"), js::get_element(aliases, i)?])?)?;
  }
  push(aggregate, obj(&[("$addFields", single(key, obj(&[("$concatArrays", concat)])?)?)])?)?;

  if truthy(count) {
    let key = tpl(&[as_, s(".totalDocs")])?;
    let add = js::array();
    for i in 0..js::array_length(aliases) {
      let alias = js::get_element(aliases, i)?;
      let first = obj(&[("$first", tpl(&[s("$"), as_, s(".totalDocs."), alias, s(".result")])?)])?;
      push(add, obj(&[("$ifNull", arr(&[first, num(0.0)])?)])?)?;
    }
    push(aggregate, obj(&[("$addFields", single(key, obj(&[("$add", add)])?)?)])?)?;
  }

  let key = tpl(&[as_, s(".docs")])?;
  let input = tpl(&[s("$"), as_, s(".docs")])?;
  let sort_array = obj(&[("input", input), ("sortBy", single(sp, num(sort_direction))?)])?;
  push(aggregate, obj(&[("$set", single(key, obj(&[("$sortArray", sort_array)])?)?)])?)?;

  let slice_value: Vec<Local> = if truthy(page) { vec![mul(sub(page, num(1.0))?, limit_join)?, limit_join] } else { vec![limit_join] };

  let key = tpl(&[as_, s(".hasNextPage")])?;
  let size = obj(&[("$size", tpl(&[s("$"), as_, s(".docs")])?)])?;
  let max = if truthy(limit_join) { limit_join } else { num(f64::MAX) };
  push(aggregate, obj(&[("$addFields", single(key, obj(&[("$gt", arr(&[size, max])?)])?)?)])?)?;

  if gt(limit_join, num(0.0))? {
    let key = tpl(&[as_, s(".docs")])?;
    let mut items = vec![tpl(&[s("$"), as_, s(".docs")])?];
    items.extend(slice_value);
    push(aggregate, obj(&[("$set", single(key, obj(&[("$slice", arr(&items)?)])?)?)])?)?;
  }
  Ok(())
}

async fn regular_join(a: &Args, aggregate: &Val, join: Val) -> JsResult<()> {
  let versions = truthy(a.versions.get());
  let projection_path =
    if versions { tpl(&[s("version."), get(join.get(), "joinPath")?])? } else { get(join.get(), "joinPath")? };
  let projection = a.projection.get();
  if truthy(projection) && !truthy(get_k(projection, projection_path)?) {
    return Ok(());
  }
  if is_false(join_query_of(a.joins.get(), join.get())?) {
    return Ok(());
  }
  let adapter = a.adapter.get();
  let collections = get(get(adapter, "payload")?, "collections")?;
  let key = get(get(join.get(), "field")?, "collection")?;
  let collection_config = opt(get_k(collections, key)?, "config")?;
  if !truthy(collection_config) {
    let name = call_method(get(get(join.get(), "field")?, "collection")?, "toString", &[], "join.field.collection.toString")?;
    let message = tpl(&[s("Collection config for "), name, s(" was not found")])?;
    return Err(deps::api_error(message)?);
  }
  let use_drafts = (truthy(a.drafts_enabled.get()) || versions)
    && truthy(deps::call("hasDraftsEnabled", &[collection_config])?);
  let join_model = if use_drafts {
    get_k(get(adapter, "versions")?, get(collection_config, "slug")?)?
  } else {
    get_k(get(adapter, "collections")?, get(collection_config, "slug")?)?
  };
  if !truthy(join_model) {
    let message = tpl(&[s("Join Model was not found for "), get(collection_config, "slug")?])?;
    return Err(deps::api_error(message)?);
  }
  let src = join_query_of(a.joins.get(), join.get())?;
  let src = if truthy(src) { src } else { js::object() };
  let d = jsx::call("joinQuery", &[src, join.get(), collection_config])?;
  let [count, limit_join, page, sort_join, where_join] = jsx::elements::<5>(d)?;
  if is_array(get(get(join.get(), "field")?, "collection")?)? {
    return Err(payload_mongo_live::error::new_error("Error", &[s("Unreachable")]));
  }
  let fields = if use_drafts {
    let config = get(get(adapter, "payload")?, "config")?;
    deps::build_version_collection_fields(config, collection_config, true)?
  } else {
    get(collection_config, "flattenedFields")?
  };
  let config = get(get(adapter, "payload")?, "config")?;
  let sort_value = if use_drafts {
    let args = obj(&[("collectionConfig", collection_config), ("sort", sort_join.get())])?;
    deps::call("getQueryDraftsSort", &[args])?
  } else {
    sort_join.get()
  };
  let sort = live_deps::build_sort_param(BuildSortParamArgs {
    adapter: a.adapter.clone(),
    config: val(config)?,
    fields: val(fields)?,
    locale: a.locale.clone(),
    parent_is_localized: Val::Undefined,
    sort: val(sort_value)?,
    sort_aggregation: Val::Undefined,
    timestamps: Val::Bool(true),
    versions: Val::Undefined,
  })?;
  let adapter = a.adapter.get();
  let (sort_property, sort_direction) = sort_property(sort)?;

  let build_query = get(join_model, "buildQuery")?;
  let payload = get(adapter, "payload")?;
  let where_ = if use_drafts {
    let appended = deps::call("appendVersionToQueryKey", &[where_join.get()])?;
    let latest = obj(&[("latest", obj(&[("equals", js::boolean(true))])?)])?;
    deps::call("combineQueries", &[appended, latest])?
  } else {
    where_join.get()
  };
  let query_args = obj(&[("locale", a.locale.get()), ("payload", payload), ("where", where_)])?;
  let join_model = val(join_model)?;
  let query = call_fn(build_query, join_model.get(), &[query_args], "JoinModel.buildQuery")?;
  let match_ = await_js(query).await?;

  let sp = sort_property.get();
  let (count, limit_join, page) = (count.get(), limit_join.get(), page.get());
  let match_stage = obj(&[("$match", match_.get())])?;
  let pipeline = arr(&[match_stage, obj(&[("$sort", single(sp, num(sort_direction))?)])?])?;
  if truthy(page) {
    push(pipeline, obj(&[("$skip", mul(sub(page, num(1.0))?, limit_join)?)])?)?;
  }
  if gt(limit_join, num(0.0))? {
    push(pipeline, obj(&[("$limit", jsx::add(limit_join, num(1.0))?)])?)?;
  }
  let polymorphic_suffix =
    if is_array(get(get(join.get(), "targetField")?, "relationTo")?)? { ".value" } else { "" };
  let foreign_field_prefix = if use_drafts { "version." } else { "" };
  let local_field = || if versions { s("parent") } else { s("_id") };
  let map_in = || if use_drafts { s("$$doc.parent") } else { s("$$doc._id") };
  let adapter = a.adapter.get();
  let aggregate = aggregate.get();
  let join_model = join_model.get();
  let join = join.get();

  let add_total_docs = |as_: Local, foreign_field: Local| -> JsResult<()> {
    let lookup = obj(&[
      ("as", tpl(&[as_, s(".totalDocs")])?),
      ("foreignField", foreign_field),
      ("from", get(get(join_model, "collection")?, "name")?),
      ("localField", local_field()),
      ("pipeline", arr(&[obj(&[("$match", match_.get())])?, obj(&[("$count", s("result"))])?])?),
    ])?;
    let first_lookup = obj(&[("$lookup", lookup)])?;
    let key = tpl(&[as_, s(".totalDocs")])?;
    let first = obj(&[("$first", tpl(&[s("$"), as_, s(".totalDocs.result")])?)])?;
    let add_fields = obj(&[("$addFields", single(key, obj(&[("$ifNull", arr(&[first, num(0.0)])?)])?)?)])?;
    push(aggregate, first_lookup)?;
    push(aggregate, add_fields)
  };
  let join_path_prefix = || -> JsResult<Local> {
    if versions { tpl(&[s("version."), get(join, "joinPath")?]) } else { get(join, "joinPath") }
  };

  let localization = get(get(get(adapter, "payload")?, "config")?, "localization")?;
  if truthy(localization) && eq_str(a.locale.get(), "all") {
    let locale_codes = get(get(get(get(adapter, "payload")?, "config")?, "localization")?, "localeCodes")?;
    jsx::array_method(locale_codes, "forEach", "adapter.payload.config.localization.localeCodes", &mut |args| {
      let code = args[0];
      let as_ = tpl(&[join_path_prefix()?, code])?;
      let foreign_field = tpl(&[s(foreign_field_prefix), get(get(join, "field")?, "on")?, code, s(polymorphic_suffix)])?;
      let lookup = obj(&[
        ("as", tpl(&[as_, s(".docs")])?),
        ("foreignField", foreign_field),
        ("from", get(get(join_model, "collection")?, "name")?),
        ("localField", local_field()),
        ("pipeline", pipeline),
      ])?;
      let lookup = obj(&[("$lookup", lookup)])?;
      let docs_key = tpl(&[as_, s(".docs")])?;
      let map = obj(&[("as", s("doc")), ("in", map_in()), ("input", tpl(&[s("$"), as_, s(".docs")])?)])?;
      let map = obj(&[("$map", map)])?;
      let next_key = tpl(&[as_, s(".hasNextPage")])?;
      let has_next = if truthy(limit_join) {
        let size = obj(&[("$size", tpl(&[s("$"), as_, s(".docs")])?)])?;
        obj(&[("$gt", arr(&[size, limit_join])?)])?
      } else {
        js::boolean(false)
      };
      let add_fields = obj_k(&[(prop_key(docs_key)?, map), (prop_key(next_key)?, has_next)])?;
      push(aggregate, lookup)?;
      push(aggregate, obj(&[("$addFields", add_fields)])?)?;
      if gt(limit_join, num(0.0))? {
        let key = tpl(&[as_, s(".docs")])?;
        let slice = obj(&[("$slice", arr(&[tpl(&[s("$"), as_, s(".docs")])?, limit_join])?)])?;
        push(aggregate, obj(&[("$addFields", single(key, slice)?)])?)?;
      }
      if truthy(count) {
        let foreign_field =
          tpl(&[s(foreign_field_prefix), get(get(join, "field")?, "on")?, code, s(polymorphic_suffix)])?;
        add_total_docs(as_, foreign_field)?;
      }
      Ok(js::undefined())
    })?;
  } else {
    let localized = {
      let args = obj(&[("field", get(join, "field")?), ("parentIsLocalized", get(join, "parentIsLocalized")?)])?;
      truthy(deps::call("fieldShouldBeLocalized", &[args])?)
        && truthy(get(get(get(adapter, "payload")?, "config")?, "localization")?)
        && truthy(a.locale.get())
    };
    let locale_suffix = if localized { tpl(&[s("."), a.locale.get()])? } else { s("") };
    let as_ = tpl(&[join_path_prefix()?, locale_suffix])?;
    let foreign_field = if truthy(get(join, "getForeignPath")?) {
      let path = call_method(join, "getForeignPath", &[obj(&[("locale", a.locale.get())])?], "join.getForeignPath")?;
      tpl(&[path, s(polymorphic_suffix)])?
    } else {
      tpl(&[get(get(join, "field")?, "on")?, s(polymorphic_suffix)])?
    };
    let lookup = obj(&[
      ("as", tpl(&[as_, s(".docs")])?),
      ("foreignField", tpl(&[s(foreign_field_prefix), foreign_field])?),
      ("from", get(get(join_model, "collection")?, "name")?),
      ("localField", local_field()),
      ("pipeline", pipeline),
    ])?;
    let lookup = obj(&[("$lookup", lookup)])?;
    let docs_key = tpl(&[as_, s(".docs")])?;
    let map = obj(&[("as", s("doc")), ("in", map_in()), ("input", tpl(&[s("$"), as_, s(".docs")])?)])?;
    let map = obj(&[("$map", map)])?;
    let next_key = tpl(&[as_, s(".hasNextPage")])?;
    let size = obj(&[("$size", tpl(&[s("$"), as_, s(".docs")])?)])?;
    let max = if truthy(limit_join) { limit_join } else { num(f64::MAX) };
    let has_next = obj(&[("$gt", arr(&[size, max])?)])?;
    let add_fields = obj_k(&[(prop_key(docs_key)?, map), (prop_key(next_key)?, has_next)])?;
    push(aggregate, lookup)?;
    push(aggregate, obj(&[("$addFields", add_fields)])?)?;
    if truthy(count) {
      add_total_docs(as_, tpl(&[s(foreign_field_prefix), foreign_field])?)?;
    }
    if gt(limit_join, num(0.0))? {
      let key = tpl(&[as_, s(".docs")])?;
      let slice = obj(&[("$slice", arr(&[tpl(&[s("$"), as_, s(".docs")])?, limit_join])?)])?;
      push(aggregate, obj(&[("$addFields", single(key, slice)?)])?)?;
    }
  }
  Ok(())
}
