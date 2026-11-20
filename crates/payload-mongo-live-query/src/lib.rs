//! Live-object port of `@payloadcms/db-mongodb`'s query builders (`queries/*`) and
//! `utilities/buildProjectionFromSelect.ts` on the core runtime (`payload-core-runtime`, strategy B
//! of RUST_CORE_DESIGN.md, MONGO_ENGINE_CONTRACT.md "Stage 1b decision").
//!
//! The caller's `where`, `sort`, `sortAggregation`, `select`, config objects, `payload`, the adapter
//! and its mongoose models are used in place through Node-API on the JS thread: every read, write,
//! `in`, iteration step and call happens where the TS performs it (so getters, proxies, class
//! instances, prototypes, frozen objects and shared references behave as upstream), the TS
//! mutations of caller objects happen in place (`formattedValue.value = new ObjectId(...)`,
//! `sort.push(fallbackSort)`, `sortAggregation.push(...)`), every `async` function is one task
//! awaited where the TS awaits it, and the sub-queries call `Model.buildQuery` /
//! `Model.find(...).lean().select(...)` / `Model.distinct(...)` on the real models.
//!
//! Rust entry points (for the live engine crates, called inside their tasks):
//! - [`query::build_query`] (`buildQuery`, returns its promise), [`query::parse_params`],
//!   [`query::schema_build_query_function`] / [`query::build_query_plugin`] (`Model.buildQuery`)
//! - [`sort::build_sort_param`], [`sort::get_localized_sort_property`]
//! - [`projection::build_projection_from_select`]
//! - [`deps`]: the `payload_mongo_live::deps` signatures (registered by payload-node)
//!
//! `getCollection`, `isObjectID` and the ObjectId / APIError helpers are payload-mongo-live's
//! (one implementation per behaviour).
//!
//! JS entry points: [`binding::create_binding`] (`mongoLiveQueryBinding()` of the addon).

pub mod binding;
pub mod deps;
pub mod host;
pub mod projection;
pub mod query;
pub mod sanitize;
pub mod sort;

pub use binding::create_binding;
