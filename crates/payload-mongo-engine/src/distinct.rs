//! `findDistinct.ts`

use payload_engine::error::EngineError;
use payload_engine::js::{JsVal, Obj};

use crate::components::{BuildQueryArgs, Components, SortParamArgs};
use crate::context::Call;
use crate::entity::get_collection;
use crate::host::{ModelCall, MongoResult, get_session};
use crate::read::{empty_obj, model_op, or_default};
use crate::util::{get_field_by_path, json_round_trip, obj, object_keys, read, to_number};

/// `sanitizeGroupID(id)`
fn sanitize_group_id(id: &JsVal) -> JsVal {
  if id.truthy() && id.type_of() == "object" && id.bson().is_none() && id.typed().is_none() && id.has("_field") {
    return id.get("_field").clone();
  }
  id.clone()
}

/// `getSortAggregation({ fieldPath, hasSortAggregationAndHasMany, sortDirection, sortProperty })`
fn get_sort_aggregation(field_path: &str, has_sort_aggregation_and_has_many: bool, direction: f64, sort_property: &str) -> JsVal {
  let resolved = if has_sort_aggregation_and_has_many {
    if sort_property == field_path { "_id._field" } else { "_id._sort" }
  } else if sort_property == field_path {
    "_id"
  } else {
    "_sort"
  };
  obj([(resolved, JsVal::Num(direction))])
}

/// `'$lookup' in stage`
fn lookup_of(stage: &JsVal) -> Option<&JsVal> {
  stage.as_obj().and_then(|o| o.get("$lookup"))
}

fn strip_leading_underscores(s: &str) -> &str {
  s.trim_start_matches('_')
}

