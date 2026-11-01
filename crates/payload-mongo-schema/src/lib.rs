//! Rust port of `@payloadcms/db-mongodb`'s model building (`models/*`, `init.ts`).
//!
//! [`build_mongo_models`] turns the sanitized config into a [`Description`]: every mongoose call
//! upstream `init` makes after `afterCreateConnection` (`new Schema`, `schema.add`,
//! `schema.index`, block discriminators, plugins, `connection.model`, global discriminators), in
//! upstream's order, with typed arguments. packages/engine-rs/src/mongo-schema replays it on the
//! adapter's real mongoose, so `payload.db.collections` / `versions` / `globals` are the same
//! mongoose models upstream builds (verified by test/__rs/mongo-schema).

mod build;
mod description;

pub use build::{Input, Options, build_mongo_models};
pub use description::{
  BuildQueryArgs, DObj, DVal, Description, GlobalCtor, ModelId, ModelTarget, Op, SchemaId, SchemaTypeName,
  VersionsFields,
};
