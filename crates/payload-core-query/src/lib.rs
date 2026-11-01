//! Port of the DB-agnostic query/select utilities of `packages/payload/src`:
//!
//! - [`where_query`]: `combineQueries`, `sanitizeWhereQuery`, `prefixWherePaths`,
//!   `appendNonTrashedFilter`, `appendVersionToQueryKey`, `appendGlobalVersionToQueryKey`
//! - [`paths`]: `getFieldByPath`, `getLocalizedPaths`
//! - [`sort`]: `sanitizeSortQuery`, `getQueryDraftsSort`
//! - [`select`]: `getSelectMode`, `sanitizeSelect`, `resolveSelect`,
//!   `stripUnselectedFields`, `getQueryDraftsSelect`
//! - [`validate`]: `validateQueryPaths`, `validateSearchParam`, `validateSortQuery`
//! - [`join`]: `sanitizeJoinQuery`
//!
//! Config values (fields, collection configs) are the immutable decoded graph
//! ([`JsVal`](payload_engine::js::JsVal)); request data (`where`, `select`,
//! `joins`, `policies`) is mutable with reference semantics
//! ([`Val`](payload_sql_read::Val)) because the TS code mutates it in place.
//! The async validators run on [`rt::Rt`] and call back into JS via [`host::Host`].

pub mod config;
pub mod graph;
pub mod host;
pub mod join;
pub mod js;
pub mod paths;
pub mod rt;
pub mod select;
pub mod sort;
pub mod validate;
pub mod where_query;

pub use config::QueryConfig;
pub use host::Host;
pub use js::{JsError, JsResult};
pub use rt::{Promise, Rt};
pub use validate::Ctx;
