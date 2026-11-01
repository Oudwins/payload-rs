//! Port of `find/buildPolymorphicJoinQuery.ts`,
//! `find/createPolymorphicJoinWherePlan.ts` and
//! `find/buildPolymorphicJoinWhere.ts`.

use indexmap::{IndexMap, IndexSet};
use payload_engine::error::{EngineError, Result};
use payload_engine::js::{JsVal, Obj, num_to_json};
use payload_engine::strings::to_snake_case;
use serde_json::json;

use crate::args::Extra;
use crate::context::{
  ColumnRef, FindContext, JsonQueryArgs, OperatorConstraintArgs, SanitizeArgs, WhereColumn,
};
use crate::schema::Table;
use crate::sql::{self, Sql, escape_name};
use crate::utils::{get_field_by_path, js_for_in_entries, js_object_entries, js_object_keys_len};

fn error(message: impl Into<String>) -> EngineError {
  EngineError::new("Error", message)
}

/// `new QueryError([{ path }])`
pub fn query_error(path: &str) -> EngineError {
  EngineError::new("QueryError", format!("The following path cannot be queried: {path}"))
    .with_data(json!([{ "path": path }]))
}

fn is_uuid_type(id_type: &str) -> bool {
  id_type == "uuid" || id_type == "uuidv7"
}

// ---------------------------------------------------------------------------
// createPolymorphicJoinWherePlan
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub enum CollectionWhereField {
  Scalar { field: JsVal, is_localized: bool, is_uuid: bool },
  HasManySelect { field: JsVal },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WherePathType {
  HasManySelect,
  Invalid,
  Scalar,
}

#[derive(Clone, Debug)]
pub struct WherePathPlan {
  pub column_path: String,
  pub fields_by_collection: IndexMap<String, CollectionWhereField>,
  pub schema_path: String,
  pub kind: WherePathType,
}

pub type PolymorphicJoinWherePlan = IndexMap<String, WherePathPlan>;

struct CollectionContext<'a> {
  collection: String,
  collection_config: &'a JsVal,
  table: &'a Table,
  table_name: String,
}

/// `sanitizePathSegment` + join: `getColumnPath`.
fn get_column_path(schema_path: &str) -> Result<String> {
  schema_path
    .split('.')
    .map(|segment| {
      if !segment.is_empty() && segment.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        Ok(segment.to_string())
      } else {
        Err(
          EngineError::api("Invalid path segment. Only alphanumeric characters and underscores are permitted.")
            .with_data(json!({ "status": 400 })),
        )
      }
    })
    .collect::<Result<Vec<_>>>()
    .map(|s| s.join("_"))
}

fn get_where_schema_paths(where_: &JsVal, paths: &mut Vec<String>) {
  for (key, value) in js_for_in_entries(where_) {
    let upper = key.to_uppercase();
    if upper == "AND" || upper == "OR" {
      for nested in value.as_arr().into_iter().flatten() {
        get_where_schema_paths(nested, paths);
      }
    } else {
      paths.push(key);
    }
  }
}

fn path_has_separate_rows(fields: &JsVal, path: &str) -> bool {
  let segments: Vec<&str> = path.split('.').collect();
  (1..segments.len()).any(|i| {
    get_field_by_path(fields, &segments[..i].join("."), "")
      .is_some_and(|f| matches!(f.field.get("type").as_str(), Some("array" | "blocks")))
  })
}

fn path_has_unsupported_nested_container(fields: &JsVal, path: &str) -> bool {
  let segments: Vec<&str> = path.split('.').collect();
  for i in 1..segments.len() {
    let Some(parent) = get_field_by_path(fields, &segments[..i].join("."), "") else {
      return false;
    };
    if !matches!(parent.field.get("type").as_str(), Some("group" | "tab")) {
      return true;
    }
  }
  false
}

