//! `resolveJoins` (packages/db-mongodb/src/utilities/resolveJoins.ts) on the live objects: one
//! spawned task per `async` arrow (joins, then collections), concurrency only through JS
//! `Promise.all` (fail-fast), awaits exactly at `await buildQuery(...)` /
//! `await JoinModel.buildQuery(...)`, `await Promise.all(...)`; `docs` mutated in place.

use std::rc::Rc;

use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Type, Val};

use payload_mongo_live::deps::{self as live_deps, BuildQueryArgs, BuildSortParamArgs, ResolveJoinsArgs, TransformArgs};

use crate::deps;
use crate::jsx::{
  self, add, arr, array_method, call_fn, call_method, entries, eq_str, for_of_sync, get, get_k, gt, is_array,
  keys, lt, mul, nullish, num, obj, obj_k, opt, prop_key, s, set, set_k, strict_eq, sub, tpl, truthy,
  val, values,
};

/// `resolveJoins(args)` called with an args object (the binding): the parameter destructuring
/// (`versions = false`) runs inside the async function, like upstream's. Resolves with `undefined`.
pub fn resolve_joins(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(async move {
    let d = jsx::call("resolveJoinsArgs", &[args.get()])?;
    let [adapter, collection_slug, docs, joins, locale, projection, versions] = jsx::elements::<7>(d)?;
    body(adapter, collection_slug, docs, joins, locale, projection, versions).await
  })
}

/// `resolveJoins({ ... })` as registered in `payload_mongo_live::deps`.
pub fn resolve_joins_native(a: ResolveJoinsArgs) -> JsResult<Local> {
  spawn(async move {
    // versions = false
    let versions = if a.versions.is_undefined() { Val::Bool(false) } else { a.versions };
    body(a.adapter, a.collection_slug, a.docs, a.joins, a.locale, a.projection, versions).await
  })
}

struct Cx {
  adapter: Val,
  collection_slug: Val,
  docs: Val,
  locale: Val,
  projection: Val,
  versions: Val,
  join_map: Val,
}

