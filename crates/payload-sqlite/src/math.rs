//! Math SQL functions shipped by `libsql@0.4.7`.
//!
//! libsql is not built with SQLite's `SQLITE_ENABLE_MATH_FUNCTIONS`; it
//! registers the math functions of `extension-functions.c` (bundled through
//! SQLite3 Multiple Ciphers) instead, with their own semantics: any non-NULL
//! argument is read with `sqlite3_value_double` (so `'abc'` is `0.0`),
//! `ceil`/`floor` return integers, `log(X)` is the natural logarithm, there is
//! no `log(B, X)`/`log2`/`pow`/`mod`/`trunc`, and the functions are registered
//! without `SQLITE_DETERMINISTIC`. The SQLite bundled by `rusqlite` has none
//! of them, so they are ported here and registered on every connection.
//!
//! The `errno` checks of `extension-functions.c` never trigger on macOS
//! (libm reports domain errors as NaN, which SQLite stores as NULL); this port
//! follows that behaviour on every platform.

use std::ffi::{c_int, c_void};

use rusqlite::ffi;

#[derive(Clone, Copy)]
enum F {
  Ceil,
  Floor,
  Square,
  Power,
  Atan2,
  Pi,
  Unary(fn(f64) -> f64),
}

const PI: f64 = std::f64::consts::PI;

const FUNCTIONS: &[(&str, c_int, F)] = &[
  ("acos", 1, F::Unary(f64::acos)),
  ("asin", 1, F::Unary(f64::asin)),
  ("atan", 1, F::Unary(f64::atan)),
  ("atn2", 2, F::Atan2),
  ("atan2", 2, F::Atan2),
  ("acosh", 1, F::Unary(f64::acosh)),
  ("asinh", 1, F::Unary(f64::asinh)),
  ("atanh", 1, F::Unary(f64::atanh)),
  ("degrees", 1, F::Unary(|x| x * 180.0 / PI)),
  ("radians", 1, F::Unary(|x| x * PI / 180.0)),
  ("cos", 1, F::Unary(f64::cos)),
  ("sin", 1, F::Unary(f64::sin)),
  ("tan", 1, F::Unary(f64::tan)),
  ("cot", 1, F::Unary(|x| 1.0 / x.tan())),
  ("cosh", 1, F::Unary(f64::cosh)),
  ("sinh", 1, F::Unary(f64::sinh)),
  ("tanh", 1, F::Unary(f64::tanh)),
  ("coth", 1, F::Unary(|x| 1.0 / x.tanh())),
  ("exp", 1, F::Unary(f64::exp)),
  ("log", 1, F::Unary(f64::ln)),
  ("ln", 1, F::Unary(f64::ln)),
  ("log10", 1, F::Unary(f64::log10)),
  ("power", 2, F::Power),
  ("sqrt", 1, F::Unary(f64::sqrt)),
  ("square", 1, F::Square),
  ("ceil", 1, F::Ceil),
  ("ceiling", 1, F::Ceil),
  ("floor", 1, F::Floor),
  ("pi", 0, F::Pi),
];

unsafe extern "C" fn call(ctx: *mut ffi::sqlite3_context, argc: c_int, argv: *mut *mut ffi::sqlite3_value) {
  // SAFETY: SQLite passes `argc` valid values and the user data registered
  // below (a pointer into the static FUNCTIONS table).
  unsafe {
    let f = *(ffi::sqlite3_user_data(ctx) as *const F);
    let arg = |i: usize| *argv.add(i);
    let is_null = |i: usize| ffi::sqlite3_value_type(arg(i)) == ffi::SQLITE_NULL;
    let double = |i: usize| ffi::sqlite3_value_double(arg(i));
    match f {
      F::Pi => ffi::sqlite3_result_double(ctx, PI),
      F::Power | F::Atan2 => {
        if argc < 2 || is_null(0) || is_null(1) {
          ffi::sqlite3_result_null(ctx);
        } else {
          let (a, b) = (double(0), double(1));
          ffi::sqlite3_result_double(ctx, if matches!(f, F::Power) { a.powf(b) } else { a.atan2(b) });
        }
      }
      F::Ceil | F::Floor | F::Square => match ffi::sqlite3_value_type(arg(0)) {
        ffi::SQLITE_NULL => ffi::sqlite3_result_null(ctx),
        ffi::SQLITE_INTEGER => {
          let i = ffi::sqlite3_value_int64(arg(0));
          ffi::sqlite3_result_int64(ctx, if matches!(f, F::Square) { i.wrapping_mul(i) } else { i });
        }
        _ => {
          let x = double(0);
          match f {
            // `(i64) ceil(x)`: saturating, NaN -> 0 (as on arm64/x86-64 SSE).
            F::Ceil => ffi::sqlite3_result_int64(ctx, x.ceil() as i64),
            F::Floor => ffi::sqlite3_result_int64(ctx, x.floor() as i64),
            _ => ffi::sqlite3_result_double(ctx, x * x),
          }
        }
      },
      F::Unary(func) => {
        if is_null(0) {
          ffi::sqlite3_result_null(ctx);
        } else {
          ffi::sqlite3_result_double(ctx, func(double(0)));
        }
      }
    }
  }
}

/// Registers the functions on `db`.
pub fn register(db: *mut ffi::sqlite3) -> c_int {
  for (name, n_arg, f) in FUNCTIONS {
    let Ok(cname) = std::ffi::CString::new(*name) else {
      continue;
    };
    // SAFETY: `db` is a live connection; the user data points into a static.
    let rc = unsafe {
      ffi::sqlite3_create_function_v2(
        db,
        cname.as_ptr(),
        *n_arg,
        ffi::SQLITE_UTF8,
        f as *const F as *mut c_void,
        Some(call),
        None,
        None,
        None,
      )
    };
    if rc != ffi::SQLITE_OK {
      return rc;
    }
  }
  ffi::SQLITE_OK
}
