//! db-mongodb's `init.ts` (the `init` adapter method), `models/buildCollectionSchema.ts`,
//! `models/buildGlobalModel.ts`, `models/schemaBuildContext.ts` (`createMongoSchemaBuildContext`)
//! and `utilities/getDBName.ts` on the live adapter: the connection, `afterCreateConnection`
//! (awaited where upstream awaits it), then every schema, plugin, user `dbName` callback and
//! `connection.model` call interleaved in upstream's order.

use std::rc::Rc;

use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Type, Val};

use super::build::{BuildArgs, Deps, Options, build_schema};
use super::jsx::{
  self, array_method, call_fn, call_method, get, get_k, gt, is_array, nullish, obj, s, set, set_k, tpl, truthy, val,
  with_cb,
};

/// `init.call(adapter)` with `deps = { mongoose, paginate, getBuildQueryPlugin, payload, defaultPlugins }`:
/// the promise of the async method.
pub fn init(adapter: Local, deps: Local) -> JsResult<Local> {
  let adapter = val(adapter)?;
  let deps = val(deps)?;
  spawn(async move {
    let d = {
      let deps = deps.get();
      Deps {
        mongoose: val(js::get_named(deps, "mongoose")?)?,
        paginate: val(js::get_named(deps, "paginate")?)?,
        get_build_query_plugin: val(js::get_named(deps, "getBuildQueryPlugin")?)?,
        payload: val(js::get_named(deps, "payload")?)?,
        default_plugins: val(js::get_named(deps, "defaultPlugins")?)?,
      }
    };
    // this.connection ??= mongoose.createConnection()
    let this = adapter.get();
    if nullish(get(this, "connection")?) {
      let connection = call_method(d.mongoose.get(), "createConnection", &[], "mongoose.createConnection")?;
      set(this, "connection", connection)?;
    }
    // if (this.afterCreateConnection) await this.afterCreateConnection(this)
    if truthy(get(this, "afterCreateConnection")?) {
      let p = call_method(this, "afterCreateConnection", &[this], "this.afterCreateConnection")?;
      await_js(p).await?;
    }
    build_models(&d, adapter.get())?;
    Ok(Val::Undefined)
  })
}

/// The synchronous rest of `init`: `try { ... } finally { schemaBuildContext.clear() }`.
pub fn build_models(d: &Deps, this: Local) -> JsResult<()> {
  let context = create_mongo_schema_build_context(d, get(this, "connection")?)?;
  let result = build_all(d, this, context);
  // finally: a throw of clear() replaces the completion
  call_method(context, "clear", &[], "schemaBuildContext.clear")?;
  result
}

/// `createMongoSchemaBuildContext({ connection })`
fn create_mongo_schema_build_context(d: &Deps, connection: Local) -> JsResult<Local> {
  let plugins = get(get(connection, "base")?, "plugins")?;
  let has_custom_global_plugins = array_method(plugins, "some", "getMongoosePluginRegistry(...)", &mut |args| {
    let plugin = jsx::call("first", &[args[0]])?;
    let known = jsx::call("setHas", &[d.default_plugins.get(), plugin])?;
    Ok(js::boolean(!truthy(known)))
  })?;
  let length = get(get(connection, "plugins")?, "length")?;
  let is_cache_enabled = jsx::strict_eq(length, js::number(0.0)) && !truthy(has_custom_global_plugins);
  d.payload_fn("createSchemaBuildContext", &[obj(&[("isCacheEnabled", js::boolean(is_cache_enabled))])?])
}

fn payload_config(this: Local) -> JsResult<Local> {
  get(get(this, "payload")?, "config")
}

fn build_all(d: &Deps, this: Local, context: Local) -> JsResult<()> {
  let collections = get(payload_config(this)?, "collections")?;
  array_method(collections, "forEach", "this.payload.config.collections", &mut |args| {
    collection_models(d, this, context, args[0])?;
    Ok(js::undefined())
  })?;

  let globals_model = build_global_model(d, this, context)?;
  set(this, "globals", globals_model)?;

  let globals = get(payload_config(this)?, "globals")?;
  array_method(globals, "forEach", "this.payload.config.globals", &mut |args| {
    global_version_model(d, this, context, args[0])?;
    Ok(js::undefined())
  })?;
  Ok(())
}

