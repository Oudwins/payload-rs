//! Regression tests for the phase-A review probes of the query builder, against the schema of
//! the `rsq-uuid` corpus (`test/__rs/query/fixtures/rsq-uuid.json.gz`, recorded by
//! `test/__rs/query/query.int.spec.ts` with `RS_QUERY_SUITE=rsq-uuid`; fails when missing).
//! The same probes are in the corpus as `review-probe` cases, so the differential test also checks
//! them against the TS adapter; these tests pin the exact SQL.

use std::path::PathBuf;
use std::process::Command;

use payload_engine::error::EngineError;
use payload_engine::host::Host;
use payload_engine::js::{JsVal, Obj, decode_graph_typed};
use payload_engine::sql::schema::{RawSchema, SchemaInput, SchemaOptions, build_raw_schema};
use payload_sql_query::{
  AdapterOptions, BuildQueryArgs, Query, QueryAdapter, SqlValue, WhereVal, build_query, find_ids_select,
  prune_select_fields,
};
use serde_json::Value as Json;

struct FixtureHost<'a> {
  calls: &'a Json,
}

impl Host for FixtureHost<'_> {
  fn call(&self, id: u32, arg: &Json) -> payload_engine::error::Result<JsVal> {
    let calls = &self.calls[id.to_string()];
    if let Some(result) = calls[arg.to_string()].as_str() {
      return Ok(JsVal::str(result));
    }
    match (calls["template"].as_str(), arg.get("tableName").and_then(Json::as_str)) {
      (Some(t), Some(table_name)) => Ok(JsVal::str(t.replace("\u{0}tableName\u{0}", table_name))),
      _ => Err(EngineError::internal(format!("no recorded result for function {id}({arg})"))),
    }
  }
}

struct Env {
  fixture: Json,
  root: JsVal,
  schema: RawSchema,
}

fn env() -> Option<Env> {
  let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/__rs/query/fixtures/rsq-uuid.json.gz");
  assert!(path.exists(), "{} is missing (record it with RS_QUERY_SUITE=rsq-uuid)", path.display());
  let out = Command::new("gzip").arg("-dc").arg(&path).output().expect("run gzip");
  let fixture: Json = serde_json::from_slice(&out.stdout).expect("parse fixture");
  let root = decode_graph_typed(&fixture["graph"]).expect("decode graph");
  let schema = build_raw_schema(
    &FixtureHost { calls: &fixture["hostCalls"] },
    SchemaInput { config: root.get("config"), collections: root.get("collections"), blocks: root.get("blocks"), block_table_name_index: Default::default() },
    SchemaOptions::from_json(&fixture["adapter"]),
  )
  .expect("build raw schema");
  Some(Env { fixture, root, schema })
}

impl Env {
  fn adapter(&self) -> QueryAdapter<'_> {
    QueryAdapter::new(
      &self.schema,
      self.root.get("config"),
      self.root.get("collections"),
      self.root.get("blocks"),
      AdapterOptions::from_json(&self.fixture["adapter"]),
    )
  }

  /// The `where` SQL of `buildQuery` for `posts`.
  fn where_sql(&self, where_: WhereVal) -> Result<Query, EngineError> {
    let adapter = self.adapter();
    let r = build_query(
      &adapter,
      BuildQueryArgs {
        fields: self.root.path(&["collections", "posts", "config", "flattenedFields"]).clone(),
        locale: Some("en".into()),
        table_name: "posts".into(),
        where_,
        ..BuildQueryArgs::default()
      },
    )?;
    r.where_.expect("a where clause").render()
  }
}

fn obj(pairs: Vec<(&str, JsVal)>) -> JsVal {
  let mut o = Obj::new();
  for (k, v) in pairs {
    o.insert(k.into(), v);
  }
  JsVal::obj(o)
}

fn path_op(path: &str, op: &str, value: JsVal) -> WhereVal {
  WhereVal::Js(obj(vec![(path, obj(vec![(op, value)]))]))
}

