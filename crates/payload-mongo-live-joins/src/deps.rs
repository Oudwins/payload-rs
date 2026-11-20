//! What the ported modules import from other modules:
//!
//! - db-mongodb's `buildQuery` / `buildSortParam` / `transform`: through the shared registry
//!   `payload_mongo_live::deps` (the live ports once registered, upstream's TS until then);
//! - `getCollection`, `APIError`, `buildVersionCollectionFields`: the shared live helpers
//!   (`payload_mongo_live::{entity, error, host}`);
//! - payload's `appendVersionToQueryKey`, `combineQueries`, `getQueryDraftsSort`,
//!   `fieldShouldBeLocalized`, `hasDraftsEnabled`: upstream's own functions, installed by the
//!   binding's `init(deps)` (packages/engine-rs/src/mongo-adapter/init.ts) and read from the deps
//!   object when called (a module binding of the upstream file).

use std::cell::RefCell;
use std::rc::Rc;

use payload_core_runtime::js::{self, JsResult, Local, Persist, Thrown, Type};

use crate::jsx;

thread_local! {
  static DEPS: RefCell<Option<Rc<Persist>>> = const { RefCell::new(None) };
}

pub const NAMES: &[&str] =
  &["appendVersionToQueryKey", "combineQueries", "fieldShouldBeLocalized", "getQueryDraftsSort", "hasDraftsEnabled"];

pub fn install(deps: Local) -> JsResult<()> {
  for name in NAMES {
    if js::type_of(js::get_named(deps, name)?) != Type::Function {
      return Err(js::engine_error(&format!("mongo live joins: dependency `{name}` is missing")));
    }
  }
  let p = Rc::new(Persist::new(deps)?);
  DEPS.with(|d| *d.borrow_mut() = Some(p));
  Ok(())
}

pub fn installed() -> bool {
  DEPS.with(|d| d.borrow().is_some())
}

fn dep(name: &str) -> JsResult<Local> {
  let deps = DEPS
    .with(|d| d.borrow().clone())
    .ok_or_else(|| js::engine_error("mongo live joins binding not initialized (mongoLiveJoinsBinding().init(deps))"))?;
  js::get_named(deps.get(), name)
}

/// `name(...args)` (a module function, `this === undefined`).
pub fn call(name: &str, args: &[Local]) -> JsResult<Local> {
  jsx::call_fn(dep(name)?, js::undefined(), args, name)
}

/// `new APIError(message)` (message: an evaluated template literal).
pub fn api_error(message: Local) -> JsResult<Thrown> {
  Ok(payload_mongo_live::error::api_error_of(message))
}

/// `buildVersionCollectionFields(config, collection, flatten)`
pub fn build_version_collection_fields(config: Local, collection: Local, flatten: bool) -> JsResult<Local> {
  payload_mongo_live::host::call("buildVersionCollectionFields", &[config, collection, js::boolean(flatten)])
}
