//! The read methods: `find.ts`, `findOne.ts`, `count.ts`, `countVersions.ts`,
//! `countGlobalVersions.ts`, `findGlobal.ts`, `findVersions.ts`, `findGlobalVersions.ts`,
//! `queryDrafts.ts`.

use payload_engine::js::{JsVal, Obj};

use crate::components::{BuildQueryArgs, Components, JoinAggregationArgs, Operation, ResolveJoinsArgs, SortParamArgs, TransformArgs};
use crate::context::Call;
use crate::entity::{get_collection, get_global};
use crate::host::{HostOp, ModelCall, ModelRef, MongoResult, get_session, host_op};
use crate::paginate::{AggregatePaginateArgs, aggregate_paginate};
use crate::util::{combine_queries, ge_num, has_near_constraint, is_num, obj, object_keys_len, props_mut, set, spread_into, type_error};

/// `value === undefined ? default : value` (destructuring defaults).
pub(crate) fn or_default(value: &JsVal, default: impl FnOnce() -> JsVal) -> JsVal {
  if value.is_undefined() { default() } else { value.clone() }
}

/// `a || b`
pub(crate) fn or(a: &JsVal, b: &JsVal) -> JsVal {
  if a.truthy() { a.clone() } else { b.clone() }
}

pub(crate) fn empty_obj() -> JsVal {
  JsVal::obj(Obj::new())
}

pub(crate) fn slug_arg(args: &JsVal, key: &str) -> String {
  args.get(key).to_js_string()
}

pub(crate) async fn model_op(call: &Call<'_>, op: ModelCall) -> MongoResult<JsVal> {
  host_op(call.host, &HostOp::Model(op)).await
}

/// The `collation` option when `adapter.collation` is set:
/// `{ locale: locale && locale !== 'all' && locale !== '*' ? locale : defaultLocale, ...collation }`.
pub(crate) fn collation_option(call: &Call<'_>, locale: &JsVal) -> Option<JsVal> {
  let collation = call.ctx.collation();
  if !collation.truthy() {
    return None;
  }
  let use_locale = locale.truthy() && locale.as_str() != Some("all") && locale.as_str() != Some("*");
  let mut out = Obj::new();
  out.insert("locale".into(), if use_locale { locale.clone() } else { call.graph.default_locale() });
  spread_into(&mut out, collation);
  Some(JsVal::obj(out))
}

/// `useEstimatedCount = hasNearConstraint || !query || Object.keys(query).length === 0`
fn use_estimated_count(has_near: bool, query: &JsVal) -> MongoResult<bool> {
  Ok(has_near || !query.truthy() || object_keys_len(query)? == 0)
}

/// `hasNearConstraint` (`false` when `where` is falsy).
fn near(where_: &JsVal) -> MongoResult<bool> {
  Ok(if where_.truthy() { has_near_constraint(where_)? } else { false })
}

/// The `useCustomCountFn` of the paginated finds (`Model.countDocuments(query, options)`), or
/// `None`. `collation_fallback`: the second branch (collation without index hints) exists.
fn custom_count_fn(
  call: &Call<'_>,
  model: &ModelRef,
  query: &JsVal,
  use_estimated: bool,
  collation: &Option<JsVal>,
  session: &JsVal,
  collation_fallback: bool,
) -> MongoResult<Option<ModelCall>> {
  let collation_value = collation.clone().unwrap_or_default();
  if !use_estimated && object_keys_len(query)? == 0 && call.ctx.index_hints_enabled() {
    let options = obj([
      ("collation", collation_value),
      ("hint", obj([("_id", JsVal::Num(1.0))])),
      ("session", session.clone()),
    ]);
    return Ok(Some(ModelCall::new(model, "countDocuments", vec![query.clone(), options])));
  }
  if collation_fallback && !use_estimated && call.ctx.collation().truthy() {
    let options = obj([("collation", collation_value), ("session", session.clone())]);
    return Ok(Some(ModelCall::new(model, "countDocuments", vec![query.clone(), options])));
  }
  Ok(None)
}

