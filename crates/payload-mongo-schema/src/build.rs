//! `models/buildSchema.ts`, `models/buildCollectionSchema.ts`, `models/buildGlobalModel.ts`,
//! `models/schemaBuildContext.ts` and the model building of `init.ts`, emitting the mongoose calls
//! as [`Op`]s in upstream's evaluation order.

use std::collections::HashMap;

use indexmap::IndexMap;
use payload_engine::error::{EngineError, Result};
use payload_engine::fields::{
  field_affects_data, field_is_presentational_only, field_is_virtual, field_should_be_localized, tab_has_name,
};
use payload_engine::host::Host;
use payload_engine::js::{JsVal, Obj};

use crate::description::{
  BuildQueryArgs, DObj, DVal, Description, GlobalCtor, ModelId, ModelTarget, Op, SchemaId, SchemaTypeName,
  VersionsFields,
};

/// What `init` reads besides the config graph.
#[derive(Clone, Debug, Default)]
pub struct Options {
  /// `payload.db.useBigIntForNumberIDs` (truthiness)
  pub use_big_int_for_number_ids: bool,
  /// `this.autoPluralization === true`
  pub auto_pluralization: bool,
  /// `createMongoSchemaBuildContext`'s `isCacheEnabled`: no connection plugins and no custom
  /// global mongoose plugins when `init` creates the context (computed by the TS glue).
  pub is_cache_enabled: bool,
}

/// The decoded input graph.
#[derive(Clone, Copy)]
pub struct Input<'a> {
  /// `payload.config`
  pub config: &'a JsVal,
  /// `payload.collections` (`{ [slug]: { customIDType } }`)
  pub collections: &'a JsVal,
  /// `payload.blocks`
  pub blocks: &'a JsVal,
  /// `adapter.collectionsSchemaOptions`
  pub collections_schema_options: &'a JsVal,
}

/// Runs upstream `init`'s model building (everything after `afterCreateConnection`). An error
/// upstream throws ends the description with [`Op::Throw`] after the calls that precede it.
pub fn build_mongo_models(host: &dyn Host, input: Input<'_>, options: &Options) -> Description {
  let mut builder = Builder {
    host,
    input,
    options,
    ops: Vec::new(),
    next_schema: 0,
    next_model: 0,
    cache: HashMap::new(),
  };
  if let Err(error) = builder.init() {
    builder.ops.push(Op::Throw(error));
  }
  Description { ops: builder.ops }
}

/// `BuildSchemaOptions`. Values that upstream combines with `&&` / `||` stay JS values.
#[derive(Clone, Default)]
struct Bso {
  allow_id_field: bool,
  disable_unique: JsVal,
  drafts_enabled: JsVal,
  index_sortable_fields: JsVal,
  options: Option<DVal>,
}

#[derive(Clone)]
struct State {
  is_version: bool,
  path: String,
}

struct BuildSchemaArgs<'v> {
  bso: Bso,
  compound_indexes: Option<JsVal>,
  config_fields: JsVal,
  flattened_fields: Option<&'v JsVal>,
  is_version: bool,
  parent_is_localized: bool,
  schema_path: String,
}

struct Builder<'a> {
  host: &'a dyn Host,
  input: Input<'a>,
  options: &'a Options,
  ops: Vec<Op>,
  next_schema: SchemaId,
  next_model: ModelId,
  /// `schemasByDefinition`: block identity -> cache key -> schema (the `JsVal` keeps the identity
  /// alive, like the WeakMap key).
  cache: HashMap<usize, (JsVal, IndexMap<String, SchemaId>)>,
}

fn type_error(message: impl Into<String>) -> EngineError {
  EngineError::new("TypeError", message)
}

/// `value.<key>` that throws like V8 on `null` / `undefined`.
fn prop<'v>(value: &'v JsVal, key: &str) -> Result<&'v JsVal> {
  if value.is_nullish() {
    return Err(type_error(format!(
      "Cannot read properties of {} (reading '{key}')",
      if value.is_null() { "null" } else { "undefined" }
    )));
  }
  Ok(value.get(key))
}

/// The items of `value` for `<expr>.<method>(...)` (`forEach`, `map`, `find`, `reduce`, ...).
fn array<'v>(value: &'v JsVal, expr: &str, method: &str) -> Result<&'v [JsVal]> {
  prop(value, method)?;
  value.as_arr().ok_or_else(|| type_error(format!("{expr}.{method} is not a function")))
}

/// The items of `for (const x of value)`.
fn iterable<'v>(value: &'v JsVal, expr: &str) -> Result<&'v [JsVal]> {
  value.as_arr().ok_or_else(|| type_error(format!("{expr} is not iterable")))
}

/// ToPropertyKey for the computed keys / template strings upstream builds from config values.
fn key(value: &JsVal) -> String {
  value.to_js_string()
}

