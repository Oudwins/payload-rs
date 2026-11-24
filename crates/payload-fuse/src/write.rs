//! Result JSON for `JSON.parse` materialization (FUSE_CONTRACT.md section 5): bails on anything
//! `JSON.parse` would not give back identically.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use payload_engine::js::{JsVal, Obj, Props, num_to_js_string, write_json_string};

use crate::backend::{Bail, FuseResult};

/// Deeper values bail (the exact lane handles them without recursion limits).
const MAX_DEPTH: usize = 400;

thread_local! {
  static CANONICAL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
  /// The raw leaves of the job running on this thread.
  static RAW: RefCell<Option<RawLeaves>> = const { RefCell::new(None) };
}

/// The raw leaves of one fused job: values the core carries without looking into them and writes
/// as JSON text (a backend's json or rich text subtree the `afterRead` traversal only moves). A
/// raw leaf is an empty object identified by its address in this table, which keeps it alive (its
/// address is not reused while the job runs). The traversal never reaches into one: backends only
/// create them where the collection plan has a leaf. Shared by the threads that build the job's
/// documents.
#[derive(Clone, Default)]
pub struct RawLeaves(Arc<Mutex<HashMap<usize, (Arc<Props>, String)>>>);

impl RawLeaves {
  /// A raw leaf written as `json` (`JSON.parse(json)` is the value).
  pub fn value(&self, json: String) -> JsVal {
    let props = Arc::new(Props::from(Obj::new()));
    self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(Arc::as_ptr(&props) as usize, (Arc::clone(&props), json));
    JsVal::Obj(props)
  }
}

/// Runs `f` (the job's core) with the job's raw leaves visible to the writer.
pub fn with_raw_leaves<R>(leaves: Option<RawLeaves>, f: impl FnOnce() -> R) -> R {
  let previous = RAW.with(|raw| raw.replace(leaves));
  let out = f();
  RAW.with(|raw| raw.replace(previous));
  out
}

/// The JSON text of a raw leaf.
pub(crate) fn raw_text<R>(props: &Arc<Props>, f: impl FnOnce(&str) -> R) -> Option<R> {
  if !props.is_empty() {
    return None;
  }
  RAW.with(|raw| {
    let raw = raw.borrow();
    let table = raw.as_ref()?.0.lock().unwrap_or_else(|e| e.into_inner());
    table.get(&(Arc::as_ptr(props) as usize)).map(|(_, text)| f(text))
  })
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
      if raw_text(props, |text| out.push_str(text)).is_some() {
        return Ok(());
      }
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
