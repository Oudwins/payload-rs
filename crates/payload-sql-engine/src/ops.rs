//! The adapter methods (packages/drizzle/src/*.ts). Read operations are ported here; the write
//! operations are thin wrappers around `payload_sql_upsert::ops` that resolve their inputs
//! (`buildQuery`, version fields, table names) the way the TS operation does.

use payload_engine::error::{EngineError, Result};
use payload_engine::fields::has_drafts_enabled;
use payload_engine::js::{JsVal, Obj};
use payload_engine::strings::to_snake_case;
use payload_sql_find::context::FindContext;
use payload_sql_find::find_many::FindManyResult;
use payload_sql_find::query::SqlQueryBuilder;
use payload_sql_query::render::{count_select, find_distinct_select};
use payload_sql_query::sql::Expr;
use payload_sql_query::{QueryAdapter, WhereVal};
use payload_sql_read::{ReadAdapter, schema_block_index};
use payload_sql_upsert::ops::{self as wops, CreateVersionArgs, Env, UpdateOneArgs, WriteArgs};
use payload_sql_upsert::value::json_parse;
use payload_sql_upsert::{IgnoreResult, Operation, UpsertRowArgs, WriteContext, upsert_row};
use payload_sql_write::SchemaWriteAdapter;
use payload_sql_write::js::{js_insert, set, to_js_string};

use crate::{CallEnv, CallOutput, EngineOptions, SqliteEngine};
use crate::fields::{
  collection_config, field_by_path, global_config, snake_slug, version_collection_fields, version_global_fields,
};
use crate::hosts::{Call, FindSpec, Ops, ReadBack, built_query};

pub(crate) fn dispatch(
  engine: &SqliteEngine,
  options: &EngineOptions,
  method: &str,
  args: &JsVal,
  env: &CallEnv<'_>,
) -> Result<CallOutput> {
  let root = &engine.root;
  let config = root.get("config");
  let collections = root.get("collections");
  let blocks = root.get("blocks");
  let qa = QueryAdapter::new(&engine.schema, config, collections, blocks, options.query.clone());
  let qb = SqlQueryBuilder::new(&qa);
  let find = FindContext {
    schema: &engine.drizzle,
    table_name_map: &engine.schema.table_name_map,
    config,
    collections,
    blocks,
    block_table_name_index: &engine.schema.block_table_name_index,
    options: &options.query,
    query: &qb,
  };
  let block_index = schema_block_index(&engine.schema.block_table_name_index);
  let read = ReadAdapter {
    config,
    blocks,
    collections,
    table_name_map: &engine.schema.table_name_map,
    blocks_as_json: options.schema.blocks_as_json,
    block_table_name_index: &block_index,
  };
  let write = SchemaWriteAdapter {
    schema: &engine.schema,
    config,
    name: &options.query.name,
    blocks_as_json: options.schema.blocks_as_json,
  };
  let call = Call {
    engine,
    root,
    qa: &qa,
    find: &find,
    read: &read,
    write: &write,
    conn: env.conn,
    raw: env.raw,
    host: env.host,
    steps: env.steps,
    options,
    mutations: Default::default(),
  };

  let result = run(&call, method, args).map_err(untranslated)?;
  Ok(CallOutput { result, mutations: call.mutations.into_inner() })
}

/// `handleUpsertError`'s `ValidationError` without `errors[].message`: TS rebuilds the error with
/// `req.t('error:valueMustBeUnique')` (ENGINE_CONTRACT.md "Errors"), since `req.t` stays in TS.
fn untranslated(mut error: EngineError) -> EngineError {
  if error.name != "ValidationError" {
    return error;
  }
  if let Some(errors) = error.data.as_mut().and_then(|d| d.get_mut("errors")).and_then(|e| e.as_array_mut()) {
    for entry in errors.iter_mut().filter_map(|e| e.as_object_mut()) {
      entry.shift_remove("message");
    }
  }
  error
}

fn run(call: &Call<'_>, method: &str, args: &JsVal) -> Result<JsVal> {
  match method {
    "find" => find_op(call, args),
    "findOne" => find_one(call, args),
    "findGlobal" => find_global(call, args),
    "findVersions" => find_versions(call, args),
    "findGlobalVersions" => find_global_versions(call, args),
    "queryDrafts" => query_drafts(call, args),
    "count" => count(call, args, Entity::Collection),
    "countVersions" => count(call, args, Entity::CollectionVersions),
    "countGlobalVersions" => count(call, args, Entity::GlobalVersions),
    "findDistinct" => find_distinct(call, args),
    "create" => create(call, args),
    "createGlobal" => create_global(call, args),
    "createVersion" => create_version(call, args),
    "createGlobalVersion" => create_global_version(call, args),
    "updateOne" => update_one(call, args, false),
    "upsert" => update_one(call, args, true),
    "updateMany" => update_many(call, args),
    "updateGlobal" => update_global(call, args),
    "updateVersion" => update_version(call, args, Entity::CollectionVersions),
    "updateGlobalVersion" => update_version(call, args, Entity::GlobalVersions),
    "updateJobs" => update_jobs(call, args),
    "deleteOne" => delete_one(call, args),
    "deleteMany" => delete_many(call, args),
    "deleteVersions" => delete_versions(call, args),
    other => Err(EngineError::internal(format!("unknown engine method `{other}`"))),
  }
}

