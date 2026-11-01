//! Rust port of the `@payloadcms/drizzle` write path for SQLite
//! (`upsertRow` and the create/update/delete adapter operations), executed
//! through rusqlite.
//!
//! - [`upsert_row`]: packages/drizzle/src/upsertRow/*
//! - [`ops`]: packages/drizzle/src/{create,update*,delete*,upsert}.ts
//! - [`sql`]: drizzle sqlite statement rendering + `insert` / `deleteWhere` /
//!   `execute` (packages/drizzle/src/sqlite/{insert,deleteWhere,execute}.ts)
//! - [`error`]: packages/drizzle/src/upsertRow/handleUpsertError.ts
//! - [`optimized`]: packages/drizzle/src/upsertRow/shouldUseOptimizedUpsertRow.ts
//!
//! `RowToInsert` and its row/value types come from `payload-sql-write`, which
//! also provides the `transformForWrite` port called by `upsert_row`.

pub mod error;
pub mod ops;
pub mod optimized;
pub mod sql;
pub mod upsert_row;
pub mod value;

pub use error::{ErrorContext, handle_upsert_error};
pub use optimized::should_use_optimized_upsert_row;
pub use payload_sql_write::{NestedRowToInsert, Row, RowToInsert, RowValue, SqlExpr};
pub use sql::{ExecutedStatement, Executor, SqlFragment};
pub use upsert_row::{
  AdapterOptions, FindArgsShape, IgnoreResult, Operation, UpsertHost, UpsertOutcome, UpsertRowArgs, WriteContext,
  upsert_row,
};
