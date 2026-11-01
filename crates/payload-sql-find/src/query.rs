//! [`QueryBuilder`] implemented on top of the Rust query builder
//! (`payload-sql-query`).
//!
//! The query crate builds drizzle-shaped SQL trees; this module renders them
//! into the pre-rendered fragments ([`Sql`]) the find module splices into its
//! statements, applying drizzle's `mapColumnsInSQLToAlias(…, rootTable)` for
//! the relational-query forms (`where_rqb` / `expr_rqb`).

use payload_engine::error::{EngineError, Result};
use payload_engine::js::JsVal;
use payload_sql_query::build_query::{BuildQueryArgs as QBuildQueryArgs, BuildQueryResult, Order};
use payload_sql_query::json_query::{CreateJsonQueryArgs, JsonColumn, create_json_query};
use payload_sql_query::operators::{OperatorConstraintArgs as QOperatorConstraintArgs, apply_operator, build_operator_constraint};
use payload_sql_query::sanitize::{SanitizeArgs as QSanitizeArgs, sanitize_query_value};
use payload_sql_query::sql::{Chunk, Column, Expr, Operand, Sql as QSql, SqlValue, TableRef};
use payload_sql_query::{QueryAdapter, WhereVal, build_query};

use crate::context::{
  BuildQueryArgs, BuiltQuery, ColumnRef, JsonQueryArgs, OperatorConstraintArgs, QueryBuilder, QueryJoin,
  QueryOrderBy, SanitizeArgs, SanitizedQueryValue, SelectField, WhereColumn,
};
use crate::sql::{Param, Sql};

/// Keys of the SQLite `adapter.operators` object (`operatorMap` with the
/// `@payloadcms/db-sqlite` overrides).
const OPERATOR_KEYS: &[&str] = &[
  "and",
  "contains",
  "equals",
  "exists",
  "greater_than",
  "greater_than_equal",
  "in",
  "isNull",
  "less_than",
  "less_than_equal",
  "like",
  "not_equals",
  "not_like",
  "not_in",
  "or",
];

/// Properties every plain object inherits from `Object.prototype` (JS `in`
/// sees them too).
const OBJECT_PROTOTYPE_KEYS: &[&str] = &[
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
];

/// The find module's query boundary backed by `payload-sql-query`.
pub struct SqlQueryBuilder<'q, 'a> {
  pub adapter: &'q QueryAdapter<'a>,
}

impl<'q, 'a> SqlQueryBuilder<'q, 'a> {
  pub fn new(adapter: &'q QueryAdapter<'a>) -> Self {
    Self { adapter }
  }

  /// The drizzle column a [`ColumnRef`] points at (`adapter.tables[table]`
  /// column with that database name).
  fn column(&self, column: &ColumnRef) -> Result<Column> {
    let key = self
      .adapter
      .column_key_by_db_name(&column.table, &column.name)
      .ok_or_else(|| EngineError::new("TypeError", "Cannot read properties of undefined (reading 'name')"))?;
    let table_ref = TableRef { name: column.table.clone(), alias: None };
    self
      .adapter
      .column(&table_ref, &key)
      .ok_or_else(|| EngineError::new("TypeError", "Cannot read properties of undefined (reading 'name')"))
  }

  fn where_column(&self, column: &WhereColumn) -> Result<Expr> {
    Ok(match column {
      WhereColumn::Column(c) => Expr::Col(self.column(c)?),
      WhereColumn::Null => Expr::Sql(QSql::raw("null")),
      WhereColumn::Param(v) => Expr::Sql(QSql::new(vec![Chunk::Value(JsVal::str(v.as_str()))])),
    })
  }
}

impl QueryBuilder for SqlQueryBuilder<'_, '_> {
  fn build_query(&self, args: &BuildQueryArgs<'_>) -> Result<BuiltQuery> {
    let alias_table = match args.alias_table {
      Some(alias) => Some(self.adapter.aliased_table(args.table_name, alias)?),
      None => None,
    };
    let result = build_query(
      self.adapter,
      QBuildQueryArgs {
        alias_table,
        fields: args.fields.clone(),
        joins: Vec::new(),
        locale: args.locale.map(str::to_string),
        parent_is_localized: args.parent_is_localized,
        select_locale: args.select_locale,
        sort: args.sort.clone(),
        table_name: args.table_name.to_string(),
        where_: args.where_.clone(),
      },
    )?;
    built_query(&result, args.table_name)
  }

  fn table_alias(&self, table_name: &str) -> Result<String> {
    let (_, alias) = self.adapter.get_table_alias(Some(table_name))?;
    Ok(alias)
  }

  fn sanitize_query_value(&self, args: &SanitizeArgs<'_>) -> Result<Option<SanitizedQueryValue>> {
    // Polymorphic join wheres are user data only: never an internal value.
    let val = WhereVal::Js(args.val.clone());
    let sanitized = sanitize_query_value(
      self.adapter,
      QSanitizeArgs {
        columns: None,
        field: args.field,
        is_uuid: args.is_uuid,
        operator: args.operator,
        relation_or_path: args.relation_or_path,
        val: &val,
      },
    )?;
    sanitized
      .map(|s| {
        let value = match s.value {
          Operand::Val(v) => v,
          Operand::Expr(_) => {
            return Err(EngineError::internal("sanitizeQueryValue returned SQL for a plain where value"));
          }
        };
        Ok(SanitizedQueryValue { operator: s.operator, value, has_columns: s.columns.is_some() })
      })
      .transpose()
  }