// ---------------------------------------------------------------------------
// argument helpers

/// A string argument (`undefined` for any other type).
fn str_arg<'a>(args: &'a JsVal, key: &str) -> Option<&'a str> {
  args.get(key).as_str()
}

fn num_arg(args: &JsVal, key: &str) -> Option<f64> {
  args.get(key).as_num()
}

/// `pagination` as `findMany` compares it (`pagination === false`).
fn pagination_arg(args: &JsVal) -> Option<bool> {
  match args.get("pagination") {
    JsVal::Bool(b) => Some(*b),
    _ => None,
  }
}

/// `returning === false`
fn returning_false(args: &JsVal) -> bool {
  matches!(args.get("returning"), JsVal::Bool(false))
}

/// `req?.locale`
fn req_locale(args: &JsVal) -> Option<&str> {
  args.get("req").get("locale").as_str()
}

/// `value ?? fallback`
fn or_default(value: &JsVal, fallback: &JsVal) -> JsVal {
  if value.is_nullish() { fallback.clone() } else { value.clone() }
}

/// `this.tableNameMap.get(key)`; `undefined` table names fail where TS dereferences
/// `adapter.tables[undefined]`.
fn table_name(call: &Call<'_>, key: &str) -> Result<String> {
  call
    .engine
    .schema
    .table_name_map
    .get(key)
    .cloned()
    .ok_or_else(|| EngineError::new("TypeError", "Cannot read properties of undefined (reading 'id')"))
}

fn versions_table_name(call: &Call<'_>, entity: &JsVal) -> Result<String> {
  table_name(call, &format!("_{}{}", snake_slug(entity)?, call.options.query.versions_suffix))
}

/// The operation's `WriteArgs`: `now` (`new Date().toISOString()` stamps) is the caller's clock.
/// The translated unique-violation messages (`req.t`) are left to TS.
fn write_args(call: &Call<'_>, args: &JsVal, table_name: String) -> Result<WriteArgs> {
  let now = call.options.now.map(payload_sql_write::js::iso_string).transpose()?;
  Ok(WriteArgs { table_name, returning_false: returning_false(args), now, ..WriteArgs::default() })
}

#[derive(Clone, Copy)]
enum Entity {
  Collection,
  CollectionVersions,
  GlobalVersions,
}

/// The fields and table of a collection, its versions or a global's versions.
fn entity_target(call: &Call<'_>, args: &JsVal, entity: Entity) -> Result<(JsVal, String)> {
  match entity {
    Entity::Collection => {
      let collection = collection_config(call.root, str_arg(args, "collection").unwrap_or("undefined"))?;
      Ok((collection.get("flattenedFields").clone(), table_name(call, &snake_slug(collection)?)?))
    }
    Entity::CollectionVersions => {
      let collection = collection_config(call.root, str_arg(args, "collection").unwrap_or("undefined"))?;
      let table = versions_table_name(call, collection)?;
      Ok((version_collection_fields(call.config(), collection), table))
    }
    Entity::GlobalVersions => {
      let global = global_config(call.root, str_arg(args, "global").unwrap_or("undefined"))?;
      let table = versions_table_name(call, global)?;
      Ok((version_global_fields(call.config(), global), table))
    }
  }
}

/// `findMany`'s `PaginatedDocs` object.
fn paginated(result: FindManyResult<JsVal>) -> JsVal {
  let num_or_null = |n: Option<f64>| n.map(JsVal::Num).unwrap_or(JsVal::Null);
  JsVal::obj(Obj::from_iter([
    ("docs".to_string(), JsVal::arr(result.docs)),
    ("hasNextPage".to_string(), JsVal::Bool(result.has_next_page)),
    ("hasPrevPage".to_string(), JsVal::Bool(result.has_prev_page)),
    ("limit".to_string(), result.limit.map(JsVal::Num).unwrap_or(JsVal::Undefined)),
    ("nextPage".to_string(), num_or_null(result.next_page)),
    ("page".to_string(), JsVal::Num(result.page)),
    ("pagingCounter".to_string(), JsVal::Num(result.paging_counter)),
    ("prevPage".to_string(), num_or_null(result.prev_page)),
    ("totalDocs".to_string(), JsVal::Num(result.total_docs)),
    ("totalPages".to_string(), JsVal::Num(result.total_pages)),
  ]))
}

// ---------------------------------------------------------------------------
// read operations

/// `find` (find.ts)
fn find_op(call: &Call<'_>, args: &JsVal) -> Result<JsVal> {
  let collection = collection_config(call.root, str_arg(args, "collection").unwrap_or("undefined"))?;
  let sort = or_default(args.get("sort"), collection.get("defaultSort"));
  let spec = FindSpec {
    collection_slug: collection.get("slug").as_str().map(str::to_string),
    drafts_enabled: args.get("draftsEnabled").truthy(),
    fields: collection.get("flattenedFields").clone(),
    joins: args.get("joins").clone(),
    limit: num_arg(args, "limit"),
    locale: str_arg(args, "locale").map(str::to_string),
    page: num_arg(args, "page"),
    pagination: pagination_arg(args),
    select: args.get("select").clone(),
    sort,
    table_name: table_name(call, &snake_slug(collection)?)?,
    versions: false,
    where_: args.get("where").clone(),
  };
  Ok(paginated(call.find_many(&spec)?))
}

