//! Result JSON for `JSON.parse` materialization (FUSE_CONTRACT.md section 5): bails on anything
//! `JSON.parse` would not give back identically.

use payload_engine::js::{JsVal, num_to_js_string, write_json_string};

use crate::backend::{Bail, FuseResult};

/// Deeper values bail (the exact lane handles them without recursion limits).
const MAX_DEPTH: usize = 400;

pub fn to_json(value: &JsVal) -> FuseResult<String> {
  let mut out = String::with_capacity(256);
  write(value, &mut out, 0)?;
  Ok(out)
}

pub fn write(value: &JsVal, out: &mut String, depth: usize) -> FuseResult<()> {
  if depth > MAX_DEPTH {
    return Err(Bail::new("value:deep"));
  }
  match value {
    JsVal::Undefined => return Err(Bail::new("value:undefined")),
    JsVal::Null => out.push_str("null"),
    JsVal::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
    JsVal::Num(n) => {
      if !n.is_finite() {
        return Err(Bail::new("value:non-finite"));
      }
      if *n == 0.0 && n.is_sign_negative() {
        out.push_str("-0");
      } else if n.fract() == 0.0 && n.abs() < 1e15 {
        use std::fmt::Write;
        let _ = write!(out, "{}", *n as i64);
      } else {
        out.push_str(&num_to_js_string(*n));
      }
    }
    JsVal::Str(s) => write_json_string(s, out),
    JsVal::Fn(_) => return Err(Bail::new("value:function")),
    JsVal::Arr(items) => {
      out.push('[');
      for (i, item) in items.iter().enumerate() {
        if i > 0 {
          out.push(',');
        }
        write(item, out, depth + 1)?;
      }
      out.push(']');
    }
    JsVal::Obj(props) => {
      if props.is_empty() && (value.typed().is_some() || value.bson().is_some() || value.as_host_object().is_some()) {
        return Err(Bail::new("value:typed"));
      }
      out.push('{');
      for (i, (key, item)) in props.iter().enumerate() {
        if key == "__proto__" {
          return Err(Bail::new("value:__proto__"));
        }
        if i > 0 {
          out.push(',');
        }
        write_json_string(key, out);
        out.push(':');
        write(item, out, depth + 1)?;
      }
      out.push('}');
    }
  }
  Ok(())
}
