//! Statement rendering for find/count, mirroring how `find/findMany.ts`,
//! `queries/selectDistinct.ts` and `sqlite/countDistinct.ts` use a [`BuildQueryResult`].

use std::collections::{HashMap, HashSet};
use std::hash::Hash;

use payload_engine::error::Result;
use payload_engine::js::JsVal;

use crate::adapter::{QueryAdapter, type_error};
use crate::build_query::{BuildQueryResult, Order};
use crate::sql::{Chunk, Expr, Join, Select, Sql, expr_sql, selection_sql};

/// How the ids returned by [`find_ids_select`] must be post-processed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdRows {
  /// One row per document, already in order (no joins: drizzle relational `findMany`).
  Ordered,
  /// Rows may repeat an id (`selectDistinct` / group query); apply [`ordered_unique_ids`].
  Distinct,
}

/// The statement `findMany` runs to get the ordered page of ids.
#[derive(Clone, Debug)]
pub struct FindIdsSelect {
  pub select: Select,
  pub rows: IdRows,
}

fn num_param(n: f64) -> Sql {
  Sql::new(vec![Chunk::Value(JsVal::Num(n))])
}

/// Removes select fields that are neither primary keys nor order-by columns, like `findMany`.
pub fn prune_select_fields(result: &mut BuildQueryResult) {
  let order_by = &result.order_by;
  result.select_fields.retain(|_, column| match column {
    None => true,
    Some(Expr::Col(c)) if c.primary => true,
    Some(Expr::Col(c)) => order_by.iter().any(|o| o.column.name == c.name && o.column.table.ref_name() == c.table.ref_name()),
    Some(Expr::Sql(_)) => false,
  });
}

/// `limit`/`offset` like drizzle's SQLite dialect: `limit` only when `>= 0`, `offset` only when truthy.
fn apply_paging(select: &mut Select, limit: Option<f64>, offset: Option<f64>) {
  if let Some(l) = limit.filter(|l| *l >= 0.0) {
    select.limit = Some(num_param(l));
  }
  if let Some(o) = offset.filter(|o| *o != 0.0 && !o.is_nan()) {
    // Without a limit this renders `... offset ?`, which SQLite rejects like it does for drizzle.
    select.offset = Some(num_param(o));
  }
}

/// Builds the id query of `findMany` (`page` / `limit` already turned into `limit` / `offset`).
/// Call [`prune_select_fields`] first, as `findMany` does.
pub fn find_ids_select(
  adapter: &QueryAdapter,
  result: &BuildQueryResult,
  table_name: &str,
  limit: Option<f64>,
  offset: Option<f64>,
) -> Result<FindIdsSelect> {
  let main = adapter.table_req(Some(table_name), "id")?;
  crate::sql::check_join_aliases(&result.joins)?;
  let main_id = adapter.col(&main, "id");
  let id_sql = || main_id.as_ref().map(selection_sql).unwrap_or_default();

  let one_to_many: HashSet<&str> = result.joins.iter().filter(|j| j.is_one_to_many).map(|j| j.table.ref_name()).collect();
  let has_sort_on_one_to_many =
    !one_to_many.is_empty() && result.order_by.iter().any(|o| one_to_many.contains(o.column.table.ref_name()));

  if has_sort_on_one_to_many {
    let order_by = result
      .order_by
      .iter()
      .map(|o| {
        if one_to_many.contains(o.column.table.ref_name()) {
          let col = Expr::Col(o.column.clone()).clone();
          if matches!(o.order, Order::Asc) {
            Sql::new(vec![Chunk::Str("min(".into()), Chunk::Sql(expr_sql(&col)), Chunk::Str(") asc".into())])
          } else {
            Sql::new(vec![Chunk::Str("max(".into()), Chunk::Sql(expr_sql(&col)), Chunk::Str(") desc".into())])
          }
        } else {
          o.to_sql()
        }
      })
      .collect();
    let mut select = Select {
      fields: vec![id_sql()],
      from: Some(main.clone()),
      joins: result.joins.clone(),
      where_: result.where_.clone(),
      group_by: vec![id_sql()],
      order_by,
      ..Select::default()
    };
    apply_paging(&mut select, limit, offset);
    return Ok(FindIdsSelect { select, rows: IdRows::Distinct });
  }

  if !result.joins.is_empty() {
    let mut fields = Vec::new();
    for (_, field) in &result.select_fields {
      match field {
        Some(e) => fields.push(selection_sql(e)),
        None => return Err(type_error("Cannot convert undefined or null to object")),
      }
    }
    let mut select = Select {
      distinct: true,
      fields,
      from: Some(main.clone()),
      joins: result.joins.clone(),
      where_: result.where_.clone(),
      order_by: result.order_by.iter().map(|o| o.to_sql()).collect(),
      ..Select::default()
    };
    apply_paging(&mut select, limit, offset);
    return Ok(FindIdsSelect { select, rows: IdRows::Distinct });
  }

  let mut select = Select {
    fields: vec![id_sql()],
    from: Some(main),
    where_: result.where_.clone(),
    order_by: result.order_by.iter().map(|o| o.to_sql()).collect(),
    ..Select::default()
  };
  apply_paging(&mut select, limit, offset);
  Ok(FindIdsSelect { select, rows: IdRows::Ordered })
}