/// `findOne` (findOne.ts)
fn find_one(call: &Call<'_>, args: &JsVal) -> Result<JsVal> {
  let collection = collection_config(call.root, str_arg(args, "collection").unwrap_or("undefined"))?;
  let spec = FindSpec {
    collection_slug: str_arg(args, "collection").map(str::to_string),
    drafts_enabled: args.get("draftsEnabled").truthy(),
    fields: collection.get("flattenedFields").clone(),
    joins: args.get("joins").clone(),
    limit: Some(1.0),
    locale: str_arg(args, "locale").map(str::to_string),
    page: Some(1.0),
    pagination: Some(false),
    select: args.get("select").clone(),
    sort: JsVal::Undefined,
    table_name: table_name(call, &snake_slug(collection)?)?,
    versions: false,
    where_: args.get("where").clone(),
  };
  let docs = call.find_many(&spec)?.docs;
  // `docs?.[0] || null`
  Ok(docs.into_iter().next().filter(JsVal::truthy).unwrap_or(JsVal::Null))
}

/// `findGlobal` (findGlobal.ts)
fn find_global(call: &Call<'_>, args: &JsVal) -> Result<JsVal> {
  let slug = str_arg(args, "slug").unwrap_or("undefined");
  let global = global_config(call.root, slug)?;
  let spec = FindSpec {
    fields: global.get("flattenedFields").clone(),
    limit: Some(1.0),
    locale: str_arg(args, "locale").map(str::to_string),
    pagination: Some(false),
    select: args.get("select").clone(),
    table_name: table_name(call, &snake_slug(global)?)?,
    where_: args.get("where").clone(),
    ..FindSpec::default()
  };
  let docs = call.find_many(&spec)?.docs;
  match docs.into_iter().next().filter(JsVal::truthy) {
    Some(mut doc) => {
      set(&mut doc, "globalType", args.get("slug").clone())?;
      Ok(doc)
    }
    None => Ok(JsVal::obj(Obj::new())),
  }
}

/// `findVersions` (findVersions.ts)
fn find_versions(call: &Call<'_>, args: &JsVal) -> Result<JsVal> {
  let collection = collection_config(call.root, str_arg(args, "collection").unwrap_or("undefined"))?;
  let sort = or_default(args.get("sort"), collection.get("defaultSort"));
  let table = versions_table_name(call, collection)?;
  let spec = FindSpec {
    fields: version_collection_fields(call.config(), collection),
    joins: JsVal::Bool(false),
    limit: num_arg(args, "limit"),
    locale: str_arg(args, "locale").map(str::to_string),
    page: num_arg(args, "page"),
    pagination: pagination_arg(args),
    select: args.get("select").clone(),
    sort,
    table_name: table,
    where_: args.get("where").clone(),
    ..FindSpec::default()
  };
  Ok(paginated(call.find_many(&spec)?))
}

/// `findGlobalVersions` (findGlobalVersions.ts)
fn find_global_versions(call: &Call<'_>, args: &JsVal) -> Result<JsVal> {
  let global = global_config(call.root, str_arg(args, "global").unwrap_or("undefined"))?;
  let sort = or_default(args.get("sort"), &JsVal::str("-createdAt"));
  let table = versions_table_name(call, global)?;
  let spec = FindSpec {
    fields: version_global_fields(call.config(), global),
    limit: num_arg(args, "limit"),
    locale: str_arg(args, "locale").map(str::to_string),
    page: num_arg(args, "page"),
    pagination: pagination_arg(args),
    select: args.get("select").clone(),
    sort,
    table_name: table,
    where_: args.get("where").clone(),
    ..FindSpec::default()
  };
  Ok(paginated(call.find_many(&spec)?))
}

/// `combineQueries(where, access)` (payload/src/database/combineQueries.ts)
fn combine_queries(where_: &JsVal, access: &JsVal) -> JsVal {
  if !where_.truthy() && !access.truthy() {
    return JsVal::obj(Obj::new());
  }
  let mut and = Vec::new();
  if where_.truthy() {
    and.push(where_.clone());
  }
  if access.truthy() && access.is_object_like() {
    and.push(access.clone());
  }
  JsVal::obj(Obj::from_iter([("and".to_string(), JsVal::arr(and))]))
}

