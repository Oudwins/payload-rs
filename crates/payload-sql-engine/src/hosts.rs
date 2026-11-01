//! The per-call context and the boundaries the write path calls back through
//! ([`UpsertHost`] for `upsertRow`'s read-backs, [`OpsHost`] for the operations' lookups).

use payload_engine::error::{EngineError, Result};
use payload_engine::js::{JsVal, Obj};
use payload_sql_find::args::QueryConfig;
use payload_sql_find::build_args::{BuildFindManyArgs, build_find_many_args};
use payload_sql_find::context::{FieldsSource, FindContext};
use payload_engine::host::Host;
use payload_sql_find::exec::{Executor as FindExecutor, execute_js};
use payload_sql_find::find_many::{FindManyArgs, FindManyResult, find_many_js};
use payload_sql_find::query::map_columns_to_alias;
use payload_sql_find::relational::{Mode, build_relational_query};
use payload_sql_query::build_query::{BuildQueryArgs, BuildQueryResult, build_query};
use payload_sql_query::drizzle::Decoder;
use payload_sql_query::sql::{Chunk, Select, Sql, check_join_aliases, selection_sql};
use payload_sql_query::{QueryAdapter, WhereVal};
use payload_sql_read::{ReadAdapter, TransformArgs, Val, transform};
use payload_sql_upsert::ops::{BuiltQuery, OpsHost};
use payload_sql_upsert::sql::{eq, require_table};
use payload_sql_upsert::sql::Statements;
use payload_sql_upsert::{Executor, FindArgsShape, SqlFragment, UpsertHost};
use payload_sql_write::SchemaWriteAdapter;

use crate::{EngineOptions, SqliteEngine};
use crate::convert::{fragment_to_find_sql, render_find_sql, render_fragment, val_to_js};

/// Everything one adapter method call works with. The adapters borrow the engine's single decoded
/// graph and raw schema.
pub(crate) struct Call<'a> {
  pub engine: &'a SqliteEngine,
  /// The engine's options with the call-time adapter properties applied.
  pub options: &'a EngineOptions,
  pub root: &'a JsVal,
  pub qa: &'a QueryAdapter<'a>,
  pub find: &'a FindContext<'a>,
  pub read: &'a ReadAdapter<'a>,
  pub write: &'a SchemaWriteAdapter<'a>,
  /// The call's connection as libsql (`client.execute` / `tx.execute`): find statements.
  pub conn: &'a dyn FindExecutor,
  /// The same connection for the write path's executor.
  pub statements: &'a dyn Statements,
  /// JS functions (custom column `fromDriver`).
  pub host: &'a dyn Host,
  /// Caller-visible mutations of the arguments to report (`CallOutput::mutations`).
  pub mutations: std::cell::RefCell<Vec<(Vec<String>, JsVal)>>,
}

/// Arguments of `findMany()` (find/findMany.ts), owned.
#[derive(Clone, Debug, Default)]
pub(crate) struct FindSpec {
  pub collection_slug: Option<String>,
  pub drafts_enabled: bool,
  pub fields: JsVal,
  pub joins: JsVal,
  pub limit: Option<f64>,
  pub locale: Option<String>,
  pub page: Option<f64>,
  pub pagination: Option<bool>,
  pub select: JsVal,
  pub sort: JsVal,
  pub table_name: String,
  pub versions: bool,
  pub where_: JsVal,
}

