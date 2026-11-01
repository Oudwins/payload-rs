//! Port of `@payloadcms/drizzle` `schema/buildRawSchema.ts`, `schema/build.ts`,
//! `schema/traverseFields.ts` and their naming helpers.
//!
//! The output mirrors the TS adapter state after `buildRawSchema`:
//! `rawTables`, `rawRelations`, `tableNameMap`, `indexes`, `foreignKeys` and
//! `fieldConstraints`, so it can be compared 1:1 and fed to drizzle.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value as Json, json};

use crate::error::{EngineError, Result};
use crate::fields::{
  field_affects_data, field_has_sub_fields, field_is_virtual, field_should_be_localized, has_autosave_enabled,
  has_drafts_enabled, option_is_object, tab_has_name,
};
use crate::host::Host;
use crate::js::{JsVal, Obj};
use crate::strings::{has_lone_surrogate, js_len, js_slice_to_units, to_snake_case};

/// Postgres max identifier length (NAMEDATALEN - 1).
pub const MAX_IDENTIFIER_LENGTH: usize = 63;
pub const MAX_GENERATED_IDENTIFIER_LENGTH: usize = MAX_IDENTIFIER_LENGTH - 3;

#[derive(Clone, Debug)]
pub struct SchemaOptions {
  pub auto_increment: bool,
  pub blocks_as_json: bool,
  /// `number` | `uuid` | `uuidv7`
  pub id_type: String,
  pub locales_suffix: String,
  pub relationships_suffix: String,
  pub versions_suffix: String,
}

impl SchemaOptions {
  pub fn from_json(json: &Json) -> Self {
    let s = |k: &str, d: &str| json.get(k).and_then(|v| v.as_str()).unwrap_or(d).to_string();
    let b = |k: &str| json.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    Self {
      auto_increment: b("autoIncrement"),
      blocks_as_json: b("blocksAsJSON"),
      id_type: s("idType", "number"),
      locales_suffix: s("localesSuffix", "_locales"),
      relationships_suffix: s("relationshipsSuffix", "_rels"),
      versions_suffix: s("versionsSuffix", "_v"),
    }
  }
}

#[derive(Clone, Debug)]
pub struct RawTable {
  pub name: String,
  pub columns: Map<String, Json>,
  pub foreign_keys: Map<String, Json>,
  pub indexes: Map<String, Json>,
}

impl RawTable {
  pub fn to_json(&self) -> Json {
    json!({
      "name": self.name,
      "columns": self.columns,
      "foreignKeys": self.foreign_keys,
      "indexes": self.indexes,
    })
  }
}

/// The schema state produced by [`build_raw_schema`].
#[derive(Debug, Default)]
pub struct RawSchema {
  /// `None` mirrors TS keys that were assigned `undefined` and never filled.
  pub raw_tables: IndexMap<String, Option<RawTable>>,
  pub raw_relations: IndexMap<String, Map<String, Json>>,
  pub table_name_map: IndexMap<String, String>,
  pub indexes: IndexSet<String>,
  pub foreign_keys: IndexSet<String>,
  pub field_constraints: IndexMap<String, IndexMap<String, String>>,
  /// Mirrors `block[InternalBlockTableNameIndex]`, keyed by block object identity.
  pub block_table_name_index: HashMap<usize, u32>,
  /// The JS `field.defaultValue` of every column built by `withDefault`, keyed by table name then
  /// column key. TS stores the value by reference (`default: field.defaultValue`); the column JSON
  /// in `raw_tables` only holds its `JSON.stringify` form, which loses `Date`s / `bigint`s
  /// ([`crate::js::TypedValue`]), non-finite numbers and object identity.
  pub column_defaults: IndexMap<String, IndexMap<String, JsVal>>,
  /// Generated identifiers (index / foreign key names) whose JS value is not valid UTF-16: TS
  /// truncates names with `name.slice(0, n)`, which can cut a surrogate pair in half. The Rust
  /// string (everywhere it is used above) has U+FFFD instead of the lone surrogate; this maps it
  /// to the exact JS code units (see [`crate::strings::json_to_string_with_utf16`]).
  pub utf16_identifiers: HashMap<String, Vec<u16>>,
}

impl RawSchema {
  pub fn to_json(&self) -> Json {
    json!({
      // keys still holding `undefined` are dropped, like `JSON.stringify`
      "rawTables": self.raw_tables.iter().filter_map(|(k, v)| v.as_ref().map(|t| (k.clone(), t.to_json()))).collect::<Map<_, _>>(),
      "rawRelations": self.raw_relations.iter().map(|(k, v)| (k.clone(), Json::Object(v.clone()))).collect::<Map<_, _>>(),
      "tableNameMap": self.table_name_map.iter().map(|(k, v)| (k.clone(), Json::String(v.clone()))).collect::<Map<_, _>>(),
      "indexes": self.indexes.iter().collect::<Vec<_>>(),
      "foreignKeys": self.foreign_keys.iter().collect::<Vec<_>>(),
      "fieldConstraints": self.field_constraints.iter().map(|(k, v)| (k.clone(), json!(v))).collect::<Map<_, _>>(),
    })
  }
}

#[derive(Clone, Debug)]
struct RelationToBuild {
  kind: &'static str,
  localized: bool,
  relation_name: Option<String>,
  target: String,
}

type RelationMap = Rc<RefCell<IndexMap<String, RelationToBuild>>>;

#[derive(Clone, Copy, Debug, PartialEq)]
enum HasMany {
  No,
  Yes,
  Index,
}

impl HasMany {
  fn truthy(self) -> bool {
    self != HasMany::No
  }
}

#[derive(Debug)]
struct BuildResult {
  has_localized_many_number_field: bool,
  has_localized_many_text_field: bool,
  has_localized_relationship_field: bool,
  has_many_number_field: HasMany,
  has_many_text_field: HasMany,
  relations_to_build: RelationMap,
}

struct TraverseResult {
  has_localized_field: bool,
  has_localized_many_number_field: bool,
  has_localized_many_text_field: bool,
  has_localized_relationship_field: bool,
  has_many_number_field: HasMany,
  has_many_text_field: HasMany,
}

/// Inputs from the running Payload instance.
pub struct SchemaInput<'a> {
  /// `payload.config` (sanitized)
  pub config: &'a JsVal,
  /// `payload.collections`: `{ [slug]: { config, customIDType } }`
  pub collections: &'a JsVal,
  /// `payload.blocks`
  pub blocks: &'a JsVal,
  /// `block[InternalBlockTableNameIndex]` values already present on block objects before the build,
  /// keyed by [`JsVal::identity`].
  pub block_table_name_index: HashMap<usize, u32>,
}

struct Builder<'a> {
  host: &'a dyn Host,
  input: SchemaInput<'a>,
  opts: SchemaOptions,
  schema: RawSchema,
}

pub fn build_raw_schema(host: &dyn Host, input: SchemaInput<'_>, opts: SchemaOptions) -> Result<RawSchema> {
  let schema = RawSchema { block_table_name_index: input.block_table_name_index.clone(), ..Default::default() };
  let mut b = Builder { host, input, opts, schema };
  b.build_raw_schema()?;
  Ok(b.schema)
}

#[derive(Default)]
struct CreateTableName<'a> {
  parent_table_name: Option<&'a str>,
  prefix: &'a str,
  enum_name: bool,
  throw_validation_error: bool,
  versions: bool,
  versions_custom_name: bool,
}

struct BuildTableArgs<'a> {
  base_columns: Map<String, Json>,
  base_foreign_keys: Map<String, Json>,
  base_indexes: Map<String, Json>,
  blocks_table_name_map: &'a mut IndexMap<String, u32>,
  compound_indexes: Option<Vec<JsVal>>,
  disable_not_null: bool,
  disable_rels_table_unique: bool,
  disable_unique: bool,
  fields: Vec<JsVal>,
  parent_is_localized: bool,
  root_relationships: Option<&'a mut IndexSet<String>>,
  root_relations_to_build: Option<RelationMap>,
  root_table_id_col_type: Option<String>,
  root_table_name: Option<String>,
  root_unique_relationships: Option<&'a mut IndexSet<String>>,
  table_name: String,
  timestamps: bool,
  versions: bool,
  within_localized_array_or_block: bool,
}

impl<'a> BuildTableArgs<'a> {
  fn new(table_name: String, fields: Vec<JsVal>, blocks_table_name_map: &'a mut IndexMap<String, u32>) -> Self {
    Self {
      base_columns: Map::new(),
      base_foreign_keys: Map::new(),
      base_indexes: Map::new(),
      blocks_table_name_map,
      compound_indexes: None,
      disable_not_null: false,
      disable_rels_table_unique: false,
      disable_unique: false,
      fields,
      parent_is_localized: false,
      root_relationships: None,
      root_relations_to_build: None,
      root_table_id_col_type: None,
      root_table_name: None,
      root_unique_relationships: None,
      table_name,
      timestamps: false,
      versions: false,
      within_localized_array_or_block: false,
    }
  }
}

struct TraverseArgs<'b> {
  blocks_table_name_map: &'b mut IndexMap<String, u32>,
  column_prefix: String,
  columns: &'b mut Map<String, Json>,
  /// `field.defaultValue` of the `columns` built by `withDefault` (see [`RawSchema::column_defaults`]).
  column_defaults: &'b mut IndexMap<String, JsVal>,
  disable_not_null: bool,
  disable_rels_table_unique: bool,
  disable_unique: bool,
  field_prefix: Option<String>,
  fields: &'b [JsVal],
  force_localized: bool,
  indexes: &'b mut Map<String, Json>,
  locales_columns: &'b mut Map<String, Json>,
  locales_column_defaults: &'b mut IndexMap<String, JsVal>,
  locales_indexes: &'b mut Map<String, Json>,
  new_table_name: String,
  parent_is_localized: bool,
  parent_table_name: String,
  relationships: &'b mut IndexSet<String>,
  relations_to_build: RelationMap,
  root_relations_to_build: RelationMap,
  root_table_id_col_type: String,
  root_table_name: String,
  unique_relationships: &'b mut IndexSet<String>,
  versions: bool,
  within_localized_array_or_block: bool,
}

fn one_relation(field: &str, table: &str, relation_name: &str, to: &str) -> Json {
  json!({
    "type": "one",
    "fields": [{ "name": field, "table": table }],
    "references": ["id"],
    "relationName": relation_name,
    "to": to,
  })
}

fn many_relation(relation_name: &str, to: &str) -> Json {
  json!({ "type": "many", "relationName": relation_name, "to": to })
}

fn cascade_fk(name: String, column: &str, table: &str) -> Json {
  json!({
    "name": name,
    "columns": [column],
    "foreignColumns": [{ "name": "id", "table": table }],
    "onDelete": "cascade",
  })
}