/// `queryDrafts` (queryDrafts.ts)
fn query_drafts(call: &Call<'_>, args: &JsVal) -> Result<JsVal> {
  let slug = str_arg(args, "collection");
  let collection = collection_config(call.root, slug.unwrap_or("undefined"))?;
  let table = versions_table_name(call, collection)?;
  let fields = version_collection_fields(call.config(), collection);
  let latest = JsVal::obj(Obj::from_iter([(
    "latest".to_string(),
    JsVal::obj(Obj::from_iter([("equals".to_string(), JsVal::Bool(true))])),
  )]));
  let spec = FindSpec {
    collection_slug: slug.map(str::to_string),
    fields,
    joins: args.get("joins").clone(),
    limit: num_arg(args, "limit"),
    locale: str_arg(args, "locale").map(str::to_string),
    page: num_arg(args, "page"),
    pagination: pagination_arg(args),
    select: args.get("select").clone(),
    sort: args.get("sort").clone(),
    table_name: table,
    versions: true,
    where_: combine_queries(&latest, args.get("where")),
    ..FindSpec::default()
  };
  let mut result = call.find_many(&spec)?;
  // `{ id: doc.parent, ...doc.version }`
  result.docs = std::mem::take(&mut result.docs)
    .into_iter()
    .map(|doc| {
      let mut out = Obj::new();
      out.insert("id".to_string(), doc.get("parent").clone());
      spread_into(&mut out, doc.get("version"));
      JsVal::obj(out)
    })
    .collect();
  Ok(paginated(result))
}

/// `{ ...target, ...value }` for a spread source.
fn spread_into(target: &mut Obj, value: &JsVal) {
  match value {
    JsVal::Obj(o) if value.typed().is_none() => {
      for (k, v) in o.iter() {
        js_insert(target, k.clone(), v.clone());
      }
    }
    JsVal::Arr(a) => {
      for (i, v) in a.iter().enumerate() {
        js_insert(target, i.to_string(), v.clone());
      }
    }
    JsVal::Str(s) => {
      for (i, c) in s.encode_utf16().enumerate() {
        js_insert(target, i.to_string(), JsVal::str(String::from_utf16_lossy(&[c])));
      }
    }
    _ => {}
  }
}

/// `Number(countResult?.[0]?.count ?? 0)` of `countDistinct`
fn first_count(rows: Vec<Vec<(String, JsVal)>>) -> f64 {
  match rows.into_iter().next().and_then(|row| row.into_iter().next()).map(|(_, v)| v) {
    None | Some(JsVal::Null) | Some(JsVal::Undefined) => 0.0,
    Some(JsVal::Num(n)) => n,
    Some(JsVal::Bool(b)) => f64::from(u8::from(b)),
    Some(JsVal::Str(s)) => payload_sql_find::exec::string_to_number(&s),
    Some(_) => f64::NAN,
  }
}

/// `count` / `countVersions` / `countGlobalVersions`
fn count(call: &Call<'_>, args: &JsVal, entity: Entity) -> Result<JsVal> {
  let (fields, table) = entity_target(call, args, entity)?;
  let built = call.build_query(&fields, &table, str_arg(args, "locale"), &JsVal::Undefined, WhereVal::Js(args.get("where").clone()))?;
  let select = count_select(call.qa, None, &built.joins, built.where_.as_ref(), &table)?;
  let mut exec = call.executor();
  let total = first_count(call.select_rows(&mut exec, &select)?);
  Ok(JsVal::obj(Obj::from_iter([("totalDocs".to_string(), JsVal::Num(total))])))
}

/// `findDistinct` (findDistinct.ts)
fn find_distinct(call: &Call<'_>, args: &JsVal) -> Result<JsVal> {
  let collection = collection_config(call.root, str_arg(args, "collection").unwrap_or("undefined"))?;
  let fields = collection.get("flattenedFields").clone();
  let table = table_name(call, &snake_slug(collection)?)?;
  let field_arg = args.get("field");
  let field_key = to_js_string(field_arg);
  // `args.page || 1`, `args.limit` truthiness
  let page = args.get("page").as_num().filter(|_| args.get("page").truthy()).unwrap_or(1.0);
  let limit = args.get("limit").as_num().filter(|_| args.get("limit").truthy());

  let user_where = or_default(args.get("where"), &JsVal::obj(Obj::new()));
  let where_ = WhereVal::obj(vec![(
    "and",
    WhereVal::Arr(vec![WhereVal::Js(user_where), WhereVal::obj(vec![(field_key.clone(), WhereVal::obj(vec![("equals", WhereVal::Distinct)]))])]),
  )]);
  let sort = or_default(args.get("sort"), field_arg);
  let built = call.build_query(&fields, &table, str_arg(args, "locale"), &sort, where_)?;
  let selected = built.select_fields.get("_selected").cloned().flatten();
  let statements = find_distinct_select(call.qa, built, &table, limit, Some(page))?;

  let mut exec = call.executor();
  let rows = call.select_rows(&mut exec, &statements.select)?;
  let mut selected_values = rows
    .into_iter()
    .map(|row| {
      let value = row.into_iter().next().map(|(_, v)| v).unwrap_or_default();
      match (&selected, value) {
        (_, JsVal::Null) => Ok(JsVal::Null),
        (Some(Expr::Col(column)), value) => column.map_from_driver_value(value),
        (_, value) => Ok(value),
      }
    })
    .collect::<Result<Vec<_>>>()?;

  let field = field_by_path(call.config(), &fields, &field_key);
  if field.as_ref().is_some_and(|f| matches!(f.get("relationTo"), JsVal::Arr(_))) {
    for value in &mut selected_values {
      *value = polymorphic_selected(value)?;
    }
  }

  let values: Vec<JsVal> = selected_values
    .into_iter()
    .map(|v| JsVal::obj(Obj::from_iter([(field_key.clone(), v)])))
    .collect();

  if let Some(limit) = limit {
    let total_docs = match &statements.count {
      Some(count) => first_count(call.select_rows(&mut exec, count)?),
      None => 0.0,
    };
    let total_pages = (total_docs / limit).ceil();
    let has_prev_page = page > 1.0;
    let has_next_page = total_pages > page;
    return Ok(JsVal::obj(Obj::from_iter([
      ("hasNextPage".to_string(), JsVal::Bool(has_next_page)),
      ("hasPrevPage".to_string(), JsVal::Bool(has_prev_page)),
      ("limit".to_string(), JsVal::Num(limit)),
      ("nextPage".to_string(), if has_next_page { JsVal::Num(page + 1.0) } else { JsVal::Null }),
      ("page".to_string(), JsVal::Num(page)),
      ("pagingCounter".to_string(), JsVal::Num((page - 1.0) * limit + 1.0)),
      ("prevPage".to_string(), if has_prev_page { JsVal::Num(page - 1.0) } else { JsVal::Null }),
      ("totalDocs".to_string(), JsVal::Num(total_docs)),
      ("totalPages".to_string(), JsVal::Num(total_pages)),
      ("values".to_string(), JsVal::arr(values)),
    ])));
  }

  let total_docs = values.len() as f64;
  Ok(JsVal::obj(Obj::from_iter([
    ("hasNextPage".to_string(), JsVal::Bool(false)),
    ("hasPrevPage".to_string(), JsVal::Bool(false)),
    ("limit".to_string(), JsVal::Num(0.0)),
    ("page".to_string(), JsVal::Num(1.0)),
    ("pagingCounter".to_string(), JsVal::Num(1.0)),
    ("totalDocs".to_string(), JsVal::Num(total_docs)),
    ("totalPages".to_string(), JsVal::Num(1.0)),
    ("values".to_string(), JsVal::arr(values)),
  ])))
}