fn scalar_query_value_signature(sql_type: &str, field: &JsVal) -> String {
  let field_type = field.get("type").to_js_string();
  match field_type.as_str() {
    "select" | "radio" => {
      let values: Vec<serde_json::Value> = field
        .get("options")
        .items()
        .map(|o| match o {
          JsVal::Str(s) => serde_json::Value::String(s.to_string()),
          other => other.get("value").to_json(),
        })
        .collect();
      format!("{field_type}:{}", serde_json::Value::Array(values))
    }
    "code" | "email" | "slug" | "text" | "textarea" => "text".into(),
    _ => format!("{field_type}:{sql_type}"),
  }
}

fn collection_contexts<'a>(ctx: &'a FindContext<'_>, collections: &[String]) -> Result<Vec<CollectionContext<'a>>> {
  collections
    .iter()
    .map(|collection| {
      let collection_config = ctx.collections.get(collection).get("config");
      if !collection_config.truthy() {
        return Err(error(format!("Unknown polymorphic join collection \"{collection}\"")));
      }
      let table = ctx
        .table_name_map
        .get(&to_snake_case(collection))
        .and_then(|name| ctx.schema.tables.get(name))
        .ok_or_else(|| error(format!("Polymorphic join collection \"{collection}\" has no database table")))?;
      Ok(CollectionContext { collection: collection.clone(), collection_config, table, table_name: table.ts_name.clone() })
    })
    .collect()
}

/// `createPolymorphicJoinWherePlan()`
pub fn create_polymorphic_join_where_plan(
  ctx: &FindContext<'_>,
  collections: &[String],
  where_: &JsVal,
) -> Result<PolymorphicJoinWherePlan> {
  let contexts = collection_contexts(ctx, collections)?;
  let mut all_paths = Vec::new();
  get_where_schema_paths(where_, &mut all_paths);
  let schema_paths: IndexSet<String> = all_paths.into_iter().collect();

  let mut schema_paths_by_column_path: IndexMap<String, IndexSet<String>> = IndexMap::new();
  for schema_path in &schema_paths {
    schema_paths_by_column_path.entry(get_column_path(schema_path)?).or_default().insert(schema_path.clone());
  }

  let mut plan = PolymorphicJoinWherePlan::new();
  for schema_path in &schema_paths {
    let column_path = get_column_path(schema_path)?;
    let mut fields_by_collection = IndexMap::new();
    let mut is_field_present = schema_path == "id" || schema_path == "relationTo";
    let mut has_many_select = false;
    let mut has_unsupported_field_shape = false;
    let mut signatures: IndexSet<String> = IndexSet::new();

    for c in &contexts {
      let flattened = c.collection_config.get("flattenedFields");
      let field_at_path = get_field_by_path(flattened, schema_path, "");

      if schema_path == "id" {
        match c.table.columns.get("id") {
          None => has_unsupported_field_shape = true,
          Some(id_column) => {
            signatures.insert(format!("id:{}", id_column.sql_type));
            let uuid = is_uuid_type(&ctx.options.id_type);
            let field = match &field_at_path {
              Some(f) => f.field.clone(),
              None => {
                let mut o = Obj::new();
                o.insert("name".into(), JsVal::str("id"));
                o.insert("type".into(), JsVal::str(if uuid { "text" } else { "number" }));
                JsVal::obj(o)
              }
            };
            fields_by_collection.insert(
              c.collection.clone(),
              CollectionWhereField::Scalar { field, is_localized: false, is_uuid: field_at_path.is_none() && uuid },
            );
          }
        }
        continue;
      }

      let Some(field_at_path) = field_at_path else {
        if path_has_unsupported_nested_container(flattened, schema_path) {
          has_unsupported_field_shape = true;
        }
        continue;
      };
      is_field_present = true;

      if path_has_separate_rows(flattened, schema_path) {
        has_unsupported_field_shape = true;
        continue;
      }

      let field = &field_at_path.field;
      if field.get("type").as_str() == Some("select") && field.get("hasMany").truthy() {
        if field_at_path.path_has_localized {
          has_unsupported_field_shape = true;
          continue;
        }
        has_many_select = true;
        fields_by_collection.insert(c.collection.clone(), CollectionWhereField::HasManySelect { field: field.clone() });
        continue;
      }

      let field_table = if field_at_path.path_has_localized {
        ctx.schema.tables.get(&format!("{}{}", c.table_name, ctx.options.locales_suffix))
      } else {
        Some(c.table)
      };
      let Some(field_column) = field_table.and_then(|t| t.columns.get(&column_path)) else {
        has_unsupported_field_shape = true;
        continue;
      };
      fields_by_collection.insert(
        c.collection.clone(),
        CollectionWhereField::Scalar {
          field: field.clone(),
          is_localized: field_at_path.path_has_localized,
          // `fieldColumn.columnType === 'PgUUID'` is never true on SQLite.
          is_uuid: false,
        },
      );
      signatures.insert(scalar_query_value_signature(&field_column.sql_type, field));
    }

    let has_collision = schema_paths_by_column_path.get(&column_path).map_or(0, |s| s.len()) > 1;
    let is_invalid = has_collision
      || !is_field_present
      || has_unsupported_field_shape
      || (has_many_select && !signatures.is_empty())
      || signatures.len() > 1;
    plan.insert(
      schema_path.clone(),
      WherePathPlan {
        column_path,
        fields_by_collection,
        schema_path: schema_path.clone(),
        kind: if is_invalid {
          WherePathType::Invalid
        } else if has_many_select {
          WherePathType::HasManySelect
        } else {
          WherePathType::Scalar
        },
      },
    );
  }
  Ok(plan)
}