fn is_uuid_type(id_type: &str) -> bool {
  id_type == "uuid" || id_type == "uuidv7"
}

/// `withDefault`
fn with_default(mut column: Json, field: &JsVal) -> Json {
  let default = field.get("defaultValue");
  if default.is_undefined() || default.is_fn() {
    return column;
  }
  column.as_object_mut().expect("column is an object").insert("default".into(), default.to_json());
  column
}

/// Keeps the JS value `withDefault` stored on the column under `key` (or forgets a previous one).
fn record_default(defaults: &mut IndexMap<String, JsVal>, key: &str, field: &JsVal) {
  let default = field.get("defaultValue");
  if default.is_undefined() || default.is_fn() {
    defaults.shift_remove(key);
  } else {
    defaults.insert(key.to_string(), default.clone());
  }
}

/// `idToUUID`
fn id_to_uuid(fields: &[JsVal]) -> Vec<JsVal> {
  fields
    .iter()
    .map(|field| {
      if field.get("name").as_str() == Some("id") {
        let mut o: Obj = field.as_obj().cloned().unwrap_or_default();
        o.insert("name".into(), JsVal::str("_uuid"));
        JsVal::obj(o)
      } else {
        field.clone()
      }
    })
    .collect()
}

/// `hasLocalesTable`
pub fn has_locales_table(fields: &JsVal, parent_is_localized: bool) -> bool {
  fields.items().any(|field| {
    let t = field.get("type").as_str().unwrap_or("");
    if t == "array" {
      return false;
    }
    if field_affects_data(field) && field_should_be_localized(field, parent_is_localized) {
      return true;
    }
    if field_has_sub_fields(field) {
      return has_locales_table(field.get("fields"), parent_is_localized || field.get("localized").truthy());
    }
    if t == "tabs" {
      return field
        .get("tabs")
        .items()
        .any(|tab| has_locales_table(tab.get("fields"), parent_is_localized || tab.get("localized").truthy()));
    }
    false
  })
}

/// `getFlattenedFieldNames` from `validateExistingBlockIsIdentical.ts`
fn get_flattened_field_names(fields: &JsVal, parent_is_localized: bool, prefix: &str) -> Vec<(String, bool)> {
  let mut out = Vec::new();
  for field in fields.items() {
    let t = field.get("type").as_str().unwrap_or("");
    if ["array", "blocks", "relationship", "upload"].contains(&t) || field.get("hasMany").is_true() {
      continue;
    }
    if field_has_sub_fields(field) {
      let field_prefix =
        if field.has("name") { format!("{prefix}{}_", field.get("name").to_js_string()) } else { prefix.to_string() };
      out.extend(get_flattened_field_names(
        field.get("fields"),
        parent_is_localized || field.get("localized").truthy(),
        &field_prefix,
      ));
      continue;
    }
    if t == "tabs" {
      for tab in field.get("tabs").items() {
        let field_prefix =
          if tab.has("name") { format!("{prefix}_{}", tab.get("name").to_js_string()) } else { prefix.to_string() };
        if tab_has_name(tab) {
          // upstream pushes `{ ...tab, type: 'tab' }`: unprefixed name, raw `localized`
          out.push((tab.get("name").to_js_string(), tab.get("localized").truthy()));
        } else {
          out.extend(get_flattened_field_names(
            tab.get("fields"),
            parent_is_localized || tab.get("localized").truthy(),
            &field_prefix,
          ));
        }
      }
      continue;
    }
    if field_affects_data(field) {
      out.push((
        format!("{prefix}{}", field.get("name").to_js_string()),
        field_should_be_localized(field, parent_is_localized),
      ));
    }
  }
  out
}

/// `validateExistingBlockIsIdentical`
fn validate_existing_block_is_identical(
  block: &JsVal,
  localized: bool,
  parent_is_localized: bool,
  table: &RawTable,
  table_locales: Option<&RawTable>,
) -> bool {
  let field_names = get_flattened_field_names(block.get("fields"), parent_is_localized || localized, "");

  let missing_field = field_names.iter().any(|(name, localized)| {
    let field_table = match (localized, table_locales) {
      (true, Some(locales)) => locales,
      _ => table,
    };
    !field_table.columns.contains_key(name)
  }) || {
    // Upstream iterates the keys of the table object itself (`name`, `columns`, ...)
    // and checks `fieldNames.findIndex((field) => field.name) === -1`.
    !field_names.iter().any(|(name, _)| !name.is_empty())
  };

  if missing_field {
    return false;
  }

  localized == table.columns.contains_key("_locale")
}

