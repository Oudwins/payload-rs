//! Live ports of `handleError.ts`, `getEntity.ts` (`getCollection` / `getGlobal`) and
//! `getDBName.ts` (packages/db-mongodb/src/utilities).

use payload_core_runtime::js::{self, JsResult, Local, Thrown, Type, Val};

use crate::live::{self, Helpers, call, get, get_named, get_optional, has_named, is_typeof_object};

fn thrown(v: Local) -> Thrown {
  match Val::from_local(v) {
    Ok(v) => Thrown(v),
    Err(e) => e,
  }
}

fn api_error(h: &Helpers, message: &[u16]) -> Thrown {
  match call(&h.new_api_error, &[live::string_utf16(message)]) {
    Ok(e) => thrown(e),
    Err(e) => e,
  }
}

fn concat(parts: &[&[u16]]) -> Vec<u16> {
  parts.iter().flat_map(|p| p.iter().copied()).collect()
}

/// `handleError({ collection, error, global, req })`: the value the TS throws (it always throws).
pub fn handle_error(collection: Local, error: Local, global: Local, req: Local) -> Thrown {
  match handle_error_inner(collection, error, global, req) {
    Ok(v) => thrown(v),
    Err(e) => e,
  }
}

fn handle_error_inner(collection: Local, error: Local, global: Local, req: Local) -> JsResult<Local> {
  let h = live::helpers()?;
  let h = &*h;
  // `!error || typeof error !== 'object'`
  if !js::truthy(error) || !is_typeof_object(error) {
    return Ok(error);
  }
  if !(has_named(h, error, "code")? && js::strict_equals(js::get_named(error, "code")?, js::number(11000.0))) {
    return Ok(error);
  }

  let mut path: Option<Local> = None;
  if has_named(h, error, "keyValue")?
    && js::truthy(js::get_named(error, "keyValue")?)
    && is_typeof_object(js::get_named(error, "keyValue")?)
  {
    // `Object.keys(error.keyValue)[0] ?? ''`
    path = Some(call(&h.first_key, &[js::get_named(error, "keyValue")?])?);
  } else if has_named(h, error, "message")? && js::type_of(js::get_named(error, "message")?) == Type::String {
    let extracted = call(&h.extract_field_from_message, &[js::get_named(error, "message")?])?;
    path = Some(extracted);
  }

  if let Some(p) = path
    && js::truthy(p)
  {
    path = Some(strip_locale_from_path(h, p, req)?);
  }

  let t = get_optional(h, req, "t")?;
  let message = if js::truthy(t) {
    live::call_method(h, req, "t", "req.t", &[js::string("error:valueMustBeUnique")])?
  } else {
    js::string("Value must be unique")
  };
  let path = match path {
    Some(p) if !live::is_nullish(p) => p,
    _ => js::string(""),
  };
  let data = call(&h.validation_error_data, &[collection, message, path, global])?;
  let t = get_optional(h, req, "t")?;
  call(&h.new_validation_error, &[data, t])
}

/// `stripLocaleFromPath(path, req)` for a truthy `path` (its `lastIndexOf` / `substring` /
/// `includes` are the live methods, called like the TS calls them).
fn strip_locale_from_path(h: &Helpers, path: Local, req: Local) -> JsResult<Local> {
  let payload = get_optional(h, req, "payload")?;
  let config = get_optional(h, payload, "config")?;
  let localization = get_optional(h, config, "localization")?;
  if !js::truthy(localization) {
    return Ok(path);
  }
  let last_dot_index = call(&h.last_index_of_dot, &[path])?;
  if js::strict_equals(last_dot_index, js::number(-1.0)) {
    return Ok(path);
  }
  let last_segment = call(&h.substring_after_index, &[path, last_dot_index])?;
  let codes = get_named(h, localization, "localeCodes")?;
  let included = live::call_method(h, codes, "includes", "localization.localeCodes.includes", &[last_segment])?;
  if js::truthy(included) {
    return call(&h.substring_to_index, &[path, last_dot_index]);
  }
  Ok(path)
}

/// What `getCollection` returns.
#[derive(Clone, Copy)]
pub struct CollectionEntity {
  pub collection_config: Local,
  pub custom_id_type: Local,
  pub model: Local,
}

impl CollectionEntity {
  /// The TS return value `{ collectionConfig, customIDType, Model }`.
  pub fn to_object(&self) -> JsResult<Local> {
    let h = live::helpers()?;
    call(&h.collection_entity, &[self.collection_config, self.custom_id_type, self.model])
  }
}

