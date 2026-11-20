//! Live-object ports (MONGO_ENGINE_CONTRACT.md "Stage 1b decision") of
//! `packages/db-mongodb/src/utilities/{transform,handleError,getEntity,getDBName,isObjectID}.ts`.
//!
//! Everything is synchronous (like the TS) and runs on the JS thread inside the caller's napi
//! segment: arguments are the caller's live `Local`s, every JS-observable operation on the data,
//! the operator objects, the adapter, `req` and errors happens in the TS order and in place, and
//! JS values thrown on the way (user getters, proxies, mongoose `ObjectId`, payload errors) come
//! back as the same [`Thrown`](payload_core_runtime::js::Thrown) value.
//!
//! [`install`] must run once per env first (the binding's `init(deps)`), with the values
//! `@payloadcms/db-mongodb` imports: `{ APIError, flattenAllFields, Types, ValidationError }`
//! (payload's error classes and `flattenAllFields`, mongoose's `Types`).

pub mod binding;
mod live;
pub mod register;
pub mod transform;
pub mod utilities;

pub use binding::create_binding;
pub use live::{install, is_installed, is_object_id};
pub use transform::{Operation, TransformArgs, transform};
pub use utilities::{CollectionEntity, GlobalEntity, get_collection, get_db_name, get_db_name_destructured, get_global, handle_error};
