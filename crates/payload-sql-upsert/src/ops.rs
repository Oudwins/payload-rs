//! Write-side adapter operations driving `upsertRow`:
//! packages/drizzle/src/{create,createGlobal,createVersion,createGlobalVersion,
//! updateOne,updateMany,updateGlobal,updateVersion,updateGlobalVersion,
//! updateJobs,upsert,deleteOne,deleteMany,deleteVersions}.ts.
//!
//! Query building (`buildQuery`, `selectDistinct`), `findMany` / `findFirst`
//! and the read transform belong to other modules; their results are passed
//! in as [`BuiltQuery`] values or produced lazily through [`OpsHost`].

use payload_engine::error::{EngineError, Result};
use payload_engine::js::{JsVal, Obj};
use payload_engine::sql::schema::RawSchema;
use payload_sql_write::js::{js_insert, set};

use crate::sql::{Executor, Returning, SqlFragment, and, build_update, eq, ident, in_array, is_null, or, require_table};
use crate::upsert_row::{
  AdapterOptions, IgnoreResult, Operation, UpsertHost, UpsertOutcome, UpsertRowArgs, WriteContext, run_should_use,
  run_transform, upsert_row,
};
use crate::value::{get_defined, row_value};

/// Result of `buildQuery({ where, sort, ... })` from the query module.
#[derive(Clone, Debug, Default)]
pub struct BuiltQuery {
  /// `where` rendered with `dialect.sqlToQuery`.
  pub where_: Option<SqlFragment>,
  /// `joins.length`
  pub joins: usize,
  /// `orderBy` rendered as the list after ` order by ` (e.g. `"posts"."created_at" desc`).
  pub order_by: Option<SqlFragment>,
}

