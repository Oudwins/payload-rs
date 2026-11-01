//! Port of `find/findMany.ts`, including the statements it issues through
//! `queries/selectDistinct.ts` and `sqlite/countDistinct.ts`.
//!
//! The read transform (`transform/read`) is not part of this module: raw
//! drizzle rows are passed through the caller-provided `transform`.

use indexmap::IndexMap;
use payload_engine::error::{EngineError, Result};
use payload_engine::host::{Host, NoHost};
use payload_engine::js::{JsVal, Obj, num_to_json};
use serde_json::{Map, Value as Json};

use crate::args::OrderBy;
use crate::build_args::{BuildFindManyArgs, build_find_many_args};
use crate::context::{BuildQueryArgs, FieldsSource, FindContext, SelectField, WhereVal};
use crate::exec::{Driver, Executor, decode_js, execute_js, js_number_of, js_string_of, query_cells};
use crate::join::{render_joins, render_selection};
use crate::relational::{Mode, build_relational_query, push_limit_offset};
use crate::sql::{self, Sql};
use crate::utils::js_object_key_order;

/// Arguments of `findMany()` (`FindArgs` + adapter specifics).
#[derive(Clone, Debug)]
pub struct FindManyArgs<'a> {
  pub collection_slug: Option<&'a str>,
  pub drafts_enabled: bool,
  pub fields: &'a JsVal,
  pub fields_source: FieldsSource,
  /// `joins` (JoinQuery)
  pub joins: &'a JsVal,
  /// `limit` (`undefined` = `None`)
  pub limit: Option<f64>,
  pub locale: Option<&'a str>,
  /// `page` (`undefined` = `None`, defaults to 1)
  pub page: Option<f64>,
  /// `pagination` (`undefined` = `None`)
  pub pagination: Option<bool>,
  pub select: &'a JsVal,
  pub sort: &'a JsVal,
  pub table_name: &'a str,
  pub versions: bool,
  pub where_: &'a JsVal,
}

/// `findMany()` result (`PaginatedDocs`). `D` is the document type: JSON for
/// [`find_many`], [`JsVal`] for [`find_many_js`].
#[derive(Clone, Debug, PartialEq)]
pub struct FindManyResult<D = Json> {
  pub docs: Vec<D>,
  pub has_next_page: bool,
  pub has_prev_page: bool,
  pub limit: Option<f64>,
  pub next_page: Option<f64>,
  pub page: f64,
  pub paging_counter: f64,
  pub prev_page: Option<f64>,
  pub total_docs: f64,
  pub total_pages: f64,
}

impl FindManyResult<JsVal> {
  /// The returned object, keys in TS order (`limit` is `undefined` when the
  /// `limit` argument was).
  pub fn to_js(&self) -> JsVal {
    let opt = |v: Option<f64>| v.map(JsVal::Num).unwrap_or(JsVal::Null);
    let mut out = Obj::new();
    out.insert("docs".into(), JsVal::arr(self.docs.clone()));
    out.insert("hasNextPage".into(), JsVal::Bool(self.has_next_page));
    out.insert("hasPrevPage".into(), JsVal::Bool(self.has_prev_page));
    out.insert("limit".into(), self.limit.map(JsVal::Num).unwrap_or(JsVal::Undefined));
    out.insert("nextPage".into(), opt(self.next_page));
    out.insert("page".into(), JsVal::Num(self.page));
    out.insert("pagingCounter".into(), JsVal::Num(self.paging_counter));
    out.insert("prevPage".into(), opt(self.prev_page));
    out.insert("totalDocs".into(), JsVal::Num(self.total_docs));
    out.insert("totalPages".into(), JsVal::Num(self.total_pages));
    JsVal::obj(out)
  }
}

