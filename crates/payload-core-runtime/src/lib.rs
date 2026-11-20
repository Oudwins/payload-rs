//! Payload core runtime: executes ported engine code (field hook traversals, operations) on the
//! JS thread, driving the user's JS objects and callbacks through Node-API with the exact
//! ordering and microtask interleaving of the TypeScript reference. See RUST_CORE_DESIGN.md.

pub mod after_read;
pub mod bench;
pub mod binding;
pub mod config;
pub mod executor;
pub mod host;
pub mod js;
pub mod probes;

pub use binding::create_binding;
