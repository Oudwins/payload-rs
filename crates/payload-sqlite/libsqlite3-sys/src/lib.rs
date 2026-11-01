//! `libsqlite3-sys` 0.35 API over the libSQL build of `libsql-ffi` 0.4.1
//! (`multiple-ciphers`), the SQLite of the reference `libsql@0.4.7` binding.
//!
//! The raw bindings (SQLite 3.45.1 + libSQL + SQLite3 Multiple Ciphers
//! symbols) and the static library come from `libsql-ffi`; the error types
//! are libsqlite3-sys 0.35's own (`error.rs`, copied verbatim) because
//! `rusqlite` 0.37 is written against them.

#![allow(non_snake_case, non_camel_case_types)]

pub use libsql_ffi::*;

pub use self::error::{code_to_str, Error, ErrorCode};

use std::mem;

mod error;

// libsqlite3-sys declares the auto extension entry point with
// `pzErrMsg: *mut *mut c_char` (libsql-ffi: `*mut *const c_char`); these
// explicit declarations shadow the glob re-export for `rusqlite`.
unsafe extern "C" {
  pub fn sqlite3_auto_extension(
    xEntryPoint: Option<
      unsafe extern "C" fn(
        db: *mut sqlite3,
        pzErrMsg: *mut *mut std::ffi::c_char,
        _: *const sqlite3_api_routines,
      ) -> std::ffi::c_int,
    >,
  ) -> std::ffi::c_int;
  pub fn sqlite3_cancel_auto_extension(
    xEntryPoint: Option<
      unsafe extern "C" fn(
        db: *mut sqlite3,
        pzErrMsg: *mut *mut std::ffi::c_char,
        _: *const sqlite3_api_routines,
      ) -> std::ffi::c_int,
    >,
  ) -> std::ffi::c_int;
}

#[must_use]
pub fn SQLITE_STATIC() -> sqlite3_destructor_type {
  None
}

#[must_use]
pub fn SQLITE_TRANSIENT() -> sqlite3_destructor_type {
  Some(unsafe { mem::transmute::<isize, unsafe extern "C" fn(*mut std::ffi::c_void)>(-1_isize) })
}