/// `.plugin(paginate, { useEstimatedCount: true }).plugin(getBuildQueryPlugin(<args>))`
fn plugins(d: &Deps, schema: Local, build_query_args: impl FnOnce() -> JsResult<Option<Local>>) -> JsResult<()> {
  let options = obj(&[("useEstimatedCount", js::boolean(true))])?;
  let chained = call_method(schema, "plugin", &[d.paginate.get(), options], "schema.plugin")?;
  let plugin = get(chained, "plugin")?;
  let args = build_query_args()?;
  let query_plugin = call_fn(
    d.get_build_query_plugin.get(),
    js::undefined(),
    args.as_ref().map(std::slice::from_ref).unwrap_or(&[]),
    "getBuildQueryPlugin",
  )?;
  call_fn(plugin, chained, &[query_plugin], "schema.plugin(...).plugin")?;
  Ok(())
}

/// `this.autoPluralization === true && !entity.dbName ? undefined : modelName`
fn collection_name(this: Local, entity: Local, model_name: Local) -> JsResult<Local> {
  if jsx::is_true(get(this, "autoPluralization")?) && !truthy(get(entity, "dbName")?) {
    Ok(js::undefined())
  } else {
    Ok(model_name)
  }
}

/// `this[target][entity.slug] = this.connection.model(name, schema, collectionName)`
fn register_model(this: Local, target: &str, entity: Local, name: Local, schema: Local, collection: Local) -> JsResult<()> {
  let models = get(this, target)?;
  let key = get(entity, "slug")?;
  let model = call_method(get(this, "connection")?, "model", &[name, schema, collection], "this.connection.model")?;
  set_k(models, key, model)
}

/// The body of `this.payload.config.collections.forEach((collection) => { ... })`.
fn collection_models(d: &Deps, this: Local, context: Local, collection: Local) -> JsResult<()> {
  // const schemaOptions = this.collectionsSchemaOptions?.[collection.slug]
  let options_by_slug = get(this, "collectionsSchemaOptions")?;
  let schema_options =
    if nullish(options_by_slug) { js::undefined() } else { get_k(options_by_slug, get(collection, "slug")?)? };
  let payload = get(this, "payload")?;
  let schema = build_collection_schema(d, collection, payload, context, schema_options)?;

  if truthy(get(collection, "versions")?) {
    let version_model_name = get_db_name(d, collection, true)?;
    let version_fields = d.payload_fn("buildVersionCollectionFields", &[payload_config(this)?, collection])?;
    let index_sortable_fields = get(payload_config(this)?, "indexSortableFields")?;
    let options = obj(&[("minimize", js::boolean(false)), ("timestamps", js::boolean(false))])?;
    jsx::call("spreadInto", &[options, schema_options])?;
    let compound_indexes = d.payload_fn(
      "buildVersionCompoundIndexes",
      &[obj(&[("indexes", get(collection, "sanitizedIndexes")?)])?],
    )?;
    let payload = get(this, "payload")?;
    let schema_path = tpl(&[s("collection:"), get(collection, "slug")?])?;
    let version_schema = build_schema(
      d,
      BuildArgs {
        build_schema_options: Rc::new(Options {
          allow_id_field: Val::Undefined,
          disable_unique: Val::Bool(true),
          drafts_enabled: Val::Bool(true),
          index_sortable_fields: val(index_sortable_fields)?,
          options: val(options)?,
        }),
        compound_indexes,
        config_fields: version_fields,
        flattened_fields: js::undefined(),
        is_version: true,
        parent_is_localized: js::undefined(),
        payload,
        context,
        schema_path,
      },
    )?;
    plugins(d, version_schema, || {
      let slug = get(collection, "slug")?;
      let fields =
        d.payload_fn("buildVersionCollectionFields", &[payload_config(this)?, collection, js::boolean(true)])?;
      Ok(Some(obj(&[("collectionSlug", slug), ("versionsFields", fields)])?))
    })?;
    let version_collection_name = collection_name(this, collection, version_model_name)?;
    register_model(this, "versions", collection, version_model_name, version_schema, version_collection_name)?;
  }

  let model_name = get_db_name(d, collection, false)?;
  let name = collection_name(this, collection, model_name)?;
  register_model(this, "collections", collection, model_name, schema, name)
}

