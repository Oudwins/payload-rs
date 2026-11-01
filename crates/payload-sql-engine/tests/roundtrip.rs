//! End-to-end checks of the engine on upstream configs (graphs from test/__rs/schema/fixtures,
//! written by `RS_SCHEMA_WRITE_FIXTURES=1 pnpm test:int:sqlite test/__rs/schema/schema.int.spec.ts`):
//! build the schema once, create the tables, then create / find / update / delete through
//! `SqliteEngine::call_json` on a `payload-sqlite` worker connection, as the napi binding does.
//!
//! The fixtures are git-ignored; a missing fixture fails the tests (regenerate them with the
//! command above).

use std::sync::Arc;

use payload_engine::host::NoHost;
use payload_sql_engine::SqliteEngine;
use payload_sqlite::worker::{self, ConnId};
use serde_json::{Value as Json, json};

fn fixture(name: &str) -> Option<Json> {
  let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../test/__rs/schema/fixtures/{name}.json"));
  let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
    panic!("missing fixture {} ({e}); write it with RS_SCHEMA_WRITE_FIXTURES=1 (see the module docs)", path.display())
  });
  Some(serde_json::from_str(&text).expect("parse fixture"))
}

struct Db {
  engine: Arc<SqliteEngine>,
  id: ConnId,
  path: String,
}

impl Drop for Db {
  fn drop(&mut self) {
    worker::release(self.id);
    // `release` closes the connection after queued jobs; wait for that before deleting the file
    let _ = worker::call(self.id, |_| ());
    for suffix in ["", "-wal", "-shm", "-journal"] {
      let _ = std::fs::remove_file(format!("{}{suffix}", self.path));
    }
  }
}

fn sqlite_type(column: &Json) -> &'static str {
  match column["type"].as_str().unwrap_or("") {
    "integer" | "serial" | "boolean" => "integer",
    "numeric" => "numeric",
    _ => "text",
  }
}

/// `CREATE TABLE` / `CREATE INDEX` statements like drizzle's push for the raw tables.
fn ddl(raw_tables: &Json) -> String {
  let mut out = String::new();
  for table in raw_tables.as_object().expect("rawTables").values() {
    let name = table["name"].as_str().expect("name");
    let columns = table["columns"].as_object().expect("columns");
    let mut defs = Vec::new();
    for column in columns.values() {
      let mut def = format!("\"{}\" {}", column["name"].as_str().expect("column name"), sqlite_type(column));
      if column["primaryKey"] == json!(true) {
        def.push_str(" PRIMARY KEY");
        if column["autoIncrement"] == json!(true) {
          def.push_str(" AUTOINCREMENT");
        }
      }
      if column["notNull"] == json!(true) {
        def.push_str(" NOT NULL");
      }
      if column["type"] == "timestamp" && column["defaultNow"] == json!(true) {
        def.push_str(" DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");
      }
      defs.push(def);
    }
    for fk in table["foreignKeys"].as_object().into_iter().flatten().map(|(_, fk)| fk) {
      let cols: Vec<String> =
        fk["columns"].as_array().expect("fk columns").iter().map(|c| format!("\"{}\"", columns[c.as_str().expect("key")]["name"].as_str().expect("name"))).collect();
      let foreign = &fk["foreignColumns"][0];
      defs.push(format!(
        "FOREIGN KEY ({}) REFERENCES \"{}\"(\"{}\") ON DELETE {}",
        cols.join(", "),
        foreign["table"].as_str().expect("table"),
        foreign["name"].as_str().expect("name"),
        fk["onDelete"].as_str().unwrap_or("no action")
      ));
    }
    out.push_str(&format!("CREATE TABLE \"{name}\" ({});\n", defs.join(", ")));
    for index in table["indexes"].as_object().into_iter().flatten().map(|(_, i)| i) {
      let on: Vec<&str> = match &index["on"] {
        Json::String(s) => vec![s.as_str()],
        Json::Array(a) => a.iter().filter_map(Json::as_str).collect(),
        _ => vec![],
      };
      let cols: Vec<String> = on.iter().map(|k| format!("\"{}\"", columns[*k]["name"].as_str().unwrap_or(k))).collect();
      let unique = if index["unique"] == json!(true) { "UNIQUE " } else { "" };
      out.push_str(&format!("CREATE {unique}INDEX \"{}\" ON \"{name}\" ({});\n", index["name"].as_str().expect("index name"), cols.join(", ")));
    }
  }
  out
}

fn open(name: &str, fixture: &Json, variant: &str) -> Db {
  let options = json!({
    "idType": if variant == "number" { "number" } else { variant },
    "autoIncrement": variant == "number",
    "blocksAsJSON": false,
    "name": "sqlite",
  });
  let engine = Arc::new(SqliteEngine::create(&NoHost, &fixture["graph"], &options).expect("create engine"));
  let path = format!("/tmp/rs-engine-test-{name}-{variant}.db");
  for suffix in ["", "-wal", "-shm", "-journal"] {
    let _ = std::fs::remove_file(format!("{path}{suffix}"));
  }
  let id = worker::open_client(&path).expect("open client");
  let statements = ddl(&engine.raw_schema_json()["rawTables"]);
  worker::call(id, move |session| {
    let conn = session.conn().expect("conn").connection().expect("connection");
    conn.execute_batch(&format!("PRAGMA foreign_keys = ON;\n{statements}")).expect("create tables");
  })
  .expect("ddl job");
  Db { engine, id, path }
}

