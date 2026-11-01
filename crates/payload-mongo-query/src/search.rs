//! `buildQuery`, `parseParams`, `buildAndOrConditions`, `buildSearchParam` (with
//! `buildHasManyRelationshipSearchParam` / `buildJoinContainsSearchParam`) and the
//! `Model.buildQuery` static of `getBuildQueryPlugin`.

use payload_engine::error::{EngineError, Result};
use payload_engine::js::JsVal;
use serde_json::json;

use crate::js::{
  JsObj, get, is_object, is_plain_object, obj1, object_id_is_valid, object_keys, parse_float, template, to_string_method,
  type_error,
};
use crate::merge::deep_merge_with_combined_arrays;
use crate::paths::{LocalizedPathsArgs, PathToQuery, get_field_by_path, get_localized_paths};
use crate::sanitize::{SanitizeArgs, sanitize_query_value};
use crate::{LocalBoxFuture, ModelOp, QueryCx};

/// `validOperators` (payload/src/types/constants.ts)
pub const VALID_OPERATORS: &[&str] = &[
  "equals",
  "contains",
  "not_equals",
  "in",
  "all",
  "not_in",
  "exists",
  "greater_than",
  "greater_than_equal",
  "less_than",
  "less_than_equal",
  "like",
  "not_like",
  "within",
  "intersects",
  "near",
];

/// `operatorMap` (queries/operatorMap.ts)
fn operator_key(operator: &str) -> Option<&'static str> {
  Some(match operator {
    "all" => "$all",
    "equals" => "$eq",
    "exists" => "$exists",
    "greater_than" => "$gt",
    "greater_than_equal" => "$gte",
    "in" => "$in",
    "intersects" => "$geoIntersects",
    "less_than" => "$lt",
    "less_than_equal" => "$lte",
    "near" => "$near",
    "not_equals" => "$ne",
    "not_in" => "$nin",
    "within" => "$geoWithin",
    _ => return None,
  })
}

/// Arguments of `buildQuery` / `parseParams`.
#[derive(Clone, Copy)]
pub struct BuildQueryArgs<'a> {
  pub collection_slug: Option<&'a str>,
  pub fields: &'a JsVal,
  pub global_slug: Option<&'a str>,
  /// `locale` (`undefined` when not passed).
  pub locale: &'a JsVal,
  pub where_: &'a JsVal,
}

/// `buildQuery({ adapter, collectionSlug, fields, globalSlug, locale, where })`
pub async fn build_query(cx: &QueryCx<'_>, args: BuildQueryArgs<'_>) -> Result<JsVal> {
  parse_params(cx, args, false).await
}

/// The model a `Model.buildQuery` static belongs to (how `getBuildQueryPlugin` was configured).
#[derive(Clone, Copy)]
pub enum ModelRef<'a> {
  /// `adapter.collections[slug]`: `getBuildQueryPlugin({ collectionSlug })`
  Collection(&'a str),
  /// `adapter.versions[slug]`: `getBuildQueryPlugin({ collectionSlug?, versionsFields })` (the
  /// version fields built at init, `collectionSlug` only for collection versions).
  Versions { collection_slug: Option<&'a str>, versions_fields: &'a JsVal },
  /// `adapter.globals`: `getBuildQueryPlugin()`
  Globals,
}

#[derive(Clone, Copy)]
pub struct SchemaBuildQueryArgs<'a> {
  pub global_slug: Option<&'a str>,
  pub locale: &'a JsVal,
  pub where_: &'a JsVal,
}

