//! Error model of the libsql client stack (`@libsql/client` sqlite3 driver,
//! `@libsql/core/api` `LibsqlError` and the `libsql` native binding).
//!
//! Every variant maps onto exactly one JS error shape that the original stack
//! produces, so the TS glue (`packages/engine-rs/src/sqlite/errors.ts`) can
//! rebuild a byte-identical error object.

use std::fmt;

/// An error raised by the SQLite runtime, tagged with the JS shape it must take.
#[derive(Clone, Debug, PartialEq)]
pub enum ClientError {
  /// A `SqliteError` from the `libsql` binding that `mapSqliteError`
  /// (libsql-client `sqlite3.ts`) wraps into
  /// `new LibsqlError(message, code, rawCode, sqliteError)`.
  Sqlite { message: String, code: String, raw_code: i32 },
  /// A raw native error object that escapes `convertError` in the `libsql`
  /// binding (errors raised while iterating rows of a reader statement):
  /// a plain `Error` with own `rawCode`, `code` and `libsqlError: true`.
  Native { message: String, code: String, raw_code: i32 },
  /// A `LibsqlError` raised by the client itself (`CLIENT_CLOSED`,
  /// `TRANSACTION_CLOSED`, `URL_INVALID`, ...): no `rawCode`, no `cause`.
  Libsql { message: String, code: String },
  /// `LibsqlError(..., "URL_INVALID", undefined, uriError)` thrown by
  /// `percentDecode`, whose `cause` is the `URIError: URI malformed`.
  UriMalformed { message: String },
  /// A JS `TypeError`.
  Type(String),
  /// A JS `RangeError`.
  Range(String),
  /// A plain JS `Error`, optionally with an own enumerable `code` property.
  Error { message: String, code: Option<String> },
}

impl ClientError {
  pub fn libsql(message: impl Into<String>, code: impl Into<String>) -> Self {
    Self::Libsql { message: message.into(), code: code.into() }
  }

  /// `new LibsqlError("The transaction is closed", "TRANSACTION_CLOSED")`.
  pub fn transaction_closed() -> Self {
    Self::libsql("The transaction is closed", "TRANSACTION_CLOSED")
  }

  /// `new LibsqlError("The transaction has been rolled back", "TRANSACTION_CLOSED")`.
  pub fn transaction_rolled_back() -> Self {
    Self::libsql("The transaction has been rolled back", "TRANSACTION_CLOSED")
  }

  /// `new LibsqlError("The client is closed", "CLIENT_CLOSED")`.
  pub fn client_closed() -> Self {
    Self::libsql("The client is closed", "CLIENT_CLOSED")
  }

  /// Error thrown by the `libsql` binding when a value cannot be bound.
  pub fn invalid_bind() -> Self {
    Self::Error {
      message: "SQLite3 can only bind numbers, strings, bigints, buffers, and null".to_string(),
      code: None,
    }
  }

  /// Error thrown by the `libsql` binding when a closed database is used.
  pub fn connection_not_open() -> Self {
    Self::Type("The database connection is not open".to_string())
  }

  /// The JS-visible `message` of the error object.
  pub fn js_message(&self) -> String {
    match self {
      Self::Sqlite { message, code, .. } | Self::Libsql { message, code } => format!("{code}: {message}"),
      Self::UriMalformed { message } => format!("URL_INVALID: {message}"),
      Self::Native { message, .. } | Self::Type(message) | Self::Range(message) | Self::Error { message, .. } => {
        message.clone()
      }
    }
  }

  /// The JS-visible `code` property, if any.
  pub fn code(&self) -> Option<&str> {
    match self {
      Self::Sqlite { code, .. } | Self::Native { code, .. } | Self::Libsql { code, .. } => Some(code),
      Self::Error { code, .. } => code.as_deref(),
      Self::UriMalformed { .. } => Some("URL_INVALID"),
      Self::Type(_) | Self::Range(_) => None,
    }
  }

