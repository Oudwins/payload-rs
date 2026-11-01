//! Query validation on live JS values (strategy B of RUST_CORE_DESIGN.md, on the
//! `payload-core-runtime` executor):
//!
//! - [`validate`]: `validateQueryPaths`, `validateSearchParam`, `validateSortQuery`
//! - [`join`]: `sanitizeJoinQuery`
//! - [`paths`]: `getLocalizedPaths`, `getFieldByPath`
//! - [`where_query`]: `combineQueries`, `prefixWherePaths`, `sanitizeWhereQuery`
//!
//! The `where`, `policies`, `errors`, `joins` and `req` objects are the caller's objects: every
//! read, write, delete, `in`, `for...in` (prototype chain included) and iterator step happens on
//! them at the point the TS performs it, so getters, proxies, frozen objects and mutations made
//! by access functions while a validation is suspended are observed exactly as upstream.
//! `getEntityPermissions` / `executeAccess` (and through them the access functions) are called
//! as the real JS functions with the TS argument objects, and awaited like the TS awaits them.
//! Errors are the payload classes (`QueryError` with `data === errors`, `APIError`) or whatever
//! user code threw, unchanged.

pub mod binding;
pub mod host;
pub mod join;
pub mod paths;
pub mod validate;
pub mod where_query;

pub use binding::create_binding;
