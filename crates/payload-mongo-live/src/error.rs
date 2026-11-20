//! Error helpers. Rules for every live crate:
//! - a value thrown by user code, mongoose, bson or the driver travels as `Thrown(Val)` holding the
//!   very object (identity, class, own properties, getters untouched); propagate it with `?`, never
//!   copy or re-create it, never read its properties unless upstream does (glue review item 6);
//! - engine-created errors are constructed in JS by the host with upstream's classes, at the point
//!   upstream throws them, so `instanceof` and `name` / `message` / `status` are upstream's (only the
//!   stack differs).

use payload_core_runtime::js::{self, Local, Thrown};

use crate::host::throw_from;

/// `new APIError(message)` (Payload's class, as `@payloadcms/db-mongodb` imports it).
pub fn api_error(message: &str) -> Thrown {
  throw_from("newError", &[js::string("APIError"), js::string(message)])
}

/// `new APIError(message)` with a JS message value.
pub fn api_error_of(message: Local) -> Thrown {
  throw_from("newError", &[js::string("APIError"), message])
}

/// `new BSONError(message)` with the bson module's class (`mongoose.mongo.BSON.BSONError`).
pub fn bson_error(message: &str) -> Thrown {
  throw_from("newError", &[js::string("BSONError"), js::string(message)])
}

/// `new <kind>(...args)` for the classes the host knows: `APIError`, `BSONError`,
/// `ValidationError` (Payload's; args = `(data, t)`), `Error`, `TypeError`, `RangeError`.
pub fn new_error(kind: &str, args: &[Local]) -> Thrown {
  let mut all = Vec::with_capacity(args.len() + 1);
  all.push(js::string(kind));
  all.extend_from_slice(args);
  throw_from("newError", &all)
}

/// Whether `a` and `b` are the very same thrown value (`Object.is`).
pub fn is_same(a: &Thrown, b: &Thrown) -> bool {
  js::strict_equals(a.0.get(), b.0.get())
}
