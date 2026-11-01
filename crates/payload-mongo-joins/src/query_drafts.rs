//! `queryDrafts` (packages/db-mongodb/src/queryDrafts.ts): the latest version of each document,
//! through `aggregatePaginate` when joins / relationship sorts need an aggregation and
//! `Model.paginate` otherwise.

use payload_engine::error::Result;
use payload_engine::js::JsVal;

use crate::aggregate_paginate::{AggregatePaginateArgs, aggregate_paginate};
use crate::build_join_aggregation::{JoinAggregationArgs, build_join_aggregation};
use crate::env::{BuildQueryArgs, JoinsEnv, ModelOp, PaginateArgs, SortParamArgs, get_collection};
use crate::resolve_joins::{ResolveJoinsArgs, resolve_joins};
use crate::util::{
  assign, build_version_collection_fields, combine_queries, gt, has_near_constraint, is_str, latest_equals_true, num,
  obj, object_keys, or_else, read, set_key, spread,
};

pub struct QueryDraftsArgs<'a> {
  pub collection: &'a str,
  pub joins: &'a JsVal,
  pub limit: &'a JsVal,
  pub locale: &'a JsVal,
  pub page: &'a JsVal,
  pub pagination: &'a JsVal,
  pub select: &'a JsVal,
  pub sort: &'a JsVal,
  /// `undefined` when not passed (defaults to `{}`)
  pub where_: &'a JsVal,
}

/// `queryDrafts(args)`; `env.get_session()` stands for `getSession(this, req)`.
pub async fn query_drafts<E: JoinsEnv>(env: &E, args: &QueryDraftsArgs<'_>) -> Result<JsVal> {
  let (collection_config, model) = get_collection(env, args.collection, true)?;
  let where_ = if args.where_.is_undefined() { obj::<&str>([]) } else { args.where_.clone() };

  let mut has_near = JsVal::Undefined;
  if where_.truthy() {
    has_near = JsVal::Bool(has_near_constraint(&where_)?);
  }

  let fields = build_version_collection_fields(env.config(), &collection_config, true)?;

  let mut sort = JsVal::Undefined;
  let mut sort_aggregation: Vec<JsVal> = Vec::new();
  if !has_near.truthy() {
    let sort_arg = or_else(args.sort.clone(), || read(&collection_config, "defaultSort"))?;
    let sort_param = env.build_sort_param(SortParamArgs {
      fields: &fields,
      locale: args.locale,
      sort: &sort_arg,
      timestamps: &JsVal::Bool(true),
      versions: &JsVal::Bool(true),
      with_sort_aggregation: true,
    })?;
    sort = sort_param.sort;
    sort_aggregation = sort_param.sort_aggregation;
  }

  let combined_where = combine_queries(&latest_equals_true(), &where_);
  let version_query = env
    .build_query(BuildQueryArgs { collection_slug: None, fields: &fields, locale: args.locale, where_: &combined_where })
    .await?;

  let projection = env.build_projection_from_select(&fields, args.select)?;

  let session = env.get_session().await?;
  let mut options = vec![("session".to_string(), session.clone())];

  let use_estimated_count =
    has_near.truthy() || !version_query.truthy() || object_keys(&version_query)?.is_empty();

  let mut collation = JsVal::Undefined;
  let adapter_collation = env.collation();
  if adapter_collation.truthy() {
    let localization = env.config().get("localization");
    let default_locale = or_else(
      if localization.is_object_like() && !localization.is_nullish() { localization.get("defaultLocale").clone() } else { JsVal::Bool(false) },
      || Ok(crate::util::s("en")),
    )?;
    let locale = args.locale;
    let collation_locale = if locale.truthy() && !is_str(locale, "all") && !is_str(locale, "*") { locale.clone() } else { default_locale };
    let mut entries = indexmap::IndexMap::new();
    set_key(&mut entries, "locale".to_string(), collation_locale);
    for (k, v) in spread(&adapter_collation)? {
      set_key(&mut entries, k, v);
    }
    collation = JsVal::obj(entries);
  }

  let mut custom_count = None;
  if !use_estimated_count && object_keys(&version_query)?.is_empty() && !env.disable_index_hints().is_true() {
    custom_count = Some(ModelOp::new(
      model.clone(),
      "countDocuments",
      vec![
        version_query.clone(),
        obj([("collation", collation.clone()), ("hint", obj([("_id", num(1.0))])), ("session", session.clone())]),
      ],
    ));
  }

  let mut limit = JsVal::Undefined;
  if args.limit.truthy() && gt(args.limit, &num(0.0))? {
    limit = args.limit.clone();
    options.push(("limit".to_string(), args.limit.clone()));
  }

  let aggregate = build_join_aggregation(
    env,
    &JoinAggregationArgs {
      collection: args.collection,
      collection_config: &collection_config,
      drafts_enabled: &JsVal::Undefined,
      joins: args.joins,
      locale: args.locale,
      projection: &projection,
      versions: &JsVal::Bool(true),
    },
  )
  .await?;

  let mut result = if !aggregate.is_empty() || !sort_aggregation.is_empty() {
    aggregate_paginate(
      env,
      &AggregatePaginateArgs {
        collation: &collation,
        join_aggregation: Some(&aggregate),
        limit: &limit,
        model: &model,
        page: args.page,
        pagination: args.pagination,
        projection: &projection,
        query: &version_query,
        // `paginationOptions.options?.session ?? undefined`
        session: &if session.is_nullish() { JsVal::Undefined } else { session.clone() },
        sort: &sort,
        sort_aggregation: Some(&sort_aggregation),
        use_estimated_count: &JsVal::Bool(use_estimated_count),
      },
    )
    .await?
  } else {
    let mut pagination_options = vec![
      ("lean".to_string(), JsVal::Bool(true)),
      ("leanWithId".to_string(), JsVal::Bool(true)),
      ("options".to_string(), obj(options)),
      ("page".to_string(), args.page.clone()),
      ("pagination".to_string(), args.pagination.clone()),
      ("projection".to_string(), projection.clone()),
      ("sort".to_string(), sort.clone()),
      ("useEstimatedCount".to_string(), JsVal::Bool(use_estimated_count)),
    ];
    if adapter_collation.truthy() {
      pagination_options.push(("collation".to_string(), collation.clone()));
    }
    // `useCustomCountFn` (a function in the TS options) travels as `custom_count`.
    if !limit.is_undefined() {
      pagination_options.push(("limit".to_string(), limit.clone()));
    }
    env
      .paginate(PaginateArgs { model: model.clone(), query: version_query.clone(), options: obj(pagination_options), custom_count })
      .await?
  };

  let mut docs: Vec<JsVal> = read(&result, "docs")?.items().cloned().collect();
  if !env.use_join_aggregations() {
    resolve_joins(
      env,
      &mut docs,
      &ResolveJoinsArgs {
        collection_slug: args.collection,
        joins: args.joins,
        locale: args.locale,
        projection: &JsVal::Undefined,
        versions: true,
      },
    )
    .await?;
  }

  let transformed = env.transform_read(JsVal::arr(docs), &build_version_collection_fields(env.config(), &collection_config, false)?)?;

  let mut docs: Vec<JsVal> = Vec::new();
  for doc in transformed.items() {
    let id = crate::util::get(doc, "parent");
    let version = crate::util::get(doc, "version");
    let mut out = if version.is_nullish() { obj::<&str>([]) } else { version };
    assign(&mut out, "id", id)?;
    docs.push(out);
  }
  assign(&mut result, "docs", JsVal::arr(docs))?;
  Ok(result)
}
