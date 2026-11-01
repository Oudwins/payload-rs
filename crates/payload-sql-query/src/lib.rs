//! Port of `@payloadcms/drizzle/src/queries/*` and `sqlite/createJSONQuery` for the SQLite
//! adapter: turns a Payload `where` / `sort` into SQLite SQL text and bound parameters.
//!
//! Entry point: [`build_query::build_query`] with a [`adapter::QueryAdapter`]; the result
//! ([`build_query::BuildQueryResult`]) mirrors the TS `BuildQueryResult` and can be rendered
//! with [`render::find_ids_select`] / [`render::count_select`] or composed by other modules.
//!
//! See RUST_PORT.md for ownership and porting rules.

pub mod adapter;
pub mod build_query;
pub mod columns;
pub mod drizzle;
pub mod js_date;
pub mod js_ops;
pub mod json_query;
pub mod operators;
pub mod parse_params;
pub mod paths;
pub mod render;
pub mod sanitize;
pub mod sql;
pub mod where_val;

pub use adapter::{AdapterOptions, QueryAdapter};
pub use build_query::{BuildQueryArgs, BuildQueryResult, Order, OrderBy, build_order_by, build_query};
pub use render::{
  FindDistinctSelect, FindIdsSelect, IdRows, count_select, docs_by_ids_select, find_distinct_select, find_ids_select, js_id_key, ordered_unique_ids,
  prune_select_fields,
};
pub use sql::{Column, Expr, Join, JoinType, Operand, Query, Select, Sql, SqlValue, TableRef};
pub use where_val::WhereVal;
