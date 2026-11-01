//! Differential test against the TS adapter.
//!
//! Replays every case recorded by `test/__rs/query/query.int.spec.ts` (gzipped corpus and
//! database copy in `test/__rs/query/fixtures/<suite>.{json,db}.gz`) through the Rust query
//! builder, in the time zone the corpus was recorded in, and checks:
//! - the `buildQuery` SQL (where, joins, order by, select fields) and bound params, byte for byte
//!   after numbering the random table aliases, for every case kind;
//! - `find` / `versions`: the ordered ids and counts (executed with rusqlite against the database);
//! - `distinct`: findDistinct values and totals;
//! - errors: the same error class (see [`error_class`]).
//!
//! `RS_QUERY_FIXTURES` overrides the fixture directory, `RS_QUERY_SUITE` selects one suite,
//! `RS_QUERY_VERBOSE=1` prints every mismatch.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use payload_engine::error::EngineError;
use payload_engine::host::Host;
use payload_engine::js::{JsVal, decode_graph};
use payload_engine::sql::schema::{SchemaInput, SchemaOptions, build_raw_schema};
use payload_engine::strings::to_snake_case;
use payload_sql_query::paths::get_field_by_path;
use payload_sql_query::{
  AdapterOptions, BuildQueryArgs, BuildQueryResult, IdRows, JoinType, QueryAdapter, Sql, SqlValue, WhereVal,
  build_query, count_select, docs_by_ids_select, find_distinct_select, find_ids_select, js_id_key, ordered_unique_ids,
  prune_select_fields,
};
use rusqlite::types::{Value as DbValue, ValueRef};
use serde_json::{Value as Json, json};

/// Replays the `dbName` / `enumName` function results recorded by the TS spec.
struct FixtureHost<'a> {
  calls: &'a Json,
}

impl Host for FixtureHost<'_> {
  fn call(&self, id: u32, arg: &Json) -> payload_engine::error::Result<JsVal> {
    let calls = &self.calls[id.to_string()];
    if let Some(result) = calls[arg.to_string()].as_str() {
      return Ok(JsVal::str(result));
    }
    let template = calls["template"].as_str().filter(|t| t.matches("\u{0}tableName\u{0}").count() == 1);
    match (template, arg.get("tableName").and_then(Json::as_str)) {
      (Some(t), Some(table_name)) => Ok(JsVal::str(t.replace("\u{0}tableName\u{0}", table_name))),
      _ => Err(EngineError::internal(format!("no recorded result for function {id}({arg})"))),
    }
  }
}

type Failure = (String, String);

const PAYLOAD_ERRORS: &[&str] = &["APIError", "QueryError", "ValidationError", "NotFound"];

fn fixtures_dir() -> PathBuf {
  std::env::var("RS_QUERY_FIXTURES")
    .map(PathBuf::from)
    .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/__rs/query/fixtures"))
}

fn gunzip(path: &Path) -> Vec<u8> {
  let out = Command::new("gzip").arg("-dc").arg(path).output().expect("run gzip");
  assert!(out.status.success(), "gzip -dc {} failed", path.display());
  out.stdout
}

unsafe extern "C" {
  fn tzset();
}

fn set_tz(tz: &str) {
  // SAFETY: the differential test is the only test in this binary.
  unsafe {
    std::env::set_var("TZ", tz);
    tzset();
  }
}

fn to_db(v: &SqlValue) -> DbValue {
  match v {
    SqlValue::Null => DbValue::Null,
    SqlValue::Real(n) => DbValue::Real(*n),
    SqlValue::Text(s) => DbValue::Text(s.clone()),
  }
}

fn cell_to_json(v: ValueRef) -> Json {
  match v {
    ValueRef::Null => Json::Null,
    ValueRef::Integer(i) => Json::from(i),
    ValueRef::Real(f) => payload_engine::js::num_to_json(f),
    ValueRef::Text(t) => Json::String(String::from_utf8_lossy(t).into_owned()),
    ValueRef::Blob(_) => Json::String("<blob>".into()),
  }
}

fn engine_err(e: EngineError) -> Failure {
  (e.name, e.message)
}

