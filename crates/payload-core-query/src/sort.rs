//! `sanitizeSortQuery` and `getQueryDraftsSort`.

use payload_engine::js::JsVal;
use payload_sql_read::Val;

use crate::js::{JsError, JsResult};
use crate::paths::find_field;

fn sanitize_sort(fields: &JsVal, sort: &Val) -> JsResult<Val> {
  let sort_str = match sort {
    Val::Str(s) => s.to_lossy().into_owned(),
    // arrays have `indexOf` but not `split`
    Val::Arr(_) => return Err(JsError::type_error("sortProperty.split is not a function")),
    Val::Undefined | Val::Null => {
      return Err(JsError::type_error(format!(
        "Cannot read properties of {} (reading 'indexOf')",
        sort.to_js_string()
      )));
    }
    _ => return Err(JsError::type_error("sort.indexOf is not a function")),
  };
  let mut sort_property: &str = &sort_str;
  let mut desc = false;
  if sort_str.starts_with('-') {
    desc = true;
    sort_property = &sort_str[1..];
  }
  let mut fields = fields.clone();
  for segment in sort_property.split('.') {
    let Some(field) = find_field(&fields, segment)? else {
      return Ok(sort.clone());
    };
    if field.has("fields") {
      fields = field.get("flattenedFields").clone();
      continue;
    }
    if field.has("virtual")
      && let JsVal::Str(v) = field.get("virtual")
    {
      return Ok(Val::str(&format!("{}{v}", if desc { "-" } else { "" })));
    }
  }
  Ok(sort.clone())
}

/// `sanitizeSortQuery({ fields, sort })`
pub fn sanitize_sort_query(fields: &JsVal, sort: &Val) -> JsResult<Val> {
  if !sort.truthy() {
    return Ok(Val::Undefined);
  }
  if let Val::Arr(items) = sort {
    let items = items.borrow().to_vec();
    return Ok(Val::new_arr(items.iter().map(|s| sanitize_sort(fields, s)).collect::<JsResult<_>>()?));
  }
  sanitize_sort(fields, sort)
}

/// `getQueryDraftsSort({ collectionConfig, sort })`
pub fn get_query_drafts_sort(collection_config: &JsVal, sort: &Val) -> JsResult<Val> {
  let mut sort = sort.clone();
  if !sort.truthy() {
    let default_sort = collection_config.get("defaultSort");
    sort = if default_sort.truthy() { Val::from_js(default_sort) } else { Val::str("-createdAt") };
  }
  if sort.is_string() {
    sort = Val::new_arr(vec![sort]);
  }
  let Val::Arr(items) = &sort else {
    return Err(JsError::type_error("sort.map is not a function"));
  };
  let items = items.borrow().to_vec();
  let mut out = Vec::with_capacity(items.len());
  for field in &items {
    let (order_by, direction) = match field {
      Val::Str(s) => {
        let s = s.to_lossy();
        if s.starts_with('-') { (s[1..].to_string(), "-") } else { (s.to_string(), "") }
      }
      Val::Undefined | Val::Null => {
        return Err(JsError::type_error(format!(
          "Cannot read properties of {} (reading '0')",
          field.to_js_string()
        )));
      }
      Val::Arr(a) if a.borrow().first().is_some_and(|v| crate::js::is_str(v, "-")) => {
        return Err(JsError::type_error("field.substring is not a function"));
      }
      // `field[0] !== '-'`, so `orderBy = field` and is interpolated with String()
      other => (other.to_js_string(), ""),
    };
    if order_by == "id" {
      out.push(Val::str(&format!("{direction}parent")));
    } else {
      out.push(Val::str(&format!("{direction}version.{order_by}")));
    }
  }
  Ok(Val::new_arr(out))
}