impl<'a> Call<'a> {
  pub fn config(&self) -> &'a JsVal {
    self.root.get("config")
  }

  pub fn executor(&self) -> Executor<'a> {
    let mut exec = Executor::new(self.statements);
    exec.limited_bound_parameters = self.options.upsert.limited_bound_parameters;
    exec
  }

  /// `buildQuery({ adapter, fields, locale, sort, tableName, where })`
  pub fn build_query(
    &self,
    fields: &JsVal,
    table_name: &str,
    locale: Option<&str>,
    sort: &JsVal,
    where_: WhereVal,
  ) -> Result<BuildQueryResult> {
    build_query(
      self.qa,
      BuildQueryArgs {
        alias_table: None,
        fields: fields.clone(),
        joins: Vec::new(),
        locale: locale.map(str::to_string),
        parent_is_localized: false,
        select_locale: false,
        sort: sort.clone(),
        table_name: table_name.to_string(),
        where_,
      },
    )
  }

  /// `transform({ adapter, config, data, fields, joinQuery, tableName })` (transform/read)
  pub fn transform(&self, data: Val, fields: &JsVal, join_query: &JsVal, table_name: &str) -> Result<JsVal> {
    let doc = transform(self.read, TransformArgs { data, fields, join_query, parent_is_localized: false, table_name })?;
    Ok(val_to_js(&doc))
  }

  /// `findMany()` with the read transform; returns the pagination result and the transformed docs.
  pub fn find_many(&self, spec: &FindSpec) -> Result<FindManyResult<JsVal>> {
    find_many_js(
      self.find,
      self.conn,
      &FindManyArgs {
        collection_slug: spec.collection_slug.as_deref(),
        drafts_enabled: spec.drafts_enabled,
        fields: &spec.fields,
        fields_source: FieldsSource::Caller,
        joins: &spec.joins,
        limit: spec.limit,
        locale: spec.locale.as_deref(),
        page: spec.page,
        pagination: spec.pagination,
        select: &spec.select,
        sort: &spec.sort,
        table_name: &spec.table_name,
        versions: spec.versions,
        where_: &spec.where_,
      },
      self.host,
      &mut |row| self.transform(Val::from_js(&row), &spec.fields, &spec.joins, &spec.table_name),
      None,
    )
  }

  /// `buildFindManyArgs({ adapter, depth: 0, fields, joinQuery: false, select, tableName })`
  pub fn read_back_args(&self, fields: &JsVal, select: &JsVal, table_name: &str) -> Result<QueryConfig> {
    build_find_many_args(
      self.find,
      &BuildFindManyArgs {
        collection_slug: None,
        depth: Some(0.0),
        drafts_enabled: false,
        fields,
        join_query: &JsVal::Bool(false),
        locale: None,
        select,
        table_name,
        versions: false,
      },
    )
  }

  /// `db.query[tableName].findFirst(config)`: the raw drizzle row, `None` for `undefined`.
  pub fn find_first_raw(&self, table_name: &str, config: &QueryConfig) -> Result<Option<JsVal>> {
    let built = build_relational_query(&self.engine.drizzle, table_name, config, Mode::First)?;
    let row = execute_js(self.conn, &built, Mode::First, self.host)?;
    Ok(if row.is_undefined() { None } else { Some(row) })
  }

  /// A selected driver value decoded like drizzle's `mapResultRow`: `null` stays `null`, a column
  /// field goes through its column's `mapFromDriverValue`, other fields are kept.
  pub fn decode(&self, decoder: Option<Decoder>, value: JsVal) -> Result<JsVal> {
    match (decoder, value) {
      (_, JsVal::Null) => Ok(JsVal::Null),
      (Some(decoder), value) => payload_sql_find::exec::decode_js(decoder, payload_sql_find::exec::Driver::Js(value), self.host),
      (None, value) => Ok(value),
    }
  }

  /// Runs a query-crate select on the executor (statements fail like drizzle's `DrizzleQueryError`).
  pub fn select_rows(&self, exec: &mut Executor<'_>, select: &Select) -> Result<Vec<Vec<(String, JsVal)>>> {
    let q = crate::convert::query_to_fragment(select.render()?);
    exec.query_raw(&q).map_err(|e| e.into_engine_error())
  }
}

/// A JS number as a bound SQL value (`limit ?`).
pub(crate) fn num_param(n: f64) -> Sql {
  Sql::new(vec![Chunk::Value(JsVal::Num(n))])
}

/// The upsert crate's view of a `buildQuery` result (`where` rendered, joins counted, `orderBy`
/// rendered as the list after ` order by `).
pub(crate) fn built_query(result: &BuildQueryResult) -> Result<BuiltQuery> {
  let where_ = result.where_.as_ref().map(render_fragment).transpose()?;
  let order_by = if result.order_by.is_empty() {
    None
  } else {
    let mut out = SqlFragment::default();
    for (i, o) in result.order_by.iter().enumerate() {
      let rendered = render_fragment(&o.to_sql())?;
      if i > 0 {
        out.sql.push_str(", ");
      }
      out.sql.push_str(&rendered.sql);
      out.params.extend(rendered.params);
    }
    Some(out)
  };
  Ok(BuiltQuery { where_, joins: result.joins.len(), order_by })
}

/// `upsertRow`'s read-backs for one operation (its `fields`, `select` and `tableName`).
pub(crate) struct ReadBack<'c> {
  pub call: &'c Call<'c>,
  pub fields: &'c JsVal,
  pub select: JsVal,
  pub table_name: String,
}

impl UpsertHost for ReadBack<'_> {
  /// `transformForWrite`'s `new Date()` (auto `updatedAt`) is the caller's clock.
  fn transform_started(&mut self, _data: &JsVal, _atomic: bool, _path: &str, _table_name: &str) -> Option<f64> {
    self.call.options.now
  }

  fn find_args_shape(&mut self) -> Result<FindArgsShape> {
    let config = self.call.read_back_args(self.fields, &self.select, &self.table_name)?;
    // `Object.keys(findManyArgs).length` / `Object.keys(findManyArgs.columns || {}).length > 0`
    let key_count = [
      config.columns.is_some(),
      config.with.is_some(),
      config.extras.is_some(),
      config.order_by.is_some(),
      config.where_.is_some(),
      config.limit.is_some(),
      config.offset.is_some(),
    ]
    .iter()
    .filter(|present| **present)
    .count();
    Ok(match &config.columns {
      Some(columns) if !columns.is_empty() => {
        FindArgsShape::OnlyColumns(columns.iter().filter(|(_, v)| **v == Some(true)).map(|(k, _)| k.clone()).collect())
      }
      _ if key_count == 0 => FindArgsShape::Empty,
      _ => FindArgsShape::NeedsQuery,
    })
  }

  fn find_first(&mut self, _exec: &mut Executor<'_>, where_: &SqlFragment) -> Result<Option<JsVal>> {
    let mut config = self.call.read_back_args(self.fields, &self.select, &self.table_name)?;
    config.where_ = Some(fragment_to_find_sql(where_)?);
    // the executor's statements and this read run on the same connection, in order
    let Some(row) = self.call.find_first_raw(&self.table_name, &config)? else { return Ok(None) };
    self.call.transform(Val::from_js(&row), self.fields, &JsVal::Bool(false), &self.table_name).map(Some)
  }

  fn transform_row(&mut self, row: Obj) -> Result<JsVal> {
    self.call.transform(Val::from_js(&JsVal::obj(row)), self.fields, &JsVal::Bool(false), &self.table_name)
  }
}

