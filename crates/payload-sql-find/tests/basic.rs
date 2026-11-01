//! Unit tests for the find crate. The differential verification against the
//! live TS implementation lives in test/__rs/find (see harness.ts); these
//! tests pin the building blocks with expectations taken from drizzle output.

use std::collections::HashMap;

use indexmap::IndexMap;
use payload_engine::error::Result;
use payload_engine::js::JsVal;
use payload_sql_find::args::QueryConfig;
use payload_sql_find::build_args::{BuildFindManyArgs, build_find_many_args};
use payload_sql_find::context::{
  AdapterOptions, BuildQueryArgs, BuiltQuery, FindContext, JsonQueryArgs, OperatorConstraintArgs, QueryBuilder,
  SanitizeArgs, SanitizedQueryValue,
};
use payload_sql_find::exec::{execute, string_to_number};
use payload_sql_find::relational::{Mode, build_relational_query};
use payload_sql_find::schema::DrizzleSchema;
use payload_sql_find::sql::Sql;
use payload_sql_find::utils::js_object_key_order;
use serde_json::json;

fn raw_schema() -> DrizzleSchema {
  let raw_tables = json!({
    "posts": { "name": "posts", "columns": {
      "id": { "name": "id", "type": "integer", "primaryKey": true },
      "title": { "name": "title", "type": "varchar" },
      "flag": { "name": "flag", "type": "boolean" },
      "data": { "name": "data", "type": "jsonb" },
      "num": { "name": "num", "type": "numeric" },
      "createdAt": { "name": "created_at", "type": "timestamp" }
    }},
    "posts_arr": { "name": "posts_arr", "columns": {
      "_order": { "name": "_order", "type": "integer" },
      "_parentID": { "name": "_parent_id", "type": "integer" },
      "id": { "name": "id", "type": "varchar" },
      "text": { "name": "text", "type": "varchar" }
    }},
    "posts_locales": { "name": "posts_locales", "columns": {
      "localized": { "name": "localized", "type": "varchar" },
      "id": { "name": "id", "type": "integer" },
      "_locale": { "name": "_locale", "type": "enum" },
      "_parentID": { "name": "_parent_id", "type": "integer" }
    }}
  });
  let raw_relations = json!({
    "posts": {
      "arr": { "type": "many", "to": "posts_arr", "relationName": "arr" },
      "_locales": { "type": "many", "to": "posts_locales", "relationName": "_locales" }
    },
    "posts_arr": {
      "_parentID": { "type": "one", "to": "posts", "fields": [{ "table": "posts_arr", "name": "_parentID" }], "references": ["id"], "relationName": "arr" }
    },
    "posts_locales": {
      "_parentID": { "type": "one", "to": "posts", "fields": [{ "table": "posts_locales", "name": "_parentID" }], "references": ["id"], "relationName": "_locales" }
    }
  });
  DrizzleSchema::from_raw(&raw_tables, &raw_relations).expect("schema")
}

fn conn() -> rusqlite::Connection {
  let c = rusqlite::Connection::open_in_memory().expect("open");
  c.execute_batch(
    r#"
    create table posts (id integer primary key, title text, flag integer, data text, num numeric, created_at text);
    create table posts_arr (_order integer, _parent_id integer, id text, text text);
    create table posts_locales (localized text, id integer primary key, _locale text, _parent_id integer);
    insert into posts values (1, 'a', 1, '{"x":[1,2]}', 1.5, '2020'), (2, 'b', 0, null, '7', '2021');
    insert into posts_arr values (2, 1, 'r2', 'second'), (1, 1, 'r1', 'first');
    insert into posts_locales values ('en', 1, 'en', 1), ('es', 2, 'es', 1);
    "#,
  )
  .expect("seed");
  c
}

#[test]
fn renders_like_drizzle() {
  let schema = raw_schema();
  let config = QueryConfig::from_json(&json!({
    "columns": { "id": true, "title": true },
    "with": {
      "arr": { "columns": { "_parentID": false }, "orderBy": [{ "column": "_order", "order": "asc" }], "with": {} },
      "_locales": { "columns": { "id": false, "_parentID": false } }
    },
    "orderBy": [{ "sql": "\"posts\".\"created_at\" desc", "params": [] }],
    "limit": 10,
    "offset": 0
  }))
  .expect("config");
  let built = build_relational_query(&schema, "posts", &config, Mode::Many).expect("build");
  assert_eq!(
    built.sql.sql,
    "select \"id\", \"title\", (select coalesce(json_group_array(json_array(\"_order\", \"id\", \"text\")), json_array()) as \"data\" from (select * from \"posts_arr\" \"posts_arr\" where \"posts_arr\".\"_parent_id\" = \"posts\".\"id\" order by \"posts_arr\".\"_order\" asc) \"posts_arr\") as \"arr\", (select coalesce(json_group_array(json_array(\"localized\", \"_locale\")), json_array()) as \"data\" from \"posts_locales\" \"posts__locales\" where \"posts__locales\".\"_parent_id\" = \"posts\".\"id\") as \"_locales\" from \"posts\" \"posts\" order by \"posts\".\"created_at\" desc limit ?"
  );
  assert_eq!(built.sql.to_json()["params"], json!([10]));

  let rows = execute(&conn(), &built, Mode::Many).expect("execute");
  assert_eq!(
    rows,
    json!([
      { "id": 2, "title": "b", "arr": [], "_locales": [] },
      { "id": 1, "title": "a",
        "arr": [{ "_order": 1, "id": "r1", "text": "first" }, { "_order": 2, "id": "r2", "text": "second" }],
        "_locales": [{ "localized": "en", "_locale": "en" }, { "localized": "es", "_locale": "es" }] }
    ])
  );
}

