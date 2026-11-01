//! `buildJoinAggregation` (packages/db-mongodb/src/utilities/buildJoinAggregation.ts): the
//! `$lookup` / `$addFields` / `$set` stages that resolve join fields inside the find aggregation.

use payload_engine::error::{EngineError, Result};
use payload_engine::fields::has_drafts_enabled;
use payload_engine::js::JsVal;

use crate::env::{BuildQueryArgs, JoinsEnv, ModelRef, SortParamArgs, get_collection};
use crate::util::{
  add, append_version_to_query_key, get, build_version_collection_fields, combine_queries, field_should_be_localized,
  get_query_drafts_sort, gt, is_array, is_str, latest_equals_true, mul, num, nullish_or, obj, object_keys,
  opt_get, or_else, property_key, read, s, sub, template,
};

pub struct JoinAggregationArgs<'a> {
  pub collection: &'a str,
  pub collection_config: &'a JsVal,
  pub drafts_enabled: &'a JsVal,
  pub joins: &'a JsVal,
  pub locale: &'a JsVal,
  pub projection: &'a JsVal,
  pub versions: &'a JsVal,
}

/// The destructured join query: `const { count, limit, page, sort, where } = joins?.[path] || {}`
/// with the defaults of each call site.
struct JoinQuery {
  count: JsVal,
  limit: JsVal,
  page: JsVal,
  sort: JsVal,
  where_: JsVal,
}

fn join_query_of(joins: &JsVal, join_path: &str) -> JsVal {
  let query = if joins.is_nullish() { JsVal::Undefined } else { opt_get(joins, join_path) };
  if query.truthy() { query } else { obj::<&str>([]) }
}

/// `Number.MAX_VALUE`
const MAX_VALUE: f64 = f64::MAX;