/// The lookups of the write operations (`selectDistinct`, `findMany`, `findFirst`).
pub(crate) struct Ops<'c> {
  pub call: &'c Call<'c>,
  pub fields: &'c JsVal,
  pub table_name: String,
  /// The operation's `buildQuery` result.
  pub built: Option<BuildQueryResult>,
  pub select: JsVal,
  /// The operation's `findMany` arguments.
  pub find_spec: Option<FindSpec>,
}

impl OpsHost for Ops<'_> {
  /// `selectDistinct({ joins, selectFields, tableName, where, query })`: `query.limit(1)` for
  /// updateOne / deleteOne, `query.orderBy(orderBy)` for updateMany.
  fn select_distinct_ids(&mut self, exec: &mut Executor<'_>, _query: &BuiltQuery, limit: Option<i64>) -> Result<Vec<JsVal>> {
    let built = self.built.as_ref().ok_or_else(|| EngineError::internal("selectDistinct without buildQuery"))?;
    let main = self.call.qa.table_req(Some(&self.table_name), "id")?;
    check_join_aliases(&built.joins)?;
    let mut fields = Vec::new();
    let mut decoders = Vec::new();
    let mut id_index = None;
    for (i, (key, field)) in built.select_fields.iter().enumerate() {
      let Some(expr) = field else {
        return Err(EngineError::new("TypeError", "Cannot convert undefined or null to object"));
      };
      if key == "id" {
        id_index = Some(i);
      }
      decoders.push(expr.as_col().map(|c| c.decoder));
      fields.push(selection_sql(expr));
    }
    let select = Select {
      distinct: true,
      fields,
      from: Some(main),
      joins: built.joins.clone(),
      where_: built.where_.clone(),
      order_by: if limit.is_none() { built.order_by.iter().map(|o| o.to_sql()).collect() } else { Vec::new() },
      limit: limit.map(|l| num_param(l as f64)),
      ..Select::default()
    };
    let rows = self.call.select_rows(exec, &select)?;
    // `mapResultRow`: every selected column is decoded in selection order (`mapFromDriverValue`,
    // which can throw); only `id` is read afterwards
    let mut ids = Vec::with_capacity(rows.len());
    for row in rows {
      let mut id = JsVal::Undefined;
      for (i, (_, value)) in row.into_iter().enumerate() {
        let value = self.call.decode(decoders.get(i).copied().flatten(), value)?;
        if Some(i) == id_index {
          id = value;
        }
      }
      ids.push(id);
    }
    Ok(ids)
  }

  fn find_many(&mut self, _exec: &mut Executor<'_>) -> Result<Vec<JsVal>> {
    let spec = self.find_spec.as_ref().ok_or_else(|| EngineError::internal("findMany without arguments"))?;
    Ok(self.call.find_many(spec)?.docs)
  }

  fn find_first_to_delete(
    &mut self,
    _exec: &mut Executor<'_>,
    distinct_id: Option<&JsVal>,
    _where: Option<&SqlFragment>,
  ) -> Result<Option<JsVal>> {
    let config = match distinct_id {
      // `findFirst({ where: eq(this.tables[tableName].id, selectDistinctResult[0].id) })`
      Some(id) => {
        let t = require_table(self.call.engine.write_schema(), &self.table_name)?;
        QueryConfig { where_: Some(fragment_to_find_sql(&eq(t, "id", id)?)?), ..QueryConfig::default() }
      }
      // `buildFindManyArgs(...)` with `findManyArgs.where = where` (drizzle maps its columns to
      // the root table alias)
      None => {
        let mut config = self.call.read_back_args(self.fields, &self.select, &self.table_name)?;
        let built = self.built.as_ref().ok_or_else(|| EngineError::internal("findFirst without buildQuery"))?;
        config.where_ =
          built.where_.as_ref().map(|w| render_find_sql(&map_columns_to_alias(w, &self.table_name))).transpose()?;
        config
      }
    };
    self.call.find_first_raw(&self.table_name, &config)
  }

  fn transform_doc(&mut self, doc: &JsVal) -> Result<JsVal> {
    self.call.transform(Val::from_js(doc), self.fields, &JsVal::Bool(false), &self.table_name)
  }
}
