//! `models/buildSchema.ts` of @payloadcms/db-mongodb on the live config: every property read,
//! object literal (key and evaluation order, shared objects), array method callback and mongoose
//! call (`new Schema`, `schema.add`, `schema.index`, `schema.path(...).discriminator`) happens
//! where upstream makes it.

use std::rc::Rc;

use payload_core_runtime::js::{self, JsResult, Local, Type, Val};

use super::jsx::{
  self, arr, array_method, call_fn, call_method, construct, define, for_of_sync, get, get_k, global, is_array, obj,
  obj_k, prop_key, s, thrown, tpl, truthy, val, with_cb,
};

/// The values the upstream modules import, read from the deps object once per `init`.
pub struct Deps {
  /// the `mongoose` module db-mongodb imports
  pub mongoose: Val,
  /// `mongoose-paginate-v2`
  pub paginate: Val,
  /// db-mongodb's `getBuildQueryPlugin`
  pub get_build_query_plugin: Val,
  /// payload's `APIError`, `buildVersionCollectionFields`, `buildVersionCompoundIndexes`,
  /// `buildVersionGlobalFields`, `createSchemaBuildContext`, `fieldAffectsData`,
  /// `fieldIsPresentationalOnly`, `fieldIsVirtual`, `fieldShouldBeLocalized`, `tabHasName`
  pub payload: Val,
  /// `defaultMongoosePluginFunctions` of models/schemaBuildContext.ts (a `Set`)
  pub default_plugins: Val,
}

impl Deps {
  /// `new mongoose.Schema(definition, options)`
  pub fn new_schema(&self, definition: Local, options: Local) -> JsResult<Local> {
    let ctor = get(self.mongoose.get(), "Schema")?;
    construct(ctor, &[definition, options])
  }

  /// `mongoose.Schema.Types.<name>`
  pub fn schema_type(&self, name: &str) -> JsResult<Local> {
    get(get(get(self.mongoose.get(), "Schema")?, "Types")?, name)
  }

  /// A payload function `name(...args)`.
  pub fn payload_fn(&self, name: &str, args: &[Local]) -> JsResult<Local> {
    call_fn(get(self.payload.get(), name)?, js::undefined(), args, name)
  }

  /// `new APIError(message)`
  pub fn api_error(&self, message: Local) -> jsx::ThrownResult {
    let ctor = get(self.payload.get(), "APIError")?;
    Ok(thrown(construct(ctor, &[message])?))
  }

  /// `fieldShouldBeLocalized({ field, parentIsLocalized })`
  pub fn should_be_localized(&self, field: Local, parent_is_localized: Local) -> JsResult<bool> {
    let args = obj(&[("field", field), ("parentIsLocalized", parent_is_localized)])?;
    Ok(truthy(self.payload_fn("fieldShouldBeLocalized", &[args])?))
  }

  pub fn affects_data(&self, field: Local) -> JsResult<bool> {
    Ok(truthy(self.payload_fn("fieldAffectsData", &[field])?))
  }

  pub fn is_virtual(&self, field: Local) -> JsResult<bool> {
    Ok(truthy(self.payload_fn("fieldIsVirtual", &[field])?))
  }
}

/// `BuildSchemaOptions` literals: absent keys are `undefined` (only read by this module).
#[derive(Clone)]
pub struct Options {
  pub allow_id_field: Val,
  pub disable_unique: Val,
  pub drafts_enabled: Val,
  pub index_sortable_fields: Val,
  pub options: Val,
}

impl Options {
  pub fn new(options: Local) -> JsResult<Options> {
    Ok(Options {
      allow_id_field: Val::Undefined,
      disable_unique: Val::Undefined,
      drafts_enabled: Val::Undefined,
      index_sortable_fields: Val::Undefined,
      options: val(options)?,
    })
  }

  /// `buildSchemaOptions` as a JS object (only for a generator reached through
  /// `Object.prototype`, which receives it).
  fn to_js(&self) -> JsResult<Local> {
    let o = js::object();
    for (k, v) in [
      ("allowIDField", &self.allow_id_field),
      ("disableUnique", &self.disable_unique),
      ("draftsEnabled", &self.drafts_enabled),
      ("indexSortableFields", &self.index_sortable_fields),
      ("options", &self.options),
    ] {
      if !v.is_undefined() {
        define(o, js::key(k), v.get())?;
      }
    }
    Ok(o)
  }
}

