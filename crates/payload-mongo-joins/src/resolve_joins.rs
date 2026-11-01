//! `resolveJoins` (packages/db-mongodb/src/utilities/resolveJoins.ts): resolves join fields with
//! separate queries per joined collection (adapters with `useJoinAggregations: false`) and writes
//! the paginated results into the parent documents.

use indexmap::IndexMap;
use payload_engine::error::{EngineError, Result};
use payload_engine::js::JsVal;
use payload_sql_read::jsops::relative_index;
use payload_sql_read::sort::v8_sort;

use crate::env::{BuildQueryArgs, JoinsEnv, ModelOp, ModelRef, SortParamArgs, join_all, join2};
use crate::util::{
  add, append_version_to_query_key, assign, build_version_collection_fields, combine_queries,
  field_should_be_localized, get, get_query_drafts_sort, gt, is_array, is_str, latest_equals_true, lt, mul, num,
  nullish_or, obj, object_entries, opt_get, or_else, prop_mut, property_key, read, s, set_key, spread, sub, template,
  to_number,
};

pub struct ResolveJoinsArgs<'a> {
  pub collection_slug: &'a str,
  pub joins: &'a JsVal,
  pub locale: &'a JsVal,
  pub projection: &'a JsVal,
  pub versions: bool,
}

struct CollectionResult {
  collection_slug: JsVal,
  count: JsVal,
  db_field_name: String,
  results: JsVal,
  sort: JsVal,
  use_drafts: bool,
}

struct Group {
  docs: Vec<JsVal>,
  sort: JsVal,
}

struct JoinResult {
  grouped: IndexMap<String, Group>,
  is_polymorphic_join: bool,
  join_query: JsVal,
  limit: JsVal,
  localized_join_path: String,
  skip: f64,
  total_count: f64,
}

/// `resolveJoins({ adapter, collectionSlug, docs, joins, locale, projection, versions })`:
/// mutates `docs` like the TS mutates its argument.
pub async fn resolve_joins<E: JoinsEnv>(env: &E, docs: &mut [JsVal], args: &ResolveJoinsArgs<'_>) -> Result<()> {
  let ResolveJoinsArgs { collection_slug, joins, locale, projection, versions } = *args;
  if !joins.truthy() || docs.is_empty() {
    return Ok(());
  }

  let Some(collection_config) = env.collection_config(collection_slug).filter(JsVal::truthy) else {
    return Ok(());
  };

  // joinPath -> { ...join, targetCollection }; only `field`, `parentIsLocalized` and
  // `targetField` are read from the entries.
  let mut join_map: IndexMap<String, JsVal> = IndexMap::new();
  for (_target, join_list) in object_entries(&read(&collection_config, "joins")?)? {
    for join in iterate(&join_list)? {
      join_map.insert(property_key(&read(&join, "joinPath")?), join.clone());
    }
  }
  let polymorphic = or_else(collection_config.get("polymorphicJoins").clone(), || Ok(JsVal::arr(Vec::new())))?;
  for join in iterate(&polymorphic)? {
    join_map.insert(property_key(&read(&join, "joinPath")?), join.clone());
  }

  // `docs` is read (parent ids) by every join before any of them writes to it.
  let parent_docs: Vec<JsVal> = docs.to_vec();
  let join_map = &join_map;
  let parent_docs = &parent_docs;

  let join_futures = object_entries(joins)?
    .into_iter()
    .map(|(join_path, join_query)| resolve_join(env, join_map, parent_docs, collection_slug, join_path, join_query, locale, projection, versions))
    .collect();
  let join_results = join_all(join_futures).await?;

  for join_result in join_results.into_iter().flatten() {
    let JoinResult { grouped, is_polymorphic_join, join_query, limit, localized_join_path, skip, total_count } = join_result;
    for doc in docs.iter_mut() {
      let id = parent_id(doc, versions);
      let all = grouped.get(&property_key(&id)).map(|g| g.docs.clone()).unwrap_or_default();

      let slice = if is_polymorphic_join {
        if limit_is_zero(&limit) {
          all
        } else {
          let end = to_number(&add(&num(skip), &limit)?)?;
          let (start, end) = (relative_index(skip, all.len()), relative_index(end, all.len()));
          if start < end { all[start..end].to_vec() } else { Vec::new() }
        }
      } else {
        all
      };

      let has_next_page = if limit_is_zero(&limit) {
        false
      } else {
        total_count > skip + slice.len() as f64
      };
      let mut value = vec![("docs", JsVal::arr(slice)), ("hasNextPage", JsVal::Bool(has_next_page))];
      if get(&join_query, "count").truthy() {
        value.push(("totalDocs", num(total_count)));
      }
      let value = obj(value);

      let segments: Vec<&str> = localized_join_path.split('.').collect();
      let target: &mut JsVal = if versions {
        if !doc.get("version").truthy() {
          assign(doc, "version", obj::<&str>([]))?;
        }
        prop_mut(doc, "version").ok_or_else(|| EngineError::internal("resolveJoins: doc.version is not an object"))?
      } else {
        doc
      };
      set_path(target, &segments, value)?;
    }
  }
  Ok(())
}