/// `Model.buildQuery({ globalSlug, locale, payload, where })` (`schemaBuildQuery`)
pub async fn schema_build_query(cx: &QueryCx<'_>, model: ModelRef<'_>, args: SchemaBuildQueryArgs<'_>) -> Result<JsVal> {
  let (collection_slug, versions_fields) = match model {
    ModelRef::Collection(slug) => (Some(slug), None),
    ModelRef::Versions { collection_slug, versions_fields } => (collection_slug, Some(versions_fields)),
    ModelRef::Globals => (None, None),
  };

  let mut fields: Option<JsVal> = None;
  if let Some(versions_fields) = versions_fields.filter(|f| f.truthy()) {
    fields = Some(versions_fields.clone());
  } else {
    if let Some(global_slug) = args.global_slug.filter(|s| !s.is_empty()) {
      let mut global_config = JsVal::Undefined;
      for global in get(cx.env.config, "globals")?.items() {
        if get(global, "slug")?.as_str() == Some(global_slug) {
          global_config = global.clone();
          break;
        }
      }
      if !global_config.truthy() {
        return Err(EngineError::api(format!("Global with the slug {global_slug} was not found")));
      }
      fields = Some(get(&global_config, "flattenedFields")?);
    }
    if let Some(collection_slug) = collection_slug.filter(|s| !s.is_empty()) {
      let collection_config = cx.collection(collection_slug).get("config").clone();
      if !collection_config.truthy() {
        return Err(EngineError::api(format!(
          "Collection with the slug {} was not found",
          args.global_slug.unwrap_or("undefined")
        )));
      }
      fields = Some(get(&collection_config, "flattenedFields")?);
    }
  }

  let Some(fields) = fields else {
    return Err(EngineError::api("Fields are not initialized."));
  };

  parse_params(
    cx,
    BuildQueryArgs { collection_slug, fields: &fields, global_slug: args.global_slug, locale: args.locale, where_: args.where_ },
    false,
  )
  .await
}

/// `result.$and.push(item)` (creating `result.$and = []` when falsy).
fn push_and(result: &mut JsObj, item: JsVal) -> Result<()> {
  let current = result.read("$and");
  let mut items = if current.truthy() {
    match &current {
      JsVal::Arr(a) => a.to_vec(),
      _ => return Err(type_error("result.$and.push is not a function")),
    }
  } else {
    Vec::new()
  };
  items.push(item);
  result.set("$and", JsVal::arr(items));
  Ok(())
}

/// `parseParams`
pub fn parse_params<'f>(
  cx: &'f QueryCx<'_>,
  args: BuildQueryArgs<'f>,
  parent_is_localized: bool,
) -> LocalBoxFuture<'f, Result<JsVal>> {
  Box::pin(parse_params_inner(cx, args, parent_is_localized))
}

async fn parse_params_inner(cx: &QueryCx<'_>, args: BuildQueryArgs<'_>, parent_is_localized: bool) -> Result<JsVal> {
  let _depth = cx.enter()?;
  let where_ = args.where_;
  let mut result = JsObj::new();

  if where_.type_of() == "object" {
    for relation_or_path in object_keys(where_)? {
      let condition = get(where_, &relation_or_path)?;
      let lower = relation_or_path.to_lowercase();
      let condition_operator = match lower.as_str() {
        "and" => Some("$and"),
        "or" => Some("$or"),
        _ => None,
      };

      if let JsVal::Arr(items) = &condition {
        let built = build_and_or_conditions(cx, args, parent_is_localized, items).await?;
        if !built.is_empty()
          && let Some(op) = condition_operator
        {
          result.set(op, JsVal::arr(built));
        }
        continue;
      }

      // It's a path - and there can be multiple comparisons on a single path.
      let path_operators = condition;
      if path_operators.type_of() != "object" {
        continue;
      }
      let valid_operators: Vec<String> =
        object_keys(&path_operators)?.into_iter().filter(|op| VALID_OPERATORS.contains(&op.as_str())).collect();

      for operator in &valid_operators {
        let val = get(&path_operators, operator)?;
        let search_param = boxed_search_param(
          cx,
          &SearchArgs {
            collection_slug: args.collection_slug,
            fields: args.fields,
            global_slug: args.global_slug,
            incoming_path: &relation_or_path,
            locale: args.locale,
            operator,
            parent_is_localized,
            val: &val,
          },
        )
        .await?;

        let Some(search_param) = search_param else { continue };
        match &search_param.path {
          Some(path) if search_param.value.truthy() && !path.is_empty() => {
            if valid_operators.len() > 1 {
              push_and(&mut result, obj1(path.as_str(), search_param.value))?;
            } else if result.read(path).truthy() {
              let existing = result.read(path);
              push_and(&mut result, obj1(path.as_str(), existing))?;
              push_and(&mut result, obj1(path.as_str(), search_param.value))?;
              result.remove(path);
            } else {
              result.set(path.as_str(), search_param.value);
            }
          }
          _ => {
            if search_param.value.type_of() == "object" {
              let source = if search_param.value.is_nullish() { JsObj::new().into_val() } else { search_param.value };
              let merged = deep_merge_with_combined_arrays(&result.clone().into_val(), &source)?;
              if !matches!(merged, JsVal::Obj(_)) {
                return Err(crate::js::unsupported("a where that merges into a non-object"));
              }
              result = JsObj::from_val(&merged);
            }
          }
        }
      }
    }
  }

  Ok(result.into_val())
}