fn obj<const N: usize>(entries: [(&str, DVal); N]) -> DObj {
  entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

/// `{ ...target, ...source }` for a config value `source` (own enumerable entries).
fn spread(mut target: DObj, source: &JsVal) -> DObj {
  match source {
    JsVal::Obj(o) if source.typed().is_none() && source.bson().is_none() => {
      for (k, v) in o.iter() {
        target.insert(k.clone(), DVal::Value(v.clone()));
      }
    }
    JsVal::Arr(a) => {
      for (i, v) in a.iter().enumerate() {
        target.insert(i.to_string(), DVal::Value(v.clone()));
      }
    }
    JsVal::Str(s) => {
      for (i, c) in s.encode_utf16().enumerate() {
        target.insert(i.to_string(), DVal::Value(JsVal::str(String::from_utf16_lossy(&[c]))));
      }
    }
    _ => {}
  }
  target
}

/// `indexDefinition[k] = 1`: an assignment, so `__proto__` sets the prototype (ignored for a
/// number) instead of adding a key.
fn assign_key(target: &mut DObj, k: String, v: DVal) {
  if k != "__proto__" {
    target.insert(k, v);
  }
}

/// `String.prototype.replace(pattern, replacement)` with a string pattern (first occurrence,
/// `GetSubstitution` patterns in `replacement`).
fn replace_first(s: &str, pattern: &str, replacement: &str) -> String {
  let Some(pos) = s.find(pattern) else { return s.to_string() };
  let before = &s[..pos];
  let after = &s[pos + pattern.len()..];
  let mut out = String::from(before);
  let mut chars = replacement.chars().peekable();
  while let Some(c) = chars.next() {
    if c != '$' {
      out.push(c);
      continue;
    }
    match chars.peek() {
      Some('$') => {
        chars.next();
        out.push('$');
      }
      Some('&') => {
        chars.next();
        out.push_str(pattern);
      }
      Some('`') => {
        chars.next();
        out.push_str(before);
      }
      Some('\'') => {
        chars.next();
        out.push_str(after);
      }
      _ => out.push('$'),
    }
  }
  out.push_str(after);
  out
}

/// `formatDefaultValue`
fn format_default_value(field: &JsVal) -> JsVal {
  let value = field.get("defaultValue");
  if !value.is_undefined() && !value.is_fn() { value.clone() } else { JsVal::Undefined }
}

/// `a || b || ... || last`
fn or_chain(values: &[JsVal], last: JsVal) -> JsVal {
  values.iter().find(|v| v.truthy()).cloned().unwrap_or(last)
}

/// `typeof option === 'object' ? option.value : option` of the radio / select `enum`.
fn option_values(field: &JsVal) -> Result<Vec<DVal>> {
  array(field.get("options"), "field.options", "map")?
    .iter()
    .map(|option| {
      if option.type_of() == "object" { prop(option, "value").map(|v| DVal::Value(v.clone())) } else { Ok(DVal::Value(option.clone())) }
    })
    .collect()
}

impl Builder<'_> {
  fn localization(&self) -> &JsVal {
    self.input.config.get("localization")
  }

  fn new_schema(&mut self, definition: DVal, options: DVal) -> SchemaId {
    let id = self.next_schema;
    self.next_schema += 1;
    self.ops.push(Op::NewSchema { id, definition, options });
    id
  }

  fn add(&mut self, schema: SchemaId, name: &JsVal, definition: DVal) {
    let mut entries = DObj::new();
    entries.insert(key(name), definition);
    self.ops.push(Op::Add { schema, definition: DVal::obj(entries) });
  }

  fn new_model(&mut self, name: JsVal, schema: SchemaId, collection: JsVal, assign: Option<ModelTarget>) -> ModelId {
    let id = self.next_model;
    self.next_model += 1;
    self.ops.push(Op::Model { id, name, schema, collection, assign });
    id
  }

  /// `init` after `afterCreateConnection`.
  fn init(&mut self) -> Result<()> {
    let config = self.input.config;
    let collections = array(config.get("collections"), "this.payload.config.collections", "forEach")?;
    for (index, collection) in collections.iter().enumerate() {
      let slug = prop(collection, "slug")?;
      let schema_options = match self.input.collections_schema_options {
        options if options.is_nullish() => JsVal::Undefined,
        options => options.get(&key(slug)).clone(),
      };

      let schema = self.build_collection_schema(collection, &schema_options)?;
      if collection.get("versions").truthy() {
        let version_model_name = self.get_db_name(collection, true)?;
        let version_collection_fields = build_version_collection_fields(config, collection)?;
        let compound_indexes = build_version_compound_indexes(collection.get("sanitizedIndexes"))?;
        let version_schema = self.build_schema(BuildSchemaArgs {
          bso: Bso {
            disable_unique: JsVal::Bool(true),
            drafts_enabled: JsVal::Bool(true),
            index_sortable_fields: config.get("indexSortableFields").clone(),
            options: Some(DVal::obj(spread(
              obj([("minimize", DVal::bool(false)), ("timestamps", DVal::bool(false))]),
              &schema_options,
            ))),
            ..Bso::default()
          },
          compound_indexes: Some(compound_indexes),
          config_fields: version_collection_fields,
          flattened_fields: None,
          is_version: true,
          parent_is_localized: false,
          schema_path: format!("collection:{}", key(slug)),
        })?;
        self.ops.push(Op::Paginate {
          schema: version_schema,
          options: DVal::obj(obj([("useEstimatedCount", DVal::bool(true))])),
        });
        self.ops.push(Op::BuildQuery {
          schema: version_schema,
          args: Some(BuildQueryArgs {
            collection_slug: Some(slug.clone()),
            versions_fields: Some(VersionsFields::Collection(index)),
          }),
        });
        let version_collection_name = if self.options.auto_pluralization && !collection.get("dbName").truthy() {
          JsVal::Undefined
        } else {
          version_model_name.clone()
        };
        self.new_model(
          version_model_name,
          version_schema,
          version_collection_name,
          Some(ModelTarget::Versions(slug.clone())),
        );
      }

      let model_name = self.get_db_name(collection, false)?;
      let collection_name = if self.options.auto_pluralization && !collection.get("dbName").truthy() {
        JsVal::Undefined
      } else {
        model_name.clone()
      };
      self.new_model(model_name, schema, collection_name, Some(ModelTarget::Collections(slug.clone())));
    }

    let globals_model = self.build_global_model()?;
    self.ops.push(Op::AssignGlobals { model: globals_model });

    let globals = array(config.get("globals"), "this.payload.config.globals", "forEach")?;
    for (index, global) in globals.iter().enumerate() {
      if !prop(global, "versions")?.truthy() {
        continue;
      }
      let version_model_name = self.get_db_name(global, true)?;
      let version_global_fields = build_version_global_fields(config, global)?;
      let version_schema = self.build_schema(BuildSchemaArgs {
        bso: Bso {
          disable_unique: JsVal::Bool(true),
          drafts_enabled: JsVal::Bool(true),
          index_sortable_fields: config.get("indexSortableFields").clone(),
          options: Some(DVal::obj(obj([("minimize", DVal::bool(false)), ("timestamps", DVal::bool(false))]))),
          ..Bso::default()
        },
        compound_indexes: None,
        config_fields: version_global_fields,
        flattened_fields: None,
        is_version: true,
        parent_is_localized: false,
        schema_path: format!("global:{}", key(global.get("slug"))),
      })?;
      self.ops.push(Op::Paginate {
        schema: version_schema,
        options: DVal::obj(obj([("useEstimatedCount", DVal::bool(true))])),
      });
      self.ops.push(Op::BuildQuery {
        schema: version_schema,
        args: Some(BuildQueryArgs { collection_slug: None, versions_fields: Some(VersionsFields::Global(index)) }),
      });
      self.new_model(
        version_model_name.clone(),
        version_schema,
        version_model_name,
        Some(ModelTarget::Versions(global.get("slug").clone())),
      );
    }
    Ok(())
  }

  /// `getDBName({ config, versions })` (target `dbName`).
  fn get_db_name(&mut self, entity: &JsVal, versions: bool) -> Result<JsVal> {
    let name = entity.get("name");
    let slug = entity.get("slug");
    let custom = entity.get("dbName");
    let mut result = if custom.truthy() {
      match custom {
        JsVal::Fn(id) => self.host.call_value(*id, &JsVal::obj(Obj::new()))?,
        _ => custom.clone(),
      }
    } else if !name.is_nullish() {
      name.clone()
    } else if !slug.is_nullish() {
      slug.clone()
    } else {
      JsVal::Null
    };
    if versions {
      result = JsVal::str(format!("_{}_versions", key(&result)));
    }
    if !result.truthy() {
      return Err(EngineError::api(format!(
        "Assertion for DB name of {} {} was failed.",
        key(name),
        key(slug)
      )));
    }
    Ok(result)
  }

  /// `buildCollectionSchema`
  fn build_collection_schema(&mut self, collection: &JsVal, schema_options: &JsVal) -> Result<SchemaId> {
    let config = self.input.config;
    let versions = collection.get("versions");
    let drafts_enabled = versions.type_of() == "object" && prop(versions, "drafts")?.truthy();
    let options = spread(
      obj([
        ("minimize", DVal::bool(false)),
        ("timestamps", DVal::bool(!matches!(collection.get("timestamps"), JsVal::Bool(false)))),
      ]),
      schema_options,
    );
    let schema = self.build_schema(BuildSchemaArgs {
      bso: Bso {
        drafts_enabled: JsVal::Bool(drafts_enabled),
        index_sortable_fields: config.get("indexSortableFields").clone(),
        options: Some(DVal::obj(options)),
        ..Bso::default()
      },
      compound_indexes: Some(collection.get("sanitizedIndexes").clone()),
      config_fields: collection.get("fields").clone(),
      flattened_fields: Some(collection.get("flattenedFields")),
      is_version: false,
      parent_is_localized: false,
      schema_path: format!("collection:{}", key(collection.get("slug"))),
    })?;

    if let JsVal::Arr(indexes) = prop(prop(collection, "upload")?, "filenameCompoundIndex")? {
      let mut definition = DObj::new();
      for index in indexes.iter() {
        assign_key(&mut definition, key(index), DVal::num(1.0));
      }
      self.ops.push(Op::Index {
        schema,
        fields: DVal::obj(definition),
        options: DVal::obj(obj([("unique", DVal::bool(true))])),
      });
    }

    self.ops.push(Op::Paginate { schema, options: DVal::obj(obj([("useEstimatedCount", DVal::bool(true))])) });
    self.ops.push(Op::BuildQuery {
      schema,
      args: Some(BuildQueryArgs { collection_slug: Some(collection.get("slug").clone()), versions_fields: None }),
    });
    Ok(schema)
  }

  /// `buildGlobalModel`
  fn build_global_model(&mut self) -> Result<Option<ModelId>> {
    let globals = self.input.config.get("globals");
    let length = match globals.as_arr() {
      Some(items) => Some(items.len() as f64),
      None => globals.get("length").as_num(),
    };
    let has_globals = globals.truthy() && length.is_some_and(|n| n > 0.0);
    if !has_globals {
      return Ok(None);
    }
    let globals_schema = self.new_schema(
      DVal::obj(DObj::new()),
      DVal::obj(obj([
        ("discriminatorKey", DVal::str("globalType")),
        ("minimize", DVal::bool(false)),
        ("timestamps", DVal::bool(true)),
      ])),
    );
    self.ops.push(Op::BuildQuery { schema: globals_schema, args: None });
    let model = self.new_model(JsVal::str("globals"), globals_schema, JsVal::str("globals"), None);

    for global in globals.items() {
      let global_schema = self.build_schema(BuildSchemaArgs {
        bso: Bso { options: Some(DVal::obj(obj([("minimize", DVal::bool(false))]))), ..Bso::default() },
        compound_indexes: None,
        config_fields: prop(global, "fields")?.clone(),
        flattened_fields: None,
        is_version: false,
        parent_is_localized: false,
        schema_path: format!("global:{}", key(global.get("slug"))),
      })?;
      self.ops.push(Op::ModelDiscriminator { model, name: global.get("slug").clone(), schema: global_schema });
    }
    Ok(Some(model))
  }

  /// `buildSchema`
  fn build_schema(&mut self, args: BuildSchemaArgs<'_>) -> Result<SchemaId> {
    let BuildSchemaArgs { bso, compound_indexes, config_fields, flattened_fields, is_version, parent_is_localized, schema_path } =
      args;
    let state = State { is_version, path: schema_path };
    let mut fields = DObj::new();
    let mut schema_fields: Vec<JsVal> = Vec::new();
    let mut schema_fields_value = Some(&config_fields);

    if !bso.allow_id_field {
      let fields_to_search = match flattened_fields {
        Some(f) if f.truthy() => f,
        _ => &config_fields,
      };
      let id_field = array(fields_to_search, "fieldsToSearch", "find")?
        .iter()
        .find(|field| field_affects_data(field) && field.get("name").as_str() == Some("id"));
      if let Some(id_field) = id_field {
        let id_type = if id_field.get("type").as_str() == Some("number") {
          if self.options.use_big_int_for_number_ids {
            DVal::SchemaType(SchemaTypeName::BigInt)
          } else {
            DVal::Global(GlobalCtor::Number)
          }
        } else {
          DVal::Global(GlobalCtor::String)
        };
        fields.insert("_id".into(), id_type);
        schema_fields = array(&config_fields, "schemaFields", "filter")?
          .iter()
          .filter(|field| !(field_affects_data(field) && field.get("name").as_str() == Some("id")))
          .cloned()
          .collect();
        schema_fields_value = None;
      }
    }

    let options = bso.options.clone().unwrap_or(DVal::Value(JsVal::Undefined));
    let schema = self.new_schema(DVal::obj(fields), options);

    let schema_fields: &[JsVal] = match schema_fields_value {
      Some(value) => array(value, "schemaFields", "forEach")?,
      None => &schema_fields,
    };
    for field in schema_fields {
      if field_is_virtual(field) {
        continue;
      }
      if !field_is_presentational_only(field) {
        self.add_field_schema(field, schema, &bso, parent_is_localized, &state)?;
      }
    }

    if let Some(compound_indexes) = compound_indexes.filter(|c| c.truthy()) {
      let localization = self.localization().clone();
      for index in iterable(&compound_indexes, "args.compoundIndexes")? {
        let mut definition = DObj::new();
        for field in iterable(prop(index, "fields")?, "index.fields")? {
          if prop(field, "pathHasLocalized")?.truthy() && localization.truthy() {
            for locale in iterable(localization.get("locales"), "payload.config.localization.locales")? {
              let localized_path = field.get("localizedPath");
              prop(localized_path, "replace")?;
              let Some(localized_path) = localized_path.as_str() else {
                return Err(type_error("field.localizedPath.replace is not a function"));
              };
              let code = key(prop(locale, "code")?);
              assign_key(&mut definition, replace_first(&localized_path, "<locale>", &code), DVal::num(1.0));
            }
          } else {
            assign_key(&mut definition, key(field.get("path")), DVal::num(1.0));
          }
        }
        let unique = if bso.disable_unique.truthy() { JsVal::Bool(false) } else { index.get("unique").clone() };
        self.ops.push(Op::Index {
          schema,
          fields: DVal::obj(definition),
          options: DVal::obj(obj([("unique", DVal::Value(unique))])),
        });
      }
    }

    Ok(schema)
  }

  /// `getSchemaGenerator(field.type)(field, schema, ...)`
  fn add_field_schema(&mut self, field: &JsVal, schema: SchemaId, bso: &Bso, parent_is_localized: bool, state: &State) -> Result<()> {
    match field.get("type").as_str().unwrap_or("") {
      "array" => self.array(field, schema, bso, parent_is_localized, state),
      "blocks" => self.blocks(field, schema, bso, parent_is_localized, state),
      "checkbox" => self.scalar(field, schema, bso, parent_is_localized, DVal::Global(GlobalCtor::Boolean)),
      "code" | "email" | "slug" | "textarea" => {
        self.scalar(field, schema, bso, parent_is_localized, DVal::Global(GlobalCtor::String))
      }
      "collapsible" | "row" => self.sub_fields(prop(field, "fields")?, "field.fields", schema, bso, parent_is_localized, state),
      "date" => self.scalar(field, schema, bso, parent_is_localized, DVal::Global(GlobalCtor::Date)),
      "group" => self.group(field, schema, bso, parent_is_localized, state),
      "json" | "richText" => self.scalar(field, schema, bso, parent_is_localized, DVal::SchemaType(SchemaTypeName::Mixed)),
      "number" => {
        let ty = if field.get("hasMany").truthy() {
          DVal::arr(vec![DVal::Global(GlobalCtor::Number)])
        } else {
          DVal::Global(GlobalCtor::Number)
        };
        self.scalar(field, schema, bso, parent_is_localized, ty)
      }
      "point" => self.point(field, schema, bso, parent_is_localized),
      "radio" => {
        let mut base = self.format_base_schema(bso, field, parent_is_localized);
        base.insert("type".into(), DVal::Global(GlobalCtor::String));
        base.insert("enum".into(), DVal::arr(option_values(field)?));
        let definition = self.localize_schema(field, DVal::obj(base), parent_is_localized)?;
        self.add(schema, field.get("name"), definition);
        Ok(())
      }
      "relationship" | "upload" => self.relationship(field, schema, bso, parent_is_localized),
      "select" => {
        let mut base = self.format_base_schema(bso, field, parent_is_localized);
        base.insert("type".into(), DVal::Global(GlobalCtor::String));
        let mut values = option_values(field)?;
        if bso.drafts_enabled.truthy() || !field.get("required").truthy() {
          values.push(DVal::Value(JsVal::Null));
        }
        base.insert("enum".into(), DVal::arr(values));
        let base = DVal::obj(base);
        let entity = if field.get("hasMany").truthy() { DVal::arr(vec![base]) } else { base };
        let definition = self.localize_schema(field, entity, parent_is_localized)?;
        self.add(schema, field.get("name"), definition);
        Ok(())
      }
      "tabs" => self.tabs(field, schema, bso, parent_is_localized, state),
      "text" => {
        let ty = if field.get("hasMany").truthy() {
          DVal::arr(vec![DVal::Global(GlobalCtor::String)])
        } else {
          DVal::Global(GlobalCtor::String)
        };
        self.scalar(field, schema, bso, parent_is_localized, ty)
      }
      _ => Ok(()),
    }
  }

  /// `formatBaseSchema`
  fn format_base_schema(&self, bso: &Bso, field: &JsVal, parent_is_localized: bool) -> DObj {
    let unique_term = if bso.disable_unique.truthy() { JsVal::Bool(false) } else { field.get("unique").clone() };
    let index = or_chain(
      &[field.get("index").clone(), unique_term.clone(), bso.index_sortable_fields.clone()],
      JsVal::Bool(false),
    );
    let unique = or_chain(&[unique_term], JsVal::Bool(false));
    let mut schema = obj([
      ("default", DVal::Value(format_default_value(field))),
      ("index", DVal::Value(index)),
      ("required", DVal::bool(false)),
      ("unique", DVal::Value(unique.clone())),
    ]);
    let field_type = field.get("type").as_str();
    if unique.truthy()
      && (field_should_be_localized(field, parent_is_localized)
        || bso.drafts_enabled.truthy()
        || (field_affects_data(field)
          && field_type != Some("group")
          && field_type != Some("tab")
          && !field.get("required").is_true()))
    {
      schema.insert("sparse".into(), DVal::bool(true));
    }
    if field.get("hidden").truthy() {
      schema.insert("hidden".into(), DVal::bool(true));
    }
    schema
  }

  /// `localizeSchema`
  fn localize_schema(&self, entity: &JsVal, schema: DVal, parent_is_localized: bool) -> Result<DVal> {
    let localization = self.localization();
    if field_should_be_localized(entity, parent_is_localized)
      && localization.truthy()
      && localization.get("locales").as_arr().is_some()
    {
      let mut locales = obj([("_id", DVal::bool(false))]);
      for locale in array(localization.get("localeCodes"), "localization.localeCodes", "reduce")? {
        locales.insert(key(locale), schema.clone());
      }
      return Ok(DVal::obj(obj([("type", DVal::obj(locales)), ("localized", DVal::bool(true))])));
    }
    Ok(schema)
  }

  /// checkbox, code, date, email, json, number, richText, slug, text, textarea
  fn scalar(&mut self, field: &JsVal, schema: SchemaId, bso: &Bso, parent_is_localized: bool, ty: DVal) -> Result<()> {
    let mut base = self.format_base_schema(bso, field, parent_is_localized);
    base.insert("type".into(), ty);
    let definition = self.localize_schema(field, DVal::obj(base), parent_is_localized)?;
    self.add(schema, field.get("name"), definition);
    Ok(())
  }

  /// collapsible, row, unnamed groups and tabs: the sub fields go onto `schema`.
  fn sub_fields(
    &mut self,
    fields: &JsVal,
    expr: &str,
    schema: SchemaId,
    bso: &Bso,
    parent_is_localized: bool,
    state: &State,
  ) -> Result<()> {
    for sub_field in array(fields, expr, "forEach")? {
      if field_is_virtual(sub_field) {
        continue;
      }
      self.add_field_schema(sub_field, schema, bso, parent_is_localized, state)?;
    }
    Ok(())
  }

  fn nested_options() -> DVal {
    DVal::obj(obj([("_id", DVal::bool(false)), ("id", DVal::bool(false)), ("minimize", DVal::bool(false))]))
  }

  fn array(&mut self, field: &JsVal, schema: SchemaId, bso: &Bso, parent_is_localized: bool, state: &State) -> Result<()> {
    let mut base = self.format_base_schema(bso, field, parent_is_localized);
    let nested = self.build_schema(BuildSchemaArgs {
      bso: Bso {
        allow_id_field: true,
        disable_unique: bso.disable_unique.clone(),
        drafts_enabled: bso.drafts_enabled.clone(),
        index_sortable_fields: JsVal::Undefined,
        options: Some(Self::nested_options()),
      },
      compound_indexes: None,
      config_fields: field.get("fields").clone(),
      flattened_fields: None,
      is_version: state.is_version,
      parent_is_localized: parent_is_localized || field.get("localized").truthy(),
      schema_path: format!("{}/field:{}", state.path, key(field.get("name"))),
    })?;
    base.insert("type".into(), DVal::arr(vec![DVal::Schema(nested)]));
    let definition = self.localize_schema(field, DVal::obj(base), parent_is_localized)?;
    self.add(schema, field.get("name"), definition);
    Ok(())
  }

  fn blocks(&mut self, field: &JsVal, schema: SchemaId, bso: &Bso, parent_is_localized: bool, state: &State) -> Result<()> {
    let mut field_schema = self.format_base_schema(bso, field, parent_is_localized);
    let element = self.new_schema(
      DVal::obj(DObj::new()),
      DVal::obj(obj([("_id", DVal::bool(false)), ("discriminatorKey", DVal::str("blockType"))])),
    );
    field_schema.insert("type".into(), DVal::arr(vec![DVal::Schema(element)]));
    let definition = self.localize_schema(field, DVal::obj(field_schema), parent_is_localized)?;
    let name = field.get("name");
    self.add(schema, name, definition);

    for block_item in array(field.get("blocks"), "field.blocks", "forEach")? {
      let block = match block_item {
        JsVal::Str(slug) => prop(self.input.blocks, slug)?.clone(),
        _ => block_item.clone(),
      };
      if !block.truthy() {
        continue;
      }
      let is_localized = parent_is_localized || field.get("localized").truthy();
      let is_reference = block_item.as_str().is_some();
      let field_path = format!("{}/field:{}", state.path, key(name));
      let block_slug = key(prop(&block, "slug")?);
      let cache_key = get_block_schema_cache_key(&block_slug, bso, &field_path, is_localized, is_reference, state.is_version);
      let template_state = State {
        is_version: state.is_version,
        path: if is_reference { format!("block:{block_slug}") } else { format!("{field_path}/block:{block_slug}") },
      };
      let block_schema = self.get_or_create(&block, cache_key, |this| {
        let template = this.new_schema(
          DVal::obj(DObj::new()),
          DVal::obj(obj([("_id", DVal::bool(false)), ("id", DVal::bool(false))])),
        );
        for block_field in array(prop(&block, "fields")?, "block.fields", "forEach")? {
          if field_is_virtual(block_field) {
            continue;
          }
          this.add_field_schema(block_field, template, bso, is_localized, &template_state)?;
        }
        Ok(template)
      })?;

      let localization = self.localization().clone();
      if field_should_be_localized(field, parent_is_localized) && localization.truthy() {
        for locale_code in array(localization.get("localeCodes"), "payload.config.localization.localeCodes", "forEach")? {
          self.ops.push(Op::Discriminator {
            schema,
            path: format!("{}.{}", key(name), key(locale_code)),
            name: block.get("slug").clone(),
            discriminator: block_schema,
          });
        }
      } else {
        self.ops.push(Op::Discriminator {
          schema,
          path: key(name),
          name: block.get("slug").clone(),
          discriminator: block_schema,
        });
      }
    }
    Ok(())
  }

  /// `schemaBuildContext.getOrCreate({ build, cacheKey, definition })`
  fn get_or_create(
    &mut self,
    definition: &JsVal,
    cache_key: String,
    build: impl FnOnce(&mut Self) -> Result<SchemaId>,
  ) -> Result<SchemaId> {
    if !self.options.is_cache_enabled {
      return build(self);
    }
    let identity = definition.identity();
    if let Some(schema) = identity.and_then(|id| self.cache.get(&id)).and_then(|(_, by_key)| by_key.get(&cache_key)) {
      return Ok(*schema);
    }
    let schema = build(self)?;
    let Some(identity) = identity else {
      return Err(type_error("Invalid value used as weak map key"));
    };
    self.cache.entry(identity).or_insert_with(|| (definition.clone(), IndexMap::new())).1.insert(cache_key, schema);
    Ok(schema)
  }

  fn group(&mut self, field: &JsVal, schema: SchemaId, bso: &Bso, parent_is_localized: bool, state: &State) -> Result<()> {
    if !field_affects_data(field) {
      let localized = parent_is_localized || field.get("localized").truthy();
      return self.sub_fields(prop(field, "fields")?, "field.fields", schema, bso, localized, state);
    }
    let mut base = self.format_base_schema(bso, field, parent_is_localized);
    // `indexSortableFields && field.name === 'version' && draftsEnabled`
    let index_sortable_fields = if !bso.index_sortable_fields.truthy() {
      bso.index_sortable_fields.clone()
    } else if field.get("name").as_str() != Some("version") {
      JsVal::Bool(false)
    } else {
      bso.drafts_enabled.clone()
    };
    let nested = self.build_schema(BuildSchemaArgs {
      bso: Bso {
        allow_id_field: false,
        disable_unique: bso.disable_unique.clone(),
        drafts_enabled: bso.drafts_enabled.clone(),
        index_sortable_fields,
        options: Some(Self::nested_options()),
      },
      compound_indexes: None,
      config_fields: field.get("fields").clone(),
      flattened_fields: None,
      is_version: state.is_version,
      parent_is_localized: parent_is_localized || field.get("localized").truthy(),
      schema_path: format!("{}/field:{}", state.path, key(field.get("name"))),
    })?;
    base.insert("type".into(), DVal::Schema(nested));
    let definition = self.localize_schema(field, DVal::obj(base), parent_is_localized)?;
    self.add(schema, field.get("name"), definition);
    Ok(())
  }

  fn point(&mut self, field: &JsVal, schema: SchemaId, bso: &Bso, parent_is_localized: bool) -> Result<()> {
    let mut point_type = obj([
      ("type", DVal::Global(GlobalCtor::String)),
      ("enum", DVal::arr(vec![DVal::str("Point")])),
    ]);
    if !field.get("defaultValue").is_undefined() {
      point_type.insert("default".into(), DVal::str("Point"));
    }
    let mut coordinates = obj([
      ("type", DVal::arr(vec![DVal::Global(GlobalCtor::Number)])),
      ("default", DVal::Value(format_default_value(field))),
      ("required", DVal::bool(false)),
    ]);
    let should_localize = field_should_be_localized(field, parent_is_localized);
    if bso.disable_unique.truthy() && field.get("unique").truthy() && should_localize {
      coordinates.insert("sparse".into(), DVal::bool(true));
    }
    let base = obj([("type", DVal::obj(point_type)), ("coordinates", DVal::obj(coordinates))]);
    let definition = self.localize_schema(field, DVal::obj(base), parent_is_localized)?;
    let name = field.get("name");
    self.add(schema, name, definition);

    let index = field.get("index");
    if index.is_true() || index.is_undefined() {
      let mut index_options = DObj::new();
      if !bso.disable_unique.truthy() && field.get("unique").truthy() {
        index_options.insert("sparse".into(), DVal::bool(true));
        index_options.insert("unique".into(), DVal::bool(true));
      }
      let index_options = DVal::obj(index_options);
      let localization = self.localization().clone();
      if should_localize && localization.truthy() {
        for locale in array(localization.get("locales"), "payload.config.localization.locales", "forEach")? {
          let mut fields = DObj::new();
          fields.insert(format!("{}.{}", key(name), key(prop(locale, "code")?)), DVal::str("2dsphere"));
          self.ops.push(Op::Index { schema, fields: DVal::obj(fields), options: index_options.clone() });
        }
      } else {
        let mut fields = DObj::new();
        fields.insert(key(name), DVal::str("2dsphere"));
        self.ops.push(Op::Index { schema, fields: DVal::obj(fields), options: index_options });
      }
    }
    Ok(())
  }

  /// `getRelationshipValueType`
  fn relationship_value_type(&self, field: &JsVal) -> Result<DVal> {
    let collections = self.input.collections;
    let relation_to = field.get("relationTo");
    if let JsVal::Str(slug) = relation_to {
      let custom_id_type = collections.get(slug).get("customIDType");
      if !custom_id_type.truthy() {
        return Ok(DVal::SchemaType(SchemaTypeName::ObjectId));
      }
      if custom_id_type.as_str() == Some("number") {
        return Ok(DVal::SchemaType(if self.options.use_big_int_for_number_ids {
          SchemaTypeName::BigInt
        } else {
          SchemaTypeName::Number
        }));
      }
      return Ok(DVal::SchemaType(SchemaTypeName::String));
    }
    let relations = array(relation_to, "field.relationTo", "some")?;
    if relations.iter().any(|r| collections.get(&key(r)).get("customIDType").truthy()) {
      return Ok(DVal::SchemaType(SchemaTypeName::Mixed));
    }
    Ok(DVal::SchemaType(SchemaTypeName::ObjectId))
  }

  /// relationship and upload (identical upstream)
  fn relationship(&mut self, field: &JsVal, schema: SchemaId, bso: &Bso, parent_is_localized: bool) -> Result<()> {
    let relation_to = field.get("relationTo");
    let has_many_relations = relation_to.as_arr().is_some();
    let value_type = self.relationship_value_type(field)?;
    let name = field.get("name");
    let has_many = field.get("hasMany").truthy();
    let localization = self.localization().clone();

    let polymorphic = |this: &Self, ref_path: String| {
      let mut s = this.format_base_schema(bso, field, parent_is_localized);
      s.insert("_id".into(), DVal::bool(false));
      s.insert("type".into(), DVal::SchemaType(SchemaTypeName::Mixed));
      s.insert(
        "relationTo".into(),
        DVal::obj(obj([("type", DVal::Global(GlobalCtor::String)), ("enum", DVal::Value(relation_to.clone()))])),
      );
      s.insert("value".into(), DVal::obj(obj([("type", value_type.clone()), ("refPath", DVal::str(ref_path))])));
      s
    };
    let single = |this: &Self| {
      let mut s = this.format_base_schema(bso, field, parent_is_localized);
      s.insert("type".into(), value_type.clone());
      s.insert("ref".into(), DVal::Value(relation_to.clone()));
      s
    };
    let with_has_many = |s: DObj| {
      if has_many {
        DVal::obj(obj([("type", DVal::arr(vec![DVal::obj(s)])), ("default", DVal::Value(format_default_value(field)))]))
      } else {
        DVal::obj(s)
      }
    };

    let schema_to_return = if field_should_be_localized(field, parent_is_localized) && localization.truthy() {
      let mut locales = DObj::new();
      for locale in array(localization.get("localeCodes"), "payload.config.localization.localeCodes", "reduce")? {
        let locale_schema = if has_many_relations {
          polymorphic(self, format!("{}.{}.relationTo", key(name), key(locale)))
        } else {
          single(self)
        };
        locales.insert(key(locale), with_has_many(locale_schema));
      }
      DVal::obj(obj([("_id", DVal::bool(false)), ("type", DVal::obj(locales)), ("localized", DVal::bool(true))]))
    } else if has_many_relations {
      with_has_many(polymorphic(self, format!("{}.relationTo", key(name))))
    } else {
      with_has_many(single(self))
    };
    self.add(schema, name, schema_to_return);
    Ok(())
  }

  fn tabs(&mut self, field: &JsVal, schema: SchemaId, bso: &Bso, parent_is_localized: bool, state: &State) -> Result<()> {
    for tab in array(field.get("tabs"), "field.tabs", "forEach")? {
      if tab_has_name(tab) {
        if field_is_virtual(tab) {
          continue;
        }
        let nested = self.build_schema(BuildSchemaArgs {
          bso: Bso {
            allow_id_field: false,
            disable_unique: bso.disable_unique.clone(),
            drafts_enabled: bso.drafts_enabled.clone(),
            index_sortable_fields: JsVal::Undefined,
            options: Some(Self::nested_options()),
          },
          compound_indexes: None,
          config_fields: tab.get("fields").clone(),
          flattened_fields: None,
          is_version: state.is_version,
          parent_is_localized: parent_is_localized || tab.get("localized").truthy(),
          schema_path: format!("{}/tab:{}", state.path, key(tab.get("name"))),
        })?;
        let base = DVal::obj(obj([("type", DVal::Schema(nested))]));
        let definition = self.localize_schema(tab, base, parent_is_localized)?;
        self.add(schema, tab.get("name"), definition);
      } else {
        let localized = parent_is_localized || tab.get("localized").truthy();
        self.sub_fields(prop(tab, "fields")?, "tab.fields", schema, bso, localized, state)?;
      }
    }
    Ok(())
  }
}

