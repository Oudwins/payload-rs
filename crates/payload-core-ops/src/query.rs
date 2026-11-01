//! The query utilities the operations call, from the live-JS-value port of
//! `crates/payload-core-query` (`live`): `combineQueries`, `sanitizeWhereQuery`,
//! `prefixWherePaths`, `validateQueryPaths`, `validateSortQuery`, `sanitizeJoinQuery`,
//! `getFieldByPath`, `getLocalizedPaths`. They work on the caller's `where` / `joins` objects
//! (identity and in-place mutation as upstream). Their host must be installed
//! (`coreQueryBinding().init`, done by `getCoreOps()`).
//!
//! The async ones return the promise of their own task, like calling the TS `async` function.

use payload_core_query::live::join::{JoinQueryArgs, sanitize_join_query_body};
use payload_core_query::live::paths::{FieldByPath, FieldByPathArgs, LocalizedPathArg, LocalizedPathsArgs, PathToQuery};
use payload_core_query::live::validate::{QueryPathsArgs, SortQueryArgs, validate_sort_query_body};
use payload_core_query::live::{paths, validate, where_query};
use payload_core_runtime::executor::spawn;
use payload_core_runtime::js::{JsResult, Local, Val};

use crate::host::val;

/// `combineQueries(where, access)`
pub fn combine_queries(where_: Local, access: Local) -> JsResult<Val> {
  val(where_query::combine_queries(where_, access)?)
}

/// `sanitizeWhereQuery({ fields, payload, where })`
pub fn sanitize_where_query(fields: Local, payload: Local, where_: Local) -> JsResult<()> {
  where_query::sanitize_where_query(fields, payload, where_)
}

/// `prefixWherePaths({ prefix, where })`
pub fn prefix_where_paths(prefix: Local, where_: Local) -> JsResult<Local> {
  where_query::prefix_where_paths(prefix, where_)
}

/// The keys of a `validateQueryPaths({...})` literal of the operations (the others absent).
pub struct QueryPaths {
  pub collection_config: Val,
  pub override_access: Val,
  pub req: Val,
  pub show_hidden_fields: Val,
  pub version_fields: Val,
  pub where_: Val,
}

/// `validateQueryPaths({...})`: returns its promise.
pub fn validate_query_paths(a: QueryPaths) -> JsResult<Local> {
  validate::validate_query_paths(QueryPathsArgs {
    collection_config: a.collection_config,
    errors: Val::Undefined,
    global_config: Val::Undefined,
    override_access: a.override_access,
    policies: Val::Undefined,
    polymorphic_join: Val::Undefined,
    req: a.req,
    show_hidden_fields: a.show_hidden_fields,
    version_fields: a.version_fields,
    where_: a.where_,
  })
}

/// `validateSortQuery({ collectionConfig, overrideAccess, req, sort, versionFields })`: returns
/// its promise.
pub fn validate_sort_query(
  collection_config: Val,
  override_access: Val,
  req: Val,
  sort: Val,
  version_fields: Val,
) -> JsResult<Local> {
  spawn(validate_sort_query_body(SortQueryArgs {
    collection_config,
    global_config: Val::Undefined,
    override_access,
    req,
    sort,
    version_fields,
  }))
}

/// `sanitizeJoinQuery({ collectionConfig, joins, overrideAccess, req })`: returns its promise.
pub fn sanitize_join_query(collection_config: Val, joins: Val, override_access: Val, req: Val) -> JsResult<Local> {
  spawn(sanitize_join_query_body(JoinQueryArgs { collection_config, joins, override_access, req }))
}

/// `getFieldByPath({ config, fields, includeRelationships: true, path })`
pub fn get_field_by_path_with_relationships(config: Local, fields: Local, path: Local) -> JsResult<Option<FieldByPath>> {
  paths::get_field_by_path(&FieldByPathArgs {
    config,
    fields,
    include_relationships: true,
    localized_path: LocalizedPathArg::Units(Vec::new()),
    path,
  })
}

/// `getLocalizedPaths({ collectionSlug, fields, incomingPath, locale, overrideAccess: true, payload })`
pub fn get_localized_paths_override_access(
  collection_slug: Local,
  fields: Local,
  incoming_path: Local,
  locale: Local,
  payload: Local,
) -> JsResult<Vec<PathToQuery>> {
  paths::get_localized_paths(&LocalizedPathsArgs {
    collection_slug,
    fields,
    global_slug: payload_core_runtime::js::undefined(),
    incoming_path,
    locale,
    override_access: true,
    parent_is_localized: payload_core_runtime::js::undefined(),
    payload,
    show_hidden_fields: false,
  })
}
