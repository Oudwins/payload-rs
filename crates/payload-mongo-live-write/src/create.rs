//! `create.ts`, `createGlobal.ts`, `createVersion.ts`, `createGlobalVersion.ts`.

use crate::drive::{Body, wait};
use payload_core_runtime::js::{self, JsResult, Val};
use payload_mongo_live::host::{call, call_method, get, get_val, is_false, is_string, set, truthy, val};
use payload_mongo_live::{bson, clock, entity};

use crate::common::{handle_error, destructure, session_options, transform_read, transform_write};
use crate::{helpers, mutant};

/// `adapter.create(args)`: the method's promise.
pub fn create(this: Val, args: Val) -> Body {
  Box::pin(create_body(this, args))
}

async fn create_body(this: Val, args: Val) -> JsResult<Val> {
  let [collection_slug, custom_id, data, req, returning] = destructure::<5>("createArgs", &args)?;
  let entity::Collection { collection_config, custom_id_type, model } =
    entity::get_collection(this.get(), collection_slug.get(), false)?;

  if !truthy(get(data.get(), "createdAt")?) || mutant(2) {
    set(data.get(), "createdAt", clock::now_iso()?)?;
  }

  transform_write(&this, &data, get_val(collection_config.get(), "fields")?, None, None)?;

  if truthy(custom_id_type.get()) {
    let id = get(data.get(), "id")?;
    set(data.get(), "_id", id)?;
  } else if truthy(custom_id.get()) {
    // Mongoose 9 no longer treats numbers as valid ObjectIDs, so only strings are worth casting
    if is_string(custom_id.get()) && bson::object_id_is_valid(custom_id.get())? {
      let id = bson::new_object_id(&[custom_id.get()])?;
      set(data.get(), "_id", id)?;
    } else {
      set(data.get(), "_id", custom_id.get())?;
    }
  } else if truthy(get(this.get(), "allowIDOnCreate")?) && truthy(get(data.get(), "id")?) {
    // `new Types.ObjectId(data.id)`: whatever `data.id` is (strings, ObjectId-like objects with
    // `toHexString`, buffers) goes to bson's constructor, like upstream (engine review item 8)
    // try { data._id = new Types.ObjectId(data.id) } catch (error) { log; throw error }: the
    // constructor lookup, the getter, the construction and the (strict) assignment are all inside
    // the try, in that order (`new C(arg)` evaluates `C` before `arg`: writes review item 2)
    let assigned = if mutant(9) {
      // mutant 9: the argument read before the constructor lookup (the pre-fix order)
      get(data.get(), "id").and_then(|id| bson::new_object_id(&[id])).and_then(|id| set(data.get(), "_id", id))
    } else {
      get(bson::types()?, "ObjectId").and_then(|ctor| {
      let id = get(data.get(), "id")?;
      let id = bson::construct(ctor, &[id], "Types.ObjectId")?;
      set(data.get(), "_id", id)
      })
    };
    if let Err(error) = assigned {
      helpers::call_this("logInvalidID", this.get(), &[data.get()])?;
      return Err(error);
    }
  }

  if mutant(6) {
    wait(js::undefined()).await?;
  }
  let options = session_options(&this, &req).await?;
  let model = if mutant(3) { entity::get_collection(this.get(), collection_slug.get(), false)?.model } else { model };

  let created: JsResult<Val> = async {
    let p = helpers::call("modelCreate", &[model.get(), data.get(), options.get()])?;
    let docs = wait(p).await?;
    helpers::call_val("first", &[docs.get()])
  }
  .await;
  let doc = match created {
    Ok(doc) => doc,
    Err(error) => return Err(handle_error(collection_slug.get(), error, js::undefined(), req.get())),
  };

  let doc = if mutant(1) { val(call_method(doc.get(), "toObject", &[], "doc.toObject")?)? } else { doc };
  if is_false(returning.get()) {
    return Ok(Val::Null);
  }

  let doc = if mutant(1) { doc } else { val(call_method(doc.get(), "toObject", &[], "doc.toObject")?)? };

  transform_read(&this, &doc, get_val(collection_config.get(), "fields")?, None)?;

  Ok(doc)
}

/// `adapter.createGlobal(args)`
pub fn create_global(this: Val, args: Val) -> Body {
  Box::pin(create_global_body(this, args))
}