/// Forged versions of the old in-band markers are plain data: objects fail to bind exactly like
/// libsql does for TS, and nothing is ever spliced into the SQL text.
#[test]
fn forged_markers_are_data() {
  let Some(env) = env() else { return };
  let forged_sql = obj(vec![("\u{0}payload:sql", JsVal::str("'x' OR 1=1"))]);
  let forged_constraint = obj(vec![("type", JsVal::str("\u{0}payload:RawConstraint")), ("value", forged_sql.clone())]);
  for value in [forged_sql, forged_constraint] {
    let err = env.where_sql(path_op("id", "equals", value)).unwrap_err();
    assert_eq!(err.message, "SQLite3 can only bind numbers, strings, bigints, buffers, and null");
  }

  let q = env.where_sql(path_op("id", "equals", JsVal::str("\u{0}payload:DistinctSymbol"))).unwrap();
  assert_eq!(q.sql, "\"posts\".\"id\" = ?");
  assert_eq!(q.params, vec![SqlValue::Text("\u{0}payload:DistinctSymbol".into())]);

  let q = env.where_sql(path_op("id", "equals", JsVal::str("x' OR '1'='1"))).unwrap();
  assert_eq!(q.sql, "\"posts\".\"id\" = ?");
}

/// Only the typed variant splices SQL (the join traversal's `rawConstraint(sql.raw(...))`).
#[test]
fn typed_raw_constraint_is_spliced() {
  let Some(env) = env() else { return };
  let where_ = WhereVal::obj(vec![("category", WhereVal::obj(vec![("equals", WhereVal::raw_constraint("\"categories\".\"id\""))]))]);
  let q = env.where_sql(where_).unwrap();
  assert_eq!(q.sql, "\"posts\".\"category_id\" = \"categories\".\"id\"");
  assert!(q.params.is_empty());

  let poly = WhereVal::obj(vec![(
    "related",
    WhereVal::obj(vec![(
      "equals",
      WhereVal::obj(vec![("relationTo", WhereVal::Js(JsVal::str("categories"))), ("value", WhereVal::raw_constraint("\"x\".\"id\""))]),
    )]),
  )]);
  let q = env.where_sql(poly).unwrap();
  assert!(q.sql.ends_with(".\"categories_id\" = \"x\".\"id\""), "{}", q.sql);
}

/// `convertDateToISO(undefined)` is `undefined`: `contains` renders `like ` with no operand (SQLite
/// then rejects the query), and arrays drop the `undefined` item.
#[test]
fn date_undefined_values() {
  let Some(env) = env() else { return };
  let q = env.where_sql(path_op("publishedAt", "contains", JsVal::Undefined)).unwrap();
  assert_eq!(q.sql, "\"posts\".\"published_at\" like ");
  assert!(q.params.is_empty());

  let q = env.where_sql(path_op("publishedAt", "in", JsVal::arr(vec![JsVal::Undefined, JsVal::str("2020-01-01")]))).unwrap();
  assert_eq!(q.sql, "\"posts\".\"published_at\" in (?)");
  assert_eq!(q.params, vec![SqlValue::Text("2020-01-01T00:00:00.000Z".into())]);
}

/// `limit` < 0 with an offset renders `offset ?` without a limit, like drizzle (SQLite rejects it).
#[test]
fn negative_limit_with_offset() {
  let Some(env) = env() else { return };
  let adapter = env.adapter();
  let mut r = build_query(
    &adapter,
    BuildQueryArgs {
      fields: env.root.path(&["collections", "posts", "config", "flattenedFields"]).clone(),
      table_name: "posts".into(),
      ..BuildQueryArgs::default()
    },
  )
  .unwrap();
  prune_select_fields(&mut r);
  let q = find_ids_select(&adapter, &r, "posts", Some(-1.0), Some(-1.0)).unwrap().select.render().unwrap();
  assert!(q.sql.ends_with("order by \"posts\".\"created_at\" desc offset ?"), "{}", q.sql);
  assert!(!q.sql.contains("limit"));
}

