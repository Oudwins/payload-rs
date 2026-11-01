//! `utilities/aggregatePaginate.ts`

use payload_engine::js::{JsVal, Obj};

use crate::context::Call;
use crate::host::{HostOp, ModelCall, ModelRef, MongoResult, host_op, join_all};
use crate::util::{object_keys_len, obj, to_number};

pub struct AggregatePaginateArgs<'a> {
  pub collation: JsVal,
  pub join_aggregation: Option<Vec<JsVal>>,
  pub limit: JsVal,
  pub model: &'a ModelRef,
  pub page: JsVal,
  pub pagination: JsVal,
  pub projection: JsVal,
  pub query: JsVal,
  pub session: JsVal,
  pub sort: JsVal,
  pub sort_aggregation: Option<Vec<JsVal>>,
  pub use_estimated_count: JsVal,
}

pub async fn aggregate_paginate(call: &Call<'_>, args: AggregatePaginateArgs<'_>) -> MongoResult<JsVal> {
  let AggregatePaginateArgs {
    collation,
    join_aggregation,
    limit,
    model,
    page,
    pagination,
    projection,
    query,
    session,
    sort,
    sort_aggregation,
    use_estimated_count,
  } = args;
  let mut aggregation = vec![obj([("$match", query.clone())])];
  if let Some(stages) = &sort_aggregation {
    aggregation.extend(stages.iter().cloned());
  }
  if sort.truthy() {
    let mut sort_stage = Obj::new();
    for (key, value) in object_entries(&sort) {
      let direction = if value.as_str() == Some("desc") { -1.0 } else { 1.0 };
      sort_stage.insert(key, JsVal::Num(direction));
    }
    aggregation.push(obj([("$sort", JsVal::obj(sort_stage))]));
  }
  if page.truthy() {
    let limit_or_zero = if limit.is_nullish() { 0.0 } else { to_number(&limit) };
    aggregation.push(obj([("$skip", JsVal::Num((to_number(&page) - 1.0) * limit_or_zero))]));
  }
  if limit.truthy() {
    aggregation.push(obj([("$limit", limit.clone())]));
  }
  if let Some(stages) = &join_aggregation {
    aggregation.extend(stages.iter().cloned());
  }
  if projection.truthy() {
    aggregation.push(obj([("$project", projection.clone())]));
  }

  let pagination_disabled = matches!(pagination, JsVal::Bool(false));
  let mut count_op = None;
  if !pagination_disabled && limit.truthy() {
    if use_estimated_count.truthy() {
      count_op = Some(ModelCall::new(model, "estimatedDocumentCount", vec![query.clone()]));
    } else {
      let hint = call.ctx.index_hints_enabled() && object_keys_len(&query)? == 0;
      let mut options = Obj::new();
      options.insert("collation".into(), collation.clone());
      options.insert("session".into(), session.clone());
      if hint {
        options.insert("hint".into(), obj([("_id", JsVal::Num(1.0))]));
      }
      count_op = Some(ModelCall::new(model, "countDocuments", vec![query.clone(), JsVal::obj(options)]));
    }
  }
  // `Model.countDocuments(...)` is called before `Model.aggregate(...)` (both run once awaited)
  let count_future = count_op.map(|op| host_op(call.host, &HostOp::Model(op)));
  let aggregate_options = obj([("collation", collation.clone()), ("session", session.clone())]);
  let docs_future =
    host_op(call.host, &HostOp::Model(ModelCall::new(model, "aggregate", vec![JsVal::arr(aggregation), aggregate_options])));
  let count_future = count_future.unwrap_or_else(|| Box::pin(async { Ok(JsVal::Null) }));
  let mut results = join_all(vec![docs_future, count_future]).await?;
  let count_result = results.pop().unwrap_or_default();
  let docs = results.pop().unwrap_or_default();

  let count = if count_result.is_null() { JsVal::Num(docs.as_arr().map_or(0, <[JsVal]>::len) as f64) } else { count_result };
  let limit_is_number = matches!(limit, JsVal::Num(_));
  let total_pages = if !pagination_disabled && limit_is_number && !matches!(limit, JsVal::Num(n) if n == 0.0) {
    (to_number(&count) / to_number(&limit)).ceil()
  } else {
    1.0
  };
  let page_number = match page {
    JsVal::Num(n) => Some(n),
    _ => None,
  };
  let has_prev_page = page_number.is_some_and(|p| !pagination_disabled && p > 1.0);
  let has_next_page = page_number.is_some_and(|p| !pagination_disabled && total_pages > p);
  let paging_counter = match page_number {
    Some(p) if !pagination_disabled && limit_is_number => (p - 1.0) * to_number(&limit) + 1.0,
    _ => 1.0,
  };
  let mut result = Obj::new();
  result.insert("docs".into(), docs);
  result.insert("hasNextPage".into(), JsVal::Bool(has_next_page));
  result.insert("hasPrevPage".into(), JsVal::Bool(has_prev_page));
  result.insert("limit".into(), if limit.is_nullish() { JsVal::Num(0.0) } else { limit.clone() });
  result.insert(
    "nextPage".into(),
    if has_next_page { JsVal::Num(page_number.unwrap_or_default() + 1.0) } else { JsVal::Null },
  );
  result.insert("page".into(), page.clone());
  result.insert("pagingCounter".into(), JsVal::Num(paging_counter));
  result.insert(
    "prevPage".into(),
    if has_prev_page { JsVal::Num(page_number.unwrap_or_default() - 1.0) } else { JsVal::Null },
  );
  result.insert("totalDocs".into(), count);
  result.insert("totalPages".into(), JsVal::Num(total_pages));
  Ok(JsVal::obj(result))
}

/// `Object.entries(value)` of a plain object.
fn object_entries(value: &JsVal) -> Vec<(String, JsVal)> {
  match value {
    JsVal::Obj(o) if value.typed().is_none() && value.bson().is_none() => {
      o.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }
    JsVal::Arr(a) => a.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
    _ => Vec::new(),
  }
}
