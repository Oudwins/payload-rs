//! Ports of `packages/payload/src/fields/hooks/afterChange/*` and
//! `packages/payload/src/fields/hooks/beforeDuplicate/*` on the core runtime
//! (`payload-core-runtime`, strategy B of RUST_CORE_DESIGN.md): the docs stay JS objects, every
//! JS-observable read/write/call happens in the TS order, every `async` function is a spawned task
//! with its own native promise and every `await` is a real JS await.

pub mod after_change;
pub mod before_duplicate;
pub mod binding;
mod common;
mod host;

pub use binding::create_binding;
