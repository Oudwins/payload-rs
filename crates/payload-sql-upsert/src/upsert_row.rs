//! Port of packages/drizzle/src/upsertRow/index.ts, insertArrays.ts,
//! deleteExistingArrayRows.ts and deleteExistingRowsByPath.ts.
//!
//! The write transform (`transformForWrite`) and `shouldUseOptimizedUpsertRow`
//! are called directly ([`payload_sql_write::transform_for_write`] and
//! [`crate::optimized::should_use_optimized_upsert_row`]); the
//! [`RowToInsert`] they produce is the single shared type of the write crate.

use indexmap::{IndexMap, IndexSet};
use payload_engine::error::{EngineError, Result};
use payload_engine::js::{JsVal, Obj};
use payload_engine::sql::schema::RawSchema;
use payload_sql_write::js::{OBJECT_PROTOTYPE_KEYS, js_insert, to_js_string};
use payload_sql_write::{NestedRowToInsert, Row, RowToInsert, RowValue, TransformForWriteArgs, WriteAdapter, transform_for_write};

use crate::error::{ErrorContext, handle_upsert_error};
use crate::optimized::should_use_optimized_upsert_row;
use crate::sql::{
  ExecError, ExecResult, Executor, OnConflictDoUpdate, Returning, SqlFragment, Table, and, build_update, eq, ident,
  in_array, is_null, or, require_table, table,
};
use crate::value::{get_defined, js_to_number, obj_into_row, row_set, row_value};

/// Adapter state used by the write path (`adapter.*`).
#[derive(Clone, Debug)]
pub struct AdapterOptions {
  pub allow_id_on_create: bool,
  pub limited_bound_parameters: bool,
  pub locales_suffix: String,
  pub relationships_suffix: String,
  pub versions_suffix: String,
}

impl Default for AdapterOptions {
  fn default() -> Self {
    Self {
      allow_id_on_create: false,
      limited_bound_parameters: false,
      locales_suffix: "_locales".into(),
      relationships_suffix: "_rels".into(),
      versions_suffix: "_v".into(),
    }
  }
}

impl AdapterOptions {
  /// Reads `{ allowIDOnCreate, limitedBoundParameters, localesSuffix, relationshipsSuffix, versionsSuffix }`.
  pub fn from_js(value: &JsVal) -> Self {
    let d = Self::default();
    let s = |k: &str, d: String| value.get(k).as_str().map(str::to_string).unwrap_or(d);
    Self {
      allow_id_on_create: value.get("allowIDOnCreate").truthy(),
      limited_bound_parameters: value.get("limitedBoundParameters").truthy(),
      locales_suffix: s("localesSuffix", d.locales_suffix),
      relationships_suffix: s("relationshipsSuffix", d.relationships_suffix),
      versions_suffix: s("versionsSuffix", d.versions_suffix),
    }
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
  Create,
  Update,
}

impl Operation {
  pub fn as_str(self) -> &'static str {
    match self {
      Operation::Create => "create",
      Operation::Update => "update",
    }
  }
}

/// `ignoreResult?: 'idOnly' | boolean`
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum IgnoreResult {
  #[default]
  No,
  Yes,
  IdOnly,
}

impl IgnoreResult {
  pub fn from_js(v: &JsVal) -> Self {
    match v {
      JsVal::Str(s) if &**s == "idOnly" => IgnoreResult::IdOnly,
      other if other.truthy() => IgnoreResult::Yes,
      _ => IgnoreResult::No,
    }
  }

  fn truthy(self) -> bool {
    self != IgnoreResult::No
  }
}

/// The shape of `buildFindManyArgs({ depth: 0, joinQuery: false, select, ... })`
/// as far as the optimized update path cares.
#[derive(Clone, Debug)]
pub enum FindArgsShape {
  /// `Object.keys(findManyArgs).length === 0`
  Empty,
  /// `Object.keys(findManyArgs.columns).length > 0`: the enabled columns.
  OnlyColumns(Vec<String>),
  /// Needs `with` joins: update first, then `findFirst`.
  NeedsQuery,
}

/// What `transformForWrite` / `shouldUseOptimizedUpsertRow` need from the
/// operation: the adapter state and the `fields` passed to `upsertRow`.
#[derive(Clone, Copy)]
pub struct WriteContext<'a> {
  pub adapter: &'a dyn WriteAdapter,
  /// `FlattenedField[]` of the upsert target (collection, global or version fields).
  pub fields: &'a JsVal,
}

/// Boundary to the modules owned by other ports (find + read transform) and
/// observation points. Implementations are bound to the `fields`, `select`
/// and `tableName` of one operation.
pub trait UpsertHost {
  /// `buildFindManyArgs({ adapter, depth: 0, fields, joinQuery: false, select, tableName })`
  fn find_args_shape(&mut self) -> Result<FindArgsShape>;