impl Db {
  /// Runs a method on the client connection; `Ok(result)` / `Err(error JSON)`.
  fn call(&self, method: &str, args: Json) -> Result<Json, Json> {
    self.call_on(self.id, method, args)
  }

  fn call_on(&self, id: ConnId, method: &str, args: Json) -> Result<Json, Json> {
    self.call_with(id, method, args, None)
  }

  fn call_with(&self, id: ConnId, method: &str, args: Json, adapter: Option<Json>) -> Result<Json, Json> {
    let engine = Arc::clone(&self.engine);
    let method = method.to_string();
    let args = json!({ "objects": [], "root": args }).to_string();
    let adapter = adapter.map(|a| a.to_string());
    worker::call(id, move |session| {
      match engine.call_json(&NoHost, &method, &args, adapter.as_deref(), session) {
        Ok(text) => Ok(serde_json::from_str(&text).expect("result JSON")),
        Err(e) => Err(e.to_json()),
      }
    })
    .expect("job")
  }

  fn ok(&self, method: &str, args: Json) -> Json {
    self.call(method, args.clone()).unwrap_or_else(|e| panic!("{method}({args}) failed: {e}"))
  }

  fn sql(&self, sql: &str) -> Vec<Vec<Json>> {
    let sql = sql.to_string();
    worker::call(self.id, move |session| {
      let conn = session.conn().expect("conn").connection().expect("connection");
      let mut stmt = conn.prepare(&sql).expect("prepare");
      let n = stmt.column_count();
      let rows = stmt
        .query_map([], |row| {
          Ok(
            (0..n)
              .map(|i| match row.get_ref(i).expect("cell") {
                payload_sqlite::rusqlite::types::ValueRef::Null => Json::Null,
                payload_sqlite::rusqlite::types::ValueRef::Integer(i) => json!(i),
                payload_sqlite::rusqlite::types::ValueRef::Real(f) => json!(f),
                payload_sqlite::rusqlite::types::ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                payload_sqlite::rusqlite::types::ValueRef::Blob(_) => json!("<blob>"),
              })
              .collect(),
          )
        })
        .expect("query")
        .collect::<Result<Vec<Vec<Json>>, _>>()
        .expect("rows");
      rows
    })
    .expect("sql job")
  }
}

fn where_eq(field: &str, value: Json) -> Json {
  json!({ field: { "equals": value } })
}

#[test]
fn schema_is_retained_and_matches_the_ts_output() {
  for name in ["relationships", "versions", "fields", "localization"] {
    let Some(fixture) = fixture(name) else { continue };
    for (variant, expected) in fixture["outputs"].as_object().expect("outputs") {
      if variant == "blocksAsJSON" {
        continue;
      }
      let options = json!({ "idType": variant, "autoIncrement": variant == "number" });
      let engine = SqliteEngine::create(&NoHost, &fixture["graph"], &options).expect("create");
      let out = engine.raw_schema_json();
      for key in ["rawTables", "rawRelations", "indexes", "foreignKeys", "fieldConstraints"] {
        assert_eq!(out[key].to_string(), expected["result"][key].to_string(), "{name} [{variant}] {key}");
      }
      // the fixtures store `tableNameMap` as `[key, value]` pairs, like the napi output
      assert_eq!(out["tableNameMap"], expected["result"]["tableNameMap"], "{name} [{variant}] tableNameMap");
    }
  }
}