/// `buildCollectionSchema({ collection, payload, schemaBuildContext, schemaOptions })`
fn build_collection_schema(
  d: &Deps,
  collection: Local,
  payload: Local,
  context: Local,
  schema_options: Local,
) -> JsResult<Local> {
  // schemaOptions = {}
  let schema_options = if jsx::is_undefined(schema_options) { js::object() } else { schema_options };
  // Boolean(typeof collection?.versions === 'object' && collection.versions.drafts)
  let drafts_enabled = {
    let versions = jsx::opt(collection, "versions")?;
    matches!(js::type_of(versions), Type::Object | Type::Null) && truthy(get(get(collection, "versions")?, "drafts")?)
  };
  let index_sortable_fields = get(get(payload, "config")?, "indexSortableFields")?;
  let timestamps = !jsx::is_false(get(collection, "timestamps")?);
  let options = obj(&[("minimize", js::boolean(false)), ("timestamps", js::boolean(timestamps))])?;
  jsx::call("spreadInto", &[options, schema_options])?;
  let compound_indexes = get(collection, "sanitizedIndexes")?;
  let config_fields = get(collection, "fields")?;
  let flattened_fields = get(collection, "flattenedFields")?;
  let schema_path = tpl(&[s("collection:"), get(collection, "slug")?])?;
  let schema = build_schema(
    d,
    BuildArgs {
      build_schema_options: Rc::new(Options {
        allow_id_field: Val::Undefined,
        disable_unique: Val::Undefined,
        drafts_enabled: Val::Bool(drafts_enabled),
        index_sortable_fields: val(index_sortable_fields)?,
        options: val(options)?,
      }),
      compound_indexes,
      config_fields,
      flattened_fields,
      is_version: false,
      parent_is_localized: js::undefined(),
      payload,
      context,
      schema_path,
    },
  )?;

  if is_array(get(get(collection, "upload")?, "filenameCompoundIndex")?)? {
    let indexes = get(get(collection, "upload")?, "filenameCompoundIndex")?;
    let reduce = get(indexes, "reduce")?;
    let definition = with_cb(
      &mut |args| {
        let (acc, index) = (args[0], args[1]);
        set_k(acc, index, js::number(1.0))?;
        Ok(acc)
      },
      |cb| call_fn(reduce, indexes, &[cb, js::object()], "collection.upload.filenameCompoundIndex.reduce"),
    )?;
    call_method(schema, "index", &[definition, obj(&[("unique", js::boolean(true))])?], "schema.index")?;
  }

  plugins(d, schema, || Ok(Some(obj(&[("collectionSlug", get(collection, "slug")?)])?)))?;
  Ok(schema)
}

