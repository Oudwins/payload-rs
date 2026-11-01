//! Value model crossing the JS <-> SQLite boundary.

use crate::error::{ClientError, Result};

/// `Config.intMode` of `@libsql/client`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum IntMode {
  #[default]
  Number,
  Bigint,
  String,
}

impl IntMode {
  pub fn parse(s: &str) -> Option<Self> {
    match s {
      "number" => Some(Self::Number),
      "bigint" => Some(Self::Bigint),
      "string" => Some(Self::String),
      _ => None,
    }
  }
}

/// A bind parameter after `valueToSql` (libsql-client `sqlite3.ts`) ran on
/// the JS side, as seen by the `libsql` native binding.
#[derive(Clone, Debug, PartialEq)]
pub enum BindValue {
  Null,
  /// JS numbers are always bound as REAL by the `libsql` binding.
  Real(f64),
  /// JS bigints.
  Integer(i64),
  Text(String),
  /// `Buffer` / `Uint8Array`.
  Blob(Vec<u8>),
  /// Any other JS value: binding fails with
  /// "SQLite3 can only bind numbers, strings, bigints, buffers, and null".
  Invalid,
}

/// Arguments of one statement.
#[derive(Clone, Debug, PartialEq)]
pub enum Args {
  /// `args` was an array: bound by position (`args[i]` -> `?{i + 1}`).
  Positional(Vec<BindValue>),
  /// `args` was an object: names already stripped of their `@`/`$`/`:` prefix.
  Named(Vec<(String, BindValue)>),
}

impl Default for Args {
  fn default() -> Self {
    Self::Positional(Vec::new())
  }
}

impl Args {
  pub fn values(&self) -> Box<dyn Iterator<Item = &BindValue> + '_> {
    match self {
      Self::Positional(v) => Box::new(v.iter()),
      Self::Named(v) => Box::new(v.iter().map(|(_, v)| v)),
    }
  }
}

/// `InStatement` after JS-side normalization.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Statement {
  pub sql: String,
  pub args: Args,
  /// An error thrown by `valueToSql` while converting the arguments. It is
  /// raised when the statement is reached (before `prepare`), exactly where
  /// `executeStmt` throws it.
  pub error: Option<ClientError>,
}

impl Statement {
  pub fn sql(sql: impl Into<String>) -> Self {
    Self { sql: sql.into(), ..Default::default() }
  }

  pub fn with_args(sql: impl Into<String>, args: Vec<BindValue>) -> Self {
    Self { sql: sql.into(), args: Args::Positional(args), error: None }
  }
}

/// A raw SQLite column value.
#[derive(Clone, Debug, PartialEq)]
pub enum SqlValue {
  Null,
  Integer(i64),
  Real(f64),
  Text(String),
  Blob(Vec<u8>),
}

/// A cell after `valueFromSql` (libsql-client `sqlite3.ts`).
#[derive(Clone, Debug, PartialEq)]
pub enum Cell {
  Null,
  Number(f64),
  BigInt(i64),
  String(String),
  /// Materialized as an `ArrayBuffer`.
  Blob(Vec<u8>),
}

const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// Port of `valueFromSql`.
pub fn value_from_sql(value: SqlValue, int_mode: IntMode) -> Result<Cell> {
  Ok(match value {
    SqlValue::Null => Cell::Null,
    SqlValue::Integer(i) => match int_mode {
      IntMode::Number => {
        if !(-MAX_SAFE..=MAX_SAFE).contains(&i) {
          return Err(ClientError::Range(
            "Received integer which cannot be safely represented as a JavaScript number".to_string(),
          ));
        }
        Cell::Number(i as f64)
      }
      IntMode::Bigint => Cell::BigInt(i),
      IntMode::String => Cell::String(i.to_string()),
    },
    SqlValue::Real(f) => Cell::Number(f),
    SqlValue::Text(s) => Cell::String(s),
    SqlValue::Blob(b) => Cell::Blob(b),
  })
}

/// `ResultSet` of `@libsql/core/api` before the JS `Row` objects are built.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ResultSet {
  pub columns: Vec<String>,
  pub column_types: Vec<String>,
  pub rows: Vec<Vec<Cell>>,
  pub rows_affected: i64,
  /// `undefined` for statements that return data.
  pub last_insert_rowid: Option<i64>,
}