/// `String(id)`: the key of `orderedIDMap` in `findMany`.
pub fn js_id_key(id: &JsVal) -> String {
  crate::js_ops::js_string(id)
}

/// The second `findMany` step after a [`IdRows::Distinct`] id query:
/// `db.query[tableName].findMany({ where: inArray(table.id, Object.keys(orderedIDMap)) })`.
/// `keys` are [`js_id_key`]s from [`ordered_unique_ids`]; returned documents must then be sorted by
/// the position of their id key in `keys`.
pub fn docs_by_ids_select(adapter: &QueryAdapter, table_name: &str, keys: &[String]) -> Result<Select> {
  let main = adapter.table_req(Some(table_name), "id")?;
  let id = adapter.col(&main, "id");
  let values = JsVal::arr(keys.iter().map(|k| JsVal::str(k.as_str())).collect());
  Ok(Select {
    fields: vec![id.as_ref().map(selection_sql).unwrap_or_default()],
    from: Some(main),
    where_: Some(crate::sql::in_array(id.as_ref(), values)),
    ..Select::default()
  })
}

/// `orderedIDMap` semantics of `findMany`: every id keeps the index of its last row.
pub fn ordered_unique_ids<T: Clone + Eq + Hash>(ids: &[T]) -> Vec<T> {
  let mut last: HashMap<&T, usize> = HashMap::new();
  for (i, id) in ids.iter().enumerate() {
    last.insert(id, i);
  }
  let mut unique: Vec<(&T, usize)> = last.into_iter().collect();
  unique.sort_by_key(|(_, i)| *i);
  unique.into_iter().map(|(id, _)| id.clone()).collect()
}

/// `countDistinct({ column, joins, tableName, where })` (SQLite)
pub fn count_select(
  adapter: &QueryAdapter,
  column: Option<&Expr>,
  joins: &[Join],
  where_: Option<&Sql>,
  table_name: &str,
) -> Result<Select> {
  let main = adapter.table_req(Some(table_name), "id")?;
  crate::sql::check_join_aliases(joins)?;
  if joins.is_empty() {
    let count = match column {
      Some(c) => Sql::new(vec![Chunk::Str("count(DISTINCT ".into()), Chunk::Sql(expr_sql(c)), Chunk::Str(")".into())]),
      None => Sql::raw("count(*)"),
    };
    return Ok(Select { fields: vec![count], from: Some(main), where_: where_.cloned(), ..Select::default() });
  }
  let group = match column {
    Some(c) => expr_sql(c),
    None => adapter.col(&main, "id").map(|e| expr_sql(&e)).unwrap_or_default(),
  };
  Ok(Select {
    fields: vec![Sql::raw("COUNT(1) OVER()")],
    from: Some(main),
    joins: joins.to_vec(),
    where_: where_.cloned(),
    group_by: vec![group],
    limit: Some(num_param(1.0)),
    ..Select::default()
  })
}