fn run_select(conn: &rusqlite::Connection, select: &payload_sql_query::Select) -> Result<Vec<Json>, Failure> {
  let q = select.render().map_err(engine_err)?;
  let fail = |e: rusqlite::Error| ("SqliteError".to_string(), format!("{e}: {}", q.sql));
  let mut stmt = conn.prepare(&q.sql).map_err(fail)?;
  let params: Vec<DbValue> = q.params.iter().map(to_db).collect();
  let rows = stmt.query_map(rusqlite::params_from_iter(params), |row| Ok(cell_to_json(row.get_ref(0)?))).map_err(fail)?;
  rows.collect::<Result<Vec<_>, _>>().map_err(fail)
}

/// Error class used for comparison: Payload errors and plain `Error`s by name + message,
/// database failures (drizzle's `Failed query: ...` wrapper, SQLite errors and libsql bind
/// errors) as one class, other JS errors by constructor name and message.
fn error_class(name: &str, message: &str, from_ts: bool) -> String {
  let is_bind_error = message.starts_with("undefined cannot be passed")
    || message.starts_with("Only finite numbers")
    || message.starts_with("SQLite3 can only bind");
  if (from_ts && message.starts_with("Failed query:")) || (!from_ts && (name == "SqliteError" || is_bind_error)) {
    return "database".into();
  }
  if PAYLOAD_ERRORS.contains(&name) || name == "Error" || name == "TypeError" || name == "RangeError" {
    return format!("{name}: {message}");
  }
  name.to_string()
}

fn ts_error(v: &Json) -> Option<Failure> {
  let err = v.get("error")?;
  Some((
    err.get("name").and_then(Json::as_str).unwrap_or("Error").to_string(),
    err.get("message").and_then(Json::as_str).unwrap_or("").to_string(),
  ))
}

fn errors_match(ts: &Failure, rs: &Failure) -> bool {
  error_class(&ts.0, &ts.1, true) == error_class(&rs.0, &rs.1, false)
}

// ---------------------------------------------------------------------------------------------
// SQL structure comparison

/// Bound params as the TS spec encodes them, or the libsql bind error class.
fn rendered(sql: &Sql) -> Json {
  match sql.render() {
    Ok(q) => json!({ "params": q.params.iter().map(SqlValue::to_json).collect::<Vec<_>>(), "sql": q.sql }),
    Err(e) => json!({ "bindError": e.name }),
  }
}

/// The TS side of [`rendered`]: queries with unbindable params collapse to the bind error class
/// libsql throws for the first one.
fn ts_rendered(q: &Json) -> Json {
  if q.is_null() {
    return Json::Null;
  }
  for p in q["params"].as_array().into_iter().flatten() {
    let tag = if p.get("$num").is_some() {
      "RangeError"
    } else if p.get("$undefined").is_some() {
      "TypeError"
    } else if p.get("$unbindable").is_some() {
      "Error"
    } else {
      continue;
    };
    return json!({ "bindError": tag });
  }
  json!({ "params": q["params"], "sql": q["sql"] })
}

fn join_type_name(t: Option<JoinType>) -> Json {
  match t {
    None => Json::Null,
    Some(JoinType::Inner) => json!("innerJoin"),
    Some(JoinType::Left) => json!("leftJoin"),
    Some(JoinType::Right) => json!("rightJoin"),
  }
}

fn rs_structure(r: &BuildQueryResult) -> Json {
  json!({
    "joins": r.joins.iter().map(|j| json!({
      "alias": j.table.ref_name(),
      "condition": j.condition.as_ref().map(rendered).unwrap_or(Json::Null),
      "many": j.is_one_to_many,
      "path": j.query_path,
      "table": j.table.name,
      "type": join_type_name(j.join_type),
    })).collect::<Vec<_>>(),
    "orderBy": r.order_by.iter().map(|o| rendered(&o.to_sql())).collect::<Vec<_>>(),
    "select": r.select_fields.iter().map(|(k, v)| json!([k, v.as_ref().map(|e| rendered(&payload_sql_query::sql::expr_sql(e))).unwrap_or(Json::Null)])).collect::<Vec<_>>(),
    "where": r.where_.as_ref().map(rendered).unwrap_or(Json::Null),
  })
}