#[test]
fn relationships_create_find_update_delete() {
  let Some(fixture) = fixture("relationships") else { return };
  let db = open("relationships", &fixture, "number");

  let relation = db.ok("create", json!({ "collection": "relation", "data": { "name": "rel one" } }));
  assert_eq!(relation["name"], "rel one");
  let relation_id = relation["id"].clone();
  assert_eq!(relation_id, json!(1));
  assert!(relation["createdAt"].as_str().is_some_and(|s| s.ends_with('Z')), "{relation}");

  let post = db.ok(
    "create",
    json!({ "collection": "posts", "data": { "title": "first", "description": "d1", "number": 5, "relationField": relation_id } }),
  );
  assert_eq!(post["title"], "first");
  assert_eq!(post["number"], 5);
  assert_eq!(post["relationField"], relation_id);
  let post_id = post["id"].clone();
  db.ok("create", json!({ "collection": "posts", "data": { "title": "second", "number": 7 } }));
  db.ok("create", json!({ "collection": "posts", "data": { "title": "third", "number": 5 } }));

  // find: pagination, sort, where on a relationship (join)
  let found = db.ok("find", json!({ "collection": "posts", "limit": 2, "page": 1, "sort": "-number", "where": {} }));
  assert_eq!(found["totalDocs"], 3);
  assert_eq!(found["totalPages"], 2);
  assert_eq!(found["hasNextPage"], true);
  assert_eq!(found["nextPage"], 2);
  assert_eq!(found["limit"], 2);
  assert_eq!(found["docs"][0]["title"], "second");
  let by_relation = db.ok(
    "find",
    json!({ "collection": "posts", "limit": 10, "where": { "relationField.name": { "equals": "rel one" } } }),
  );
  assert_eq!(by_relation["totalDocs"], 1);
  assert_eq!(by_relation["docs"][0]["id"], post_id);
  // `limit` undefined stays an own `undefined` key
  let unlimited = db.ok("find", json!({ "collection": "posts", "pagination": false, "where": where_eq("number", json!(5)) }));
  assert_eq!(unlimited["limit"], json!({ "$undefined": true }));
  assert_eq!(unlimited["docs"].as_array().map(Vec::len), Some(2));

  let one = db.ok("findOne", json!({ "collection": "posts", "where": where_eq("title", json!("first")) }));
  assert_eq!(one["id"], post_id);
  let none = db.ok("findOne", json!({ "collection": "posts", "where": where_eq("title", json!("nope")) }));
  assert_eq!(none, Json::Null);

  let counted = db.ok("count", json!({ "collection": "posts", "where": where_eq("number", json!(5)) }));
  assert_eq!(counted, json!({ "totalDocs": 2 }));

  let distinct = db.ok("findDistinct", json!({ "collection": "posts", "field": "number", "sort": "number", "where": {} }));
  assert_eq!(distinct["values"], json!([{ "number": 5 }, { "number": 7 }]));
  assert_eq!(distinct["totalDocs"], 2);
  let paged = db.ok("findDistinct", json!({ "collection": "posts", "field": "title", "sort": "title", "limit": 2, "page": 2 }));
  assert_eq!(paged["values"], json!([{ "title": "third" }]));
  assert_eq!(paged["totalDocs"], 3);
  assert_eq!(paged["prevPage"], 1);

  // updateOne by id and by where (with a join), updateMany
  let updated = db.ok("updateOne", json!({ "collection": "posts", "id": post_id, "data": { "title": "first!" } }));
  assert_eq!(updated["title"], "first!");
  assert_eq!(updated["description"], "d1");
  let by_where = db.ok(
    "updateOne",
    json!({ "collection": "posts", "where": { "relationField.name": { "equals": "rel one" } }, "data": { "description": "via join" } }),
  );
  assert_eq!(by_where["id"], post_id);
  assert_eq!(by_where["description"], "via join");
  let many = db.ok("updateMany", json!({ "collection": "posts", "where": where_eq("number", json!(5)), "data": { "description": "five" } }));
  assert_eq!(many.as_array().map(Vec::len), Some(2));
  assert!(many.as_array().into_iter().flatten().all(|d| d["description"] == "five"));
  let none = db.ok("updateOne", json!({ "collection": "posts", "where": where_eq("title", json!("nope")), "data": { "title": "x" } }));
  assert_eq!(none, Json::Null);
  let returned_null = db.ok("updateOne", json!({ "collection": "posts", "id": post_id, "returning": false, "data": { "number": 6 } }));
  assert_eq!(returned_null, Json::Null);
  assert_eq!(db.sql("select number from posts where id = 1"), vec![vec![json!(6)]]);

  // upsert: creates when nothing matches
  let upserted = db.ok("upsert", json!({ "collection": "posts", "where": where_eq("title", json!("fourth")), "data": { "title": "fourth" } }));
  assert_eq!(upserted["title"], "fourth");
  assert_eq!(db.ok("count", json!({ "collection": "posts" })), json!({ "totalDocs": 4 }));

  // deleteOne returns the deleted doc, deleteMany with a join
  let deleted = db.ok("deleteOne", json!({ "collection": "posts", "where": where_eq("title", json!("second")) }));
  assert_eq!(deleted["title"], "second");
  let gone = db.ok("deleteMany", json!({ "collection": "posts", "where": { "relationField.name": { "equals": "rel one" } } }));
  assert_eq!(gone, json!({ "$undefined": true }));
  assert_eq!(db.ok("count", json!({ "collection": "posts" })), json!({ "totalDocs": 2 }));
}