/// `getBlockSchemaCacheKey`
fn get_block_schema_cache_key(
  block_slug: &str,
  bso: &Bso,
  field_path: &str,
  is_localized: bool,
  is_reference: bool,
  is_version: bool,
) -> String {
  let mut parts = vec![format!(
    "{}{}",
    if is_reference { format!("block:{block_slug}") } else { format!("inline:{field_path}/block:{block_slug}") },
    if is_version { "-version" } else { "" }
  )];
  if bso.disable_unique.truthy() {
    parts.push("disableUnique:true".into());
  }
  if bso.drafts_enabled.truthy() {
    parts.push("draftsEnabled:true".into());
  }
  if bso.index_sortable_fields.truthy() {
    parts.push("indexSortableFields:true".into());
  }
  if is_localized {
    parts.push("isLocalized:true".into());
  }
  parts.join("|")
}

fn admin_disabled() -> JsVal {
  JsVal::obj(Obj::from_iter([("disabled".into(), JsVal::Bool(true))]))
}

fn date_field(name: &str) -> JsVal {
  JsVal::obj(Obj::from_iter([
    ("name".into(), JsVal::str(name)),
    ("type".into(), JsVal::str("date")),
    ("admin".into(), admin_disabled()),
    ("index".into(), JsVal::Bool(true)),
  ]))
}

