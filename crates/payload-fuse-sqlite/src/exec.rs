//! Statement execution of the fast path: libsql's `executeStmt` (`stmt.raw().all(args)`) on the
//! connection's rusqlite handle with its prepared-statement cache, so repeated reads skip SQL
//! parsing. Values are read exactly like `payload_sqlite::Conn::execute` reads them (text up to
//! the first NUL, lossy UTF-8; integers as numbers, failing beyond 2^53).

use payload_engine::error::{EngineError, Result};
use payload_sql_find::exec::statement;
use payload_sql_find::sql::Sql;
use payload_sqlite::rusqlite::types::{ToSqlOutput, ValueRef};
use payload_sqlite::value::{Args, BindValue, SqlValue, value_from_sql};
use payload_sqlite::{Cell, Conn, IntMode};

fn engine_error(error: impl std::fmt::Display) -> EngineError {
  EngineError::new("DrizzleQueryError", error.to_string())
}

/// Runs `sql` and returns its rows.
pub fn query(conn: &Conn, sql: &Sql) -> Result<Vec<Vec<Cell>>> {
  let stmt = statement(sql);
  if let Some(error) = &stmt.error {
    return Err(engine_error(format!("{error:?}")));
  }
  let connection = conn.connection().map_err(|e| engine_error(format!("{e:?}")))?;
  let mut prepared = connection.prepare_cached(&stmt.sql).map_err(engine_error)?;
  let count = prepared.parameter_count();
  match &stmt.args {
    Args::Positional(values) => {
      for (i, value) in values.iter().enumerate().take(count) {
        let value = match value {
          BindValue::Null => ToSqlOutput::Borrowed(ValueRef::Null),
          BindValue::Real(f) => ToSqlOutput::Borrowed(ValueRef::Real(*f)),
          BindValue::Integer(n) => ToSqlOutput::Borrowed(ValueRef::Integer(*n)),
          BindValue::Text(s) => ToSqlOutput::Borrowed(ValueRef::Text(s.as_bytes())),
          BindValue::Blob(b) => ToSqlOutput::Borrowed(ValueRef::Blob(b)),
          BindValue::Invalid => return Err(engine_error("invalid bind value")),
        };
        prepared.raw_bind_parameter(i + 1, value).map_err(engine_error)?;
      }
    }
    Args::Named(_) => return Err(engine_error("named parameters")),
  }
  let columns = prepared.column_count();
  let mut out = Vec::new();
  let mut rows = prepared.raw_query();
  while let Some(row) = rows.next().map_err(engine_error)? {
    let mut cells = Vec::with_capacity(columns);
    for i in 0..columns {
      let value = match row.get_ref(i).map_err(engine_error)? {
        ValueRef::Null => SqlValue::Null,
        ValueRef::Integer(n) => SqlValue::Integer(n),
        ValueRef::Real(f) => SqlValue::Real(f),
        ValueRef::Text(bytes) => {
          let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
          SqlValue::Text(String::from_utf8_lossy(&bytes[..end]).into_owned())
        }
        ValueRef::Blob(bytes) => SqlValue::Blob(bytes.to_vec()),
      };
      cells.push(value_from_sql(value, IntMode::Number).map_err(|e| engine_error(format!("{e:?}")))?);
    }
    out.push(cells);
  }
  Ok(out)
}