/// `SchemaBuildState`
#[derive(Clone)]
pub struct State {
  pub context: Val,
  pub is_version: bool,
  pub path: Val,
}

impl State {
  fn to_js(&self) -> JsResult<Local> {
    obj(&[("context", self.context.get()), ("isVersion", js::boolean(self.is_version)), ("path", self.path.get())])
  }
}

/// `buildSchema(args)`: the args literal's values, evaluated by the caller in its order.
pub struct BuildArgs {
  pub build_schema_options: Rc<Options>,
  /// `undefined` when the literal has no `compoundIndexes`
  pub compound_indexes: Local,
  pub config_fields: Local,
  pub flattened_fields: Local,
  pub is_version: bool,
  /// `undefined` when the literal has no `parentIsLocalized`
  pub parent_is_localized: Local,
  pub payload: Local,
  pub context: Local,
  pub schema_path: Local,
}

/// `buildSchema(args)`
pub fn build_schema(d: &Deps, a: BuildArgs) -> JsResult<Local> {
  let state = State { context: val(a.context)?, is_version: a.is_version, path: val(a.schema_path)? };
  let opts = a.build_schema_options;
  let payload = a.payload;
  let mut fields = js::object();
  let mut schema_fields = a.config_fields;

  if !truthy(opts.allow_id_field.get()) {
    let to_search = if truthy(a.flattened_fields) { a.flattened_fields } else { schema_fields };
    let id_field = array_method(to_search, "find", "fieldsToSearch", &mut |args| {
      let field = args[0];
      Ok(js::boolean(d.affects_data(field)? && jsx::eq_str(get(field, "name")?, "id")))
    })?;
    if truthy(id_field) {
      let id_type = if jsx::eq_str(get(id_field, "type")?, "number") {
        if truthy(get(get(payload, "db")?, "useBigIntForNumberIDs")?) {
          d.schema_type("BigInt")?
        } else {
          global("Number")?
        }
      } else {
        global("String")?
      };
      fields = obj(&[("_id", id_type)])?;
      schema_fields = array_method(schema_fields, "filter", "schemaFields", &mut |args| {
        let field = args[0];
        Ok(js::boolean(!(d.affects_data(field)? && jsx::eq_str(get(field, "name")?, "id"))))
      })?;
    }
  }

  let schema = d.new_schema(fields, opts.options.get())?;
  let parent_is_localized =
    if jsx::nullish(a.parent_is_localized) { js::boolean(false) } else { a.parent_is_localized };

  array_method(schema_fields, "forEach", "schemaFields", &mut |args| {
    let field = args[0];
    if d.is_virtual(field)? {
      return Ok(js::undefined());
    }
    if !truthy(d.payload_fn("fieldIsPresentationalOnly", &[field])?) {
      add_field(d, field, schema, payload, &opts, parent_is_localized, &state)?;
    }
    Ok(js::undefined())
  })?;

  if truthy(a.compound_indexes) {
    for_of_sync(a.compound_indexes, "args.compoundIndexes", |index| {
      let definition = js::object();
      for_of_sync(get(index, "fields")?, "index.fields", |field| {
        if truthy(get(field, "pathHasLocalized")?) && truthy(get(get(payload, "config")?, "localization")?) {
          let locales = get(get(get(payload, "config")?, "localization")?, "locales")?;
          for_of_sync(locales, "payload.config.localization.locales", |locale| {
            let path = get(field, "localizedPath")?;
            let key = jsx::call("replace", &[path, s("<locale>"), get(locale, "code")?])?;
            jsx::set_k(definition, key, js::number(1.0))
          })
        } else {
          jsx::set_k(definition, get(field, "path")?, js::number(1.0))
        }
      })?;
      let unique = if truthy(opts.disable_unique.get()) { js::boolean(false) } else { get(index, "unique")? };
      call_method(schema, "index", &[definition, obj(&[("unique", unique)])?], "schema.index")?;
      Ok(())
    })?;
  }
  Ok(schema)
}

