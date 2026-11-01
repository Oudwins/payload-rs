//! Port of `queries/parseParams.ts` (with `prefixJoinContainsWhere` and
//! `buildHasManyRelationshipCondition`) and `queries/buildAndOrConditions.ts`.

use payload_engine::error::{EngineError, Result};
use payload_engine::js::JsVal;
use payload_engine::strings::to_snake_case;
use serde_json::json;

use crate::adapter::{QueryAdapter, read_undefined, type_error};
use crate::columns::{ColumnArgs, SelectFields, get_table_column_from_path, locale_val, opt_operand};
use crate::js_ops::{js_string, replace_double_underscore};
use crate::json_query::{CreateJsonQueryArgs, convert_path_to_json_traversal, create_json_query, escape_sql_value};
use crate::operators::{OperatorConstraintArgs, apply_operator, build_operator_constraint};
use crate::paths::{field_type, get_field_by_path, resolve_relationship_path};
use crate::sanitize::{SanitizeArgs, sanitize_query_value};
use crate::sql::{self, Chunk, Expr, Join, Operand, Select, Sql, TableRef};
use crate::where_val::WhereVal;

/// `QueryContext`
#[derive(Clone, Debug, Default)]
pub struct QueryContext {
  pub raw_sort: Option<Sql>,
  pub sort: JsVal,
}

/// Arguments of `parseParams` (minus `adapter`, `context`, `joins` and `selectFields`).
#[derive(Clone, Debug)]
pub struct ParseArgs<'w> {
  pub alias_table: Option<TableRef>,
  pub fields: JsVal,
  pub locale: Option<String>,
  pub parent_is_localized: bool,
  pub select_locale: bool,
  pub table_name: String,
  pub where_: &'w WhereVal,
}

pub(crate) fn query_error(path: &str) -> EngineError {
  EngineError::new("QueryError", format!("The following path cannot be queried: {path}"))
    .with_data(json!({ "status": 400, "data": [{ "path": path }] }))
}

