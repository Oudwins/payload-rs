use napi_derive::napi;

mod core_query;
mod hooks_before_validate;
mod hooks_after_change;
mod hooks_before_change;
mod ops;
mod ops_global;
mod ops_write;
mod engine;
mod fn_ir;
mod fuse;
mod fuse_write;
mod runtime;
mod mongo_live;
mod mongo_live_write;
mod mongo_schema;
#[path = "../../payload-mongo-live-query/node/binding.rs"] mod mongo_live_query;
#[path = "../../payload-mongo-live-transform/node/mod.rs"] mod mongo_live_transform;
#[path = "../../payload-mongo-live-joins/node/mod.rs"] mod mongo_live_joins;
#[path = "../../payload-mongo-schema/node/mod.rs"] mod mongo_live_schema;
#[path = "../../payload-mongo-driver/node/mod.rs"] mod mongo_driver;
mod schema;
mod sqlite;
mod validate;

#[napi]
pub fn version() -> String {
  payload_engine::version().to_string()
}