/// Lazily evaluated pieces owned by other modules.
pub trait OpsHost {
  /// `selectDistinct({ joins, where, ... })` ids; only called when `joins > 0`.
  fn select_distinct_ids(&mut self, exec: &mut Executor<'_>, query: &BuiltQuery, limit: Option<i64>) -> Result<Vec<JsVal>>;

  /// `findMany({ ... }).docs` for the operation (deleteMany with joins,
  /// deleteVersions, updateJobs).
  fn find_many(&mut self, exec: &mut Executor<'_>) -> Result<Vec<JsVal>>;

  /// deleteOne: `db.query[tableName].findFirst(...)` — by `distinct_id` when
  /// `selectDistinct` found one, otherwise by `where` with
  /// `buildFindManyArgs(select)`. Returns the raw drizzle row.
  fn find_first_to_delete(
    &mut self,
    exec: &mut Executor<'_>,
    distinct_id: Option<&JsVal>,
    where_: Option<&SqlFragment>,
  ) -> Result<Option<JsVal>>;

  /// deleteOne: read `transform` of the raw row (only when `returning !== false`).
  fn transform_doc(&mut self, doc: &JsVal) -> Result<JsVal>;
}

/// Common arguments of the write operations.
#[derive(Clone, Debug, Default)]
pub struct WriteArgs {
  /// `tableName` resolved through `tableNameMap`.
  pub table_name: String,
  pub collection_slug: Option<String>,
  pub global_slug: Option<String>,
  /// `returning === false`
  pub returning_false: bool,
  pub value_must_be_unique: Option<String>,
  pub following_fields_invalid: Option<String>,
  /// `new Date().toISOString()` override for deterministic replays.
  pub now: Option<String>,
}

impl WriteArgs {
  fn upsert_args(&self, operation: Operation) -> UpsertRowArgs {
    let mut a = UpsertRowArgs::new(self.table_name.clone(), operation);
    a.collection_slug = self.collection_slug.clone();
    a.global_slug = self.global_slug.clone();
    a.value_must_be_unique = self.value_must_be_unique.clone();
    a.following_fields_invalid = self.following_fields_invalid.clone();
    a.now = self.now.clone();
    a.ignore_result = if self.returning_false { IgnoreResult::Yes } else { IgnoreResult::No };
    a
  }
}

/// The engine-level arguments shared by every upsert-driving operation.
pub struct Env<'e, 'c> {
  pub exec: &'e mut Executor<'c>,
  pub schema: &'e RawSchema,
  pub opts: &'e AdapterOptions,
  pub ctx: WriteContext<'e>,
  pub host: &'e mut dyn UpsertHost,
}

impl Env<'_, '_> {
  fn upsert(&mut self, args: &UpsertRowArgs, data: &mut JsVal) -> Result<UpsertOutcome> {
    upsert_row(self.exec, self.schema, self.opts, &self.ctx, self.host, args, data)
  }
}

fn outcome_or_null(returning_false: bool, outcome: UpsertOutcome) -> JsVal {
  if returning_false { JsVal::Null } else { outcome.to_js() }
}

/// `create` (packages/drizzle/src/create.ts)
pub fn create(env: &mut Env<'_, '_>, args: &WriteArgs, custom_id: JsVal, data: &mut JsVal) -> Result<JsVal> {
  let mut a = args.upsert_args(Operation::Create);
  a.custom_id = custom_id;
  let outcome = env.upsert(&a, data)?;
  Ok(outcome_or_null(args.returning_false, outcome))
}

/// `result.globalType = slug`
fn set_global_type(mut result: JsVal, slug: &str) -> Result<JsVal> {
  set(&mut result, "globalType", JsVal::str(slug))?;
  Ok(result)
}

/// `createGlobal` (packages/drizzle/src/createGlobal.ts)
pub fn create_global(env: &mut Env<'_, '_>, args: &WriteArgs, slug: &str, data: &mut JsVal) -> Result<JsVal> {
  set(data, "createdAt", JsVal::str(args.now.clone().unwrap_or_else(crate::upsert_row::now_iso)))?;
  let mut a = args.upsert_args(Operation::Create);
  a.global_slug = Some(slug.to_string());
  let outcome = env.upsert(&a, data)?;
  if args.returning_false {
    return Ok(JsVal::Null);
  }
  set_global_type(outcome.to_js(), slug)
}

/// Inputs of `createVersion` / `createGlobalVersion` (`undefined` when not passed).
#[derive(Clone, Debug, Default)]
pub struct CreateVersionArgs {
  pub autosave: JsVal,
  pub created_at: JsVal,
  /// Collection versions only.
  pub parent: JsVal,
  pub published_locale: JsVal,
  pub snapshot: JsVal,
  pub updated_at: JsVal,
  pub version_data: JsVal,
  /// `hasDraftsEnabled(collection | global)`
  pub drafts_enabled: bool,
}

/// `{ ...versionData }`
fn spread(value: &JsVal) -> Obj {
  match value {
    JsVal::Obj(o) => (**o).clone(),
    JsVal::Arr(a) => a.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
    _ => Obj::new(),
  }
}

/// `createVersion` (packages/drizzle/src/createVersion.ts)
pub fn create_version(env: &mut Env<'_, '_>, args: &WriteArgs, version: &CreateVersionArgs) -> Result<JsVal> {
  let mut version_data = spread(&version.version_data);
  if version_data.get("id").is_some_and(JsVal::truthy) {
    version_data.shift_remove("id");
  }
  let mut data = Obj::new();
  data.insert("autosave".into(), version.autosave.clone());
  data.insert("createdAt".into(), version.created_at.clone());
  data.insert("latest".into(), JsVal::Bool(true));
  data.insert("parent".into(), version.parent.clone());
  data.insert("publishedLocale".into(), version.published_locale.clone());
  data.insert("snapshot".into(), version.snapshot.clone());
  data.insert("updatedAt".into(), version.updated_at.clone());
  data.insert("version".into(), JsVal::obj(version_data));
  let mut data = JsVal::obj(data);

  let mut a = args.upsert_args(Operation::Create);
  a.ignore_result = if args.returning_false { IgnoreResult::IdOnly } else { IgnoreResult::No };
  let result = env.upsert(&a, &mut data)?.to_js();

  if version.drafts_enabled {
    let t = require_table(env.schema, &args.table_name)?;
    let result_id = payload_sql_write::js::get(&result, "id")?.clone();
    let result_updated_at = payload_sql_write::js::get(&result, "updatedAt")?;
    let updated_at = if result_updated_at.truthy() { result_updated_at.clone() } else { version.updated_at.clone() };
    let q = SqlFragment::new(
      format!(
        "\n        UPDATE {}\n        SET latest = false\n        WHERE {} != ?\n          AND {} = ?\n          AND {} < ?\n      ",
        ident(t.name()),
        t.col_ref("id")?,
        t.col_ref("parent")?,
        t.col_ref("updatedAt")?
      ),
      vec![result_id, version.parent.clone(), updated_at],
    );
    env.exec.execute(&q).map_err(|e| e.into_engine_error())?;
  }

  Ok(if args.returning_false { JsVal::Null } else { result })
}

/// `createGlobalVersion` (packages/drizzle/src/createGlobalVersion.ts)
pub fn create_global_version(env: &mut Env<'_, '_>, args: &WriteArgs, version: &CreateVersionArgs) -> Result<JsVal> {
  let mut data = Obj::new();
  data.insert("autosave".into(), version.autosave.clone());
  data.insert("createdAt".into(), version.created_at.clone());
  data.insert("latest".into(), JsVal::Bool(true));
  data.insert("publishedLocale".into(), version.published_locale.clone());
  data.insert("snapshot".into(), version.snapshot.clone());
  data.insert("updatedAt".into(), version.updated_at.clone());
  data.insert("version".into(), version.version_data.clone());
  let mut data = JsVal::obj(data);

  let mut a = args.upsert_args(Operation::Create);
  a.ignore_result = if args.returning_false { IgnoreResult::IdOnly } else { IgnoreResult::No };
  let result = env.upsert(&a, &mut data)?.to_js();

  if version.drafts_enabled {
    let t = require_table(env.schema, &args.table_name)?;
    let result_id = payload_sql_write::js::get(&result, "id")?.clone();
    let q = SqlFragment::new(
      format!("\n          UPDATE {}\n          SET latest = false\n          WHERE {} != ?;\n        ", ident(t.name()), t.col_ref("id")?),
      vec![result_id],
    );
    env.exec.execute(&q).map_err(|e| e.into_engine_error())?;
  }

  Ok(if args.returning_false { JsVal::Null } else { result })
}

/// Inputs of `updateOne` / `upsert`.
#[derive(Clone, Debug, Default)]
pub struct UpdateOneArgs {
  pub id: JsVal,
  /// `buildQuery({ where })`; only used when `id` is falsy.
  pub query: BuiltQuery,
  /// Whether a `where` argument was passed.
  pub has_where_arg: bool,
  /// `options.upsert`
  pub upsert: bool,
  /// `options.atomic === true`
  pub atomic: bool,
}

/// `select "id" from "t" [where ...] [order by ...] [limit ?]`
fn select_ids(
  exec: &mut Executor<'_>,
  schema: &RawSchema,
  table_name: &str,
  where_: Option<&SqlFragment>,
  order_by: Option<&SqlFragment>,
  limit: Option<f64>,
) -> Result<Vec<JsVal>> {
  let t = require_table(schema, table_name)?;
  let mut q = SqlFragment::raw(format!("select {} from {}", ident(t.column_name("id")?), ident(t.name())));
  if let Some(w) = where_ {
    q.sql.push_str(" where ");
    q.sql.push_str(&w.sql);
    q.params.extend(w.params.iter().cloned());
  }
  if let Some(o) = order_by {
    q.sql.push_str(" order by ");
    q.sql.push_str(&o.sql);
    q.params.extend(o.params.iter().cloned());
  }
  if let Some(l) = limit {
    q.sql.push_str(" limit ?");
    q.params.push(JsVal::Num(l));
  }
  let rows = exec.query_columns(t, &["id"], &q).map_err(|e| e.into_engine_error())?;
  Ok(rows.into_iter().map(|r| r.get("id").cloned().unwrap_or_default()).collect())
}

/// `updateOne` (packages/drizzle/src/updateOne.ts); `upsert` (upsert.ts) is
/// `updateOne` with `upsert: true`.
pub fn update_one(
  env: &mut Env<'_, '_>,
  ops_host: &mut dyn OpsHost,
  args: &WriteArgs,
  update: &UpdateOneArgs,
  data: &mut JsVal,
) -> Result<JsVal> {
  let mut id_to_update = update.id.clone();
  let mut where_to_update: Option<SqlFragment> = None;

  if !id_to_update.truthy() {
    let q = &update.query;
    where_to_update = if q.joins == 0 { q.where_.clone() } else { None };

    if update.atomic {
      if !run_should_use(&env.ctx, env.host, data)? {
        return Err(EngineError::new("Error", "Atomic where updates only support fields stored on the main table"));
      }
      let rti = run_transform(&env.ctx, env.host, data, true, "", &args.table_name)?;
      if !rti.arrays_to_push.is_empty() {
        return Err(EngineError::new("Error", "Atomic where updates do not support array operations"));
      }
      let t = require_table(env.schema, &args.table_name)?;
      let sql = build_update(t, &rti.row, q.where_.as_ref(), &Returning::All)?;
      let keys: Vec<&str> = t.columns().map(|(k, _)| k.as_str()).collect();
      let docs = env.exec.query_columns(t, &keys, &sql).map_err(|e| e.into_engine_error())?;
      return match docs.into_iter().next() {
        None => Ok(JsVal::Null),
        Some(doc) => env.host.transform_row(doc),
      };
    }

    let distinct = if q.joins > 0 { ops_host.select_distinct_ids(env.exec, q, Some(1))? } else { vec![] };
    if let Some(first) = distinct.first().filter(|v| v.truthy()) {
      id_to_update = first.clone();
    } else if update.has_where_arg && q.joins == 0 {
      id_to_update = select_ids(env.exec, env.schema, &args.table_name, q.where_.as_ref(), None, Some(1.0))?
        .into_iter()
        .next()
        .unwrap_or_default();
    }
  }

  if !id_to_update.truthy() && !update.upsert {
    return Ok(JsVal::Null);
  }

  let mut a = args.upsert_args(Operation::Update);
  a.id = id_to_update;
  a.where_ = where_to_update;
  let outcome = env.upsert(&a, data)?;
  Ok(outcome_or_null(args.returning_false, outcome))
}

/// `updateMany` (packages/drizzle/src/updateMany.ts)
pub fn update_many(
  env: &mut Env<'_, '_>,
  ops_host: &mut dyn OpsHost,
  args: &WriteArgs,
  query: &BuiltQuery,
  has_where_arg: bool,
  limit: &JsVal,
  data: &mut JsVal,
) -> Result<JsVal> {
  let mut ids: Vec<JsVal> = vec![];
  let distinct = if query.joins > 0 { ops_host.select_distinct_ids(env.exec, query, None)? } else { vec![] };
  if distinct.first().is_some_and(JsVal::truthy) {
    ids = distinct;
  } else if has_where_arg && query.joins == 0 {
    // `typeof limit === 'number' && limit > 0`
    let limit = limit.as_num().filter(|l| *l > 0.0);
    ids = select_ids(env.exec, env.schema, &args.table_name, query.where_.as_ref(), query.order_by.as_ref(), limit)?;
  }
  if ids.is_empty() {
    return Ok(JsVal::arr(vec![]));
  }
  let mut results = vec![];
  for id in ids {
    let mut a = args.upsert_args(Operation::Update);
    a.id = id;
    let outcome = env.upsert(&a, data)?;
    results.push(outcome.to_js());
  }
  Ok(if args.returning_false { JsVal::Null } else { JsVal::arr(results) })
}

/// `updateGlobal` (packages/drizzle/src/updateGlobal.ts)
pub fn update_global(env: &mut Env<'_, '_>, args: &WriteArgs, slug: &str, data: &mut JsVal) -> Result<JsVal> {
  // `db.query[tableName].findFirst({})`
  let existing = select_ids(env.exec, env.schema, &args.table_name, None, None, Some(1.0))?.into_iter().next();
  let mut a = match existing {
    Some(id) => {
      let mut a = args.upsert_args(Operation::Update);
      a.id = id;
      a
    }
    None => args.upsert_args(Operation::Create),
  };
  a.global_slug = Some(slug.to_string());
  let outcome = env.upsert(&a, data)?;
  if args.returning_false {
    return Ok(JsVal::Null);
  }
  set_global_type(outcome.to_js(), slug)
}

/// `updateVersion` / `updateGlobalVersion`
/// (packages/drizzle/src/updateVersion.ts, updateGlobalVersion.ts). `where_`
/// is `buildQuery({ where: whereArg || { id: { equals: id } } }).where`.
pub fn update_version(
  env: &mut Env<'_, '_>,
  args: &WriteArgs,
  id: JsVal,
  where_: Option<SqlFragment>,
  version_data: &mut JsVal,
) -> Result<JsVal> {
  let mut a = args.upsert_args(Operation::Update);
  a.id = id;
  a.where_ = where_;
  let outcome = env.upsert(&a, version_data)?;
  Ok(outcome_or_null(args.returning_false, outcome))
}

fn is_initial_job_claim(data: &JsVal) -> bool {
  let Some(m) = data.as_obj() else { return false };
  matches!(data.get("processingToken"), JsVal::Str(_))
    && matches!(data.get("processingUntil"), JsVal::Str(_))
    && m.keys().all(|k| k == "processingToken" || k == "processingUntil" || k == "updatedAt")
}

/// `{ ...job, ...data }`
fn merge(job: &JsVal, data: &JsVal) -> JsVal {
  let mut m = spread(job);
  for (k, v) in spread(data) {
    js_insert(&mut m, k, v);
  }
  JsVal::obj(m)
}

/// `updateJobs` (packages/drizzle/src/updateJobs.ts). `id` and `now`
/// (`new Date().toISOString()` of the claim) are explicit.
pub fn update_jobs(
  env: &mut Env<'_, '_>,
  ops_host: &mut dyn OpsHost,
  args: &WriteArgs,
  id: JsVal,
  data: &mut JsVal,
) -> Result<JsVal> {
  // `!data?.log?.length && !(data.log && typeof data.log === 'object' && '$push' in data.log)`
  let log = data.get("log").clone();
  let log_len_truthy = match &log {
    JsVal::Arr(a) => !a.is_empty(),
    JsVal::Str(s) => !s.is_empty(),
    JsVal::Obj(o) => o.get("length").is_some_and(JsVal::truthy),
    _ => false,
  };
  let log_push = matches!(&log, JsVal::Obj(o) if o.contains_key("$push"));
  if !log_len_truthy && !log_push {
    payload_sql_write::js::delete(data, "log")?;
  }

  let use_optimized = run_should_use(&env.ctx, env.host, data)?;

  if use_optimized && id.truthy() {
    let mut a = args.upsert_args(Operation::Update);
    a.id = id;
    a.collection_slug = Some("payload-jobs".into());
    let outcome = env.upsert(&a, data)?;
    return Ok(if args.returning_false { JsVal::Null } else { JsVal::arr(vec![outcome.to_js()]) });
  }

  let jobs = ops_host.find_many(env.exec)?;
  if jobs.is_empty() {
    return Ok(JsVal::arr(vec![]));
  }

  if is_initial_job_claim(data) {
    let t = require_table(env.schema, &args.table_name)?;
    let now = args.now.clone().unwrap_or_else(crate::upsert_row::now_iso);
    let mut rti = run_transform(&env.ctx, env.host, data, true, "", &args.table_name)?;
    if get_defined(&rti.row, "updatedAt").is_none() || row_value(&rti.row, "updatedAt").is_null() {
      rti.row.shift_remove("updatedAt");
    }
    let job_ids: Vec<JsVal> = jobs.iter().map(|j| j.get("id").clone()).collect();
    let lte = SqlFragment::new(format!("{} <= ?", t.col_ref("processingUntil")?), vec![JsVal::str(now)]);
    let where_ = and(vec![
      in_array(t, "id", &job_ids)?,
      or(vec![is_null(t, "processingUntil")?, lte]).unwrap_or_default(),
    ]);
    let q = build_update(t, &rti.row, where_.as_ref(), &Returning::Columns(vec!["id".into()]))?;
    let claimed = env.exec.query_columns(t, &["id"], &q).map_err(|e| e.into_engine_error())?;
    if args.returning_false {
      return Ok(JsVal::Null);
    }
    let claimed_ids: Vec<JsVal> = claimed.into_iter().map(|r| r.get("id").cloned().unwrap_or_default()).collect();
    let out = jobs
      .iter()
      .filter(|job| claimed_ids.iter().any(|c| same_value_zero(c, job.get("id"))))
      .map(|job| merge(job, data))
      .collect();
    return Ok(JsVal::arr(out));
  }

  let mut results = vec![];
  for job in &jobs {
    let mut a = args.upsert_args(Operation::Update);
    a.id = job.get("id").clone();
    a.collection_slug = Some("payload-jobs".into());
    let outcome = if use_optimized {
      env.upsert(&a, data)?
    } else {
      let mut update_data = merge(job, data);
      env.upsert(&a, &mut update_data)?
    };
    results.push(outcome.to_js());
  }
  Ok(if args.returning_false { JsVal::Null } else { JsVal::arr(results) })
}

/// `Set#has` (SameValueZero).
fn same_value_zero(a: &JsVal, b: &JsVal) -> bool {
  match (a, b) {
    (JsVal::Num(x), JsVal::Num(y)) => x == y || (x.is_nan() && y.is_nan()),
    _ => a.strict_eq(b),
  }
}

/// `deleteOne` (packages/drizzle/src/deleteOne.ts)
pub fn delete_one(
  exec: &mut Executor<'_>,
  schema: &RawSchema,
  ops_host: &mut dyn OpsHost,
  args: &WriteArgs,
  query: &BuiltQuery,
) -> Result<JsVal> {
  let distinct = if query.joins > 0 { ops_host.select_distinct_ids(exec, query, Some(1))? } else { vec![] };
  let distinct_id = distinct.first().filter(|v| v.truthy());
  let doc = ops_host.find_first_to_delete(exec, distinct_id, query.where_.as_ref())?;
  let Some(doc) = doc.filter(JsVal::truthy) else { return Ok(JsVal::Null) };
  let result = if args.returning_false { JsVal::Null } else { ops_host.transform_doc(&doc)? };
  let t = require_table(schema, &args.table_name)?;
  let w = eq(t, "id", payload_sql_write::js::get(&doc, "id")?)?;
  exec.delete_where(t, Some(&w)).map_err(|e| e.into_engine_error())?;
  Ok(result)
}

/// `deleteMany` (packages/drizzle/src/deleteMany.ts)
pub fn delete_many(
  exec: &mut Executor<'_>,
  schema: &RawSchema,
  ops_host: &mut dyn OpsHost,
  args: &WriteArgs,
  query: &BuiltQuery,
) -> Result<()> {
  let t = require_table(schema, &args.table_name)?;
  let mut where_ = query.where_.clone();
  if query.joins > 0 {
    let docs = ops_host.find_many(exec)?;
    let ids: Vec<JsVal> = docs.iter().map(|d| d.get("id").clone()).collect();
    where_ = Some(in_array(t, "id", &ids)?);
  }
  exec.delete_where(t, where_.as_ref()).map_err(|e| e.into_engine_error())
}

/// `deleteVersions` (packages/drizzle/src/deleteVersions.ts). Returns the
/// `findMany` docs.
pub fn delete_versions(
  exec: &mut Executor<'_>,
  schema: &RawSchema,
  ops_host: &mut dyn OpsHost,
  args: &WriteArgs,
) -> Result<JsVal> {
  let docs = ops_host.find_many(exec)?;
  let ids: Vec<JsVal> = docs.iter().map(|d| d.get("id").clone()).collect();
  if !ids.is_empty() {
    let t = require_table(schema, &args.table_name)?;
    let w = in_array(t, "id", &ids)?;
    exec.delete_where(t, Some(&w)).map_err(|e| e.into_engine_error())?;
  }
  Ok(JsVal::arr(docs))
}