/// `buildAndOrConditions`
async fn build_and_or_conditions(
  cx: &QueryCx<'_>,
  args: BuildQueryArgs<'_>,
  parent_is_localized: bool,
  where_: &[JsVal],
) -> Result<Vec<JsVal>> {
  let mut completed = Vec::new();
  for condition in where_ {
    if condition.type_of() == "object" {
      let result = parse_params(cx, BuildQueryArgs { where_: condition, ..args }, parent_is_localized).await?;
      if result.as_obj().is_some_and(|o| !o.is_empty()) {
        completed.push(result);
      }
    }
  }
  Ok(completed)
}

/// `SearchParam`
#[derive(Clone, Debug)]
pub struct SearchParam {
  pub path: Option<String>,
  pub value: JsVal,
}

impl SearchParam {
  fn new(path: Option<&str>, value: JsVal) -> Option<SearchParam> {
    Some(SearchParam { path: path.map(str::to_owned), value })
  }
}

struct SearchArgs<'a> {
  collection_slug: Option<&'a str>,
  fields: &'a JsVal,
  global_slug: Option<&'a str>,
  incoming_path: &'a str,
  locale: &'a JsVal,
  operator: &'a str,
  parent_is_localized: bool,
  val: &'a JsVal,
}

/// `isNestedRelationshipQuery`
fn is_nested_relationship_query(v: &JsVal) -> bool {
  is_plain_object(v)
}

fn type_of_field(field: &JsVal) -> Result<String> {
  Ok(get(field, "type")?.as_str().unwrap_or_default().to_owned())
}

/// `getCollection({ adapter, collectionSlug })`: the collection config (models exist for every
/// collection).
fn get_collection_config(cx: &QueryCx, slug: &str) -> Result<JsVal> {
  let collection = cx.collection(slug);
  if !collection.truthy() {
    return Err(EngineError::api(format!(
      "ERROR: Failed to retrieve collection with the slug \"{slug}\". Does not exist."
    )));
  }
  get(collection, "config")
}

async fn find_lean_select(cx: &QueryCx<'_>, slug: &str, filter: JsVal, select: JsVal) -> Result<JsVal> {
  cx.host
    .model_op(&ModelOp {
      slug: slug.to_owned(),
      method: "find",
      args: vec![filter],
      chain: vec![("lean", vec![]), ("select", vec![select])],
      to_object: false,
    })
    .await
}

async fn distinct(cx: &QueryCx<'_>, slug: &str, path: &str, filter: JsVal) -> Result<JsVal> {
  cx.host
    .model_op(&ModelOp {
      slug: slug.to_owned(),
      method: "distinct",
      args: vec![JsVal::str(path), filter],
      chain: vec![],
      to_object: false,
    })
    .await
}

/// `array.map((doc) => doc._id)`
fn map_ids(result: &JsVal) -> Result<Vec<JsVal>> {
  match result {
    JsVal::Arr(a) => a.iter().map(|doc| get(doc, "_id")).collect(),
    _ => Err(type_error("result.map is not a function")),
  }
}