impl FindManyResult {
  pub fn to_json(&self) -> Json {
    let mut out = Map::new();
    out.insert("docs".into(), Json::Array(self.docs.clone()));
    out.insert("hasNextPage".into(), Json::Bool(self.has_next_page));
    out.insert("hasPrevPage".into(), Json::Bool(self.has_prev_page));
    if let Some(limit) = self.limit {
      out.insert("limit".into(), num_to_json(limit));
    }
    out.insert("nextPage".into(), self.next_page.map(num_to_json).unwrap_or(Json::Null));
    out.insert("page".into(), num_to_json(self.page));
    out.insert("pagingCounter".into(), num_to_json(self.paging_counter));
    out.insert("prevPage".into(), self.prev_page.map(num_to_json).unwrap_or(Json::Null));
    out.insert("totalDocs".into(), num_to_json(self.total_docs));
    out.insert("totalPages".into(), num_to_json(self.total_pages));
    Json::Object(out)
  }
}

/// The statements `findMany` executes, exposed for diagnostics.
#[derive(Clone, Debug, Default)]
pub struct FindManyTrace {
  pub distinct: Option<Sql>,
  pub count: Option<Sql>,
  pub relational: Option<Sql>,
  /// Raw drizzle rows (after the `orderedIDMap` sort), before `transform`.
  pub raw_docs: Vec<Json>,
}

fn js_lt_eq(a: f64, b: Option<f64>) -> bool {
  b.is_some_and(|b| a <= b)
}

/// `findMany()` with JSON documents (what `JSON.stringify` makes of the JS
/// rows; custom column decoders fail without a host). See [`find_many_js`].
pub fn find_many<C: Executor + ?Sized>(
  ctx: &FindContext<'_>,
  conn: &C,
  args: &FindManyArgs<'_>,
  transform: &mut dyn FnMut(Json) -> Result<Json>,
  trace: Option<&mut FindManyTrace>,
) -> Result<FindManyResult> {
  let result = find_many_js(ctx, conn, args, &NoHost, &mut |doc| Ok(JsVal::from_json(&transform(doc.to_json())?)), trace)?;
  Ok(FindManyResult {
    docs: result.docs.iter().map(JsVal::to_json).collect(),
    has_next_page: result.has_next_page,
    has_prev_page: result.has_prev_page,
    limit: result.limit,
    next_page: result.next_page,
    page: result.page,
    paging_counter: result.paging_counter,
    prev_page: result.prev_page,
    total_docs: result.total_docs,
    total_pages: result.total_pages,
  })
}