/// findDistinct's polymorphic step: `JSON.parse(row._selected)`, the first key with a truthy
/// value becomes `{ relationTo, value }` (`null` when there is none).
fn polymorphic_selected(selected: &JsVal) -> Result<JsVal> {
  let json = json_parse(&to_js_string(selected))?;
  let entries: Vec<(String, JsVal)> = match &json {
    JsVal::Null | JsVal::Undefined => {
      return Err(EngineError::new("TypeError", "Cannot convert undefined or null to object"));
    }
    JsVal::Obj(o) => o.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
    JsVal::Arr(a) => a.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
    JsVal::Str(s) => s.encode_utf16().enumerate().map(|(i, c)| (i.to_string(), JsVal::str(String::from_utf16_lossy(&[c])))).collect(),
    _ => Vec::new(),
  };
  let Some((relation_to, value)) = entries.into_iter().find(|(_, v)| v.truthy()) else { return Ok(JsVal::Null) };
  Ok(JsVal::obj(Obj::from_iter([("relationTo".to_string(), JsVal::str(relation_to)), ("value".to_string(), value)])))
}

// ---------------------------------------------------------------------------
// write operations

fn write_env<'e, 'c>(
  call: &'e Call<'e>,
  exec: &'e mut payload_sql_upsert::Executor<'c>,
  fields: &'e JsVal,
  host: &'e mut ReadBack<'e>,
) -> Env<'e, 'c> {
  Env {
    exec,
    schema: &call.engine.schema,
    opts: &call.options.upsert,
    ctx: WriteContext { adapter: call.write, fields },
    host,
  }
}

fn read_back<'c>(call: &'c Call<'c>, fields: &'c JsVal, select: &JsVal, table_name: &str) -> ReadBack<'c> {
  ReadBack { call, fields, select: select.clone(), table_name: table_name.to_string() }
}

/// `create` (create.ts)
fn create(call: &Call<'_>, args: &JsVal) -> Result<JsVal> {
  let slug = str_arg(args, "collection");
  let collection = collection_config(call.root, slug.unwrap_or("undefined"))?;
  let table = table_name(call, &snake_slug(collection)?)?;
  let fields = collection.get("flattenedFields");
  let mut wargs = write_args(call, args, table.clone())?;
  wargs.collection_slug = slug.map(str::to_string);
  let mut host = read_back(call, fields, args.get("select"), &table);
  let mut exec = call.executor();
  let mut data = args.get("data").clone();
  let mut env = write_env(call, &mut exec, fields, &mut host);
  wops::create(&mut env, &wargs, args.get("customID").clone(), &mut data)
}