async fn body(
  adapter: Val,
  collection_slug: Val,
  docs: Val,
  joins: Val,
  locale: Val,
  projection: Val,
  versions: Val,
) -> JsResult<Val> {

  if !truthy(joins.get()) || strict_eq(get(docs.get(), "length")?, num(0.0)) {
    return Ok(Val::Undefined);
  }
  let entry = get_k(get(get(adapter.get(), "payload")?, "collections")?, collection_slug.get())?;
  let collection_config = opt(entry, "config")?;
  if !truthy(collection_config) {
    return Ok(Val::Undefined);
  }

  let join_map = js::object();
  let regular = entries(get(collection_config, "joins")?)?;
  for i in 0..js::array_length(regular) {
    let pair = js::get_element(regular, i)?;
    let target = js::get_element(pair, 0)?;
    let join_list = js::get_element(pair, 1)?;
    for_of_sync(join_list, "joinList", |join| {
      let key = get(join, "joinPath")?;
      let copy = jsx::call("spreadInto", &[js::object(), join])?;
      jsx::define(copy, js::key("targetCollection"), target)?;
      set_k(join_map, key, copy)?;
      Ok(false)
    })?;
  }
  let polymorphic = get(collection_config, "polymorphicJoins")?;
  let polymorphic = if truthy(polymorphic) { polymorphic } else { js::array() };
  for_of_sync(polymorphic, "collectionConfig.polymorphicJoins || []", |join| {
    let key = get(join, "joinPath")?;
    let copy = jsx::call("spreadInto", &[js::object(), join])?;
    jsx::define(copy, js::key("targetCollection"), get(get(join, "field")?, "collection")?)?;
    set_k(join_map, key, copy)?;
    Ok(false)
  })?;

  let cx = Rc::new(Cx { adapter, collection_slug, docs, locale, projection, versions, join_map: val(join_map)? });

  // Object.entries(joins).map(async ([joinPath, joinQuery]) => ...)
  let pairs = entries(joins.get())?;
  let join_promises = js::array();
  for i in 0..js::array_length(pairs) {
    let pair = val(js::get_element(pairs, i)?)?;
    let cx = cx.clone();
    let promise = spawn(async move { join_task(cx, pair).await })?;
    jsx::push(join_promises, promise)?;
  }
  let all = jsx::promise_all(join_promises)?;
  let join_results = await_js(all).await?;

  let versions = truthy(cx.versions.get());
  let results = join_results.get();
  for i in 0..js::array_length(results) {
    let join_result = js::get_element(results, i)?;
    if !truthy(join_result) {
      continue;
    }
    let d = jsx::call("joinResult", &[join_result])?;
    let grouped = js::get_element(d, 0)?;
    let is_polymorphic_join = truthy(js::get_element(d, 1)?);
    let join_query = js::get_element(d, 2)?;
    let limit = js::get_element(d, 3)?;
    let localized_join_path = js::get_element(d, 4)?;
    let skip = js::get_element(d, 5)?;
    let total_count = js::get_element(d, 6)?;

    for_of_sync(cx.docs.get(), "docs", |doc| {
      let id = parent_id(doc, versions)?;
      let all = {
        let entry = opt(get_k(grouped, id)?, "docs")?;
        if truthy(entry) { entry } else { js::array() }
      };
      let slice = if is_polymorphic_join {
        if strict_eq(limit, num(0.0)) { all } else { call_method(all, "slice", &[skip, add(skip, limit)?], "all.slice")? }
      } else {
        all
      };
      let has_next_page = if strict_eq(limit, num(0.0)) {
        js::boolean(false)
      } else {
        js::boolean(gt(total_count, add(skip, get(slice, "length")?)?)?)
      };
      let value = obj(&[("docs", slice), ("hasNextPage", has_next_page)])?;
      if truthy(get(join_query, "count")?) {
        set(value, "totalDocs", total_count)?;
      }
      let segments = call_method(localized_join_path, "split", &[s(".")], "localizedJoinPath.split")?;
      let mut r = if versions {
        if !truthy(get(doc, "version")?) {
          set(doc, "version", js::object())?;
        }
        get(doc, "version")?
      } else {
        doc
      };
      let mut i: f64 = 0.0;
      while lt(num(i), sub(get(segments, "length")?, num(1.0))?)? {
        let seg = get_k(segments, num(i))?;
        if !truthy(get_k(r, seg)?) {
          set_k(r, seg, js::object())?;
        }
        r = get_k(r, seg)?;
        i += 1.0;
      }
      let last = get_k(segments, sub(get(segments, "length")?, num(1.0))?)?;
      set_k(r, last, value)?;
      Ok(false)
    })?;
  }
  Ok(Val::Undefined)
}

/// `versions ? (d.parent ?? d._id ?? d.id) : (d._id ?? d.id)`
fn parent_id(d: Local, versions: bool) -> JsResult<Local> {
  if versions {
    let parent = get(d, "parent")?;
    if !nullish(parent) {
      return Ok(parent);
    }
  }
  let id = get(d, "_id")?;
  if !nullish(id) { Ok(id) } else { get(d, "id") }
}