/// `findMany()`. Statements run on `conn` (see [`crate::exec::Executor`]);
/// `host` runs the `fromDriver` functions of custom columns; `transform` is
/// the read transform applied to every raw row.
pub fn find_many_js<C: Executor + ?Sized>(
  ctx: &FindContext<'_>,
  conn: &C,
  args: &FindManyArgs<'_>,
  host: &dyn Host,
  transform: &mut dyn FnMut(JsVal) -> Result<JsVal>,
  trace: Option<&mut FindManyTrace>,
) -> Result<FindManyResult<JsVal>> {
  let mut local_trace = FindManyTrace::default();
  let trace = trace.unwrap_or(&mut local_trace);
  let page = args.page.unwrap_or(1.0);
  let mut pagination = args.pagination;
  let mut limit = args.limit;
  // `(page - 1) * limit` with `undefined` is NaN.
  let offset = (page - 1.0) * limit.unwrap_or(f64::NAN);

  if limit == Some(0.0) {
    pagination = Some(false);
    limit = None;
  }

  let where_ = WhereVal::Js(args.where_.clone());
  let built = ctx.query.build_query(&BuildQueryArgs {
    table_name: args.table_name,
    alias_table: None,
    fields: args.fields,
    fields_source: args.fields_source.clone(),
    locale: args.locale,
    parent_is_localized: false,
    select_locale: false,
    sort: args.sort,
    where_: &where_,
  })?;

  let mut find_many_args = build_find_many_args(
    ctx,
    &BuildFindManyArgs {
      collection_slug: args.collection_slug,
      depth: Some(0.0),
      drafts_enabled: args.drafts_enabled,
      fields: args.fields,
      join_query: args.joins,
      locale: args.locale,
      select: args.select,
      table_name: args.table_name,
      versions: args.versions,
    },
  )?;

  let mut select_fields = built.select_fields.clone();
  select_fields.retain(|_, field| match field {
    SelectField::Column(column) => {
      column.primary || built.order_by.iter().any(|o| o.column.name == column.name && o.column.table == column.table)
    }
    SelectField::Sql(_) => false,
  });

  let main_table = ctx.schema.table(args.table_name)?;
  let id_column = main_table
    .columns
    .get("id")
    .ok_or_else(|| EngineError::new("TypeError", "Cannot read properties of undefined (reading 'id')"))?;
  let main_from = Sql::ident(&main_table.db_name);
  let main_id = Sql::column(&main_table.db_name, &id_column.name);

  let one_to_many: Vec<&str> =
    built.joins.iter().filter(|j| j.is_one_to_many).map(|j| j.table_name.as_str()).collect();
  let has_sort_on_one_to_many =
    !one_to_many.is_empty() && built.order_by.iter().any(|o| one_to_many.contains(&o.column.table.as_str()));

  // `mapResultRow` decodes the selected `id` with its column.
  let decode_id = |row: Vec<payload_sqlite::Cell>, index: Option<usize>| -> Result<JsVal> {
    match index.and_then(|i| row.get(i)) {
      None => Ok(JsVal::Undefined),
      Some(payload_sqlite::Cell::Null) => Ok(JsVal::Null),
      Some(cell) => decode_js(id_column.decoder, Driver::from_cell(cell), host),
    }
  };
  let mut distinct_result: Option<Vec<JsVal>> = None;
  if has_sort_on_one_to_many {
    let mut q = Sql::raw("select ");
    q.push(&main_id).push_str(" from ").push(&main_from).push(&render_joins(&built.joins));
    if let Some(w) = &built.where_ {
      q.push_str(" where ").push(w);
    }
    q.push_str(" group by ").push(&main_id);
    let order: Vec<Sql> = built
      .order_by
      .iter()
      .map(|o| {
        if one_to_many.contains(&o.column.table.as_str()) {
          let (func, dir) = if o.is_asc { ("min", "asc") } else { ("max", "desc") };
          let mut s = Sql::raw(format!("{func}("));
          s.push(&o.column.qualified()).push_str(") ").push_str(dir);
          s
        } else {
          o.expr.clone()
        }
      })
      .collect();
    if !order.is_empty() {
      q.push_str(" order by ").push(&Sql::join(order.iter(), ", "));
    }
    push_limit_offset(&mut q, limit, Some(offset));
    distinct_result =
      Some(query_cells(conn, &q)?.into_iter().map(|row| decode_id(row, Some(0))).collect::<Result<Vec<_>>>()?);
    trace.distinct = Some(q);
  } else if !built.joins.is_empty() {
    let id_index = select_fields.keys().position(|k| k == "id");
    let mut q = Sql::raw("select distinct ");
    q.push(&render_selection(select_fields.values(), false)).push_str(" from ").push(&main_from);
    q.push(&render_joins(&built.joins));
    if let Some(w) = &built.where_ {
      q.push_str(" where ").push(w);
    }
    if !built.order_by.is_empty() {
      let exprs: Vec<Sql> = built.order_by.iter().map(|o| o.expr.clone()).collect();
      q.push_str(" order by ").push(&Sql::join(exprs.iter(), ", "));
    }
    push_limit_offset(&mut q, limit, Some(offset));
    let rows = query_cells(conn, &q)?;
    distinct_result = Some(rows.into_iter().map(|row| decode_id(row, id_index)).collect::<Result<Vec<_>>>()?);
    trace.distinct = Some(q);
  }

  let mut ordered_id_map: IndexMap<String, usize> = IndexMap::new();
  let mut ordered_ids_len = None;
  match &distinct_result {
    Some(ids) if ids.is_empty() => {
      return Ok(FindManyResult {
        docs: Vec::new(),
        has_next_page: false,
        has_prev_page: false,
        limit,
        next_page: None,
        page: 1.0,
        paging_counter: 0.0,
        prev_page: None,
        total_docs: 0.0,
        total_pages: 0.0,
      });
    }
    Some(ids) => {
      for (i, id) in ids.iter().enumerate() {
        ordered_id_map.insert(js_key(id), i);
      }
      let ordered_ids = js_object_key_order(ordered_id_map.keys().cloned().collect());
      ordered_ids_len = Some(ordered_ids.len() as f64);
      let params: Vec<Json> = ordered_ids.into_iter().map(Json::String).collect();
      find_many_args.where_ = Some(sql::in_array(&Sql::column(&main_table.ts_name, &id_column.name), &params));
    }
    None => {
      find_many_args.limit = limit;
      find_many_args.offset = Some(offset);
      find_many_args.order_by = Some(
        built.order_by.iter().map(|o| OrderBy::Sql(o.expr_rqb.clone().unwrap_or_else(|| o.expr.clone()))).collect(),
      );
      if let Some(w) = built.where_rqb.as_ref().or(built.where_.as_ref()) {
        find_many_args.where_ = Some(w.clone());
      }
    }
  }

  let relational = build_relational_query(ctx.schema, args.table_name, &find_many_args, Mode::Many)?;

  let mut total_docs = f64::NAN;
  let mut total_pages = f64::NAN;
  let mut has_prev_page = false;
  let mut has_next_page = false;
  let mut paging_counter = f64::NAN;
  let mut counted = false;

  if pagination != Some(false) && ordered_ids_len.is_none_or(|len| js_lt_eq(len, limit)) {
    let count_sql = if built.joins.is_empty() {
      let mut q = Sql::raw("select count(*) from ");
      q.push(&main_from);
      if let Some(w) = &built.where_ {
        q.push_str(" where ").push(w);
      }
      q
    } else {
      let mut q = Sql::raw("select COUNT(1) OVER() from ");
      q.push(&main_from).push(&render_joins(&built.joins));
      if let Some(w) = &built.where_ {
        q.push_str(" where ").push(w);
      }
      q.push_str(" group by ").push(&main_id);
      push_limit_offset(&mut q, Some(1.0), None);
      q
    };
    let rows = query_cells(conn, &count_sql)?;
    // `Number(countResult?.[0]?.count ?? 0)` (`count()` maps with `Number`).
    let count = rows.first().and_then(|r| r.first()).map(|c| Driver::from_cell(c).into_js()).unwrap_or(JsVal::Null);
    total_docs = if count.is_nullish() { 0.0 } else { js_number_of(&count) };
    trace.count = Some(count_sql);
    counted = true;

    total_pages = match limit {
      Some(l) if l != 0.0 => (total_docs / l).ceil(),
      _ => 1.0,
    };
    has_prev_page = page > 1.0;
    has_next_page = total_pages > page;
    paging_counter = (page - 1.0) * limit.unwrap_or(f64::NAN) + 1.0;
  }

  let raw = execute_js(conn, &relational, Mode::Many, host)?;
  trace.relational = Some(relational.sql.clone());
  let mut raw_docs = raw.as_arr().map(<[JsVal]>::to_vec).unwrap_or_default();
  if !ordered_id_map.is_empty() {
    raw_docs.sort_by(|a, b| {
      let ia = ordered_id_map.get(&js_key(a.get("id"))).map(|i| *i as f64).unwrap_or(f64::NAN);
      let ib = ordered_id_map.get(&js_key(b.get("id"))).map(|i| *i as f64).unwrap_or(f64::NAN);
      ia.partial_cmp(&ib).unwrap_or(std::cmp::Ordering::Equal)
    });
  }

  if pagination == Some(false) || !counted || total_docs == 0.0 || total_docs.is_nan() {
    total_docs = raw_docs.len() as f64;
    total_pages = 1.0;
    paging_counter = 1.0;
    has_prev_page = false;
    has_next_page = false;
  }

  trace.raw_docs = raw_docs.iter().map(JsVal::to_json).collect();
  let docs = raw_docs.into_iter().map(|doc| transform(doc)).collect::<Result<Vec<_>>>()?;

  Ok(FindManyResult {
    docs,
    has_next_page,
    has_prev_page,
    limit: args.limit,
    next_page: if has_next_page { Some(page + 1.0) } else { None },
    page,
    paging_counter,
    prev_page: if has_prev_page { Some(page - 1.0) } else { None },
    total_docs,
    total_pages,
  })
}

/// JS property key of a value (`String(value)`).
fn js_key(value: &JsVal) -> String {
  js_string_of(value)
}
