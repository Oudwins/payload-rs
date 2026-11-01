//! Pins the drizzle behaviours fixed after the find review (reverse one-to-one
//! relations, `findFirst` returning `undefined`, column decoders,
//! `DrizzleQueryError` wrapping, `Object.keys` semantics of polymorphic join
//! filters, transaction visibility through `payload-sqlite` ids). Expected
//! values were taken from drizzle-orm 0.45 / Node 24; the differential suite
//! test/__rs/find/suites/drizzle-columns checks the same cases against the live TS.

use payload_engine::error::Result;
use payload_engine::host::Host;
use payload_engine::js::{JsVal, TypedValue};
use payload_sql_find::args::QueryConfig;
use payload_sql_find::exec::{
  Driver, Executor, LibsqlConn, QueuedConn, decode_js, execute_js, query_cells, string_to_bigint,
};
use payload_sql_find::relational::{Mode, build_relational_query};
use payload_sql_find::schema::{Decoder, DrizzleSchema};
use payload_sql_find::sql::Sql;
use payload_sql_find::utils::{js_for_in_entries, js_object_entries, js_object_keys_len};
use payload_sqlite::worker;
use payload_sqlite::{Cell, Conn, IntMode};
use serde_json::json;

struct NoCalls;

impl Host for NoCalls {
  fn call(&self, id: u32, arg: &serde_json::Value) -> Result<JsVal> {
    Ok(JsVal::str(format!("host:{id}:{arg}")))
  }
}

fn schema() -> DrizzleSchema {
  DrizzleSchema::from_json(&json!({
    "posts": {
      "dbName": "posts",
      "columns": {
        "id": { "name": "id", "columnType": "SQLiteInteger", "sqlType": "integer" },
        "when": { "name": "when_sec", "columnType": "SQLiteTimestamp", "sqlType": "integer", "mode": "timestamp" },
        "big": { "name": "big", "columnType": "SQLiteNumericBigInt", "sqlType": "numeric" }
      },
      "relations": {
        "profile": { "type": "one-no-config", "sourceTable": "posts", "referencedTable": "profiles" }
      }
    },
    "profiles": {
      "dbName": "profiles",
      "columns": {
        "id": { "name": "id", "columnType": "SQLiteInteger", "sqlType": "integer" },
        "postId": { "name": "post_id", "columnType": "SQLiteInteger", "sqlType": "integer" }
      },
      "relations": {
        "post": {
          "type": "one", "sourceTable": "profiles", "referencedTable": "posts",
          "fields": ["post_id"], "references": ["id"]
        }
      }
    }
  }))
  .expect("schema")
}

fn memory_conn() -> Conn {
  let conn = Conn::open(":memory:").expect("open");
  conn
    .connection()
    .expect("connection")
    .execute_batch(
      "create table posts (id integer primary key, when_sec integer, big numeric);
       create table profiles (id integer primary key, post_id integer);
       insert into posts (id, when_sec, big) values (1, 1700000000, 12), (2, null, null);
       insert into profiles (id, post_id) values (10, 1);",
    )
    .expect("fixture");
  conn
}

#[test]
fn reverse_one_to_one_is_an_object_or_null() {
  let schema = schema();
  let conn = memory_conn();
  let exec = LibsqlConn { conn: &conn, in_transaction: false, int_mode: IntMode::Number };
  let config = QueryConfig::from_json(&json!({
    "columns": { "id": true },
    "with": { "profile": true },
    "orderBy": [{ "column": "id", "order": "asc" }]
  }))
  .expect("config");
  let built = build_relational_query(&schema, "posts", &config, Mode::Many).expect("build");
  assert_eq!(
    built.sql.sql,
    "select \"id\", (select json_array(\"id\", \"post_id\") as \"data\" from (select * from \"profiles\" \"posts_profile\" where \"posts_profile\".\"post_id\" = \"posts\".\"id\" limit ?) \"posts_profile\") as \"profile\" from \"posts\" \"posts\" order by \"posts\".\"id\" asc"
  );
  let rows = execute_js(&exec, &built, Mode::Many, &NoCalls).expect("rows").to_json();
  assert_eq!(rows, json!([{ "id": 1, "profile": { "id": 10, "postId": 1 } }, { "id": 2, "profile": null }]));
}