/// `buildGlobalModel({ adapter, schemaBuildContext })`
fn build_global_model(d: &Deps, adapter: Local, context: Local) -> JsResult<Local> {
  let globals = get(payload_config(adapter)?, "globals")?;
  if !(truthy(globals) && gt(get(get(payload_config(adapter)?, "globals")?, "length")?, js::number(0.0))?) {
    return Ok(js::null());
  }
  let options = obj(&[
    ("discriminatorKey", s("globalType")),
    ("minimize", js::boolean(false)),
    ("timestamps", js::boolean(true)),
  ])?;
  let globals_schema = d.new_schema(js::object(), options)?;
  let plugin = get(globals_schema, "plugin")?;
  let query_plugin = call_fn(d.get_build_query_plugin.get(), js::undefined(), &[], "getBuildQueryPlugin")?;
  call_fn(plugin, globals_schema, &[query_plugin], "globalsSchema.plugin")?;
  let globals_model =
    call_method(get(adapter, "connection")?, "model", &[s("globals"), globals_schema, s("globals")], "adapter.connection.model")?;

  let configs = jsx::values(get(payload_config(adapter)?, "globals")?)?;
  array_method(configs, "forEach", "Object.values(adapter.payload.config.globals)", &mut |args| {
    let global_config = args[0];
    let config_fields = get(global_config, "fields")?;
    let payload = get(adapter, "payload")?;
    let schema_path = tpl(&[s("global:"), get(global_config, "slug")?])?;
    let options = obj(&[("minimize", js::boolean(false))])?;
    let global_schema = build_schema(
      d,
      BuildArgs {
        build_schema_options: Rc::new(Options::new(options)?),
        compound_indexes: js::undefined(),
        config_fields,
        flattened_fields: js::undefined(),
        is_version: false,
        parent_is_localized: js::undefined(),
        payload,
        context,
        schema_path,
      },
    )?;
    let discriminator = get(globals_model, "discriminator")?;
    call_fn(discriminator, globals_model, &[get(global_config, "slug")?, global_schema], "Globals.discriminator")?;
    Ok(js::undefined())
  })?;
  Ok(globals_model)
}

/// The body of `this.payload.config.globals.forEach((global) => { ... })`.
fn global_version_model(d: &Deps, this: Local, context: Local, global: Local) -> JsResult<()> {
  if !truthy(get(global, "versions")?) {
    return Ok(());
  }
  let version_model_name = get_db_name(d, global, true)?;
  let version_fields = d.payload_fn("buildVersionGlobalFields", &[payload_config(this)?, global])?;
  let index_sortable_fields = get(payload_config(this)?, "indexSortableFields")?;
  let options = obj(&[("minimize", js::boolean(false)), ("timestamps", js::boolean(false))])?;
  let payload = get(this, "payload")?;
  let schema_path = tpl(&[s("global:"), get(global, "slug")?])?;
  let version_schema = build_schema(
    d,
    BuildArgs {
      build_schema_options: Rc::new(Options {
        allow_id_field: Val::Undefined,
        disable_unique: Val::Bool(true),
        drafts_enabled: Val::Bool(true),
        index_sortable_fields: val(index_sortable_fields)?,
        options: val(options)?,
      }),
      compound_indexes: js::undefined(),
      config_fields: version_fields,
      flattened_fields: js::undefined(),
      is_version: true,
      parent_is_localized: js::undefined(),
      payload,
      context,
      schema_path,
    },
  )?;
  plugins(d, version_schema, || {
    let fields = d.payload_fn("buildVersionGlobalFields", &[payload_config(this)?, global, js::boolean(true)])?;
    Ok(Some(obj(&[("versionsFields", fields)])?))
  })?;
  register_model(this, "versions", global, version_model_name, version_schema, version_model_name)
}

/// `getDBName({ config, versions })` (target `'dbName'`)
fn get_db_name(d: &Deps, config: Local, versions: bool) -> JsResult<Local> {
  // ({ config: { name, slug }, config, target = 'dbName', versions = false })
  let name = get(config, "name")?;
  let slug = get(config, "slug")?;
  let custom = get(config, "dbName")?;
  let mut result = if truthy(custom) {
    if js::type_of(custom) == Type::Function {
      call_fn(custom, js::undefined(), &[js::object()], "custom")?
    } else {
      custom
    }
  } else if !nullish(name) {
    name
  } else if !nullish(slug) {
    slug
  } else {
    js::null()
  };
  if versions {
    result = tpl(&[s("_"), result, s("_versions")])?;
  }
  if !truthy(result) {
    let message = tpl(&[s("Assertion for DB name of "), name, s(" "), slug, s(" was failed.")])?;
    return Err(d.api_error(message)?);
  }
  Ok(result)
}