/// `createGlobal` (createGlobal.ts). `data.createdAt = new Date().toISOString()` is a
/// caller-visible mutation the TS glue makes before the call (ENGINE_STATUS.md), so it is not
/// repeated here.
fn create_global(call: &Call<'_>, args: &JsVal) -> Result<JsVal> {
  let slug = str_arg(args, "slug").unwrap_or("undefined");
  let global = global_config(call.root, slug)?;
  let table = table_name(call, &snake_slug(global)?)?;
  let fields = global.get("flattenedFields");
  let wargs = write_args(call, args, table.clone())?;
  let mut upsert = UpsertRowArgs::new(table.clone(), Operation::Create);
  upsert.global_slug = Some(slug.to_string());
  upsert.now = wargs.now.clone();
  upsert.ignore_result = if wargs.returning_false { IgnoreResult::Yes } else { IgnoreResult::No };
  let mut host = read_back(call, fields, &JsVal::Undefined, &table);
  let mut exec = call.executor();
  let mut data = args.get("data").clone();
  let ctx = WriteContext { adapter: call.write, fields };
  let outcome = upsert_row(&mut exec, &call.engine.schema, &call.options.upsert, &ctx, &mut host, &upsert, &mut data)?;
  if wargs.returning_false {
    return Ok(JsVal::Null);
  }
  // `result.globalType = slug`
  let mut result = outcome.to_js();
  set(&mut result, "globalType", JsVal::str(slug))?;
  Ok(result)
}

fn create_version_args(args: &JsVal, drafts_enabled: bool) -> CreateVersionArgs {
  CreateVersionArgs {
    autosave: args.get("autosave").clone(),
    created_at: args.get("createdAt").clone(),
    parent: args.get("parent").clone(),
    published_locale: args.get("publishedLocale").clone(),
    snapshot: args.get("snapshot").clone(),
    updated_at: args.get("updatedAt").clone(),
    version_data: args.get("versionData").clone(),
    drafts_enabled,
  }
}

/// `createVersion` (createVersion.ts)
fn create_version(call: &Call<'_>, args: &JsVal) -> Result<JsVal> {
  let slug = str_arg(args, "collectionSlug");
  let collection = collection_config(call.root, slug.unwrap_or("undefined"))?;
  let mut select = args.get("select").clone();
  // `if (collection.versions.drafts) { if (typeof select === 'object') select.updatedAt = true }`
  let versions = collection.get("versions");
  if versions.is_nullish() {
    return Err(EngineError::new("TypeError", format!("Cannot read properties of {} (reading 'drafts')", to_js_string(versions))));
  }
  if versions.get("drafts").truthy() {
    match &select {
      JsVal::Null => {
        return Err(EngineError::new("TypeError", "Cannot set properties of null (setting 'updatedAt')"));
      }
      JsVal::Obj(_) | JsVal::Arr(_) => set(&mut select, "updatedAt", JsVal::Bool(true))?,
      _ => {}
    }
  }
  let table = versions_table_name(call, collection)?;
  let fields = version_collection_fields(call.config(), collection);
  let mut wargs = write_args(call, args, table.clone())?;
  wargs.collection_slug = slug.map(str::to_string);
  let mut host = read_back(call, &fields, &select, &table);
  let mut exec = call.executor();
  let mut env = write_env(call, &mut exec, &fields, &mut host);
  wops::create_version(&mut env, &wargs, &create_version_args(args, has_drafts_enabled(collection)))
}

/// `createGlobalVersion` (createGlobalVersion.ts)
fn create_global_version(call: &Call<'_>, args: &JsVal) -> Result<JsVal> {
  let slug = str_arg(args, "globalSlug");
  let global = global_config(call.root, slug.unwrap_or("undefined"))?;
  let table = versions_table_name(call, global)?;
  let fields = version_global_fields(call.config(), global);
  let mut wargs = write_args(call, args, table.clone())?;
  wargs.global_slug = slug.map(str::to_string);
  let mut host = read_back(call, &fields, args.get("select"), &table);
  let mut exec = call.executor();
  let mut env = write_env(call, &mut exec, &fields, &mut host);
  wops::create_global_version(&mut env, &wargs, &create_version_args(args, has_drafts_enabled(global)))
}

/// `updateOne` (updateOne.ts); `upsert` (upsert.ts) is `updateOne` with `options: { upsert: true }`
/// and no `id`.
fn update_one(call: &Call<'_>, args: &JsVal, upsert: bool) -> Result<JsVal> {
  let slug = str_arg(args, "collection");
  let collection = collection_config(call.root, slug.unwrap_or("undefined"))?;
  let table = table_name(call, &snake_slug(collection)?)?;
  let fields = collection.get("flattenedFields");
  let id = if upsert { JsVal::Undefined } else { args.get("id").clone() };
  // `options = { upsert: false }`
  let options = if upsert { None } else { Some(args.get("options")) };
  let (is_upsert, atomic) = match options {
    None => (true, false),
    Some(JsVal::Undefined) => (false, false),
    Some(options) => (options.get("upsert").truthy(), matches!(options.get("atomic"), JsVal::Bool(true))),
  };
  let where_arg = args.get("where");

  let mut built = None;
  let mut query = Default::default();
  if !id.truthy() {
    let result = call.build_query(fields, &table, str_arg(args, "locale"), &JsVal::Undefined, WhereVal::Js(where_arg.clone()))?;
    query = built_query(&result)?;
    built = Some(result);
  }

  let mut wargs = write_args(call, args, table.clone())?;
  wargs.collection_slug = slug.map(str::to_string);
  let update = UpdateOneArgs { id, query, has_where_arg: where_arg.truthy(), upsert: is_upsert, atomic };
  let mut ops_host = Ops { call, fields, table_name: table.clone(), built, select: args.get("select").clone(), find_spec: None };
  let mut host = read_back(call, fields, args.get("select"), &table);
  let mut exec = call.executor();
  let mut data = args.get("data").clone();
  let mut env = write_env(call, &mut exec, fields, &mut host);
  wops::update_one(&mut env, &mut ops_host, &wargs, &update, &mut data)
}

