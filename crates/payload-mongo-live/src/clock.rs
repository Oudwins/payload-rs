//! Clock reads. Each function is ONE evaluation of the upstream expression, through the global
//! `Date` at call time (fake timers, the shadow harness's clock tape and AsyncLocalStorage context
//! apply). Call them exactly where upstream evaluates the expression, once per evaluation: never
//! share a reading between two upstream `new Date()`s (engine review item 7).

use payload_core_runtime::js::{JsResult, Local};

use crate::host::call;

/// `new Date()`
pub fn new_date() -> JsResult<Local> {
  call("newDate", &[])
}

/// `new Date().toISOString()` (e.g. `data.createdAt = new Date().toISOString()`,
/// transform's `data.updatedAt = new Date().toISOString()`).
pub fn now_iso() -> JsResult<Local> {
  call("nowISO", &[])
}

/// `new Date(value)` (e.g. `$lt: new Date(doc.updatedAt)`).
pub fn new_date_of(value: Local) -> JsResult<Local> {
  call("newDateOf", &[value])
}

/// `Date.now()`
pub fn date_now() -> JsResult<Local> {
  call("dateNow", &[])
}
