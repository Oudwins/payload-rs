//! Port of `packages/payload/src/fields/hooks/beforeChange/{index,traverseFields,promise,
//! getExistingRowDoc}.ts` on the payload core runtime (see RUST_CORE_DESIGN.md, strategy B).
//!
//! The binding (`hooksBeforeChangeBinding()` of the `payload-node` addon) must be loaded from the
//! same addon instance as `coreRuntimeBinding()`: both share the runtime's executor and host.

pub mod before_change;
pub mod binding;
mod host;

pub use binding::create_binding;
