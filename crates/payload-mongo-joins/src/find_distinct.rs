//! `findDistinct` (packages/db-mongodb/src/findDistinct.ts): the `$group` pipeline of distinct
//! field values (relationship lookups, hasMany unwinds, sort stages), its count pipeline and the
//! pagination of the values.

use payload_engine::error::{EngineError, Result};
use payload_engine::js::JsVal;

use crate::build_join_aggregation::{first_key, sort_direction_of};
use crate::env::{BuildQueryArgs, JoinsEnv, ModelOp, ModelRef, SortParamArgs, get_collection};
use crate::util::{
  add, div, find_by_name, get, in_op, get_field_by_path, gt, is_relationship_or_upload, nullish_or, num, obj, opt_get,
  or_else, read, replace_first, s, sub, mul, template, trim_leading_underscores,
};

pub struct FindDistinctArgs<'a> {
  pub collection: &'a str,
  /// `args.field` (a string in every caller)
  pub field: &'a str,
  pub limit: &'a JsVal,
  pub locale: &'a JsVal,
  pub page: &'a JsVal,
  pub related_access: &'a JsVal,
  pub sort: &'a JsVal,
  /// `args.where` (`undefined` when not passed)
  pub where_: &'a JsVal,
}

struct Rel {
  field_path: String,
  relation_to: String,
}

/// The pipelines `findDistinct` runs.
pub struct DistinctPipelines {
  /// The values pipeline (with `$skip` / `$limit` when `limit` is set).
  pub pipeline: Vec<JsVal>,
  /// The count pipeline (only when `limit` is set).
  pub count_pipeline: Option<Vec<JsVal>>,
  pub page: JsVal,
  /// The collection's model (`getCollection`)
  pub model: ModelRef,
}

/// `findDistinct(args)`; `env.get_session()` stands for `getSession(this, args.req)`.
pub async fn find_distinct<E: JoinsEnv>(env: &E, args: &FindDistinctArgs<'_>) -> Result<JsVal> {
  let DistinctPipelines { pipeline, count_pipeline, page, model } = build_find_distinct_pipelines(env, args).await?;
  let session = env.get_session().await?;

  let values_op = || ModelOp::new(model.clone(), "aggregate", vec![JsVal::arr(pipeline.clone()), obj([("session", session.clone())])]);

  if let Some(count_pipeline) = count_pipeline {
    let res = env
      .model_op(ModelOp::new(model.clone(), "aggregate", vec![JsVal::arr(count_pipeline), obj([("session", session.clone())])]))
      .await?;
    let total_docs = nullish_or(opt_get(&get(&res, "0"), "count"), || Ok(num(0.0)))?;
    let total_pages = num(div(&total_docs, args.limit)?.ceil());
    let has_prev_page = gt(&page, &num(1.0))?;
    let has_next_page = gt(&total_pages, &page)?;
    let paging_counter = add(&num(mul(&num(sub(&page, &num(1.0))?), args.limit)?), &num(1.0))?;
    let values = values_of(env.model_op(values_op()).await?, args.field)?;
    return Ok(obj([
      ("hasNextPage", JsVal::Bool(has_next_page)),
      ("hasPrevPage", JsVal::Bool(has_prev_page)),
      ("limit", args.limit.clone()),
      ("nextPage", if has_next_page { add(&page, &num(1.0))? } else { JsVal::Null }),
      ("page", page.clone()),
      ("pagingCounter", paging_counter),
      ("prevPage", if has_prev_page { num(sub(&page, &num(1.0))?) } else { JsVal::Null }),
      ("totalDocs", total_docs),
      ("totalPages", total_pages),
      ("values", values),
    ]));
  }

  let values = values_of(env.model_op(values_op()).await?, args.field)?;
  let total = get(&values, "length");
  Ok(obj([
    ("hasNextPage", JsVal::Bool(false)),
    ("hasPrevPage", JsVal::Bool(false)),
    ("limit", num(0.0)),
    ("page", num(1.0)),
    ("pagingCounter", num(1.0)),
    ("totalDocs", total),
    ("totalPages", num(1.0)),
    ("values", values),
  ]))
}