/// Moves `result.docs` out for mutation and puts it back (same key position).
async fn with_docs<F>(result: &mut JsVal, f: F) -> MongoResult<()>
where
  F: AsyncFnOnce(&mut JsVal) -> MongoResult<()>,
{
  let mut docs = result.get("docs").clone();
  if let Some(props) = props_mut(result) {
    props.insert("docs".into(), JsVal::Undefined);
  }
  let outcome = f(&mut docs).await;
  set(result, "docs", docs)?;
  outcome
}

pub async fn find<C: Components>(components: &C, call: &Call<'_>, args: &JsVal) -> MongoResult<JsVal> {
  let collection_slug = slug_arg(args, "collection");
  let drafts_enabled = args.get("draftsEnabled").clone();
  let joins = or_default(args.get("joins"), empty_obj);
  let limit = or_default(args.get("limit"), || JsVal::Num(0.0));
  let locale = args.get("locale").clone();
  let page = args.get("page").clone();
  let pagination = args.get("pagination").clone();
  let projection = args.get("projection").clone();
  let select = args.get("select").clone();
  let sort_arg = args.get("sort").clone();
  let where_ = or_default(args.get("where"), empty_obj);

  let entity = get_collection(call, &collection_slug, false)?;
  let collection_config = entity.config;
  let model = entity.model;

  let has_near = near(&where_)?;
  let mut sort_aggregation = Vec::new();
  let mut sort = JsVal::Undefined;
  if !has_near {
    let timestamps = collection_config.get("timestamps");
    sort = components.build_sort_param(
      call,
      SortParamArgs {
        fields: collection_config.get("flattenedFields"),
        locale: &locale,
        sort: &or(&sort_arg, collection_config.get("defaultSort")),
        timestamps: timestamps.truthy(),
        versions: false,
      },
      Some(&mut sort_aggregation),
    )?;
  }

  let query = components
    .build_query(
      call,
      BuildQueryArgs {
        collection_slug: Some(&collection_slug),
        fields: collection_config.get("flattenedFields"),
        global_slug: None,
        locale: &locale,
        where_: &where_,
      },
    )
    .await?;

  let session = get_session(call).await?;

  let use_estimated = use_estimated_count(has_near, &query)?;
  let mut options = Obj::new();
  options.insert("session".into(), session.clone());
  let mut pagination_options = Obj::new();
  pagination_options.insert("lean".into(), JsVal::Bool(true));
  pagination_options.insert("leanWithId".into(), JsVal::Bool(true));
  pagination_options.insert("options".into(), JsVal::Undefined);
  pagination_options.insert("page".into(), page.clone());
  pagination_options.insert("pagination".into(), pagination.clone());
  pagination_options.insert("projection".into(), projection.clone());
  pagination_options.insert("sort".into(), sort.clone());
  pagination_options.insert("useEstimatedCount".into(), JsVal::Bool(use_estimated));

  if select.truthy() {
    let projection = components.build_projection_from_select(call, collection_config.get("flattenedFields"), &select)?;
    pagination_options.insert("projection".into(), projection);
  }

  let collation = collation_option(call, &locale);
  if let Some(collation) = &collation {
    pagination_options.insert("collation".into(), collation.clone());
  }

  let count_fn = custom_count_fn(call, &model, &query, use_estimated, &collation, &session, true)?;
  if count_fn.is_some() {
    pagination_options.insert("useCustomCountFn".into(), JsVal::Undefined);
  }

  if ge_num(&limit, 0.0) {
    pagination_options.insert("limit".into(), limit.clone());
    options.insert("limit".into(), limit.clone());
    if is_num(&limit, 0.0) {
      pagination_options.insert("pagination".into(), JsVal::Bool(false));
    }
  }
  pagination_options.insert("options".into(), JsVal::obj(options));

  let pagination_projection = pagination_options.get("projection").cloned().unwrap_or_default();
  let aggregate = components
    .build_join_aggregation(
      call,
      JoinAggregationArgs {
        collection: &collection_slug,
        collection_config,
        drafts_enabled: &drafts_enabled,
        joins: &joins,
        locale: &locale,
        projection: &pagination_projection,
        query: &query,
        versions: false,
      },
    )
    .await?;

  let mut result = if !aggregate.is_empty() || !sort_aggregation.is_empty() {
    aggregate_paginate(
      call,
      AggregatePaginateArgs {
        collation: pagination_options.get("collation").cloned().unwrap_or_default(),
        join_aggregation: Some(aggregate),
        limit: pagination_options.get("limit").cloned().unwrap_or_default(),
        model: &model,
        page: page.clone(),
        pagination: pagination_options.get("pagination").cloned().unwrap_or_default(),
        projection: pagination_projection.clone(),
        query: query.clone(),
        session: session_or_undefined(&session),
        sort: sort.clone(),
        sort_aggregation: Some(sort_aggregation),
        use_estimated_count: JsVal::Bool(use_estimated),
      },
    )
    .await?
  } else {
    let mut paginate = ModelCall::new(&model, "paginate", vec![query.clone(), JsVal::obj(pagination_options)]);
    if let Some(count_fn) = count_fn {
      paginate = paginate.fn_option(1, "useCustomCountFn", count_fn);
    }
    model_op(call, paginate).await?
  };

  if !call.ctx.use_join_aggregations() {
    with_docs(&mut result, async |docs| {
      components
        .resolve_joins(
          call,
          ResolveJoinsArgs { collection_slug: &collection_slug, docs, joins: &joins, locale: &locale, versions: false },
        )
        .await
    })
    .await?;
  }

  with_docs(&mut result, async |docs| {
    components.transform(
      call,
      TransformArgs {
        data: docs,
        fields: collection_config.get("fields"),
        global_slug: None,
        operation: Operation::Read,
        update_ops: None,
      },
    )
  })
  .await?;

  Ok(result)
}

