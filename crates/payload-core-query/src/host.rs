//! Calls from the query utilities into the JS side (access functions and
//! permission resolution). Every call happens at the exact point the TS code
//! makes it; asynchronous results are delivered through a [`Promise`] the host
//! settles whenever it is ready (synchronously, from a queued job, or from
//! [`Host::on_idle`]), which keeps the trait agnostic of how the host awaits.

use payload_engine::js::JsVal;
use payload_sql_read::Val;

use crate::js::JsResult;
use crate::rt::{Promise, Rt};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntityType {
  Collection,
  Global,
}

impl EntityType {
  pub fn as_str(self) -> &'static str {
    match self {
      EntityType::Collection => "collection",
      EntityType::Global => "global",
    }
  }
}

/// `getEntityPermissions({ blockReferencesPermissions, entity, entityType, fetchData: false, operations: ['read'], req })`
#[derive(Clone, Debug)]
pub struct EntityPermissionsCall {
  pub entity_type: EntityType,
  /// The collection/global config (`entity`).
  pub entity: JsVal,
  /// Identity of the `blockReferencesPermissions` object: one fresh `{}` per
  /// `validateSearchParam` invocation, shared by all calls it makes.
  pub block_references_permissions: u64,
  /// `req` was passed as `isolateObjectProperty(req, 'transactionID')`
  /// (collections) instead of `req` itself (globals).
  pub isolated_transaction_id: bool,
}

/// `executeAccess({ slug, disableErrors: true, req }, access)`
#[derive(Clone, Debug)]
pub struct ExecuteAccessCall {
  pub slug: String,
  /// `collectionConfig.access.read` (a function handle, or undefined).
  pub access: JsVal,
}

pub trait Host {
  /// Starts `getEntityPermissions(...)`; the promise resolves with the
  /// permissions object (a [`Val`], stored into the caller's `policies`).
  fn get_entity_permissions(&self, rt: &Rt, call: EntityPermissionsCall) -> Promise;

  /// Starts `executeAccess(...)`; the promise resolves with the access result.
  fn execute_access(&self, rt: &Rt, call: ExecuteAccessCall) -> Promise;

  /// Calls an entity `select` function synchronously:
  /// `config({ operation, req, select })`.
  fn call_select(&self, function: &JsVal, operation: &str, select: &Val) -> JsResult<Val>;

  /// Called when the job queue is empty; settles the next promise that waits
  /// on external work and returns true, or returns false when there is none.
  fn on_idle(&self, _rt: &Rt) -> bool {
    false
  }
}