/// `updateMany` (updateMany.ts)
fn update_many(call: &Call<'_>, args: &JsVal) -> Result<JsVal> {
  let slug = str_arg(args, "collection");
  let collection = collection_config(call.root, slug.unwrap_or("undefined"))?;
  let table = table_name(call, &snake_slug(collection)?)?;
  let fields = collection.get("flattenedFields");
  let sort = or_default(args.get("sort"), collection.get("defaultSort"));
  let where_arg = args.get("where");
  let result = call.build_query(fields, &table, str_arg(args, "locale"), &sort, WhereVal::Js(where_arg.clone()))?;
  let query = built_query(&result)?;

  let mut wargs = write_args(call, args, table.clone())?;
  wargs.collection_slug = slug.map(str::to_string);
  let mut ops_host =
    Ops { call, fields, table_name: table.clone(), built: Some(result), select: args.get("select").clone(), find_spec: None };
  let mut host = read_back(call, fields, args.get("select"), &table);
  let mut exec = call.executor();
  let mut data = args.get("data").clone();
  let mut env = write_env(call, &mut exec, fields, &mut host);
  wops::update_many(&mut env, &mut ops_host, &wargs, &query, where_arg.truthy(), args.get("limit"), &mut data)
}

/// `updateGlobal` (updateGlobal.ts). Without a global row yet, `upsertRow({ operation: 'create' })`
/// sets `data.createdAt` on the caller's `data` when it is falsy (after the `findFirst`); that
/// mutation is reported as `[['data', 'createdAt'], value]` (`CallOutput::mutations`).
fn update_global(call: &Call<'_>, args: &JsVal) -> Result<JsVal> {
  let slug = str_arg(args, "slug").unwrap_or("undefined");
  let global = global_config(call.root, slug)?;
  let table = table_name(call, &snake_slug(global)?)?;
  let fields = global.get("flattenedFields");
  let wargs = write_args(call, args, table.clone())?;
  let mut host = read_back(call, fields, args.get("select"), &table);
  let mut exec = call.executor();
  let mut data = args.get("data").clone();
  let created_at_before = args.get("data").get("createdAt").clone();
  let mut env = write_env(call, &mut exec, fields, &mut host);
  let result = wops::update_global(&mut env, &wargs, slug, &mut data);
  let created_at = data.get("createdAt");
  if !created_at_before.truthy() && created_at.truthy() {
    call.mutations.borrow_mut().push((vec!["data".to_string(), "createdAt".to_string()], created_at.clone()));
  }
  result
}

/// `updateVersion` / `updateGlobalVersion` (updateVersion.ts, updateGlobalVersion.ts)
fn update_version(call: &Call<'_>, args: &JsVal, entity: Entity) -> Result<JsVal> {
  let (fields, table) = entity_target(call, args, entity)?;
  let id = args.get("id").clone();
  // `whereArg || { id: { equals: id } }`
  let where_arg = args.get("where");
  let where_to_use = if where_arg.truthy() {
    where_arg.clone()
  } else {
    JsVal::obj(Obj::from_iter([("id".to_string(), JsVal::obj(Obj::from_iter([("equals".to_string(), id.clone())])))]))
  };
  let result = call.build_query(&fields, &table, str_arg(args, "locale"), &JsVal::Undefined, WhereVal::Js(where_to_use))?;
  let where_ = built_query(&result)?.where_;

  let mut wargs = write_args(call, args, table.clone())?;
  match entity {
    Entity::GlobalVersions => wargs.global_slug = str_arg(args, "global").map(str::to_string),
    _ => wargs.collection_slug = str_arg(args, "collection").map(str::to_string),
  }
  let mut host = read_back(call, &fields, args.get("select"), &table);
  let mut exec = call.executor();
  let mut version_data = args.get("versionData").clone();
  let mut env = write_env(call, &mut exec, &fields, &mut host);
  wops::update_version(&mut env, &wargs, id, where_, &mut version_data)
}