/// `paginationOptions.options?.session ?? undefined`
fn session_or_undefined(session: &JsVal) -> JsVal {
  if session.is_nullish() { JsVal::Undefined } else { session.clone() }
}

pub async fn find_one<C: Components>(components: &C, call: &Call<'_>, args: &JsVal) -> MongoResult<JsVal> {
  let collection_slug = slug_arg(args, "collection");
  let drafts_enabled = args.get("draftsEnabled").clone();
  let joins = args.get("joins").clone();
  let locale = args.get("locale").clone();
  let select = args.get("select").clone();
  let where_ = or_default(args.get("where"), empty_obj);

  let entity = get_collection(call, &collection_slug, false)?;
  let collection_config = entity.config;
  let model = entity.model;

  let query = components
    .build_query(
      call,
      BuildQueryArgs {
        collection_slug: Some(&collection_slug),
        fields: collection_config.get("flattenedFields"),
        global_slug: None,
        locale: &locale,
        where_: &where_,
      },
    )
    .await?;

  let projection = components.build_projection_from_select(call, collection_config.get("flattenedFields"), &select)?;

  let aggregate = components
    .build_join_aggregation(
      call,
      JoinAggregationArgs {
        collection: &collection_slug,
        collection_config,
        drafts_enabled: &drafts_enabled,
        joins: &joins,
        locale: &locale,
        projection: &projection,
        query: &query,
        versions: false,
      },
    )
    .await?;

  let session = get_session(call).await?;
  let mut options = Obj::new();
  options.insert("lean".into(), JsVal::Bool(true));
  options.insert("session".into(), session.clone());

  let mut doc = if !aggregate.is_empty() {
    let result = aggregate_paginate(
      call,
      AggregatePaginateArgs {
        collation: JsVal::Undefined,
        join_aggregation: Some(aggregate),
        limit: JsVal::Num(1.0),
        model: &model,
        page: JsVal::Undefined,
        pagination: JsVal::Bool(false),
        projection: projection.clone(),
        query: query.clone(),
        session: session.clone(),
        sort: JsVal::Undefined,
        sort_aggregation: None,
        use_estimated_count: JsVal::Undefined,
      },
    )
    .await?;
    result.get("docs").as_arr().and_then(|docs| docs.first().cloned()).unwrap_or_default()
  } else {
    options.insert("projection".into(), projection.clone());
    model_op(call, ModelCall::new(&model, "findOne", vec![query.clone(), empty_obj(), JsVal::obj(options)])).await?
  };

  if doc.truthy() && !call.ctx.use_join_aggregations() {
    let mut docs = JsVal::arr(vec![doc.clone()]);
    components
      .resolve_joins(
        call,
        ResolveJoinsArgs { collection_slug: &collection_slug, docs: &mut docs, joins: &joins, locale: &locale, versions: false },
      )
      .await?;
    doc = docs.as_arr().and_then(|d| d.first().cloned()).unwrap_or_default();
  }

  if !doc.truthy() {
    return Ok(JsVal::Null);
  }

  components.transform(
    call,
    TransformArgs {
      data: &mut doc,
      fields: collection_config.get("fields"),
      global_slug: None,
      operation: Operation::Read,
      update_ops: None,
    },
  )?;
  Ok(doc)
}