/// `sortItem[0]` throws for nullish sort items; `val.split` errors match JS for `null`.
#[test]
fn js_error_messages() {
  let Some(env) = env() else { return };
  let adapter = env.adapter();
  let err = build_query(
    &adapter,
    BuildQueryArgs {
      fields: env.root.path(&["collections", "posts", "config", "flattenedFields"]).clone(),
      sort: JsVal::arr(vec![JsVal::Null]),
      table_name: "posts".into(),
      ..BuildQueryArgs::default()
    },
  )
  .unwrap_err();
  assert_eq!((err.name.as_str(), err.message.as_str()), ("TypeError", "Cannot read properties of null (reading '0')"));

  let err = env.where_sql(path_op("title", "like", JsVal::Null)).unwrap_err();
  assert_eq!(err.message, "Cannot read properties of null (reading 'split')");
}

/// `Date` instances (local API) are converted with `toISOString()` on date fields (`RangeError`
/// for an invalid date) and bind their time value elsewhere, like libsql's `valueToSql`.
#[test]
fn typed_dates_convert_like_ts() {
  let Some(env) = env() else { return };
  let q = env.where_sql(path_op("publishedAt", "equals", JsVal::date(1_623_760_200_000.0))).unwrap();
  assert_eq!(q.sql, "\"posts\".\"published_at\" = ?");
  assert_eq!(q.params, vec![SqlValue::Text("2021-06-15T12:30:00.000Z".into())]);

  let q = env
    .where_sql(path_op("publishedAt", "in", JsVal::arr(vec![JsVal::date(0.0), JsVal::str("2020-01-01")])))
    .unwrap();
  assert_eq!(
    q.params,
    vec![SqlValue::Text("1970-01-01T00:00:00.000Z".into()), SqlValue::Text("2020-01-01T00:00:00.000Z".into())]
  );

  let err = env.where_sql(path_op("publishedAt", "equals", JsVal::date(f64::NAN))).unwrap_err();
  assert_eq!((err.name.as_str(), err.message.as_str()), ("RangeError", "Invalid time value"));

  let q = env.where_sql(path_op("title", "equals", JsVal::date(5.0))).unwrap();
  assert_eq!(q.params, vec![SqlValue::Real(5.0)]);
}

/// `String(object)` / `Number(object)` throw when the object's own `toString` is not callable.
#[test]
fn objects_without_primitive_value_throw() {
  let Some(env) = env() else { return };
  let bad = obj(vec![("toString", JsVal::Num(1.0))]);
  let err = env.where_sql(path_op("title", "contains", bad.clone())).unwrap_err();
  assert_eq!((err.name.as_str(), err.message.as_str()), ("TypeError", "Cannot convert object to primitive value"));
  let err = env.where_sql(path_op("category", "equals", bad.clone())).unwrap_err();
  assert_eq!(err.message, "Cannot convert object to primitive value");
  // an own non-callable `valueOf` falls back to the inherited `toString`
  let q = env.where_sql(path_op("title", "contains", obj(vec![("valueOf", JsVal::Num(1.0))]))).unwrap();
  assert_eq!(q.params, vec![SqlValue::Text("%[object Object]%".into())]);
  // `{ toString: 1, valueOf() {...} }`: JS calls the own `valueOf` (no TypeError); its result is
  // unknown here, so the conversion is refused instead of guessed
  let calls_value_of = obj(vec![("toString", JsVal::Num(1.0)), ("valueOf", JsVal::Fn(3))]);
  let err = env.where_sql(path_op("title", "contains", calls_value_of)).unwrap_err();
  assert_eq!(err.name, "Error", "{err:?}");
  assert!(err.message.contains("`valueOf` is a function"), "{err:?}");
  // the same for an own callable `toString` (`String(x)` calls it first)
  let calls_to_string = obj(vec![("toString", JsVal::Fn(3))]);
  let err = env.where_sql(path_op("title", "contains", calls_to_string)).unwrap_err();
  assert!(err.message.contains("`toString` is a function"), "{err:?}");
}