/// `ref = doc; for (seg of segments[..-1]) { if (!ref[seg]) ref[seg] = {}; ref = ref[seg] }; ref[last] = value`
fn set_path(target: &mut JsVal, segments: &[&str], value: JsVal) -> Result<()> {
  let Some((last, parents)) = segments.split_last() else { return Ok(()) };
  let mut current = target;
  for seg in parents {
    if !get(current, seg).truthy() {
      assign(current, seg, obj::<&str>([]))?;
    }
    current = match current {
      JsVal::Obj(_) if current.typed().is_none() && current.bson().is_none() && current.as_host_object().is_none() => {
        prop_mut(current, seg).ok_or_else(|| EngineError::internal("resolveJoins: missing path segment"))?
      }
      _ => return Err(EngineError::internal(format!("resolveJoins: cannot descend into '{seg}' of a non-plain value"))),
    };
  }
  assign(current, last, value)
}

fn limit_is_zero(limit: &JsVal) -> bool {
  matches!(limit, JsVal::Num(n) if *n == 0.0)
}

/// `versions ? (d.parent ?? d._id ?? d.id) : (d._id ?? d.id)`
fn parent_id(doc: &JsVal, versions: bool) -> JsVal {
  let id = if get(doc, "_id").is_nullish() { get(doc, "id") } else { get(doc, "_id") };
  if versions && !get(doc, "parent").is_nullish() { get(doc, "parent") } else { id }
}

/// `for (const item of value)` over an array (`TypeError` otherwise).
fn iterate(value: &JsVal) -> Result<Vec<JsVal>> {
  match value {
    JsVal::Arr(items) => Ok(items.to_vec()),
    JsVal::Str(text) => Ok(text.chars().map(|c| s(c.to_string())).collect()),
    _ => Err(EngineError::new("TypeError", format!("{} is not iterable", value.type_of()))),
  }
}