/// `const addFieldSchema = getSchemaGenerator(field.type); if (addFieldSchema) addFieldSchema(...)`
#[allow(clippy::too_many_arguments)]
fn add_field(
  d: &Deps,
  field: Local,
  schema: Local,
  payload: Local,
  opts: &Rc<Options>,
  parent_is_localized: Local,
  state: &State,
) -> JsResult<()> {
  let generator = jsx::call("schemaGenerator", &[get(field, "type")?])?;
  if js::type_of(generator) == Type::Null {
    return Ok(());
  }
  add_with_generator(d, generator, field, schema, payload, opts, parent_is_localized, state)
}

/// `formatDefaultValue(field)`
fn format_default_value(field: Local) -> JsResult<Local> {
  let t = js::type_of(get(field, "defaultValue")?);
  if t == Type::Undefined {
    return Ok(js::undefined());
  }
  if js::type_of(get(field, "defaultValue")?) == Type::Function {
    return Ok(js::undefined());
  }
  get(field, "defaultValue")
}

struct Gen<'a> {
  d: &'a Deps,
  field: Local,
  schema: Local,
  payload: Local,
  opts: &'a Rc<Options>,
  parent_is_localized: Local,
  state: &'a State,
}

impl Gen<'_> {
  /// `formatBaseSchema({ buildSchemaOptions, field, parentIsLocalized })`
  fn base(&self) -> JsResult<Local> {
    let (field, opts) = (self.field, self.opts);
    let disable_unique = truthy(opts.disable_unique.get());
    let default = format_default_value(field)?;
    // field.index || (!disableUnique && field.unique) || indexSortableFields || false
    let mut index = get(field, "index")?;
    if !truthy(index) {
      index = if disable_unique { js::boolean(false) } else { get(field, "unique")? };
      if !truthy(index) {
        index = opts.index_sortable_fields.get();
        if !truthy(index) {
          index = js::boolean(false);
        }
      }
    }
    // (!disableUnique && field.unique) || false
    let mut unique = if disable_unique { js::boolean(false) } else { get(field, "unique")? };
    if !truthy(unique) {
      unique = js::boolean(false);
    }
    let schema = obj(&[("default", default), ("index", index), ("required", js::boolean(false)), ("unique", unique)])?;
    if truthy(unique)
      && (self.d.should_be_localized(field, self.parent_is_localized)?
        || truthy(opts.drafts_enabled.get())
        || (self.d.affects_data(field)?
          && !jsx::eq_str(get(field, "type")?, "group")
          && !jsx::eq_str(get(field, "type")?, "tab")
          && !jsx::is_true(get(field, "required")?)))
    {
      define(schema, js::key("sparse"), js::boolean(true))?;
    }
    if truthy(get(field, "hidden")?) {
      define(schema, js::key("hidden"), js::boolean(true))?;
    }
    Ok(schema)
  }

  /// `{ ...formatBaseSchema(...), type }`
  fn base_with_type(&self, type_: impl FnOnce() -> JsResult<Local>) -> JsResult<Local> {
    let base = self.base()?;
    let o = jsx::call("spreadInto", &[js::object(), base])?;
    define(o, js::key("type"), type_()?)?;
    Ok(o)
  }

  /// `localizeSchema(entity, schema, payload.config.localization, parentIsLocalized)` (the
  /// localization argument is read by the caller)
  fn localize(&self, entity: Local, schema: Local, localization: Local) -> JsResult<Local> {
    if self.d.should_be_localized(entity, self.parent_is_localized)?
      && truthy(localization)
      && is_array(get(localization, "locales")?)?
    {
      let initial = obj(&[("_id", js::boolean(false))])?;
      let reduce = |codes: Local| -> JsResult<Local> {
        let m = get(codes, "reduce")?;
        if js::type_of(m) != Type::Function {
          return Err(thrown(jsx::call("notAFunction", &[s("localization.localeCodes.reduce")])?));
        }
        with_cb(
          &mut |args| {
            let (acc, locale) = (args[0], args[1]);
            let next = jsx::call("spreadInto", &[js::object(), acc])?;
            define(next, prop_key(locale)?, schema)?;
            Ok(next)
          },
          |cb| js::call_unguarded(m, codes, &[cb, initial]),
        )
      };
      let type_ = reduce(get(localization, "localeCodes")?)?;
      return obj(&[("type", type_), ("localized", js::boolean(true))]);
    }
    Ok(schema)
  }

  fn localization(&self) -> JsResult<Local> {
    get(get(self.payload, "config")?, "localization")
  }

  /// `schema.add({ [field.name]: localizeSchema(field, value, payload.config.localization, parentIsLocalized) })`
  fn add_localized(&self, value: impl FnOnce() -> JsResult<Local>) -> JsResult<()> {
    let key = prop_key(get(self.field, "name")?)?;
    let value = value()?;
    let localized = self.localize(self.field, value, self.localization()?)?;
    self.add(obj_k(&[(key, localized)])?)
  }

  fn add(&self, definition: Local) -> JsResult<()> {
    call_method(self.schema, "add", &[definition], "schema.add").map(|_| ())
  }

  /// checkbox, code, date, email, json, number, richText, slug, text, textarea
  fn simple(&self, type_: impl FnOnce() -> JsResult<Local>) -> JsResult<()> {
    let base = self.base_with_type(type_)?;
    self.add_localized(|| Ok(base))
  }

  /// `{ _id: false, id: false, minimize: false }`
  fn nested_options() -> JsResult<Local> {
    obj(&[("_id", js::boolean(false)), ("id", js::boolean(false)), ("minimize", js::boolean(false))])
  }

  /// `parentIsLocalized || x.localized`
  fn or_localized(&self, x: Local) -> JsResult<Local> {
    if truthy(self.parent_is_localized) { Ok(self.parent_is_localized) } else { get(x, "localized") }
  }

  /// `${schemaBuildState.path}/<kind>:${x.name}`
  fn child_path(&self, kind: &str, x: Local) -> JsResult<Local> {
    tpl(&[self.state.path.get(), s(&format!("/{kind}:")), get(x, "name")?])
  }

  fn array(&self) -> JsResult<()> {
    let field = self.field;
    let base = self.base()?;
    let options = Options {
      allow_id_field: Val::Bool(true),
      disable_unique: self.opts.disable_unique.clone(),
      drafts_enabled: self.opts.drafts_enabled.clone(),
      index_sortable_fields: Val::Undefined,
      options: val(Self::nested_options()?)?,
    };
    let config_fields = get(field, "fields")?;
    let parent_is_localized = self.or_localized(field)?;
    let schema_path = self.child_path("field", field)?;
    let nested = build_schema(
      self.d,
      BuildArgs {
        build_schema_options: Rc::new(options),
        compound_indexes: js::undefined(),
        config_fields,
        flattened_fields: js::undefined(),
        is_version: self.state.is_version,
        parent_is_localized,
        payload: self.payload,
        context: self.state.context.get(),
        schema_path,
      },
    )?;
    let base_schema = jsx::call("spreadInto", &[js::object(), base])?;
    define(base_schema, js::key("type"), arr(&[nested])?)?;
    self.add_localized(|| Ok(base_schema))
  }

  fn blocks(&self) -> JsResult<()> {
    let (d, field, payload) = (self.d, self.field, self.payload);
    let base = self.base()?;
    let options = obj(&[("_id", js::boolean(false)), ("discriminatorKey", s("blockType"))])?;
    let template = d.new_schema(js::object(), options)?;
    let field_schema = jsx::call("spreadInto", &[js::object(), base])?;
    define(field_schema, js::key("type"), arr(&[template])?)?;
    self.add_localized(|| Ok(field_schema))?;

    array_method(get(field, "blocks")?, "forEach", "field.blocks", &mut |args| {
      let block_item = args[0];
      let block = if jsx::is_string(block_item) { get_k(get(payload, "blocks")?, block_item)? } else { block_item };
      if !truthy(block) {
        return Ok(js::undefined());
      }
      let is_localized = truthy(self.parent_is_localized) || truthy(get(field, "localized")?);
      let is_reference = jsx::is_string(block_item);
      let field_path = self.child_path("field", field)?;
      let context = self.state.context.get();
      let block_schema = with_cb(
        &mut |_| {
          let template = d.new_schema(js::object(), obj(&[("_id", js::boolean(false)), ("id", js::boolean(false))])?)?;
          array_method(get(block, "fields")?, "forEach", "block.fields", &mut |args| {
            let block_field = args[0];
            if d.is_virtual(block_field)? {
              return Ok(js::undefined());
            }
            let generator = jsx::call("schemaGenerator", &[get(block_field, "type")?])?;
            if js::type_of(generator) == Type::Null {
              return Ok(js::undefined());
            }
            // the state literal is evaluated after the lookup, as an argument of the call
            let path = if is_reference {
              tpl(&[s("block:"), get(block, "slug")?])?
            } else {
              tpl(&[field_path, s("/block:"), get(block, "slug")?])?
            };
            let state = State { context: self.state.context.clone(), is_version: self.state.is_version, path: val(path)? };
            add_with_generator(d, generator, block_field, template, payload, self.opts, js::boolean(is_localized), &state)?;
            Ok(js::undefined())
          })?;
          Ok(template)
        },
        |build| {
          let get_or_create = get(context, "getOrCreate")?;
          let cache_key = block_cache_key(get(block, "slug")?, self.opts, field_path, is_localized, is_reference, self.state.is_version)?;
          let args = obj(&[("build", build), ("cacheKey", cache_key), ("definition", block)])?;
          call_fn(get_or_create, context, &[args], "schemaBuildState.context.getOrCreate")
        },
      )?;

      if d.should_be_localized(field, self.parent_is_localized)? && truthy(self.localization()?) {
        let codes = get(self.localization()?, "localeCodes")?;
        array_method(codes, "forEach", "payload.config.localization.localeCodes", &mut |args| {
          let path = tpl(&[get(field, "name")?, s("."), args[0]])?;
          let at = call_method(self.schema, "path", &[path], "schema.path")?;
          call_method(at, "discriminator", &[get(block, "slug")?, block_schema], "schema.path(...).discriminator")?;
          Ok(js::undefined())
        })?;
      } else {
        let at = call_method(self.schema, "path", &[get(field, "name")?], "schema.path")?;
        call_method(at, "discriminator", &[get(block, "slug")?, block_schema], "schema.path(...).discriminator")?;
      }
      Ok(js::undefined())
    })?;
    Ok(())
  }

  /// collapsible, row, unnamed group, unnamed tab: `fields.forEach((subField) => { if
  /// (fieldIsVirtual(subField)) return; ... addFieldSchema(subField, schema, ..., parentIsLocalized', state) })`.
  /// `localized_of`: the container whose `localized` makes `(parentIsLocalized || x.localized) ?? false`.
  fn sub_fields(&self, fields: Local, expr: &str, localized_of: Option<Local>) -> JsResult<()> {
    array_method(fields, "forEach", expr, &mut |args| {
      let sub_field = args[0];
      if self.d.is_virtual(sub_field)? {
        return Ok(js::undefined());
      }
      let generator = jsx::call("schemaGenerator", &[get(sub_field, "type")?])?;
      if js::type_of(generator) == Type::Null {
        return Ok(js::undefined());
      }
      let parent_is_localized = match localized_of {
        None => self.parent_is_localized,
        Some(x) => {
          let v = self.or_localized(x)?;
          if jsx::nullish(v) { js::boolean(false) } else { v }
        }
      };
      add_with_generator(self.d, generator, sub_field, self.schema, self.payload, self.opts, parent_is_localized, self.state)?;
      Ok(js::undefined())
    })
    .map(|_| ())
  }

  fn group(&self) -> JsResult<()> {
    let (d, field, opts) = (self.d, self.field, self.opts);
    if !d.affects_data(field)? {
      return self.sub_fields(get(field, "fields")?, "field.fields", Some(field));
    }
    let formatted = self.base()?;
    // buildSchemaOptions.indexSortableFields && field.name === 'version' && buildSchemaOptions.draftsEnabled
    let index_sortable_fields = {
      let a = opts.index_sortable_fields.get();
      if !truthy(a) {
        a
      } else if !jsx::eq_str(get(field, "name")?, "version") {
        js::boolean(false)
      } else {
        opts.drafts_enabled.get()
      }
    };
    let options = Options {
      allow_id_field: Val::Undefined,
      disable_unique: opts.disable_unique.clone(),
      drafts_enabled: opts.drafts_enabled.clone(),
      index_sortable_fields: val(index_sortable_fields)?,
      options: val(Self::nested_options()?)?,
    };
    let config_fields = get(field, "fields")?;
    let parent_is_localized = self.or_localized(field)?;
    let schema_path = self.child_path("field", field)?;
    let nested = build_schema(
      d,
      BuildArgs {
        build_schema_options: Rc::new(options),
        compound_indexes: js::undefined(),
        config_fields,
        flattened_fields: js::undefined(),
        is_version: self.state.is_version,
        parent_is_localized,
        payload: self.payload,
        context: self.state.context.get(),
        schema_path,
      },
    )?;
    let base_schema = jsx::call("spreadInto", &[js::object(), formatted])?;
    define(base_schema, js::key("type"), nested)?;
    self.add_localized(|| Ok(base_schema))
  }

  fn point(&self) -> JsResult<()> {
    let (d, field, opts) = (self.d, self.field, self.opts);
    let type_ = obj(&[("type", global("String")?), ("enum", arr(&[s("Point")])?)])?;
    if !jsx::is_undefined(get(field, "defaultValue")?) {
      define(type_, js::key("default"), s("Point"))?;
    }
    let coordinates =
      obj(&[("type", arr(&[global("Number")?])?), ("default", format_default_value(field)?), ("required", js::boolean(false))])?;
    let base_schema = obj(&[("type", type_), ("coordinates", coordinates)])?;
    if truthy(opts.disable_unique.get()) && truthy(get(field, "unique")?) && d.should_be_localized(field, self.parent_is_localized)? {
      jsx::set(get(base_schema, "coordinates")?, "sparse", js::boolean(true))?;
    }
    self.add_localized(|| Ok(base_schema))?;

    let index = get(field, "index")?;
    if jsx::is_true(index) || jsx::is_undefined(get(field, "index")?) {
      let index_options = js::object();
      if !truthy(opts.disable_unique.get()) && truthy(get(field, "unique")?) {
        jsx::set(index_options, "sparse", js::boolean(true))?;
        jsx::set(index_options, "unique", js::boolean(true))?;
      }
      if d.should_be_localized(field, self.parent_is_localized)? && truthy(self.localization()?) {
        let locales = get(self.localization()?, "locales")?;
        array_method(locales, "forEach", "payload.config.localization.locales", &mut |args| {
          let key = tpl(&[get(field, "name")?, s("."), get(args[0], "code")?])?;
          call_method(self.schema, "index", &[obj_k(&[(key, s("2dsphere"))])?, index_options], "schema.index")?;
          Ok(js::undefined())
        })?;
      } else {
        let key = prop_key(get(field, "name")?)?;
        call_method(self.schema, "index", &[obj_k(&[(key, s("2dsphere"))])?, index_options], "schema.index")?;
      }
    }
    Ok(())
  }

  /// `field.options.map((option) => typeof option === 'object' ? option.value : option)`
  fn option_values(&self) -> JsResult<Local> {
    array_method(get(self.field, "options")?, "map", "field.options", &mut |args| {
      let option = args[0];
      if js::type_of(option).is_typeof_object() { get(option, "value") } else { Ok(option) }
    })
  }

  fn radio(&self) -> JsResult<()> {
    let base = self.base()?;
    let o = jsx::call("spreadInto", &[js::object(), base])?;
    define(o, js::key("type"), global("String")?)?;
    define(o, js::key("enum"), self.option_values()?)?;
    self.add_localized(|| Ok(o))
  }

  fn select(&self) -> JsResult<()> {
    let (field, opts) = (self.field, self.opts);
    let base = self.base()?;
    let base_schema = jsx::call("spreadInto", &[js::object(), base])?;
    define(base_schema, js::key("type"), global("String")?)?;
    define(base_schema, js::key("enum"), self.option_values()?)?;
    if truthy(opts.drafts_enabled.get()) || !truthy(get(field, "required")?) {
      call_method(get(base_schema, "enum")?, "push", &[js::null()], "baseSchema.enum.push")?;
    }
    let key = prop_key(get(field, "name")?)?;
    let value = if truthy(get(field, "hasMany")?) { arr(&[base_schema])? } else { base_schema };
    let localized = self.localize(field, value, self.localization()?)?;
    self.add(obj_k(&[(key, localized)])?)
  }

  fn tabs(&self) -> JsResult<()> {
    let (d, field) = (self.d, self.field);
    array_method(get(field, "tabs")?, "forEach", "field.tabs", &mut |args| {
      let tab = args[0];
      if truthy(d.payload_fn("tabHasName", &[tab])?) {
        if d.is_virtual(tab)? {
          return Ok(js::undefined());
        }
        let options = Options {
          allow_id_field: Val::Undefined,
          disable_unique: self.opts.disable_unique.clone(),
          drafts_enabled: self.opts.drafts_enabled.clone(),
          index_sortable_fields: Val::Undefined,
          options: val(Self::nested_options()?)?,
        };
        let config_fields = get(tab, "fields")?;
        let parent_is_localized = self.or_localized(tab)?;
        let schema_path = tpl(&[self.state.path.get(), s("/tab:"), get(tab, "name")?])?;
        let nested = build_schema(
          d,
          BuildArgs {
            build_schema_options: Rc::new(options),
            compound_indexes: js::undefined(),
            config_fields,
            flattened_fields: js::undefined(),
            is_version: self.state.is_version,
            parent_is_localized,
            payload: self.payload,
            context: self.state.context.get(),
            schema_path,
          },
        )?;
        let base_schema = obj(&[("type", nested)])?;
        let key = prop_key(get(tab, "name")?)?;
        let localized = self.localize(tab, base_schema, self.localization()?)?;
        self.add(obj_k(&[(key, localized)])?)?;
      } else {
        self.sub_fields(get(tab, "fields")?, "tab.fields", Some(tab))?;
      }
      Ok(js::undefined())
    })
    .map(|_| ())
  }

  /// relationship and upload
  fn relationship(&self) -> JsResult<()> {
    let (d, field) = (self.d, self.field);
    let has_many_relations = is_array(get(field, "relationTo")?)?;
    let value_type = self.relationship_value_type()?;
    let mut schema_to_return;
    if d.should_be_localized(field, self.parent_is_localized)? && truthy(self.localization()?) {
      let codes = get(self.localization()?, "localeCodes")?;
      let m = get(codes, "reduce")?;
      if js::type_of(m) != Type::Function {
        return Err(thrown(jsx::call("notAFunction", &[s("payload.config.localization.localeCodes.reduce")])?));
      }
      let type_ = with_cb(
        &mut |args| {
          let (locales, locale) = (args[0], args[1]);
          let locale_schema = if has_many_relations {
            let o = jsx::call("spreadInto", &[js::object(), self.base()?])?;
            define(o, js::key("_id"), js::boolean(false))?;
            define(o, js::key("type"), d.schema_type("Mixed")?)?;
            let relation_to = obj(&[("type", global("String")?), ("enum", get(field, "relationTo")?)])?;
            define(o, js::key("relationTo"), relation_to)?;
            let ref_path = tpl(&[get(field, "name")?, s("."), locale, s(".relationTo")])?;
            define(o, js::key("value"), obj(&[("type", value_type), ("refPath", ref_path)])?)?;
            o
          } else {
            let o = jsx::call("spreadInto", &[js::object(), self.base()?])?;
            define(o, js::key("type"), value_type)?;
            define(o, js::key("ref"), get(field, "relationTo")?)?;
            o
          };
          let next = jsx::call("spreadInto", &[js::object(), locales])?;
          let key = prop_key(locale)?;
          let value = if truthy(get(field, "hasMany")?) {
            obj(&[("type", arr(&[locale_schema])?), ("default", format_default_value(field)?)])?
          } else {
            locale_schema
          };
          define(next, key, value)?;
          Ok(next)
        },
        |cb| js::call_unguarded(m, codes, &[cb, js::object()]),
      )?;
      schema_to_return = obj(&[("_id", js::boolean(false)), ("type", type_), ("localized", js::boolean(true))])?;
    } else if has_many_relations {
      schema_to_return = jsx::call("spreadInto", &[js::object(), self.base()?])?;
      define(schema_to_return, js::key("_id"), js::boolean(false))?;
      define(schema_to_return, js::key("type"), d.schema_type("Mixed")?)?;
      let relation_to = obj(&[("type", global("String")?), ("enum", get(field, "relationTo")?)])?;
      define(schema_to_return, js::key("relationTo"), relation_to)?;
      let ref_path = tpl(&[get(field, "name")?, s(".relationTo")])?;
      define(schema_to_return, js::key("value"), obj(&[("type", value_type), ("refPath", ref_path)])?)?;
      if truthy(get(field, "hasMany")?) {
        schema_to_return = obj(&[("type", arr(&[schema_to_return])?), ("default", format_default_value(field)?)])?;
      }
    } else {
      schema_to_return = jsx::call("spreadInto", &[js::object(), self.base()?])?;
      define(schema_to_return, js::key("type"), value_type)?;
      define(schema_to_return, js::key("ref"), get(field, "relationTo")?)?;
      if truthy(get(field, "hasMany")?) {
        schema_to_return = obj(&[("type", arr(&[schema_to_return])?), ("default", format_default_value(field)?)])?;
      }
    }
    let key = prop_key(get(field, "name")?)?;
    self.add(obj_k(&[(key, schema_to_return)])?)
  }

  /// `getRelationshipValueType(field, payload)`
  fn relationship_value_type(&self) -> JsResult<Local> {
    let (d, field, payload) = (self.d, self.field, self.payload);
    if jsx::is_string(get(field, "relationTo")?) {
      let entry = get_k(get(payload, "collections")?, get(field, "relationTo")?)?;
      let custom_id_type = jsx::opt(entry, "customIDType")?;
      if !truthy(custom_id_type) {
        return d.schema_type("ObjectId");
      }
      if jsx::eq_str(custom_id_type, "number") {
        if truthy(get(get(payload, "db")?, "useBigIntForNumberIDs")?) {
          return d.schema_type("BigInt");
        }
        return d.schema_type("Number");
      }
      return d.schema_type("String");
    }
    let some = array_method(get(field, "relationTo")?, "some", "field.relationTo", &mut |args| {
      let entry = get_k(get(payload, "collections")?, args[0])?;
      Ok(js::boolean(truthy(jsx::opt(entry, "customIDType")?)))
    })?;
    if truthy(some) {
      return d.schema_type("Mixed");
    }
    d.schema_type("ObjectId")
  }
}

