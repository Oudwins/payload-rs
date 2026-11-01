//! Inputs of the find module and its boundary to the query module
//! (`payload-sql-query`, port of `queries/buildQuery.ts` & co.).
//!
//! The query module is consumed through the [`QueryBuilder`] trait. It
//! returns pre-rendered SQL fragments ([`Sql`]) in exactly the form drizzle
//! renders the corresponding TS objects, so the find module only has to
//! splice them into the statements it builds.

use std::collections::HashMap;

use indexmap::IndexMap;
use payload_engine::error::Result;
use payload_engine::js::JsVal;

use crate::schema::DrizzleSchema;
use crate::sql::Sql;

/// Adapter options the find module reads (`adapter.*`): the query crate's
/// options type.
pub use payload_sql_query::AdapterOptions;

/// Everything `buildFindManyArgs`/`findMany` read from the adapter and the
/// Payload instance.
pub struct FindContext<'a> {
  /// `adapter.tables` + drizzle relations.
  pub schema: &'a DrizzleSchema,
  /// `adapter.tableNameMap`
  pub table_name_map: &'a IndexMap<String, String>,
  /// `payload.config` (sanitized)
  pub config: &'a JsVal,
  /// `payload.collections`: `{ [slug]: { config } }`
  pub collections: &'a JsVal,
  /// `payload.blocks`: `{ [slug]: block }`
  pub blocks: &'a JsVal,
  /// `block[InternalBlockTableNameIndex]`, keyed by [`JsVal::identity`]
  /// (same map as `RawSchema::block_table_name_index`).
  pub block_table_name_index: &'a HashMap<usize, u32>,
  pub options: &'a AdapterOptions,
  pub query: &'a dyn QueryBuilder,
}

/// Where the `fields` passed to [`QueryBuilder::build_query`] come from, for
/// implementations that resolve fields themselves (e.g. a JS bridge).
#[derive(Clone, Debug, PartialEq)]
pub enum FieldsSource {
  /// `payload.collections[slug].config.flattenedFields`
  Collection(String),
  /// `buildVersionCollectionFields(config, collection, true)`
  CollectionVersions(String),
  /// Fields of the caller (findMany `fields` argument).
  Caller,
}

/// Arguments of `buildQuery()`.
///
/// `where_` is a Payload `Where`: user data as [`WhereVal::Js`], engine-built
/// wheres with typed internal values ([`raw_constraint`]).
pub struct BuildQueryArgs<'a> {
  pub table_name: &'a str,
  /// `aliasTable` (`getTableAlias` result name): columns of `table_name`
  /// must be rendered through this alias.
  pub alias_table: Option<&'a str>,
  pub fields: &'a JsVal,
  pub fields_source: FieldsSource,
  pub locale: Option<&'a str>,
  pub parent_is_localized: bool,
  pub select_locale: bool,
  pub sort: &'a JsVal,
  pub where_: &'a WhereVal,
}

/// A drizzle column reference.
#[derive(Clone, Debug, PartialEq)]
pub struct ColumnRef {
  /// `getTableName(column.table)`: the alias when the table is aliased.
  pub table: String,
  /// Database column name.
  pub name: String,
  /// `column.primary`
  pub primary: bool,
}

impl ColumnRef {
  /// `"table"."name"`
  pub fn qualified(&self) -> Sql {
    Sql::column(&self.table, &self.name)
  }
}

#[derive(Clone, Debug, PartialEq)]
pub enum SelectField {
  Column(ColumnRef),
  /// Non-column selection (rendered SQL).
  Sql(Sql),
}

pub use payload_sql_query::{JoinType, WhereVal};

/// An entry of `BuildQueryJoinAliases`.
#[derive(Clone, Debug, PartialEq)]
pub struct QueryJoin {
  pub join_type: JoinType,
  /// The joined table as drizzle's `buildJoins` renders it after `join `:
  /// `"orig"` or `"orig" "alias"` (or a rendered subquery).
  pub table: Sql,
  /// `getNameFromDrizzleTable(table)`
  pub table_name: String,
  pub condition: Sql,
  pub is_one_to_many: bool,
}

