//! Port of `queries/sanitizeQueryValue.ts`.

use payload_engine::error::{EngineError, Result};
use payload_engine::fields::field_affects_data;
use payload_engine::js::JsVal;

use crate::adapter::{QueryAdapter, read_undefined};
use crate::columns::{PolyColumn, is_polymorphic_relationship};
use crate::js_ops::{date_parse, js_number, js_number_checked, js_string_checked, parse_float, parse_int, to_iso_string, uuid_validate};
use crate::paths::field_type;
use crate::sql::{Expr, Operand, Sql};
use crate::where_val::WhereVal;

#[derive(Clone, Debug)]
pub struct SanitizedColumn {
  pub raw_column: Sql,
  pub value: JsVal,
}

#[derive(Clone, Debug)]
pub struct SanitizedQueryValue {
  pub columns: Option<Vec<SanitizedColumn>>,
  pub operator: String,
  /// A JS value, or the SQL of a raw constraint.
  pub value: Operand,
}

pub struct SanitizeArgs<'a> {
  pub columns: Option<&'a [PolyColumn]>,
  pub field: &'a JsVal,
  pub is_uuid: bool,
  pub operator: &'a str,
  pub relation_or_path: &'a str,
  pub val: &'a WhereVal,
}

fn num(n: f64) -> JsVal {
  JsVal::Num(n)
}

/// `convertDateToISO(item)`; `Ok(None)` mirrors `undefined`.
fn convert_date_to_iso(item: &JsVal) -> Result<Option<JsVal>> {
  if let Some(ms) = item.as_date() {
    return Ok(Some(JsVal::str(to_iso_string(ms)?)));
  }
  Ok(match item {
    JsVal::Undefined => None,
    JsVal::Str(s) => {
      if s.as_ref() == "null" || s.is_empty() {
        Some(JsVal::Null)
      } else {
        date_parse(s).map(|t| to_iso_string(t).map(JsVal::str)).transpose()?
      }
    }
    JsVal::Num(n) => Some(JsVal::str(to_iso_string(*n)?)),
    other => Some(other.clone()),
  })
}