/// The fields `buildVersion{Collection,Global}Fields` append after `version`.
fn version_meta_fields(config: &JsVal, entity: &JsVal, fields: &mut Vec<JsVal>) -> Result<()> {
  fields.push(date_field("createdAt"));
  fields.push(date_field("updatedAt"));
  if payload_engine::fields::has_drafts_enabled(entity) {
    let localization = config.get("localization");
    if localization.truthy() {
      let options = array(localization.get("locales"), "config.localization.locales", "map")?
        .iter()
        .map(|locale| match locale {
          JsVal::Str(_) => Ok(locale.clone()),
          _ => prop(locale, "code").cloned(),
        })
        .collect::<Result<Vec<_>>>()?;
      fields.push(JsVal::obj(Obj::from_iter([
        ("name".into(), JsVal::str("publishedLocale")),
        ("type".into(), JsVal::str("select")),
        ("admin".into(), admin_disabled()),
        ("index".into(), JsVal::Bool(true)),
        ("options".into(), JsVal::arr(options)),
      ])));
    }
    fields.push(JsVal::obj(Obj::from_iter([
      ("name".into(), JsVal::str("latest")),
      ("type".into(), JsVal::str("checkbox")),
      ("admin".into(), admin_disabled()),
      ("index".into(), JsVal::Bool(true)),
    ])));
    if payload_engine::fields::has_autosave_enabled(entity) {
      fields.push(JsVal::obj(Obj::from_iter([
        ("name".into(), JsVal::str("autosave")),
        ("type".into(), JsVal::str("checkbox")),
        ("index".into(), JsVal::Bool(true)),
      ])));
    }
  }
  Ok(())
}

