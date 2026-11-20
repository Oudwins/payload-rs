//! Live-object ports of the write data methods of `@payloadcms/db-mongodb`
//! (`packages/db-mongodb/src/{create,createGlobal,createVersion,createGlobalVersion,updateOne,
//! updateMany,upsert,updateGlobal,updateVersion,updateGlobalVersion,updateJobs,deleteOne,deleteMany,
//! deleteVersions}.ts`), on the core runtime (strategy B of
//! RUST_CORE_DESIGN.md, rules in MONGO_ENGINE_CONTRACT.md "Stage 1b decision"):
//!
//! - every method is a real JS `async function` whose body drives the Rust port ([`drive`]): the
//!   port awaits with [`drive::wait`] exactly where upstream awaits (`buildQuery`, `getSession`,
//!   every mongoose call), nowhere else, and each of those is the wrapper's native `await`;
//! - the method's `this` is the adapter it was called on, its argument the caller's live object:
//!   `data` / `versionData` are mutated in place by the write transform, `createdAt`, `_id` and
//!   `delete data.log` exactly when upstream does (before the first await), so model overrides and
//!   callers see them like upstream;
//! - `getCollection` / `getGlobal` run at the method start and the `Model` they return is the one
//!   every later call uses (resolved before the awaits, like upstream's `const { Model }`);
//! - mongoose is called directly (`Model.create([data], options)` returns hydrated documents;
//!   `toObject()` runs only where upstream calls it: after the latest flip, never with
//!   `returning: false`); the clock is read once per upstream `new Date()`;
//! - errors are the very values mongoose / user code threw; `handleError` (the one port, in
//!   payload-mongo-live-transform) reads them live where upstream calls it.
//!
//! Upstream expressions whose evaluation must be V8's (destructuring patterns, spreads, the iterator
//! protocol, `Model.x(...)` call sites for their error messages) are one-expression JS helpers in
//! `helpers.js`, compiled once per env ([`helpers`]). The query / transform functions owned by the
//! other live crates are called through `payload_mongo_live::deps`.

pub mod binding;
pub mod common;
pub mod create;
pub mod delete;
pub mod drive;
pub mod helpers;
pub mod update;
pub mod update_jobs;

pub use binding::create_binding;

thread_local! {
  static MUTANT: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Deliberately wrong behaviours for the mutation runs of test/__rs/mongo-live-writes (debug builds
/// only; `init({ mutant })`). Each number names one upstream rule the differential must catch:
/// 1 `toObject()` before the `returning === false` check (create), 2 `createdAt` stamped even when
/// given (an extra clock read), 3 the model re-resolved after the `getSession` await (create),
/// 4 updateOne's options spread after the await, 5 updateOne's `returning: false` read transform
/// outside the try (its errors would skip handleError),
/// 6 one extra await before `getSession` (create), 7 updateJobs reads `data.log` once for its
/// three checks, 8 createVersion converts the doc before the latest flip; the pre-fix behaviours of
/// the phase J writes review: 9 `data.id` read before `Types.ObjectId` (item 2), 10 updateJobs'
/// `typeof data.log === 'object'` false for null (item 3), 11 native operator assembly (items 5 /
/// 6), 12 options objects filled with ordinary Sets (item 7).
pub fn mutant(n: u32) -> bool {
  cfg!(debug_assertions) && MUTANT.with(|m| m.get()) == n
}

pub(crate) fn set_mutant(n: u32) {
  MUTANT.with(|m| m.set(n));
}
