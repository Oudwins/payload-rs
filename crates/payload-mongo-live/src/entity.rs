//! `getCollection` / `getGlobal` (db-mongodb utilities/getEntity.ts), live: the model is read from
//! `adapter.collections` / `adapter.versions` / `adapter.globals` when the method calls them (at its
//! start, before any await), and kept for the whole call like upstream's `const { Model }` (glue
//! review item 5). User overrides and spies on those objects apply.

use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::host::{call, get, get_key, throw_from, truthy, val};

pub struct Collection {
  pub collection_config: Val,
  pub custom_id_type: Val,
  pub model: Val,
}

pub struct Global {
  pub global_config: Val,
  pub model: Val,
}

/// `getCollection({ adapter, collectionSlug, versions })`
pub fn get_collection(adapter: Local, collection_slug: Local, versions: bool) -> JsResult<Collection> {
  let collection = get_key(get(get(adapter, "payload")?, "collections")?, collection_slug)?;

  if !truthy(collection) {
    return Err(not_found("collection", collection_slug));
  }

  let (model, what) = if versions {
    (get_key(get(adapter, "versions")?, collection_slug)?, "collection version model")
  } else {
    (get_key(get(adapter, "collections")?, collection_slug)?, "collection model")
  };

  if !truthy(model) {
    return Err(not_found(what, collection_slug));
  }

  let model = val(model)?;
  Ok(Collection {
    collection_config: val(get(collection, "config")?)?,
    custom_id_type: val(get(collection, "customIDType")?)?,
    model,
  })
}

/// `getGlobal({ adapter, globalSlug, versions })`
pub fn get_global(adapter: Local, global_slug: Local, versions: bool) -> JsResult<Global> {
  // adapter.payload.config.globals.find((each) => each.slug === globalSlug)
  let global_config = call("findGlobalConfig", &[adapter, global_slug])?;

  if !truthy(global_config) {
    return Err(not_found("global", global_slug));
  }

  if versions {
    let model = get_key(get(adapter, "versions")?, global_slug)?;
    if !truthy(model) {
      return Err(not_found("global version model", global_slug));
    }
    return Ok(Global { global_config: val(global_config)?, model: val(model)? });
  }

  Ok(Global { global_config: val(global_config)?, model: val(get(adapter, "globals")?)? })
}

/// `new APIError(`ERROR: Failed to retrieve ${what} with the slug "${slug}". Does not exist.`)`
/// (the template literal is evaluated in JS: ToString of the slug like upstream).
fn not_found(what: &str, slug: Local) -> js::Thrown {
  throw_from("entityNotFound", &[js::string(what), slug])
}