impl Builder<'_> {
  fn localization(&self) -> &JsVal {
    self.input.config.get("localization")
  }

  fn has_localization(&self) -> bool {
    self.localization().truthy()
  }

  fn collection(&self, slug: &str) -> &JsVal {
    self.input.collections.get(slug)
  }

  fn collection_config(&self, slug: &str) -> Result<&JsVal> {
    let config = self.collection(slug).get("config");
    if config.is_undefined() {
      return Err(EngineError::new(
        "TypeError",
        format!("Cannot read properties of undefined (reading 'config') for collection '{slug}'"),
      ));
    }
    Ok(config)
  }

  /// Calls a `dbName` / `enumName` function with `{ tableName: parentTableName }` (an own
  /// `tableName` key holding `undefined` for root tables, like upstream).
  fn call_name_fn(&self, id: u32, parent_table_name: Option<&str>) -> Result<JsVal> {
    let table_name = parent_table_name.map(JsVal::str).unwrap_or_default();
    self.host.call_value(id, &JsVal::obj(Obj::from_iter([("tableName".to_string(), table_name)])))
  }

  /// Records the exact JS string of a generated identifier that is not valid UTF-16.
  fn record_identifier(&mut self, name: &str, exact: Option<Vec<u16>>) {
    if let Some(units) = exact {
      self.schema.utf16_identifiers.insert(name.to_string(), units);
    }
  }

  /// `createTableName`
  fn create_table_name(&mut self, config: &JsVal, args: CreateTableName<'_>) -> Result<String> {
    let target = if args.enum_name { "enumName" } else { "dbName" };
    let mut custom = config.get(target).clone();
    let name = config.get("name");
    let base = if name.is_nullish() { config.get("slug") } else { name };
    let mut default_table_name = format!("{}{}", args.prefix, to_snake_case(&base.to_js_string()));

    if args.versions {
      default_table_name = format!("_{default_table_name}{}", self.opts.versions_suffix);
    }

    if !custom.truthy() && args.enum_name {
      custom = config.get("dbName").clone();
    }

    // `customTableNameResult || defaultTableName`: a custom function may return a falsy value.
    let mut custom_result = JsVal::Undefined;
    if custom.truthy() {
      custom_result = match &custom {
        JsVal::Fn(id) => self.call_name_fn(*id, args.parent_table_name)?,
        v => v.clone(),
      };
      if args.versions_custom_name {
        custom_result = JsVal::str(format!("_{}{}", custom_result.to_js_string(), self.opts.versions_suffix));
      }
    }

    let result =
      if custom_result.truthy() { custom_result.to_js_string() } else { default_table_name.clone() };

    self.schema.table_name_map.insert(default_table_name, result.clone());

    if !args.throw_validation_error {
      return Ok(result);
    }
    validate_identifier_length(result)
  }

  /// `buildIndexName`
  fn build_index_name(&mut self, name: &str, append_suffix: bool) -> String {
    let mut number = 0u32;
    loop {
      let num = if number > 0 { format!("_{number}") } else { String::new() };
      let suffix = format!("{num}{}", if append_suffix { "_idx" } else { "" });
      let mut index_name = format!("{name}{suffix}");
      let mut exact = None;
      if js_len(&index_name) > MAX_GENERATED_IDENTIFIER_LENGTH {
        (index_name, exact) = truncated_identifier(name, MAX_GENERATED_IDENTIFIER_LENGTH - js_len(&suffix), &suffix);
      }
      if !self.schema.indexes.contains(&index_name) && !self.schema.raw_tables.contains_key(&index_name) {
        self.schema.indexes.insert(index_name.clone());
        self.record_identifier(&index_name, exact);
        return index_name;
      }
      number += 1;
    }
  }

  /// `buildForeignKeyName`
  fn build_foreign_key_name(&mut self, name: &str) -> String {
    let mut number = 0u32;
    loop {
      let num = if number > 0 { format!("_{number}") } else { String::new() };
      let suffix = format!("{num}_fk");
      let mut fk_name = format!("{name}{suffix}");
      let mut exact = None;
      if js_len(&fk_name) > MAX_GENERATED_IDENTIFIER_LENGTH {
        (fk_name, exact) = truncated_identifier(name, MAX_GENERATED_IDENTIFIER_LENGTH - js_len(&suffix), &suffix);
      }
      if !self.schema.foreign_keys.contains(&fk_name) {
        self.schema.foreign_keys.insert(fk_name.clone());
        self.record_identifier(&fk_name, exact);
        return fk_name;
      }
      number += 1;
    }
  }

  /// sqlite `setColumnID`
  fn set_column_id(&self, columns: &mut Map<String, Json>, fields: &[JsVal]) -> String {
    let id_field = fields.iter().find(|f| f.get("name").as_str() == Some("id"));
    if let Some(id_field) = id_field {
      match id_field.get("type").as_str() {
        Some("number") => {
          columns.insert("id".into(), json!({ "name": "id", "type": "numeric", "primaryKey": true }));
          return "numeric".into();
        }
        Some("text") => {
          columns.insert("id".into(), json!({ "name": "id", "type": "text", "primaryKey": true }));
          return "text".into();
        }
        _ => {}
      }
    }
    if self.opts.id_type == "uuid" {
      columns.insert("id".into(), json!({ "name": "id", "type": "uuid", "defaultRandom": true, "primaryKey": true }));
      return "uuid".into();
    }
    if self.opts.id_type == "uuidv7" {
      columns.insert("id".into(), json!({ "name": "id", "type": "uuid", "defaultV7": true, "primaryKey": true }));
      return "uuid".into();
    }
    columns.insert(
      "id".into(),
      json!({ "name": "id", "type": "integer", "autoIncrement": self.opts.auto_increment, "primaryKey": true }),
    );
    "integer".into()
  }

  fn build_raw_schema(&mut self) -> Result<()> {
    let config = self.input.config.clone();
    let collections: Vec<JsVal> = config.get("collections").items().cloned().collect();
    let globals: Vec<JsVal> = config.get("globals").items().cloned().collect();

    for collection in &collections {
      self.create_table_name(collection, CreateTableName::default())?;
      if collection.get("versions").truthy() {
        self.create_table_name(
          collection,
          CreateTableName { versions: true, versions_custom_name: true, ..Default::default() },
        )?;
      }
    }

    for collection in &collections {
      let slug = collection.get("slug").to_js_string();
      let table_name = self.schema.table_name_map.get(&to_snake_case(&slug)).cloned().unwrap_or_default();

      let mut base_indexes = Map::new();
      let filename_compound_index = collection.path(&["upload", "filenameCompoundIndex"]);
      if filename_compound_index.truthy() {
        let index_name = self.build_index_name(&format!("{table_name}_filename_compound"), true);
        base_indexes.insert(
          "filename_compound_index".into(),
          json!({
            "name": index_name,
            "on": filename_compound_index.to_json(),
            "unique": true,
          }),
        );
      }

      let drafts = collection.path(&["versions", "drafts"]).truthy();
      let mut blocks_table_name_map = IndexMap::new();
      let mut args = BuildTableArgs::new(
        table_name.clone(),
        collection.get("flattenedFields").items().cloned().collect(),
        &mut blocks_table_name_map,
      );
      args.base_indexes = base_indexes;
      args.compound_indexes = Some(collection.get("sanitizedIndexes").items().cloned().collect());
      args.disable_not_null = drafts;
      args.timestamps = collection.get("timestamps").truthy();
      self.build_table(args)?;

      if collection.get("versions").truthy() {
        let versions_table_name = self
          .schema
          .table_name_map
          .get(&format!("_{}{}", to_snake_case(&slug), self.opts.versions_suffix))
          .cloned()
          .unwrap_or_default();
        let version_fields = self.build_version_collection_fields(collection);
        let compound = build_version_compound_indexes(collection.get("sanitizedIndexes"));

        let mut blocks_table_name_map = IndexMap::new();
        let mut args = BuildTableArgs::new(versions_table_name, version_fields, &mut blocks_table_name_map);
        args.compound_indexes = Some(compound);
        args.disable_not_null = drafts;
        args.disable_unique = true;
        args.timestamps = true;
        args.versions = true;
        self.build_table(args)?;
      }
    }

    for global in &globals {
      let table_name = self.create_table_name(global, CreateTableName::default())?;
      let mut blocks_table_name_map = IndexMap::new();
      let mut args =
        BuildTableArgs::new(table_name, global.get("flattenedFields").items().cloned().collect(), &mut blocks_table_name_map);
      args.disable_not_null = has_drafts_enabled(global);
      self.build_table(args)?;

      if global.get("versions").truthy() {
        let versions_table_name = self.create_table_name(
          global,
          CreateTableName { versions: true, versions_custom_name: true, ..Default::default() },
        )?;
        let version_fields = self.build_version_global_fields(global);
        let mut blocks_table_name_map = IndexMap::new();
        let mut args = BuildTableArgs::new(versions_table_name, version_fields, &mut blocks_table_name_map);
        args.disable_not_null = global.path(&["versions", "drafts"]).truthy();
        args.disable_unique = true;
        args.timestamps = true;
        args.versions = true;
        self.build_table(args)?;
      }
    }

    Ok(())
  }

  fn version_meta_fields(&self, entity: &JsVal) -> Vec<JsVal> {
    let mut fields = vec![
      date_field("createdAt"),
      date_field("updatedAt"),
    ];
    if has_drafts_enabled(entity) {
      if self.has_localization() {
        let options = self
          .localization()
          .get("locales")
          .items()
          .map(|locale| match locale {
            JsVal::Str(_) => locale.clone(),
            _ => locale.get("code").clone(),
          })
          .collect();
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
      if has_autosave_enabled(entity) {
        fields.push(JsVal::obj(Obj::from_iter([
          ("name".into(), JsVal::str("autosave")),
          ("type".into(), JsVal::str("checkbox")),
          ("index".into(), JsVal::Bool(true)),
        ])));
      }
    }
    fields
  }

  /// `buildVersionCollectionFields(config, collection, true)`
  fn build_version_collection_fields(&self, collection: &JsVal) -> Vec<JsVal> {
    let not_id = |f: &&JsVal| !f.has("name") || f.get("name").as_str() != Some("id");
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
        ("fields".into(), JsVal::arr(collection.get("fields").items().filter(not_id).cloned().collect())),
        (
          "flattenedFields".into(),
          JsVal::arr(
            collection.get("flattenedFields").items().filter(|f| f.get("name").as_str() != Some("id")).cloned().collect(),
          ),
        ),
      ])),
    ];
    fields.extend(self.version_meta_fields(collection));
    fields
  }

  /// `buildVersionGlobalFields(config, global, true)`
  fn build_version_global_fields(&self, global: &JsVal) -> Vec<JsVal> {
    let mut fields = vec![JsVal::obj(Obj::from_iter([
      ("name".into(), JsVal::str("version")),
      ("type".into(), JsVal::str("group")),
      ("fields".into(), global.get("fields").clone()),
      ("flattenedFields".into(), global.get("flattenedFields").clone()),
    ]))];
    fields.extend(self.version_meta_fields(global));
    fields
  }

  /// `buildTable`
  /// `adapter.rawTables[name] = table`
  fn insert_raw_table(&mut self, name: String, table: Option<RawTable>) {
    self.schema.column_defaults.shift_remove(&name);
    self.schema.raw_tables.insert(name, table);
  }

  /// Records the `withDefault` values of a table just inserted, keeping only columns that still
  /// carry a default (a later column under the same key, e.g. timestamps, replaces it).
  fn set_column_defaults(&mut self, table_name: &str, defaults: IndexMap<String, JsVal>) {
    let Some(Some(table)) = self.schema.raw_tables.get(table_name) else { return };
    let defaults: IndexMap<String, JsVal> = defaults
      .into_iter()
      .filter(|(key, _)| table.columns.get(key).is_some_and(|column| column.get("default").is_some()))
      .collect();
    if !defaults.is_empty() {
      self.schema.column_defaults.insert(table_name.to_string(), defaults);
    }
  }

  /// `getTableToUse()` of the compound index loop in `build.ts`.
  fn table_to_use<'t>(
    &'t self,
    localized: bool,
    has_locales_table: bool,
    table_name: &str,
    locale_table_name: &str,
    detached_table: &'t Option<RawTable>,
  ) -> Option<&'t RawTable> {
    if localized {
      if !has_locales_table {
        return None;
      }
      return self.schema.raw_tables.get(locale_table_name).and_then(Option::as_ref);
    }
    if let Some(table) = detached_table {
      return Some(table);
    }
    self.schema.raw_tables.get(table_name).and_then(Option::as_ref)
  }

  fn build_table(&mut self, args: BuildTableArgs<'_>) -> Result<BuildResult> {
    let BuildTableArgs {
      base_columns,
      base_foreign_keys,
      base_indexes,
      blocks_table_name_map,
      compound_indexes,
      disable_not_null,
      disable_rels_table_unique,
      disable_unique,
      fields,
      parent_is_localized,
      root_relationships,
      root_relations_to_build,
      root_table_id_col_type,
      root_table_name: incoming_root_table_name,
      root_unique_relationships,
      table_name,
      timestamps,
      versions,
      within_localized_array_or_block,
    } = args;

    // `!incomingRootTableName` / `incomingRootTableName || tableName`
    let incoming_root_table_name = incoming_root_table_name.filter(|n| !n.is_empty());
    let is_root = incoming_root_table_name.is_none();
    let root_table_name = incoming_root_table_name.unwrap_or_else(|| table_name.clone());
    let mut columns = base_columns;
    let mut indexes = base_indexes;

    let mut locales_columns = Map::new();
    let mut locales_indexes = Map::new();
    let mut column_defaults = IndexMap::new();
    let mut locales_column_defaults = IndexMap::new();

    let mut own_relationships = IndexSet::new();
    let relationships: &mut IndexSet<String> = match root_relationships {
      Some(r) => r,
      None => &mut own_relationships,
    };
    let mut own_unique = IndexSet::new();
    let unique_relationships: &mut IndexSet<String> = match root_unique_relationships {
      Some(r) => r,
      None => &mut own_unique,
    };

    let relations_to_build: RelationMap = Rc::new(RefCell::new(IndexMap::new()));

    let id_col_type = self.set_column_id(&mut columns, &fields);

    let traverse = self.traverse_fields(TraverseArgs {
      blocks_table_name_map,
      column_prefix: String::new(),
      columns: &mut columns,
      column_defaults: &mut column_defaults,
      disable_not_null,
      disable_rels_table_unique,
      disable_unique,
      field_prefix: None,
      fields: &fields,
      force_localized: false,
      indexes: &mut indexes,
      locales_columns: &mut locales_columns,
      locales_column_defaults: &mut locales_column_defaults,
      locales_indexes: &mut locales_indexes,
      new_table_name: table_name.clone(),
      parent_is_localized,
      parent_table_name: table_name.clone(),
      relationships: &mut *relationships,
      relations_to_build: relations_to_build.clone(),
      root_relations_to_build: root_relations_to_build.unwrap_or_else(|| relations_to_build.clone()),
      root_table_id_col_type: root_table_id_col_type.unwrap_or_else(|| id_col_type.clone()),
      root_table_name: root_table_name.clone(),
      unique_relationships: &mut *unique_relationships,
      versions,
      within_localized_array_or_block,
    })?;

    let mut localized_relations: IndexMap<String, RelationToBuild> = IndexMap::new();
    let mut non_localized_relations: IndexMap<String, RelationToBuild> = IndexMap::new();
    for (key, rel) in relations_to_build.borrow().iter() {
      let map = if rel.localized { &mut localized_relations } else { &mut non_localized_relations };
      map.insert(key.clone(), rel.clone());
    }

    if timestamps {
      for (key, name) in [("createdAt", "created_at"), ("updatedAt", "updated_at")] {
        columns.insert(
          key.into(),
          json!({
            "name": name,
            "type": "timestamp",
            "defaultNow": true,
            "mode": "string",
            "notNull": true,
            "precision": 3,
            "withTimezone": true,
          }),
        );
      }
    }

    self.insert_raw_table(
      table_name.clone(),
      Some(RawTable { name: table_name.clone(), columns, foreign_keys: base_foreign_keys, indexes }),
    );
    self.set_column_defaults(&table_name, column_defaults);
    // TS keeps the table in a local (`table`) for the compound indexes below, which stays the same
    // object even if the locales table replaces it in `rawTables` (an empty `localesSuffix`).
    let mut detached_table: Option<RawTable> = None;

    let locale_table_name = format!("{table_name}{}", self.opts.locales_suffix);
    let mut has_locales_table = false;

    if traverse.has_localized_field || !localized_relations.is_empty() {
      has_locales_table = true;
      if locale_table_name == table_name {
        detached_table = self.schema.raw_tables.get_mut(&table_name).and_then(Option::take);
      }
      self.insert_raw_table(locale_table_name.clone(), None);

      locales_columns.insert("id".into(), json!({ "name": "id", "type": "serial", "primaryKey": true }));
      locales_columns
        .insert("_locale".into(), json!({ "name": "_locale", "type": "enum", "locale": true, "notNull": true }));
      locales_columns.insert("_parentID".into(), json!({ "name": "_parent_id", "type": id_col_type, "notNull": true }));

      let index_name = self.build_index_name(&format!("{locale_table_name}_parent_id_locale_unique"), false);
      locales_indexes
        .insert("_localeParent".into(), json!({ "name": index_name, "on": ["_parentID", "_locale"], "unique": true }));

      let fk_name = self.build_foreign_key_name(&format!("{locale_table_name}_parent_id"));
      let mut foreign_keys = Map::new();
      foreign_keys.insert("_parentIdFk".into(), cascade_fk(fk_name, "_parentID", &table_name));

      self.insert_raw_table(
        locale_table_name.clone(),
        Some(RawTable {
          name: locale_table_name.clone(),
          columns: std::mem::take(&mut locales_columns),
          foreign_keys,
          indexes: std::mem::take(&mut locales_indexes),
        }),
      );
      self.set_column_defaults(&locale_table_name, std::mem::take(&mut locales_column_defaults));

      let mut locale_relations = Map::new();
      locale_relations
        .insert("_parentID".into(), one_relation("_parentID", &locale_table_name, "_locales", &table_name));
      for (key, rel) in &localized_relations {
        if rel.kind == "one" {
          locale_relations.insert(key.clone(), one_relation(key, &locale_table_name, key, &rel.target));
        }
        if rel.kind == "many" {
          locale_relations.insert(key.clone(), many_relation(key, &rel.target));
        }
      }
      self.schema.raw_relations.insert(locale_table_name.clone(), locale_relations);
    }

    if let Some(compound_indexes) = compound_indexes {
      for index in &compound_indexes {
        let mut some_localized: Option<bool> = None;
        let mut index_columns: Vec<String> = Vec::new();

        for f in index.get("fields").items() {
          let path = f.get("path").to_js_string();
          let path_has_localized = f.get("pathHasLocalized").truthy();
          if some_localized.is_none() {
            some_localized = Some(path_has_localized);
          }
          let localized = some_localized == Some(true);
          if localized != path_has_localized {
            return Err(EngineError::invalid_configuration(format!(
              "Compound indexes within localized and non localized fields are not supported in SQL. Expected {path} to be {} localized.",
              if localized { "non" } else { "" }
            )));
          }
          let column_path = path.replace('.', "_");
          // `getTableToUse()`: the `localesTable` local is only set when this call built it
          let table = match self.table_to_use(localized, has_locales_table, &table_name, &locale_table_name, &detached_table) {
            Some(t) => t,
            None => {
              return Err(EngineError::new(
                "TypeError",
                "Cannot read properties of undefined (reading 'columns')",
              ));
            }
          };
          if !table.columns.contains_key(&column_path) {
            return Err(EngineError::invalid_configuration(format!(
              "Column {column_path} for compound index on {path} was not found in the {} table.",
              table.name
            )));
          }
          index_columns.push(column_path);
        }

        let localized = some_localized == Some(true);
        if localized {
          index_columns.push("_locale".into());
        }

        let mut name = index_columns.join("_");
        if js_len(&name) > 63 {
          name = "compound_index".into();
        }
        let index_name = self.build_index_name(&name, true);
        let unique = if disable_unique { Json::Bool(false) } else { index.get("unique").to_json() };
        let table = if !localized && detached_table.is_some() {
          detached_table.as_mut()
        } else {
          let table_to_use = if localized { &locale_table_name } else { &table_name };
          self.schema.raw_tables.get_mut(table_to_use).and_then(Option::as_mut)
        };
        if let Some(table) = table {
          let mut entry = Map::new();
          entry.insert("name".into(), json!(index_name));
          entry.insert("on".into(), json!(index_columns));
          if !index.get("unique").is_undefined() || disable_unique {
            entry.insert("unique".into(), unique);
          }
          table.indexes.insert(index_name, Json::Object(entry));
        }
      }
    }

    let mut texts_table_name: Option<String> = None;
    let mut numbers_table_name: Option<String> = None;
    let mut relationships_table_name: Option<String> = None;

    if is_root {
      if traverse.has_many_text_field.truthy() {
        let name = format!("{root_table_name}_texts");
        self.insert_raw_table(name.clone(), None);
        let mut cols = Map::new();
        cols.insert("id".into(), json!({ "name": "id", "type": "serial", "primaryKey": true }));
        cols.insert("order".into(), json!({ "name": "order", "type": "integer", "notNull": true }));
        cols.insert("parent".into(), json!({ "name": "parent_id", "type": id_col_type, "notNull": true }));
        cols.insert("path".into(), json!({ "name": "path", "type": "varchar", "notNull": true }));
        cols.insert("text".into(), json!({ "name": "text", "type": "varchar" }));
        if traverse.has_localized_many_text_field {
          cols.insert("locale".into(), json!({ "name": "locale", "type": "enum", "locale": true }));
        }
        let mut idx = Map::new();
        let n = self.build_index_name(&format!("{name}_order_parent"), false);
        idx.insert("orderParentIdx".into(), json!({ "name": n, "on": ["order", "parent"] }));
        if traverse.has_many_text_field == HasMany::Index {
          let n = self.build_index_name(&format!("{name}_text"), true);
          idx.insert("text_idx".into(), json!({ "name": n, "on": "text" }));
        }
        if traverse.has_localized_many_text_field {
          let n = self.build_index_name(&format!("{name}_locale_parent"), false);
          idx.insert("localeParent".into(), json!({ "name": n, "on": ["locale", "parent"] }));
        }
        let fk = self.build_foreign_key_name(&format!("{name}_parent"));
        let mut fks = Map::new();
        fks.insert("parentFk".into(), cascade_fk(fk, "parent", &table_name));
        self.insert_raw_table(
          name.clone(),
          Some(RawTable { name: name.clone(), columns: cols, foreign_keys: fks, indexes: idx }),
        );
        let mut rels = Map::new();
        rels.insert("parent".into(), one_relation("parent", &name, "_texts", &table_name));
        self.schema.raw_relations.insert(name.clone(), rels);
        texts_table_name = Some(name);
      }

      if traverse.has_many_number_field.truthy() {
        let name = format!("{root_table_name}_numbers");
        self.insert_raw_table(name.clone(), None);
        let mut cols = Map::new();
        cols.insert("id".into(), json!({ "name": "id", "type": "serial", "primaryKey": true }));
        cols.insert("number".into(), json!({ "name": "number", "type": "numeric" }));
        cols.insert("order".into(), json!({ "name": "order", "type": "integer", "notNull": true }));
        cols.insert("parent".into(), json!({ "name": "parent_id", "type": id_col_type, "notNull": true }));
        cols.insert("path".into(), json!({ "name": "path", "type": "varchar", "notNull": true }));
        if traverse.has_localized_many_number_field {
          cols.insert("locale".into(), json!({ "name": "locale", "type": "enum", "locale": true }));
        }
        let mut idx = Map::new();
        let n = self.build_index_name(&format!("{name}_order_parent"), true);
        idx.insert("orderParentIdx".into(), json!({ "name": n, "on": ["order", "parent"] }));
        if traverse.has_many_number_field == HasMany::Index {
          let n = self.build_index_name(&format!("{name}_number"), true);
          idx.insert("numberIdx".into(), json!({ "name": n, "on": "number" }));
        }
        if traverse.has_localized_many_number_field {
          let n = self.build_index_name(&format!("{name}_locale_parent"), false);
          idx.insert("localeParent".into(), json!({ "name": n, "on": ["locale", "parent"] }));
        }
        let fk = self.build_foreign_key_name(&format!("{name}_parent"));
        let mut fks = Map::new();
        fks.insert("parentFk".into(), cascade_fk(fk, "parent", &table_name));
        self.insert_raw_table(
          name.clone(),
          Some(RawTable { name: name.clone(), columns: cols, foreign_keys: fks, indexes: idx }),
        );
        let mut rels = Map::new();
        rels.insert("parent".into(), one_relation("parent", &name, "_numbers", &table_name));
        self.schema.raw_relations.insert(name.clone(), rels);
        numbers_table_name = Some(name);
      }

      if !relationships.is_empty() {
        let relationships: Vec<String> = relationships.iter().cloned().collect();
        let mut cols = Map::new();
        cols.insert("id".into(), json!({ "name": "id", "type": "serial", "primaryKey": true }));
        cols.insert("order".into(), json!({ "name": "order", "type": "integer" }));
        cols.insert("parent".into(), json!({ "name": "parent_id", "type": id_col_type, "notNull": true }));
        cols.insert("path".into(), json!({ "name": "path", "type": "varchar", "notNull": true }));
        if traverse.has_localized_relationship_field {
          cols.insert("locale".into(), json!({ "name": "locale", "type": "enum", "locale": true }));
        }

        let rels_name = format!("{table_name}{}", self.opts.relationships_suffix);
        let mut idx = Map::new();
        let n = self.build_index_name(&format!("{rels_name}_order"), true);
        idx.insert("order".into(), json!({ "name": n, "on": "order" }));
        let n = self.build_index_name(&format!("{rels_name}_parent"), true);
        idx.insert("parentIdx".into(), json!({ "name": n, "on": "parent" }));
        let n = self.build_index_name(&format!("{rels_name}_path"), true);
        idx.insert("pathIdx".into(), json!({ "name": n, "on": "path" }));
        if traverse.has_localized_relationship_field {
          let n = self.build_index_name(&format!("{rels_name}_locale"), true);
          idx.insert("localeIdx".into(), json!({ "name": n, "on": "locale" }));
        }

        let mut fks = Map::new();
        let fk = self.build_foreign_key_name(&format!("{rels_name}_parent"));
        fks.insert("parentFk".into(), cascade_fk(fk, "parent", &table_name));

        for relation_to in &relationships {
          let relationship_config = self.collection_config(relation_to)?.clone();
          let formatted_relation_to = self.create_table_name(
            &relationship_config,
            CreateTableName { throw_validation_error: true, ..Default::default() },
          )?;
          let mut col_type = if is_uuid_type(&self.opts.id_type) { "uuid" } else { "integer" };
          let custom_id_type = self.collection(&relationship_config.get("slug").to_js_string()).get("customIDType").clone();
          if custom_id_type.as_str() == Some("number") {
            col_type = "numeric";
          }
          if custom_id_type.as_str() == Some("text") {
            col_type = "varchar";
          }
          let col_name = format!("{relation_to}ID");
          cols.insert(col_name.clone(), json!({ "name": format!("{formatted_relation_to}_id"), "type": col_type }));

          let fk = self.build_foreign_key_name(&format!("{rels_name}_{}", to_snake_case(relation_to)));
          fks.insert(format!("{relation_to}IdFk"), cascade_fk(fk, &col_name, &formatted_relation_to));

          let mut index_columns = vec![col_name.clone()];
          let unique = !disable_unique && unique_relationships.contains(relation_to);
          if unique {
            index_columns.push("path".into());
          }
          if traverse.has_localized_relationship_field {
            index_columns.push("locale".into());
          }
          let index_name = self.build_index_name(&format!("{rels_name}_{formatted_relation_to}_id"), true);
          idx.insert(index_name.clone(), json!({ "name": index_name, "on": index_columns, "unique": unique }));
        }

        self.insert_raw_table(
          rels_name.clone(),
          Some(RawTable { name: rels_name.clone(), columns: cols, foreign_keys: fks, indexes: idx }),
        );

        let mut rels = Map::new();
        rels.insert("parent".into(), one_relation("parent", &rels_name, "_rels", &table_name));
        for relation_to in &relationships {
          let config = self.collection_config(relation_to)?.clone();
          let related_table_name =
            self.create_table_name(&config, CreateTableName { throw_validation_error: true, ..Default::default() })?;
          let id_column_name = format!("{relation_to}ID");
          rels.insert(
            id_column_name.clone(),
            one_relation(&id_column_name, &rels_name, relation_to, &related_table_name),
          );
        }
        self.schema.raw_relations.insert(rels_name.clone(), rels);
        relationships_table_name = Some(rels_name);
      }
    }

    let mut table_relations = Map::new();
    for (key, rel) in &non_localized_relations {
      if rel.kind == "one" {
        table_relations.insert(key.clone(), one_relation(key, &table_name, key, &rel.target));
      }
      if rel.kind == "many" {
        table_relations.insert(key.clone(), many_relation(rel.relation_name.as_deref().unwrap_or(key), &rel.target));
      }
    }
    if traverse.has_localized_field && has_locales_table {
      table_relations.insert("_locales".into(), many_relation("_locales", &locale_table_name));
    }
    if let Some(name) = &texts_table_name {
      table_relations.insert("_texts".into(), many_relation("_texts", name));
    }
    if let Some(name) = &numbers_table_name {
      table_relations.insert("_numbers".into(), many_relation("_numbers", name));
    }
    if let Some(name) = &relationships_table_name {
      table_relations.insert("_rels".into(), many_relation("_rels", name));
    }
    self.schema.raw_relations.insert(table_name.clone(), table_relations);

    Ok(BuildResult {
      has_localized_many_number_field: traverse.has_localized_many_number_field,
      has_localized_many_text_field: traverse.has_localized_many_text_field,
      has_localized_relationship_field: traverse.has_localized_relationship_field,
      has_many_number_field: traverse.has_many_number_field,
      has_many_text_field: traverse.has_many_text_field,
      relations_to_build,
    })
  }

  /// `traverseFields` (schema/traverseFields.ts)
  fn traverse_fields(&mut self, a: TraverseArgs<'_>) -> Result<TraverseResult> {
    let mut r = TraverseResult {
      has_localized_field: false,
      has_localized_many_number_field: false,
      has_localized_many_text_field: false,
      has_localized_relationship_field: false,
      has_many_number_field: HasMany::No,
      has_many_text_field: HasMany::No,
    };

    let mut parent_id_col_type = "integer".to_string();
    if let Some(t) = a.columns.get("id").and_then(|c| c.get("type")).and_then(|t| t.as_str())
      && ["numeric", "text", "uuid", "varchar"].contains(&t)
    {
      parent_id_col_type = t.to_string();
    }

    let localization = self.has_localization();
    let fields = a.fields;

    for field in fields {
      if field.has("name") && field.get("name").as_str() == Some("id") {
        continue;
      }
      if field_is_virtual(field) {
        continue;
      }

      let field_type = field.get("type").as_str().unwrap_or("");
      let name = match field.get("name") {
        JsVal::Undefined | JsVal::Null => {
          return Err(EngineError::new("TypeError", "Cannot read properties of undefined (reading '0')"));
        }
        v => v.to_js_string(),
      };

      let column_name = format!(
        "{}{}{}",
        a.column_prefix,
        if field.get("name").as_str().is_some_and(|n| n.starts_with('_')) { "_" } else { "" },
        to_snake_case(&name)
      );
      // `fieldPrefix?.replace('.', '_')` only replaces the first `.`
      let field_name =
        format!("{}{name}", a.field_prefix.as_deref().map(|p| p.replacen('.', "_", 1)).unwrap_or_default());

      let is_field_localized = field_should_be_localized(field, a.parent_is_localized);
      let has_many_key = field.has("hasMany");
      let has_many_true = field.get("hasMany").is_true();

      // When true, `targetTable` / `targetIndexes` are the locales table ones.
      let mut target_locales = false;
      if localization
        && (is_field_localized || a.force_localized)
        && field_type != "array"
        && (field_type != "blocks" || self.opts.blocks_as_json)
        && ((has_many_key && !has_many_true) || !has_many_key)
      {
        r.has_localized_field = true;
        target_locales = true;
      }

      let field_unique = field.get("unique");
      if (field_unique.truthy() || field.get("index").truthy() || ["relationship", "upload"].contains(&field_type))
        && !["array", "blocks", "group"].contains(&field_type)
        && !(has_many_key && has_many_true)
        && !(field.has("relationTo") && field.get("relationTo").as_arr().is_some())
      {
        // `disableUnique !== true && field.unique`
        let unique: Option<Json> = if a.disable_unique {
          Some(Json::Bool(false))
        } else if field_unique.is_undefined() {
          None
        } else {
          Some(field_unique.to_json())
        };
        if !a.disable_unique && field_unique.truthy() {
          let constraint_value = format!("{}{name}", a.field_prefix.as_deref().unwrap_or(""));
          self
            .schema
            .field_constraints
            .entry(a.root_table_name.clone())
            .or_default()
            .insert(format!("{column_name}_idx"), constraint_value);
        }

        let index_name = self.build_index_name(&format!("{}_{column_name}", a.new_table_name), true);
        let mut entry = Map::new();
        entry.insert("name".into(), json!(index_name));
        entry.insert(
          "on".into(),
          if is_field_localized { json!([field_name, "_locale"]) } else { json!(field_name) },
        );
        if let Some(unique) = unique {
          entry.insert("unique".into(), unique);
        }
        let target_indexes = if target_locales { &mut *a.locales_indexes } else { &mut *a.indexes };
        target_indexes.insert(index_name, Json::Object(entry));
      }

      macro_rules! target_table {
        () => {
          if target_locales { &mut *a.locales_columns } else { &mut *a.columns }
        };
      }

      // `targetTable[fieldName] = withDefault(column, field)`
      macro_rules! insert_with_default {
        ($column:expr) => {{
          let column = with_default($column, field);
          record_default(
            if target_locales { &mut *a.locales_column_defaults } else { &mut *a.column_defaults },
            &field_name,
            field,
          );
          target_table!().insert(field_name.clone(), column);
        }};
      }

      let is_localized_sub = (is_field_localized && localization) || a.within_localized_array_or_block || a.force_localized;

      match field_type {
        "array" => {
          let disable_not_null_from_here = field.path(&["admin", "condition"]).truthy() || a.disable_not_null;
          let prefix = format!("{}_", a.new_table_name);
          let array_table_name = self.create_table_name(
            field,
            CreateTableName {
              parent_table_name: Some(&a.new_table_name),
              prefix: &prefix,
              throw_validation_error: true,
              versions_custom_name: a.versions,
              ..Default::default()
            },
          )?;

          let mut base_columns = Map::new();
          base_columns.insert("_order".into(), json!({ "name": "_order", "type": "integer", "notNull": true }));
          base_columns
            .insert("_parentID".into(), json!({ "name": "_parent_id", "type": parent_id_col_type, "notNull": true }));

          let mut base_indexes = Map::new();
          base_indexes
            .insert("_orderIdx".into(), json!({ "name": format!("{array_table_name}_order_idx"), "on": ["_order"] }));
          base_indexes.insert(
            "_parentIDIdx".into(),
            json!({ "name": format!("{array_table_name}_parent_id_idx"), "on": "_parentID" }),
          );

          let mut base_foreign_keys = Map::new();
          base_foreign_keys.insert(
            "_parentIDFk".into(),
            cascade_fk(format!("{array_table_name}_parent_id_fk"), "_parentID", &a.parent_table_name),
          );

          let is_localized = is_localized_sub;
          if is_localized {
            base_columns.insert(
              "_locale".into(),
              json!({ "name": "_locale", "type": "enum", "locale": true, "notNull": true }),
            );
            base_indexes
              .insert("_localeIdx".into(), json!({ "name": format!("{array_table_name}_locale_idx"), "on": "_locale" }));
          }

          let flattened: Vec<JsVal> = field.get("flattenedFields").items().cloned().collect();
          let sub_parent_is_localized = a.parent_is_localized || field.get("localized").truthy();
          let sub = self.build_table(BuildTableArgs {
            base_columns,
            base_foreign_keys,
            base_indexes,
            blocks_table_name_map: &mut *a.blocks_table_name_map,
            compound_indexes: None,
            disable_not_null: disable_not_null_from_here,
            disable_rels_table_unique: true,
            disable_unique: a.disable_unique,
            fields: if a.disable_unique { id_to_uuid(&flattened) } else { flattened },
            parent_is_localized: sub_parent_is_localized,
            root_relationships: Some(&mut *a.relationships),
            root_relations_to_build: Some(a.root_relations_to_build.clone()),
            root_table_id_col_type: Some(a.root_table_id_col_type.clone()),
            root_table_name: Some(a.root_table_name.clone()),
            root_unique_relationships: Some(&mut *a.unique_relationships),
            table_name: array_table_name.clone(),
            timestamps: false,
            versions: a.versions,
            within_localized_array_or_block: is_localized,
          })?;
          merge_sub_flags(&mut r, &sub);

          // `getArrayRelationName`
          let relation_name = if field.get("dbName").truthy() && js_len(&field_name) > 63 {
            format!("_{array_table_name}")
          } else {
            field_name.clone()
          };

          a.relations_to_build.borrow_mut().insert(
            relation_name.clone(),
            RelationToBuild { kind: "many", localized: false, relation_name: None, target: array_table_name.clone() },
          );

          let mut array_relations = Map::new();
          array_relations.insert(
            "_parentID".into(),
            one_relation("_parentID", &array_table_name, &relation_name, &a.parent_table_name),
          );
          if has_locales_table(field.get("fields"), sub_parent_is_localized) {
            array_relations.insert(
              "_locales".into(),
              many_relation("_locales", &format!("{array_table_name}{}", self.opts.locales_suffix)),
            );
          }
          let locales_name = format!("{array_table_name}{}", self.opts.locales_suffix);
          add_sub_relations(&mut array_relations, &sub.relations_to_build, &array_table_name, &locales_name);
          self.schema.raw_relations.insert(array_table_name, array_relations);
        }

        "blocks" => {
          if self.opts.blocks_as_json {
            insert_with_default!(json!({ "name": column_name, "type": "jsonb" }));
          } else {
            let disable_not_null_from_here = field.path(&["admin", "condition"]).truthy() || a.disable_not_null;

            for block_ref in field.get("blocks").items() {
              let block = match block_ref {
                JsVal::Str(slug) => self.input.blocks.get(slug).clone(),
                b => b.clone(),
              };
              if block.is_nullish() {
                return Err(EngineError::new(
                  "TypeError",
                  format!("Cannot destructure property 'name' of 'config' as it is {}.", block.to_js_string()),
                ));
              }

              let prefix = format!("{}_blocks_", a.root_table_name);
              let mut block_table_name = self.create_table_name(
                &block,
                CreateTableName {
                  parent_table_name: Some(&a.root_table_name),
                  prefix: &prefix,
                  throw_validation_error: true,
                  versions_custom_name: a.versions,
                  ..Default::default()
                },
              )?;

              let is_localized_block_table = is_localized_sub;

              if !a.blocks_table_name_map.contains_key(&block_table_name) {
                a.blocks_table_name_map.insert(block_table_name.clone(), 1);
              } else {
                let identical = match self.schema.raw_tables.get(&block_table_name) {
                  Some(Some(table)) => {
                    let locales_key = format!("{block_table_name}{}", self.opts.locales_suffix);
                    let table_locales = self.schema.raw_tables.get(&locales_key).and_then(|t| t.as_ref());
                    validate_existing_block_is_identical(
                      &block,
                      is_localized_block_table,
                      a.parent_is_localized,
                      table,
                      table_locales,
                    )
                  }
                  _ => false,
                };
                if !identical {
                  let count = a.blocks_table_name_map.get(&block_table_name).copied().unwrap_or(0) + 1;
                  a.blocks_table_name_map.insert(block_table_name.clone(), count);
                  if let Some(id) = block.identity() {
                    self.schema.block_table_name_index.insert(id, count);
                  }
                  block_table_name = format!("{block_table_name}_{count}");
                }
              }

              let slug = block.get("slug").to_js_string();
              let relation_name = match block.identity().and_then(|id| self.schema.block_table_name_index.get(&id)) {
                Some(index) => format!("_blocks_{slug}_{index}"),
                None => format!("_blocks_{slug}"),
              };

              if !matches!(self.schema.raw_tables.get(&block_table_name), Some(Some(_))) {
                let mut base_columns = Map::new();
                base_columns.insert("_order".into(), json!({ "name": "_order", "type": "integer", "notNull": true }));
                base_columns.insert(
                  "_parentID".into(),
                  json!({ "name": "_parent_id", "type": a.root_table_id_col_type, "notNull": true }),
                );
                base_columns.insert("_path".into(), json!({ "name": "_path", "type": "text", "notNull": true }));

                let mut base_indexes = Map::new();
                base_indexes
                  .insert("_orderIdx".into(), json!({ "name": format!("{block_table_name}_order_idx"), "on": "_order" }));
                base_indexes.insert(
                  "_parentIDIdx".into(),
                  json!({ "name": format!("{block_table_name}_parent_id_idx"), "on": ["_parentID"] }),
                );
                base_indexes
                  .insert("_pathIdx".into(), json!({ "name": format!("{block_table_name}_path_idx"), "on": "_path" }));

                let mut base_foreign_keys = Map::new();
                base_foreign_keys.insert(
                  "_parentIdFk".into(),
                  cascade_fk(format!("{block_table_name}_parent_id_fk"), "_parentID", &a.root_table_name),
                );

                if is_localized_block_table {
                  base_columns.insert(
                    "_locale".into(),
                    json!({ "name": "_locale", "type": "enum", "locale": true, "notNull": true }),
                  );
                  base_indexes.insert(
                    "_localeIdx".into(),
                    json!({ "name": format!("{block_table_name}_locale_idx"), "on": "_locale" }),
                  );
                }

                let flattened: Vec<JsVal> = block.get("flattenedFields").items().cloned().collect();
                let sub_parent_is_localized = a.parent_is_localized || field.get("localized").truthy();
                let sub = self.build_table(BuildTableArgs {
                  base_columns,
                  base_foreign_keys,
                  base_indexes,
                  blocks_table_name_map: &mut *a.blocks_table_name_map,
                  compound_indexes: None,
                  disable_not_null: disable_not_null_from_here,
                  disable_rels_table_unique: true,
                  disable_unique: a.disable_unique,
                  fields: if a.disable_unique { id_to_uuid(&flattened) } else { flattened },
                  parent_is_localized: sub_parent_is_localized,
                  root_relationships: Some(&mut *a.relationships),
                  root_relations_to_build: Some(a.root_relations_to_build.clone()),
                  root_table_id_col_type: Some(a.root_table_id_col_type.clone()),
                  root_table_name: Some(a.root_table_name.clone()),
                  root_unique_relationships: Some(&mut *a.unique_relationships),
                  table_name: block_table_name.clone(),
                  timestamps: false,
                  versions: a.versions,
                  within_localized_array_or_block: is_localized_block_table,
                })?;
                merge_sub_flags(&mut r, &sub);

                let mut block_relations = Map::new();
                block_relations.insert(
                  "_parentID".into(),
                  one_relation("_parentID", &block_table_name, &relation_name, &a.root_table_name),
                );
                let locales_name = format!("{block_table_name}{}", self.opts.locales_suffix);
                if has_locales_table(block.get("fields"), sub_parent_is_localized) {
                  block_relations.insert("_locales".into(), many_relation("_locales", &locales_name));
                }
                add_sub_relations(&mut block_relations, &sub.relations_to_build, &block_table_name, &locales_name);
                self.schema.raw_relations.insert(block_table_name.clone(), block_relations);
              }

              // blocks relationships are defined from the root table down to the block, bypassing sub blocks
              a.root_relations_to_build.borrow_mut().insert(
                relation_name,
                RelationToBuild { kind: "many", localized: false, relation_name: None, target: block_table_name },
              );
            }
          }
        }

        "checkbox" => {
          insert_with_default!(json!({ "name": column_name, "type": "boolean" }));
        }

        "code" | "email" | "slug" | "textarea" => {
          insert_with_default!(json!({ "name": column_name, "type": "varchar" }));
        }

        "date" => {
          insert_with_default!(json!({ "name": column_name, "type": "timestamp", "mode": "string", "precision": 3, "withTimezone": true }));
        }

        "group" | "tab" => {
          let disable_not_null_from_here = field.path(&["admin", "condition"]).truthy() || a.disable_not_null;
          let sub = self.traverse_fields(TraverseArgs {
            blocks_table_name_map: &mut *a.blocks_table_name_map,
            column_prefix: format!("{column_name}_"),
            columns: &mut *a.columns,
            column_defaults: &mut *a.column_defaults,
            disable_not_null: disable_not_null_from_here,
            // upstream does not forward `disableRelsTableUnique` here
            disable_rels_table_unique: false,
            disable_unique: a.disable_unique,
            field_prefix: Some(format!("{field_name}.")),
            fields: field.get("flattenedFields").as_arr().unwrap_or(&[]),
            force_localized: is_field_localized || a.force_localized,
            indexes: &mut *a.indexes,
            locales_columns: &mut *a.locales_columns,
            locales_column_defaults: &mut *a.locales_column_defaults,
            locales_indexes: &mut *a.locales_indexes,
            new_table_name: format!("{}_{column_name}", a.parent_table_name),
            parent_is_localized: a.parent_is_localized || field.get("localized").truthy(),
            parent_table_name: a.parent_table_name.clone(),
            relationships: &mut *a.relationships,
            relations_to_build: a.relations_to_build.clone(),
            root_relations_to_build: a.root_relations_to_build.clone(),
            root_table_id_col_type: a.root_table_id_col_type.clone(),
            root_table_name: a.root_table_name.clone(),
            unique_relationships: &mut *a.unique_relationships,
            versions: a.versions,
            within_localized_array_or_block: a.within_localized_array_or_block || is_field_localized,
          })?;

          if sub.has_localized_field {
            r.has_localized_field = true;
          }
          if sub.has_localized_relationship_field {
            r.has_localized_relationship_field = true;
          }
          // upstream sets `true`, dropping a previous `'index'`
          if sub.has_many_text_field.truthy() {
            r.has_many_text_field = HasMany::Yes;
          }
          if sub.has_localized_many_text_field {
            r.has_localized_many_text_field = true;
          }
          if sub.has_many_number_field.truthy() {
            r.has_many_number_field = HasMany::Yes;
          }
          if sub.has_localized_many_number_field {
            r.has_localized_many_number_field = true;
          }
        }

        "json" | "richText" => {
          insert_with_default!(json!({ "name": column_name, "type": "jsonb" }));
        }

        "number" => {
          if field.get("hasMany").truthy() {
            if is_localized_sub {
              r.has_localized_many_number_field = true;
            }
            if field.get("index").truthy() {
              r.has_many_number_field = HasMany::Index;
            } else if !r.has_many_number_field.truthy() {
              r.has_many_number_field = HasMany::Yes;
            }
            if field_unique.truthy() {
              return Err(EngineError::invalid_configuration(
                "Unique is not supported in Postgres for hasMany number fields.",
              ));
            }
          } else {
            insert_with_default!(json!({ "name": column_name, "type": "numeric" }));
          }
        }

        "point" => {
          insert_with_default!(json!({ "name": column_name, "type": "geometry" }));
        }

        "radio" | "select" => {
          let enum_prefix = format!("enum_{}_", a.new_table_name);
          let enum_args = || CreateTableName {
            parent_table_name: Some(&a.new_table_name),
            prefix: &enum_prefix,
            enum_name: true,
            throw_validation_error: true,
            ..Default::default()
          };
          let enum_name = self.create_table_name(field, enum_args())?;

          let options: Vec<Json> = field
            .get("options")
            .items()
            .map(|option| if option_is_object(option) { option.get("value").to_json() } else { option.to_json() })
            .collect();

          if field_type == "select" && field.get("hasMany").truthy() {
            let prefix = format!("{}_", a.new_table_name);
            let select_table_name = self.create_table_name(
              field,
              CreateTableName {
                parent_table_name: Some(&a.new_table_name),
                prefix: &prefix,
                throw_validation_error: true,
                versions_custom_name: a.versions,
                ..Default::default()
              },
            )?;

            let value_enum_name = self.create_table_name(field, enum_args())?;
            let mut base_columns = Map::new();
            base_columns.insert("order".into(), json!({ "name": "order", "type": "integer", "notNull": true }));
            base_columns
              .insert("parent".into(), json!({ "name": "parent_id", "type": parent_id_col_type, "notNull": true }));
            base_columns.insert(
              "value".into(),
              json!({ "name": "value", "type": "enum", "enumName": value_enum_name, "options": options }),
            );

            let mut base_indexes = Map::new();
            base_indexes
              .insert("orderIdx".into(), json!({ "name": format!("{select_table_name}_order_idx"), "on": "order" }));
            base_indexes
              .insert("parentIdx".into(), json!({ "name": format!("{select_table_name}_parent_idx"), "on": "parent" }));

            let mut base_foreign_keys = Map::new();
            base_foreign_keys.insert(
              "parentFk".into(),
              cascade_fk(format!("{select_table_name}_parent_fk"), "parent", &a.parent_table_name),
            );

            if is_localized_sub {
              base_columns
                .insert("locale".into(), json!({ "name": "locale", "type": "enum", "locale": true, "notNull": true }));
              base_indexes
                .insert("localeIdx".into(), json!({ "name": format!("{select_table_name}_locale_idx"), "on": "locale" }));
            }

            if field.get("index").truthy() {
              base_indexes
                .insert("value".into(), json!({ "name": format!("{select_table_name}_value_idx"), "on": "value" }));
            }

            let mut args = BuildTableArgs::new(select_table_name.clone(), Vec::new(), &mut *a.blocks_table_name_map);
            args.base_columns = base_columns;
            args.base_foreign_keys = base_foreign_keys;
            args.base_indexes = base_indexes;
            args.disable_not_null = a.disable_not_null;
            args.disable_unique = a.disable_unique;
            args.parent_is_localized = a.parent_is_localized || field.get("localized").truthy();
            args.root_table_name = Some(a.root_table_name.clone());
            args.versions = a.versions;
            self.build_table(args)?;

            a.relations_to_build.borrow_mut().insert(
              field_name.clone(),
              RelationToBuild { kind: "many", localized: false, relation_name: None, target: select_table_name.clone() },
            );

            let mut rels = Map::new();
            rels.insert(
              "parent".into(),
              one_relation("parent", &select_table_name, &field_name, &a.parent_table_name),
            );
            self.schema.raw_relations.insert(select_table_name, rels);
          } else {
            insert_with_default!(json!({ "name": column_name, "type": "enum", "enumName": enum_name, "options": options }));
          }
        }

        "relationship" | "upload" => {
          let relation_to = field.get("relationTo");
          let unique_rel = field_unique.truthy() && !a.disable_unique && !a.disable_rels_table_unique;
          let mut simple = false;
          if let Some(relations) = relation_to.as_arr() {
            for relation in relations {
              let relation = relation.to_js_string();
              a.relationships.insert(relation.clone());
              if unique_rel {
                a.unique_relationships.insert(relation);
              }
            }
          } else if field.get("hasMany").truthy() {
            let relation = relation_to.to_js_string();
            a.relationships.insert(relation.clone());
            if unique_rel {
              a.unique_relationships.insert(relation);
            }
          } else {
            simple = true;
            // simple relationships get a column on the targetTable with a foreign key to the relationTo table
            let relation_slug = relation_to.to_js_string();
            let relationship_config = self.collection_config(&relation_slug)?.clone();
            let table_name = self.schema.table_name_map.get(&to_snake_case(&relation_slug)).cloned().ok_or_else(|| {
              EngineError::internal(format!("no table name registered for collection '{relation_slug}'"))
            })?;

            let mut col_type = if is_uuid_type(&self.opts.id_type) { "uuid" } else { "integer" };
            let custom_id = relationship_config
              .get("fields")
              .items()
              .find(|f| field_affects_data(f) && f.get("name").as_str() == Some("id"));
            if let Some(custom_id) = custom_id {
              match custom_id.get("type").as_str() {
                Some("number") => col_type = "numeric",
                Some("text") => col_type = "varchar",
                _ => {}
              }
            }

            let mut col = json!({
              "name": format!("{column_name}_id"),
              "type": col_type,
              "reference": { "name": "id", "onDelete": "set null", "table": table_name },
            });

            a.relations_to_build.borrow_mut().insert(
              field_name.clone(),
              RelationToBuild {
                kind: "one",
                localized: localization && (is_field_localized || a.force_localized),
                relation_name: None,
                target: table_name,
              },
            );

            if !a.disable_not_null && field.get("required").truthy() && !field.path(&["admin", "condition"]).truthy()
              && let Some(o) = col.as_object_mut()
            {
              o.insert("notNull".into(), Json::Bool(true));
            }
            target_table!().insert(field_name.clone(), col);
          }

          if !simple && ((is_field_localized && localization) || a.within_localized_array_or_block) {
            r.has_localized_relationship_field = true;
          }
        }

        "text" => {
          if field.get("hasMany").truthy() {
            if is_localized_sub {
              r.has_localized_many_text_field = true;
            }
            if field.get("index").truthy() {
              r.has_many_text_field = HasMany::Index;
            } else if !r.has_many_text_field.truthy() {
              r.has_many_text_field = HasMany::Yes;
            }
            if field_unique.truthy() {
              return Err(EngineError::invalid_configuration(
                "Unique is not supported in Postgres for hasMany text fields.",
              ));
            }
          } else {
            insert_with_default!(json!({ "name": column_name, "type": "varchar" }));
          }
        }

        _ => {}
      }

      let condition = field.path(&["admin", "condition"]).truthy();
      if !a.disable_not_null
        && field.has("required")
        && field.get("required").truthy()
        && !condition
        && let Some(Json::Object(col)) = target_table!().get_mut(&field_name)
      {
        col.insert("notNull".into(), Json::Bool(true));
      }
    }

    Ok(r)
  }
}

