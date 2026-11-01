//! Ports of the collection write operations of `packages/payload/src/collections/operations`
//! (`create`, `update`, `updateByID`, `utilities/update` (`updateDocument`), `delete`,
//! `deleteByID`, `duplicate`, `restoreVersion`, `validate`) on the core runtime
//! (`payload-core-runtime`, strategy B of RUST_CORE_DESIGN.md), with the porting rules of
//! RUST_OPS_DESIGN.md:
//! - every TS `async` function (operations and their inner `async` arrows: `writeDocument`,
//!   `processDocument`, `runBeforeDeleteWork`, ...) is a spawned task, every TS `await` an
//!   [`await_js`](payload_core_runtime::executor::await_js), concurrency only through JS
//!   `Promise.all` over task promises in iteration order;
//! - `try`/`catch`/`finally` are `async` blocks whose `Err` runs the catch block's awaits and
//!   rethrows the same JS value; `finally` runs on both paths;
//! - docs, args and `data` stay the user's JS objects; collection hooks and access are called live
//!   with object literals built by JS helpers in upstream's key order;
//! - the field traversals are the Rust ports (beforeValidate, beforeChange, afterChange,
//!   afterRead); transactions, uploads, versions, auth crypto, locked documents and the query
//!   utilities are the upstream JS, called at the same points with the same arguments.

pub mod binding;
pub mod common;
pub mod create;
pub mod delete;
pub mod delete_by_id;
pub mod duplicate;
pub mod host;
pub mod restore_version;
pub mod update;
pub mod update_by_id;
pub mod update_document;
pub mod validate;

pub use binding::create_binding;
