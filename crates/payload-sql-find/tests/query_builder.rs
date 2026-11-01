//! `findMany` end to end through the Rust query builder (`SqlQueryBuilder` on
//! `payload-sql-query`). Expectations are drizzle/libsql outputs; the full
//! differential check against TS lives in test/__rs/find.

use std::collections::HashMap;

use payload_engine::js::JsVal;
use payload_engine::sql::schema::{RawSchema, RawTable};
use payload_sql_find::context::{AdapterOptions, FieldsSource, FindContext};
use payload_sql_find::find_many::{FindManyArgs, FindManyTrace, find_many};
use payload_sql_find::query::SqlQueryBuilder;
use payload_sql_find::schema::DrizzleSchema;
use payload_sql_query::QueryAdapter;
use serde_json::{Value as Json, json};

fn raw_tables() -> Json {
  json!({
    "posts": { "name": "posts", "columns": {
      "id": { "name": "id", "type": "integer", "primaryKey": true },
      "title": { "name": "title", "type": "varchar" },
      "data": { "name": "data", "type": "jsonb" },
      "updatedAt": { "name": "updated_at", "type": "timestamp" },
      "createdAt": { "name": "created_at", "type": "timestamp" }
    }}
  })
}

fn raw_schema() -> RawSchema {
  let tables = raw_tables();
  let table = &tables["posts"];
  RawSchema {
    raw_tables: [(
      "posts".to_string(),
      Some(RawTable {
        name: "posts".into(),
        columns: table["columns"].as_object().cloned().unwrap_or_default(),
        foreign_keys: Default::default(),
        indexes: Default::default(),
      }),
    )]
    .into_iter()
    .collect(),
    table_name_map: [("posts".to_string(), "posts".to_string())].into_iter().collect(),
    ..Default::default()
  }
}

fn conn() -> payload_sql_find::rusqlite::Connection {
  let c = payload_sql_find::rusqlite::Connection::open_in_memory().expect("open");
  c.execute_batch(
    r#"
    create table posts (id integer primary key, title text, data text, updated_at text, created_at text);
    insert into posts values
      (1, 'a', null, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'),
      (2, 'b', null, '2021-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z'),
      (3, '1', null, '2022-01-01T00:00:00.000Z', '2022-01-01T00:00:00.000Z');
    "#,
  )
  .expect("seed");
  c
}

struct Fixture {
  raw: RawSchema,
  schema: DrizzleSchema,
  config: JsVal,
  collections: JsVal,
  blocks: JsVal,
  fields: JsVal,
  options: AdapterOptions,
}

fn fixture() -> Fixture {
  let fields = json!([
    { "name": "title", "type": "text" },
    { "name": "data", "type": "json" },
    { "name": "updatedAt", "type": "date" },
    { "name": "createdAt", "type": "date" }
  ]);
  Fixture {
    raw: raw_schema(),
    schema: DrizzleSchema::from_raw(&raw_tables(), &json!({})).expect("schema"),
    config: JsVal::from_json(&json!({ "localization": false })),
    collections: JsVal::from_json(&json!({ "posts": { "config": { "slug": "posts", "flattenedFields": fields } } })),
    blocks: JsVal::from_json(&json!({})),
    fields: JsVal::from_json(&fields),
    options: AdapterOptions::default(),
  }
}

/// Runs `findMany` on `posts`; returns `(ids, relational SQL text, params)` or the error.
fn run(where_: Json, sort: Option<&str>) -> Result<(Vec<Json>, String, Vec<Json>), String> {
  let f = fixture();
  let adapter = QueryAdapter::new(&f.raw, &f.config, &f.collections, &f.blocks, f.options.clone());
  let query = SqlQueryBuilder::new(&adapter);
  let block_index = HashMap::new();
  let ctx = FindContext {
    schema: &f.schema,
    table_name_map: &f.raw.table_name_map,
    config: &f.config,
    collections: &f.collections,
    blocks: &f.blocks,
    block_table_name_index: &block_index,
    options: &f.options,
    query: &query,
  };
  let where_ = JsVal::from_json(&where_);
  let sort = sort.map(JsVal::str).unwrap_or(JsVal::Undefined);
  let mut trace = FindManyTrace::default();
  let result = find_many(
    &ctx,
    &conn(),
    &FindManyArgs {
      collection_slug: Some("posts"),
      drafts_enabled: false,
      fields: &f.fields,
      fields_source: FieldsSource::Collection("posts".into()),
      joins: &JsVal::Undefined,
      limit: Some(10.0),
      locale: None,
      page: Some(1.0),
      pagination: None,
      select: &JsVal::Undefined,
      sort: &sort,
      table_name: "posts",
      versions: false,
      where_: &where_,
    },
    &mut |doc| Ok(doc),
    Some(&mut trace),
  )
  .map_err(|e| format!("{}: {}", e.name, e.message))?;
  let rel = trace.relational.expect("relational");
  Ok((result.docs.iter().map(|d| d["id"].clone()).collect(), rel.sql, rel.params))
}

#[test]
fn where_and_sort_render_like_drizzle_rqb() {
  let (ids, sql, params) = run(json!({ "title": { "in": ["a", "b"] } }), Some("title")).expect("find");
  assert_eq!(ids, vec![json!(1), json!(2)]);
  // `mapColumnsInSQLToAlias(where, "posts")` + `order(column)` for the relational query.
  assert!(
    sql.ends_with(
      "from \"posts\" \"posts\" where \"posts\".\"title\" in (?, ?) order by \"posts\".\"title\" asc, \"posts\".\"created_at\" desc limit ?"
    ),
    "{sql}"
  );
  assert_eq!(params, vec![json!("a"), json!("b"), json!(10)]);
}

#[test]
fn numbers_bind_as_real_like_libsql() {
  // libsql binds JS numbers as REAL: a text column holding '1' does not equal 1.0.
  let (ids, _, _) = run(json!({ "title": { "equals": 1 } }), None).expect("find");
  assert_eq!(ids, Vec::<Json>::new());
}

/// JSON values that look like the internal raw-SQL / raw-constraint markers
/// (current and former encodings) must be bound as data, never spliced into
/// the SQL text.
#[test]
fn user_json_is_never_sql() {
  let forged = [
    json!({ "$rawConstraint": "1=1" }),
    json!({ "\u{0}payload:sql": "1=1" }),
    json!({ "type": "\u{0}payload:RawConstraint", "value": { "\u{0}payload:sql": "1=1" } }),
    json!({ "$sql": [{ "str": "1=1" }] }),
  ];
  for value in forged {
    for where_ in [json!({ "title": { "equals": value.clone() } }), json!({ "data": { "equals": value.clone() } })] {
      match run(where_.clone(), None) {
        Ok((ids, sql, _)) => {
          assert!(!sql.contains("1=1"), "{where_}: {sql}");
          assert!(ids.is_empty(), "{where_} matched {ids:?}");
        }
        // libsql refuses to bind an object, like TS.
        Err(e) => assert!(!e.contains("1=1"), "{where_}: {e}"),
      }
    }
  }
}