/// `updateJobs` (updateJobs.ts)
fn update_jobs(call: &Call<'_>, args: &JsVal) -> Result<JsVal> {
  let id = args.get("id").clone();
  let mut data = args.get("data").clone();
  let collection = collection_config(call.root, "payload-jobs")?;
  let table = table_name(call, &snake_slug(collection)?)?;
  let fields = collection.get("flattenedFields");
  let sort = or_default(args.get("sort"), collection.get("defaultSort"));
  // `id ? { id: { equals: id } } : whereArg`, `id ? 1 : limitArg`
  let (where_, limit) = if id.truthy() {
    (
      JsVal::obj(Obj::from_iter([("id".to_string(), JsVal::obj(Obj::from_iter([("equals".to_string(), id.clone())])))])),
      Some(1.0),
    )
  } else {
    (args.get("where").clone(), num_arg(args, "limit"))
  };
  let spec = FindSpec {
    collection_slug: Some("payload-jobs".into()),
    fields: fields.clone(),
    limit,
    pagination: Some(false),
    sort,
    table_name: table.clone(),
    where_,
    ..FindSpec::default()
  };
  let mut wargs = write_args(call, args, table.clone())?;
  wargs.collection_slug = Some("payload-jobs".into());
  let mut ops_host = Ops { call, fields, table_name: table.clone(), built: None, select: JsVal::Undefined, find_spec: Some(spec) };
  let mut host = read_back(call, fields, &JsVal::Undefined, &table);
  let mut exec = call.executor();
  let mut env = write_env(call, &mut exec, fields, &mut host);
  wops::update_jobs(&mut env, &mut ops_host, &wargs, id, &mut data)
}

/// `deleteOne` (deleteOne.ts)
fn delete_one(call: &Call<'_>, args: &JsVal) -> Result<JsVal> {
  let collection = collection_config(call.root, str_arg(args, "collection").unwrap_or("undefined"))?;
  let table = table_name(call, &snake_slug(collection)?)?;
  let fields = collection.get("flattenedFields");
  let result = call.build_query(fields, &table, req_locale(args), &JsVal::Undefined, WhereVal::Js(args.get("where").clone()))?;
  let query = built_query(&result)?;
  let wargs = write_args(call, args, table.clone())?;
  let mut ops_host =
    Ops { call, fields, table_name: table, built: Some(result), select: args.get("select").clone(), find_spec: None };
  let mut exec = call.executor();
  wops::delete_one(&mut exec, &call.engine.schema, &mut ops_host, &wargs, &query)
}

/// `deleteMany` (deleteMany.ts)
fn delete_many(call: &Call<'_>, args: &JsVal) -> Result<JsVal> {
  let collection = collection_config(call.root, str_arg(args, "collection").unwrap_or("undefined"))?;
  let table = table_name(call, &snake_slug(collection)?)?;
  let fields = collection.get("flattenedFields");
  let where_arg = args.get("where");
  let result = call.build_query(fields, &table, req_locale(args), &JsVal::Undefined, WhereVal::Js(where_arg.clone()))?;
  let query = built_query(&result)?;
  let spec = FindSpec {
    fields: fields.clone(),
    joins: JsVal::Bool(false),
    limit: Some(0.0),
    locale: req_locale(args).map(str::to_string),
    page: Some(1.0),
    pagination: Some(false),
    select: JsVal::obj(Obj::from_iter([("id".to_string(), JsVal::Bool(true))])),
    table_name: table.clone(),
    where_: where_arg.clone(),
    ..FindSpec::default()
  };
  let wargs = write_args(call, args, table.clone())?;
  let mut ops_host = Ops { call, fields, table_name: table, built: Some(result), select: JsVal::Undefined, find_spec: Some(spec) };
  let mut exec = call.executor();
  wops::delete_many(&mut exec, &call.engine.schema, &mut ops_host, &wargs, &query)?;
  Ok(JsVal::Undefined)
}

/// `deleteVersions` (deleteVersions.ts)
fn delete_versions(call: &Call<'_>, args: &JsVal) -> Result<JsVal> {
  let global_slug = args.get("globalSlug");
  let collection_slug = args.get("collection");
  let (fields, table) = if global_slug.truthy() {
    let slug = to_js_string(global_slug);
    let global = call.config().get("globals").items().find(|g| g.get("slug").as_str() == Some(slug.as_str()));
    let table = call.engine.schema.table_name_map.get(&format!("_{}{}", to_snake_case(&slug), call.options.query.versions_suffix)).cloned();
    // `buildVersionGlobalFields(this.payload.config, globalConfig, true)` reads `global.fields`
    let global = global.ok_or_else(|| EngineError::new("TypeError", "Cannot read properties of undefined (reading 'fields')"))?;
    let table = table.ok_or_else(|| EngineError::new("TypeError", "Cannot read properties of undefined (reading 'id')"))?;
    (version_global_fields(call.config(), global), table)
  } else if collection_slug.truthy() {
    let collection = collection_config(call.root, &to_js_string(collection_slug))?;
    (version_collection_fields(call.config(), collection), versions_table_name(call, collection)?)
  } else {
    return Err(EngineError::api("Either collection or globalSlug must be passed."));
  };
  let spec = FindSpec {
    fields: fields.clone(),
    joins: JsVal::Bool(false),
    limit: Some(0.0),
    locale: str_arg(args, "locale").map(str::to_string),
    page: Some(1.0),
    pagination: Some(false),
    table_name: table.clone(),
    where_: args.get("where").clone(),
    ..FindSpec::default()
  };
  let wargs = write_args(call, args, table.clone())?;
  let mut ops_host = Ops { call, fields: &fields, table_name: table, built: None, select: JsVal::Undefined, find_spec: Some(spec) };
  let mut exec = call.executor();
  wops::delete_versions(&mut exec, &call.engine.schema, &mut ops_host, &wargs)
}