/// `buildJoinAggregation(args)`
pub async fn build_join_aggregation<E: JoinsEnv>(env: &E, args: &JoinAggregationArgs<'_>) -> Result<Vec<JsVal>> {
  if !env.use_join_aggregations() {
    return Ok(Vec::new());
  }
  let JoinAggregationArgs { collection, collection_config, drafts_enabled, joins, locale, projection, versions } = *args;

  let no_joins = object_keys(&read(collection_config, "joins")?)?.is_empty()
    && loose_eq_zero(&read(&read(collection_config, "polymorphicJoins")?, "length")?)?;
  if no_joins || matches!(joins, JsVal::Bool(false)) {
    return Ok(Vec::new());
  }

  let registered = env.collection_config(collection);
  let join_config = registered.as_ref().map(|c| c.get("joins").clone()).unwrap_or_default();
  if !join_config.truthy() {
    return Err(EngineError::api(format!("Could not retrieve sanitized join config for {collection}.")));
  }

  let mut aggregate: Vec<JsVal> = Vec::new();
  let polymorphic_joins_config = registered.as_ref().map(|c| c.get("polymorphicJoins").clone()).unwrap_or_default();
  if !polymorphic_joins_config.truthy() {
    return Err(EngineError::api(format!(
      "Could not retrieve sanitized polymorphic joins config for {collection}."
    )));
  }

  for join in polymorphic_joins_config.items() {
    let join_path = property_key(&read(join, "joinPath")?);
    if projection.truthy() && !opt_get(projection, &join_path).truthy() {
      continue;
    }
    if matches!(opt_get(joins, &join_path), JsVal::Bool(false)) {
      continue;
    }
    let field = read(join, "field")?;
    let query = join_query_of(joins, &join_path);
    let JoinQuery { count, limit: limit_join, page, sort: sort_join, where_: where_join } = JoinQuery {
      count: nullish_default(get(&query, "count"), || Ok(JsVal::Bool(false)))?,
      limit: nullish_default(get(&query, "limit"), || nullish_or(read(&field, "defaultLimit")?, || Ok(num(10.0))))?,
      page: get(&query, "page"),
      sort: nullish_default(get(&query, "sort"), || {
        or_else(read(&field, "defaultSort")?, || read(collection_config, "defaultSort"))
      })?,
      where_: nullish_default(get(&query, "where"), || Ok(obj::<&str>([])))?,
    };

    let collections = read(&field, "collection")?;
    let mut aggregated_fields: Vec<JsVal> = Vec::new();
    for collection_slug in collections.items() {
      let (config, _) = get_collection(env, &property_key(collection_slug), false)?;
      for f in read(&config, "flattenedFields")?.items() {
        if !aggregated_fields.iter().any(|each| each.get("name").strict_eq(f.get("name"))) {
          aggregated_fields.push(f.clone());
        }
      }
    }
    let aggregated_fields = JsVal::arr(aggregated_fields);

    let sort = env
      .build_sort_param(SortParamArgs {
        fields: &aggregated_fields,
        locale,
        sort: &sort_join,
        timestamps: &JsVal::Bool(true),
        versions: &JsVal::Undefined,
        with_sort_aggregation: false,
      })?
      .sort;

    let match_ = env
      .build_query(BuildQueryArgs { collection_slug: None, fields: &aggregated_fields, locale, where_: &where_join })
      .await?;

    let sort_property = first_key(&sort)?;
    let sort_direction = sort_direction_of(&sort, &sort_property);
    let project_sort = sort_property != "_id" && sort_property != "relationTo";

    let mut aliases: Vec<String> = Vec::new();
    let as_ = join_path.clone();
    let on = template(&read(&field, "on")?);

    for collection_slug in collections.items() {
      let slug = property_key(collection_slug);
      let alias = format!("{as_}.docs.{slug}");
      aliases.push(alias.clone());

      let base_pipeline = vec![
        obj([("$addFields", obj([("relationTo", obj([("$literal", collection_slug.clone())]))]))]),
        obj([(
          "$match",
          obj([(
            "$and",
            JsVal::arr(vec![
              obj([("$expr", obj([("$eq", JsVal::arr(vec![s(format!("${on}")), s("$$root_id_")]))]))]),
              match_.clone(),
            ]),
          )]),
        )]),
      ];

      let (_, model) = get_collection(env, &slug, false)?;
      let from = env.collection_name(&model).await?;

      let mut pipeline = base_pipeline.clone();
      pipeline.push(obj([("$sort", obj([(sort_property.clone(), sort_direction.clone())]))]));
      if gt(&limit_join, &num(0.0))? {
        let limit = if page.truthy() { num(mul(&page, &limit_join)?) } else { limit_join.clone() };
        pipeline.push(obj([("$limit", limit)]));
      }
      let mut project = vec![("value".to_string(), s("$_id"))];
      if project_sort {
        project.push((sort_property.clone(), num(1.0)));
      }
      project.push(("relationTo".to_string(), num(1.0)));
      pipeline.push(obj([("$project", obj(project))]));

      aggregate.push(obj([(
        "$lookup",
        obj([
          ("as", s(alias.clone())),
          ("from", from.clone()),
          ("let", obj([("root_id_", s("$_id"))])),
          ("pipeline", JsVal::arr(pipeline)),
        ]),
      )]));

      if count.truthy() {
        let mut pipeline = base_pipeline.clone();
        pipeline.push(obj([("$count", s("result"))]));
        aggregate.push(obj([(
          "$lookup",
          obj([
            ("as", s(format!("{as_}.totalDocs.{alias}"))),
            ("from", from.clone()),
            ("let", obj([("root_id_", s("$_id"))])),
            ("pipeline", JsVal::arr(pipeline)),
          ]),
        )]));
      }
    }

    aggregate.push(obj([(
      "$addFields",
      obj([(
        format!("{as_}.docs"),
        obj([("$concatArrays", JsVal::arr(aliases.iter().map(|alias| s(format!("${alias}"))).collect()))]),
      )]),
    )]));

    if count.truthy() {
      aggregate.push(obj([(
        "$addFields",
        obj([(
          format!("{as_}.totalDocs"),
          obj([(
            "$add",
            JsVal::arr(
              aliases
                .iter()
                .map(|alias| {
                  obj([(
                    "$ifNull",
                    JsVal::arr(vec![obj([("$first", s(format!("${as_}.totalDocs.{alias}.result")))]), num(0.0)]),
                  )])
                })
                .collect(),
            ),
          )]),
        )]),
      )]));
    }

    aggregate.push(obj([(
      "$set",
      obj([(
        format!("{as_}.docs"),
        obj([(
          "$sortArray",
          obj([
            ("input", s(format!("${as_}.docs"))),
            ("sortBy", obj([(sort_property.clone(), sort_direction.clone())])),
          ]),
        )]),
      )]),
    )]));

    let slice_value = if page.truthy() {
      vec![num(mul(&JsVal::Num(sub(&page, &num(1.0))?), &limit_join)?), limit_join.clone()]
    } else {
      vec![limit_join.clone()]
    };

    aggregate.push(obj([(
      "$addFields",
      obj([(
        format!("{as_}.hasNextPage"),
        obj([(
          "$gt",
          JsVal::arr(vec![obj([("$size", s(format!("${as_}.docs")))]), or_else(limit_join.clone(), || Ok(num(MAX_VALUE)))?]),
        )]),
      )]),
    )]));

    if gt(&limit_join, &num(0.0))? {
      let mut slice = vec![s(format!("${as_}.docs"))];
      slice.extend(slice_value);
      aggregate.push(obj([("$set", obj([(format!("{as_}.docs"), obj([("$slice", JsVal::arr(slice))]))]))]));
    }
  }

  for slug in object_keys(&join_config)? {
    let joins_list = opt_get(&join_config, &slug);
    if !joins_list.truthy() {
      return Err(EngineError::api(format!(
        "Failed to retrieve array of joins for {slug} in collectio {collection}"
      )));
    }

    for join in joins_list.items() {
      let join_path = template(&read(join, "joinPath")?);
      let projection_path = if versions.truthy() { format!("version.{join_path}") } else { join_path.clone() };
      if projection.truthy() && !opt_get(projection, &projection_path).truthy() {
        continue;
      }
      if matches!(opt_get(joins, &join_path), JsVal::Bool(false)) {
        continue;
      }

      let field = read(join, "field")?;
      let field_collection = read(&field, "collection")?;
      let Some(collection_config) = env.collection_config(&property_key(&field_collection)) else {
        return Err(EngineError::api(format!(
          "Collection config for {} was not found",
          field_collection.to_js_string()
        )));
      };

      let use_drafts = (drafts_enabled.truthy() || versions.truthy()) && has_drafts_enabled(&collection_config);
      let config_slug = property_key(collection_config.get("slug"));
      let join_model =
        if use_drafts { ModelRef::Versions(config_slug.clone().into()) } else { ModelRef::Collection(config_slug.clone().into()) };
      if !env.has_model(&join_model) {
        return Err(EngineError::api(format!("Join Model was not found for {config_slug}")));
      }

      let query = join_query_of(joins, &join_path);
      let JoinQuery { count, limit: limit_join, page, sort: sort_join, where_: where_join } = JoinQuery {
        count: get(&query, "count").clone(),
        limit: nullish_default(get(&query, "limit"), || nullish_or(read(&field, "defaultLimit")?, || Ok(num(10.0))))?,
        page: get(&query, "page"),
        sort: nullish_default(get(&query, "sort"), || {
          or_else(read(&field, "defaultSort")?, || read(&collection_config, "defaultSort"))
        })?,
        where_: nullish_default(get(&query, "where"), || Ok(obj::<&str>([])))?,
      };

      if is_array(&field_collection) {
        return Err(EngineError::new("Error", "Unreachable"));
      }

      let fields = if use_drafts {
        build_version_collection_fields(env.config(), &collection_config, true)?
      } else {
        read(&collection_config, "flattenedFields")?
      };

      let sort_arg = if use_drafts { get_query_drafts_sort(&collection_config, &sort_join)? } else { sort_join.clone() };
      let sort = env
        .build_sort_param(SortParamArgs {
          fields: &fields,
          locale,
          sort: &sort_arg,
          timestamps: &JsVal::Bool(true),
          versions: &JsVal::Undefined,
          with_sort_aggregation: false,
        })?
        .sort;
      let sort_property = first_key(&sort)?;
      let sort_direction = sort_direction_of(&sort, &sort_property);

      let match_where = if use_drafts {
        combine_queries(&append_version_to_query_key(&where_join)?, &latest_equals_true())
      } else {
        where_join.clone()
      };
      let match_ = env.model_build_query(&join_model, locale, &match_where).await?;

      let mut pipeline =
        vec![obj([("$match", match_.clone())]), obj([("$sort", obj([(sort_property.clone(), sort_direction.clone())]))])];
      if page.truthy() {
        pipeline.push(obj([("$skip", num(mul(&JsVal::Num(sub(&page, &num(1.0))?), &limit_join)?))]));
      }
      if gt(&limit_join, &num(0.0))? {
        pipeline.push(obj([("$limit", add(&limit_join, &num(1.0))?)]));
      }
      let pipeline = JsVal::arr(pipeline);

      let polymorphic_suffix = if is_array(&read(&read(join, "targetField")?, "relationTo")?) { ".value" } else { "" };
      let local_field = if versions.truthy() { "parent" } else { "_id" };
      // `JoinModel.collection.name` is read where each stage is built
      let mut from_slot: Option<JsVal> = None;

      let add_total_docs_aggregation = |aggregate: &mut Vec<JsVal>, as_: &str, foreign_field: String, from: &JsVal| {
        aggregate.push(obj([(
          "$lookup",
          obj([
            ("as", s(format!("{as_}.totalDocs"))),
            ("foreignField", s(foreign_field)),
            ("from", from.clone()),
            ("localField", s(local_field)),
            ("pipeline", JsVal::arr(vec![obj([("$match", match_.clone())]), obj([("$count", s("result"))])])),
          ]),
        )]));
        aggregate.push(obj([(
          "$addFields",
          obj([(
            format!("{as_}.totalDocs"),
            obj([("$ifNull", JsVal::arr(vec![obj([("$first", s(format!("${as_}.totalDocs.result")))]), num(0.0)]))]),
          )]),
        )]));
      };

      let foreign_field_prefix = if use_drafts { "version." } else { "" };
      let on = template(&read(&field, "on")?);
      let doc_id = if use_drafts { "$$doc.parent" } else { "$$doc._id" };
      let base_as = if versions.truthy() { format!("version.{join_path}") } else { join_path.clone() };
      let localization = env.config().get("localization").clone();

      if localization.truthy() && is_str(locale, "all") {
        for code in read(&localization, "localeCodes")?.items() {
          let code = template(code);
          let as_ = format!("{base_as}{code}");
          let foreign_field = format!("{foreign_field_prefix}{on}{code}{polymorphic_suffix}");
          let from = collection_name_once(env, &join_model, &mut from_slot).await?;

          aggregate.push(obj([(
            "$lookup",
            obj([
              ("as", s(format!("{as_}.docs"))),
              ("foreignField", s(foreign_field.clone())),
              ("from", from.clone()),
              ("localField", s(local_field)),
              ("pipeline", pipeline.clone()),
            ]),
          )]));
          let has_next_page = if limit_join.truthy() {
            obj([("$gt", JsVal::arr(vec![obj([("$size", s(format!("${as_}.docs")))]), limit_join.clone()]))])
          } else {
            JsVal::Bool(false)
          };
          aggregate.push(obj([(
            "$addFields",
            obj([
              (
                format!("{as_}.docs"),
                obj([("$map", obj([("as", s("doc")), ("in", s(doc_id)), ("input", s(format!("${as_}.docs")))]))]),
              ),
              (format!("{as_}.hasNextPage"), has_next_page),
            ]),
          )]));

          if gt(&limit_join, &num(0.0))? {
            aggregate.push(obj([(
              "$addFields",
              obj([(format!("{as_}.docs"), obj([("$slice", JsVal::arr(vec![s(format!("${as_}.docs")), limit_join.clone()]))]))]),
            )]));
          }

          if count.truthy() {
            add_total_docs_aggregation(&mut aggregate, &as_, foreign_field, &from);
          }
        }
      } else {
        let locale_suffix = if field_should_be_localized(&field, join.get("parentIsLocalized"))
          && localization.truthy()
          && locale.truthy()
        {
          format!(".{}", template(locale))
        } else {
          String::new()
        };
        let as_ = format!("{base_as}{locale_suffix}");

        let get_foreign_path = join.get("getForeignPath");
        let foreign_field = if get_foreign_path.truthy() {
          let path = env.call_function(get_foreign_path, obj([("locale", locale.clone())]))?;
          format!("{}{polymorphic_suffix}", template(&path))
        } else {
          format!("{on}{polymorphic_suffix}")
        };
        let from = collection_name_once(env, &join_model, &mut from_slot).await?;

        aggregate.push(obj([(
          "$lookup",
          obj([
            ("as", s(format!("{as_}.docs"))),
            ("foreignField", s(format!("{foreign_field_prefix}{foreign_field}"))),
            ("from", from.clone()),
            ("localField", s(local_field)),
            ("pipeline", pipeline.clone()),
          ]),
        )]));
        aggregate.push(obj([(
          "$addFields",
          obj([
            (
              format!("{as_}.docs"),
              obj([("$map", obj([("as", s("doc")), ("in", s(doc_id)), ("input", s(format!("${as_}.docs")))]))]),
            ),
            (
              format!("{as_}.hasNextPage"),
              obj([(
                "$gt",
                JsVal::arr(vec![
                  obj([("$size", s(format!("${as_}.docs")))]),
                  or_else(limit_join.clone(), || Ok(num(MAX_VALUE)))?,
                ]),
              )]),
            ),
          ]),
        )]));

        if count.truthy() {
          add_total_docs_aggregation(&mut aggregate, &as_, format!("{foreign_field_prefix}{foreign_field}"), &from);
        }

        if gt(&limit_join, &num(0.0))? {
          aggregate.push(obj([(
            "$addFields",
            obj([(format!("{as_}.docs"), obj([("$slice", JsVal::arr(vec![s(format!("${as_}.docs")), limit_join.clone()]))]))]),
          )]));
        }
      }
    }
  }

  Ok(aggregate)
}