  /// `db.query[tableName].findFirst({ ...findManyArgs, where })` followed by the
  /// read `transform`. `None` when no row matches.
  fn find_first(&mut self, exec: &mut Executor<'_>, where_: &SqlFragment) -> Result<Option<JsVal>>;

  /// Read `transform` of a raw row returned by `.returning()`.
  fn transform_row(&mut self, row: Obj) -> Result<JsVal>;

  /// Called before every `transformForWrite`; returns the `Date.now()` the
  /// transform uses for auto `updatedAt` (`None` reads the system clock).
  fn transform_started(&mut self, _data: &JsVal, _enable_atomic_writes: bool, _path: &str, _table_name: &str) -> Option<f64> {
    None
  }

  /// Called after every `transformForWrite` with its result and the (mutated) data.
  fn transform_finished(&mut self, _result: std::result::Result<&RowToInsert, &EngineError>, _data: &JsVal) {}

  /// Called after every `shouldUseOptimizedUpsertRow`.
  fn should_use_checked(&mut self, _data: &JsVal, _result: std::result::Result<bool, &EngineError>) {}

  /// Called when `upsertRow` starts (before `data.createdAt` is set).
  fn upsert_started(&mut self, _args: &UpsertRowArgs, _data: &JsVal) {}

  /// Called when `upsertRow` returns or throws.
  fn upsert_finished(&mut self, _outcome: std::result::Result<&UpsertOutcome, &EngineError>) {}
}

/// `transformForWrite({ adapter, data, enableAtomicWrites, fields, path, tableName })`
pub(crate) fn run_transform(
  ctx: &WriteContext<'_>,
  host: &mut dyn UpsertHost,
  data: &mut JsVal,
  enable_atomic_writes: bool,
  path: &str,
  table_name: &str,
) -> Result<RowToInsert> {
  let now = host.transform_started(data, enable_atomic_writes, path, table_name);
  let args = TransformForWriteArgs {
    adapter: ctx.adapter,
    enable_atomic_writes,
    fields: ctx.fields,
    parent_is_localized: false,
    path,
    table_name,
    now,
  };
  let result = transform_for_write(args, data);
  host.transform_finished(result.as_ref(), data);
  result
}

/// `shouldUseOptimizedUpsertRow({ data, fields })`
pub(crate) fn run_should_use(ctx: &WriteContext<'_>, host: &mut dyn UpsertHost, data: &JsVal) -> Result<bool> {
  let result = should_use_optimized_upsert_row(data, ctx.fields);
  host.should_use_checked(data, result.as_ref().copied());
  result
}

/// Arguments of `upsertRow` (packages/drizzle/src/upsertRow/types.ts) after
/// the TS-only values (`adapter`, `db`, `fields`, `req`, `select`) moved to
/// the executor / write context / host.
#[derive(Clone, Debug)]
pub struct UpsertRowArgs {
  pub table_name: String,
  pub operation: Operation,
  /// `undefined` when not passed.
  pub id: JsVal,
  pub custom_id: JsVal,
  pub where_: Option<SqlFragment>,
  /// Column key of `upsertTarget`.
  pub upsert_target: Option<String>,
  pub ignore_result: IgnoreResult,
  pub path: String,
  pub collection_slug: Option<String>,
  pub global_slug: Option<String>,
  pub value_must_be_unique: Option<String>,
  pub following_fields_invalid: Option<String>,
  /// `new Date().toISOString()` used when `operation === 'create'` and
  /// `data.createdAt` is falsy. Defaults to the current time.
  pub now: Option<String>,
}

impl UpsertRowArgs {
  pub fn new(table_name: impl Into<String>, operation: Operation) -> Self {
    Self {
      table_name: table_name.into(),
      operation,
      id: JsVal::Undefined,
      custom_id: JsVal::Undefined,
      where_: None,
      upsert_target: None,
      ignore_result: IgnoreResult::No,
      path: String::new(),
      collection_slug: None,
      global_slug: None,
      value_must_be_unique: None,
      following_fields_invalid: None,
      now: None,
    }
  }

  fn error_context(&self) -> ErrorContext {
    ErrorContext {
      id: self.id.clone(),
      collection_slug: self.collection_slug.clone(),
      global_slug: self.global_slug.clone(),
      value_must_be_unique: self.value_must_be_unique.clone(),
      following_fields_invalid: self.following_fields_invalid.clone(),
    }
  }
}

/// Result of `upsertRow`.
#[derive(Clone, Debug)]
pub enum UpsertOutcome {
  /// `null`
  Null,
  /// The read-back document.
  Doc(JsVal),
  /// `{ id }` (`ignoreResult: 'idOnly'`).
  IdOnly(JsVal),
  /// `data` as passed in (`ignoreResult: true`).
  Data(JsVal),
}

impl UpsertOutcome {
  /// The JS value returned by `upsertRow`.
  pub fn to_js(&self) -> JsVal {
    match self {
      UpsertOutcome::Null => JsVal::Null,
      UpsertOutcome::Doc(d) | UpsertOutcome::Data(d) => d.clone(),
      UpsertOutcome::IdOnly(id) => JsVal::obj(Obj::from([("id".to_string(), id.clone())])),
    }
  }

