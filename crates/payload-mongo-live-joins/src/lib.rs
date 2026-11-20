//! Live-object port of `@payloadcms/db-mongodb`'s join utilities on the core runtime
//! (crates/payload-core-runtime, strategy B of RUST_CORE_DESIGN.md): `buildJoinAggregation`,
//! and `resolveJoins` operate on the caller's JS objects (adapter, mongoose
//! models, docs, where) through Node-API on the JS thread, await exactly where the TS awaits,
//! compose concurrency only through JS `Promise.all` and mutate in place when upstream does.
//!
//! Shared helpers, `getCollection`, `aggregatePaginate` and the `buildQuery` / `buildSortParam` /
//! `transform` entry points come from `payload-mongo-live` (one implementation per behaviour);
//! payload's query/version helpers from the binding's `init(deps)` (see [`deps`]). The ports are
//! registered in `payload_mongo_live::deps` as `build_join_aggregation_native` /
//! `resolve_joins_native`.

pub mod binding;
pub mod build_join_aggregation;
pub mod deps;
pub mod jsx;
pub mod resolve_joins;

pub use binding::create_binding;
pub use build_join_aggregation::{build_join_aggregation, build_join_aggregation_native};
pub use resolve_joins::{resolve_joins, resolve_joins_native};