async fn collection_name_once<E: JoinsEnv>(env: &E, model: &ModelRef, slot: &mut Option<JsVal>) -> Result<JsVal> {
  if let Some(name) = slot {
    return Ok(name.clone());
  }
  let name = env.collection_name(model).await?;
  *slot = Some(name.clone());
  Ok(name)
}

/// A destructuring default: `value === undefined ? fallback() : value`.
fn nullish_default(value: JsVal, fallback: impl FnOnce() -> Result<JsVal>) -> Result<JsVal> {
  if value.is_undefined() { fallback() } else { Ok(value) }
}

/// `value == 0`
fn loose_eq_zero(value: &JsVal) -> Result<bool> {
  Ok(match value {
    JsVal::Undefined | JsVal::Null => false,
    JsVal::Num(n) => *n == 0.0,
    _ => crate::util::to_number(value)? == 0.0,
  })
}

/// `Object.keys(sort)[0]` as a property key (`'undefined'` when `sort` is empty).
pub(crate) fn first_key(sort: &JsVal) -> Result<String> {
  Ok(object_keys(sort)?.into_iter().next().unwrap_or_else(|| "undefined".to_string()))
}

/// `sort[sortProperty] === 'asc' ? 1 : -1`
pub(crate) fn sort_direction_of(sort: &JsVal, sort_property: &str) -> JsVal {
  num(if is_str(&opt_get(sort, sort_property), "asc") { 1.0 } else { -1.0 })
}