#[test]
fn decodes_columns() {
  let schema = raw_schema();
  let config = QueryConfig::from_json(&json!({ "columns": { "flag": true, "data": true, "num": true } })).expect("config");
  let built = build_relational_query(&schema, "posts", &config, Mode::First).expect("build");
  assert_eq!(built.sql.sql, "select \"flag\", \"data\", \"num\" from \"posts\" \"posts\" limit ?");
  let row = execute(&conn(), &built, Mode::First).expect("execute");
  assert_eq!(row, json!({ "flag": true, "data": { "x": [1, 2] }, "num": 1.5 }));
}

#[test]
fn empty_selection_errors() {
  let schema = raw_schema();
  let config = QueryConfig::from_json(&json!({ "columns": {} })).expect("config");
  let err = build_relational_query(&schema, "posts", &config, Mode::Many).expect_err("no fields");
  assert_eq!(err.name, "DrizzleError");
}

#[test]
fn js_number_semantics() {
  assert_eq!(string_to_number(" 12 "), 12.0);
  assert_eq!(string_to_number(""), 0.0);
  assert_eq!(string_to_number("0x10"), 16.0);
  assert!(string_to_number("inf").is_nan());
  assert!(string_to_number("1e").is_nan());
  assert_eq!(string_to_number("-Infinity"), f64::NEG_INFINITY);
  assert_eq!(string_to_number(".5e1"), 5.0);
}

#[test]
fn object_key_order() {
  let keys = vec!["b".into(), "10".into(), "2".into(), "a".into(), "01".into()];
  assert_eq!(js_object_key_order(keys), vec!["2", "10", "b", "a", "01"]);
}

struct NoQuery;

impl QueryBuilder for NoQuery {
  fn build_query(&self, _: &BuildQueryArgs<'_>) -> Result<BuiltQuery> {
    Ok(BuiltQuery::default())
  }
  fn table_alias(&self, _: &str) -> Result<String> {
    Ok("alias".into())
  }
  fn sanitize_query_value(&self, _: &SanitizeArgs<'_>) -> Result<Option<SanitizedQueryValue>> {
    Ok(None)
  }
  fn has_operator(&self, _: &str) -> bool {
    false
  }
  fn operator_constraint(&self, _: &OperatorConstraintArgs<'_>) -> Result<Sql> {
    Ok(Sql::raw("true"))
  }
  fn create_json_query(&self, _: &JsonQueryArgs<'_>) -> Result<String> {
    Ok(String::new())
  }
}

#[test]
fn build_find_many_args_basic() {
  let schema = raw_schema();
  let table_name_map: IndexMap<String, String> =
    [("posts", "posts"), ("posts_arr", "posts_arr")].into_iter().map(|(a, b)| (a.into(), b.into())).collect();
  let fields = JsVal::from_json(&json!([
    { "name": "title", "type": "text" },
    { "name": "localized", "type": "text", "localized": true },
    { "name": "arr", "type": "array", "flattenedFields": [{ "name": "text", "type": "text" }] }
  ]));
  let empty = JsVal::from_json(&json!({}));
  let options = AdapterOptions::default();
  let block_index = HashMap::new();
  let ctx = FindContext {
    schema: &schema,
    table_name_map: &table_name_map,
    config: &empty,
    collections: &empty,
    blocks: &empty,
    block_table_name_index: &block_index,
    options: &options,
    query: &NoQuery,
  };
  let base = BuildFindManyArgs {
    collection_slug: Some("posts"),
    depth: Some(0.0),
    drafts_enabled: false,
    fields: &fields,
    join_query: &JsVal::Undefined,
    locale: None,
    select: &JsVal::Undefined,
    table_name: "posts",
    versions: false,
  };
  let all = build_find_many_args(&ctx, &base).expect("args");
  assert_eq!(
    all.to_json(),
    json!({
      "with": {
        "arr": { "columns": { "_parentID": false }, "with": {}, "orderBy": [{ "column": "_order", "order": "asc" }] },
        "_locales": { "columns": { "id": false, "_parentID": false }, "with": {}, "extras": {} }
      }
    })
  );

  let select = JsVal::from_json(&json!({ "localized": true, "arr": { "text": true } }));
  let selected = build_find_many_args(&ctx, &BuildFindManyArgs { select: &select, ..base }).expect("args");
  assert_eq!(
    selected.to_json(),
    json!({
      "columns": { "id": true },
      "with": {
        "arr": { "columns": { "id": true, "_order": true, "text": true }, "with": {}, "orderBy": [{ "column": "_order", "order": "asc" }] },
        "_locales": { "columns": { "_locale": true, "localized": true }, "with": {}, "extras": {} }
      }
    })
  );
}