/// Everything `findDistinct` does before `getSession`: the values pipeline and the count pipeline.
pub async fn build_find_distinct_pipelines<E: JoinsEnv>(env: &E, args: &FindDistinctArgs<'_>) -> Result<DistinctPipelines> {
  let (collection_config, model) = get_collection(env, args.collection, false)?;
  let flattened_fields = read(&collection_config, "flattenedFields")?;
  let where_ = if args.where_.is_undefined() { obj::<&str>([]) } else { args.where_.clone() };

  let sort_arg = nullish_or(args.sort.clone(), || Ok(s(args.field)))?;
  let sort_param = env.build_sort_param(SortParamArgs {
    fields: &flattened_fields,
    locale: args.locale,
    sort: &sort_arg,
    timestamps: &JsVal::Bool(true),
    versions: &JsVal::Undefined,
    with_sort_aggregation: true,
  })?;
  let sort = sort_param.sort;
  let mut sort_aggregation = sort_param.sort_aggregation;

  let query = env
    .build_query(BuildQueryArgs {
      collection_slug: Some(args.collection),
      fields: &flattened_fields,
      locale: args.locale,
      where_: &where_,
    })
    .await?;

  let field_path_result = get_field_by_path(Some(env.config()), &flattened_fields, true, "", args.field)?;
  let mut field_path = args.field.to_string();
  if let Some(result) = &field_path_result
    && result.path_has_localized
    && args.locale.truthy()
  {
    field_path = replace_first(&result.localized_path, "<locale>", &template(args.locale));
  }

  let page = or_else(args.page.clone(), || Ok(num(1.0)))?;

  let mut sort_property = first_key(&sort)?;
  let sort_direction = sort_direction_of(&sort, &sort_property);

  let mut current_fields = flattened_fields.clone();
  let mut found_field: Option<JsVal> = None;
  let mut rels: Vec<Rel> = Vec::new();
  let mut temp_path = String::new();
  let mut inside_relation = false;

  let segments: Vec<&str> = args.field.split('.').collect();
  for i in 0..segments.len() {
    let segment = segments[i];
    let field = find_by_name(&current_fields, segment)?;
    if !rels.is_empty() {
      inside_relation = true;
    }
    let Some(field) = field else { break };

    let name = template(field.get("name"));
    temp_path = if temp_path.is_empty() { name } else { format!("{temp_path}.{name}") };

    if field.has("flattenedFields") {
      current_fields = field.get("flattenedFields").clone();
      continue;
    }

    if is_relationship_or_upload(&field)
      && let JsVal::Str(relation_to) = field.get("relationTo")
    {
      if i + 2 == segments.len() && segments[i + 1] == "id" {
        found_field = Some(field.clone());
        field_path = temp_path.clone();
        break;
      }
      rels.push(Rel { field_path: temp_path.clone(), relation_to: relation_to.to_string() });
      current_fields = env
        .collection_config(relation_to)
        .map(|config| read(&config, "flattenedFields"))
        .transpose()?
        .unwrap_or_default();
      continue;
    }
    found_field = Some(field);
  }

  let resolved_field = match found_field {
    Some(field) if field.truthy() => field,
    _ => field_path_result.as_ref().map(|r| r.field.clone()).unwrap_or_default(),
  };
  let is_has_many_value = resolved_field.truthy() && resolved_field.has("hasMany");

  let mut relation_lookup: Option<Vec<JsVal>> = None;
  if !inside_relation {
    rels.clear();
  }

  if !rels.is_empty() {
    if sort_property.starts_with('_') {
      let without_prefix = trim_leading_underscores(&sort_property).to_string();
      let last_field_path = rels.last().map(|r| r.field_path.clone()).unwrap_or_default();
      if without_prefix.starts_with(&last_field_path) {
        sort_property = without_prefix;
      }
    }
    let mut lookups = Vec::new();
    for Rel { field_path, relation_to } in &rels {
      let mut kept = Vec::new();
      for each in sort_aggregation.drain(..) {
        let drop = in_op("$lookup", &each)
          && trim_leading_underscores(&lookup_as(&each)?) == field_path.as_str();
        if !drop {
          kept.push(each);
        }
      }
      sort_aggregation = kept;

      let (foreign_config, foreign_model) = get_collection(env, relation_to, false)?;
      let related_access = opt_get(args.related_access, field_path);
      let related_access_query = if related_access.truthy() {
        Some(
          env
            .build_query(BuildQueryArgs {
              collection_slug: Some(relation_to),
              fields: &read(&foreign_config, "flattenedFields")?,
              locale: args.locale,
              where_: &related_access,
            })
            .await?,
        )
      } else {
        None
      };

      let from = env.collection_name(&foreign_model).await?;
      let mut lookup = vec![("as".to_string(), s(field_path.as_str())), ("from".to_string(), from)];
      match related_access_query {
        Some(access_query) => {
          lookup.push(("let".to_string(), obj([("relatedIDs", s(format!("${field_path}")))])));
          lookup.push((
            "pipeline".to_string(),
            JsVal::arr(vec![obj([(
              "$match",
              obj([(
                "$and",
                JsVal::arr(vec![
                  obj([(
                    "$expr",
                    obj([(
                      "$cond",
                      obj([
                        ("else", obj([("$eq", JsVal::arr(vec![s("$_id"), s("$$relatedIDs")]))])),
                        ("if", obj([("$isArray", s("$$relatedIDs"))])),
                        ("then", obj([("$in", JsVal::arr(vec![s("$_id"), s("$$relatedIDs")]))])),
                      ]),
                    )]),
                  )]),
                  access_query,
                ]),
              )]),
            )])]),
          ));
        }
        None => {
          lookup.push(("foreignField".to_string(), s("_id")));
          lookup.push(("localField".to_string(), s(field_path.as_str())));
        }
      }
      lookups.push(obj([("$lookup", obj(lookup))]));
      lookups.push(obj([("$unwind", s(format!("${field_path}")))]));
    }
    relation_lookup = Some(lookups);
  }

  let mut unwind: Option<JsVal> = None;
  let mut group: Option<JsVal> = None;
  let first_sort_lookup = sort_aggregation.first().filter(|stage| stage.truthy() && in_op("$lookup", stage));
  if is_has_many_value && let Some(stage) = first_sort_lookup {
    let as_ = lookup_as(stage)?;
    unwind = Some(obj([("path", s(format!("${as_}"))), ("preserveNullAndEmptyArrays", JsVal::Bool(true))]));
    group = Some(obj([(
      "_id",
      obj([("_field", s(format!("${as_}._id"))), ("_sort", s(format!("${sort_property}")))]),
    )]));
  } else if is_has_many_value {
    unwind = Some(obj([("path", s(format!("${}", args.field))), ("preserveNullAndEmptyArrays", JsVal::Bool(true))]));
  }

  let group = match group {
    Some(group) => group,
    None => {
      let mut entries = vec![("_id".to_string(), s(format!("${field_path}")))];
      if sort_property != field_path {
        entries.push(("_sort".to_string(), obj([("$max", s(format!("${sort_property}")))])));
      }
      obj(entries)
    }
  };

  let head = |out: &mut Vec<JsVal>| {
    out.push(obj([("$match", query.clone())]));
    out.extend(sort_aggregation.iter().cloned());
    if let Some(lookups) = relation_lookup.as_ref().filter(|l| !l.is_empty()) {
      out.extend(lookups.iter().cloned());
    }
    if let Some(unwind) = &unwind {
      out.push(obj([("$unwind", unwind.clone())]));
    }
    out.push(obj([("$group", group.clone())]));
  };

  let mut pipeline = Vec::new();
  head(&mut pipeline);
  pipeline.push(obj([(
    "$sort",
    get_sort_aggregation(&field_path, is_has_many_value && !sort_aggregation.is_empty(), sort_direction, &sort_property),
  )]));

  let count_pipeline = if args.limit.truthy() {
    pipeline.push(obj([("$skip", num(mul(&num(sub(&page, &num(1.0))?), args.limit)?))]));
    pipeline.push(obj([("$limit", args.limit.clone())]));
    let mut count_pipeline = Vec::new();
    head(&mut count_pipeline);
    count_pipeline.push(obj([("$count", s("count"))]));
    Some(count_pipeline)
  } else {
    None
  };

  Ok(DistinctPipelines { pipeline, count_pipeline, page, model })
}

