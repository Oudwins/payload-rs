//! Port of the join / pagination code of `@payloadcms/db-mongodb` (MONGO_ENGINE_CONTRACT.md):
//!
//! | TS module                              | Rust                                   |
//! | -------------------------------------- | -------------------------------------- |
//! | `utilities/buildJoinAggregation.ts`    | [`build_join_aggregation`]             |
//! | `utilities/resolveJoins.ts`            | [`resolve_joins`]                      |
//! | `utilities/aggregatePaginate.ts`       | [`aggregate_paginate`]                 |
//! | `findDistinct.ts`                      | [`find_distinct`]                      |
//! | `queryDrafts.ts`                       | [`query_drafts`]                       |
//!
//! Values are [`payload_engine::js::JsVal`]s with the typed BSON values of
//! `payload_engine::bson`; what the modules import from elsewhere (buildQuery, buildSortParam,
//! transform, the mongoose models) is [`JoinsEnv`].

pub mod aggregate_paginate;
pub mod build_join_aggregation;
pub mod env;
pub mod find_distinct;
pub mod query_drafts;
pub mod resolve_joins;
pub mod util;

pub use aggregate_paginate::{AggregatePaginateArgs, aggregate_paginate, build_aggregate_paginate_pipeline, paginated_docs};
pub use build_join_aggregation::{JoinAggregationArgs, build_join_aggregation};
pub use env::{BuildQueryArgs, JoinsEnv, ModelOp, ModelRef, PaginateArgs, SortParam, SortParamArgs, get_collection, join_all, join2};
pub use find_distinct::{DistinctPipelines, FindDistinctArgs, build_find_distinct_pipelines, find_distinct};
pub use query_drafts::{QueryDraftsArgs, query_drafts};
pub use resolve_joins::{ResolveJoinsArgs, resolve_joins};