#[test]
fn empty_find_first_is_undefined_and_bigint_numeric_reads_as_text() {
  let schema = schema();
  let conn = memory_conn();
  let exec = LibsqlConn { conn: &conn, in_transaction: false, int_mode: IntMode::Number };
  let mut config = QueryConfig::default();
  config.where_ = Some(Sql { sql: "\"posts\".\"id\" = ?".into(), params: vec![json!(-1)] });
  let built = build_relational_query(&schema, "posts", &config, Mode::First).expect("build");
  assert!(execute_js(&exec, &built, Mode::First, &NoCalls).expect("first").is_undefined());

  config.where_ = Some(Sql { sql: "\"posts\".\"id\" = ?".into(), params: vec![json!(1)] });
  let built = build_relational_query(&schema, "posts", &config, Mode::First).expect("build");
  assert!(built.sql.sql.starts_with("select \"id\", \"when_sec\", cast(\"big\" as text) from "));
  let row = execute_js(&exec, &built, Mode::First, &NoCalls).expect("first");
  assert_eq!(row.get("when").typed(), Some(TypedValue::Date(1.7e12)));
  assert_eq!(row.get("big").typed(), Some(TypedValue::BigInt("12".into())));
}

fn decoded(decoder: Decoder, value: Driver) -> std::result::Result<JsVal, (String, String)> {
  decode_js(decoder, value, &NoCalls).map_err(|e| (e.name, e.message))
}

#[test]
fn column_decoders_follow_drizzle() {
  let js = |v: JsVal| Driver::Js(v);
  let typed = |r: std::result::Result<JsVal, (String, String)>| r.expect("decoded").typed();
  assert_eq!(typed(decoded(Decoder::Timestamp, js(JsVal::str("12")))), Some(TypedValue::Date(12_000.0)));
  assert_eq!(
    typed(decoded(Decoder::TimestampMs, js(JsVal::str("2024-01-02T03:04:05Z")))),
    Some(TypedValue::Date(1_704_164_645_000.0))
  );
  // TimeClip: out of range -> Invalid Date
  assert!(matches!(typed(decoded(Decoder::TimestampMs, js(JsVal::Num(9e15)))), Some(TypedValue::Date(t)) if t.is_nan()));
  assert_eq!(
    decoded(Decoder::Timestamp, js(JsVal::bigint("1"))).err(),
    Some(("TypeError".into(), "Cannot mix BigInt and other types, use explicit conversions".into()))
  );
  assert!(matches!(decoded(Decoder::Boolean, js(JsVal::str("1"))), Ok(JsVal::Bool(true))));
  assert!(matches!(decoded(Decoder::Boolean, js(JsVal::str("yes"))), Ok(JsVal::Bool(false))));
  assert_eq!(typed(decoded(Decoder::BlobBigInt, Driver::Blob(b" 0x1F ".to_vec()))), Some(TypedValue::BigInt("31".into())));
  assert_eq!(typed(decoded(Decoder::NumericBigInt, js(JsVal::Num(1e21)))), Some(TypedValue::BigInt("1000000000000000000000".into())));
  assert_eq!(
    decoded(Decoder::NumericBigInt, js(JsVal::Num(1.5))).err(),
    Some(("RangeError".into(), "The number 1.5 cannot be converted to a BigInt because it is not an integer".into()))
  );
  assert_eq!(
    decoded(Decoder::NumericBigInt, js(JsVal::str("9.87654321098765e+19"))).err(),
    Some(("SyntaxError".into(), "Cannot convert 9.87654321098765e+19 to a BigInt".into()))
  );
  assert_eq!(
    decoded(Decoder::BlobBuffer, Driver::Blob(vec![0, 255])).map(|v| v.to_json()).ok(),
    Some(json!({ "type": "Buffer", "data": [0, 255] }))
  );
  assert_eq!(
    decoded(Decoder::BlobJson, js(JsVal::Num(5.0))).err(),
    Some((
      "TypeError".into(),
      "The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received type number (5)".into()
    ))
  );
  assert_eq!(
    decoded(Decoder::BlobJson, js(JsVal::str("{\"a\":1}"))).map(|v| v.to_json()).ok(),
    Some(json!({ "a": 1 }))
  );
  assert_eq!(decoded(Decoder::NumericString, js(JsVal::Num(1.5))).map(|v| v.to_json()).ok(), Some(json!("1.5")));
  assert!(matches!(decoded(Decoder::Number, js(JsVal::str("x"))), Ok(JsVal::Num(n)) if n.is_nan()));
  assert_eq!(
    decoded(Decoder::Custom(Some(3)), js(JsVal::str("x"))).map(|v| v.to_json()).ok(),
    Some(json!("host:3:\"x\""))
  );
  assert_eq!(decoded(Decoder::Custom(None), js(JsVal::Num(7.0))).map(|v| v.to_json()).ok(), Some(json!(7)));
  assert_eq!(Decoder::from_column("SQLiteTimestamp", Some("timestamp_ms"), None), Decoder::TimestampMs);
  assert_eq!(Decoder::from_column("SQLiteCustomColumn", None, Some(4)), Decoder::Custom(Some(4)));
}