// ---------------------------------------------------------------------------
// buildPolymorphicJoinWhere
// ---------------------------------------------------------------------------

const SUPPORTED_JSON_QUERY_OPERATORS: [&str; 5] = ["contains", "equals", "exists", "in", "like"];

enum ResolvedWherePath<'p> {
  Scalar { column: WhereColumn, field_context: Option<JsVal>, query_value_field: JsVal, query_value_is_uuid: bool },
  HasManySelect { field_context: JsVal, json_expression: String, plan: &'p WherePathPlan },
  Invalid,
}

fn resolve_where_path<'p>(
  ctx: &FindContext<'_>,
  collection: &str,
  schema_path: &str,
  table: &Table,
  plan: &'p PolymorphicJoinWherePlan,
) -> Result<ResolvedWherePath<'p>> {
  let path_plan = plan.get(schema_path).ok_or_else(|| query_error(schema_path))?;
  if path_plan.kind == WherePathType::Invalid {
    return Ok(ResolvedWherePath::Invalid);
  }
  if schema_path == "relationTo" {
    let mut field = Obj::new();
    field.insert("name".into(), JsVal::str("relationTo"));
    field.insert("type".into(), JsVal::str("text"));
    return Ok(ResolvedWherePath::Scalar {
      column: WhereColumn::Param(collection.to_string()),
      field_context: None,
      query_value_field: JsVal::obj(field),
      query_value_is_uuid: false,
    });
  }
  if path_plan.kind == WherePathType::HasManySelect {
    let field_context = path_plan.fields_by_collection.values().find_map(|f| match f {
      CollectionWhereField::HasManySelect { field } => Some(field.clone()),
      CollectionWhereField::Scalar { .. } => None,
    });
    let Some(field_context) = field_context else {
      return Ok(ResolvedWherePath::Invalid);
    };
    return Ok(ResolvedWherePath::HasManySelect {
      field_context,
      json_expression: has_many_select_expression(ctx, collection, path_plan, table)?,
      plan: path_plan,
    });
  }

  let field_context = match path_plan.fields_by_collection.get(collection) {
    Some(CollectionWhereField::Scalar { field, is_localized, is_uuid }) => Some((field.clone(), *is_localized, *is_uuid)),
    _ => None,
  };
  let query_value = field_context.clone().or_else(|| {
    path_plan.fields_by_collection.values().find_map(|f| match f {
      CollectionWhereField::Scalar { field, is_localized, is_uuid } => Some((field.clone(), *is_localized, *is_uuid)),
      CollectionWhereField::HasManySelect { .. } => None,
    })
  });
  let Some((query_value_field, _, query_value_is_uuid)) = query_value else {
    return Ok(ResolvedWherePath::Invalid);
  };
  let column = match &field_context {
    Some((_, is_localized, _)) => {
      let column_table = if *is_localized {
        ctx
          .schema
          .tables
          .get(&format!("{}{}", table.db_name, ctx.options.locales_suffix))
          .ok_or_else(|| EngineError::new("TypeError", "Cannot read properties of undefined (reading columnPath)"))?
      } else {
        table
      };
      match column_table.columns.get(&path_plan.column_path) {
        Some(c) => {
          WhereColumn::Column(ColumnRef { table: column_table.db_name.clone(), name: c.name.clone(), primary: false })
        }
        None => return Err(EngineError::new("TypeError", "Cannot read properties of undefined (reading 'name')")),
      }
    }
    None => WhereColumn::Null,
  };
  Ok(ResolvedWherePath::Scalar {
    column,
    field_context: field_context.map(|(f, _, _)| f),
    query_value_field,
    query_value_is_uuid,
  })
}