#[allow(clippy::too_many_arguments)]
async fn resolve_join<E: JoinsEnv>(
  env: &E,
  join_map: &IndexMap<String, JsVal>,
  docs: &[JsVal],
  collection_slug: &str,
  join_path: String,
  join_query: JsVal,
  locale: &JsVal,
  projection: &JsVal,
  versions: bool,
) -> Result<Option<JoinResult>> {
  if !join_query.truthy() {
    return Ok(None);
  }
  if projection.truthy() && !opt_get(projection, &join_path).truthy() {
    return Ok(None);
  }
  let Some(join_def) = join_map.get(&join_path) else { return Ok(None) };

  let field = read(join_def, "field")?;
  let field_collection = read(&field, "collection")?;
  let all_collections = if is_array(&field_collection) { field_collection.items().cloned().collect() } else { vec![field_collection.clone()] };

  let localization_config = env.config().get("localization").clone();
  let effective_locale = or_else(locale.clone(), || {
    // `typeof localizationConfig === 'object' && localizationConfig && localizationConfig.defaultLocale`
    Ok(if !localization_config.is_object_like() {
      JsVal::Bool(false)
    } else if !localization_config.truthy() {
      localization_config.clone()
    } else {
      localization_config.get("defaultLocale").clone()
    })
  })?;

  let join_where = or_else(get(&join_query, "where"), || Ok(obj::<&str>([])))?;
  let relation_to_filter = extract_relation_to_filter(&join_where)?;
  let collections: Vec<JsVal> = match &relation_to_filter {
    Some(filter) => all_collections.into_iter().filter(|c| filter.iter().any(|f| same_value_zero(f, c))).collect(),
    None => all_collections,
  };

  let is_polymorphic_join = is_array(&field_collection);

  let limit = nullish_or(get(&join_query, "limit"), || nullish_or(read(&field, "defaultLimit")?, || Ok(num(10.0))))?;
  let page = nullish_or(get(&join_query, "page"), || Ok(num(1.0)))?;
  let skip = mul(&num(sub(&page, &num(1.0))?), &limit)?;

  let collection_futures = collections
    .iter()
    .map(|join_collection_slug| {
      resolve_collection(
        env,
        join_def,
        docs,
        collection_slug,
        join_collection_slug,
        &join_query,
        &limit,
        skip,
        locale,
        &effective_locale,
        &localization_config,
        is_polymorphic_join,
        versions,
      )
    })
    .collect();
  let collection_results = join_all(collection_futures).await?;

  let mut grouped: IndexMap<String, Group> = IndexMap::new();
  let mut total_count = num(0.0);
  for collection_result in collection_results.into_iter().flatten() {
    let CollectionResult { collection_slug, count, db_field_name, results, sort, use_drafts } = collection_result;
    total_count = add(&total_count, &count)?;

    for mut result in results.items().cloned() {
      if use_drafts {
        let parent = get(&result, "parent");
        assign(&mut result, "id", parent)?;
      }
      let parent_values = get_by_path_with_arrays(&result, &db_field_name);
      if parent_values.is_empty() {
        continue;
      }
      for mut parent_value in parent_values {
        if !parent_value.truthy() {
          continue;
        }
        if parent_value.is_object_like() {
          parent_value = get(&parent_value, "value");
        }
        let join_data = obj([("relationTo", collection_slug.clone()), ("value", get(&result, "id"))]);
        let group = grouped.entry(property_key(&parent_value)).or_insert_with(|| Group { docs: Vec::new(), sort: sort.clone() });
        let mut doc = spread(&result)?;
        set_key(&mut doc, "__joinData".to_string(), join_data);
        group.docs.push(JsVal::obj(doc));
      }
    }
  }

  for group in grouped.values_mut() {
    let sort_entries = object_entries(&group.sort)?;
    let mut error = None;
    v8_sort(&mut group.docs, |a, b| {
      if error.is_some() {
        return 0.0;
      }
      match compare(a, b, &sort_entries) {
        Ok(order) => order,
        Err(e) => {
          error = Some(e);
          0.0
        }
      }
    });
    if let Some(e) = error {
      return Err(e);
    }
    group.docs = group
      .docs
      .iter()
      .map(|doc| if is_polymorphic_join { get(doc, "__joinData") } else { get(doc, "id") })
      .collect();
  }

  let locale_suffix = if field_should_be_localized(&field, join_def.get("parentIsLocalized"))
    && localization_config.truthy()
    && effective_locale.truthy()
  {
    format!(".{}", template(&effective_locale))
  } else {
    String::new()
  };

  Ok(Some(JoinResult {
    grouped,
    is_polymorphic_join,
    join_query,
    limit,
    localized_join_path: format!("{join_path}{locale_suffix}"),
    skip,
    total_count: to_number(&total_count)?,
  }))
}

/// The comparator of `results.docs.sort`.
fn compare(a: &JsVal, b: &JsVal, sort: &[(String, JsVal)]) -> Result<f64> {
  for (field_name, sort_order) in sort {
    let direction = if is_str(sort_order, "asc") { 1.0 } else { -1.0 };
    let (a_value, b_value) = (get(a, field_name), get(b, field_name));
    if lt(&a_value, &b_value)? {
      return Ok(-direction);
    }
    if gt(&a_value, &b_value)? {
      return Ok(direction);
    }
  }
  Ok(0.0)
}