fn ts_structure(s: &Json) -> Json {
  json!({
    "joins": s["joins"].as_array().into_iter().flatten().map(|j| json!({
      "alias": j["alias"],
      "condition": ts_rendered(&j["condition"]),
      "many": j["many"],
      "path": j["path"],
      "table": j["table"],
      "type": j["type"],
    })).collect::<Vec<_>>(),
    "orderBy": s["orderBy"].as_array().into_iter().flatten().map(ts_rendered).collect::<Vec<_>>(),
    "select": s["select"].as_array().into_iter().flatten().map(|e| json!([e[0], ts_rendered(&e[1])])).collect::<Vec<_>>(),
    "where": ts_rendered(&s["where"]),
  })
}

/// Replaces table aliases (snake-cased v4 uuids in TS, `a0000001_0000_4000_8000_…` in Rust) by
/// `$N` in order of first appearance.
fn number_aliases(text: &str) -> String {
  const GROUPS: [usize; 5] = [8, 4, 4, 4, 12];
  let b = text.as_bytes();
  let is_hex = |c: u8| c.is_ascii_digit() || (b'a'..=b'f').contains(&c);
  let alias_at = |i: usize| -> Option<usize> {
    let mut j = i;
    for (g, len) in GROUPS.iter().enumerate() {
      if g > 0 {
        if b.get(j) != Some(&b'_') {
          return None;
        }
        j += 1;
      }
      if j + len > b.len() || !b[j..j + len].iter().all(|c| is_hex(*c)) {
        return None;
      }
      j += len;
    }
    Some(j)
  };
  let mut seen: Vec<String> = Vec::new();
  let mut out = String::with_capacity(text.len());
  let mut i = 0;
  while i < b.len() {
    let boundary = i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_');
    if boundary {
      if let Some(end) = alias_at(i) {
        let alias = &text[i..end];
        let n = seen.iter().position(|a| a == alias).unwrap_or_else(|| {
          seen.push(alias.to_string());
          seen.len() - 1
        });
        out.push_str(&format!("${n}"));
        i = end;
        continue;
      }
    }
    let ch = text[i..].chars().next().unwrap_or('\0');
    out.push(ch);
    i += ch.len_utf8().max(1);
  }
  out
}

fn compare_sql(ts: &Json, rs: &Result<BuildQueryResult, EngineError>) -> Result<(), String> {
  match (ts_error(ts), rs) {
    (Some(t), Err(e)) => {
      let r = (e.name.clone(), e.message.clone());
      if errors_match(&t, &r) { Ok(()) } else { Err(format!("ts error {t:?} / rs error {r:?}")) }
    }
    (Some(t), Ok(_)) => Err(format!("ts error {t:?} / rs ok")),
    (None, Err(e)) => Err(format!("ts ok / rs error {}: {}", e.name, e.message)),
    (None, Ok(r)) => {
      let a = number_aliases(&ts_structure(ts).to_string());
      let b = number_aliases(&rs_structure(r).to_string());
      if a == b { Ok(()) } else { Err(format!("sql differs\n    ts={a}\n    rs={b}")) }
    }
  }
}

// ---------------------------------------------------------------------------------------------

#[derive(Default)]
struct Stats {
  total: usize,
  matched: usize,
  by_source: BTreeMap<String, (usize, usize)>,
  examples: Vec<String>,
}

impl Stats {
  fn record(&mut self, source: &str, result: Result<(), String>, context: impl FnOnce() -> String) {
    self.total += 1;
    let entry = self.by_source.entry(source.to_string()).or_default();
    entry.0 += 1;
    match result {
      Ok(()) => {
        self.matched += 1;
        entry.1 += 1;
      }
      Err(detail) => {
        if self.examples.len() < 40 || std::env::var("RS_QUERY_VERBOSE").is_ok() {
          self.examples.push(format!("{}\n  {detail}", context()));
        }
      }
    }
  }
}

fn outcome_check<T: PartialEq + std::fmt::Debug>(ts: &Json, key: &str, rs: Result<T, Failure>, from: impl Fn(&Json) -> Option<T>) -> Result<(), String> {
  match (ts_error(ts), rs) {
    (Some(t), Err(r)) => if errors_match(&t, &r) { Ok(()) } else { Err(format!("ts error {t:?} / rs error {r:?}")) },
    (Some(t), Ok(v)) => Err(format!("ts error {t:?} / rs {v:?}")),
    (None, Err(r)) => Err(format!("ts {} / rs error {r:?}", ts[key])),
    (None, Ok(v)) => match from(&ts[key]) {
      Some(t) if t == v => Ok(()),
      t => Err(format!("ts {t:?} / rs {v:?}")),
    },
  }
}