fn has_many_select_expression(
  ctx: &FindContext<'_>,
  collection: &str,
  plan: &WherePathPlan,
  table: &Table,
) -> Result<String> {
  if !matches!(plan.fields_by_collection.get(collection), Some(CollectionWhereField::HasManySelect { .. })) {
    return Ok("'[]'".into());
  }
  let select_table_path = plan.schema_path.split('.').map(to_snake_case).collect::<Vec<_>>().join("_");
  let values_table = ctx
    .table_name_map
    .get(&format!("{}_{select_table_path}", to_snake_case(collection)))
    .ok_or_else(|| {
      error(format!("Polymorphic join collection \"{collection}\" has no value table for \"{}\"", plan.schema_path))
    })?;
  let parent = &table.db_name;
  Ok(format!(
    "(select json_group_array({values_table}.value) from {values_table} where {values_table}.parent_id = {parent}.id)"
  ))
}

/// `buildPolymorphicJoinWhere()`
pub fn build_polymorphic_join_where(
  ctx: &FindContext<'_>,
  collection: &str,
  locale: Option<&str>,
  table: &Table,
  where_: &JsVal,
  plan: &PolymorphicJoinWherePlan,
) -> Result<Option<Sql>> {
  let mut constraints: Vec<Sql> = Vec::new();
  for (key, value) in js_for_in_entries(where_) {
    let key = key.as_str();
    let upper = key.to_uppercase();
    if upper == "AND" || upper == "OR" {
      let nested = value.as_arr().ok_or_else(|| query_error(key))?;
      let nested = nested
        .iter()
        .map(|w| build_polymorphic_join_where(ctx, collection, locale, table, w, plan))
        .collect::<Result<Vec<_>>>()?;
      let combined = if upper == "AND" { sql::and(nested) } else { sql::or(nested) };
      if let Some(c) = combined {
        constraints.push(c);
      }
      continue;
    }

    let resolved = resolve_where_path(ctx, collection, key, table, plan)?;
    for (operator, op_value) in js_object_entries(&value)? {
      let op_value = &op_value;
      let original_operator = operator.as_str();
      let mut payload_operator = operator.clone();
      let error_path = format!("{key}.{original_operator}");

      match &resolved {
        ResolvedWherePath::Invalid => return Err(query_error(&error_path)),
        ResolvedWherePath::HasManySelect { field_context, json_expression, plan: path_plan } => {
          if !SUPPORTED_JSON_QUERY_OPERATORS.contains(&payload_operator.as_str()) {
            return Err(query_error(&error_path));
          }
          let sanitized = ctx
            .query
            .sanitize_query_value(&SanitizeArgs {
              field: field_context,
              is_uuid: false,
              operator: &payload_operator,
              relation_or_path: key,
              val: op_value,
            })?
            .ok_or_else(|| query_error(&error_path))?;
          if sanitized.has_columns {
            return Err(query_error(&error_path));
          }
          let value = sanitized.value;
          if payload_operator == "in" && value.as_arr().is_some_and(|a| a.is_empty()) {
            constraints.push(Sql::raw("false"));
            continue;
          }
          let json_operator = if payload_operator == "exists" { "exists".to_string() } else { sanitized.operator };
          constraints.push(Sql::raw(ctx.query.create_json_query(&JsonQueryArgs {
            column: json_expression,
            operator: &json_operator,
            path_segments: vec![path_plan.column_path.clone()],
            value: &value,
          })?));
          continue;
        }
        ResolvedWherePath::Scalar { column, field_context, query_value_field, query_value_is_uuid } => {
          if payload_operator == "$raw" {
            match op_value {
              JsVal::Str(raw) => constraints.push(Sql::raw(raw.to_string())),
              _ => return Err(query_error(&error_path)),
            }
            continue;
          }
          if payload_operator == "like"
            && (matches!(query_value_field.get("type").as_str(), Some("number" | "relationship" | "upload"))
              || *query_value_is_uuid)
          {
            payload_operator = "equals".into();
          }
          let sanitized = ctx
            .query
            .sanitize_query_value(&SanitizeArgs {
              field: query_value_field,
              is_uuid: *query_value_is_uuid,
              operator: &payload_operator,
              relation_or_path: key,
              val: op_value,
            })?
            .ok_or_else(|| query_error(&error_path))?;
          if sanitized.has_columns {
            return Err(query_error(&error_path));
          }
          payload_operator = sanitized.operator;
          let value = sanitized.value;
          if !ctx.query.has_operator(&payload_operator) {
            return Err(query_error(&error_path));
          }
          let column_sql = column.to_sql();
          let build = |v: &JsVal| -> Result<Sql> {
            ctx.query.operator_constraint(&OperatorConstraintArgs {
              column,
              field: field_context.as_ref(),
              locale,
              original_operator,
              path: key,
              resolved_operator: &payload_operator,
              value: v,
            })
          };

          if original_operator == "equals" && value.is_null() {
            constraints.push(sql::is_null(&column_sql));
            continue;
          }
          if original_operator == "not_equals" {
            if value.is_null() {
              constraints.push(sql::is_not_null(&column_sql));
            } else if let Some(c) = sql::or([Some(sql::is_null(&column_sql)), Some(build(&value)?)]) {
              constraints.push(c);
            }
            continue;
          }
          if original_operator == "in"
            && let Some(items) = value.as_arr()
            && items.iter().any(|i| i.is_null())
          {
            let non_null = JsVal::arr(items.iter().filter(|i| !i.is_null()).cloned().collect());
            if let Some(c) = sql::or([Some(sql::is_null(&column_sql)), Some(build(&non_null)?)]) {
              constraints.push(c);
            }
            continue;
          }
          if payload_operator == "like"
            && let Some(text) = value.as_str()
          {
            let words =
              text.split(' ').map(|word| build(&JsVal::str(format!("%{word}%"))).map(Some)).collect::<Result<Vec<_>>>()?;
            if let Some(c) = sql::and(words) {
              constraints.push(c);
            }
            continue;
          }
          constraints.push(build(&value)?);
        }
      }
    }
  }
  Ok(sql::and(constraints.into_iter().map(Some)))
}

