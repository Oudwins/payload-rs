//! Live-object MongoDB engine: shared helpers and the read data methods.
//!
//! Everything here runs on the JS thread on the core runtime (`payload-core-runtime`, strategy B of
//! RUST_CORE_DESIGN.md): the method arguments, `req`, the `where` / `select` / `sort` objects, the
//! documents and the mongoose models / queries / sessions are the caller's live JS objects, driven
//! through Node-API. Porting rules (MONGO_ENGINE_CONTRACT.md "Stage 1b decision"):
//!
//! - one Rust `async fn` per TS `async` function, called through
//!   [`spawn`](payload_core_runtime::executor::spawn) where the TS calls it and awaited with
//!   [`await_js`](payload_core_runtime::executor::await_js) exactly where the TS awaits (also on
//!   values that are not promises);
//! - concurrency only through JS `Promise.all` (fail-fast), in the TS element order;
//! - mutate in place exactly when upstream mutates; read the clock where upstream does;
//! - resolve models / sessions at the same points upstream resolves them; call mongoose methods
//!   directly on them.
//!
//! Modules:
//! - shared helpers for every Mongo live crate: [`host`] (JS helpers, JS-semantic operations),
//!   [`bson`], [`clock`], [`session`], [`entity`], [`error`], [`deps`] (the query / transform / joins
//!   entry points the read methods call, registered by their crates);
//! - the read methods: [`reads`] (`find`, `findOne`, `count`, `countVersions`,
//!   `countGlobalVersions`, `findDistinct`, `findGlobal`, `findVersions`, `findGlobalVersions`,
//!   `queryDrafts`, `aggregatePaginate`) and their [`binding`].

pub mod binding;
pub mod bson;
pub mod clock;
pub mod deps;
pub mod entity;
pub mod error;
pub mod host;
pub mod reads;
pub mod session;

pub use binding::create_binding;
