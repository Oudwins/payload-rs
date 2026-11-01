//! Ports of the collection read operations of `packages/payload/src/collections/operations`
//! (`find`, `findByID`, `count`, `countVersions`, `findDistinct`, `findVersions`,
//! `findVersionByID`, `docAccess`) and their utilities (`executeAccess`, `buildBeforeOperation`,
//! `buildAfterOperation`, `sanitizeSortQuery`, lock status) on the core runtime
//! (`payload-core-runtime`, strategy B of RUST_CORE_DESIGN.md).
//!
//! Porting rules (RUST_CORE_DESIGN.md section 3, RUST_OPS_DESIGN.md):
//! - every TS `async` function is a spawned task with its own native promise, every TS `await` is
//!   an [`await_js`](payload_core_runtime::executor::await_js), concurrency only through JS
//!   `Promise.all` over task promises in iteration order;
//! - docs, args, `where`/`select` objects stay the user's JS objects (identity, mutation);
//! - user callbacks (collection hooks, access functions) are called live with object literals of
//!   upstream's key order, built by JS helpers;
//! - the query utilities (`combineQueries`, `sanitizeWhereQuery`, `validateQueryPaths`,
//!   `validateSortQuery`, `sanitizeJoinQuery`, `getFieldByPath`, `getLocalizedPaths`,
//!   `prefixWherePaths`) are the live port of payload-core-query, the small where/select/draft
//!   utilities are ported here (`utilities`), `afterRead` is the Rust port of
//!   payload-core-runtime; `payload.db.*` is called through JS (any adapter, including the Rust
//!   SQL engine).

pub mod binding;
pub mod common;
pub mod count;
pub mod doc_access;
pub mod find;
pub mod find_by_id;
pub mod find_distinct;
pub mod find_version_by_id;
pub mod find_versions;
pub mod host;
pub mod query;
pub mod utilities;

pub use binding::create_binding;
