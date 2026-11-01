//! Ports of `sqlite/createJSONQuery/index.ts`, `sqlite/createJSONQuery/convertPathToJSONTraversal.ts`,
//! `utilities/escapeSQLValue.ts`, `utilities/sanitizePathSegment.ts` and
//! `utilities/parseJSONPathSegment.ts`.

use payload_engine::error::{EngineError, Result};
use payload_engine::js::JsVal;
use serde_json::json;

use crate::js_ops::{is_word_char, js_string};

fn api_400(message: impl Into<String>) -> EngineError {
  EngineError::api(message).with_data(json!({ "status": 400 }))
}

/// `SAFE_STRING_REGEX = /^[\w @.\-+:]*$/`
fn is_safe_string(s: &str) -> bool {
  s.chars().all(|c| is_word_char(c) || matches!(c, ' ' | '@' | '.' | '-' | '+' | ':'))
}

/// `escapeSQLValue(value)`
pub fn escape_sql_value(value: &JsVal) -> Result<JsVal> {
  match value {
    JsVal::Null => Ok(JsVal::Null),
    JsVal::Num(_) | JsVal::Bool(_) => Ok(value.clone()),
    JsVal::Str(s) => {
      if !is_safe_string(s) {
        return Err(api_400(format!("{s} is not allowed as a JSON query value")));
      }
      Ok(JsVal::str(s.replace('\\', "\\\\").replace('"', "\\\"")))
    }
    _ => Err(EngineError::internal("Invalid value type")),
  }
}

/// `sanitizePathSegment(segment)`; `None` mirrors `undefined` (which passes the regex as "undefined").
pub fn sanitize_path_segment(segment: Option<&str>) -> Result<String> {
  let s = segment.unwrap_or("undefined");
  if s.is_empty() || !s.chars().all(is_word_char) {
    return Err(api_400("Invalid path segment. Only alphanumeric characters and underscores are permitted."));
  }
  Ok(s.to_string())
}

/// `convertPathToJSONTraversal(incomingSegments)` (SQLite)
pub fn convert_path_to_json_traversal(incoming: &[String]) -> Result<String> {
  let segments = incoming.get(1..).unwrap_or(&[]);
  let mut res = String::new();
  for (i, segment) in segments.iter().enumerate() {
    let sanitized = sanitize_path_segment(Some(segment))?;
    let formatted = if sanitized.chars().all(|c| c.is_ascii_digit()) { sanitized } else { format!("'{sanitized}'") };
    let is_last = i == segments.len() - 1;
    res.push_str(if is_last { "->>" } else { "->" });
    res.push_str(&formatted);
  }
  Ok(res)
}

/// `column` argument of `createJSONQuery`.
#[derive(Clone, Debug)]
pub enum JsonColumn {
  /// A raw column string.
  Raw(String),
  /// A drizzle column, rendered as `"name"`.
  Named(String),
}

pub struct CreateJsonQueryArgs<'a> {
  pub column: Option<JsonColumn>,
  pub operator: &'a str,
  pub path_segments: Vec<String>,
  pub table: Option<String>,
  pub treat_as_array: Option<Vec<String>>,
  pub treat_root_as_array: bool,
  pub value: JsVal,
}

fn seg(segments: &[String], i: usize) -> Option<&str> {
  segments.get(i).map(String::as_str)
}

fn from_array(operator: &str, path_segments: &[String], table: &str, treat_as_array: Option<Vec<String>>, value: JsVal) -> Result<String> {
  let new_path_segments: Vec<String> = path_segments.get(1..).unwrap_or(&[]).to_vec();
  let sanitized_segment = sanitize_path_segment(seg(path_segments, 1))?;
  let alias = format!("{sanitized_segment}_alias_{}", new_path_segments.len());
  let root = sanitize_path_segment(seg(path_segments, 0))?;
  let inner = create_json_query(CreateJsonQueryArgs {
    column: None,
    operator,
    path_segments: new_path_segments,
    table: Some(alias.clone()),
    treat_as_array,
    treat_root_as_array: false,
    value,
  })?;
  Ok(format!(
    "EXISTS (\n    SELECT 1\n    FROM json_each({table}.{root}) AS {alias}\n    WHERE {inner}\n  )"
  ))
}

