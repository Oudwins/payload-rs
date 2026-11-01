//! What the data methods take from the other `db-mongodb` modules, ported by the sibling crates
//! (payload-mongo-query: `queries/*` + `buildProjectionFromSelect`; payload-mongo-transform:
//! `utilities/transform.ts`; payload-mongo-joins: `buildJoinAggregation` / `resolveJoins`;
//! payload-mongo-schema: `models/*`). The signatures mirror the TS functions; `adapter` and
//! `payload` are the [`Call`].

#![allow(async_fn_in_trait)]

use payload_engine::js::{JsVal, Obj};

use crate::context::{Call, Graph};
use crate::host::MongoResult;

/// `buildQuery({ adapter, collectionSlug, fields, globalSlug, locale, where })`
pub struct BuildQueryArgs<'a> {
  pub collection_slug: Option<&'a str>,
  pub fields: &'a JsVal,
  pub global_slug: Option<&'a str>,
  pub locale: &'a JsVal,
  pub where_: &'a JsVal,
}

/// `buildSortParam({ adapter, config, fields, locale, sort, sortAggregation, timestamps, versions })`
pub struct SortParamArgs<'a> {
  pub fields: &'a JsVal,
  pub locale: &'a JsVal,
  pub sort: &'a JsVal,
  pub timestamps: bool,
  pub versions: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
  Read,
  Write,
}

/// The `$inc` / `$push` / `$addToSet` / `$pull` objects the write transform fills.
#[derive(Clone, Debug, Default)]
pub struct UpdateOps {
  pub inc: Obj,
  pub push: Obj,
  pub add_to_set: Obj,
  pub pull: Obj,
}

/// `transform({ $addToSet, $inc, $pull, $push, adapter, data, fields, globalSlug, operation })`
pub struct TransformArgs<'a> {
  pub data: &'a mut JsVal,
  pub fields: &'a JsVal,
  pub global_slug: Option<&'a str>,
  pub operation: Operation,
  pub update_ops: Option<&'a mut UpdateOps>,
}

/// `buildJoinAggregation({ adapter, collection, collectionConfig, draftsEnabled, joins, locale,
/// projection, query, versions })`
pub struct JoinAggregationArgs<'a> {
  pub collection: &'a str,
  pub collection_config: &'a JsVal,
  pub drafts_enabled: &'a JsVal,
  pub joins: &'a JsVal,
  pub locale: &'a JsVal,
  pub projection: &'a JsVal,
  pub query: &'a JsVal,
  pub versions: bool,
}

/// `resolveJoins({ adapter, collectionSlug, docs, joins, locale, versions })`
pub struct ResolveJoinsArgs<'a> {
  pub collection_slug: &'a str,
  pub docs: &'a mut JsVal,
  pub joins: &'a JsVal,
  pub locale: &'a JsVal,
  pub versions: bool,
}

pub trait Components {
  /// `await buildQuery(...)`
  async fn build_query(&self, call: &Call<'_>, args: BuildQueryArgs<'_>) -> MongoResult<JsVal>;

  /// `buildSortParam(...)`; `sort_aggregation` is the `sortAggregation` array when the TS passes
  /// one (stages are pushed into it).
  fn build_sort_param(
    &self,
    call: &Call<'_>,
    args: SortParamArgs<'_>,
    sort_aggregation: Option<&mut Vec<JsVal>>,
  ) -> MongoResult<JsVal>;

  /// `buildProjectionFromSelect({ adapter, fields, select })` (`undefined` without `select`).
  fn build_projection_from_select(&self, call: &Call<'_>, fields: &JsVal, select: &JsVal) -> MongoResult<JsVal>;

  /// `transform(...)`: mutates `data` (and fills the update operators).
  fn transform(&self, call: &Call<'_>, args: TransformArgs<'_>) -> MongoResult<()>;

  /// `await buildJoinAggregation(...)`
  async fn build_join_aggregation(&self, call: &Call<'_>, args: JoinAggregationArgs<'_>) -> MongoResult<Vec<JsVal>>;

  /// `await resolveJoins(...)`: mutates `docs`.
  async fn resolve_joins(&self, call: &Call<'_>, args: ResolveJoinsArgs<'_>) -> MongoResult<()>;

  /// The schema description TS builds the mongoose schemas from (`host`: config functions).
  fn schema_description(&self, graph: &Graph, host: &dyn payload_engine::host::Host) -> MongoResult<serde_json::Value>;
}