  /// `result?.id`
  pub fn id(&self) -> JsVal {
    match self {
      UpsertOutcome::Null => JsVal::Undefined,
      UpsertOutcome::IdOnly(id) => id.clone(),
      UpsertOutcome::Doc(d) | UpsertOutcome::Data(d) => d.get("id").clone(),
    }
  }
}

pub fn now_iso() -> String {
  payload_sql_write::js::iso_string(payload_sql_write::js::now_ms()).unwrap_or_default()
}

fn row_id(row: &Obj) -> JsVal {
  row.get("id").cloned().unwrap_or_default()
}

/// `upsertRow` (packages/drizzle/src/upsertRow/index.ts).
///
/// `data` is mutated like in TS (`data.createdAt` on create, and every
/// mutation `transformForWrite` makes).
pub fn upsert_row(
  exec: &mut Executor<'_>,
  schema: &RawSchema,
  opts: &AdapterOptions,
  ctx: &WriteContext<'_>,
  host: &mut dyn UpsertHost,
  args: &UpsertRowArgs,
  data: &mut JsVal,
) -> Result<UpsertOutcome> {
  host.upsert_started(args, data);
  let result = upsert_row_inner(exec, schema, opts, ctx, host, args, data);
  host.upsert_finished(result.as_ref());
  result
}

fn upsert_row_inner(
  exec: &mut Executor<'_>,
  schema: &RawSchema,
  opts: &AdapterOptions,
  ctx: &WriteContext<'_>,
  host: &mut dyn UpsertHost,
  args: &UpsertRowArgs,
  data: &mut JsVal,
) -> Result<UpsertOutcome> {
  let table_name = args.table_name.as_str();
  if args.operation == Operation::Create && !payload_sql_write::js::get(data, "createdAt")?.truthy() {
    let now = args.now.clone().unwrap_or_else(now_iso);
    payload_sql_write::js::set(data, "createdAt", JsVal::str(now))?;
  }

  let err_ctx = args.error_context();

  if args.id.truthy() && run_should_use(ctx, host, data)? {
    return optimized_update(exec, schema, opts, ctx, host, args, data)
      .map_err(|e| handle_upsert_error(schema, table_name, &err_ctx, e));
  }

  let mut row_to_insert = run_transform(ctx, host, data, false, &args.path, table_name)?;

  if args.custom_id.truthy() {
    row_set(&mut row_to_insert.row, "id", args.custom_id.clone());
  }

  let inserted = match write_rows(exec, schema, opts, args, data, row_to_insert) {
    Ok(Some(row)) => row,
    Ok(None) => return Ok(UpsertOutcome::Null),
    Err(e) => return Err(handle_upsert_error(schema, table_name, &err_ctx, e)),
  };
  let inserted_id = row_id(&inserted);

  match args.ignore_result {
    IgnoreResult::IdOnly => return Ok(UpsertOutcome::IdOnly(inserted_id)),
    IgnoreResult::Yes => return Ok(UpsertOutcome::Data(data.clone())),
    IgnoreResult::No => {}
  }

  let t = require_table(schema, table_name)?;
  // findManyArgs.where = eq(adapter.tables[tableName].id, insertedRow.id)
  let where_ = eq(t, "id", &inserted_id)?;
  let doc = host.find_first(exec, &where_)?;
  Ok(doc.map(UpsertOutcome::Doc).unwrap_or(UpsertOutcome::Null))
}

/// The `id && shouldUseOptimizedUpsertRow(...)` branch: a plain `UPDATE ... SET`.
fn optimized_update(
  exec: &mut Executor<'_>,
  schema: &RawSchema,
  opts: &AdapterOptions,
  ctx: &WriteContext<'_>,
  host: &mut dyn UpsertHost,
  args: &UpsertRowArgs,
  data: &mut JsVal,
) -> ExecResult<UpsertOutcome> {
  let id = args.id.clone();
  let transformed = run_transform(ctx, host, data, true, "", &args.table_name)?;
  let RowToInsert { mut row, arrays_to_push, .. } = transformed;
  let t = require_table(schema, &args.table_name)?;

  let id_eq = eq(t, "id", &id)?;
  let update_where = match &args.where_ {
    Some(w) => and(vec![id_eq, w.clone()]).unwrap_or_default(),
    None => id_eq,
  };

  let inserted_row = Obj::from([("id".to_string(), id.clone())]);

  if !arrays_to_push.is_empty() {
    let mut uuid_map = IndexMap::new();
    insert_arrays(exec, schema, opts, vec![arrays_to_push], std::slice::from_ref(&inserted_row), &mut uuid_map)?;
  }

  // `typeof row.updatedAt === 'undefined' || row.updatedAt === null`
  if matches!(get_defined(&row, "updatedAt"), None | Some(RowValue::Value(JsVal::Null))) {
    row.shift_remove("updatedAt");
  }
  let has_data_to_update = !row.is_empty();

  if args.ignore_result.truthy() {
    if has_data_to_update {
      let q = build_update(t, &row, Some(&update_where), &Returning::None)?;
      exec.query_raw(&q)?;
    }
    return Ok(if args.ignore_result == IgnoreResult::IdOnly { UpsertOutcome::IdOnly(id) } else { UpsertOutcome::Null });
  }

  let shape = host.find_args_shape()?;

  if !has_data_to_update {
    let doc = host.find_first(exec, &update_where)?;
    return Ok(doc.map(UpsertOutcome::Doc).unwrap_or(UpsertOutcome::Null));
  }

  match shape {
    FindArgsShape::Empty | FindArgsShape::OnlyColumns(_) => {
      let returning = match &shape {
        FindArgsShape::OnlyColumns(cols) => {
          // selectedFields[column] = adapter.tables[tableName][column]; columns
          // without a drizzle column are dropped by orderSelectedFields.
          let cols: Vec<String> = cols.iter().filter(|c| t.has_column(c)).cloned().collect();
          if cols.is_empty() { Returning::All } else { Returning::Columns(cols) }
        }
        _ => Returning::All,
      };
      let keys: Vec<String> = match &returning {
        Returning::Columns(c) => c.clone(),
        _ => t.columns().map(|(k, _)| k.clone()).collect(),
      };
      let key_refs: Vec<&str> = keys.iter().map(String::as_str).collect();
      let q = build_update(t, &row, Some(&update_where), &returning)?;
      let docs = exec.query_columns(t, &key_refs, &q)?;
      match docs.into_iter().next() {
        None => Ok(UpsertOutcome::Null),
        Some(doc) => Ok(UpsertOutcome::Doc(host.transform_row(doc)?)),
      }
    }
    FindArgsShape::NeedsQuery => {
      let q = build_update(t, &row, Some(&update_where), &Returning::Columns(vec!["id".into()]))?;
      let docs = exec.query_columns(t, &["id"], &q)?;
      let Some(first) = docs.into_iter().next() else { return Ok(UpsertOutcome::Null) };
      let where_ = eq(t, "id", &row_id(&first))?;
      let doc = host.find_first(exec, &where_)?;
      // transform() of an undefined doc throws in TS; mirror as null.
      Ok(doc.map(UpsertOutcome::Doc).unwrap_or(UpsertOutcome::Null))
    }
  }
}

/// `adapter.tables[name][key]` where a missing table throws like V8.
fn table_reading<'a>(schema: &'a RawSchema, name: &str, reading: &str) -> Result<Table<'a>> {
  table(schema, name)
    .ok_or_else(|| EngineError::new("TypeError", format!("Cannot read properties of undefined (reading '{reading}')")))
}

