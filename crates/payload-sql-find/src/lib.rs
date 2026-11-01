//! Port of `@payloadcms/drizzle` `find/*` and of the drizzle-orm relational
//! query builder for SQLite (`db.query[table].findMany(...)`).
//!
//! - [`build_args`]: `buildFindManyArgs` / `traverseFields`
//! - [`join`], [`polymorphic`]: join field projections
//! - [`relational`] + [`exec`]: drizzle `buildRelationalQuery` + row mapping;
//!   statements run through an [`exec::Executor`] on `payload-sqlite`
//!   connections ([`exec::LibsqlConn`] inside a worker job, [`exec::QueuedConn`]
//!   by `ConnId`), driver errors become `DrizzleQueryError`s
//! - [`find_many`]: `findMany` ([`find_many::find_many_js`] keeps JS value types)
//! - [`context`]: inputs and the boundary to the query module
//!   ([`context::QueryBuilder`]), implemented on `payload-sql-query` by
//!   [`query::SqlQueryBuilder`]
//!
//! See RUST_PORT.md for ownership and porting rules.

pub mod args;
pub mod build_args;
pub mod context;
pub mod exec;
pub mod find_many;
pub mod join;
pub mod polymorphic;
pub mod query;
pub mod relational;
pub mod schema;
pub mod sql;
pub mod utils;

pub use rusqlite;
