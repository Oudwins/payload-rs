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
//! - [`worker`]: id-addressed clients and transactions; one FIFO queue (and
//!   worker thread) per database file, so calls never overlap, as in libsql.
//!   Engine code runs SQL on a client's queue via [`worker::submit`].
//!
//! The JS facade lives in `packages/engine-rs/src/sqlite`, the napi bindings
//! in `crates/payload-node/src/sqlite.rs`.

pub mod client;
pub mod config;
pub mod conn;
pub mod error;
pub mod math;
pub mod value;
pub mod worker;

pub use conn::Conn;
pub use error::{ClientError, Result};
pub use value::{Args, BindValue, Cell, IntMode, ResultSet, SqlValue, Statement};
pub use rusqlite;
pub use worker::{ConnId, Session};
