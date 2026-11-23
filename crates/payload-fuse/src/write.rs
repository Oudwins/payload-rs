//! Result JSON for `JSON.parse` materialization (FUSE_CONTRACT.md section 5): bails on anything
//! `JSON.parse` would not give back identically.

use payload_engine::js::{JsVal, num_to_js_string, write_json_string};

use crate::backend::{Bail, FuseResult};

/// Deeper values bail (the exact lane handles them without recursion limits).
const MAX_DEPTH: usize = 400;

thread_local! {
  static CANONICAL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Whether the running job writes canonical text (RUST_HTTP_LANES.md 3.1:
/// `text === JSON.stringify(JSON.parse(text))`): `-0` as `0`, no integer-like keys (JS orders
/// them first), spliced JSON only when already canonical.
pub fn canonical() -> bool {
  CANONICAL.with(std::cell::Cell::get)
}

/// Runs `f` with canonical text on (`canonical`) or off, restoring the previous mode.
pub fn with_canonical<R>(canonical: bool, f: impl FnOnce() -> R) -> R {
  let previous = CANONICAL.with(|c| c.replace(canonical));
  let out = f();
  CANONICAL.with(|c| c.set(previous));
  out
}

/// `"0"`, or `[1-9][0-9]*` up to 4294967294: a key JS objects order before the others.
pub fn is_array_index_key(key: &str) -> bool {
  let b = key.as_bytes();
  match b.first() {
    Some(b'0') => b.len() == 1,
    Some(b'1'..=b'9') => b.len() <= 10 && b.iter().all(u8::is_ascii_digit) && key.parse::<u64>().is_ok_and(|n| n < 4_294_967_295),
    _ => false,
  }
}

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
        out.push_str(if canonical() { "0" } else { "-0" });
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
        if canonical() && is_array_index_key(key) {
          return Err(Bail::new("value:index-key"));
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