/// The `async ([joinPath, joinQuery]) => { ... }` arrow of `joinPromises`.
async fn join_task(cx: Rc<Cx>, pair: Val) -> JsResult<Val> {
  let d = jsx::call("pair", &[pair.get()])?;
  let join_path = js::get_element(d, 0)?;
  let join_query = js::get_element(d, 1)?;
  if !truthy(join_query) {
    return Ok(Val::Null);
  }
  let projection = cx.projection.get();
  if truthy(projection) && !truthy(get_k(projection, join_path)?) {
    return Ok(Val::Null);
  }
  let join_def = get_k(cx.join_map.get(), join_path)?;
  if !truthy(join_def) {
    return Ok(Val::Null);
  }
  let all_collections = if is_array(get(get(join_def, "field")?, "collection")?)? {
    get(get(join_def, "field")?, "collection")?
  } else {
    arr(&[get(get(join_def, "field")?, "collection")?])?
  };
  let adapter = cx.adapter.get();
  let localization_config = get(get(get(adapter, "payload")?, "config")?, "localization")?;
  let locale = cx.locale.get();
  let effective_locale = if truthy(locale) {
    locale
  } else if js::type_of(localization_config) != Type::Object && js::type_of(localization_config) != Type::Null {
    js::boolean(false)
  } else if !truthy(localization_config) {
    localization_config
  } else {
    get(localization_config, "defaultLocale")?
  };

  let where_ = get(join_query, "where")?;
  let relation_to_filter = extract_relation_to_filter(if truthy(where_) { where_ } else { js::object() })?;
  let collections = if truthy(relation_to_filter) {
    array_method(all_collections, "filter", "allCollections", &mut |args| {
      call_method(relation_to_filter, "includes", &[args[0]], "relationToFilter.includes")
    })?
  } else {
    all_collections
  };
  let is_polymorphic_join = is_array(get(get(join_def, "field")?, "collection")?)?;
  let limit = {
    let l = get(join_query, "limit")?;
    if !nullish(l) {
      l
    } else {
      let dl = get(get(join_def, "field")?, "defaultLimit")?;
      if !nullish(dl) { dl } else { num(10.0) }
    }
  };
  let page = {
    let p = get(join_query, "page")?;
    if !nullish(p) { p } else { num(1.0) }
  };
  let skip = mul(sub(page, num(1.0))?, limit)?;
  let join_path = val(join_path)?;
  let page = val(page)?;

  let job = Rc::new(Job {
    join_def: val(join_def)?,
    join_query: val(join_query)?,
    effective_locale: val(effective_locale)?,
    localization_config: val(localization_config)?,
    is_polymorphic_join,
    limit: val(limit)?,
    skip: val(skip)?,
  });
  let collection_promises = array_method(collections, "map", "collections", &mut |args| {
    let slug = val(args[0])?;
    let cx = cx.clone();
    let job = job.clone();
    spawn(async move { collection_task(cx, job, slug).await })
  })?;
  let all = jsx::promise_all(collection_promises)?;
  let collection_results = await_js(all).await?;

  let grouped = js::object();
  let mut total_count = num(0.0);
  let results_list = collection_results.get();
  for i in 0..js::array_length(results_list) {
    let collection_result = js::get_element(results_list, i)?;
    if !truthy(collection_result) {
      continue;
    }
    let d = jsx::call("collectionResult", &[collection_result])?;
    let result_slug = js::get_element(d, 0)?;
    let count = js::get_element(d, 1)?;
    let db_field_name = js::get_element(d, 2)?;
    let results = js::get_element(d, 3)?;
    let sort = js::get_element(d, 4)?;
    let use_drafts = truthy(js::get_element(d, 5)?);
    total_count = add(total_count, count)?;
    for_of_sync(results, "results", |result| {
      if use_drafts {
        let parent = get(result, "parent")?;
        set(result, "id", parent)?;
      }
      let parent_values = get_by_path_with_arrays(result, db_field_name)?;
      if strict_eq(get(parent_values, "length")?, num(0.0)) {
        return Ok(false);
      }
      for_of_sync(parent_values, "parentValues", |parent_value| {
        if !truthy(parent_value) {
          return Ok(false);
        }
        let parent_value = if js::type_of(parent_value).is_typeof_object() {
          get(parent_value, "value")?
        } else {
          parent_value
        };
        let join_data = obj(&[("relationTo", result_slug), ("value", get(result, "id")?)])?;
        if !truthy(get_k(grouped, parent_value)?) {
          let entry = obj(&[("docs", js::array()), ("sort", sort)])?;
          set_k(grouped, parent_value, entry)?;
        }
        let docs = get(get_k(grouped, parent_value)?, "docs")?;
        let item = jsx::call("spreadInto", &[js::object(), result])?;
        jsx::define(item, js::key("__joinData"), join_data)?;
        call_method(docs, "push", &[item], "grouped[parentKey].docs.push")?;
        Ok(false)
      })?;
      Ok(false)
    })?;
  }

  let groups = values(grouped)?;
  for i in 0..js::array_length(groups) {
    let results = js::get_element(groups, i)?;
    array_method(get(results, "docs")?, "sort", "results.docs", &mut |args| {
      let (a, b) = (args[0], args[1]);
      let pairs = entries(get(results, "sort")?)?;
      for k in 0..js::array_length(pairs) {
        let pair = js::get_element(pairs, k)?;
        let field_name = js::get_element(pair, 0)?;
        let sort_order = js::get_element(pair, 1)?;
        let sort = if eq_str(sort_order, "asc") { 1.0 } else { -1.0 };
        let a_value = get_k(a, field_name)?;
        let b_value = get_k(b, field_name)?;
        if lt(a_value, b_value)? {
          return Ok(num(-1.0 * sort));
        }
        if gt(a_value, b_value)? {
          return Ok(num(sort));
        }
      }
      Ok(num(0.0))
    })?;
    let mapped = array_method(get(results, "docs")?, "map", "results.docs", &mut |args| {
      if is_polymorphic_join { get(args[0], "__joinData") } else { get(args[0], "id") }
    })?;
    set(results, "docs", mapped)?;
  }

  let join_def = job.join_def.get();
  let adapter = cx.adapter.get();
  let localized = {
    let args = obj(&[("field", get(join_def, "field")?), ("parentIsLocalized", get(join_def, "parentIsLocalized")?)])?;
    truthy(deps::call("fieldShouldBeLocalized", &[args])?)
      && truthy(get(get(get(adapter, "payload")?, "config")?, "localization")?)
      && truthy(job.effective_locale.get())
  };
  let locale_suffix = if localized { tpl(&[s("."), job.effective_locale.get()])? } else { s("") };
  let localized_join_path = tpl(&[join_path.get(), locale_suffix])?;
  let result = obj(&[
    ("grouped", grouped),
    ("isPolymorphicJoin", js::boolean(is_polymorphic_join)),
    ("joinQuery", job.join_query.get()),
    ("limit", job.limit.get()),
    ("localizedJoinPath", localized_join_path),
    ("page", page.get()),
    ("skip", job.skip.get()),
    ("totalCount", total_count),
  ])?;
  val(result)
}