/// payload `getFieldByPath({ config, fields, includeRelationships: true, path })`: like
/// [`get_field_by_path`], continuing into the related collection after a single-collection
/// relationship.
fn field_through_relationships<'a>(collections: &'a JsVal, fields: &'a JsVal, path: &str) -> Option<&'a JsVal> {
  if let Some(field) = get_field_by_path(fields, path) {
    return Some(field);
  }
  let segments: Vec<&str> = path.split('.').collect();
  for i in 1..segments.len() {
    let head = segments[..i].join(".");
    let Some(field) = get_field_by_path(fields, &head) else { continue };
    if matches!(field.get("type").as_str(), Some("relationship" | "upload")) {
      if let Some(relation_to) = field.get("relationTo").as_str() {
        let related = collections.get(relation_to).get("config").get("flattenedFields");
        return field_through_relationships(collections, related, &segments[i..].join("."));
      }
    }
  }
  None
}

fn decode(v: Option<&Json>) -> JsVal {
  v.map(|v| decode_graph(v).expect("decode engine value")).unwrap_or(JsVal::Undefined)
}

struct TempFile(PathBuf);

impl Drop for TempFile {
  fn drop(&mut self) {
    let _ = std::fs::remove_file(&self.0);
  }
}

#[test]
fn differential_against_ts_adapter() {
  let dir = fixtures_dir();
  let Ok(entries) = std::fs::read_dir(&dir) else {
    eprintln!("no fixtures in {}; run test/__rs/query/query.int.spec.ts first", dir.display());
    return;
  };
  let mut files: Vec<PathBuf> = entries
    .filter_map(|e| e.ok().map(|e| e.path()))
    .filter(|p| p.to_string_lossy().ends_with(".json.gz"))
    .collect();
  files.sort();
  if let Ok(only) = std::env::var("RS_QUERY_SUITE") {
    files.retain(|p| p.file_name().is_some_and(|n| n.to_string_lossy() == format!("{only}.json.gz")));
  }

  let mut grand_total = 0;
  let mut grand_matched = 0;
  for file in files {
    let fixture: Json = serde_json::from_slice(&gunzip(&file)).expect("parse fixture");
    let suite = fixture["suite"].as_str().unwrap_or("?").to_string();
    let tz = fixture["tz"].as_str().unwrap_or("UTC").to_string();
    set_tz(&tz);

    let db_gz = dir.join(format!("{suite}.db.gz"));
    let db_file = TempFile(std::env::temp_dir().join(format!("rsq-diff-{}-{suite}.db", std::process::id())));
    std::fs::File::create(&db_file.0).and_then(|mut f| f.write_all(&gunzip(&db_gz))).expect("write database copy");
    let conn = rusqlite::Connection::open_with_flags(&db_file.0, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).expect("open database");

    let root = decode_graph(&fixture["graph"]).expect("decode graph");
    let (config, collections, blocks) = (root.get("config"), root.get("collections"), root.get("blocks"));
    let version_fields = root.get("versionFields");
    let schema = build_raw_schema(
      &FixtureHost { calls: &fixture["hostCalls"] },
      SchemaInput { config, collections, blocks, block_table_name_index: Default::default() },
      SchemaOptions::from_json(&fixture["adapter"]),
    )
    .expect("build raw schema");

    // The Rust schema must match the TS adapter state this corpus ran against.
    for (k, v) in fixture["tableNameMap"].as_object().expect("tableNameMap") {
      assert_eq!(schema.table_name_map.get(k).map(String::as_str), v.as_str(), "{suite}: tableNameMap[{k}]");
    }
    for name in fixture["tableNames"].as_array().expect("tableNames") {
      let name = name.as_str().unwrap_or_default();
      assert!(schema.raw_tables.get(name).is_some_and(|t| t.is_some()), "{suite}: missing raw table {name}");
    }

    let adapter = QueryAdapter::new(&schema, config, collections, blocks, AdapterOptions::from_json(&fixture["adapter"]));
    let versions_suffix = adapter.opts.versions_suffix.clone();
    let mut stats = Stats::default();

    for case in fixture["cases"].as_array().expect("cases") {
      let kind = case["kind"].as_str().unwrap_or("find");
      let slug = case["collection"].as_str().unwrap_or_default();
      let source = case["source"].as_str().unwrap_or("?");
      let collection_config = collections.get(slug).get("config");
      let is_versions = kind == "versions";
      let fields = if is_versions { version_fields.get(slug).clone() } else { collection_config.get("flattenedFields").clone() };
      let table_key = if is_versions { format!("_{}{versions_suffix}", to_snake_case(slug)) } else { to_snake_case(slug) };
      let table_name = schema.table_name_map.get(&table_key).cloned().unwrap_or_default();
      let where_js = decode(case.get("w"));
      let sort_arg = decode(case.get("s"));
      let locale = case.get("locale").and_then(Json::as_str).map(str::to_string);
      let sort = if sort_arg.is_nullish() { collection_config.get("defaultSort").clone() } else { sort_arg.clone() };
      let context = || {
        format!(
          "[{suite}/{slug}] {kind}/{source} where={} sort={} locale={locale:?} field={}",
          case.get("w").map(|w| w["root"].to_string()).unwrap_or_default(),
          case.get("s").map(|s| s["root"].to_string()).unwrap_or_default(),
          case["field"]
        )
      };

      let base = BuildQueryArgs { fields: fields.clone(), locale: locale.clone(), table_name: table_name.clone(), ..BuildQueryArgs::default() };

      match kind {
        "find" | "versions" => {
          let args = BuildQueryArgs { sort: sort.clone(), where_: where_js.clone().into(), ..base.clone() };
          let built = build_query(&adapter, args.clone());
          stats.record(&format!("{kind}:sql"), compare_sql(&case["sql"], &built), context);

          let limit_arg = case["limit"].as_f64().unwrap_or(0.0);
          let page = case["page"].as_f64().unwrap_or(1.0);
          let offset = (page - 1.0) * limit_arg;
          let limit = if limit_arg == 0.0 { None } else { Some(limit_arg) };
          let rs = (|| {
            let mut result = build_query(&adapter, args.clone()).map_err(engine_err)?;
            prune_select_fields(&mut result);
            let plan = find_ids_select(&adapter, &result, &table_name, limit, Some(offset)).map_err(engine_err)?;
            let rows = run_select(&conn, &plan.select)?;
            Ok(match plan.rows {
              IdRows::Ordered => rows,
              IdRows::Distinct => {
                let keys: Vec<String> = rows.iter().map(|v| js_id_key(&JsVal::from_json(v))).collect();
                let order = ordered_unique_ids(&keys);
                if order.is_empty() {
                  Vec::new()
                } else {
                  let docs = run_select(&conn, &docs_by_ids_select(&adapter, &table_name, &order).map_err(engine_err)?)?;
                  let mut docs: Vec<(usize, Json)> = docs
                    .into_iter()
                    .map(|id| (order.iter().position(|k| *k == js_id_key(&JsVal::from_json(&id))).unwrap_or(usize::MAX), id))
                    .collect();
                  docs.sort_by_key(|(i, _)| *i);
                  docs.into_iter().map(|(_, id)| id).collect()
                }
              }
            })
          })();
          stats.record(source, outcome_check(&case["result"], "ids", rs, |v| v.as_array().cloned()), context);

          if !case["count"].is_null() {
            let rs = (|| {
              let result = build_query(&adapter, BuildQueryArgs { sort: JsVal::Undefined, ..args.clone() }).map_err(engine_err)?;
              let select = count_select(&adapter, None, &result.joins, result.where_.as_ref(), &table_name).map_err(engine_err)?;
              Ok(run_select(&conn, &select)?.first().and_then(Json::as_f64).unwrap_or(0.0))
            })();
            stats.record(&format!("{kind}:count"), outcome_check(&case["count"], "totalDocs", rs, Json::as_f64), context);
          }
        }
        "aliased" => {
          let built = adapter.get_table_alias(Some(&table_name)).and_then(|(alias, _)| {
            build_query(
              &adapter,
              BuildQueryArgs { alias_table: Some(alias), select_locale: true, sort: sort.clone(), where_: where_js.clone().into(), ..base.clone() },
            )
          });
          stats.record("aliased:sql", compare_sql(&case["sql"], &built), context);
        }
        "raw" => {
          let raw = WhereVal::raw_constraint(case["rawSql"].as_str().unwrap_or_default());
          let value = match case["rawPoly"].as_str() {
            Some(relation_to) => WhereVal::obj(vec![("relationTo", WhereVal::Js(JsVal::str(relation_to))), ("value", raw)]),
            None => raw,
          };
          let operator = case["rawOperator"].as_str().unwrap_or("equals");
          let mut where_ = WhereVal::obj(vec![(case["rawOn"].as_str().unwrap_or_default(), WhereVal::obj(vec![(operator, value)]))]);
          if where_js.as_obj().is_some_and(|o| !o.is_empty()) {
            where_ = WhereVal::obj(vec![("and", WhereVal::Arr(vec![where_, WhereVal::Js(where_js.clone())]))]);
          }
          let built = adapter.get_table_alias(Some(&table_name)).and_then(|(alias, _)| {
            build_query(&adapter, BuildQueryArgs { alias_table: Some(alias), select_locale: true, sort: sort_arg.clone(), where_, ..base.clone() })
          });
          stats.record(&format!("raw:{operator}:sql"), compare_sql(&case["sql"], &built), context);
        }
        "distinct" => {
          let field = case["field"].as_str().unwrap_or_default();
          let user_where = if where_js.is_nullish() { WhereVal::Js(JsVal::obj(Default::default())) } else { WhereVal::Js(where_js.clone()) };
          let where_ = WhereVal::obj(vec![(
            "and",
            WhereVal::Arr(vec![user_where, WhereVal::obj(vec![(field, WhereVal::obj(vec![("equals", WhereVal::Distinct)]))])]),
          )]);
          let distinct_sort = if sort_arg.is_nullish() { JsVal::str(field) } else { sort_arg.clone() };
          let args = BuildQueryArgs { sort: distinct_sort, where_, ..base.clone() };
          let built = build_query(&adapter, args.clone());
          stats.record("distinct:sql", compare_sql(&case["sql"], &built), context);

          let limit = case["limit"].as_f64();
          let page = case["page"].as_f64();
          let is_polymorphic = field_through_relationships(collections, &fields, field).is_some_and(|f| f.get("relationTo").as_arr().is_some());
          let rs = (|| {
            let result = build_query(&adapter, args.clone()).map_err(engine_err)?;
            let plan_selected = result.select_fields.get("_selected").cloned().flatten();
            let plan = find_distinct_select(&adapter, result, &table_name, limit, page).map_err(engine_err)?;
            let mut values = run_select(&conn, &plan.select)?;
            // drizzle decodes `_selected` with its column's `mapFromDriverValue`.
            if let Some(payload_sql_query::Expr::Col(col)) = &plan_selected {
              for v in &mut values {
                *v = col.map_from_driver_value(JsVal::from_json(v)).map_err(engine_err)?.to_json();
              }
            }
            if is_polymorphic {
              for v in &mut values {
                let parsed: Json = v.as_str().and_then(|s| serde_json::from_str(s).ok()).unwrap_or(Json::Null);
                let found = parsed.as_object().and_then(|o| o.iter().find(|(_, v)| JsVal::from_json(v).truthy()));
                *v = match found {
                  Some((relation_to, value)) => json!({ "relationTo": relation_to, "value": value }),
                  None => Json::Null,
                };
              }
            }
            let total = match &plan.count {
              Some(count) => run_select(&conn, count)?.first().and_then(Json::as_f64).unwrap_or(0.0),
              None => values.len() as f64,
            };
            Ok(json!({ "totalDocs": total, "values": values }))
          })();
          let rs = rs.map(|v| v.to_string());
          stats.record(
            "distinct",
            outcome_check(&case["result"], "values", rs, |_| {
              Some(json!({ "totalDocs": case["result"]["totalDocs"].as_f64(), "values": case["result"]["values"] }).to_string())
            }),
            context,
          );
        }
        other => panic!("unknown case kind {other}"),
      }
    }

    println!("== {suite} (TZ={tz}): {}/{} matched", stats.matched, stats.total);
    for (source, (total, matched)) in &stats.by_source {
      println!("   {source:28} {matched}/{total}");
    }
    for e in &stats.examples {
      println!("{e}");
    }
    grand_total += stats.total;
    grand_matched += stats.matched;
  }

  println!("== TOTAL: {grand_matched}/{grand_total} matched");
  assert_eq!(grand_matched, grand_total, "differential mismatches (see output above)");
}
