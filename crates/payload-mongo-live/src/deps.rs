//! The db-mongodb functions the read methods call that other live crates own:
//! `buildQuery`, `buildSortParam`, `buildProjectionFromSelect` (payload-mongo-live-query),
//! `transform` (payload-mongo-live-transform), `buildJoinAggregation`, `resolveJoins`
//! (payload-mongo-live-joins).
//!
//! Those crates depend on this one (shared helpers), so they cannot be called directly: each
//! registers its entry point here once (`register_*`, called from `payload-node`'s
//! `mongo_live.rs` before the binding is used). Until a port is registered, the entry calls
//! upstream's own TS function through the host (`upstream.<name>(args literal)`), so the read
//! methods are exact by construction meanwhile and the differentials isolate them.
//!
//! Signatures follow the TS functions: the args object literal becomes a struct of live values
//! (`Val::Undefined` = the key is absent or `undefined`: every callee destructures, so the two are
//! indistinguishable); an `async` function returns the promise of its call (a spawned task; the
//! caller awaits it with `await_js` exactly where the TS awaits); a sync function returns its value.

use std::cell::Cell;

use payload_core_runtime::js::{JsResult, Local, Val};

use crate::host::{call, literal};

/// `buildQuery({ adapter, collectionSlug, fields, globalSlug, locale, where })` (async).
pub struct BuildQueryArgs {
  pub adapter: Val,
  pub collection_slug: Val,
  pub fields: Val,
  pub global_slug: Val,
  pub locale: Val,
  pub where_: Val,
}

/// `buildSortParam({ adapter, config, fields, locale, parentIsLocalized, sort, sortAggregation,
/// timestamps, versions })` (sync; pushes into the caller's `sortAggregation` array and may push
/// into a caller's `sort` array, in place).
pub struct BuildSortParamArgs {
  pub adapter: Val,
  pub config: Val,
  pub fields: Val,
  pub locale: Val,
  pub parent_is_localized: Val,
  pub sort: Val,
  pub sort_aggregation: Val,
  pub timestamps: Val,
  pub versions: Val,
}

/// `buildProjectionFromSelect({ adapter, fields, select })` (sync).
pub struct BuildProjectionFromSelectArgs {
  pub adapter: Val,
  pub fields: Val,
  pub select: Val,
}

/// `transform({ $addToSet, $inc, $pull, $push, adapter, data, fields, globalSlug, operation,
/// parentIsLocalized, validateRelationships })` (sync, mutates `data` in place).
pub struct TransformArgs {
  pub add_to_set: Val,
  pub inc: Val,
  pub pull: Val,
  pub push: Val,
  pub adapter: Val,
  pub data: Val,
  pub fields: Val,
  pub global_slug: Val,
  pub operation: Val,
  pub parent_is_localized: Val,
  pub validate_relationships: Val,
}

/// `buildJoinAggregation({ adapter, collection, collectionConfig, draftsEnabled, joins, locale,
/// projection, query, versions })` (async).
pub struct BuildJoinAggregationArgs {
  pub adapter: Val,
  pub collection: Val,
  pub collection_config: Val,
  pub drafts_enabled: Val,
  pub joins: Val,
  pub locale: Val,
  pub projection: Val,
  pub query: Val,
  pub versions: Val,
}

/// `resolveJoins({ adapter, collectionSlug, docs, joins, locale, projection, versions })` (async).
pub struct ResolveJoinsArgs {
  pub adapter: Val,
  pub collection_slug: Val,
  pub docs: Val,
  pub joins: Val,
  pub locale: Val,
  pub projection: Val,
  pub versions: Val,
}

pub type BuildQueryFn = fn(BuildQueryArgs) -> JsResult<Local>;
pub type BuildSortParamFn = fn(BuildSortParamArgs) -> JsResult<Local>;
pub type BuildProjectionFromSelectFn = fn(BuildProjectionFromSelectArgs) -> JsResult<Local>;
pub type TransformFn = fn(TransformArgs) -> JsResult<Local>;
pub type BuildJoinAggregationFn = fn(BuildJoinAggregationArgs) -> JsResult<Local>;
pub type ResolveJoinsFn = fn(ResolveJoinsArgs) -> JsResult<Local>;

thread_local! {
  static BUILD_QUERY: Cell<Option<BuildQueryFn>> = const { Cell::new(None) };
  static BUILD_SORT_PARAM: Cell<Option<BuildSortParamFn>> = const { Cell::new(None) };
  static BUILD_PROJECTION: Cell<Option<BuildProjectionFromSelectFn>> = const { Cell::new(None) };
  static TRANSFORM: Cell<Option<TransformFn>> = const { Cell::new(None) };
  static BUILD_JOIN_AGGREGATION: Cell<Option<BuildJoinAggregationFn>> = const { Cell::new(None) };
  static RESOLVE_JOINS: Cell<Option<ResolveJoinsFn>> = const { Cell::new(None) };
  /// Set by `init({ upstreamDeps: true })`: ignore registered ports (differential isolation).
  static FORCE_UPSTREAM: Cell<bool> = const { Cell::new(false) };
}

pub fn register_build_query(f: BuildQueryFn) {
  BUILD_QUERY.with(|c| c.set(Some(f)));
}
pub fn register_build_sort_param(f: BuildSortParamFn) {
  BUILD_SORT_PARAM.with(|c| c.set(Some(f)));
}
pub fn register_build_projection_from_select(f: BuildProjectionFromSelectFn) {
  BUILD_PROJECTION.with(|c| c.set(Some(f)));
}
pub fn register_transform(f: TransformFn) {
  TRANSFORM.with(|c| c.set(Some(f)));
}
pub fn register_build_join_aggregation(f: BuildJoinAggregationFn) {
  BUILD_JOIN_AGGREGATION.with(|c| c.set(Some(f)));
}
pub fn register_resolve_joins(f: ResolveJoinsFn) {
  RESOLVE_JOINS.with(|c| c.set(Some(f)));
}