#[allow(clippy::too_many_arguments)]
async fn resolve_collection<E: JoinsEnv>(
  env: &E,
  join_def: &JsVal,
  docs: &[JsVal],
  collection_slug: &str,
  join_collection_slug: &JsVal,
  join_query: &JsVal,
  limit: &JsVal,
  skip: f64,
  locale: &JsVal,
  effective_locale: &JsVal,
  localization_config: &JsVal,
  is_polymorphic_join: bool,
  versions: bool,
) -> Result<Option<CollectionResult>> {
  let Some(target_config) = env.collection_config(&property_key(join_collection_slug)).filter(JsVal::truthy) else {
    return Ok(None);
  };

  let use_drafts = versions && opt_get(&get(&target_config, "versions"), "drafts").truthy();
  let target_slug = property_key(target_config.get("slug"));
  let join_model = if use_drafts { ModelRef::Versions(target_slug.into()) } else { ModelRef::Collection(target_slug.into()) };
  if !env.has_model(&join_model) {
    return Ok(None);
  }

  let parent_ids = JsVal::arr(docs.iter().map(|d| parent_id(d, versions)).collect());

  let where_ = or_else(get(join_query, "where"), || Ok(obj::<&str>([])))?;
  let where_query = if is_polymorphic_join {
    filter_where_for_collection(&where_, &read(&target_config, "flattenedFields")?, true)?
  } else {
    Some(where_)
  };
  let Some(where_query) = where_query else { return Ok(None) };

  let mut where_query = if use_drafts {
    let where_ = combine_queries(&append_version_to_query_key(&where_query)?, &latest_equals_true());
    env.model_build_query(&join_model, locale, &where_).await?
  } else {
    env
      .build_query(BuildQueryArgs {
        collection_slug: Some(&property_key(join_collection_slug)),
        fields: &read(&target_config, "flattenedFields")?,
        locale,
        where_: &where_query,
      })
      .await?
  };

  let field = read(join_def, "field")?;
  let mut db_field_name = template(&read(&field, "on")?);

  if effective_locale.truthy() && localization_config.is_object_like() && localization_config.truthy() {
    let fields = if use_drafts {
      build_version_collection_fields(env.config(), &target_config, true)?
    } else {
      read(&target_config, "flattenedFields")?
    };
    let mut transformed: Vec<String> = Vec::new();
    for segment in db_field_name.split('.') {
      transformed.push(segment.to_string());
      let field_at_segment = crate::util::find_by_name(&fields, segment)?;
      if field_at_segment.is_some_and(|f| f.get("localized").truthy()) {
        transformed.push(template(effective_locale));
      }
    }
    db_field_name = transformed.join(".");
  }

  if use_drafts {
    db_field_name = format!("version.{db_field_name}");
  }

  let target_field = join_def.get("targetField");
  let is_polymorphic = target_field.truthy() && is_array(&read(target_field, "relationTo")?);

  if is_polymorphic {
    assign(&mut where_query, &format!("{db_field_name}.relationTo"), s(collection_slug))?;
    assign(&mut where_query, &format!("{db_field_name}.value"), obj([("$in", parent_ids)]))?;
  } else {
    assign(&mut where_query, &db_field_name, obj([("$in", parent_ids)]))?;
  }

  let fields = if use_drafts {
    build_version_collection_fields(env.config(), &target_config, true)?
  } else {
    read(&target_config, "flattenedFields")?
  };
  let sort_value = or_else(get(join_query, "sort"), || {
    or_else(read(&field, "defaultSort")?, || Ok(target_config.get("defaultSort").clone()))
  })?;
  let sort_arg = if use_drafts { get_query_drafts_sort(&target_config, &sort_value)? } else { sort_value };
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

  let projection = build_join_projection(&db_field_name, use_drafts, &sort)?;

  let mut options = vec![("sort".to_string(), sort.clone())];
  if !is_polymorphic_join {
    options.push(("limit".to_string(), limit.clone()));
    options.push(("skip".to_string(), num(skip)));
  }
  let find = env.model_op(
    ModelOp::new(join_model.clone(), "find", vec![where_query.clone(), projection, obj(options)]).chain("lean", Vec::new()),
  );
  let count = async {
    if is_polymorphic_join {
      Ok(num(0.0))
    } else {
      env.model_op(ModelOp::new(join_model.clone(), "countDocuments", vec![where_query.clone()])).await
    }
  };
  let (results, db_count) = join2(find, count).await?;

  let count = if is_polymorphic_join { get(&results, "length") } else { db_count };

  let transform_fields = if use_drafts {
    build_version_collection_fields(env.config(), &target_config, false)?
  } else {
    read(&target_config, "fields")?
  };
  let results = env.transform_read(results, &transform_fields)?;

  Ok(Some(CollectionResult {
    collection_slug: join_collection_slug.clone(),
    count,
    db_field_name,
    results,
    sort,
    use_drafts,
  }))
}