fn rows_of(objs: &[Obj]) -> Vec<Row> {
  objs.iter().cloned().map(obj_into_row).collect()
}

/// `obj[key]`, `undefined` when missing.
fn prop<'a>(obj: &'a Obj, key: &str) -> &'a JsVal {
  static UNDEFINED: JsVal = JsVal::Undefined;
  obj.get(key).unwrap_or(&UNDEFINED)
}

/// The statements after `transformForWrite` (the second `try` block of
/// `upsertRow`). Returns the inserted/updated main row, `None` when the
/// conditional upsert did not touch a row.
fn write_rows(
  exec: &mut Executor<'_>,
  schema: &RawSchema,
  opts: &AdapterOptions,
  args: &UpsertRowArgs,
  data: &JsVal,
  mut rti: RowToInsert,
) -> ExecResult<Option<Obj>> {
  let table_name = args.table_name.as_str();
  let t = require_table(schema, table_name)?;
  let is_update = args.operation == Operation::Update;
  let id = args.id.clone();

  // //////////////////////////////////
  // MAIN ROW
  // //////////////////////////////////
  let inserted_row: Obj = if is_update {
    let target = args.upsert_target.clone().unwrap_or_else(|| "id".into());
    let has_localized_data = !rti.locales.is_empty();
    let has_main_row_data = !rti.row.is_empty()
      && (has_localized_data || !rti.row.keys().all(|k| k == "updatedAt" || k == "createdAt"));
    if has_main_row_data {
      if id.truthy() {
        row_set(&mut rti.row, "id", id.clone());
      }
      let conflict = OnConflictDoUpdate { target, set: rti.row.clone(), where_: args.where_.clone() };
      let rows = exec.insert(t, std::slice::from_ref(&rti.row), Some(&conflict))?;
      match rows.into_iter().next() {
        Some(r) => r,
        None => return Ok(None),
      }
    } else {
      Obj::from([("id".to_string(), id.clone())])
    }
  } else {
    if opts.allow_id_on_create {
      let data_id = payload_sql_write::js::get(data, "id")?;
      if data_id.truthy() {
        row_set(&mut rti.row, "id", data_id.clone());
      }
    }
    let rows = exec.insert(t, std::slice::from_ref(&rti.row), None)?;
    // `[insertedRow] = ...` yields undefined for no rows; later `.id` reads crash.
    rows.into_iter().next().ok_or_else(|| {
      ExecError::Engine(EngineError::new("TypeError", "Cannot read properties of undefined (reading 'id')"))
    })?
  };
  let inserted_id = row_id(&inserted_row);
  // `id || insertedRow.id`
  let parent_id = if id.truthy() { id.clone() } else { inserted_id.clone() };

  let mut locales_to_insert: Vec<Row> = vec![];
  for (locale, mut locale_row) in std::mem::take(&mut rti.locales) {
    row_set(&mut locale_row, "_parentID", inserted_id.clone());
    row_set(&mut locale_row, "_locale", JsVal::str(locale));
    locales_to_insert.push(locale_row);
  }
  let with_parent = |rows: Vec<Obj>| -> Vec<Obj> {
    rows
      .into_iter()
      .map(|mut r| {
        js_insert(&mut r, "parent", inserted_id.clone());
        r
      })
      .collect()
  };
  let relations_to_insert = with_parent(std::mem::take(&mut rti.relationships));
  let texts_to_insert = with_parent(std::mem::take(&mut rti.texts));
  let numbers_to_insert = with_parent(std::mem::take(&mut rti.numbers));
  let mut selects_to_insert: IndexMap<String, Vec<Obj>> = IndexMap::new();
  for (select_table, rows) in std::mem::take(&mut rti.selects) {
    let rows = rows
      .into_iter()
      .map(|mut r| {
        if prop(&r, "parent").is_undefined() {
          js_insert(&mut r, "parent", inserted_id.clone());
        }
        r
      })
      .collect();
    js_insert(&mut selects_to_insert, select_table, rows);
  }
  let mut blocks_to_insert: IndexMap<String, Vec<NestedRowToInsert>> = IndexMap::new();
  for (block_table, rows) in std::mem::take(&mut rti.blocks) {
    for mut block_row in rows {
      row_set(&mut block_row.row, "_parentID", inserted_id.clone());
      if !blocks_to_insert.contains_key(&block_table) {
        js_insert(&mut blocks_to_insert, block_table.clone(), vec![]);
      }
      if row_value(&block_row.row, "uuid").truthy() {
        block_row.row.shift_remove("uuid");
      }
      blocks_to_insert.get_mut(&block_table).expect("inserted above").push(block_row);
    }
  }

  // //////////////////////////////////
  // INSERT LOCALES
  // //////////////////////////////////
  if !locales_to_insert.is_empty() {
    let locale_table_name = format!("{table_name}{}", opts.locales_suffix);
    if is_update {
      let lt = table_reading(schema, &locale_table_name, "_parentID")?;
      let w = eq(lt, "_parentID", &inserted_id)?;
      exec.delete_where(lt, Some(&w))?;
    }
    let lt = require_table(schema, &locale_table_name)?;
    exec.insert(lt, &locales_to_insert, None)?;
  }

  // //////////////////////////////////
  // INSERT RELATIONSHIPS
  // //////////////////////////////////
  let rels_table_name = format!("{table_name}{}", opts.relationships_suffix);
  if is_update {
    let mut rows: Vec<&Obj> = relations_to_insert.iter().collect();
    rows.extend(rti.relationships_to_delete.iter().filter(|r| !r.contains_key("itemToRemove")));
    delete_existing_rows_by_path(exec, schema, &rels_table_name, &inserted_id, &rows, "locale", "parent", "path")?;
  }
  if !relations_to_insert.is_empty() {
    let rt = require_table(schema, &rels_table_name)?;
    exec.insert(rt, &rows_of(&relations_to_insert), None)?;
  }

  // //////////////////////////////////
  // HANDLE RELATIONSHIP $push OPERATIONS
  // //////////////////////////////////
  if !rti.relationships_to_append.is_empty() {
    let rels = table(schema, &rels_table_name);
    let rels_has_locale = rels.map(|r| r.has_column("locale")).unwrap_or(false);
    let mut relationships: Vec<Obj> = rti
      .relationships_to_append
      .iter()
      .map(|rel| {
        let mut row = Obj::new();
        js_insert(&mut row, "parent", parent_id.clone());
        js_insert(&mut row, "path", prop(rel, "path").clone());
        if prop(rel, "locale").truthy() && rels_has_locale {
          js_insert(&mut row, "locale", prop(rel, "locale").clone());
        }
        if prop(rel, "relationTo").truthy() {
          js_insert(&mut row, format!("{}ID", to_js_string(prop(rel, "relationTo"))), prop(rel, "value").clone());
        }
        row
      })
      .collect();

    if let Some(rt) = rels {
      let mut conditions = vec![];
      for row in &relationships {
        let mut parts = vec![eq(rt, "parent", prop(row, "parent"))?, eq(rt, "path", prop(row, "path"))?];
        if !prop(row, "locale").is_undefined() && rt.has_column("locale") {
          parts.push(eq(rt, "locale", prop(row, "locale"))?);
        } else if rt.has_column("locale") {
          parts.push(is_null(rt, "locale")?);
        }
        for (key, value) in row {
          if key.ends_with("ID") && !value.is_nullish() && rt.has_column(key) {
            parts.push(eq(rt, key, value)?);
          }
        }
        if let Some(c) = and(parts) {
          conditions.push(c);
        }
      }

      let mut existing: Vec<Obj> = vec![];
      let keys: Vec<&str> = rt.columns().map(|(k, _)| k.as_str()).collect();
      if !conditions.is_empty() {
        let mut q = select_all(rt)?;
        if let Some(w) = or(conditions) {
          q.sql.push_str(" where ");
          q.sql.push_str(&w.sql);
          q.params.extend(w.params);
        }
        existing = exec.query_columns(rt, &keys, &q)?;
      }

      let max_q = SqlFragment::new(
        format!(
          "select {} from {} where {} = ? order by {} desc limit ?",
          ident(rt.column_name("order")?),
          ident(rt.name()),
          rt.col_ref("parent")?,
          rt.col_ref("order")?
        ),
        vec![crate::value::map_to_driver(rt.column_type("parent"), &parent_id)?, JsVal::Num(1.0)],
      );
      let max_rows = exec.query_columns(rt, &["order"], &max_q)?;
      let mut max_order = JsVal::Num(0.0);
      if let Some(first) = max_rows.first() {
        let v = prop(first, "order");
        if v.truthy() {
          max_order = v.clone();
        }
      }

      for (index, row) in relationships.iter_mut().enumerate() {
        // maxOrder + index + 1 (JS `+`: string concatenation when maxOrder is a string)
        let order = match &max_order {
          JsVal::Str(s) => JsVal::str(format!("{s}{index}1")),
          // a blob (`ArrayBuffer`) concatenates as its `toString()`
          JsVal::Arr(_) => JsVal::str(format!("[object ArrayBuffer]{index}1")),
          other => JsVal::Num(js_to_number(other) + index as f64 + 1.0),
        };
        js_insert(row, "order", order);
      }

      let to_insert: Vec<Obj> = relationships
        .into_iter()
        .filter(|new_row| {
          !existing.iter().any(|existing_row| {
            let mut matches = prop(existing_row, "parent").strict_eq(prop(new_row, "parent"))
              && prop(existing_row, "path").strict_eq(prop(new_row, "path"));
            if !prop(new_row, "locale").is_undefined() {
              matches = matches && prop(existing_row, "locale").strict_eq(prop(new_row, "locale"));
            }
            for key in new_row.keys() {
              if key.ends_with("ID") {
                matches = matches && prop(existing_row, key).strict_eq(prop(new_row, key));
              }
            }
            matches
          })
        })
        .collect();

      if !to_insert.is_empty() {
        exec.insert(rt, &rows_of(&to_insert), None)?;
      }
    }
  }

  // //////////////////////////////////
  // HANDLE RELATIONSHIP $remove OPERATIONS
  // //////////////////////////////////
  if rti.relationships_to_delete.iter().any(|r| r.contains_key("itemToRemove")) {
    if let Some(rt) = table(schema, &rels_table_name) {
      for rel in &rti.relationships_to_delete {
        let item = prop(rel, "itemToRemove");
        if !rel.contains_key("itemToRemove") || !item.truthy() {
          continue;
        }
        let mut conditions = vec![eq(rt, "parent", &parent_id)?, eq(rt, "path", prop(rel, "path"))?];
        if rt.has_column("locale") {
          if prop(rel, "locale").truthy() {
            conditions.push(eq(rt, "locale", prop(rel, "locale"))?);
          } else {
            conditions.push(is_null(rt, "locale")?);
          }
        }
        if let JsVal::Obj(item_obj) = item
          && item_obj.contains_key("relationTo")
        {
          let camel = format!("{}ID", to_js_string(prop(item_obj, "relationTo")));
          if rt.has_column(&camel) {
            conditions.push(eq(rt, &camel, prop(item_obj, "value"))?);
          }
        } else if prop(rel, "relationTo").truthy() {
          let camel = format!("{}ID", to_js_string(prop(rel, "relationTo")));
          if rt.has_column(&camel) {
            conditions.push(eq(rt, &camel, item)?);
          }
        }
        exec.delete_where(rt, and(conditions).as_ref())?;
      }
    }
  }

  // //////////////////////////////////
  // INSERT hasMany TEXTS
  // //////////////////////////////////
  let texts_table_name = format!("{table_name}_texts");
  if is_update {
    let mut rows: Vec<&Obj> = texts_to_insert.iter().collect();
    rows.extend(rti.texts_to_delete.iter());
    delete_existing_rows_by_path(exec, schema, &texts_table_name, &inserted_id, &rows, "locale", "parent", "path")?;
  }
  if !texts_to_insert.is_empty() {
    let tt = require_table(schema, &texts_table_name)?;
    exec.insert(tt, &rows_of(&texts_to_insert), None)?;
  }

  // //////////////////////////////////
  // INSERT hasMany NUMBERS
  // //////////////////////////////////
  let numbers_table_name = format!("{table_name}_numbers");
  if is_update {
    let mut rows: Vec<&Obj> = numbers_to_insert.iter().collect();
    rows.extend(rti.numbers_to_delete.iter());
    delete_existing_rows_by_path(exec, schema, &numbers_table_name, &inserted_id, &rows, "locale", "parent", "path")?;
  }
  if !numbers_to_insert.is_empty() {
    let nt = require_table(schema, &numbers_table_name)?;
    exec.insert(nt, &rows_of(&numbers_to_insert), None)?;
  }

  // //////////////////////////////////
  // INSERT BLOCKS
  // //////////////////////////////////
  if is_update {
    for block_table in &rti.blocks_to_delete {
      let bt = table_reading(schema, block_table, "_parentID")?;
      let w = eq(bt, "_parentID", &inserted_id)?;
      exec.delete_where(bt, Some(&w))?;
    }
  }

  let mut uuid_map: IndexMap<String, JsVal> = IndexMap::new();

  for (block_table, mut block_rows) in blocks_to_insert {
    let bt = require_table(schema, &block_table)?;
    let rows: Vec<Row> = block_rows.iter().map(|b| b.row.clone()).collect();
    let inserted_block_rows = exec.insert(bt, &rows, None)?;

    for (i, row) in inserted_block_rows.iter().enumerate() {
      if let Some(b) = block_rows.get_mut(i) {
        b.row = obj_into_row(row.clone());
      }
      record_uuid(&mut uuid_map, row);
    }

    let mut block_locale_rows: Vec<Row> = vec![];
    for block_row in &block_rows {
      for (locale, locale_data) in &block_row.locales {
        if !locale_data.is_empty() {
          let mut d = locale_data.clone();
          row_set(&mut d, "_parentID", row_value(&block_row.row, "id").clone());
          row_set(&mut d, "_locale", JsVal::str(locale.as_str()));
          block_locale_rows.push(d);
        }
      }
    }
    if !block_locale_rows.is_empty() {
      let blt = require_table(schema, &format!("{block_table}{}", opts.locales_suffix))?;
      exec.insert(blt, &block_locale_rows, None)?;
    }

    let arrays: Vec<IndexMap<String, Vec<NestedRowToInsert>>> = block_rows.into_iter().map(|b| b.arrays).collect();
    insert_arrays(exec, schema, opts, arrays, &inserted_block_rows, &mut uuid_map)?;
  }

  // //////////////////////////////////
  // INSERT ARRAYS RECURSIVELY
  // //////////////////////////////////
  if is_update {
    for array_table in rti.arrays.keys() {
      delete_existing_array_rows(exec, schema, array_table, &inserted_id)?;
    }
  }
  insert_arrays(
    exec,
    schema,
    opts,
    vec![std::mem::take(&mut rti.arrays), std::mem::take(&mut rti.arrays_to_push)],
    &[inserted_row.clone(), inserted_row.clone()],
    &mut uuid_map,
  )?;

  // //////////////////////////////////
  // INSERT hasMany SELECTS
  // //////////////////////////////////
  for (select_table, mut rows) in selects_to_insert {
    if is_update {
      let st = table_reading(schema, &select_table, "parent")?;
      let w = eq(st, "parent", &inserted_id)?;
      exec.delete_where(st, Some(&w))?;
    }
    if !uuid_map.is_empty() {
      for row in rows.iter_mut() {
        // `row.parent in arraysBlocksUUIDMap` (a plain object: inherited keys count)
        let parent_key = to_js_string(prop(row, "parent"));
        if let Some(mapped) = uuid_map.get(&parent_key) {
          js_insert(row, "parent", mapped.clone());
        } else if parent_key == "__proto__" {
          js_insert(row, "parent", JsVal::obj(Obj::new()));
        } else if OBJECT_PROTOTYPE_KEYS.contains(&parent_key.as_str()) {
          // inherited Object.prototype method
          js_insert(row, "parent", JsVal::Fn(0));
        }
      }
    }
    if !rows.is_empty() {
      let st = require_table(schema, &select_table)?;
      exec.insert(st, &rows_of(&rows), None)?;
    }
  }

  Ok(Some(inserted_row))
}