/// `getCollection({ adapter, collectionSlug, versions })` (`versions` defaults to `false`; pass
/// `undefined` when the caller omits it).
pub fn get_collection(adapter: Local, collection_slug: Local, versions: Local) -> JsResult<CollectionEntity> {
  let h = live::helpers()?;
  let h = &*h;
  let collections = get_named(h, get_named(h, adapter, "payload")?, "collections")?;
  let collection = get(h, collections, collection_slug)?;
  if !js::truthy(collection) {
    let slug = live::to_string_utf16(h, collection_slug)?;
    return Err(api_error(
      h,
      &concat(&[&live::utf16("ERROR: Failed to retrieve collection with the slug \""), &slug, &live::utf16("\". Does not exist.")]),
    ));
  }
  let kind = if js::truthy(versions) { "versions" } else { "collections" };
  let model = get(h, get_named(h, adapter, kind)?, collection_slug)?;
  if !js::truthy(model) {
    let slug = live::to_string_utf16(h, collection_slug)?;
    let what = if js::truthy(versions) { "collection version model" } else { "collection model" };
    return Err(api_error(
      h,
      &concat(&[
        &live::utf16(&format!("ERROR: Failed to retrieve {what} with the slug \"")),
        &slug,
        &live::utf16("\". Does not exist."),
      ]),
    ));
  }
  Ok(CollectionEntity {
    collection_config: get_named(h, collection, "config")?,
    custom_id_type: get_named(h, collection, "customIDType")?,
    model,
  })
}

/// What `getGlobal` returns.
#[derive(Clone, Copy)]
pub struct GlobalEntity {
  pub global_config: Local,
  pub model: Local,
}

impl GlobalEntity {
  /// The TS return value `{ globalConfig, Model }`.
  pub fn to_object(&self) -> JsResult<Local> {
    let h = live::helpers()?;
    call(&h.global_entity, &[self.global_config, self.model])
  }
}

/// `getGlobal({ adapter, globalSlug, versions })`
pub fn get_global(adapter: Local, global_slug: Local, versions: Local) -> JsResult<GlobalEntity> {
  let h = live::helpers()?;
  let h = &*h;
  // `adapter.payload.config.globals.find((each) => each.slug === globalSlug)`
  let global_config = call(&h.find_global, &[adapter, global_slug])?;
  if !js::truthy(global_config) {
    let slug = live::to_string_utf16(h, global_slug)?;
    return Err(api_error(
      h,
      &concat(&[&live::utf16("ERROR: Failed to retrieve global with the slug \""), &slug, &live::utf16("\". Does not exist.")]),
    ));
  }
  if js::truthy(versions) {
    let model = get(h, get_named(h, adapter, "versions")?, global_slug)?;
    if !js::truthy(model) {
      let slug = live::to_string_utf16(h, global_slug)?;
      return Err(api_error(
        h,
        &concat(&[
          &live::utf16("ERROR: Failed to retrieve global version model with the slug \""),
          &slug,
          &live::utf16("\". Does not exist."),
        ]),
      ));
    }
    return Ok(GlobalEntity { global_config, model });
  }
  Ok(GlobalEntity { global_config, model: get_named(h, adapter, "globals")? })
}

/// `getDBName({ config, target, versions })` (`target` defaults to `'dbName'`, `versions` to
/// `false`; pass `undefined` for omitted ones). Returns the name (whatever `dbName` produced).
pub fn get_db_name(config: Local, target: Local, versions: Local) -> JsResult<Local> {
  let h = live::helpers()?;
  // `config: { name, slug }` is destructured before `target` and `versions`
  let name = get_named(&h, config, "name")?;
  let slug = get_named(&h, config, "slug")?;
  get_db_name_destructured(name, slug, config, target, versions)
}

/// The body of `getDBName` once its parameter is destructured (`config.name`, `config.slug`,
/// `config`, `target`, `versions`).
pub fn get_db_name_destructured(name: Local, slug: Local, config: Local, target: Local, versions: Local) -> JsResult<Local> {
  let h = live::helpers()?;
  let h = &*h;
  let target = if js::type_of(target) == Type::Undefined { js::string("dbName") } else { target };
  let mut custom = get(h, config, target)?;
  if !js::truthy(custom) && live::is_str(target, "enumName") {
    custom = get_named(h, config, "dbName")?;
  }
  let mut result = if js::truthy(custom) {
    if js::type_of(custom) == Type::Function {
      let arg = call(&h.object, &[])?;
      js::call(custom, js::undefined(), &[arg])?
    } else {
      custom
    }
  } else if !live::is_nullish(name) {
    name
  } else if !live::is_nullish(slug) {
    slug
  } else {
    js::null()
  };
  if js::truthy(versions) {
    let inner = live::to_string_utf16(h, result)?;
    result = live::string_utf16(&concat(&[&live::utf16("_"), &inner, &live::utf16("_versions")]));
  }
  if !js::truthy(result) {
    let name = live::to_string_utf16(h, name)?;
    let slug = live::to_string_utf16(h, slug)?;
    return Err(api_error(
      h,
      &concat(&[&live::utf16("Assertion for DB name of "), &name, &live::utf16(" "), &slug, &live::utf16(" was failed.")]),
    ));
  }
  Ok(result)
}