/// Merges the `has*` flags of an array / block sub table (`buildTable` result) into the parent traversal.
fn merge_sub_flags(r: &mut TraverseResult, sub: &BuildResult) {
  if sub.has_localized_many_number_field {
    r.has_localized_many_number_field = true;
  }
  if sub.has_localized_relationship_field {
    r.has_localized_relationship_field = true;
  }
  if sub.has_localized_many_text_field {
    r.has_localized_many_text_field = true;
  }
  if sub.has_many_text_field.truthy() && (!r.has_many_text_field.truthy() || sub.has_many_text_field == HasMany::Index) {
    r.has_many_text_field = sub.has_many_text_field;
  }
  if sub.has_many_number_field.truthy()
    && (!r.has_many_number_field.truthy() || sub.has_many_number_field == HasMany::Index)
  {
    r.has_many_number_field = sub.has_many_number_field;
  }
}

/// `subRelationsToBuild.forEach(...)` for array and block tables.
fn add_sub_relations(relations: &mut Map<String, Json>, sub: &RelationMap, table_name: &str, locales_name: &str) {
  for (key, rel) in sub.borrow().iter() {
    if rel.kind == "one" {
      let table = if rel.localized { locales_name } else { table_name };
      relations.insert(key.clone(), one_relation(key, table, key, &rel.target));
    }
    if rel.kind == "many" {
      relations.insert(key.clone(), many_relation(key, &rel.target));
    }
  }
}

