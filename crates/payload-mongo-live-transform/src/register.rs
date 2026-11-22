//! Registration with the live engine's dependency table (crates/payload-mongo-live `deps`): the
//! read / write methods call `deps::transform(...)`, which runs this port once it is registered
//! (otherwise upstream's TS `transform`). [`register`] runs from the binding's `init(deps)`, on the
//! JS thread whose thread-local table the live engine uses.
//!
//! The registered entry is fast.js (config planned once per fields array, upstream's data
//! operations evaluated by V8), which hands calls it cannot run to the exhaustive port
//! ([`crate::transform::transform`]).

use payload_core_runtime::js::{self, JsResult, Local};
use payload_mongo_live::deps;

use crate::live;

/// `deps::TransformFn` over fast.js `transform` (positional arguments in the TS key order).
pub fn transform_entry(a: deps::TransformArgs) -> JsResult<Local> {
  let fast = live::fast_transform()?;
  js::call(
    fast.get(),
    js::undefined(),
    &[
      a.add_to_set.get(),
      a.inc.get(),
      a.pull.get(),
      a.push.get(),
      a.adapter.get(),
      a.data.get(),
      a.fields.get(),
      a.global_slug.get(),
      a.operation.get(),
      a.parent_is_localized.get(),
      a.validate_relationships.get(),
    ],
  )
}

/// Registers [`transform_entry`] as the live engine's `transform`.
pub fn register() {
  deps::register_transform(transform_entry);
}