fn select_all(t: Table<'_>) -> Result<SqlFragment> {
  let cols = t.columns().map(|(k, _)| t.column_name(k).map(ident)).collect::<Result<Vec<_>>>()?;
  Ok(SqlFragment::raw(format!("select {} from {}", cols.join(", "), ident(t.name()))))
}

/// `if (typeof row._uuid === 'string' && (typeof row.id === 'string' || typeof row.id === 'number')) uuidMap[row._uuid] = row.id`
fn record_uuid(uuid_map: &mut IndexMap<String, JsVal>, row: &Obj) {
  if let (JsVal::Str(uuid), id @ (JsVal::Str(_) | JsVal::Num(_))) = (prop(row, "_uuid"), prop(row, "id")) {
    // assigning a primitive to `__proto__` is a no-op
    if &**uuid != "__proto__" {
      js_insert(uuid_map, uuid.to_string(), id.clone());
    }
  }
}

/// `deleteExistingArrayRows` (packages/drizzle/src/upsertRow/deleteExistingArrayRows.ts).
pub fn delete_existing_array_rows(exec: &mut Executor<'_>, schema: &RawSchema, table_name: &str, parent_id: &JsVal) -> ExecResult<()> {
  let t = table_reading(schema, table_name, "_parentID")?;
  let w = and(vec![eq(t, "_parentID", parent_id)?]);
  exec.delete_where(t, w.as_ref())
}