/// An entry of `buildQuery().orderBy`.
#[derive(Clone, Debug, PartialEq)]
pub struct QueryOrderBy {
  pub column: ColumnRef,
  /// `order === asc` (false for `desc` and raw sorts).
  pub is_asc: bool,
  /// `order(column)` rendered.
  pub expr: Sql,
  /// `order(column)` as drizzle's relational query renders it
  /// (`mapColumnsInSQLToAlias(expr, rootTable)`); `None` = same as `expr`.
  pub expr_rqb: Option<Sql>,
}

/// `buildQuery()` result.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BuiltQuery {
  pub joins: Vec<QueryJoin>,
  pub order_by: Vec<QueryOrderBy>,
  pub select_fields: IndexMap<String, SelectField>,
  pub where_: Option<Sql>,
  /// `where` as drizzle's relational query renders it
  /// (`mapColumnsInSQLToAlias(where, rootTable)`); `None` = same as `where_`.
  pub where_rqb: Option<Sql>,
}

/// `sanitizeQueryValue()` result.
#[derive(Clone, Debug)]
pub struct SanitizedQueryValue {
  pub operator: String,
  pub value: JsVal,
  /// `sanitizedQueryValue.columns` was set.
  pub has_columns: bool,
}

/// The column operand used by the polymorphic where builder.
#[derive(Clone, Debug, PartialEq)]
pub enum WhereColumn {
  /// A real table column.
  Column(ColumnRef),
  /// `sql\`null\``
  Null,
  /// `sql\`${collection}\`` (a bound string).
  Param(String),
}

impl WhereColumn {
  pub fn to_sql(&self) -> Sql {
    match self {
      WhereColumn::Column(c) => c.qualified(),
      WhereColumn::Null => Sql::raw("null"),
      WhereColumn::Param(v) => Sql::param(serde_json::Value::String(v.clone())),
    }
  }
}

pub struct SanitizeArgs<'a> {
  pub field: &'a JsVal,
  pub is_uuid: bool,
  pub operator: &'a str,
  pub relation_or_path: &'a str,
  pub val: &'a JsVal,
}

pub struct OperatorConstraintArgs<'a> {
  pub column: &'a WhereColumn,
  /// `None`: plain `adapter.operators[resolvedOperator](column, value)`;
  /// `Some(field)`: `buildOperatorConstraint({ field, ... })`.
  pub field: Option<&'a JsVal>,
  pub locale: Option<&'a str>,
  pub original_operator: &'a str,
  pub path: &'a str,
  pub resolved_operator: &'a str,
  pub value: &'a JsVal,
}

pub struct JsonQueryArgs<'a> {
  pub column: &'a str,
  pub operator: &'a str,
  pub path_segments: Vec<String>,
  pub value: &'a JsVal,
}

/// Boundary to the query module.
pub trait QueryBuilder {
  /// `buildQuery()` (queries/buildQuery.ts).
  fn build_query(&self, args: &BuildQueryArgs<'_>) -> Result<BuiltQuery>;

  /// `getTableAlias({ adapter, tableName }).newAliasTableName`
  fn table_alias(&self, table_name: &str) -> Result<String>;

  /// `sanitizeQueryValue()`; `Ok(None)` for a `null` result.
  fn sanitize_query_value(&self, args: &SanitizeArgs<'_>) -> Result<Option<SanitizedQueryValue>>;

  /// `operator in adapter.operators`
  fn has_operator(&self, operator: &str) -> bool;

  /// `adapter.operators[op](column, value)` or `buildOperatorConstraint()`.
  fn operator_constraint(&self, args: &OperatorConstraintArgs<'_>) -> Result<Sql>;

  /// `adapter.createJSONQuery()`
  fn create_json_query(&self, args: &JsonQueryArgs<'_>) -> Result<String>;
}

/// `rawConstraint(sql.raw(raw))`: a typed [`WhereVal`] variant that user data
/// (always [`WhereVal::Js`]) can never produce.
pub fn raw_constraint(raw: &str) -> WhereVal {
  WhereVal::raw_constraint(raw)
}