/// `SameValueZero(a, b)` (`Array.prototype.includes`)
fn same_value_zero(a: &JsVal, b: &JsVal) -> bool {
  match (a, b) {
    (JsVal::Num(x), JsVal::Num(y)) if x.is_nan() && y.is_nan() => true,
    _ => a.strict_eq(b),
  }
}

/// `extractRelationToFilter(where)`
fn extract_relation_to_filter(where_: &JsVal) -> Result<Option<Vec<JsVal>>> {
  if !where_.truthy() || !where_.is_object_like() {
    return Ok(None);
  }

  let relation_to = get(where_, "relationTo");
  if relation_to.truthy() && relation_to.is_object_like() {
    let in_ = get(&relation_to, "in");
    if in_.truthy() && is_array(&in_) {
      return Ok(Some(in_.items().cloned().collect()));
    }
    let equals = get(&relation_to, "equals");
    if equals.truthy() {
      return Ok(Some(vec![equals]));
    }
  }

  for key in ["and", "or"] {
    let conditions = get(where_, key);
    if conditions.truthy() && is_array(&conditions) {
      let mut all: Vec<JsVal> = Vec::new();
      for condition in conditions.items() {
        if let Some(result) = extract_relation_to_filter(condition)? {
          all.extend(result);
        }
      }
      if !all.is_empty() {
        // `[...new Set(all)]`
        let mut unique: Vec<JsVal> = Vec::new();
        for value in all {
          if !unique.iter().any(|u| same_value_zero(u, &value)) {
            unique.push(value);
          }
        }
        return Ok(Some(unique));
      }
    }
  }

  Ok(None)
}

/// `filterWhereForCollection(where, availableFields, excludeRelationTo)`: `None` for `null`.
fn filter_where_for_collection(where_: &JsVal, available_fields: &JsVal, exclude_relation_to: bool) -> Result<Option<JsVal>> {
  // `return where`: a `null` condition reads as "cannot match" to the callers
  if where_.is_null() {
    return Ok(None);
  }
  if !where_.truthy() || !where_.is_object_like() {
    return Ok(Some(where_.clone()));
  }

  let field_names: Vec<JsVal> = available_fields
    .as_arr()
    .ok_or_else(|| EngineError::new("TypeError", "availableFields.map is not a function"))?
    .iter()
    .map(|f| get(f, "name"))
    .collect();
  let has_field = |key: &str| field_names.iter().any(|name| is_str(name, key)) || (!exclude_relation_to && key == "relationTo");

  let mut filtered = indexmap::IndexMap::<String, JsVal>::new();
  for (key, value) in object_entries(where_)? {
    if key == "and" {
      if is_array(&value) {
        let mut conditions = Vec::new();
        for condition in value.items() {
          let Some(filtered_condition) = filter_where_for_collection(condition, available_fields, exclude_relation_to)? else {
            return Ok(None);
          };
          if crate::util::object_keys(&filtered_condition)?.len() > 0 {
            conditions.push(filtered_condition);
          }
        }
        if !conditions.is_empty() {
          set_key(&mut filtered, key, JsVal::arr(conditions));
        }
      }
    } else if key == "or" {
      if is_array(&value) {
        let mut conditions = Vec::new();
        for condition in value.items() {
          if let Some(filtered_condition) = filter_where_for_collection(condition, available_fields, exclude_relation_to)?
            && crate::util::object_keys(&filtered_condition)?.len() > 0
          {
            conditions.push(filtered_condition);
          }
        }
        if !conditions.is_empty() {
          set_key(&mut filtered, key, JsVal::arr(conditions));
        }
      }
    } else if key == "relationTo" && exclude_relation_to {
      continue;
    } else if has_field(&key) {
      set_key(&mut filtered, key, value);
    } else {
      return Ok(None);
    }
  }
  Ok(Some(JsVal::obj(filtered)))
}