/// `buildVersionCollectionFields(config, collection)` (not flattened)
fn build_version_collection_fields(config: &JsVal, collection: &JsVal) -> Result<JsVal> {
  let version_fields: Vec<JsVal> = array(collection.get("fields"), "collection.fields", "filter")?
    .iter()
    .filter(|field| !field.has("name") || !field.get("name").strict_eq(&JsVal::str("id")))
    .cloned()
    .collect();
  let mut fields = vec![
    JsVal::obj(Obj::from_iter([
      ("name".into(), JsVal::str("parent")),
      ("type".into(), JsVal::str("relationship")),
      ("index".into(), JsVal::Bool(true)),
      ("relationTo".into(), collection.get("slug").clone()),
    ])),
    JsVal::obj(Obj::from_iter([
      ("name".into(), JsVal::str("version")),
      ("type".into(), JsVal::str("group")),
      ("fields".into(), JsVal::arr(version_fields)),
    ])),
  ];
  version_meta_fields(config, collection, &mut fields)?;
  Ok(JsVal::arr(fields))
}

/// `buildVersionGlobalFields(config, global)` (not flattened)
fn build_version_global_fields(config: &JsVal, global: &JsVal) -> Result<JsVal> {
  let mut fields = vec![JsVal::obj(Obj::from_iter([
    ("name".into(), JsVal::str("version")),
    ("type".into(), JsVal::str("group")),
    ("fields".into(), global.get("fields").clone()),
  ]))];
  version_meta_fields(config, global, &mut fields)?;
  Ok(JsVal::arr(fields))
}

/// `buildVersionCompoundIndexes({ indexes })`
fn build_version_compound_indexes(indexes: &JsVal) -> Result<JsVal> {
  let out = array(indexes, "indexes", "map")?
    .iter()
    .map(|each| {
      let fields = array(prop(each, "fields")?, "each.fields", "map")?
        .iter()
        .map(|f| {
          if f.is_nullish() {
            let what = if f.is_null() { "null" } else { "undefined" };
            return Err(type_error(format!("Cannot destructure property 'field' of '{what}' as it is {what}.")));
          }
          Ok(JsVal::obj(Obj::from_iter([
            ("field".into(), f.get("field").clone()),
            ("localizedPath".into(), JsVal::str(format!("version.{}", key(f.get("localizedPath"))))),
            ("path".into(), JsVal::str(format!("version.{}", key(f.get("path"))))),
            ("pathHasLocalized".into(), f.get("pathHasLocalized").clone()),
          ])))
        })
        .collect::<Result<Vec<_>>>()?;
      Ok(JsVal::obj(Obj::from_iter([("fields".into(), JsVal::arr(fields)), ("unique".into(), JsVal::Bool(false))])))
    })
    .collect::<Result<Vec<_>>>()?;
  Ok(JsVal::arr(out))
}