/// Use upstream's TS functions even where a port is registered (harness isolation).
pub fn set_force_upstream(force: bool) {
  FORCE_UPSTREAM.with(|c| c.set(force));
}

/// Which entries run a registered Rust port (`[buildQuery, buildSortParam,
/// buildProjectionFromSelect, transform, buildJoinAggregation, resolveJoins]`).
pub fn ported() -> [bool; 6] {
  let force = FORCE_UPSTREAM.with(Cell::get);
  [
    !force && BUILD_QUERY.with(Cell::get).is_some(),
    !force && BUILD_SORT_PARAM.with(Cell::get).is_some(),
    !force && BUILD_PROJECTION.with(Cell::get).is_some(),
    !force && TRANSFORM.with(Cell::get).is_some(),
    !force && BUILD_JOIN_AGGREGATION.with(Cell::get).is_some(),
    !force && RESOLVE_JOINS.with(Cell::get).is_some(),
  ]
}

fn pick<F: Copy>(cell: &'static std::thread::LocalKey<Cell<Option<F>>>) -> Option<F> {
  if FORCE_UPSTREAM.with(Cell::get) {
    return None;
  }
  cell.with(Cell::get)
}

fn upstream(name: &str, args: Local) -> JsResult<Local> {
  call("upstream", &[payload_core_runtime::js::string(name), args])
}

/// `buildQuery(args)`: its promise.
pub fn build_query(a: BuildQueryArgs) -> JsResult<Local> {
  if let Some(f) = pick(&BUILD_QUERY) {
    return f(a);
  }
  let args = literal(&[
    ("adapter", a.adapter.get()),
    ("collectionSlug", a.collection_slug.get()),
    ("fields", a.fields.get()),
    ("globalSlug", a.global_slug.get()),
    ("locale", a.locale.get()),
    ("where", a.where_.get()),
  ])?;
  upstream("buildQuery", args)
}

/// `buildSortParam(args)`: the sort object.
pub fn build_sort_param(a: BuildSortParamArgs) -> JsResult<Local> {
  if let Some(f) = pick(&BUILD_SORT_PARAM) {
    return f(a);
  }
  let args = literal(&[
    ("adapter", a.adapter.get()),
    ("config", a.config.get()),
    ("fields", a.fields.get()),
    ("locale", a.locale.get()),
    ("parentIsLocalized", a.parent_is_localized.get()),
    ("sort", a.sort.get()),
    ("sortAggregation", a.sort_aggregation.get()),
    ("timestamps", a.timestamps.get()),
    ("versions", a.versions.get()),
  ])?;
  upstream("buildSortParam", args)
}

/// `buildProjectionFromSelect(args)`: the projection (or `undefined`).
pub fn build_projection_from_select(a: BuildProjectionFromSelectArgs) -> JsResult<Local> {
  if let Some(f) = pick(&BUILD_PROJECTION) {
    return f(a);
  }
  let args = literal(&[("adapter", a.adapter.get()), ("fields", a.fields.get()), ("select", a.select.get())])?;
  upstream("buildProjectionFromSelect", args)
}

/// `transform(args)`: its return value (`null` / `undefined`).
pub fn transform(a: TransformArgs) -> JsResult<Local> {
  if let Some(f) = pick(&TRANSFORM) {
    return f(a);
  }
  let args = literal(&[
    ("$addToSet", a.add_to_set.get()),
    ("$inc", a.inc.get()),
    ("$pull", a.pull.get()),
    ("$push", a.push.get()),
    ("adapter", a.adapter.get()),
    ("data", a.data.get()),
    ("fields", a.fields.get()),
    ("globalSlug", a.global_slug.get()),
    ("operation", a.operation.get()),
    ("parentIsLocalized", a.parent_is_localized.get()),
    ("validateRelationships", a.validate_relationships.get()),
  ])?;
  upstream("transform", args)
}

/// `buildJoinAggregation(args)`: its promise.
pub fn build_join_aggregation(a: BuildJoinAggregationArgs) -> JsResult<Local> {
  if let Some(f) = pick(&BUILD_JOIN_AGGREGATION) {
    return f(a);
  }
  let args = literal(&[
    ("adapter", a.adapter.get()),
    ("collection", a.collection.get()),
    ("collectionConfig", a.collection_config.get()),
    ("draftsEnabled", a.drafts_enabled.get()),
    ("joins", a.joins.get()),
    ("locale", a.locale.get()),
    ("projection", a.projection.get()),
    ("query", a.query.get()),
    ("versions", a.versions.get()),
  ])?;
  upstream("buildJoinAggregation", args)
}

/// `resolveJoins(args)`: its promise.
pub fn resolve_joins(a: ResolveJoinsArgs) -> JsResult<Local> {
  if let Some(f) = pick(&RESOLVE_JOINS) {
    return f(a);
  }
  let args = literal(&[
    ("adapter", a.adapter.get()),
    ("collectionSlug", a.collection_slug.get()),
    ("docs", a.docs.get()),
    ("joins", a.joins.get()),
    ("locale", a.locale.get()),
    ("projection", a.projection.get()),
    ("versions", a.versions.get()),
  ])?;
  upstream("resolveJoins", args)
}
