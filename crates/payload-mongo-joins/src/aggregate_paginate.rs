//! `aggregatePaginate` (packages/db-mongodb/src/utilities/aggregatePaginate.ts): the find
//! aggregation (`$match`, sort stages, `$skip` / `$limit`, joins, `$project`) with the count query
//! and the pagination math of `PaginatedDocs`.

use payload_engine::error::Result;
use payload_engine::js::JsVal;

use crate::env::{JoinsEnv, ModelOp, ModelRef, join2};
use crate::util::{add, div, gt, is_str, mul, num, nullish_or, obj, object_entries, object_keys, sub};

pub struct AggregatePaginateArgs<'a> {
  pub collation: &'a JsVal,
  pub join_aggregation: Option<&'a [JsVal]>,
  pub limit: &'a JsVal,
  pub model: &'a ModelRef,
  pub page: &'a JsVal,
  pub pagination: &'a JsVal,
  pub projection: &'a JsVal,
  pub query: &'a JsVal,
  pub session: &'a JsVal,
  pub sort: &'a JsVal,
  pub sort_aggregation: Option<&'a [JsVal]>,
  pub use_estimated_count: &'a JsVal,
}

/// The aggregation pipeline `aggregatePaginate` runs.
pub fn build_aggregate_paginate_pipeline(args: &AggregatePaginateArgs<'_>) -> Result<Vec<JsVal>> {
  let mut aggregation = vec![obj([("$match", args.query.clone())])];

  if let Some(stages) = args.sort_aggregation.filter(|stages| !stages.is_empty()) {
    aggregation.extend(stages.iter().cloned());
  }

  if args.sort.truthy() {
    let mut sort = Vec::new();
    for (key, value) in object_entries(args.sort)? {
      sort.push((key, num(if is_str(&value, "desc") { -1.0 } else { 1.0 })));
    }
    aggregation.push(obj([("$sort", obj(sort))]));
  }

  if args.page.truthy() {
    let limit = nullish_or(args.limit.clone(), || Ok(num(0.0)))?;
    aggregation.push(obj([("$skip", num(mul(&num(sub(args.page, &num(1.0))?), &limit)?))]));
  }

  if args.limit.truthy() {
    aggregation.push(obj([("$limit", args.limit.clone())]));
  }

  if let Some(stages) = args.join_aggregation {
    aggregation.extend(stages.iter().cloned());
  }

  if args.projection.truthy() {
    aggregation.push(obj([("$project", args.projection.clone())]));
  }

  Ok(aggregation)
}

/// The count query `aggregatePaginate` runs next to the aggregation, `None` for
/// `Promise.resolve(null)`.
pub fn build_aggregate_paginate_count<E: JoinsEnv>(env: &E, args: &AggregatePaginateArgs<'_>) -> Result<Option<ModelOp>> {
  if matches!(args.pagination, JsVal::Bool(false)) || !args.limit.truthy() {
    return Ok(None);
  }
  if args.use_estimated_count.truthy() {
    return Ok(Some(ModelOp::new(args.model.clone(), "estimatedDocumentCount", vec![args.query.clone()])));
  }
  let hint = !env.disable_index_hints().is_true() && object_keys(args.query)?.is_empty();
  let mut options = vec![("collation", args.collation.clone()), ("session", args.session.clone())];
  if hint {
    options.push(("hint", obj([("_id", num(1.0))])));
  }
  Ok(Some(ModelOp::new(args.model.clone(), "countDocuments", vec![args.query.clone(), obj(options)])))
}

/// `aggregatePaginate(args)`
pub async fn aggregate_paginate<E: JoinsEnv>(env: &E, args: &AggregatePaginateArgs<'_>) -> Result<JsVal> {
  let aggregation = build_aggregate_paginate_pipeline(args)?;
  let count_op = build_aggregate_paginate_count(env, args)?;

  // `Promise.all([Model.aggregate(...), countPromise])`: both are lazy mongoose queries, run in
  // that order when `Promise.all` subscribes to them.
  let aggregate = env.model_op(ModelOp::new(
    args.model.clone(),
    "aggregate",
    vec![JsVal::arr(aggregation), obj([("collation", args.collation.clone()), ("session", args.session.clone())])],
  ));
  let count = async {
    match count_op {
      Some(op) => env.model_op(op).await,
      None => Ok(JsVal::Null),
    }
  };
  let (docs, count_result) = join2(aggregate, count).await?;

  paginated_docs(docs, count_result, args.limit, args.page, args.pagination)
}

/// The `PaginatedDocs` object `aggregatePaginate` builds from the aggregation result and count.
pub fn paginated_docs(docs: JsVal, count_result: JsVal, limit: &JsVal, page: &JsVal, pagination: &JsVal) -> Result<JsVal> {
  let count = if count_result.is_null() { crate::util::get(&docs, "length") } else { count_result };
  let paginated = !matches!(pagination, JsVal::Bool(false));
  let page_is_number = matches!(page, JsVal::Num(_));

  let total_pages = match limit {
    JsVal::Num(l) if paginated && *l != 0.0 => num(div(&count, limit)?.ceil()),
    _ => num(1.0),
  };
  let has_prev_page = page_is_number && paginated && gt(page, &num(1.0))?;
  let has_next_page = page_is_number && paginated && gt(&total_pages, page)?;
  let paging_counter = if page_is_number && paginated && matches!(limit, JsVal::Num(_)) {
    add(&num(mul(&num(sub(page, &num(1.0))?), limit)?), &num(1.0))?
  } else {
    num(1.0)
  };

  Ok(obj([
    ("docs", docs),
    ("hasNextPage", JsVal::Bool(has_next_page)),
    ("hasPrevPage", JsVal::Bool(has_prev_page)),
    ("limit", nullish_or(limit.clone(), || Ok(num(0.0)))?),
    ("nextPage", if has_next_page { add(page, &num(1.0))? } else { JsVal::Null }),
    ("page", page.clone()),
    ("pagingCounter", paging_counter),
    ("prevPage", if has_prev_page { num(sub(page, &num(1.0))?) } else { JsVal::Null }),
    ("totalDocs", count),
    ("totalPages", total_pages),
  ]))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::util::{get, s};

  #[test]
  fn pagination_math() {
    let docs = JsVal::arr(vec![s("a"), s("b")]);
    let out = paginated_docs(docs.clone(), num(25.0), &num(10.0), &num(2.0), &JsVal::Undefined).unwrap();
    assert_eq!(get(&out, "totalPages").as_num(), Some(3.0));
    assert!(get(&out, "hasNextPage").is_true());
    assert!(get(&out, "hasPrevPage").is_true());
    assert_eq!(get(&out, "nextPage").as_num(), Some(3.0));
    assert_eq!(get(&out, "prevPage").as_num(), Some(1.0));
    assert_eq!(get(&out, "pagingCounter").as_num(), Some(11.0));

    let out = paginated_docs(docs, JsVal::Null, &JsVal::Undefined, &JsVal::Undefined, &JsVal::Bool(false)).unwrap();
    assert_eq!(get(&out, "totalDocs").as_num(), Some(2.0));
    assert_eq!(get(&out, "limit").as_num(), Some(0.0));
    assert!(crate::util::in_op("page", &out) && get(&out, "page").is_undefined());
  }
}