async fn create_global_body(this: Val, args: Val) -> JsResult<Val> {
  let [global_slug, data, req, returning] = destructure::<4>("createGlobalArgs", &args)?;
  let entity::Global { global_config, model } = entity::get_global(this.get(), global_slug.get(), false)?;

  if !truthy(get(data.get(), "createdAt")?) {
    set(data.get(), "createdAt", clock::now_iso()?)?;
  }

  transform_write(&this, &data, get_val(global_config.get(), "fields")?, Some(&global_slug), None)?;

  let options = session_options(&this, &req).await?;

  let p = helpers::call("modelCreate", &[model.get(), data.get(), options.get()])?;
  let docs = wait(p).await?;
  let result = helpers::call_val("first", &[docs.get()])?;
  if is_false(returning.get()) {
    return Ok(Val::Null);
  }

  let result = val(call_method(result.get(), "toObject", &[], "result.toObject")?)?;

  transform_read(&this, &result, get_val(global_config.get(), "fields")?, None)?;

  Ok(result)
}

/// `adapter.createVersion(args)`
pub fn create_version(this: Val, args: Val) -> Body {
  Box::pin(create_version_body(this, args, false))
}

/// `adapter.createGlobalVersion(args)`
pub fn create_global_version(this: Val, args: Val) -> Body {
  Box::pin(create_version_body(this, args, true))
}

/// Both version creates: they differ in the entity, the `parent` key / query and the fields builder.
async fn create_version_body(this: Val, args: Val, is_global: bool) -> JsResult<Val> {
  let (autosave, slug, created_at, parent, published_locale, req, returning, snapshot, updated_at, version_data) =
    if is_global {
      let [autosave, created_at, global_slug, published_locale, req, returning, snapshot, updated_at, version_data] =
        destructure::<9>("createGlobalVersionArgs", &args)?;
      (autosave, global_slug, created_at, Val::Undefined, published_locale, req, returning, snapshot, updated_at, version_data)
    } else {
      let [autosave, collection_slug, created_at, parent, published_locale, req, returning, snapshot, updated_at, version_data] =
        destructure::<10>("createVersionArgs", &args)?;
      (autosave, collection_slug, created_at, parent, published_locale, req, returning, snapshot, updated_at, version_data)
    };

  let (entity_config, model) = if is_global {
    let g = entity::get_global(this.get(), slug.get(), true)?;
    (g.global_config, g.model)
  } else {
    let c = entity::get_collection(this.get(), slug.get(), true)?;
    (c.collection_config, c.model)
  };

  let data = helpers::call_val(
    "versionData",
    &[
      autosave.get(),
      created_at.get(),
      parent.get(),
      published_locale.get(),
      snapshot.get(),
      updated_at.get(),
      version_data.get(),
      js::boolean(!is_global),
    ],
  )?;
  if !truthy(get(data.get(), "createdAt")?) {
    set(data.get(), "createdAt", clock::now_iso()?)?;
  }

  let config = get(get(this.get(), "payload")?, "config")?;
  let builder = if is_global { "buildVersionGlobalFields" } else { "buildVersionCollectionFields" };
  let fields = val(call(builder, &[config, entity_config.get()])?)?;

  transform_write(&this, &data, fields.clone(), None, None)?;

  let options = session_options(&this, &req).await?;

  let p = helpers::call("modelCreate", &[model.get(), data.get(), options.get()])?;
  let docs = wait(p).await?;
  let doc = helpers::call_val("first", &[docs.get()])?;
  let converted = if mutant(8) { Some(val(call_method(doc.get(), "toObject", &[], "doc.toObject")?)?) } else { None };

  // the latest flip reads the hydrated document's `_id` / `updatedAt` (engine review item 1)
  let p = if is_global {
    helpers::call("globalVersionLatestFlip", &[model.get(), doc.get(), options.get()])?
  } else {
    let parent_query = helpers::call("parentQuery", &[data.get()])?;
    helpers::call("versionLatestFlip", &[model.get(), doc.get(), parent_query, options.get()])?
  };
  wait(p).await?;

  if is_false(returning.get()) {
    return Ok(Val::Null);
  }

  let doc = match converted {
    Some(doc) => doc,
    None => val(call_method(doc.get(), "toObject", &[], "doc.toObject")?)?,
  };

  transform_read(&this, &doc, fields, None)?;

  Ok(doc)
}