#[test]
fn unique_violation_is_a_validation_error_and_bad_queries_fail_like_ts() {
  let Some(fixture) = fixture("relationships") else { return };
  let db = open("relationships-errors", &fixture, "number");
  let user = json!({ "collection": "users", "data": { "email": "a@b.c" } });
  db.ok("create", user.clone());
  let err = db.call("create", user).expect_err("duplicate email");
  assert_eq!(err["name"], "ValidationError", "{err}");
  assert_eq!(err["message"], "The following field is invalid: email");
  // the unique-violation message is left to TS (`req.t`)
  assert_eq!(err["data"]["errors"], json!([{ "path": "email", "tableName": "users" }]));
  assert_eq!(err["data"]["collection"], "users");

  // a failed statement crosses the boundary as drizzle's DrizzleQueryError
  db.sql("drop table relation_rels");
  let err = db.call("create", json!({ "collection": "relation", "data": { "name": "x" } })).expect_err("missing table");
  let boundary = payload_sql_engine::error_json(&payload_engine::error::EngineError {
    name: err["name"].as_str().unwrap_or("").to_string(),
    message: err["message"].as_str().unwrap_or("").to_string(),
    data: Some(err["data"].clone()),
  });
  assert_eq!(boundary["name"], "DrizzleQueryError", "{boundary}");
  assert_eq!(boundary["cause"]["kind"], "sqlite", "{boundary}");
  assert_eq!(boundary["cause"]["code"], "SQLITE_ERROR");
  assert_eq!(boundary["cause"]["message"], "no such table: relation_rels", "{boundary}");
  // the same shape for a failing statement of the write path (payload-sql-upsert's executor)
  db.sql("drop table chained_rels");
  db.sql("drop table chained");
  let err = db.call("create", json!({ "collection": "chained", "data": { "name": "x" } })).expect_err("missing table");
  let boundary = payload_sql_engine::error_json(&payload_engine::error::EngineError {
    name: err["name"].as_str().unwrap_or("").to_string(),
    message: err["message"].as_str().unwrap_or("").to_string(),
    data: Some(err["data"].clone()),
  });
  assert_eq!(boundary["name"], "DrizzleQueryError", "{boundary}");
  assert!(boundary["query"].as_str().is_some_and(|q| q.starts_with("insert into \"chained\"")), "{boundary}");
  assert_eq!(boundary["cause"], json!({ "code": "SQLITE_ERROR", "kind": "sqlite", "message": "no such table: chained", "rawCode": 1 }));

  let err = db.call("find", json!({ "collection": "posts", "where": { "nope": { "equals": 1 } } })).expect_err("unknown path");
  // drizzle's getTableColumnFromPath throws an APIError (payload's QueryError comes from validation)
  assert_eq!(err, json!({ "name": "APIError", "message": "Cannot find field for path at nope", "data": null }));
  let err = db.call("find", json!({ "collection": "missing" })).expect_err("unknown collection");
  assert_eq!(err["name"], "TypeError", "{err}");
  let err = db.call("nope", json!({})).expect_err("unknown method");
  assert_eq!(err["name"], "Error");
}

