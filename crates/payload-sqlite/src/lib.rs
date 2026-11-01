//! Rust SQLite runtime replacing `@libsql/client` (local `file:` databases)
//! for `@payloadcms/db-sqlite`. See RUST_PORT.md for ownership and porting
//! rules.
//!
//! Layers (each mirrors a piece of the JS stack it replaces):
//! - [`config`]: `expandConfig` / `parseUri` / `_createClient` URL checks.
//! - [`conn`]: the `libsql` native binding (`Database` / `Statement`) and
//!   `executeStmt` / `executeMultiple` of `@libsql/client/sqlite3`.
//! - [`client`]: the connection-level logic of `Sqlite3Client` /
//!   `Sqlite3Transaction` (batch, migrate, transactions).
//! - [`worker`]: id-addressed clients and transactions; one process-wide
//!   FIFO queue (and worker thread), so calls never overlap, as in libsql.
//!   Engine code runs SQL on a client's queue via [`worker::submit`].
//!
//! ## SQLite build
//!
//! The reference runtime (`@libsql/client@0.14.0` -> `libsql@0.4.7`, libsql
//! rev `20147731`, feature `encryption`) runs the libSQL 3.45.1 amalgamation
//! compiled through SQLite3 Multiple Ciphers 1.8.1 (`libsql-ffi` 0.4.1,
//! feature `multiple-ciphers`). That exact build is linked here: the
//! workspace patches `libsqlite3-sys` with `libsqlite3-sys/` (this crate's
//! directory), a shim exposing libsqlite3-sys 0.35's API over `libsql-ffi`,
//! so every `rusqlite` user (this crate and the engine crates) runs on it.
//! Version-specific behaviour, `PRAGMA compile_options` (except `COMPILER`)
//! and the SQL functions of the bundled extensions (`regexp`, `median`,
//! math, `uuid`, vector functions, ...) are therefore the reference's own.
//!
//! The JS facade lives in `packages/engine-rs/src/sqlite`, the napi bindings
//! in `crates/payload-node/src/sqlite.rs`.

pub mod client;
pub mod config;
pub mod conn;
pub mod error;
pub mod value;
pub mod worker;

pub use conn::Conn;
pub use error::{ClientError, Result};
pub use value::{Args, BindValue, Cell, IntMode, ResultSet, SqlValue, Statement};
pub use rusqlite;
pub use worker::{ConnId, Session};