fn date_field(name: &str) -> JsVal {
  JsVal::obj(Obj::from_iter([
    ("name".into(), JsVal::str(name)),
    ("type".into(), JsVal::str("date")),
    ("admin".into(), admin_disabled()),
    ("index".into(), JsVal::Bool(true)),
  ]))
}

fn admin_disabled() -> JsVal {
  JsVal::obj(Obj::from_iter([("disabled".into(), JsVal::Bool(true))]))
}

/// `buildVersionCompoundIndexes`
fn build_version_compound_indexes(indexes: &JsVal) -> Vec<JsVal> {
  indexes
    .items()
    .map(|each| {
      let fields = each
        .get("fields")
        .items()
        .map(|f| {
          JsVal::obj(Obj::from_iter([
            ("field".into(), f.get("field").clone()),
            ("localizedPath".into(), JsVal::str(format!("version.{}", f.get("localizedPath").to_js_string()))),
            ("path".into(), JsVal::str(format!("version.{}", f.get("path").to_js_string()))),
            ("pathHasLocalized".into(), f.get("pathHasLocalized").clone()),
          ]))
        })
        .collect();
      JsVal::obj(Obj::from_iter([("fields".into(), JsVal::arr(fields)), ("unique".into(), JsVal::Bool(false))]))
    })
    .collect()
}