  fn has_operator(&self, operator: &str) -> bool {
    OPERATOR_KEYS.contains(&operator) || OBJECT_PROTOTYPE_KEYS.contains(&operator)
  }

  fn operator_constraint(&self, args: &OperatorConstraintArgs<'_>) -> Result<Sql> {
    let column = self.where_column(args.column)?;
    let constraint = match (args.resolved_operator, args.field) {
      ("and" | "or", _) => combinator(args.resolved_operator, &column, args.value),
      (op, _) if OBJECT_PROTOTYPE_KEYS.contains(&op) => {
        return Err(EngineError::internal(format!(
          "adapter.operators[\"{op}\"] resolves to an Object.prototype method, which the Rust query builder does not call"
        )));
      }
      (op, Some(field)) => build_operator_constraint(
        self.adapter,
        QOperatorConstraintArgs {
          column: Some(column),
          field,
          path: args.path,
          resolved_operator: op,
          value: Operand::Val(args.value.clone()),
        },
      )?,
      (op, None) => apply_operator(op, Some(&column), Operand::Val(args.value.clone()))?,
    };
    render(&constraint)
  }

  fn create_json_query(&self, args: &JsonQueryArgs<'_>) -> Result<String> {
    create_json_query(CreateJsonQueryArgs {
      column: Some(JsonColumn::Raw(args.column.to_string())),
      operator: args.operator,
      path_segments: args.path_segments.clone(),
      table: None,
      treat_as_array: None,
      treat_root_as_array: false,
      value: args.value.clone(),
    })
  }
}

/// drizzle `and(column, value)` / `or(column, value)` called through
/// `adapter.operators` (the value is interpolated as a plain chunk).
fn combinator(operator: &str, column: &Expr, value: &JsVal) -> QSql {
  let mut conditions = vec![match column {
    Expr::Col(c) => Chunk::Col(c.clone()),
    Expr::Sql(s) => Chunk::Sql(s.clone()),
  }];
  if !value.is_undefined() {
    conditions.push(Chunk::Value(value.clone()));
  }
  if conditions.len() == 1 {
    return QSql::new(conditions);
  }
  let separator = if operator == "and" { " and " } else { " or " };
  let mut chunks = vec![Chunk::Str("(".into())];
  for (i, c) in conditions.into_iter().enumerate() {
    if i > 0 {
      chunks.push(Chunk::Str(separator.into()));
    }
    chunks.push(c);
  }
  chunks.push(Chunk::Str(")".into()));
  QSql::new(chunks)
}

/// Converts a `buildQuery()` result into the rendered form of the find module.
pub fn built_query(result: &BuildQueryResult, root_table: &str) -> Result<BuiltQuery> {
  let joins = result
    .joins
    .iter()
    .map(|join| {
      Ok(QueryJoin {
        join_type: join.join_type.unwrap_or(payload_sql_query::JoinType::Left),
        table: Sql::raw(join.table.render_from()),
        table_name: join.table.ref_name().to_string(),
        condition: match &join.condition {
          Some(c) => render(c)?,
          None => Sql::new(),
        },
        is_one_to_many: join.is_one_to_many,
      })
    })
    .collect::<Result<Vec<_>>>()?;
  let order_by = result
    .order_by
    .iter()
    .map(|o| {
      let expr = o.to_sql();
      Ok(QueryOrderBy {
        column: column_ref(&o.column),
        is_asc: matches!(o.order, Order::Asc),
        expr: render(&expr)?,
        expr_rqb: Some(render(&map_columns_to_alias(&expr, root_table))?),
      })
    })
    .collect::<Result<Vec<_>>>()?;
  let select_fields = result
    .select_fields
    .iter()
    .map(|(key, value)| {
      let field = match value {
        Some(Expr::Col(c)) => SelectField::Column(column_ref(c)),
        Some(Expr::Sql(s)) => SelectField::Sql(render(s)?),
        None => SelectField::Sql(Sql::new()),
      };
      Ok((key.clone(), field))
    })
    .collect::<Result<_>>()?;
  let (where_, where_rqb) = match &result.where_ {
    Some(w) => (Some(render(w)?), Some(render(&map_columns_to_alias(w, root_table))?)),
    None => (None, None),
  };
  Ok(BuiltQuery { joins, order_by, select_fields, where_, where_rqb })
}

fn column_ref(column: &Column) -> ColumnRef {
  ColumnRef {
    table: column.table.ref_name().to_string(),
    table_name: column.table.name.clone(),
    name: column.name.clone(),
    primary: column.primary,
  }
}

/// Renders a query-crate SQL tree (`dialect.sqlToQuery`), with the bound
/// parameters as the libsql client binds them.
pub fn render(sql: &QSql) -> Result<Sql> {
  let query = sql.render()?;
  Ok(Sql { sql: query.sql, params: query.params.iter().map(param).collect() })
}

fn param(value: &SqlValue) -> Param {
  value.to_json()
}

/// drizzle `mapColumnsInSQLToAlias(query, alias)`: every column chunk (also in
/// nested SQL, not in subqueries or params) is re-pointed at `alias`.
pub fn map_columns_to_alias(sql: &QSql, alias: &str) -> QSql {
  QSql::new(
    sql
      .chunks
      .iter()
      .map(|chunk| match chunk {
        Chunk::Col(c) => Chunk::Col(Column {
          table: TableRef { name: c.table.name.clone(), alias: Some(alias.to_string()) },
          ..c.clone()
        }),
        Chunk::Sql(s) => Chunk::Sql(map_columns_to_alias(s, alias)),
        other => other.clone(),
      })
      .collect(),
  )
}