#[test]
fn string_to_bigint_follows_ecmascript() {
  assert_eq!(string_to_bigint("").as_deref(), Some("0"));
  assert_eq!(string_to_bigint(" -0 ").as_deref(), Some("0"));
  assert_eq!(string_to_bigint("+12").as_deref(), Some("12"));
  assert_eq!(string_to_bigint("0b101").as_deref(), Some("5"));
  assert_eq!(string_to_bigint("0xffffffffffffffffffffffff").as_deref(), Some("79228162514264337593543950335"));
  assert_eq!(string_to_bigint("-0x1"), None);
  assert_eq!(string_to_bigint("1.5"), None);
  assert_eq!(string_to_bigint("1e3"), None);
}

#[test]
fn driver_errors_are_drizzle_query_errors() {
  let conn = memory_conn();
  let exec = LibsqlConn { conn: &conn, in_transaction: false, int_mode: IntMode::Number };
  let sql = Sql { sql: "select * from missing where a = ? and b = ?".into(), params: vec![json!(1), json!(null), json!("x")] };
  let err = query_cells(&exec, &sql).expect_err("missing table");
  assert_eq!(err.name, "DrizzleQueryError");
  assert_eq!(err.message, "Failed query: select * from missing where a = ? and b = ?\nparams: 1,,x");
  assert_eq!(
    err.data,
    Some(json!({
      "query": "select * from missing where a = ? and b = ?",
      "params": [1, null, "x"],
      "cause": { "kind": "sqlite", "message": "no such table: missing", "code": "SQLITE_ERROR", "rawCode": 1 }
    }))
  );

  let unsafe_int = Sql::raw("select 9007199254740993");
  let err = query_cells(&exec, &unsafe_int).expect_err("unsafe integer");
  assert_eq!(
    err.data.as_ref().and_then(|d| d.get("cause")).cloned(),
    Some(json!({ "kind": "RangeError", "message": "Received integer which cannot be safely represented as a JavaScript number" }))
  );

  let object_param = Sql { sql: "select ?".into(), params: vec![json!({ "a": 1 })] };
  let err = query_cells(&exec, &object_param).expect_err("object param");
  assert_eq!(err.message, "Failed query: select ?\nparams: [object Object]");
  assert_eq!(
    err.data.as_ref().and_then(|d| d.get("cause")).cloned(),
    Some(json!({ "kind": "Error", "message": "SQLite3 can only bind numbers, strings, bigints, buffers, and null" }))
  );
}

#[test]
fn object_keys_semantics() {
  assert_eq!(
    js_object_entries(&JsVal::Null).map_err(|e| e.message).err().as_deref(),
    Some("Cannot convert undefined or null to object")
  );
  assert!(js_object_entries(&JsVal::Undefined).is_err());
  assert!(js_for_in_entries(&JsVal::Null).is_empty());
  let keys: Vec<(String, String)> =
    js_for_in_entries(&JsVal::str("ab")).into_iter().map(|(k, v)| (k, v.to_js_string())).collect();
  assert_eq!(keys, vec![("0".into(), "a".into()), ("1".into(), "b".into())]);
  assert_eq!(js_object_entries(&JsVal::Num(5.0)).map(|e| e.len()).ok(), Some(0));
  assert_eq!(js_object_keys_len(&JsVal::arr(vec![JsVal::Null])), 1);
}

#[test]
fn queued_transaction_ids_see_uncommitted_rows() {
  let path = std::env::temp_dir().join(format!("rs-find-unit-{}.db", std::process::id()));
  let path_str = path.to_string_lossy().to_string();
  let client = worker::open_client(&path_str).expect("client");
  let setup = QueuedConn { id: client, int_mode: IntMode::Number };
  setup.query_cells(&Sql::raw("create table t (a integer)")).expect("create");
  let tx = worker::call(client, |session| session.begin_transaction("write", IntMode::Number)).expect("call").expect("begin");
  let in_tx = QueuedConn { id: tx, int_mode: IntMode::Number };
  in_tx.query_cells(&Sql::raw("insert into t (a) values (1), (2), (3)")).expect("insert");

  let count = |exec: &QueuedConn| query_cells(exec, &Sql::raw("select count(*) from t")).expect("count");
  assert_eq!(count(&in_tx), vec![vec![Cell::Number(3.0)]]);
  assert_eq!(count(&setup), vec![vec![Cell::Number(0.0)]]);

  in_tx.query_cells(&Sql::raw("commit")).expect("commit");
  assert_eq!(count(&setup), vec![vec![Cell::Number(3.0)]]);
  let closed = in_tx.query_cells(&Sql::raw("select 1")).expect_err("closed");
  assert_eq!(closed.js_message(), "TRANSACTION_CLOSED: The transaction is closed");

  worker::release(tx);
  worker::release(client);
  let _ = std::fs::remove_file(&path);
}