/// `deleteExistingRowsByPath` (packages/drizzle/src/upsertRow/deleteExistingRowsByPath.ts).
#[allow(clippy::too_many_arguments)]
pub fn delete_existing_rows_by_path(
  exec: &mut Executor<'_>,
  schema: &RawSchema,
  table_name: &str,
  parent_id: &JsVal,
  rows: &[&Obj],
  locale_column_name: &str,
  parent_column_name: &str,
  path_column_name: &str,
) -> ExecResult<()> {
  let mut localized: IndexSet<String> = IndexSet::new();
  let mut plain: IndexSet<String> = IndexSet::new();
  for row in rows {
    if let JsVal::Str(path) = prop(row, path_column_name) {
      if matches!(prop(row, locale_column_name), JsVal::Str(_)) {
        localized.insert(path.to_string());
      } else {
        plain.insert(path.to_string());
      }
    }
  }
  for paths in [localized, plain] {
    if paths.is_empty() {
      continue;
    }
    let t = table_reading(schema, table_name, parent_column_name)?;
    let mut constraints = vec![eq(t, parent_column_name, parent_id)?];
    if !path_column_name.is_empty() {
      let values: Vec<JsVal> = paths.into_iter().map(JsVal::str).collect();
      constraints.push(in_array(t, path_column_name, &values)?);
    }
    exec.delete_where(t, and(constraints).as_ref())?;
  }
  Ok(())
}