struct Job {
  join_def: Val,
  join_query: Val,
  effective_locale: Val,
  localization_config: Val,
  is_polymorphic_join: bool,
  limit: Val,
  skip: Val,
}

/// The `async (joinCollectionSlug) => { ... }` arrow of `collectionPromises`.
async fn collection_task(cx: Rc<Cx>, job: Rc<Job>, join_collection_slug: Val) -> JsResult<Val> {
  let adapter = cx.adapter.get();
  let slug = join_collection_slug.get();
  let target_config = opt(get_k(get(get(adapter, "payload")?, "collections")?, slug)?, "config")?;
  if !truthy(target_config) {
    return Ok(Val::Null);
  }
  let versions = cx.versions.get();
  let use_drafts = truthy(versions) && truthy(opt(get(target_config, "versions")?, "drafts")?);
  let join_model = if use_drafts {
    get_k(get(adapter, "versions")?, get(target_config, "slug")?)?
  } else {
    get_k(get(adapter, "collections")?, get(target_config, "slug")?)?
  };
  if !truthy(join_model) {
    return Ok(Val::Null);
  }
  let versions = truthy(versions);
  let parent_ids =
    array_method(cx.docs.get(), "map", "docs", &mut |args| parent_id(args[0], versions))?;

  let join_query = job.join_query.get();
  let where_query = if job.is_polymorphic_join {
    let w = get(join_query, "where")?;
    let w = if truthy(w) { w } else { js::object() };
    filter_where_for_collection(w, get(target_config, "flattenedFields")?, true)?
  } else {
    let w = get(join_query, "where")?;
    if truthy(w) { w } else { js::object() }
  };
  if js::type_of(where_query) == Type::Null {
    return Ok(Val::Null);
  }
  let target_config = val(target_config)?;
  let join_model = val(join_model)?;
  let parent_ids = val(parent_ids)?;
  let query = if use_drafts {
    let build_query = get(join_model.get(), "buildQuery")?;
    let payload = get(adapter, "payload")?;
    let appended = deps::call("appendVersionToQueryKey", &[where_query])?;
    let latest = obj(&[("latest", obj(&[("equals", js::boolean(true))])?)])?;
    let where_ = deps::call("combineQueries", &[appended, latest])?;
    let args = obj(&[("locale", cx.locale.get()), ("payload", payload), ("where", where_)])?;
    call_fn(build_query, join_model.get(), &[args], "JoinModel.buildQuery")?
  } else {
    live_deps::build_query(BuildQueryArgs {
      adapter: cx.adapter.clone(),
      collection_slug: join_collection_slug.clone(),
      fields: val(get(target_config.get(), "flattenedFields")?)?,
      global_slug: Val::Undefined,
      locale: cx.locale.clone(),
      where_: val(where_query)?,
    })?
  };
  let where_query = await_js(query).await?;
  let where_query = where_query.get();
  let adapter = cx.adapter.get();
  let target_config = target_config.get();
  let join_def = job.join_def.get();

  let mut db_field_name = get(get(join_def, "field")?, "on")?;
  let effective_locale = job.effective_locale.get();
  let localization_config = job.localization_config.get();
  if truthy(effective_locale) && js::type_of(localization_config) == Type::Object && truthy(localization_config) {
    let path_segments = call_method(get(get(join_def, "field")?, "on")?, "split", &[s(".")], "joinDef.field.on.split")?;
    let transformed = js::array();
    let fields = if use_drafts {
      let config = get(get(adapter, "payload")?, "config")?;
      deps::build_version_collection_fields(config, target_config, true)?
    } else {
      get(target_config, "flattenedFields")?
    };
    let mut i: f64 = 0.0;
    while lt(num(i), get(path_segments, "length")?)? {
      let segment = get_k(path_segments, num(i))?;
      jsx::push(transformed, segment)?;
      let field_at_segment = array_method(fields, "find", "fields", &mut |args| {
        Ok(js::boolean(strict_eq(get(args[0], "name")?, segment)))
      })?;
      if truthy(field_at_segment) && truthy(get(field_at_segment, "localized")?) {
        jsx::push(transformed, effective_locale)?;
      }
      i += 1.0;
    }
    db_field_name = jsx::call("join", &[transformed, s(".")])?;
  }
  if use_drafts {
    db_field_name = tpl(&[s("version."), db_field_name])?;
  }
  let target_field = get(join_def, "targetField")?;
  let is_polymorphic = if truthy(target_field) { is_array(get(get(join_def, "targetField")?, "relationTo")?)? } else { false };
  let parent_ids = parent_ids.get();
  if is_polymorphic {
    set_k(where_query, tpl(&[db_field_name, s(".relationTo")])?, cx.collection_slug.get())?;
    let key = tpl(&[db_field_name, s(".value")])?;
    set_k(where_query, key, obj(&[("$in", parent_ids)])?)?;
  } else {
    set_k(where_query, db_field_name, obj(&[("$in", parent_ids)])?)?;
  }

  let fields = if use_drafts {
    let config = get(get(adapter, "payload")?, "config")?;
    deps::build_version_collection_fields(config, target_config, true)?
  } else {
    get(target_config, "flattenedFields")?
  };
  let config = get(get(adapter, "payload")?, "config")?;
  let sort_input = || -> JsResult<Local> {
    let v = get(join_query_of(&job)?, "sort")?;
    if truthy(v) {
      return Ok(v);
    }
    let v = get(get(join_def, "field")?, "defaultSort")?;
    if truthy(v) {
      return Ok(v);
    }
    get(target_config, "defaultSort")
  };
  let sort_value = if use_drafts {
    let args = obj(&[("collectionConfig", target_config), ("sort", sort_input()?)])?;
    deps::call("getQueryDraftsSort", &[args])?
  } else {
    sort_input()?
  };
  let sort = live_deps::build_sort_param(BuildSortParamArgs {
    adapter: cx.adapter.clone(),
    config: val(config)?,
    fields: val(fields)?,
    locale: cx.locale.clone(),
    parent_is_localized: Val::Undefined,
    sort: val(sort_value)?,
    sort_aggregation: Val::Undefined,
    timestamps: Val::Bool(true),
    versions: Val::Undefined,
  })?;
  let projection = build_join_projection(db_field_name, use_drafts, sort)?;

  let model = join_model.get();
  let find = get(model, "find")?;
  let options = obj(&[("sort", sort)])?;
  if !job.is_polymorphic_join {
    jsx::define(options, js::key("limit"), job.limit.get())?;
    jsx::define(options, js::key("skip"), job.skip.get())?;
  }
  let query = call_fn(find, model, &[where_query, projection, options], "JoinModel.find")?;
  let lean = call_method(query, "lean", &[], "JoinModel.find(...).lean")?;
  let second = if job.is_polymorphic_join {
    jsx::call("promiseResolve", &[num(0.0)])?
  } else {
    call_method(model, "countDocuments", &[where_query], "JoinModel.countDocuments")?
  };
  let all = jsx::promise_all(arr(&[lean, second])?)?;
  let db_field_name = val(db_field_name)?;
  let sort = val(sort)?;
  let target_config = val(target_config)?;
  let settled = await_js(all).await?;

  let pair = settled.get();
  let results = js::get_element(pair, 0)?;
  let db_count = js::get_element(pair, 1)?;
  let count = if job.is_polymorphic_join { get(results, "length")? } else { db_count };
  let adapter = cx.adapter.get();
  let target_config = target_config.get();
  let fields = if use_drafts {
    let config = get(get(adapter, "payload")?, "config")?;
    deps::build_version_collection_fields(config, target_config, false)?
  } else {
    get(target_config, "fields")?
  };
  live_deps::transform(TransformArgs {
    add_to_set: Val::Undefined,
    inc: Val::Undefined,
    pull: Val::Undefined,
    push: Val::Undefined,
    adapter: cx.adapter.clone(),
    data: val(results)?,
    fields: val(fields)?,
    global_slug: Val::Undefined,
    operation: val(s("read"))?,
    parent_is_localized: Val::Undefined,
    validate_relationships: Val::Undefined,
  })?;
  let result = obj(&[
    ("collectionSlug", join_collection_slug.get()),
    ("count", count),
    ("dbFieldName", db_field_name.get()),
    ("results", results),
    ("sort", sort.get()),
    ("useDrafts", js::boolean(use_drafts)),
  ])?;
  val(result)
}