/// The statements of `findDistinct` (`findDistinct.ts`).
#[derive(Clone, Debug)]
pub struct FindDistinctSelect {
  /// Selects `_selected` (and `_order` when sorting by another column) per distinct value.
  pub select: Select,
  /// The `totalDocs` query, only run when `limit` is truthy.
  pub count: Option<Select>,
}

/// `findDistinct`'s queries for a [`BuildQueryResult`] built with the `where`
/// `{ and: [where ?? {}, { [field]: { equals: WhereVal::Distinct } }] }` and `sort ?? field`.
/// `limit` / `page` are the raw `args.limit` / `args.page`.
pub fn find_distinct_select(
  adapter: &QueryAdapter,
  mut result: BuildQueryResult,
  table_name: &str,
  limit: Option<f64>,
  page: Option<f64>,
) -> Result<FindDistinctSelect> {
  let main = adapter.table_req(Some(table_name), "id")?;
  crate::sql::check_join_aliases(&result.joins)?;
  let limit = limit.filter(|l| *l != 0.0 && !l.is_nan());
  let page = page.filter(|p| *p != 0.0 && !p.is_nan()).unwrap_or(1.0);
  let offset = limit.map(|l| (page - 1.0) * l);

  result.order_by.pop();
  let selected = result.select_fields.get("_selected").cloned().flatten();
  let has_joins = !result.joins.is_empty();

  // `getOrderColumn(orderBy, selectFields, joins)`
  let order_column: Option<Sql> = match result.order_by.first() {
    None => None,
    Some(first) if matches!(&selected, Some(Expr::Col(c)) if c.same(&first.column)) => None,
    Some(first) if has_joins => Some(expr_sql(&Expr::Col(first.column.clone()))),
    Some(first) => Some(Sql::new(vec![
      Chunk::Str("max(".into()),
      Chunk::Col(first.column.clone()),
      Chunk::Str(") as \"_order\"".into()),
    ])),
  };
  let has_aggregates = order_column.is_some() && !has_joins;

  // `orderSelectedFields({ _selected, _order })`: `undefined` fields throw.
  let Some(selected_expr) = selected.clone() else {
    return Err(type_error("Cannot convert undefined or null to object"));
  };
  let mut fields = vec![selection_sql(&selected_expr)];
  if let Some(order) = &order_column {
    fields.push(order.clone());
  }
  let order_by = match (&order_column, result.order_by.first()) {
    (Some(_), Some(first)) if !has_joins => vec![match first.order {
      Order::Asc => Sql::raw("_order asc"),
      Order::Desc => Sql::raw("_order desc"),
      Order::Raw(ref raw) => raw.clone(),
    }],
    _ => result.order_by.iter().map(|o| o.to_sql()).collect(),
  };
  let mut select = Select {
    distinct: !has_aggregates,
    fields,
    from: Some(main),
    joins: result.joins.clone(),
    where_: result.where_.clone(),
    group_by: if has_aggregates { vec![expr_sql(&selected_expr)] } else { Vec::new() },
    order_by,
    ..Select::default()
  };
  if let Some(l) = limit {
    if let Some(o) = offset.filter(|o| *o != 0.0 && !o.is_nan()) {
      select.offset = Some(num_param(o));
    }
    if l >= 0.0 {
      select.limit = Some(num_param(l));
    }
  }
  let count = match limit {
    Some(_) => Some(count_select(adapter, selected.as_ref(), &result.joins, result.where_.as_ref(), table_name)?),
    None => None,
  };
  Ok(FindDistinctSelect { select, count })
}
