//! The entry points `payload_mongo_live::deps` calls (`register_build_query`,
//! `register_build_sort_param`, `register_build_projection_from_select`, registered by
//! payload-node's `mongo_live.rs`): the args literal of the TS call as live values, destructured
//! like the TS functions do (`parentIsLocalized = false`).

use payload_core_runtime::js::{self, JsResult, Local, Type};
use payload_mongo_live::deps::{BuildProjectionFromSelectArgs, BuildQueryArgs, BuildSortParamArgs};

use crate::{projection, query, sort};

/// `buildQuery(args)`: the promise of the async function.
pub fn build_query(a: BuildQueryArgs) -> JsResult<Local> {
  query::build_query(query::BuildQueryArgs {
    adapter: a.adapter.get(),
    collection_slug: a.collection_slug.get(),
    fields: a.fields.get(),
    global_slug: a.global_slug.get(),
    locale: a.locale.get(),
    where_: a.where_.get(),
  })
}

/// `buildSortParam(args)`
pub fn build_sort_param(a: BuildSortParamArgs) -> JsResult<Local> {
  let parent_is_localized = a.parent_is_localized.get();
  sort::build_sort_param(&sort::SortArgs {
    adapter: a.adapter.get(),
    config: a.config.get(),
    fields: a.fields.get(),
    locale: a.locale.get(),
    parent_is_localized: if js::type_of(parent_is_localized) == Type::Undefined {
      js::boolean(false)
    } else {
      parent_is_localized
    },
    sort: a.sort.get(),
    sort_aggregation: a.sort_aggregation.get(),
    timestamps: a.timestamps.get(),
    versions: a.versions.get(),
  })
}

/// `buildProjectionFromSelect(args)`
pub fn build_projection_from_select(a: BuildProjectionFromSelectArgs) -> JsResult<Local> {
  projection::build_projection_from_select(a.adapter.get(), a.fields.get(), a.select.get())
}