// ---------------------------------------------------------------------------
// buildPolymorphicJoinQuery
// ---------------------------------------------------------------------------

pub(crate) struct PolymorphicJoinArgs<'a> {
  pub current_table_name: &'a str,
  pub field: &'a JsVal,
  pub limit: f64,
  pub locale: Option<&'a str>,
  pub page: &'a JsVal,
  /// `undefined` defaults to `limit`.
  pub page_size: Option<f64>,
  pub path: &'a str,
  pub should_count: bool,
  pub sort: &'a JsVal,
  pub where_: &'a JsVal,
}

fn get_sort_field(ctx: &FindContext<'_>, collections: &[String], sort: &JsVal) -> String {
  if sort.truthy() {
    return sort.to_js_string();
  }
  let has_created_at = collections.iter().any(|c| {
    ctx
      .collections
      .get(c)
      .get("config")
      .get("fields")
      .items()
      .any(|f| f.get("type").as_str() == Some("date") && f.get("name").as_str() == Some("createdAt"))
  });
  if has_created_at { "-createdAt".into() } else { "id".into() }
}

/// `buildPolymorphicJoinQuery()`: returns `[(columnName, documents), (columnName_count, count)?]`.
pub(crate) fn build_polymorphic_join_query(
  ctx: &FindContext<'_>,
  a: &PolymorphicJoinArgs<'_>,
) -> Result<Vec<(String, Extra)>> {
  let field = a.field;
  let collections: Vec<String> = field
    .get("collection")
    .as_arr()
    .ok_or_else(|| error("A polymorphic join requires a collection array"))?
    .iter()
    .map(JsVal::to_js_string)
    .collect();
  if collections.is_empty() {
    return Err(error("A polymorphic join requires at least one collection"));
  }
  if a.sort.as_arr().is_some() {
    return Err(error("Polymorphic joins do not support multiple sort fields"));
  }
  let column_name = format!("{}{}", a.path.replace('.', "_"), field.get("name").to_js_string());
  let on_path = field.get("on").to_js_string().split('.').collect::<Vec<_>>().join("_");

  let mut collection_tables = Vec::new();
  for collection in &collections {
    if !ctx.collections.get(collection).truthy() {
      return Err(error(format!("Unknown polymorphic join collection \"{collection}\"")));
    }
    let table = ctx
      .table_name_map
      .get(&to_snake_case(collection))
      .and_then(|n| ctx.schema.tables.get(n))
      .ok_or_else(|| error(format!("Polymorphic join collection \"{collection}\" has no database table")))?;
    if !table.columns.contains_key("id") {
      return Err(error(format!("Polymorphic join collection \"{collection}\" has no \"id\" column")));
    }
    if !table.columns.contains_key(&on_path) {
      return Err(error(format!("Polymorphic join collection \"{collection}\" has no \"{on_path}\" column")));
    }
    collection_tables.push((collection.clone(), table));
  }

  let sort_field = get_sort_field(ctx, &collections, a.sort);
  let sort_desc = sort_field.starts_with('-');
  let sort_path = sort_field.replacen('-', "", 1).split('.').collect::<Vec<_>>().join("_");
  let where_truthy = a.where_.truthy();
  let plan = if where_truthy {
    create_polymorphic_join_where_plan(ctx, &collections, a.where_)?
  } else {
    PolymorphicJoinWherePlan::new()
  };

  let mut selects: Vec<Sql> = Vec::new();
  for (collection, table) in &collection_tables {
    let collection_where = if where_truthy && js_object_keys_len(a.where_) > 0 {
      build_polymorphic_join_where(ctx, collection, a.locale, table, a.where_, &plan)?
    } else {
      None
    };
    let has_localized_where = plan.values().any(|p| {
      matches!(p.fields_by_collection.get(collection), Some(CollectionWhereField::Scalar { is_localized: true, .. }))
    });
    let should_deduplicate = has_localized_where && a.locale.is_none_or(|l| l == "all");

    let single_table = !has_localized_where;
    let col = |key: &str| -> Sql {
      let name = &table.columns[key].name;
      if single_table { Sql::ident(name) } else { Sql::column(&table.db_name, name) }
    };
    let mut select = Sql::raw(if should_deduplicate { "select distinct " } else { "select " });
    select.push(&col("id")).push_str(", ");
    select.push(&col(&on_path)).push_str(" as ").push(&Sql::ident(&on_path)).push_str(", ");
    select.push_param(serde_json::Value::String(collection.clone())).push_str(" as \"relationTo\", ");
    match table.columns.get(&sort_path) {
      Some(_) => select.push(&col(&sort_path)),
      None => select.push_param(serde_json::Value::Null),
    };
    select.push_str(" as \"sortPath\" from ").push(&Sql::ident(&table.db_name));

    if has_localized_where {
      let locales_table = ctx
        .schema
        .tables
        .get(&format!("{}{}", table.db_name, ctx.options.locales_suffix))
        .ok_or_else(|| EngineError::new("TypeError", "Cannot read properties of undefined (reading '_parentID')"))?;
      let locale_col = |key: &str| -> Result<Sql> {
        locales_table
          .columns
          .get(key)
          .map(|c| Sql::column(&locales_table.db_name, &c.name))
          .ok_or_else(|| EngineError::new("TypeError", format!("Cannot read properties of undefined ({key})")))
      };
      let condition = sql::and([
        Some(sql::eq(&Sql::column(&table.db_name, &table.columns["id"].name), &locale_col("_parentID")?)),
        match a.locale {
          Some(l) if l != "all" => {
            Some(sql::eq(&locale_col("_locale")?, &Sql::param(serde_json::Value::String(l.to_string()))))
          }
          _ => None,
        },
      ]);
      select.push_str(" left join ").push(&Sql::ident(&locales_table.db_name));
      if let Some(c) = condition {
        select.push_str(" on ").push(&c);
      }
    }
    if let Some(w) = collection_where {
      select.push_str(" where ").push(&w);
    }
    selects.push(select);
  }

  let union = Sql::join(selects.iter(), " union all ");
  let sub_query_alias = format!("{column_name}_subquery");

  let mut out = Vec::new();
  let mut documents = Sql::raw("(\n    SELECT ");
  documents.push_str(&format!(
    "coalesce(json_group_array(json_object('id',\"{sub_query_alias}\".\"id\",'relationTo',\"{sub_query_alias}\".\"relationTo\")), '[]')"
  ));
  documents.push_str("\n    FROM (\n      SELECT * FROM (").push(&union);
  documents.push_str(if sort_desc { " order by \"sortPath\" desc" } else { " order by \"sortPath\" asc" });
  let sorted_alias = format!("{column_name}_sorted");
  documents.push_str(") ").push_str(&escape_name(&sorted_alias));
  documents.push_str(&format!("\n      WHERE \"{sorted_alias}\".\"{on_path}\" = \"{}\".\"id\"", a.current_table_name));
  if a.limit != 0.0 && !a.limit.is_nan() {
    documents.push_str(" LIMIT ").push_param(num_to_json(a.limit));
  }
  if a.page.truthy() && a.limit != 0.0 {
    let page = a.page.as_num().unwrap_or(f64::NAN);
    let offset = (page - 1.0) * a.page_size.unwrap_or(a.limit);
    if offset > 0.0 {
      documents.push_str(" OFFSET ").push_param(num_to_json(offset));
    }
  }
  documents.push_str(&format!("\n    ) AS \"{sub_query_alias}\"\n  )"));
  out.push((column_name.clone(), Extra { sql: documents, alias: column_name.clone() }));

  if a.should_count {
    let mut count = Sql::raw("(select count(*) from (");
    count.push(&union).push_str(") ").push_str(&escape_name(&sub_query_alias));
    count.push_str(&format!(
      " where \"{}\".\"id\" = \"{sub_query_alias}\".\"{on_path}\")",
      a.current_table_name
    ));
    out.push((format!("{column_name}_count"), Extra { sql: count, alias: format!("{column_name}_count") }));
  }
  Ok(out)
}