/// `${name.slice(0, end)}${suffix}` as a Rust string, plus the exact JS code units when the slice
/// cuts a surrogate pair (the Rust string then has U+FFFD for the lone surrogate).
///
/// Names are deduplicated by their Rust string: two names that differ only in the lone surrogate
/// count as the same name (in TS they differ), which needs two over-long field names whose cut
/// lands in different surrogate pairs after an otherwise identical prefix.
fn truncated_identifier(name: &str, end: usize, suffix: &str) -> (String, Option<Vec<u16>>) {
  let mut units = js_slice_to_units(name, end);
  let lossy = format!("{}{suffix}", String::from_utf16_lossy(&units));
  if !has_lone_surrogate(&units) {
    return (lossy, None);
  }
  units.extend(suffix.encode_utf16());
  (lossy, Some(units))
}

fn validate_identifier_length(name: String) -> Result<String> {
  if js_len(&name) > MAX_IDENTIFIER_LENGTH {
    return Err(EngineError::api(format!(
      "Exceeded max identifier length for table or enum name of {MAX_IDENTIFIER_LENGTH} characters. Invalid name: {name}.\nTip: You can use the dbName property to reduce the table name length.\n      "
    )));
  }
  Ok(name)
}

/// Resolves a property path (object keys / array indexes) from `root`.
pub fn resolve_path<'v>(root: &'v JsVal, path: &[String]) -> Option<&'v JsVal> {
  path.iter().try_fold(root, |v, key| match v {
    JsVal::Obj(o) => o.get(key),
    JsVal::Arr(a) => key.parse::<usize>().ok().and_then(|i| a.get(i)),
    _ => None,
  })
}

