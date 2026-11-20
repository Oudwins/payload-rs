//! Live-object model building (MONGO_ENGINE_CONTRACT.md "Stage 1b decision"): db-mongodb's
//! `init` (`init.ts`, `models/*`, `utilities/getDBName.ts`) on the core runtime, driving the
//! adapter's real mongoose (`new Schema`, `schema.add` / `index` / `plugin` /
//! `path(...).discriminator`, `connection.model`, `Model.discriminator`) and the user's callbacks
//! (`afterCreateConnection`, `dbName` functions, getters of the config) live, interleaved exactly
//! like upstream. Replaces the description-and-replay of [`crate::build_mongo_models`] (kept for
//! the stage-1 engine until it is removed from production).

pub mod binding;
pub mod build;
pub mod init;
pub mod jsx;