/// `relationshipField.localizedPath` with `<locale>` replaced like `buildSearchParam` does.
fn join_path_of(cx: &QueryCx, collection_config: &JsVal, on: &JsVal, locale: &JsVal) -> Result<String> {
  let Some(relationship_field) = get_field_by_path(&get(collection_config, "flattenedFields")?, on)? else {
    return Err(EngineError::api("Relationship field was not found"));
  };
  let mut path = relationship_field.localized_path;
  let localization = cx.localization();
  if relationship_field.path_has_localized && localization.truthy() {
    let replacement = if locale.truthy() { template(locale) } else { template(&get(localization, "defaultLocale")?) };
    path = path.replacen("<locale>", &replacement, 1);
  }
  Ok(path)
}

/// [`build_search_param`] boxed in its own frame: the recursion of nested `and` / `or` wheres runs
/// through `parse_params`, whose frames then do not reserve space for this (large) future.
#[inline(never)]
fn boxed_search_param<'f>(cx: &'f QueryCx<'_>, args: &'f SearchArgs<'f>) -> LocalBoxFuture<'f, Result<Option<SearchParam>>> {
  Box::pin(build_search_param(cx, args))
}

/// `buildSearchParam`
async fn build_search_param(cx: &QueryCx<'_>, args: &SearchArgs<'_>) -> Result<Option<SearchParam>> {
  let operator = args.operator;
  let val = args.val;

  // Replace GraphQL nested field double underscore formatting
  let mut sanitized_path = args.incoming_path.replace("__", ".");
  if sanitized_path == "id" {
    sanitized_path = "_id".to_owned();
  }

  let mut has_custom_id = false;
  let paths: Vec<PathToQuery> = if sanitized_path == "_id" {
    let custom_id_field_type = match args.collection_slug.filter(|s| !s.is_empty()) {
      Some(slug) => cx.custom_id_type(slug).clone(),
      None => JsVal::Undefined,
    };
    let mut id_field_type = JsVal::str("text");
    if custom_id_field_type.truthy() {
      id_field_type = custom_id_field_type;
      has_custom_id = true;
    }
    vec![PathToQuery {
      collection_slug: args.collection_slug.map(str::to_owned),
      complete: true,
      field: JsObj::new().with("name", JsVal::str("id")).with("type", id_field_type).into_val(),
      fields: JsVal::Undefined,
      path: "_id".to_owned(),
    }]
  } else {
    get_localized_paths(
      cx,
      &LocalizedPathsArgs {
        collection_slug: args.collection_slug,
        fields: args.fields,
        global_slug: args.global_slug,
        incoming_path: &sanitized_path,
        locale: args.locale,
        parent_is_localized: args.parent_is_localized,
      },
    )?
  };

  let Some(first) = paths.first() else { return Ok(None) };
  let field = first.field.clone();
  let path = first.path.clone();

  if matches!(operator, "contains" | "not_equals" | "equals") && paths.len() == 1 {
    let ty = type_of_field(&field)?;
    if (ty == "relationship" || ty == "upload")
      && get(&field, "hasMany")?.truthy()
      && get(&field, "relationTo")?.as_str().is_some()
      && is_nested_relationship_query(val)
    {
      return build_has_many_relationship_search_param(cx, &field, args.locale, val, operator, &path).await;
    }
  }

  if operator == "contains"
    && paths.len() == 1
    && type_of_field(&field)? == "join"
    && get(&field, "collection")?.as_str().is_some()
    && is_nested_relationship_query(val)
  {
    return build_join_contains_search_param(cx, &field, args.locale, val).await;
  }

  if matches!(operator, "contains" | "like" | "not_like")
    && (is_nested_relationship_query(val) || val.items().any(is_nested_relationship_query))
  {
    return Err(
      EngineError::api(format!("Invalid value for \"{operator}\" on path \"{path}\": expected a string."))
        .with_data(json!({ "status": 400 })),
    );
  }

  if path.is_empty() {
    return Ok(None);
  }

  let Some(sanitized) = sanitize_query_value(
    cx,
    &SanitizeArgs {
      field: &field,
      has_custom_id,
      locale: args.locale,
      operator,
      parent_is_localized: args.parent_is_localized,
      path: &path,
      val,
    },
  )?
  else {
    return Ok(None);
  };

  if let Some(raw_query) = &sanitized.raw_query
    && raw_query.truthy()
    && paths.len() == 1
  {
    return Ok(SearchParam::new(None, raw_query.clone()));
  }

  let Some(formatted_operator) = sanitized.operator.filter(|op| !op.is_empty()) else {
    return Ok(None);
  };
  let formatted_value = sanitized.val;

  // If there are multiple collections to search through,
  // Recursively build up a list of query constraints
  if paths.len() > 1 {
    return build_relationship_hops(cx, args, &paths, &path, &formatted_operator).await;
  }

  if VALID_OPERATORS.contains(&formatted_operator.as_str()) {
    let op_key = operator_key(&formatted_operator);
    let op_key_text = op_key.unwrap_or("undefined");
    let field_type = type_of_field(&field)?;

    if field_type == "relationship" || field_type == "upload" {
      let multi_id_condition = if op_key == Some("$ne") { "$and" } else { "$or" };
      let mut conditions = vec![obj1(path.as_str(), obj1(op_key_text, formatted_value.clone()))];

      if let Some(s) = formatted_value.as_str() {
        if object_id_is_valid(&formatted_value)? {
          conditions.push(obj1(path.as_str(), obj1(op_key_text, crate::js::new_object_id(&formatted_value)?)));
        } else {
          let relation_to = get(&field, "relationTo")?;
          let relation_tos = match &relation_to {
            JsVal::Arr(a) => a.to_vec(),
            other => vec![other.clone()],
          };
          let has_number_id_relation =
            relation_tos.iter().any(|r| cx.custom_id_type(&template(r)).as_str() == Some("number"));
          if has_number_id_relation {
            conditions.push(obj1(path.as_str(), obj1(op_key_text, JsVal::Num(parse_float(&JsVal::str(s))?))));
          }
        }
      }

      if conditions.len() > 1 {
        return Ok(SearchParam::new(None, obj1(multi_id_condition, JsVal::arr(conditions))));
      }
    }

    if formatted_operator == "like"
      && let Some(s) = formatted_value.as_str()
    {
      let ands = s
        .split(' ')
        .map(|word| {
          let pattern = crate::js::escape_reg_exp(&JsVal::str(word))?;
          Ok(obj1(
            path.as_str(),
            JsObj::new().with("$options", JsVal::str("i")).with("$regex", JsVal::str(pattern)).into_val(),
          ))
        })
        .collect::<Result<Vec<_>>>()?;
      return Ok(SearchParam::new(None, obj1("$and", JsVal::arr(ands))));
    }

    if formatted_operator == "not_like"
      && let Some(s) = formatted_value.as_str()
    {
      let ands = s
        .split(' ')
        .map(|word| {
          let pattern = crate::js::escape_reg_exp(&JsVal::str(word))?;
          let regex = JsObj::new().with("$options", JsVal::str("i")).with("$regex", JsVal::str(pattern)).into_val();
          Ok(obj1(path.as_str(), obj1("$not", regex)))
        })
        .collect::<Result<Vec<_>>>()?;
      return Ok(SearchParam::new(None, obj1("$and", JsVal::arr(ands))));
    }

    // Some operators like 'near' need to define a full query
    // so if there is no operator key, just return the value
    let Some(op_key) = op_key else {
      return Ok(SearchParam::new(Some(&path), formatted_value));
    };
    return Ok(SearchParam::new(Some(&path), obj1(op_key, formatted_value)));
  }

  Ok(None)
}

