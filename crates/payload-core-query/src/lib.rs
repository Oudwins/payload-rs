//! Port of the DB-agnostic query/select utilities of `packages/payload/src`.
//!
//! On live JS values ([`live`], strategy B on `payload-core-runtime`, exposed by the
//! `coreQueryBinding()` napi export):
//!
//! - `validateQueryPaths`, `validateSearchParam`, `validateSortQuery`, `sanitizeJoinQuery`
//! - `getLocalizedPaths`, `getFieldByPath`, `combineQueries`, `prefixWherePaths`,
//!   `sanitizeWhereQuery`
//!
//! On decoded values (config as [`JsVal`](payload_engine::js::JsVal), request data as mutable
//! [`Val`](payload_sql_read::Val)), verified by replaying recorded upstream calls:
//!
//! - [`where_query`]: `appendNonTrashedFilter`, `appendVersionToQueryKey`,
//!   `appendGlobalVersionToQueryKey`
//! - [`sort`]: `sanitizeSortQuery`, `getQueryDraftsSort`
//! - [`select`]: `getSelectMode`, `sanitizeSelect`, `resolveSelect`, `stripUnselectedFields`,
//!   `getQueryDraftsSelect`

pub mod graph;
pub mod js;
pub mod live;
pub mod paths;
pub mod select;
pub mod sort;
pub mod where_query;

pub use js::{JsError, JsResult};