/// `sanitizeQueryValue(args)`; `Ok(None)` mirrors a `null` return.
pub fn sanitize_query_value(adapter: &QueryAdapter, args: SanitizeArgs) -> Result<Option<SanitizedQueryValue>> {
  let SanitizeArgs { columns, field, is_uuid, operator: operator_arg, relation_or_path, val: where_val } = args;
  let view = where_val.view();
  let val = &view;
  let raw = |sql: &Sql| Operand::Expr(Expr::Sql(sql.clone()));
  let mut operator = operator_arg.to_string();
  let mut formatted_value = val.clone();
  let mut formatted_columns: Option<Vec<SanitizedColumn>> = None;
  let ftype = field_type(field);
  let is_relationship = ftype == "relationship" || ftype == "upload";

  if !field_affects_data(field) {
    return Ok(Some(SanitizedQueryValue { columns: None, operator, value: Operand::Val(formatted_value) }));
  }

  if let WhereVal::RawConstraint(sql) = where_val {
    return Ok(Some(SanitizedQueryValue { columns: None, operator, value: raw(sql) }));
  }

  if is_relationship && !relation_or_path.ends_with("relationTo") {
    if let Some(items) = formatted_value.as_arr() {
      let mut all = Vec::new();
      for v in items {
        if !adapter.is_uuid_id() && v.as_str().is_some() {
          all.push(v.clone());
          all.push(num(parse_int(v)));
        } else if v.as_str().is_some() {
          all.push(v.clone());
        } else {
          all.push(v.clone());
          all.push(JsVal::str(js_string_checked(v)?));
        }
      }
      formatted_value = JsVal::arr(all);
    }
  }

  if ftype == "checkbox" {
    if let Some(s) = val.as_str() {
      if s.to_lowercase() == "true" {
        formatted_value = JsVal::Bool(true);
      }
      if s.to_lowercase() == "false" {
        formatted_value = JsVal::Bool(false);
      }
    }
  }

  if matches!(operator.as_str(), "all" | "in" | "not_in") {
    if let Some(s) = formatted_value.as_str() {
      let parts: Vec<JsVal> = s.split(',').map(JsVal::str).collect();
      formatted_value = if ftype == "number" {
        JsVal::arr(parts.iter().map(|p| num(parse_float(p))).collect())
      } else {
        JsVal::arr(parts)
      };
    } else if let JsVal::Num(_) = formatted_value {
      formatted_value = JsVal::arr(vec![formatted_value.clone()]);
    }
    if formatted_value.as_arr().is_none() {
      return Ok(None);
    }
  }

  if ftype == "number" && formatted_value.as_str().is_some() {
    let n = js_number(val);
    formatted_value = if n.is_nan() { JsVal::Null } else { num(n) };
  }

  if is_uuid && formatted_value.as_str().is_some() && !uuid_validate(val) {
    formatted_value = JsVal::Null;
  }

  if ftype == "date" && operator != "exists" {
    if let Some(items) = formatted_value.as_arr() {
      let mut out = Vec::new();
      for item in items {
        if let Some(v) = convert_date_to_iso(item)? {
          out.push(v);
        }
      }
      formatted_value = JsVal::arr(out);
    } else {
      match convert_date_to_iso(val)? {
        None => return Ok(Some(SanitizedQueryValue { columns: None, operator, value: Operand::Val(JsVal::Undefined) })),
        Some(v) => formatted_value = v,
      }
    }
  }

  if is_relationship {
    if val.as_str() == Some("null") {
      formatted_value = JsVal::Null;
    } else if !(formatted_value.is_null() || matches!(formatted_value, JsVal::Bool(_))) {
      let relation_to = field.get("relationTo");
      let id_type: Option<String>;
      if relation_to.as_str().is_some() {
        let collection = adapter.collection_or_undefined(relation_to);
        if collection.is_undefined() {
          return Err(read_undefined("customIDType"));
        }
        id_type = adapter.collection_id_type(collection);
      } else {
        if is_polymorphic_relationship(val) {
          if operator != "equals" {
            return Err(EngineError::api(format!(
              "Only 'equals' operator is supported for polymorphic relationship object notation. Given - {operator}"
            )));
          }
          let collection = adapter.collection_or_undefined(val.get("relationTo"));
          if collection.is_undefined() {
            return Err(read_undefined("customIDType"));
          }
          let id_type = adapter.collection_id_type(collection);
          if let WhereVal::RawConstraint(sql) = where_val.get("value") {
            return Ok(Some(SanitizedQueryValue { columns: None, operator, value: raw(&sql) }));
          }
          let inner = val.get("value");
          let value =
            if id_type.as_deref() == Some("number") { num(js_number_checked(inner)?) } else { JsVal::str(js_string_checked(inner)?) };
          return Ok(Some(SanitizedQueryValue { columns: None, operator, value: Operand::Val(value) }));
        }

        let columns = columns.ok_or_else(|| read_undefined("map"))?;
        let mut out = Vec::new();
        for PolyColumn { id_type, raw_column } in columns {
          let value = if let Some(items) = val.as_arr() {
            let mut values = Vec::new();
            for each in items {
              let v = if id_type == "number" {
                let n = js_number_checked(each)?;
                if n.is_nan() { JsVal::Null } else { num(n) }
              } else if id_type == "uuid" && !uuid_validate(each) {
                JsVal::Null
              } else {
                JsVal::str(js_string_checked(each)?)
              };
              if v.truthy() {
                values.push(v);
              }
            }
            JsVal::arr(values)
          } else if id_type == "number" {
            let n = js_number_checked(val)?;
            if n.is_nan() {
              continue;
            }
            num(n)
          } else {
            JsVal::str(js_string_checked(val)?)
          };
          out.push(SanitizedColumn { raw_column: raw_column.clone(), value });
        }
        formatted_columns = Some(out);
        id_type = None;
      }

      if let Some(items) = formatted_value.as_arr() {
        formatted_value = JsVal::arr(
          items
            .iter()
            .map(|v| {
              Ok(match id_type.as_deref() {
                Some("number") => num(js_number_checked(v)?),
                Some("text") => JsVal::str(js_string_checked(v)?),
                _ => v.clone(),
              })
            })
            .collect::<Result<_>>()?,
        );
      } else {
        if id_type.as_deref() == Some("number") {
          formatted_value = num(js_number_checked(val)?);
        }
        if id_type.as_deref() == Some("text") {
          formatted_value = JsVal::str(js_string_checked(val)?);
        }
      }
    }
  }

  let has_many = field.has("hasMany") && field.get("hasMany").truthy();

  if has_many && operator == "contains" && matches!(ftype, "relationship" | "upload" | "select") {
    operator = "equals".into();
  }

  if operator == "near" && ftype == "point" {
    if let Some(s) = formatted_value.as_str() {
      let parts: Vec<&str> = s.split(',').collect();
      let at = |i: usize| parts.get(i).map(|p| js_number(&JsVal::str(*p))).unwrap_or(f64::NAN);
      formatted_value = JsVal::arr(vec![num(at(0)), num(at(1)), num(at(2)), num(at(3))]);
    }
  }

  if operator == "contains" {
    if let Some(items) = formatted_value.as_arr().filter(|_| has_many && matches!(ftype, "number" | "text")) {
      formatted_value = JsVal::arr(
        items.iter().map(|v| Ok(JsVal::str(format!("%{}%", js_string_checked(v)?)))).collect::<Result<_>>()?,
      );
    } else if formatted_value.as_arr().is_none() {
      formatted_value = JsVal::str(format!("%{}%", js_string_checked(&formatted_value)?));
    }
  }

  if operator == "exists" {
    let exists = val.as_str() == Some("true") || matches!(val, JsVal::Bool(true));
    formatted_value = JsVal::Bool(exists);
    operator = if exists { "exists".into() } else { "isNull".into() };
  }

  if is_relationship && formatted_value.as_arr().is_some() {
    if operator == "equals" {
      return Ok(Some(SanitizedQueryValue { columns: formatted_columns, operator: "in".into(), value: Operand::Val(formatted_value) }));
    } else if operator == "not_equals" {
      return Ok(Some(SanitizedQueryValue { columns: formatted_columns, operator: "not_in".into(), value: Operand::Val(formatted_value) }));
    }
  }

  Ok(Some(SanitizedQueryValue { columns: formatted_columns, operator, value: Operand::Val(formatted_value) }))
}