fn create_constraint(alias: Option<&str>, operator: &str, path_segments: &[String], root_column: Option<String>, value: &JsVal) -> Result<String> {
  let first = seg(path_segments, 0).unwrap_or("undefined");
  let new_alias = format!("{first}_alias_{}", path_segments.len() as i64 - 1);
  let alias = alias.unwrap_or("undefined");
  let mut operator = operator.to_string();
  let mut value = value.clone();
  if operator == "exists" && matches!(value, JsVal::Bool(false)) {
    operator = "not_exists".into();
    value = JsVal::Bool(true);
  } else if operator == "not_exists" && matches!(value, JsVal::Bool(false)) {
    operator = "exists".into();
    value = JsVal::Bool(true);
  }
  let root = |root_column: &Option<String>| -> Result<String> {
    Ok(match root_column {
      Some(c) => c.clone(),
      None => format!("\"{}\"", sanitize_path_segment(seg(path_segments, 0))?),
    })
  };

  if operator == "exists" || operator == "not_exists" {
    let not = if operator == "not_exists" { "NOT " } else { "" };
    if path_segments.len() == 1 {
      return Ok(format!("{not}EXISTS (SELECT 1 FROM json_each({}) AS {new_alias})", root(&root_column)?));
    }
    let s0 = sanitize_path_segment(seg(path_segments, 0))?;
    let s1 = sanitize_path_segment(seg(path_segments, 1))?;
    return Ok(format!(
      "{not}EXISTS (\n      SELECT 1\n      FROM json_each({alias}.value -> '{s0}') AS {new_alias}\n      WHERE {new_alias}.key = '{s1}'\n    )"
    ));
  }

  let mut formatted_value = crate::js_ops::js_string_checked(&escape_sql_value(&value)?)?;
  let mut formatted_operator = operator.clone();
  if operator == "contains" || operator == "like" {
    formatted_operator = "like".into();
    formatted_value = format!("%{}%", js_string(&value));
  } else if operator == "not_like" || operator == "notlike" {
    formatted_operator = "not like".into();
    formatted_value = format!("%{}%", js_string(&value));
  } else if operator == "equals" {
    formatted_operator = "=".into();
  }

  if path_segments.len() == 1 {
    return Ok(format!(
      "EXISTS (SELECT 1 FROM json_each({}) AS {new_alias} WHERE {new_alias}.value {formatted_operator} '{formatted_value}')",
      root(&root_column)?
    ));
  }
  let s0 = sanitize_path_segment(seg(path_segments, 0))?;
  let s1 = sanitize_path_segment(seg(path_segments, 1))?;
  Ok(format!(
    "EXISTS (\n  SELECT 1\n  FROM json_each({alias}.value -> '{s0}') AS {new_alias}\n  WHERE COALESCE({new_alias}.value ->> '{s1}', '') {formatted_operator} '{formatted_value}'\n  )"
  ))
}

/// `createJSONQuery(args)` (SQLite)
pub fn create_json_query(args: CreateJsonQueryArgs) -> Result<String> {
  if (args.operator == "in" || args.operator == "not_in") && args.value.as_arr().is_some() {
    let items = args.value.as_arr().unwrap_or(&[]);
    let mut out = String::new();
    for (i, v) in items.iter().enumerate() {
      let part = create_json_query(CreateJsonQueryArgs {
        column: args.column.clone(),
        operator: if args.operator == "in" { "equals" } else { "not_equals" },
        path_segments: args.path_segments.clone(),
        table: args.table.clone(),
        treat_as_array: args.treat_as_array.clone(),
        treat_root_as_array: args.treat_root_as_array,
        value: v.clone(),
      })?;
      let sep = if i == items.len() - 1 {
        String::new()
      } else {
        format!(" {} ", if args.operator == "in" { "OR" } else { "AND" })
      };
      out = format!("{out}{part} {sep}");
    }
    return Ok(format!("({out})"));
  }

  let second = seg(&args.path_segments, 1);
  if let (Some(treat), Some(table)) = (&args.treat_as_array, &args.table) {
    if !table.is_empty() && second.is_some_and(|s| treat.iter().any(|t| t == s)) {
      return from_array(args.operator, &args.path_segments, table, args.treat_as_array.clone(), args.value);
    }
  }

  let root_column = args.column.map(|c| match c {
    JsonColumn::Raw(s) => s,
    JsonColumn::Named(name) => format!("\"{name}\""),
  });
  create_constraint(args.table.as_deref(), args.operator, &args.path_segments, root_column, &args.value)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn traversal() {
    let segs: Vec<String> = ["data", "a", "0", "b"].iter().map(|s| s.to_string()).collect();
    assert_eq!(convert_path_to_json_traversal(&segs).unwrap(), "->'a'->0->>'b'");
    assert!(convert_path_to_json_traversal(&["d".into(), "a-b".into()]).is_err());
  }
}