/// The `paths.length > 1` part of `buildSearchParam`: queries the related collections from the
/// last hop back to the first.
async fn build_relationship_hops(
  cx: &QueryCx<'_>,
  args: &SearchArgs<'_>,
  paths: &[PathToQuery],
  path: &str,
  formatted_operator: &str,
) -> Result<Option<SearchParam>> {
  let paths_to_query: Vec<&PathToQuery> = paths[1..].iter().rev().collect();
  let parent_paths: Vec<&PathToQuery> = paths[..paths.len() - 1].iter().rev().collect();

  let mut relationship_query = SearchParam { path: None, value: JsObj::new().into_val() };

  for (i, hop) in paths_to_query.iter().enumerate() {
    let sub_path = hop.path.as_str();
    // The arrays are reversed together, so both entries describe the same relationship hop.
    let parent_field = parent_paths.get(i).map(|p| p.field.clone()).unwrap_or_default();
    if !parent_field.truthy() {
      return Ok(None);
    }

    let Some(collection_slug) = hop.collection_slug.as_deref().filter(|s| !s.is_empty()) else {
      return Err(EngineError::api(format!(
        "Collection with the slug {} was not found.",
        hop.collection_slug.as_deref().unwrap_or("undefined")
      )));
    };

    let collection_config = get_collection_config(cx, collection_slug)?;
    let parent_is_join = type_of_field(&parent_field)? == "join";

    if i == 0 {
      let where_ = obj1(sub_path, obj1(formatted_operator, args.val.clone()));
      let sub_query = Box::pin(schema_build_query(
        cx,
        crate::ModelRef::Collection(collection_slug),
        SchemaBuildQueryArgs { global_slug: None, locale: args.locale, where_: &where_ },
      ))
      .await?;

      let mut select = JsObj::new().with("_id", JsVal::Bool(true));
      let mut join_path: Option<String> = None;

      if parent_is_join {
        let p = join_path_of(cx, &collection_config, &get(&parent_field, "on")?, args.locale)?;
        select.set(p.as_str(), JsVal::Bool(true));
        join_path = Some(p);
      }

      if let Some(p) = &join_path {
        select.set(p.as_str(), JsVal::Bool(true));
      }

      let result = find_lean_select(cx, collection_slug, sub_query, select.into_val()).await?;
      let docs = match &result {
        JsVal::Arr(a) => a.to_vec(),
        _ => return Err(type_error("result.forEach is not a function")),
      };

      let mut in_ids = Vec::new();
      for doc in &docs {
        if let Some(join_path) = &join_path {
          let mut reference = doc.clone();
          for segment in join_path.split('.') {
            if let JsVal::Arr(items) = &reference {
              let mut next = Vec::new();
              for item in items.iter() {
                let value = if is_object(item) && item.truthy() { get(item, segment)? } else { JsVal::Undefined };
                match value {
                  JsVal::Arr(inner) => next.extend(inner.iter().cloned()),
                  other => next.push(other),
                }
              }
              reference = JsVal::arr(next.into_iter().filter(|v| !v.is_nullish()).collect());
            } else if is_object(&reference) && reference.truthy() {
              reference = get(&reference, segment)?;
            } else {
              reference = JsVal::Undefined;
              break;
            }
          }
          if let JsVal::Arr(items) = &reference {
            in_ids.extend(items.iter().filter(|item| item.is_object_id()).cloned());
          } else if reference.is_object_id() {
            in_ids.push(reference);
          }
        } else {
          let id = get(doc, "_id")?;
          let string_id = to_string_method(&id, "doc._id")?;
          if object_id_is_valid(&JsVal::str(string_id.as_str()))? {
            in_ids.push(id);
          } else {
            in_ids.push(JsVal::str(string_id));
          }
        }
      }

      if paths_to_query.len() == 1 {
        let result_path = if join_path.is_some() { "_id" } else { path };
        return Ok(SearchParam::new(Some(result_path), obj1("$in", JsVal::arr(in_ids))));
      }

      if let Some(next_sub_path) = paths_to_query.get(i + 1).map(|p| p.path.as_str()).filter(|p| !p.is_empty()) {
        let in_obj = obj1("$in", JsVal::arr(in_ids));
        relationship_query = SearchParam {
          path: None,
          value: if join_path.is_some() { obj1("_id", in_obj) } else { obj1(next_sub_path, in_obj) },
        };
      }
      continue;
    }

    let sub_query = relationship_query.value.clone();

    // Follow this join back to its parent IDs.
    if parent_is_join {
      let join_path = join_path_of(cx, &collection_config, &get(&parent_field, "on")?, args.locale)?;
      let in_ids = distinct(cx, collection_slug, &join_path, sub_query).await?;
      if i + 1 == paths_to_query.len() {
        return Ok(SearchParam::new(Some("_id"), obj1("$in", in_ids)));
      }
      relationship_query = SearchParam { path: None, value: obj1("_id", obj1("$in", in_ids)) };
      continue;
    }

    let result = cx
      .host
      .model_op(&ModelOp {
        slug: collection_slug.to_owned(),
        method: "find",
        // (the second argument of `Model.find` is the projection: hydrated documents come back)
        args: vec![sub_query, obj1("lean", JsVal::Bool(true))],
        chain: vec![],
        to_object: true,
      })
      .await?;
    let in_ids = JsVal::arr(map_ids(&result)?);

    // If it is the last recursion
    // then pass through the search param
    if i + 1 == paths_to_query.len() {
      relationship_query = SearchParam { path: Some(path.to_owned()), value: obj1("$in", in_ids) };
    } else if let Some(next_sub_path) = paths_to_query.get(i + 1).map(|p| p.path.as_str()).filter(|p| !p.is_empty()) {
      relationship_query = SearchParam { path: None, value: obj1(next_sub_path, obj1("$in", in_ids)) };
    }
  }

  Ok(Some(relationship_query))
}