  /// The JS error class name of the thrown object.
  pub fn js_name(&self) -> &'static str {
    match self {
      Self::Sqlite { .. } | Self::Libsql { .. } | Self::UriMalformed { .. } => "LibsqlError",
      Self::Native { .. } | Self::Error { .. } => "Error",
      Self::Type(_) => "TypeError",
      Self::Range(_) => "RangeError",
    }
  }

  /// Converts into the shared engine error (`name` = JS class name).
  pub fn into_engine_error(self) -> payload_engine::error::EngineError {
    let code = self.code().map(str::to_string);
    let mut err = payload_engine::error::EngineError::new(self.js_name(), self.js_message());
    if let Some(code) = code {
      err = err.with_data(serde_json::json!({ "code": code }));
    }
    err
  }
}

impl fmt::Display for ClientError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{}: {}", self.js_name(), self.js_message())
  }
}

impl std::error::Error for ClientError {}

pub type Result<T> = std::result::Result<T, ClientError>;

/// Name of a (possibly extended) SQLite result code, as reported by the
/// `libsql` binding in `SqliteError.code`.
pub fn code_name(code: i32) -> String {
  let name = match code {
    0 => "SQLITE_OK",
    1 => "SQLITE_ERROR",
    2 => "SQLITE_INTERNAL",
    3 => "SQLITE_PERM",
    4 => "SQLITE_ABORT",
    5 => "SQLITE_BUSY",
    6 => "SQLITE_LOCKED",
    7 => "SQLITE_NOMEM",
    8 => "SQLITE_READONLY",
    9 => "SQLITE_INTERRUPT",
    10 => "SQLITE_IOERR",
    11 => "SQLITE_CORRUPT",
    12 => "SQLITE_NOTFOUND",
    13 => "SQLITE_FULL",
    14 => "SQLITE_CANTOPEN",
    15 => "SQLITE_PROTOCOL",
    16 => "SQLITE_EMPTY",
    17 => "SQLITE_SCHEMA",
    18 => "SQLITE_TOOBIG",
    19 => "SQLITE_CONSTRAINT",
    20 => "SQLITE_MISMATCH",
    21 => "SQLITE_MISUSE",
    22 => "SQLITE_NOLFS",
    23 => "SQLITE_AUTH",
    24 => "SQLITE_FORMAT",
    25 => "SQLITE_RANGE",
    26 => "SQLITE_NOTADB",
    27 => "SQLITE_NOTICE",
    28 => "SQLITE_WARNING",
    100 => "SQLITE_ROW",
    101 => "SQLITE_DONE",
    257 => "SQLITE_ERROR_MISSING_COLLSEQ",
    513 => "SQLITE_ERROR_RETRY",
    769 => "SQLITE_ERROR_SNAPSHOT",
    266 => "SQLITE_IOERR_READ",
    522 => "SQLITE_IOERR_SHORT_READ",
    778 => "SQLITE_IOERR_WRITE",
    1034 => "SQLITE_IOERR_FSYNC",
    1290 => "SQLITE_IOERR_DIR_FSYNC",
    1546 => "SQLITE_IOERR_TRUNCATE",
    1802 => "SQLITE_IOERR_FSTAT",
    2058 => "SQLITE_IOERR_UNLOCK",
    2314 => "SQLITE_IOERR_RDLOCK",
    2570 => "SQLITE_IOERR_DELETE",
    2826 => "SQLITE_IOERR_BLOCKED",
    3082 => "SQLITE_IOERR_NOMEM",
    3338 => "SQLITE_IOERR_ACCESS",
    3594 => "SQLITE_IOERR_CHECKRESERVEDLOCK",
    3850 => "SQLITE_IOERR_LOCK",
    4106 => "SQLITE_IOERR_CLOSE",
    4362 => "SQLITE_IOERR_DIR_CLOSE",
    4618 => "SQLITE_IOERR_SHMOPEN",
    4874 => "SQLITE_IOERR_SHMSIZE",
    5130 => "SQLITE_IOERR_SHMLOCK",
    5386 => "SQLITE_IOERR_SHMMAP",
    5642 => "SQLITE_IOERR_SEEK",
    5898 => "SQLITE_IOERR_DELETE_NOENT",
    6154 => "SQLITE_IOERR_MMAP",
    6410 => "SQLITE_IOERR_GETTEMPPATH",
    6666 => "SQLITE_IOERR_CONVPATH",
    6922 => "SQLITE_IOERR_VNODE",
    7178 => "SQLITE_IOERR_AUTH",
    7434 => "SQLITE_IOERR_BEGIN_ATOMIC",
    7690 => "SQLITE_IOERR_COMMIT_ATOMIC",
    7946 => "SQLITE_IOERR_ROLLBACK_ATOMIC",
    8202 => "SQLITE_IOERR_DATA",
    8458 => "SQLITE_IOERR_CORRUPTFS",
    8714 => "SQLITE_IOERR_IN_PAGE",
    262 => "SQLITE_LOCKED_SHAREDCACHE",
    518 => "SQLITE_LOCKED_VTAB",
    261 => "SQLITE_BUSY_RECOVERY",
    517 => "SQLITE_BUSY_SNAPSHOT",
    773 => "SQLITE_BUSY_TIMEOUT",
    270 => "SQLITE_CANTOPEN_NOTEMPDIR",
    526 => "SQLITE_CANTOPEN_ISDIR",
    782 => "SQLITE_CANTOPEN_FULLPATH",
    1038 => "SQLITE_CANTOPEN_CONVPATH",
    1294 => "SQLITE_CANTOPEN_DIRTYWAL",
    1550 => "SQLITE_CANTOPEN_SYMLINK",
    267 => "SQLITE_CORRUPT_VTAB",
    523 => "SQLITE_CORRUPT_SEQUENCE",
    779 => "SQLITE_CORRUPT_INDEX",
    264 => "SQLITE_READONLY_RECOVERY",
    520 => "SQLITE_READONLY_CANTLOCK",
    776 => "SQLITE_READONLY_ROLLBACK",
    1032 => "SQLITE_READONLY_DBMOVED",
    1288 => "SQLITE_READONLY_CANTINIT",
    1544 => "SQLITE_READONLY_DIRECTORY",
    516 => "SQLITE_ABORT_ROLLBACK",
    275 => "SQLITE_CONSTRAINT_CHECK",
    531 => "SQLITE_CONSTRAINT_COMMITHOOK",
    787 => "SQLITE_CONSTRAINT_FOREIGNKEY",
    1043 => "SQLITE_CONSTRAINT_FUNCTION",
    1299 => "SQLITE_CONSTRAINT_NOTNULL",
    1555 => "SQLITE_CONSTRAINT_PRIMARYKEY",
    1811 => "SQLITE_CONSTRAINT_TRIGGER",
    2067 => "SQLITE_CONSTRAINT_UNIQUE",
    2323 => "SQLITE_CONSTRAINT_VTAB",
    2579 => "SQLITE_CONSTRAINT_ROWID",
    2835 => "SQLITE_CONSTRAINT_PINNED",
    3091 => "SQLITE_CONSTRAINT_DATATYPE",
    283 => "SQLITE_NOTICE_RECOVER_WAL",
    539 => "SQLITE_NOTICE_RECOVER_ROLLBACK",
    795 => "SQLITE_NOTICE_RBU",
    284 => "SQLITE_WARNING_AUTOINDEX",
    279 => "SQLITE_AUTH_USER",
    256 => "SQLITE_OK_LOAD_PERMANENTLY",
    512 => "SQLITE_OK_SYMLINK",
    other => return format!("SQLITE_UNKNOWN_{other}"),
  };
  name.to_string()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn names_extended_codes() {
    assert_eq!(code_name(2067), "SQLITE_CONSTRAINT_UNIQUE");
    assert_eq!(code_name(1555), "SQLITE_CONSTRAINT_PRIMARYKEY");
    assert_eq!(code_name(787), "SQLITE_CONSTRAINT_FOREIGNKEY");
    assert_eq!(code_name(5), "SQLITE_BUSY");
  }

  #[test]
  fn js_message_prefixes_libsql_errors() {
    let err = ClientError::Sqlite { message: "x".into(), code: "SQLITE_ERROR".into(), raw_code: 1 };
    assert_eq!(err.js_message(), "SQLITE_ERROR: x");
    assert_eq!(ClientError::client_closed().js_message(), "CLIENT_CLOSED: The client is closed");
  }
}