fn join_query_of(job: &Job) -> JsResult<Local> {
  Ok(job.join_query.get())
}

/// `buildJoinProjection(baseFieldName, useDrafts, sort)`
fn build_join_projection(base_field_name: Local, use_drafts: bool, sort: Local) -> JsResult<Local> {
  let projection = obj_k(&[(js::key("_id"), num(1.0)), (prop_key(base_field_name)?, num(1.0))])?;
  if use_drafts {
    set(projection, "parent", num(1.0))?;
  }
  let names = keys(sort)?;
  for i in 0..js::array_length(names) {
    set_k(projection, js::get_element(names, i)?, num(1.0))?;
  }
  Ok(projection)
}

/// `extractRelationToFilter(where)`: `null` or an array of slugs.
fn extract_relation_to_filter(where_: Local) -> JsResult<Local> {
  if !truthy(where_) || !js::type_of(where_).is_typeof_object() {
    return Ok(js::null());
  }
  if truthy(get(where_, "relationTo")?) && js::type_of(get(where_, "relationTo")?).is_typeof_object() {
    let relation_to = get(where_, "relationTo")?;
    if truthy(get(relation_to, "in")?) && is_array(get(relation_to, "in")?)? {
      return get(relation_to, "in");
    }
    if truthy(get(relation_to, "equals")?) {
      return arr(&[get(relation_to, "equals")?]);
    }
  }
  for op in ["and", "or"] {
    if truthy(get(where_, op)?) && is_array(get(where_, op)?)? {
      let all_results = js::array();
      for_of_sync(get(where_, op)?, &format!("where.{op}"), |condition| {
        let result = extract_relation_to_filter(condition)?;
        if truthy(result) {
          jsx::call("pushSpread", &[all_results, result])?;
        }
        Ok(false)
      })?;
      if js::array_length(all_results) > 0 {
        return jsx::call("uniq", &[all_results]);
      }
    }
  }
  Ok(js::null())
}