pub async fn find_distinct<C: Components>(components: &C, call: &Call<'_>, args: &JsVal) -> MongoResult<JsVal> {
  let collection_slug = args.get("collection").to_js_string();
  let entity = get_collection(call, &collection_slug, false)?;
  let collection_config = entity.config;
  let model = entity.model;
  let flattened = collection_config.get("flattenedFields");
  let where_ = or_default(args.get("where"), empty_obj);
  let locale = args.get("locale").clone();
  let field_arg = args.get("field").clone();

  let mut sort_aggregation: Vec<JsVal> = Vec::new();
  let sort_input = if args.get("sort").is_nullish() { field_arg.clone() } else { args.get("sort").clone() };
  let sort = components.build_sort_param(
    call,
    SortParamArgs { fields: flattened, locale: &locale, sort: &sort_input, timestamps: true, versions: false },
    Some(&mut sort_aggregation),
  )?;

  let query = components
    .build_query(
      call,
      BuildQueryArgs { collection_slug: Some(&collection_slug), fields: flattened, global_slug: None, locale: &locale, where_: &where_ },
    )
    .await?;

  let field = field_arg.to_js_string();
  let field_path_result = get_field_by_path(Some(call.graph.config()), flattened, true, "", &field);
  let mut field_path = field.clone();
  if let Some(result) = &field_path_result {
    if result.path_has_localized && locale.truthy() {
      field_path = result.localized_path.replacen("<locale>", &locale.to_js_string(), 1);
    }
  }

  let page = if args.get("page").truthy() { args.get("page").clone() } else { JsVal::Num(1.0) };

  let sort_keys = object_keys(&sort)?;
  let mut sort_property = sort_keys.first().cloned().unwrap_or_else(|| "undefined".to_string());
  let sort_direction = if sort.get(&sort_property).as_str() == Some("asc") { 1.0 } else { -1.0 };

  let mut current_fields = flattened.clone();
  let mut found_field: Option<JsVal> = None;
  let mut rels: Vec<(String, String)> = Vec::new();
  let mut temp_path = String::new();
  let mut inside_relation = false;
  let segments: Vec<&str> = field.split('.').collect();

  let mut i = 0;
  while i < segments.len() {
    let segment = segments[i];
    let current = current_fields.items().find(|e| e.get("name").as_str() == Some(segment)).cloned();
    if !rels.is_empty() {
      inside_relation = true;
    }
    let Some(current) = current else { break };
    let name = current.get("name").to_js_string();
    temp_path = if temp_path.is_empty() { name } else { format!("{temp_path}.{name}") };
    if current.has("flattenedFields") {
      current_fields = current.get("flattenedFields").clone();
      i += 1;
      continue;
    }
    let field_type = current.get("type").as_str().unwrap_or("");
    if (field_type == "relationship" || field_type == "upload") && matches!(current.get("relationTo"), JsVal::Str(_)) {
      if i + 2 == segments.len() && segments[i + 1] == "id" {
        found_field = Some(current);
        field_path = temp_path.clone();
        break;
      }
      let relation_to = current.get("relationTo").to_js_string();
      rels.push((temp_path.clone(), relation_to.clone()));
      current_fields = match call.graph.collection(&relation_to) {
        Some(c) => c.get("config").get("flattenedFields").clone(),
        None => JsVal::Undefined,
      };
      if current_fields.is_undefined() && i + 1 < segments.len() {
        // `currentFields.find` of `undefined` on the next segment
        return Err(EngineError::new("TypeError", "Cannot read properties of undefined (reading 'find')").into());
      }
      i += 1;
      continue;
    }
    found_field = Some(current);
    i += 1;
  }

  let resolved_field = match found_field {
    Some(f) if f.truthy() => Some(f),
    _ => field_path_result.as_ref().map(|r| r.field.clone()),
  };
  let is_has_many_value = resolved_field.as_ref().is_some_and(|f| f.truthy() && f.has("hasMany"));

  if !inside_relation {
    rels.clear();
  }

  let mut relation_lookup: Vec<JsVal> = Vec::new();
  if !rels.is_empty() {
    if sort_property.starts_with('_') {
      let without_prefix = strip_leading_underscores(&sort_property).to_string();
      let last_field_path = rels.last().map(|(p, _)| p.clone()).unwrap_or_default();
      if without_prefix.starts_with(&last_field_path) {
        sort_property = without_prefix;
      }
    }
    for (rel_field_path, relation_to) in &rels {
      sort_aggregation.retain(|each| match lookup_of(each) {
        Some(lookup) => strip_leading_underscores(&lookup.get("as").to_js_string()) != rel_field_path,
        None => true,
      });
      let foreign = get_collection(call, relation_to, false)?;
      let related_access = args.get("relatedAccess");
      let related_access = if related_access.is_nullish() { JsVal::Undefined } else { related_access.get(rel_field_path).clone() };
      let related_access_query = if related_access.truthy() {
        Some(
          components
            .build_query(
              call,
              BuildQueryArgs {
                collection_slug: Some(relation_to),
                fields: foreign.config.get("flattenedFields"),
                global_slug: None,
                locale: &locale,
                where_: &related_access,
              },
            )
            .await?,
        )
      } else {
        None
      };
      let from = call
        .ctx
        .collection_name(&foreign.model)
        .map(JsVal::str)
        .ok_or_else(|| EngineError::internal(format!("no collection name for model of {relation_to}")))?;
      let mut lookup = Obj::new();
      lookup.insert("as".into(), JsVal::str(rel_field_path.as_str()));
      lookup.insert("from".into(), from);
      match related_access_query.filter(JsVal::truthy) {
        Some(access_query) => {
          lookup.insert("let".into(), obj([("relatedIDs", JsVal::str(format!("${rel_field_path}")))]));
          let expr = obj([(
            "$expr",
            obj([(
              "$cond",
              obj([
                ("else", obj([("$eq", JsVal::arr(vec![JsVal::str("$_id"), JsVal::str("$$relatedIDs")]))])),
                ("if", obj([("$isArray", JsVal::str("$$relatedIDs"))])),
                ("then", obj([("$in", JsVal::arr(vec![JsVal::str("$_id"), JsVal::str("$$relatedIDs")]))])),
              ]),
            )]),
          )]);
          lookup.insert(
            "pipeline".into(),
            JsVal::arr(vec![obj([("$match", obj([("$and", JsVal::arr(vec![expr, access_query]))]))])]),
          );
        }
        None => {
          lookup.insert("foreignField".into(), JsVal::str("_id"));
          lookup.insert("localField".into(), JsVal::str(rel_field_path.as_str()));
        }
      }
      relation_lookup.push(obj([("$lookup", JsVal::obj(lookup))]));
      relation_lookup.push(obj([("$unwind", JsVal::str(format!("${rel_field_path}")))]));
    }
  }

  let mut unwind = JsVal::str("");
  let mut group: Option<JsVal> = None;
  let first_lookup = sort_aggregation.first().and_then(lookup_of).cloned();
  match (&first_lookup, is_has_many_value) {
    (Some(lookup), true) => {
      let as_ = lookup.get("as").to_js_string();
      unwind = obj([("path", JsVal::str(format!("${as_}"))), ("preserveNullAndEmptyArrays", JsVal::Bool(true))]);
      group = Some(obj([(
        "_id",
        obj([("_field", JsVal::str(format!("${as_}._id"))), ("_sort", JsVal::str(format!("${sort_property}")))]),
      )]));
    }
    (_, true) => {
      unwind = obj([("path", JsVal::str(format!("${field}"))), ("preserveNullAndEmptyArrays", JsVal::Bool(true))]);
    }
    _ => {}
  }
  let group = group.unwrap_or_else(|| {
    let mut g = Obj::new();
    g.insert("_id".into(), JsVal::str(format!("${field_path}")));
    if sort_property != field_path {
      g.insert("_sort".into(), obj([("$max", JsVal::str(format!("${sort_property}")))]));
    }
    JsVal::obj(g)
  });

  let unwind_stage = if unwind.truthy() { Some(obj([("$unwind", unwind.clone())])) } else { None };
  let stages_until_group = |tail: JsVal| -> Vec<JsVal> {
    let mut stages = vec![obj([("$match", query.clone())])];
    stages.extend(sort_aggregation.iter().cloned());
    stages.extend(relation_lookup.iter().cloned());
    stages.extend(unwind_stage.iter().cloned());
    stages.push(obj([("$group", group.clone())]));
    stages.push(tail);
    stages
  };
  let mut pipeline = stages_until_group(obj([(
    "$sort",
    get_sort_aggregation(&field_path, is_has_many_value && !sort_aggregation.is_empty(), sort_direction, &sort_property),
  )]));

  let session = get_session(call).await?;
  let field_key = field.clone();
  let get_values = async |pipeline: Vec<JsVal>| -> MongoResult<JsVal> {
    let res = model_op(call, ModelCall::new(&model, "aggregate", vec![JsVal::arr(pipeline), obj([("session", session.clone())])]))
      .await?;
    let items = res.as_arr().ok_or_else(|| EngineError::new("TypeError", "res.map is not a function"))?;
    let mut values = Vec::with_capacity(items.len());
    for each in items {
      let id = read(each, "_id")?;
      values.push(JsVal::obj(Obj::from_iter([(field_key.clone(), json_round_trip(&sanitize_group_id(id))?)])));
    }
    Ok(JsVal::arr(values))
  };

  let limit = args.get("limit").clone();
  if limit.truthy() {
    let limit_number = to_number(&limit);
    let page_number = to_number(&page);
    pipeline.push(obj([("$skip", JsVal::Num((page_number - 1.0) * limit_number))]));
    pipeline.push(obj([("$limit", limit.clone())]));
    let count_pipeline = stages_until_group(obj([("$count", JsVal::str("count"))]));
    let res =
      model_op(call, ModelCall::new(&model, "aggregate", vec![JsVal::arr(count_pipeline), obj([("session", session.clone())])]))
        .await?;
    let first = res.as_arr().and_then(|r| r.first().cloned()).unwrap_or_default();
    let count = if first.is_nullish() { JsVal::Undefined } else { first.get("count").clone() };
    let total_docs = if count.is_nullish() { JsVal::Num(0.0) } else { count };
    let total_pages = (to_number(&total_docs) / limit_number).ceil();
    let has_prev_page = page_number > 1.0;
    let has_next_page = total_pages > page_number;
    let paging_counter = (page_number - 1.0) * limit_number + 1.0;
    let values = get_values(pipeline).await?;
    let mut out = Obj::new();
    out.insert("hasNextPage".into(), JsVal::Bool(has_next_page));
    out.insert("hasPrevPage".into(), JsVal::Bool(has_prev_page));
    out.insert("limit".into(), limit.clone());
    out.insert("nextPage".into(), if has_next_page { JsVal::Num(page_number + 1.0) } else { JsVal::Null });
    out.insert("page".into(), page.clone());
    out.insert("pagingCounter".into(), JsVal::Num(paging_counter));
    out.insert("prevPage".into(), if has_prev_page { JsVal::Num(page_number - 1.0) } else { JsVal::Null });
    out.insert("totalDocs".into(), total_docs);
    out.insert("totalPages".into(), JsVal::Num(total_pages));
    out.insert("values".into(), values);
    return Ok(JsVal::obj(out));
  }

  let values = get_values(pipeline).await?;
  let total = values.as_arr().map_or(0, <[JsVal]>::len);
  Ok(obj([
    ("hasNextPage", JsVal::Bool(false)),
    ("hasPrevPage", JsVal::Bool(false)),
    ("limit", JsVal::Num(0.0)),
    ("page", JsVal::Num(1.0)),
    ("pagingCounter", JsVal::Num(1.0)),
    ("totalDocs", JsVal::Num(total as f64)),
    ("totalPages", JsVal::Num(1.0)),
    ("values", values),
  ]))
}