const VALID_OPERATORS: &[&str] = &[
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

/// `buildAndOrConditions(args)`
pub fn build_and_or_conditions(
  adapter: &QueryAdapter,
  args: &ParseArgs,
  conditions: &[WhereVal],
  context: &mut QueryContext,
  joins: &mut Vec<Join>,
  select_fields: &mut SelectFields,
) -> Result<Vec<Sql>> {
  let mut completed = Vec::new();
  for condition in conditions {
    if condition.is_typeof_object() {
      let result = parse_params(adapter, ParseArgs { where_: condition, ..args.clone() }, context, joins, select_fields)?;
      if let Some(result) = result {
        completed.push(result);
      }
    }
  }
  Ok(completed)
}

fn not_in_or_null(column: Option<&Expr>, value: &JsVal) -> Sql {
  let col = || column.map(|c| Chunk::Sql(sql::expr_sql(c))).unwrap_or(Chunk::Undefined);
  Sql::new(vec![
    Chunk::Str("(".into()),
    Chunk::Sql(sql::not_in_array(column, value.clone())),
    Chunk::Str(" OR\n                    ".into()),
    col(),
    Chunk::Str("\n                    IS\n                    NULL)".into()),
  ])
}

/// `isValidStringID(value)`
fn is_valid_string_id(s: &str) -> bool {
  !s.is_empty() && s.chars().all(|c| crate::js_ops::is_word_char(c) || c == '-')
}

/// `parseParams(args)`; `Ok(None)` mirrors `undefined`.
pub fn parse_params(
  adapter: &QueryAdapter,
  args: ParseArgs,
  context: &mut QueryContext,
  joins: &mut Vec<Join>,
  select_fields: &mut SelectFields,
) -> Result<Option<Sql>> {
  let where_ = args.where_;
  let mut result: Option<Sql> = None;
  let mut constraints: Vec<Option<Sql>> = Vec::new();

  if where_.is_typeof_object() && !where_.entries()?.is_empty() {
    for (relation_or_path, condition) in where_.entries()? {
      if relation_or_path.is_empty() {
        continue;
      }
      let lower = relation_or_path.to_lowercase();
      let is_and = lower == "and";
      let is_or = lower == "or";

      if let Some(items) = condition.as_items() {
        let built = build_and_or_conditions(adapter, &args, &items, context, joins, select_fields)?;
        if !built.is_empty() {
          let built = built.into_iter().map(Some).collect();
          result = if is_and {
            sql::and(built)
          } else if is_or {
            sql::or(built)
          } else {
            return Err(type_error("conditionOperator is not a function"));
          };
        }
        continue;
      }

      let path_operators = condition;
      if !path_operators.is_typeof_object() {
        continue;
      }
      for (operator_key, val) in path_operators.entries()? {
        if !VALID_OPERATORS.contains(&operator_key.as_str()) {
          continue;
        }
        let mut operator = operator_key.clone();
        let dotted_path = replace_double_underscore(&relation_or_path);

        if matches!(operator.as_str(), "contains" | "not_equals" | "equals")
          && val.is_plain_object()
          && !val.is_raw_constraint()
        {
          let relationship_path =
            resolve_relationship_path(adapter, &args.fields, args.locale.clone(), args.parent_is_localized, &dotted_path, "")?;
          if let Some(rp) = &relationship_path {
            if rp.field.get("hasMany").truthy() && rp.field.get("relationTo").as_str().is_some() {
              constraints.push(Some(build_has_many_relationship_condition(
                adapter,
                &args,
                &operator,
                &relation_or_path,
                &val,
              )?));
              continue;
            }
          }
          if operator == "contains" && relationship_path.is_none() {
            let join_field = get_field_by_path(&args.fields, &dotted_path);
            if join_field.is_some_and(|f| field_type(f) == "join") {
              let prefixed = prefix_join_contains_where(&relation_or_path, &val)?;
              let parsed = parse_params(adapter, ParseArgs { where_: &prefixed, ..args.clone() }, context, joins, select_fields)?;
              constraints.push(parsed);
              continue;
            }
          }
        }

        let mut column_args = ColumnArgs::new(
          &relation_or_path,
          args.fields.clone(),
          &args.table_name,
          dotted_path.split('.').map(str::to_string).collect(),
          val.clone(),
        );
        column_args.alias_table = args.alias_table.clone();
        column_args.locale = args.locale.clone();
        column_args.parent_is_localized = args.parent_is_localized;
        column_args.select_locale = args.select_locale;
        let tc = get_table_column_from_path(adapter, column_args, joins, select_fields)?;
        // Plain-data view of the value for shape checks; internal values stay typed in `val`.
        let view = val.view();
        let field = tc.field.clone();
        let ftype = field_type(&field).to_string();
        let column_name = tc.column_name.clone();
        let table = tc.table.clone();

        // `table[columnName]`
        let table_col = |key: Option<&str>| -> Result<Option<Expr>> {
          let t = table.as_ref().ok_or_else(|| read_undefined(key.unwrap_or("undefined")))?;
          Ok(key.and_then(|k| adapter.col(t, k)))
        };

        let resolved_column: Option<Expr> = match &tc.raw_column {
          Some(raw) => Some(Expr::Sql(raw.clone())),
          None => match &args.alias_table {
            Some(alias) => {
              let t = table.as_ref().ok_or_else(|| read_undefined("Symbol(drizzle:Name)"))?;
              if args.table_name == t.ref_name() {
                column_name.as_deref().and_then(|k| adapter.col(alias, k))
              } else {
                table_col(column_name.as_deref())?
              }
            }
            None => table_col(column_name.as_deref())?,
          },
        };

        if val.is_distinct() {
          select_fields.insert("_selected".into(), resolved_column);
          break;
        }

        for c in tc.constraints.borrow().iter() {
          let col = adapter.col(&c.table, &c.column_name);
          if c.value.as_str().is_some_and(|s| s.contains('%')) {
            constraints.push(Some(apply_operator("like", col.as_ref(), Operand::Val(c.value.clone()))?));
          } else {
            constraints.push(Some(apply_operator("equals", col.as_ref(), Operand::Val(c.value.clone()))?));
          }
        }

        let path_segments = tc.path_segments.clone();
        if (matches!(ftype.as_str(), "json" | "richText") || (ftype == "blocks" && adapter.opts.blocks_as_json))
          && path_segments.as_ref().is_some_and(|p| p.len() > 1)
        {
          let path_segments = path_segments.unwrap_or_default();
          let column = table_col(column_name.as_deref())?;
          let column_sql_name = match &column {
            Some(Expr::Col(c)) => c.name.clone(),
            _ => return Err(read_undefined("name")),
          };
          let mut segments: Vec<String> = path_segments[1..].to_vec();
          segments.insert(0, column_sql_name.clone());

          if ftype == "richText" {
            let json_table =
              if joins.is_empty() { args.table_name.clone() } else { joins[joins.len() - 1].table.ref_name().to_string() };
            let json_query = create_json_query(CreateJsonQueryArgs {
              column: None,
              operator: &operator,
              path_segments: segments,
              table: Some(json_table),
              treat_as_array: Some(vec!["children".into()]),
              treat_root_as_array: true,
              value: view.clone(),
            })?;
            constraints.push(Some(Sql::raw(json_query)));
            break;
          }

          let json_query = convert_path_to_json_traversal(&path_segments)?;
          let operator_keys = |op: &str| -> Option<(&'static str, &'static str)> {
            Some(match op {
              "contains" => ("like", "%"),
              "equals" => ("=", ""),
              "exists" => (if matches!(view, JsVal::Bool(true)) { "is not null" } else { "is null" }, ""),
              "in" => ("in", ""),
              "like" => ("like", "%"),
              "not_equals" => ("<>", ""),
              "not_in" => ("not in", ""),
              "not_like" => ("not like", "%"),
              _ => return None,
            })
          };
          let missing = || type_error(format!("Cannot read properties of undefined (reading '{}')", "wildcard"));

          let mut formatted_value: String;
          if operator == "equals" && matches!(view, JsVal::Num(_) | JsVal::Bool(_)) {
            formatted_value = js_string(&view);
          } else if (operator == "in" || operator == "not_in") && view.as_arr().is_some() {
            let mut parts = Vec::new();
            for v in view.items() {
              let escaped = escape_sql_value(v)?;
              let escaped = crate::js_ops::js_string_checked(&escaped)?;
              parts.push(if v.as_str().is_some() { format!("'{escaped}'") } else { escaped });
            }
            formatted_value = format!("({})", parts.join(","));
          } else {
            let (_, wildcard) = operator_keys(&operator).ok_or_else(missing)?;
            formatted_value = format!("'{wildcard}{}{wildcard}'", crate::js_ops::js_string_checked(&escape_sql_value(&view)?)?);
          }
          if operator == "exists" {
            formatted_value = String::new();
          }
          let mut selector = format!("{column_sql_name}{json_query}");
          if operator == "not_like" {
            selector = format!("COALESCE({column_sql_name}{json_query}, '')");
          }
          let (sql_operator, _) = operator_keys(&operator).ok_or_else(missing)?;
          constraints.push(Some(Sql::raw(format!("{selector} {sql_operator} {formatted_value}"))));
          break;
        }

        if let Some(not_null) = &tc.get_not_null_column_by_value {
          match not_null.get(&view) {
            Some(col_name) => {
              let col = table_col(Some(&col_name))?;
              constraints.push(Some(sql::is_not_null(col.as_ref())));
            }
            None => return Err(query_error(&relation_or_path)),
          }
          break;
        }

        if operator == "like" {
          let convert = matches!(ftype.as_str(), "number" | "relationship" | "upload") || {
            // `table[columnName].columnType === 'PgUUID'`
            if table_col(column_name.as_deref())?.is_none() {
              return Err(read_undefined("columnType"));
            }
            false
          };
          if convert {
            operator = "equals".into();
          }
        }

        if operator == "like" {
          let Some(s) = view.as_str() else {
            return Err(match view {
              JsVal::Null => type_error("Cannot read properties of null (reading 'split')"),
              JsVal::Undefined => read_undefined("split"),
              _ => type_error("val.split is not a function"),
            });
          };
          let column = table_col(column_name.as_deref())?;
          let mut words = Vec::new();
          for word in s.split(' ') {
            words.push(Some(build_operator_constraint(
              adapter,
              OperatorConstraintArgs {
                column: column.clone(),
                field: &field,
                path: &relation_or_path,
                resolved_operator: "like",
                value: Operand::Val(JsVal::str(format!("%{word}%"))),
              },
            )?));
          }
          constraints.push(sql::and(words));
          break;
        }

        let sanitized = sanitize_query_value(
          adapter,
          SanitizeArgs {
            columns: tc.columns.as_deref(),
            field: &field,
            is_uuid: false,
            operator: &operator,
            relation_or_path: &relation_or_path,
            val: &val,
          },
        )?;
        let Some(sanitized) = sanitized else {
          break;
        };
        let query_operator = sanitized.operator.clone();
        let query_operand = sanitized.value.clone();
        // `queryValue` when it is plain data; a raw constraint's SQL is never `null` or an array.
        let query_value = match &query_operand {
          Operand::Val(v) => v.clone(),
          Operand::Expr(_) => JsVal::obj(Default::default()),
        };

        if let Some(query_columns) = &sanitized.columns {
          if query_columns.is_empty() {
            break;
          }
          if query_value.is_null() && (operator == "equals" || operator == "not_equals") {
            let items = query_columns
              .iter()
              .map(|c| {
                let e = Expr::Sql(c.raw_column.clone());
                Some(if operator == "equals" { sql::is_null(Some(&e)) } else { sql::is_not_null(Some(&e)) })
              })
              .collect();
            constraints.push(if operator == "equals" { sql::and(items) } else { sql::or(items) });
            break;
          }
          let use_and = operator == "not_equals" || operator == "not_in";
          let mut items = Vec::new();
          for c in query_columns {
            items.push(Some(build_operator_constraint(
              adapter,
              OperatorConstraintArgs {
                column: Some(Expr::Sql(c.raw_column.clone())),
                field: &field,
                path: &relation_or_path,
                resolved_operator: &query_operator,
                value: Operand::Val(c.value.clone()),
              },
            )?));
          }
          constraints.push(if use_and { sql::and(items) } else { sql::or(items) });
          break;
        }

        if query_operator == "not_equals" && !query_value.is_null() {
          let c = build_operator_constraint(
            adapter,
            OperatorConstraintArgs {
              column: resolved_column.clone(),
              field: &field,
              path: &relation_or_path,
              resolved_operator: "not_equals",
              value: query_operand.clone(),
            },
          )?;
          constraints.push(sql::or(vec![Some(sql::is_null(resolved_column.as_ref())), Some(c)]));
          break;
        }

        if matches!(ftype.as_str(), "relationship" | "upload") && query_value.as_arr().is_some() && query_operator == "not_in" {
          let col = table_col(column_name.as_deref())?;
          constraints.push(Some(not_in_or_null(col.as_ref(), &query_value)));
          break;
        }

        if operator == "equals" && query_value.is_null() {
          constraints.push(Some(sql::is_null(resolved_column.as_ref())));
          break;
        }

        if operator == "not_equals" && query_value.is_null() {
          constraints.push(Some(sql::is_not_null(resolved_column.as_ref())));
          break;
        }

        let mut or_conditions: Vec<Option<Sql>> = Vec::new();
        let mut resolved_query_value = query_operand.clone();
        if operator == "in" {
          if let Some(items) = query_value.as_arr() {
            if items.iter().any(JsVal::is_null) {
              or_conditions.push(Some(sql::is_null(resolved_column.as_ref())));
              resolved_query_value = Operand::Val(JsVal::arr(items.iter().filter(|v| !v.is_null()).cloned().collect()));
            }
          }
        }

        if operator == "contains"
          && query_value.as_arr().is_some()
          && field.has("hasMany")
          && field.get("hasMany").truthy()
          && matches!(ftype.as_str(), "number" | "select" | "text")
        {
          for v in query_value.items() {
            or_conditions.push(Some(build_operator_constraint(
              adapter,
              OperatorConstraintArgs {
                column: resolved_column.clone(),
                field: &field,
                path: &relation_or_path,
                resolved_operator: &query_operator,
                value: Operand::Val(v.clone()),
              },
            )?));
          }
          if !or_conditions.is_empty() {
            if let Some(c) = sql::or(or_conditions) {
              constraints.push(Some(c));
            }
          }
          break;
        }

        let mut constraint = build_operator_constraint(
          adapter,
          OperatorConstraintArgs {
            column: resolved_column.clone(),
            field: &field,
            path: &relation_or_path,
            resolved_operator: &query_operator,
            value: resolved_query_value,
          },
        )?;

        if adapter.opts.limited_bound_parameters
          && (operator == "in" || operator == "not_in")
          && relation_or_path == "id"
          && query_value.as_arr().is_some()
        {
          let items = query_value.as_arr().unwrap_or(&[]);
          let invalid = items.iter().any(|v| match v {
            JsVal::Num(_) | JsVal::Null => false,
            JsVal::Str(s) => !is_valid_string_id(s),
            _ => true,
          });
          if invalid {
            let json = crate::js_ops::json_stringify(&query_value).unwrap_or_default();
            return Err(EngineError::api(format!("Invalid ID value in {json}")));
          }
          // `getTableName(resolvedColumn.table)`
          let col = match &resolved_column {
            Some(Expr::Col(c)) => c.clone(),
            Some(Expr::Sql(_)) => return Err(read_undefined("Symbol(drizzle:Name)")),
            None => return Err(read_undefined("table")),
          };
          let list: Vec<String> = items
            .iter()
            .map(|e| match e {
              JsVal::Null => "NULL".to_string(),
              JsVal::Num(_) => js_string(e),
              other => format!("'{}'", js_string(other)),
            })
            .collect();
          constraints.push(Some(Sql::raw(format!(
            "\"{}\".\"{}\" {} ({})",
            col.table.ref_name(),
            col.name,
            if operator == "in" { "IN" } else { "NOT IN" },
            list.join(",")
          ))));
          break;
        }

        if !or_conditions.is_empty() {
          or_conditions.push(Some(constraint));
          constraint = sql::or(or_conditions).unwrap_or_default();
        }
        constraints.push(Some(constraint));
      }
    }
  }

  let n = constraints.len();
  if n > 0 {
    result = match result {
      Some(r) => {
        let mut all = vec![Some(r)];
        all.extend(constraints.iter().cloned());
        sql::and(all)
      }
      None => sql::and(constraints.clone()),
    };
  }
  if n == 1 && result.is_none() {
    result = constraints.into_iter().next().flatten();
  }
  Ok(result)
}

/// `prefixJoinContainsWhere({ prefix, where })`
fn prefix_join_contains_where(prefix: &str, where_: &WhereVal) -> Result<WhereVal> {
  let mut out = Vec::new();
  for (key, value) in where_.entries()? {
    let lower = key.to_lowercase();
    let items = if lower == "and" || lower == "or" { value.as_items() } else { None };
    match items {
      Some(items) => {
        let mut nested = Vec::new();
        for item in &items {
          nested.push(prefix_join_contains_where(prefix, item)?);
        }
        out.push((key, WhereVal::Arr(nested)));
      }
      None => out.push((format!("{prefix}.{key}"), value)),
    }
  }
  Ok(WhereVal::Obj(out))
}

/// `buildHasManyRelationshipCondition(args)`
fn build_has_many_relationship_condition(
  adapter: &QueryAdapter,
  args: &ParseArgs,
  operator: &str,
  relation_or_path: &str,
  where_: &WhereVal,
) -> Result<Sql> {
  let relationship_field_path = replace_double_underscore(relation_or_path);
  let error_path = format!("{relationship_field_path}.{operator}");
  if !where_.is_plain_object() {
    return Err(query_error(&error_path));
  }
  let Some(relationship_path) = resolve_relationship_path(
    adapter,
    &args.fields,
    args.locale.clone(),
    args.parent_is_localized,
    &relationship_field_path,
    "",
  )?
  else {
    return Err(query_error(&error_path));
  };
  let relationship_field = relationship_path.field;
  let Some(relation_to) = relationship_field.get("relationTo").as_str().filter(|_| relationship_field.get("hasMany").truthy())
  else {
    return Err(query_error(&error_path));
  };
  let where_len = where_.entries()?.len();
  if operator == "equals" && where_len == 0 {
    return Ok(Sql::raw("true"));
  }

  let relationship_table_name = format!("{}{}", args.table_name, adapter.opts.relationships_suffix);
  let related_config = adapter.collection_config(&JsVal::str(relation_to))?;
  let related_table_name = adapter.table_name_map(&to_snake_case(&js_string(related_config.get("slug"))));
  let relationship_locale = relationship_path.locale.clone();
  let (relationship_table, _) = adapter.get_table_alias(Some(&relationship_table_name))?;
  let (related_table, _) = adapter.get_table_alias(related_table_name.as_deref())?;

  let mut nested_joins: Vec<Join> = Vec::new();
  let related_document_where = if where_len > 0 {
    let mut nested_context = QueryContext::default();
    let mut nested_select = SelectFields::new();
    parse_params(
      adapter,
      ParseArgs {
        alias_table: Some(related_table.clone()),
        fields: related_config.get("flattenedFields").clone(),
        locale: relationship_locale.clone(),
        parent_is_localized: false,
        select_locale: false,
        table_name: related_table_name.clone().unwrap_or_default(),
        where_,
      },
      &mut nested_context,
      &mut nested_joins,
      &mut nested_select,
    )?
  } else {
    None
  };

  let outer_table = match &args.alias_table {
    Some(t) => t.clone(),
    None => adapter.aliased_table(&args.table_name, &args.table_name)?,
  };
  let path_col = adapter.col(&relationship_table, "path");
  let mut row_constraints = vec![
    Some(sql::eq(adapter.col(&relationship_table, "parent").as_ref(), opt_operand(adapter.col(&outer_table, "id")))),
    Some(if relationship_path.path.contains('%') {
      sql::like(path_col.as_ref(), JsVal::str(relationship_path.path.as_str()))
    } else {
      sql::eq(path_col.as_ref(), JsVal::str(relationship_path.path.as_str()))
    }),
  ];
  if relationship_locale.as_ref().is_some_and(|l| !l.is_empty() && l != "all") && relationship_path.is_localized {
    row_constraints.push(Some(sql::eq(adapter.col(&relationship_table, "locale").as_ref(), locale_val(&relationship_locale))));
  }

  let mut related_constraints = vec![Some(sql::eq(
    adapter.col(&related_table, "id").as_ref(),
    opt_operand(adapter.col(&relationship_table, &format!("{relation_to}ID"))),
  ))];
  if let Some(w) = related_document_where {
    related_constraints.push(Some(w));
  }

  crate::sql::check_join_aliases(&nested_joins)?;
  let related_subquery = Select {
    fields: vec![adapter.col(&related_table, "id").map(|e| sql::expr_sql(&e)).unwrap_or_default()],
    from: Some(related_table.clone()),
    joins: nested_joins,
    where_: sql::and(related_constraints),
    ..Select::default()
  };

  let rows = |check: Sql| -> Select {
    let mut constraints = row_constraints.clone();
    constraints.push(Some(check));
    Select {
      fields: vec![adapter.col(&relationship_table, "parent").map(|e| sql::expr_sql(&e)).unwrap_or_default()],
      from: Some(relationship_table.clone()),
      where_: sql::and(constraints),
      ..Select::default()
    }
  };

  Ok(match operator {
    "contains" => sql::exists(rows(sql::exists(related_subquery))),
    "equals" => sql::not_exists(rows(sql::not_exists(related_subquery))),
    _ => sql::not_exists(rows(sql::exists(related_subquery))),
  })
}