/// Finds one property path from `root` to every object whose [`JsVal::identity`] is in `ids`,
/// so identity-keyed side tables (e.g. `block[InternalBlockTableNameIndex]`) can be applied
/// back onto the JS objects.
pub fn find_identity_paths(root: &JsVal, ids: &HashMap<usize, u32>) -> Vec<(Vec<String>, u32)> {
  let mut out = Vec::new();
  if ids.is_empty() {
    return out;
  }
  let mut seen = std::collections::HashSet::new();
  let mut path = Vec::new();
  walk_identities(root, ids, &mut seen, &mut path, &mut out);
  out
}

fn walk_identities(
  v: &JsVal,
  ids: &HashMap<usize, u32>,
  seen: &mut std::collections::HashSet<usize>,
  path: &mut Vec<String>,
  out: &mut Vec<(Vec<String>, u32)>,
) {
  let Some(id) = v.identity() else { return };
  if !seen.insert(id) {
    return;
  }
  if let Some(index) = ids.get(&id) {
    out.push((path.clone(), *index));
  }
  match v {
    JsVal::Obj(o) => {
      for (k, child) in o.iter() {
        path.push(k.clone());
        walk_identities(child, ids, seen, path, out);
        path.pop();
      }
    }
    JsVal::Arr(a) => {
      for (i, child) in a.iter().enumerate() {
        path.push(i.to_string());
        walk_identities(child, ids, seen, path, out);
        path.pop();
      }
    }
    _ => {}
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::host::NoHost;
  use crate::js::decode_graph;

  fn opts(id_type: &str) -> SchemaOptions {
    SchemaOptions::from_json(&json!({ "idType": id_type, "autoIncrement": true }))
  }

  fn run(graph: &JsVal, options: SchemaOptions) -> Result<RawSchema> {
    build_raw_schema(
      &NoHost,
      SchemaInput {
        config: graph.get("config"),
        collections: graph.get("collections"),
        blocks: graph.get("blocks"),
        block_table_name_index: HashMap::new(),
      },
      options,
    )
  }

  /// Output in the shape the spec stores: `tableNameMap` as `[key, value]` pairs.
  fn comparable(schema: &RawSchema) -> Json {
    let mut out = schema.to_json();
    let pairs = schema.table_name_map.iter().map(|(k, v)| json!([k, v])).collect();
    out.as_object_mut().expect("object").insert("tableNameMap".into(), Json::Array(pairs));
    out
  }

  /// Differential check against golden TS outputs written by
  /// `RS_SCHEMA_WRITE_FIXTURES=1 pnpm test:int:sqlite test/__rs/schema/schema.int.spec.ts`.
  ///
  /// The fixtures are git-ignored: the test fails when they are missing, unless
  /// `RS_SCHEMA_ALLOW_MISSING_FIXTURES=1` explicitly allows skipping it.
  #[test]
  fn golden_fixtures() {
    const FIXTURES: [&str; 4] = ["fields", "localization", "relationships", "versions"];
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/__rs/schema/fixtures");
    let missing: Vec<_> = FIXTURES.iter().filter(|name| !dir.join(format!("{name}.json")).exists()).collect();
    if !missing.is_empty() {
      let hint = "generate them with `RS_SCHEMA_WRITE_FIXTURES=1 SQLITE_URL=file:/tmp/rs-schema.db pnpm test:int:sqlite test/__rs/schema/schema.int.spec.ts`";
      if std::env::var("RS_SCHEMA_ALLOW_MISSING_FIXTURES").as_deref() == Ok("1") {
        eprintln!("missing schema fixtures {missing:?} in {} (allowed by RS_SCHEMA_ALLOW_MISSING_FIXTURES), {hint}", dir.display());
        return;
      }
      panic!("missing schema fixtures {missing:?} in {}: {hint}", dir.display());
    }
    let mut compared = 0;
    for name in FIXTURES {
      let entry = dir.join(format!("{name}.json"));
      let text = std::fs::read_to_string(&entry).expect("read fixture");
      let fixture: Json = serde_json::from_str(&text).expect("parse fixture");
      let graph = decode_graph(&fixture["graph"]).expect("decode graph");
      for (variant, expected) in fixture["outputs"].as_object().expect("outputs") {
        let options = SchemaOptions::from_json(&json!({
          "autoIncrement": variant == "number" || variant == "blocksAsJSON",
          "blocksAsJSON": variant == "blocksAsJSON",
          "idType": if variant == "blocksAsJSON" { "number" } else { variant.as_str() },
        }));
        let label = format!("{} [{variant}]", entry.display());
        match (run(&graph, options), expected.get("result")) {
          (Ok(schema), Some(result)) => {
            let actual = comparable(&schema);
            for key in ["rawTables", "rawRelations", "tableNameMap", "indexes", "foreignKeys", "fieldConstraints"] {
              assert_eq!(actual[key].to_string(), result[key].to_string(), "{label} {key}");
            }
          }
          (Err(e), None) => {
            assert_eq!(e.to_json()["name"], expected["error"]["name"], "{label}");
            assert_eq!(e.to_json()["message"], expected["error"]["message"], "{label}");
          }
          (actual, _) => panic!("{label}: outcome differs: {:?} vs {expected}", actual.map(|_| ())),
        }
        compared += 1;
      }
    }
    assert_eq!(compared, FIXTURES.len() * 4, "every fixture has the 4 variants");
    eprintln!("compared {compared} fixture variants");
  }

  fn graph(config: Json, collections: Json) -> JsVal {
    JsVal::from_json(&json!({ "config": config, "collections": collections, "blocks": {} }))
  }

  #[test]
  fn index_names_are_truncated_and_deduplicated() {
    let g = graph(json!({ "collections": [], "globals": [] }), json!({}));
    let input =
      SchemaInput { config: g.get("config"), collections: g.get("collections"), blocks: g.get("blocks"), block_table_name_index: HashMap::new() };
    let mut b = Builder { host: &NoHost, input, opts: opts("number"), schema: RawSchema::default() };
    let long = "x".repeat(80);
    let first = b.build_index_name(&long, true);
    let second = b.build_index_name(&long, true);
    assert_eq!(first, format!("{}_idx", "x".repeat(56)));
    assert_eq!(second, format!("{}_1_idx", "x".repeat(54)));
    assert_eq!(b.build_foreign_key_name("t"), "t_fk");
    assert_eq!(b.build_foreign_key_name("t"), "t_1_fk");
  }

  struct RecordingHost(RefCell<Vec<(u32, JsVal)>>);

  impl Host for RecordingHost {
    fn call(&self, _id: u32, _arg: &Json) -> Result<JsVal> {
      unreachable!("the schema builder passes JS values")
    }

    fn call_value(&self, id: u32, arg: &JsVal) -> Result<JsVal> {
      self.0.borrow_mut().push((id, arg.clone()));
      Ok(JsVal::Undefined)
    }
  }

  #[test]
  fn db_name_functions_get_own_table_name_key() {
    let collection = json!({
      "slug": "posts",
      "fields": [],
      "flattenedFields": [{ "name": "items", "type": "array", "dbName": { "$fn": 1 }, "fields": [], "flattenedFields": [] }],
      "sanitizedIndexes": [],
      "upload": false,
      "dbName": { "$fn": 0 },
    });
    let g = crate::js::decode_graph(&json!({
      "objects": [],
      "root": { "config": { "collections": [collection], "globals": [] }, "collections": {}, "blocks": {} },
    }))
    .expect("decode");
    let host = RecordingHost(RefCell::new(Vec::new()));
    let input =
      SchemaInput { config: g.get("config"), collections: g.get("collections"), blocks: g.get("blocks"), block_table_name_index: HashMap::new() };
    build_raw_schema(&host, input, opts("number")).expect("build");
    let calls = host.0.borrow();
    let root = calls.iter().find(|(id, _)| *id == 0).expect("root dbName called");
    assert!(root.1.has("tableName") && root.1.get("tableName").is_undefined());
    assert_eq!(root.1.to_json(), json!({}), "hosts that only take JSON still get an empty object");
    let nested = calls.iter().find(|(id, _)| *id == 1).expect("array dbName called");
    assert_eq!(nested.1.get("tableName").as_str(), Some("posts"));
  }

  #[test]
  fn truncated_identifiers_keep_lone_surrogates() {
    let g = graph(json!({ "collections": [], "globals": [] }), json!({}));
    let input =
      SchemaInput { config: g.get("config"), collections: g.get("collections"), blocks: g.get("blocks"), block_table_name_index: HashMap::new() };
    let mut b = Builder { host: &NoHost, input, opts: opts("number"), schema: RawSchema::default() };
    // the cut at 56 code units lands inside the emoji's surrogate pair
    let name = format!("{}\u{1F600}tail_padding_to_get_over_the_limit", "x".repeat(55));
    let index = b.build_index_name(&name, true);
    assert_eq!(index, format!("{}\u{FFFD}_idx", "x".repeat(55)));
    let mut expected: Vec<u16> = "x".repeat(55).encode_utf16().collect();
    expected.push(0xD83D);
    expected.extend("_idx".encode_utf16());
    assert_eq!(b.schema.utf16_identifiers.get(&index), Some(&expected));
    // `_fk` is one unit shorter than `_idx`: the cut lands one unit later
    let fk = b.build_foreign_key_name(&format!("x{name}"));
    assert_eq!(b.schema.utf16_identifiers.get(&fk).map(|u| u.len()), Some(60));
    assert_eq!(b.build_index_name("short", true), "short_idx");
    assert_eq!(b.schema.utf16_identifiers.len(), 2);
  }

  #[test]
  fn has_many_text_unique_is_invalid_configuration() {
    let collection = json!({
      "slug": "posts",
      "fields": [],
      "flattenedFields": [{ "name": "tags", "type": "text", "hasMany": true, "unique": true }],
      "sanitizedIndexes": [],
      "upload": false,
    });
    let g = graph(json!({ "collections": [collection], "globals": [] }), json!({}));
    let err = run(&g, opts("number")).expect_err("must fail");
    assert_eq!(err.name, "InvalidConfiguration");
    assert_eq!(err.message, "Unique is not supported in Postgres for hasMany text fields.");
  }

  #[test]
  fn simple_columns_and_not_null() {
    let collection = json!({
      "slug": "posts",
      "fields": [],
      "flattenedFields": [
        { "name": "title", "type": "text", "required": true, "defaultValue": "x" },
        { "name": "_status", "type": "select", "options": [{ "label": "A", "value": "a" }, "b"] },
      ],
      "sanitizedIndexes": [],
      "timestamps": true,
      "upload": false,
    });
    let g = graph(json!({ "collections": [collection], "globals": [] }), json!({}));
    let schema = run(&g, opts("uuid")).expect("build");
    let table = schema.raw_tables["posts"].as_ref().expect("table");
    assert_eq!(table.columns["id"], json!({ "name": "id", "type": "uuid", "defaultRandom": true, "primaryKey": true }));
    assert_eq!(table.columns["title"], json!({ "name": "title", "type": "varchar", "default": "x", "notNull": true }));
    assert_eq!(
      table.columns["_status"],
      json!({ "name": "_status", "type": "enum", "enumName": "enum_posts_status", "options": ["a", "b"] })
    );
    assert!(table.columns.contains_key("createdAt"));
  }
}