/// Which entity a count reads.
pub enum CountTarget {
  Collection,
  CollectionVersions,
  GlobalVersions,
}

/// `count.ts`, `countVersions.ts`, `countGlobalVersions.ts` (identical apart from the entity).
pub async fn count<C: Components>(components: &C, call: &Call<'_>, args: &JsVal, target: CountTarget) -> MongoResult<JsVal> {
  let locale = args.get("locale").clone();
  let where_ = or_default(args.get("where"), empty_obj);

  let (model, fields, collection_slug) = match target {
    CountTarget::Collection => {
      let slug = slug_arg(args, "collection");
      let entity = get_collection(call, &slug, false)?;
      (entity.model, entity.config.get("flattenedFields").clone(), Some(slug))
    }
    CountTarget::CollectionVersions => {
      let slug = slug_arg(args, "collection");
      let entity = get_collection(call, &slug, true)?;
      (entity.model, call.graph.collection_version_fields(&slug, true), None)
    }
    CountTarget::GlobalVersions => {
      let slug = slug_arg(args, "global");
      let entity = get_global(call, &slug, true)?;
      (entity.model, call.graph.global_version_fields(&slug, true), None)
    }
  };

  let has_near = near(&where_)?;
  let query = components
    .build_query(
      call,
      BuildQueryArgs {
        collection_slug: collection_slug.as_deref(),
        fields: &fields,
        global_slug: None,
        locale: &locale,
        where_: &where_,
      },
    )
    .await?;

  let use_estimated = use_estimated_count(has_near, &query)?;
  let session = get_session(call).await?;
  let mut options = Obj::new();
  options.insert("session".into(), session.clone());
  if let Some(collation) = collation_option(call, &locale) {
    options.insert("collation".into(), collation);
  }
  if !use_estimated && object_keys_len(&query)? == 0 && call.ctx.index_hints_enabled() {
    options.insert("hint".into(), obj([("_id", JsVal::Num(1.0))]));
  }

  let total = if use_estimated {
    model_op(call, ModelCall::new(&model, "estimatedDocumentCount", vec![obj([("session", session)])])).await?
  } else {
    model_op(call, ModelCall::new(&model, "countDocuments", vec![query, JsVal::obj(options)])).await?
  };
  Ok(obj([("totalDocs", total)]))
}

