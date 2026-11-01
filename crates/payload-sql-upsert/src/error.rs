//! Port of packages/drizzle/src/upsertRow/handleUpsertError.ts (SQLite branch).

use payload_engine::error::EngineError;
use payload_engine::js::JsVal;
use crate::sql::Schema;
use payload_sql_write::encode_value;
use serde_json::{Value as Json, json};

use crate::sql::ExecError;

/// Context of the upsert for error reporting.
#[derive(Clone, Debug, Default)]
pub struct ErrorContext {
  /// `id` of the upsert (`undefined` when absent).
  pub id: JsVal,
  pub collection_slug: Option<String>,
  pub global_slug: Option<String>,
  /// `req.t('error:valueMustBeUnique')` when a request with `t` is available.
  pub value_must_be_unique: Option<String>,
  /// `req.t('error:followingFieldsInvalid', { count: 1 })` when available.
  pub following_fields_invalid: Option<String>,
}

/// Extracts `table`, `field` from `UNIQUE constraint failed: table.field[, ...]`
/// (`/UNIQUE constraint failed: ([^.]+)\.([^.,]+)/`).
fn match_unique_message(message: &str) -> Option<(String, String)> {
  let needle = "UNIQUE constraint failed: ";
  let start = message.find(needle)? + needle.len();
  let rest = &message[start..];
  // ([^.]+) is greedy then backtracks to the first `.` followed by [^.,]+
  let dot = rest.find('.')?;
  let table = &rest[..dot];
  if table.is_empty() {
    return None;
  }
  let after = &rest[dot + 1..];
  let end = after.find(['.', ',']).unwrap_or(after.len());
  let field = &after[..end];
  if field.is_empty() {
    return None;
  }
  Some((table.to_string(), field.to_string()))
}

/// `handleUpsertError`: unique constraint violations become a
/// `ValidationError`, everything else is re-thrown unchanged.
pub fn handle_upsert_error(schema: Schema<'_>, table_name: &str, ctx: &ErrorContext, error: ExecError) -> EngineError {
  let db = match error {
    ExecError::Db(db) => db,
    ExecError::Engine(e) => return e,
  };
  if db.code != "SQLITE_CONSTRAINT_UNIQUE" {
    return db.to_engine_error();
  }
  let mut field_name: Option<String> = None;
  if let Some((_, field)) = match_unique_message(&db.message) {
    if let Some(constraints) = schema.field_constraints.get(table_name) {
      field_name = constraints.get(&format!("{field}_idx")).cloned();
    }
    if field_name.is_none() {
      field_name = Some(field);
    }
  }
  let message = ctx.value_must_be_unique.clone().unwrap_or_else(|| "Value must be unique".to_string());
  let mut data = serde_json::Map::new();
  data.insert("id".into(), encode_value(&ctx.id));
  if let Some(c) = &ctx.collection_slug {
    data.insert("collection".into(), Json::String(c.clone()));
  }
  data.insert(
    "errors".into(),
    json!([{ "message": message, "path": field_name, "tableName": table_name }]),
  );
  if let Some(g) = &ctx.global_slug {
    data.insert("global".into(), Json::String(g.clone()));
  }
  let prefix = ctx.following_fields_invalid.clone().unwrap_or_else(|| "The following field is invalid:".to_string());
  let label = field_name.clone().unwrap_or_else(|| "null".to_string());
  EngineError::new("ValidationError", format!("{prefix} {label}")).with_data(Json::Object(data))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_unique_message() {
    assert_eq!(
      match_unique_message("SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: posts.slug"),
      Some(("posts".into(), "slug".into()))
    );
    assert_eq!(
      match_unique_message("UNIQUE constraint failed: posts_locales.title, posts_locales._locale"),
      Some(("posts_locales".into(), "title".into()))
    );
  }
}

#[cfg(test)]
mod db_tests {
  use indexmap::IndexMap;
  use payload_engine::sql::schema::{RawSchema, RawTable};
  use payload_engine::js::JsVal;
  use payload_sql_write::RowValue;
  use rusqlite::Connection;
  use serde_json::{Map, json};

  use super::*;
  use crate::sql::{Executor, require_table};

  #[test]
  fn unique_violation_becomes_validation_error() {
    let conn = Connection::open_in_memory().unwrap();
    conn
      .execute_batch("create table posts (id integer primary key, slug text); create unique index posts_slug_idx on posts (slug);")
      .unwrap();
    let mut schema = RawSchema::default();
    let columns: Map<String, Json> = serde_json::from_value(json!({
      "id": { "name": "id", "type": "integer", "primaryKey": true },
      "slug": { "name": "slug", "type": "varchar" },
    }))
    .unwrap();
    schema.raw_tables.insert(
      "posts".into(),
      Some(RawTable { name: "posts".into(), columns, foreign_keys: Map::new(), indexes: Map::new() }),
    );
    schema.field_constraints.insert("posts".into(), IndexMap::from([("slug_idx".to_string(), "slug".to_string())]));
    let t = require_table((&schema).into(), "posts").unwrap();
    let mut exec = Executor::new(&conn);
    let row: payload_sql_write::Row = [("slug".to_string(), RowValue::Value(JsVal::str("a")))].into_iter().collect();
    exec.insert(t, std::slice::from_ref(&row), None).unwrap();
    let err = exec.insert(t, std::slice::from_ref(&row), None).unwrap_err();
    let ctx = ErrorContext { id: JsVal::Undefined, collection_slug: Some("posts".into()), ..Default::default() };
    let e = handle_upsert_error((&schema).into(), "posts", &ctx, err);
    assert_eq!(e.name, "ValidationError");
    assert_eq!(
      e.data.unwrap(),
      json!({ "id": { "$undefined": true }, "collection": "posts", "errors": [{ "message": "Value must be unique", "path": "slug", "tableName": "posts" }] })
    );
    assert_eq!(exec.statements[0].sql, "insert into \"posts\" (\"id\", \"slug\") values (null, ?) returning \"id\", \"slug\"");
  }
}