/// `each.$lookup.as` as a string (`.replace` is called on it).
fn lookup_as(stage: &JsVal) -> Result<String> {
  match read(&read(stage, "$lookup")?, "as")? {
    JsVal::Str(text) => Ok(text.to_string()),
    other => Err(EngineError::new("TypeError", format!("{} is not a string", other.type_of()))),
  }
}

/// `getSortAggregation({ fieldPath, hasSortAggregationAndHasMany, sortDirection, sortProperty })`
fn get_sort_aggregation(field_path: &str, has_sort_aggregation_and_has_many: bool, sort_direction: JsVal, sort_property: &str) -> JsVal {
  let resolved = if has_sort_aggregation_and_has_many {
    if sort_property == field_path { "_id._field" } else { "_id._sort" }
  } else if sort_property == field_path {
    "_id"
  } else {
    "_sort"
  };
  obj([(resolved, sort_direction)])
}

/// `res.map((each) => ({ [field]: JSON.parse(JSON.stringify(sanitizeGroupID(each._id))) }))`
fn values_of(res: JsVal, field: &str) -> Result<JsVal> {
  let JsVal::Arr(items) = &res else {
    return Err(EngineError::new("TypeError", "res.map is not a function"));
  };
  let mut out = Vec::with_capacity(items.len());
  for each in items.iter() {
    let id = read(each, "_id")?;
    let id = if id.truthy() && id.is_object_like() && in_op("_field", &id) { get(&id, "_field") } else { id };
    out.push(obj([(field, json_round_trip(&id)?)]));
  }
  Ok(JsVal::arr(out))
}

/// `JSON.parse(JSON.stringify(value))`
fn json_round_trip(value: &JsVal) -> Result<JsVal> {
  if matches!(value, JsVal::Undefined | JsVal::Fn(_)) {
    return Err(EngineError::new("SyntaxError", "\"undefined\" is not valid JSON"));
  }
  if contains_host_object(value) {
    return Err(EngineError::internal("findDistinct: cannot JSON-serialize a host object"));
  }
  Ok(crate::util::js_key_order(&JsVal::from_json(&value.try_to_json()?)))
}

fn contains_host_object(value: &JsVal) -> bool {
  if value.as_host_object().is_some() {
    return true;
  }
  match value {
    JsVal::Arr(a) => a.iter().any(contains_host_object),
    JsVal::Obj(o) => o.values().any(contains_host_object),
    _ => false,
  }
}
