//! Ports of the global operations (`packages/payload/src/globals/operations`: `findOne`,
//! `update`, `findVersions`, `findVersionByID`, `countGlobalVersions`, `restoreVersion`,
//! `docAccess`, `validate`) and the auth operations (`packages/payload/src/auth/operations`:
//! `login`, `logout`, `me`, `refresh`, `forgotPassword`, `resetPassword`, `registerFirstUser`,
//! `unlock`, `verifyEmail`, `access`, `auth`, `init`) on the core runtime
//! (`payload-core-runtime`, strategy B of RUST_CORE_DESIGN.md), with the porting rules of
//! RUST_OPS_DESIGN.md:
//! - every TS `async` function is a spawned task with its own native promise, every TS `await` an
//!   [`await_js`](payload_core_runtime::executor::await_js), `try`/`catch`/`finally` as `async`
//!   blocks whose `Err` runs the catch path with the same thrown value;
//! - docs, args, `where`/`select` objects and `req` stay the caller's JS objects;
//! - hooks and access functions are called live with object literals of upstream's key order,
//!   built by JS helpers (`packages/engine-rs/src/ops-global/host.ts`);
//! - `executeAccess`, `buildBeforeOperation` and `buildAfterOperation` are payload-core-ops' Rust
//!   ports; the field traversals, transactions, `payload.db.*`, the Local API and the crypto /
//!   JWT / cookie / email / query utilities are the upstream JS called at the same point.

pub mod auth_forgot_password;
pub mod auth_login;
pub mod auth_refresh;
pub mod auth_register_unlock;
pub mod auth_reset_password;
pub mod auth_small;
pub mod binding;
pub mod common;
pub mod global_count_versions;
pub mod global_doc_access;
pub mod global_find_one;
pub mod global_find_version_by_id;
pub mod global_find_versions;
pub mod global_restore_version;
pub mod global_update;
pub mod global_validate;
pub mod host;

pub use binding::create_binding;
