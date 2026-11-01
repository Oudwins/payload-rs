//! Config value access shared by the decoded-value utilities. `getFieldByPath` and
//! `getLocalizedPaths` run on live values (`crate::live::paths`).

use payload_engine::js::JsVal;

use crate::js::{JsError, JsResult};

/// `value[key]` on a config value, throwing like V8 for nullish receivers.
pub fn cfg_get<'a>(v: &'a JsVal, key: &str) -> JsResult<&'a JsVal> {
  match v {
    JsVal::Undefined | JsVal::Null => Err(JsError::type_error(format!(
      "Cannot read properties of {} (reading '{key}')",
      v.to_js_string()
    ))),
    JsVal::Arr(a) => Ok(key.parse::<usize>().ok().and_then(|i| a.get(i)).unwrap_or(&JsVal::Undefined)),
    other => Ok(other.get(key)),
  }
}

/// `fields.find((each) => each.name === name)`
pub fn find_field(fields: &JsVal, name: &str) -> JsResult<Option<JsVal>> {
  let items = match fields {
    JsVal::Arr(a) => a,
    JsVal::Undefined | JsVal::Null => {
      return Err(JsError::type_error(format!(
        "Cannot read properties of {} (reading 'find')",
        fields.to_js_string()
      )));
    }
    _ => return Err(JsError::type_error("fields.find is not a function")),
  };
  for each in items.iter() {
    if cfg_get(each, "name")?.as_str() == Some(name) {
      return Ok(Some(each.clone()));
    }
  }
  Ok(None)
}