pub async fn find_global<C: Components>(components: &C, call: &Call<'_>, args: &JsVal) -> MongoResult<JsVal> {
  let global_slug = slug_arg(args, "slug");
  let locale = args.get("locale").clone();
  let select = args.get("select").clone();
  let where_ = or_default(args.get("where"), empty_obj);

  let entity = get_global(call, &global_slug, false)?;
  let global_config = entity.config;
  let fields = global_config.get("flattenedFields");

  let combined = combine_queries(&obj([("globalType", obj([("equals", JsVal::str(global_slug.as_str()))]))]), &where_);
  let query = components
    .build_query(
      call,
      BuildQueryArgs { collection_slug: None, fields, global_slug: Some(&global_slug), locale: &locale, where_: &combined },
    )
    .await?;

  let projection = components.build_projection_from_select(call, fields, &select)?;
  let session = get_session(call).await?;
  let options = obj([("lean", JsVal::Bool(true)), ("select", projection), ("session", session)]);

  let mut doc = model_op(call, ModelCall::new(&entity.model, "findOne", vec![query, empty_obj(), options])).await?;
  if !doc.truthy() {
    return Ok(JsVal::Null);
  }
  components.transform(
    call,
    TransformArgs { data: &mut doc, fields: global_config.get("fields"), global_slug: None, operation: Operation::Read, update_ops: None },
  )?;
  Ok(doc)
}

/// Which versions a paginated version find reads.
pub enum VersionsTarget {
  Collection,
  Global,
}

/// `findVersions.ts` / `findGlobalVersions.ts`
pub async fn find_versions<C: Components>(
  components: &C,
  call: &Call<'_>,
  args: &JsVal,
  target: VersionsTarget,
) -> MongoResult<JsVal> {
  let limit = or_default(args.get("limit"), || JsVal::Num(0.0));
  let locale = args.get("locale").clone();
  let page = args.get("page").clone();
  let pagination = args.get("pagination").clone();
  let select = args.get("select").clone();
  let sort_arg = args.get("sort").clone();
  let where_ = or_default(args.get("where"), empty_obj);

  // (model, flattened version fields, fields for the sort, version fields for the transform)
  let (model, version_fields, sort_fields, read_fields) = match target {
    VersionsTarget::Collection => {
      let slug = slug_arg(args, "collection");
      let entity = get_collection(call, &slug, true)?;
      (
        entity.model,
        call.graph.collection_version_fields(&slug, true),
        // upstream sorts versions with the collection's own fields
        entity.config.get("flattenedFields").clone(),
        call.graph.collection_version_fields(&slug, false),
      )
    }
    VersionsTarget::Global => {
      let slug = slug_arg(args, "global");
      let entity = get_global(call, &slug, true)?;
      let fields = call.graph.global_version_fields(&slug, true);
      (entity.model, fields.clone(), fields, call.graph.global_version_fields(&slug, false))
    }
  };

  let has_near = near(&where_)?;
  let mut sort = JsVal::Undefined;
  if !has_near {
    sort = components.build_sort_param(
      call,
      SortParamArgs {
        fields: &sort_fields,
        locale: &locale,
        sort: &or(&sort_arg, &JsVal::str("-updatedAt")),
        timestamps: true,
        versions: false,
      },
      None,
    )?;
  }

  let query = components
    .build_query(
      call,
      BuildQueryArgs { collection_slug: None, fields: &version_fields, global_slug: None, locale: &locale, where_: &where_ },
    )
    .await?;

  let session = get_session(call).await?;
  let skip = match page {
    JsVal::Num(p) if p > 1.0 => {
      let limit_or_zero = if limit.truthy() { crate::util::to_number(&limit) } else { 0.0 };
      JsVal::Num((p - 1.0) * limit_or_zero)
    }
    _ => JsVal::Undefined,
  };
  let mut options = Obj::new();
  options.insert("limit".into(), limit.clone());
  options.insert("session".into(), session.clone());
  options.insert("skip".into(), skip);

  let use_estimated = use_estimated_count(has_near, &query)?;
  let projection = components.build_projection_from_select(call, &version_fields, &select)?;
  let mut pagination_options = Obj::new();
  pagination_options.insert("lean".into(), JsVal::Bool(true));
  pagination_options.insert("leanWithId".into(), JsVal::Bool(true));
  pagination_options.insert("limit".into(), limit.clone());
  pagination_options.insert("options".into(), JsVal::Undefined);
  pagination_options.insert("page".into(), page.clone());
  pagination_options.insert("pagination".into(), pagination.clone());
  pagination_options.insert("projection".into(), projection);
  pagination_options.insert("sort".into(), sort);
  pagination_options.insert("useEstimatedCount".into(), JsVal::Bool(use_estimated));

  let collation = collation_option(call, &locale);
  if let Some(collation) = &collation {
    pagination_options.insert("collation".into(), collation.clone());
  }
  let count_fn = custom_count_fn(call, &model, &query, use_estimated, &collation, &session, true)?;
  if count_fn.is_some() {
    pagination_options.insert("useCustomCountFn".into(), JsVal::Undefined);
  }

  if ge_num(&limit, 0.0) {
    pagination_options.insert("limit".into(), limit.clone());
    options.insert("limit".into(), limit.clone());
    if is_num(&limit, 0.0) {
      pagination_options.insert("pagination".into(), JsVal::Bool(false));
    }
  }
  pagination_options.insert("options".into(), JsVal::obj(options));

  let mut paginate = ModelCall::new(&model, "paginate", vec![query, JsVal::obj(pagination_options)]);
  if let Some(count_fn) = count_fn {
    paginate = paginate.fn_option(1, "useCustomCountFn", count_fn);
  }
  let mut result = model_op(call, paginate).await?;

  with_docs(&mut result, async |docs| {
    components.transform(
      call,
      TransformArgs { data: docs, fields: &read_fields, global_slug: None, operation: Operation::Read, update_ops: None },
    )
  })
  .await?;
  Ok(result)
}