/// `buildJoinProjection(baseFieldName, useDrafts, sort)`
fn build_join_projection(base_field_name: &str, use_drafts: bool, sort: &JsVal) -> Result<JsVal> {
  let mut projection = indexmap::IndexMap::<String, JsVal>::new();
  set_key(&mut projection, "_id".to_string(), num(1.0));
  set_key(&mut projection, base_field_name.to_string(), num(1.0));
  if use_drafts {
    set_key(&mut projection, "parent".to_string(), num(1.0));
  }
  for field_name in crate::util::object_keys(sort)? {
    set_key(&mut projection, field_name, num(1.0));
  }
  Ok(JsVal::obj(projection))
}

/// `getByPathWithArrays(doc, path)`
fn get_by_path_with_arrays(doc: &JsVal, path: &str) -> Vec<JsVal> {
  let segments: Vec<&str> = path.split('.').collect();
  let mut current = doc.clone();
  for (i, segment) in segments.iter().enumerate() {
    if current.is_nullish() {
      return Vec::new();
    }
    let value = get(&current, segment);
    if value.is_nullish() {
      return Vec::new();
    }
    if i == segments.len() - 1 {
      return if is_array(&value) { value.items().cloned().collect() } else { vec![value] };
    }
    if is_array(&value) {
      let remaining = segments[i + 1..].join(".");
      let mut results = Vec::new();
      for item in value.items() {
        if item.truthy() && item.is_object_like() {
          results.extend(get_by_path_with_arrays(item, &remaining));
        }
      }
      return results;
    }
    current = value;
  }
  Vec::new()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn filters_where_per_collection() {
    let fields = JsVal::arr(vec![obj([("name", s("title"))])]);
    let where_ = obj([("relationTo", obj([("equals", s("a"))])), ("title", obj([("equals", s("x"))]))]);
    let out = filter_where_for_collection(&where_, &fields, true).unwrap().unwrap();
    assert!(!crate::util::in_op("relationTo", &out) && crate::util::in_op("title", &out));
    let missing = obj([("other", obj([("equals", s("x"))]))]);
    assert!(filter_where_for_collection(&missing, &fields, true).unwrap().is_none());
  }

  #[test]
  fn reads_paths_through_arrays() {
    let doc = obj([("array", JsVal::arr(vec![obj([("rel", s("a"))]), obj([("rel", JsVal::arr(vec![s("b"), s("c")]))])]))]);
    let values = get_by_path_with_arrays(&doc, "array.rel");
    assert_eq!(values.iter().map(|v| v.to_js_string()).collect::<Vec<_>>(), vec!["a", "b", "c"]);
  }

  #[test]
  fn extracts_relation_to() {
    let where_ = obj([(
      "or",
      JsVal::arr(vec![obj([("relationTo", obj([("equals", s("a"))]))]), obj([("relationTo", obj([("in", JsVal::arr(vec![s("a"), s("b")]))]))])]),
    )]);
    let out = extract_relation_to_filter(&where_).unwrap().unwrap();
    assert_eq!(out.iter().map(|v| v.to_js_string()).collect::<Vec<_>>(), vec!["a", "b"]);
  }
}