#[test]
fn user_values_shaped_like_markers_are_data() {
  let Some(fixture) = fixture("versions") else { return };
  let db = open("versions-markers", &fixture, "number");
  let forged = json!({ "$obj": { "$undefined": true } });
  let created = db.ok(
    "create",
    json!({ "collection": "autosave-posts", "data": { "title": "t", "description": "d", "json": forged, "richText": { "$obj": { "$num": "NaN" } } } }),
  );
  // the result is in the engine encoding: user objects with reserved keys are `$obj`-escaped
  assert_eq!(created["json"], forged, "{created}");
  assert_eq!(created["richText"], json!({ "$obj": { "$num": "NaN" } }));
  assert_eq!(db.sql("select json, rich_text from autosave_posts"), vec![vec![json!(r#"{"$undefined":true}"#), json!(r#"{"$num":"NaN"}"#)]]);
}

#[test]
fn versions_drafts_and_globals() {
  let Some(fixture) = fixture("versions") else { return };
  let db = open("versions", &fixture, "number");

  let post = db.ok("create", json!({ "collection": "draft-posts", "data": { "title": { "en": "draft" }, "description": "d", "_status": "draft" } }));
  let parent = post["id"].clone();
  let version = |description: &str, updated_at: &str| {
    json!({
      "collectionSlug": "draft-posts",
      "parent": parent,
      "autosave": false,
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": updated_at,
      "publishedLocale": { "$undefined": true },
      "snapshot": { "$undefined": true },
      "versionData": { "description": description, "_status": "draft", "id": parent },
    })
  };
  let v1 = db.ok("createVersion", version("v1", "2025-01-01T00:00:01.000Z"));
  assert_eq!(v1["latest"], true, "{v1}");
  assert_eq!(v1["version"]["description"], "v1");
  let v2 = db.ok("createVersion", version("v2", "2025-01-01T00:00:02.000Z"));
  // the older version is no longer `latest`
  assert_eq!(db.sql(&format!("select latest from _draft_posts_v where id = {}", v1["id"])), vec![vec![json!(0)]]);

  let drafts = db.ok("queryDrafts", json!({ "collection": "draft-posts", "where": {} }));
  assert_eq!(drafts["totalDocs"], 1);
  assert_eq!(drafts["docs"][0]["id"], parent);
  assert_eq!(drafts["docs"][0]["description"], "v2");

  let versions = db.ok("findVersions", json!({ "collection": "draft-posts", "sort": "-updatedAt", "where": where_eq("parent", parent.clone()) }));
  assert_eq!(versions["totalDocs"], 2);
  assert_eq!(versions["docs"][0]["id"], v2["id"]);
  assert_eq!(db.ok("countVersions", json!({ "collection": "draft-posts" })), json!({ "totalDocs": 2 }));

  let renamed = db.ok("updateVersion", json!({ "collection": "draft-posts", "id": v1["id"], "versionData": { "version": { "description": "v1!" } } }));
  assert_eq!(renamed["version"]["description"], "v1!", "{renamed}");

  let deleted = db.ok("deleteVersions", json!({ "collection": "draft-posts", "where": where_eq("id", v1["id"].clone()) }));
  assert_eq!(deleted.as_array().map(Vec::len), Some(1));
  assert_eq!(db.ok("countVersions", json!({ "collection": "draft-posts" })), json!({ "totalDocs": 1 }));
  let err = db.call("deleteVersions", json!({ "where": {} })).expect_err("no target");
  assert_eq!(err, json!({ "name": "APIError", "message": "Either collection or globalSlug must be passed.", "data": null }));

  // globals
  let empty = db.ok("findGlobal", json!({ "slug": "draft-global" }));
  assert_eq!(empty, json!({}));
  let created = db.ok("createGlobal", json!({ "slug": "draft-global", "data": { "title": { "en": "g1" } } }));
  assert_eq!(created["globalType"], "draft-global", "{created}");
  let updated = db.ok("updateGlobal", json!({ "slug": "draft-global", "data": { "title": { "en": "g2" } } }));
  assert_eq!(updated["title"]["en"], "g2", "{updated}");
  assert_eq!(updated["id"], created["id"]);
  let found = db.ok("findGlobal", json!({ "slug": "draft-global" }));
  assert_eq!(found["title"]["en"], "g2");
  assert_eq!(found["globalType"], "draft-global");

  let gv = db.ok(
    "createGlobalVersion",
    json!({
      "globalSlug": "draft-global",
      "autosave": false,
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-01-01T00:00:00.000Z",
      "versionData": { "title": { "en": "g2" }, "_status": "draft" },
    }),
  );
  assert_eq!(gv["version"]["title"]["en"], "g2", "{gv}");
  let gvs = db.ok("findGlobalVersions", json!({ "global": "draft-global", "where": {} }));
  assert_eq!(gvs["totalDocs"], 1);
  assert_eq!(db.ok("countGlobalVersions", json!({ "global": "draft-global" })), json!({ "totalDocs": 1 }));
  let gv2 = db.ok("updateGlobalVersion", json!({ "global": "draft-global", "id": gv["id"], "versionData": { "version": { "title": { "en": "g3" } } } }));
  assert_eq!(gv2["version"]["title"]["en"], "g3", "{gv2}");
}

#[test]
fn engine_sql_runs_inside_the_callers_transaction() {
  let Some(fixture) = fixture("relationships") else { return };
  let db = open("relationships-tx", &fixture, "number");
  let tx = worker::call(db.id, |session| session.begin_transaction("write", payload_sqlite::IntMode::Number))
    .expect("job")
    .expect("begin");
  db.call_on(tx, "create", json!({ "collection": "relation", "data": { "name": "in tx" } })).expect("create in tx");
  // visible inside the transaction
  let inside = db.call_on(tx, "count", json!({ "collection": "relation" })).expect("count in tx");
  assert_eq!(inside, json!({ "totalDocs": 1 }));
  worker::call(tx, |session| session.conn().expect("conn").exec("ROLLBACK")).expect("job").expect("rollback");
  worker::call(tx, |session| session.retire_finished_transaction()).expect("job");
  assert_eq!(db.ok("count", json!({ "collection": "relation" })), json!({ "totalDocs": 0 }));
}

#[test]
fn errors_cross_the_boundary_in_the_contract_shapes() {
  use payload_engine::error::EngineError;
  use payload_sql_engine::error_json;
  let query = EngineError::new("QueryError", "The following path cannot be queried: x")
    .with_data(json!({ "status": 400, "data": [{ "path": "x" }] }));
  assert_eq!(error_json(&query), json!({ "name": "QueryError", "message": "The following path cannot be queried: x", "data": [{ "path": "x" }] }));
  let api = EngineError::api("Invalid path").with_data(json!({ "status": 400 }));
  assert_eq!(error_json(&api), json!({ "name": "APIError", "message": "Invalid path", "data": null, "status": 400 }));
  let plain = EngineError::api("Not supported");
  assert_eq!(error_json(&plain), json!({ "name": "APIError", "message": "Not supported", "data": null }));
}

#[test]
fn adapter_properties_are_read_at_call_time() {
  let Some(fixture) = fixture("relationships") else { return };
  let db = open("relationships-adapter", &fixture, "number");
  let data = json!({ "collection": "relation", "data": { "id": 9999, "name": "explicit" } });
  // `payload.db.allowIDOnCreate = true` on the live adapter
  let created = db.call_with(db.id, "create", data.clone(), Some(json!({ "allowIDOnCreate": true }))).expect("create");
  assert_eq!(created["id"], 9999);
  let created = db.call_with(db.id, "create", data, Some(json!({ "allowIDOnCreate": false }))).expect("create");
  assert_eq!(created["id"], 10000);

  // `now` is the caller's clock (fake timers): createdAt / updatedAt stamps use it
  let now = 1_700_000_000_123.0;
  let created = db
    .call_with(db.id, "create", json!({ "collection": "relation", "data": { "name": "clock" } }), Some(json!({ "now": now })))
    .expect("create");
  assert_eq!(created["createdAt"], "2023-11-14T22:13:20.123Z", "{created}");
  assert_eq!(created["updatedAt"], "2023-11-14T22:13:20.123Z", "{created}");
}

/// Drives stepped calls like the napi binding under `Promise.all`: every call's first step runs
/// when it is started (in start order), later steps round-robin (one microtask each).
fn run_concurrently(db: &Db, calls: Vec<(&str, Json)>) -> Vec<Result<Json, Json>> {
  use payload_sql_engine::stepped::{Step, SteppedCall};
  let mut results: Vec<Option<Result<Json, Json>>> = calls.iter().map(|_| None).collect();
  let mut queue = std::collections::VecDeque::new();
  let mut ops = Vec::new();
  for (method, args) in calls {
    let args = json!({ "objects": [], "root": args }).to_string();
    ops.push(SteppedCall::start(Arc::clone(&db.engine), method.to_string(), args, None, db.id));
  }
  for i in 0..ops.len() {
    queue.push_back(i);
  }
  while let Some(i) = queue.pop_front() {
    match ops[i].resume(&NoHost) {
      Step::Yielded => queue.push_back(i),
      Step::Done(result) => {
        results[i] = Some(result.map(|text| serde_json::from_str(&text).expect("result JSON")).map_err(|e| e.to_json()));
      }
    }
  }
  results.into_iter().map(|r| r.expect("finished")).collect()
}

/// test/queues "parallel tasks that complete immediately": concurrent `updateJobs` `$push`es to
/// one job's log. With libsql every `upsertRow` statement of every call runs before any call's
/// read-back (the awaits interleave round-robin), so every result already has all entries; run as
/// atomic calls, the k-th call would only see k entries.
#[test]
fn stepped_calls_interleave_at_statement_granularity() {
  let Some(fixture) = fixture("versions") else { return };
  let db = open("versions-stepped", &fixture, "number");
  let job = db.ok("create", json!({ "collection": "payload-jobs", "data": { "input": {}, "queue": "default" } }));
  let push = |i: usize| {
    (
      "updateJobs",
      json!({
        "id": job["id"],
        "data": { "log": { "$push": {
          "id": format!("{i:024x}"),
          "executedAt": "2025-01-01T00:00:00.000Z",
          "completedAt": "2025-01-01T00:00:00.000Z",
          "taskSlug": "inline",
          "taskID": format!("task {i}"),
          "input": {},
          "state": "succeeded",
        } } },
      }),
    )
  };
  let results = run_concurrently(&db, (0..3).map(push).collect());
  for result in &results {
    let docs = result.as_ref().unwrap_or_else(|e| panic!("updateJobs failed: {e}"));
    assert_eq!(docs[0]["log"].as_array().map(Vec::len), Some(3), "{docs}");
  }
  assert_eq!(db.sql("select count(*) from payload_jobs_log"), vec![vec![json!(3)]]);

  // the same calls one after another (atomic, as single jobs) see 4, 5 and 6 entries
  let sequential: Vec<usize> = (3..6)
    .map(|i| {
      let (method, args) = push(i);
      db.ok(method, args)[0]["log"].as_array().map(Vec::len).unwrap_or(0)
    })
    .collect();
  assert_eq!(sequential, vec![4, 5, 6]);
}

/// libsql runs statements that return rows with `stmt.all()`: an error while stepping them is the
/// raw native error (`kind: 'native'`), other statements fail with a `SqliteError` cause.
#[test]
fn failed_write_statements_have_libsqls_error_kind() {
  let Some(fixture) = fixture("versions") else { return };
  let db = open("versions-error-kind", &fixture, "number");
  let err = db.call("create", json!({ "collection": "text", "data": {} })).expect_err("NOT NULL");
  let boundary = payload_sql_engine::error_json(&payload_engine::error::EngineError {
    name: err["name"].as_str().expect("name").to_string(),
    message: err["message"].as_str().expect("message").to_string(),
    data: err.get("data").cloned(),
  });
  assert_eq!(boundary["name"], "DrizzleQueryError", "{boundary}");
  assert!(boundary["query"].as_str().is_some_and(|q| q.starts_with("insert into \"text\"") && q.contains(" returning ")), "{boundary}");
  assert_eq!(
    boundary["cause"],
    json!({ "code": "SQLITE_CONSTRAINT_NOTNULL", "kind": "native", "message": "NOT NULL constraint failed: text.text", "rawCode": 1299 })
  );
}

/// `updateGlobal` without a global row creates it through `upsertRow`, which sets the caller's
/// `data.createdAt`; the call reports it with `withMutations`.
#[test]
fn update_global_reports_the_created_at_mutation() {
  let Some(fixture) = fixture("versions") else { return };
  let db = open("versions-mutations", &fixture, "number");
  let context = Some(json!({ "now": 1_700_000_000_123.0, "withMutations": true }));
  let args = json!({ "slug": "draft-global", "data": { "title": { "en": "g1" } } });
  let created = db.call_with(db.id, "updateGlobal", args.clone(), context.clone()).expect("create path");
  assert_eq!(created["mutations"], json!([[["data", "createdAt"], "2023-11-14T22:13:20.123Z"]]), "{created}");
  assert_eq!(created["result"]["globalType"], "draft-global");
  let updated = db.call_with(db.id, "updateGlobal", args, context).expect("update path");
  assert_eq!(updated["mutations"], json!([]), "{updated}");
  // without `withMutations` the result is the plain return value
  let plain = db.ok("updateGlobal", json!({ "slug": "draft-global", "data": { "title": { "en": "g2" } } }));
  assert_eq!(plain["globalType"], "draft-global");
}

/// `describeDrizzleSchema` (test/__rs/find/harness.ts) output for a schema without hooks.
fn describe(schema: &payload_sql_find::schema::DrizzleSchema) -> Json {
  use payload_sql_find::schema::{Decoder, RelationKind};
  let mut out = serde_json::Map::new();
  for (ts_name, table) in &schema.tables {
    let mut columns = serde_json::Map::new();
    for (key, column) in &table.columns {
      let column_type = match column.decoder {
        Decoder::Boolean => "SQLiteBoolean",
        Decoder::Json => "SQLiteTextJson",
        Decoder::Number => "SQLiteNumericNumber",
        Decoder::NumericString => "SQLiteNumeric",
        Decoder::NumericBigInt => "SQLiteNumericBigInt",
        _ => "SQLiteText",
      };
      columns.insert(
        key.clone(),
        json!({ "name": column.name, "columnType": column_type, "sqlType": column.sql_type, "primary": column.primary }),
      );
    }
    let mut relations = serde_json::Map::new();
    for (key, relation) in &table.relations {
      let mut r = json!({
        "referencedTable": relation.referenced_table,
        "relationName": relation.relation_name,
        "sourceTable": relation.source_table,
      });
      match &relation.kind {
        RelationKind::One { fields, references } => {
          r["type"] = json!("one");
          r["fields"] = json!(fields);
          r["references"] = json!(references);
        }
        RelationKind::Many => r["type"] = json!("many"),
        RelationKind::OneWithoutConfig => r["type"] = json!("one-no-config"),
      }
      relations.insert(key.clone(), r);
    }
    out.insert(ts_name.clone(), json!({ "columns": columns, "dbName": table.db_name, "relations": relations }));
  }
  Json::Object(out)
}

/// A host whose function 7 is a custom column's `fromDriver`.
struct DecodingHost;

impl payload_engine::host::Host for DecodingHost {
  fn call(&self, id: u32, arg: &Json) -> payload_engine::error::Result<payload_engine::js::JsVal> {
    assert_eq!(id, 7);
    Ok(payload_engine::js::JsVal::str(format!("decoded:{}", arg.as_str().unwrap_or("?"))))
  }
}

/// Schema hooks can change drizzle columns (`afterSchemaInit`); with the live schema the engine
/// decodes a custom column through its `fromDriver` (a JS function, called on the driver's
/// thread during the step).
#[test]
fn live_schema_columns_and_custom_decoders() {
  use payload_sql_engine::stepped::{Step, SteppedCall};
  let Some(fixture) = fixture("relationships") else { return };
  let mut db = open("relationships-live", &fixture, "number");
  let mut description = describe(db.engine.drizzle_schema());
  assert_eq!(
    &payload_sql_find::schema::DrizzleSchema::from_json(&description).expect("from_json"),
    db.engine.drizzle_schema(),
    "describe(from_raw) round-trips"
  );
  db.ok("create", json!({ "collection": "relation", "data": { "name": "x" } }));
  description["relation"]["columns"]["name"] =
    json!({ "name": "name", "columnType": "SQLiteCustomColumn", "sqlType": "text", "fromDriver": 7 });
  Arc::get_mut(&mut db.engine).expect("no calls in flight").set_live_schema(&json!({ "drizzle": description })).expect("set");

  let args = json!({ "objects": [], "root": { "collection": "relation", "where": {} } }).to_string();
  let op = SteppedCall::start(Arc::clone(&db.engine), "find".into(), args, None, db.id);
  let result = loop {
    match op.resume(&DecodingHost) {
      Step::Yielded => continue,
      Step::Done(result) => break result.expect("find"),
    }
  };
  let result: Json = serde_json::from_str(&result).expect("result JSON");
  assert_eq!(result["docs"][0]["name"], "decoded:x", "{result}");
}

/// Runs a stepped call to completion with `host`.
fn finish(op: &payload_sql_engine::stepped::SteppedCall, host: &dyn payload_engine::host::Host) -> Result<Json, Json> {
  use payload_sql_engine::stepped::Step;
  loop {
    match op.resume(host) {
      Step::Yielded => continue,
      Step::Done(result) => {
        return result.map(|text| serde_json::from_str(&text).expect("result JSON")).map_err(|e| e.to_json());
      }
    }
  }
}

/// The reviewer's scenario: a call on the client (no transaction) whose client connection is
/// taken by a transaction begun between two of its steps (`Promise.all([find, create])`, where the
/// create begins its transaction). libsql's `client.execute` resolves `#getDb()` per statement, so
/// the TS method continues on the client's new connection; the call must finish like that, and
/// the transaction stays usable.
#[test]
fn a_transaction_begun_between_steps_does_not_fail_the_call() {
  use payload_sql_engine::stepped::{Step, SteppedCall};
  let Some(fixture) = fixture("versions") else { return };
  let db = open("versions-tx-between-steps", &fixture, "number");
  let job = db.ok("create", json!({ "collection": "payload-jobs", "data": { "input": {}, "queue": "default" } }));
  let calls = [
    ("find", json!({ "collection": "payload-jobs", "where": where_eq("queue", json!("default")) }), "write"),
    ("count", json!({ "collection": "payload-jobs" }), "write"),
    // a deferred transaction takes no lock until its first statement, so the update can write
    ("updateOne", json!({ "collection": "payload-jobs", "id": job["id"], "data": { "queue": "other" } }), "deferred"),
  ];
  for (method, args, mode) in calls {
    let expected = db.ok(method, args.clone());
    let encoded = json!({ "objects": [], "root": args }).to_string();
    let op = SteppedCall::start(Arc::clone(&db.engine), method.to_string(), encoded, None, db.id);
    assert!(matches!(op.resume(&NoHost), Step::Yielded), "{method}: the first statement ends the first step");
    let mode = mode.to_string();
    let tx = worker::call(db.id, move |session| session.begin_transaction(&mode, payload_sqlite::IntMode::Number))
      .expect("job")
      .expect("begin");
    let result = finish(&op, &NoHost).unwrap_or_else(|e| panic!("{method} failed after a transaction began: {e}"));
    let strip = |v: &Json| {
      let mut v = v.clone();
      for doc in v["docs"].as_array_mut().into_iter().flatten() {
        if let Some(o) = doc.as_object_mut() {
          o.remove("updatedAt");
        }
      }
      if let Some(o) = v.as_object_mut() {
        o.remove("updatedAt");
      }
      v
    };
    assert_eq!(strip(&result), strip(&expected), "{method}");
    // the transaction is unaffected by the call
    db.call_on(tx, "count", json!({ "collection": "payload-jobs" })).expect("count in tx");
    worker::call(tx, |session| session.conn().expect("conn").exec("ROLLBACK")).expect("job").expect("rollback");
    worker::call(tx, |session| session.retire_finished_transaction()).expect("job");
  }
}

/// A host function that makes a blocking client call while a step waits for it (TS
/// `sqliteExecuteSync` from a custom column's `fromDriver`) runs: no statement holds the queue
/// between statements.
#[test]
fn host_functions_can_use_the_queue_during_a_step() {
  use payload_sql_engine::stepped::SteppedCall;
  struct QueueUsingHost {
    id: ConnId,
  }
  impl payload_engine::host::Host for QueueUsingHost {
    fn call(&self, id: u32, arg: &Json) -> payload_engine::error::Result<payload_engine::js::JsVal> {
      assert_eq!(id, 7);
      let rows = worker::call(self.id, |session| session.conn().expect("conn").execute_sql("select 41 + 1", payload_sqlite::IntMode::Number))
        .expect("job")
        .expect("select");
      Ok(payload_engine::js::JsVal::str(format!("{}:{:?}", arg.as_str().unwrap_or("?"), rows.rows[0][0])))
    }
  }
  let Some(fixture) = fixture("relationships") else { return };
  let mut db = open("relationships-host-queue", &fixture, "number");
  let mut description = describe(db.engine.drizzle_schema());
  db.ok("create", json!({ "collection": "relation", "data": { "name": "x" } }));
  description["relation"]["columns"]["name"] =
    json!({ "name": "name", "columnType": "SQLiteCustomColumn", "sqlType": "text", "fromDriver": 7 });
  Arc::get_mut(&mut db.engine).expect("no calls in flight").set_live_schema(&json!({ "drizzle": description })).expect("set");
  let engine = Arc::clone(&db.engine);
  let id = db.id;
  let (done, finished) = std::sync::mpsc::channel();
  std::thread::spawn(move || {
    let args = json!({ "objects": [], "root": { "collection": "relation", "where": {} } }).to_string();
    let op = SteppedCall::start(engine, "find".into(), args, None, id);
    let _ = done.send(finish(&op, &QueueUsingHost { id }));
  });
  let result = finished.recv_timeout(std::time::Duration::from_secs(30)).expect("the call deadlocked").expect("find");
  assert_eq!(result["docs"][0]["name"], "x:Number(42.0)", "{result}");
}

/// Statements of one `upsertRow` are separate steps (TS awaits each): two concurrent updates that
/// replace the same document's array both delete the rows first, then both insert theirs, so both
/// read-backs see both rows. With the update / delete / insert run back to back in one step the
/// second call's delete would remove the first call's row before either reads.
#[test]
fn upsert_row_statements_interleave_with_concurrent_calls() {
  let Some(fixture) = fixture("versions") else { return };
  let db = open("versions-upsert-interleave", &fixture, "number");
  let job = db.ok("create", json!({ "collection": "payload-jobs", "data": { "input": {}, "queue": "default" } }));
  let update = |i: usize| {
    (
      "updateOne",
      json!({
        "collection": "payload-jobs",
        "id": job["id"],
        "data": { "log": [{
          "id": format!("{i:024x}"),
          "executedAt": "2025-01-01T00:00:00.000Z",
          "completedAt": "2025-01-01T00:00:00.000Z",
          "taskSlug": "inline",
          "taskID": format!("task {i}"),
          "input": {},
          "state": "succeeded",
        }] },
      }),
    )
  };
  let results = run_concurrently(&db, vec![update(1), update(2)]);
  for result in &results {
    let doc = result.as_ref().unwrap_or_else(|e| panic!("updateOne failed: {e}"));
    let ids: Vec<&str> = doc["log"].as_array().into_iter().flatten().filter_map(|row| row["id"].as_str()).collect();
    assert_eq!(ids, vec![format!("{:024x}", 1), format!("{:024x}", 2)], "{doc}");
  }
  // run one after another, the second update replaces the first one's row
  let (method, args) = update(3);
  assert_eq!(db.ok(method, args)["log"].as_array().map(Vec::len), Some(1));
}
