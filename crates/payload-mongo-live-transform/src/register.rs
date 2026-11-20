//! Registration with the live engine's dependency table (crates/payload-mongo-live `deps`): the
//! read / write methods call `deps::transform(...)`, which runs this port once it is registered
//! (otherwise upstream's TS `transform`). [`register`] runs from the binding's `init(deps)`, on the
//! JS thread whose thread-local table the live engine uses.

use payload_core_runtime::js::{JsResult, Local};
use payload_mongo_live::deps;

use crate::transform::{TransformArgs, transform};

/// `deps::TransformFn` over this crate's [`transform`].
pub fn transform_entry(a: deps::TransformArgs) -> JsResult<Local> {
  transform(&TransformArgs {
    add_to_set: a.add_to_set.get(),
    inc: a.inc.get(),
    pull: a.pull.get(),
    push: a.push.get(),
    adapter: a.adapter.get(),
    data: a.data.get(),
    fields: a.fields.get(),
    global_slug: a.global_slug.get(),
    operation: a.operation.get(),
    parent_is_localized: a.parent_is_localized.get(),
    validate_relationships: a.validate_relationships.get(),
  })
}

/// Registers [`transform_entry`] as the live engine's `transform`.
pub fn register() {
  deps::register_transform(transform_entry);
}