/// `filterWhereForCollection(where, availableFields, excludeRelationTo)`
fn filter_where_for_collection(where_: Local, available_fields: Local, exclude_relation_to: bool) -> JsResult<Local> {
  if !truthy(where_) || !js::type_of(where_).is_typeof_object() {
    return Ok(where_);
  }
  // const fieldNames = new Set(availableFields.map((f) => f.name)); SameValueZero against string keys
  let names = array_method(available_fields, "map", "availableFields", &mut |args| get(args[0], "name"))?;
  let mut field_names: Vec<Vec<u16>> = Vec::new();
  for i in 0..js::array_length(names) {
    if let Some(u) = js::get_string_utf16(js::get_element(names, i)?) {
      field_names.push(u);
    }
  }
  if !exclude_relation_to {
    field_names.push("relationTo".encode_utf16().collect());
  }
  let filtered = js::object();
  let pairs = entries(where_)?;
  for i in 0..js::array_length(pairs) {
    let pair = js::get_element(pairs, i)?;
    let key = js::get_element(pair, 0)?;
    let value = js::get_element(pair, 1)?;
    if eq_str(key, "and") {
      if is_array(value)? {
        let filtered_conditions = js::array();
        let mut unsatisfiable = false;
        for_of_sync(value, "value", |condition| {
          let filtered_condition = filter_where_for_collection(condition, available_fields, exclude_relation_to)?;
          if js::type_of(filtered_condition) == Type::Null {
            unsatisfiable = true;
            return Ok(true);
          }
          if js::array_length(keys(filtered_condition)?) > 0 {
            jsx::push(filtered_conditions, filtered_condition)?;
          }
          Ok(false)
        })?;
        if unsatisfiable {
          return Ok(js::null());
        }
        if js::array_length(filtered_conditions) > 0 {
          set_k(filtered, key, filtered_conditions)?;
        }
      }
    } else if eq_str(key, "or") {
      if is_array(value)? {
        let mapped = array_method(value, "map", "value", &mut |args| {
          filter_where_for_collection(args[0], available_fields, exclude_relation_to)
        })?;
        let filtered_conditions = array_method(mapped, "filter", "value.map(...)", &mut |args| {
          let condition = args[0];
          Ok(js::boolean(js::type_of(condition) != Type::Null && js::array_length(keys(condition)?) > 0))
        })?;
        if js::array_length(filtered_conditions) > 0 {
          set_k(filtered, key, filtered_conditions)?;
        }
      }
    } else if eq_str(key, "relationTo") && exclude_relation_to {
      continue;
    } else if js::get_string_utf16(key).is_some_and(|k| field_names.contains(&k)) {
      set_k(filtered, key, value)?;
    } else {
      return Ok(js::null());
    }
  }
  Ok(filtered)
}

/// `getByPathWithArrays(doc, path)`
fn get_by_path_with_arrays(doc: Local, path: Local) -> JsResult<Local> {
  let segments = call_method(path, "split", &[s(".")], "path.split")?;
  let mut current = doc;
  let len = js::array_length(segments);
  for i in 0..len {
    let segment = js::get_element(segments, i)?;
    if nullish(current) {
      return Ok(js::array());
    }
    let value = get_k(current, segment)?;
    if nullish(value) {
      return Ok(js::array());
    }
    if i == len - 1 {
      return if is_array(value)? { Ok(value) } else { arr(&[value]) };
    }
    if is_array(value)? {
      let remaining = {
        let rest = call_method(segments, "slice", &[num(f64::from(i + 1))], "segments.slice")?;
        jsx::call("join", &[rest, s(".")])?
      };
      let results = js::array();
      for_of_sync(value, "value", |item| {
        if truthy(item) && js::type_of(item).is_typeof_object() {
          let sub_results = get_by_path_with_arrays(item, remaining)?;
          jsx::call("pushSpread", &[results, sub_results])?;
        }
        Ok(false)
      })?;
      return Ok(results);
    }
    current = value;
  }
  Ok(js::array())
}

