//! Ports of `queries/operatorMap.ts` (with the `@payloadcms/db-sqlite` overrides:
//! `contains`/`like` use `like`, `not_like` uses `notLike`), `queries/buildOperatorConstraint.ts`
//! and `queries/validateOperatorHandlers.ts`.

use payload_engine::error::{EngineError, Result};
use payload_engine::js::JsVal;

use crate::adapter::{QueryAdapter, type_error};
use crate::sql::{self, Expr, Operand, Sql};

/// `adapter.operators[operator](column, value)` for SQLite.
pub fn apply_operator(operator: &str, column: Option<&Expr>, value: Operand) -> Result<Sql> {
  Ok(match operator {
    "contains" | "like" => sql::like(column, value),
    "not_like" => sql::not_like(column, value),
    "equals" => sql::eq(column, value),
    "not_equals" => sql::ne(column, value),
    "exists" => sql::is_not_null(column),
    "isNull" => sql::is_null(column),
    "greater_than" => sql::gt(column, value),
    "greater_than_equal" => sql::gte(column, value),
    "less_than" => sql::lt(column, value),
    "less_than_equal" => sql::lte(column, value),
    "in" => sql::in_array(column, value),
    "not_in" => sql::not_in_array(column, value),
    _ => return Err(type_error("adapter.operators[resolvedOperator] is not a function")),
  })
}

/// Metadata of a `DrizzleOperatorHandler`. The handler functions themselves live in JS and
/// are not executed by the Rust engine (`@payloadcms/db-sqlite` always configures `[]`).
#[derive(Clone, Debug)]
pub struct OperatorHandler {
  pub name: String,
  pub operators: Vec<String>,
  pub field_types: Option<Vec<String>>,
  pub has_build: bool,
  pub has_transform_operands: bool,
}

/// `validateOperatorHandlers(operatorHandlers)`
pub fn validate_operator_handlers(handlers: &[OperatorHandler]) -> Result<()> {
  for handler in handlers {
    if handler.has_build && handler.has_transform_operands {
      return Err(EngineError::api(format!(
        "Operator handler \"{}\" cannot define both \"build\" and \"transformOperands\". Use \"transformOperands\" to adjust operands, or \"build\" to replace the comparison entirely.",
        handler.name
      )));
    }
  }
  let replacement: Vec<&OperatorHandler> = handlers.iter().filter(|h| h.has_build).collect();
  for i in 0..replacement.len() {
    for j in i + 1..replacement.len() {
      let (a, b) = (replacement[i], replacement[j]);
      let shared: Vec<&str> = a.operators.iter().filter(|op| b.operators.contains(op)).map(String::as_str).collect();
      if shared.is_empty() {
        continue;
      }
      let overlap = match (&a.field_types, &b.field_types) {
        (Some(fa), Some(fb)) => fa.iter().any(|t| fb.contains(t)),
        _ => true,
      };
      if overlap {
        return Err(EngineError::api(format!(
          "Operator handlers \"{}\" and \"{}\" both replace the \"{}\" operator for overlapping field types. Only one replacement handler may match a given resolved operator and field type.",
          a.name,
          b.name,
          shared.join("\", \"")
        )));
      }
    }
  }
  Ok(())
}

pub struct OperatorConstraintArgs<'f> {
  pub column: Option<Expr>,
  pub field: &'f JsVal,
  pub path: &'f str,
  pub resolved_operator: &'f str,
  pub value: Operand,
}

/// `buildOperatorConstraint(args)`
pub fn build_operator_constraint(adapter: &QueryAdapter, args: OperatorConstraintArgs) -> Result<Sql> {
  let field_type = args.field.get("type").as_str().unwrap_or("");
  let matching = adapter.opts.operator_handlers.iter().filter(|h| {
    h.operators.iter().any(|op| op == args.resolved_operator)
      && h.field_types.as_ref().is_none_or(|types| types.iter().any(|t| t == field_type))
  });
  if let Some(handler) = matching.into_iter().next() {
    return Err(EngineError::internal(format!(
      "Operator handler \"{}\" matched the \"{}\" operator at path \"{}\", but JS operator handlers are not supported by the Rust query builder.",
      handler.name, args.resolved_operator, args.path
    )));
  }
  apply_operator(args.resolved_operator, args.column.as_ref(), args.value)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn handler(name: &str, operators: &[&str], field_types: Option<&[&str]>, build: bool, transform: bool) -> OperatorHandler {
    OperatorHandler {
      name: name.into(),
      operators: operators.iter().map(|s| s.to_string()).collect(),
      field_types: field_types.map(|t| t.iter().map(|s| s.to_string()).collect()),
      has_build: build,
      has_transform_operands: transform,
    }
  }

  /// Mirrors `queries/validateOperatorHandlers.spec.ts`.
  #[test]
  fn validates_operator_handlers() {
    let err = validate_operator_handlers(&[handler("both", &["equals"], None, true, true)]).unwrap_err();
    assert_eq!(err.name, "APIError");
    assert!(err.message.starts_with("Operator handler \"both\" cannot define both"));

    let err = validate_operator_handlers(&[
      handler("a", &["equals", "like"], None, true, false),
      handler("b", &["like", "equals"], Some(&["text"]), true, false),
    ])
    .unwrap_err();
    assert_eq!(
      err.message,
      "Operator handlers \"a\" and \"b\" both replace the \"equals\", \"like\" operator for overlapping field types. Only one replacement handler may match a given resolved operator and field type."
    );

    assert!(
      validate_operator_handlers(&[
        handler("a", &["equals"], Some(&["text"]), true, false),
        handler("b", &["equals"], Some(&["number"]), true, false),
        handler("c", &["equals"], None, false, true),
      ])
      .is_ok()
    );
  }
}