/// `buildHasManyRelationshipSearchParam`
async fn build_has_many_relationship_search_param(
  cx: &QueryCx<'_>,
  field: &JsVal,
  locale: &JsVal,
  nested_where: &JsVal,
  operator: &str,
  path: &str,
) -> Result<Option<SearchParam>> {
  let relation_to = get(field, "relationTo")?;
  let Some(relation_to) = relation_to.as_str() else { return Ok(None) };
  get_collection_config(cx, relation_to)?;

  let localization = cx.localization();
  let last_segment = path.split('.').next_back().unwrap_or_default();
  let path_locale = if localization.truthy() {
    get(localization, "localeCodes")?.items().find(|code| code.as_str() == Some(last_segment)).cloned().unwrap_or_default()
  } else {
    JsVal::Undefined
  };
  let query_locale = if path_locale.is_nullish() { locale.clone() } else { path_locale };

  let matching = Box::pin(schema_build_query(
    cx,
    crate::ModelRef::Collection(relation_to),
    SchemaBuildQueryArgs { global_slug: None, locale: &query_locale, where_: nested_where },
  ))
  .await?;

  let find_ids = async |query: JsVal| -> Result<JsVal> {
    let result = find_lean_select(cx, relation_to, query, obj1("_id", JsVal::Bool(true))).await?;
    Ok(JsVal::arr(map_ids(&result)?))
  };

  match operator {
    "contains" => Ok(SearchParam::new(Some(path), obj1("$in", find_ids(matching).await?))),
    "equals" => {
      // Every related document satisfies an empty nested query.
      if matching.as_obj().is_none_or(|o| o.is_empty()) {
        return Ok(SearchParam::new(Some(path), obj1("$nin", JsVal::arr(vec![]))));
      }
      let ids = find_ids(matching).await?;
      Ok(SearchParam::new(Some(path), obj1("$not", obj1("$elemMatch", obj1("$nin", ids)))))
    }
    "not_equals" => Ok(SearchParam::new(Some(path), obj1("$nin", find_ids(matching).await?))),
    _ => Ok(None),
  }
}

/// `buildJoinContainsSearchParam`
async fn build_join_contains_search_param(
  cx: &QueryCx<'_>,
  field: &JsVal,
  locale: &JsVal,
  nested_where: &JsVal,
) -> Result<Option<SearchParam>> {
  let collection = get(field, "collection")?;
  let Some(collection) = collection.as_str() else { return Ok(None) };
  let collection_config = get_collection_config(cx, collection)?;
  let join_path = join_path_of(cx, &collection_config, &get(field, "on")?, locale)?;

  let sub_query = Box::pin(schema_build_query(
    cx,
    crate::ModelRef::Collection(collection),
    SchemaBuildQueryArgs { global_slug: None, locale, where_: nested_where },
  ))
  .await?;

  let parent_ids = distinct(cx, collection, &join_path, sub_query).await?;
  Ok(SearchParam::new(Some("_id"), obj1("$in", parent_ids)))
}