struct TableRows {
  arrays: Vec<IndexMap<String, Vec<NestedRowToInsert>>>,
  /// Locale rows plus the `_uuid` used by `_getParentID` when the array row had no id.
  locales: Vec<(Row, Option<JsVal>)>,
  rows: Vec<Row>,
}

/// `insertArrays` (packages/drizzle/src/upsertRow/insertArrays.ts).
pub fn insert_arrays(
  exec: &mut Executor<'_>,
  schema: &RawSchema,
  opts: &AdapterOptions,
  arrays: Vec<IndexMap<String, Vec<NestedRowToInsert>>>,
  parent_rows: &[Obj],
  uuid_map: &mut IndexMap<String, JsVal>,
) -> ExecResult<()> {
  let mut rows_by_table: IndexMap<String, TableRows> = IndexMap::new();

  for (parent_row_index, arrays_by_table) in arrays.into_iter().enumerate() {
    if arrays_by_table.is_empty() {
      continue;
    }
    for (table_name, array_rows) in arrays_by_table {
      if !rows_by_table.contains_key(&table_name) {
        js_insert(&mut rows_by_table, table_name.clone(), TableRows { arrays: vec![], locales: vec![], rows: vec![] });
      }
      let entry = rows_by_table.get_mut(&table_name).expect("inserted above");
      let parent_id = parent_rows.get(parent_row_index).map(row_id).ok_or_else(|| {
        ExecError::Engine(EngineError::new("TypeError", "Cannot read properties of undefined (reading 'id')"))
      })?;
      for mut array_row in array_rows {
        if !array_row.arrays.is_empty() {
          entry.arrays.push(std::mem::take(&mut array_row.arrays));
        }
        row_set(&mut array_row.row, "_parentID", parent_id.clone());
        let row_id_value = row_value(&array_row.row, "id").clone();
        for (locale, mut locale_data) in array_row.locales {
          row_set(&mut locale_data, "_parentID", row_id_value.clone());
          row_set(&mut locale_data, "_locale", JsVal::str(locale));
          let getter = if row_id_value.truthy() { None } else { Some(row_value(&array_row.row, "_uuid").clone()) };
          entry.locales.push((locale_data, getter));
        }
        entry.rows.push(array_row.row);
      }
    }
  }

  for (table_name, mut group) in rows_by_table {
    let mut inserted_rows: Option<Vec<Obj>> = None;
    if !group.rows.is_empty() {
      let t = require_table(schema, &table_name)?;
      let rows = exec.insert(t, &group.rows, None)?;
      for row in &rows {
        record_uuid(uuid_map, row);
      }
      inserted_rows = Some(rows);
    }

    let locale_table_name = format!("{table_name}{}", opts.locales_suffix);
    if let Some(lt) = table(schema, &locale_table_name)
      && !group.locales.is_empty()
    {
      if !row_value(&group.locales[0].0, "_parentID").truthy() {
        for (locale_row, getter) in group.locales.iter_mut() {
          if let Some(uuid) = getter.take() {
            let found = inserted_rows
              .as_ref()
              .and_then(|rows| rows.iter().find(|r| prop(r, "_uuid").strict_eq(&uuid)))
              .ok_or_else(|| {
                ExecError::Engine(EngineError::new(
                  "TypeError",
                  "Cannot destructure property 'id' of 'rows.find(...)' as it is undefined.",
                ))
              })?;
            row_set(locale_row, "_parentID", row_id(found));
          }
        }
      }
      let rows: Vec<Row> = group.locales.into_iter().map(|(r, _)| r).collect();
      exec.insert(lt, &rows, None)?;
    }

    if !group.arrays.is_empty() {
      let parents = inserted_rows.unwrap_or_default();
      insert_arrays(exec, schema, opts, group.arrays, &parents, uuid_map)?;
    }
  }
  Ok(())
}