#[allow(clippy::too_many_arguments)]
fn add_with_generator(
  d: &Deps,
  generator: Local,
  field: Local,
  schema: Local,
  payload: Local,
  opts: &Rc<Options>,
  parent_is_localized: Local,
  state: &State,
) -> JsResult<()> {
  if js::type_of(generator) == Type::Object {
    let inherited = get(generator, "inherited")?;
    if truthy(inherited) {
      call_fn(inherited, js::undefined(), &[field, schema, payload, opts.to_js()?, parent_is_localized, state.to_js()?], "addFieldSchema")?;
    }
    return Ok(());
  }
  let name = jsx::rust_string_of(generator);
  let g = Gen { d, field, schema, payload, opts, parent_is_localized, state };
  match name.as_str() {
    "array" => g.array(),
    "blocks" => g.blocks(),
    "checkbox" => g.simple(|| global("Boolean")),
    "code" | "email" | "slug" | "textarea" => g.simple(|| global("String")),
    "collapsible" | "row" => g.sub_fields(get(field, "fields")?, "field.fields", None),
    "date" => g.simple(|| global("Date")),
    "group" => g.group(),
    "json" | "richText" => g.simple(|| d.schema_type("Mixed")),
    "number" => g.simple(|| if truthy(get(field, "hasMany")?) { arr(&[global("Number")?]) } else { global("Number") }),
    "point" => g.point(),
    "radio" => g.radio(),
    "relationship" | "upload" => g.relationship(),
    "select" => g.select(),
    "tabs" => g.tabs(),
    "text" => g.simple(|| if truthy(get(field, "hasMany")?) { arr(&[global("String")?]) } else { global("String") }),
    _ => Ok(()),
  }
}

/// `getBlockSchemaCacheKey({ blockSlug, buildSchemaOptions, fieldPath, isLocalized, isReference, isVersion })`
fn block_cache_key(
  block_slug: Local,
  opts: &Options,
  field_path: Local,
  is_localized: bool,
  is_reference: bool,
  is_version: bool,
) -> JsResult<Local> {
  let head = if is_reference {
    tpl(&[s("block:"), block_slug])?
  } else {
    tpl(&[s("inline:"), field_path, s("/block:"), block_slug])?
  };
  let mut parts = vec![head];
  if is_version {
    parts.push(s("-version"));
  }
  let mut key = vec![tpl(&parts)?];
  for (flag, text) in [
    (&opts.disable_unique, "disableUnique:true"),
    (&opts.drafts_enabled, "draftsEnabled:true"),
    (&opts.index_sortable_fields, "indexSortableFields:true"),
  ] {
    if truthy(flag.get()) {
      key.push(s(&format!("|{text}")));
    }
  }
  if is_localized {
    key.push(s("|isLocalized:true"));
  }
  tpl(&key)
}