pub async fn query_drafts<C: Components>(components: &C, call: &Call<'_>, args: &JsVal) -> MongoResult<JsVal> {
  let collection_slug = slug_arg(args, "collection");
  let joins = args.get("joins").clone();
  let limit = args.get("limit").clone();
  let locale = args.get("locale").clone();
  let page = args.get("page").clone();
  let pagination = args.get("pagination").clone();
  let select = args.get("select").clone();
  let sort_arg = args.get("sort").clone();
  let where_ = or_default(args.get("where"), empty_obj);

  let entity = get_collection(call, &collection_slug, true)?;
  let collection_config = entity.config;
  let model = entity.model;

  let has_near = near(&where_)?;
  let fields = call.graph.collection_version_fields(&collection_slug, true);

  let mut sort_aggregation = Vec::new();
  let mut sort = JsVal::Undefined;
  if !has_near {
    sort = components.build_sort_param(
      call,
      SortParamArgs {
        fields: &fields,
        locale: &locale,
        sort: &or(&sort_arg, collection_config.get("defaultSort")),
        timestamps: true,
        versions: true,
      },
      Some(&mut sort_aggregation),
    )?;
  }

  let combined_where = combine_queries(&obj([("latest", obj([("equals", JsVal::Bool(true))]))]), &where_);
  let version_query = components
    .build_query(
      call,
      BuildQueryArgs { collection_slug: None, fields: &fields, global_slug: None, locale: &locale, where_: &combined_where },
    )
    .await?;

  let projection = components.build_projection_from_select(call, &fields, &select)?;

  let session = get_session(call).await?;
  let mut options = Obj::new();
  options.insert("session".into(), session.clone());

  let use_estimated = use_estimated_count(has_near, &version_query)?;
  let mut pagination_options = Obj::new();
  pagination_options.insert("lean".into(), JsVal::Bool(true));
  pagination_options.insert("leanWithId".into(), JsVal::Bool(true));
  pagination_options.insert("options".into(), JsVal::Undefined);
  pagination_options.insert("page".into(), page.clone());
  pagination_options.insert("pagination".into(), pagination.clone());
  pagination_options.insert("projection".into(), projection.clone());
  pagination_options.insert("sort".into(), sort.clone());
  pagination_options.insert("useEstimatedCount".into(), JsVal::Bool(use_estimated));

  let collation = collation_option(call, &locale);
  if let Some(collation) = &collation {
    pagination_options.insert("collation".into(), collation.clone());
  }
  let count_fn = custom_count_fn(call, &model, &version_query, use_estimated, &collation, &session, false)?;
  if count_fn.is_some() {
    pagination_options.insert("useCustomCountFn".into(), JsVal::Undefined);
  }

  if limit.truthy() && crate::util::gt_num(&limit, 0.0) {
    pagination_options.insert("limit".into(), limit.clone());
    options.insert("limit".into(), limit.clone());
  }
  pagination_options.insert("options".into(), JsVal::obj(options));

  let aggregate = components
    .build_join_aggregation(
      call,
      JoinAggregationArgs {
        collection: &collection_slug,
        collection_config,
        drafts_enabled: &JsVal::Undefined,
        joins: &joins,
        locale: &locale,
        projection: &projection,
        query: &version_query,
        versions: true,
      },
    )
    .await?;

  let mut result = if !aggregate.is_empty() || !sort_aggregation.is_empty() {
    aggregate_paginate(
      call,
      AggregatePaginateArgs {
        collation: pagination_options.get("collation").cloned().unwrap_or_default(),
        join_aggregation: Some(aggregate),
        limit: pagination_options.get("limit").cloned().unwrap_or_default(),
        model: &model,
        page: page.clone(),
        pagination: pagination_options.get("pagination").cloned().unwrap_or_default(),
        projection: projection.clone(),
        query: version_query.clone(),
        session: session_or_undefined(&session),
        sort: sort.clone(),
        sort_aggregation: Some(sort_aggregation),
        use_estimated_count: JsVal::Bool(use_estimated),
      },
    )
    .await?
  } else {
    let mut paginate = ModelCall::new(&model, "paginate", vec![version_query.clone(), JsVal::obj(pagination_options)]);
    if let Some(count_fn) = count_fn {
      paginate = paginate.fn_option(1, "useCustomCountFn", count_fn);
    }
    model_op(call, paginate).await?
  };

  if !call.ctx.use_join_aggregations() {
    with_docs(&mut result, async |docs| {
      components
        .resolve_joins(
          call,
          ResolveJoinsArgs { collection_slug: &collection_slug, docs, joins: &joins, locale: &locale, versions: true },
        )
        .await
    })
    .await?;
  }

  let read_fields = call.graph.collection_version_fields(&collection_slug, false);
  with_docs(&mut result, async |docs| {
    components.transform(
      call,
      TransformArgs { data: docs, fields: &read_fields, global_slug: None, operation: Operation::Read, update_ops: None },
    )?;
    // `result.docs[i] = result.docs[i].version ?? {}; result.docs[i].id = parent`
    let Some(items) = crate::util::items_mut(docs) else {
      return match docs {
        JsVal::Undefined | JsVal::Null => Err(type_error(format!(
          "Cannot read properties of {} (reading 'length')",
          docs.to_js_string()
        ))
        .into()),
        _ => Ok(()),
      };
    };
    for doc in items.iter_mut() {
      let id = crate::util::read(doc, "parent")?.clone();
      let version = doc.get("version");
      let mut next = if version.is_nullish() { empty_obj() } else { version.clone() };
      set(&mut next, "id", id)?;
      *doc = next;
    }
    Ok(())
  })
  .await?;

  Ok(result)
}
