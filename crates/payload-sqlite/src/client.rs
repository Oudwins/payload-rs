//! The database-touching parts of `Sqlite3Client` / `Sqlite3Transaction`
//! (`@libsql/client/lib-esm/sqlite3.js`). Everything that only manipulates
//! JS-side state (`closed`, `#db = null`, argument conversion) stays in the TS
//! glue (`packages/engine-rs/src/sqlite/client.ts`); everything that runs
//! against the connection is executed here, as one unit, so that the
//! observable ordering of statements is identical.

use crate::conn::Conn;
use crate::error::{ClientError, Result};
use crate::value::{IntMode, ResultSet, Statement};

/// `transactionModeToBegin(mode)` of `@libsql/core/util`.
pub fn transaction_mode_to_begin(mode: &str) -> Result<&'static str> {
  match mode {
    "write" => Ok("BEGIN IMMEDIATE"),
    "read" => Ok("BEGIN TRANSACTION READONLY"),
    "deferred" => Ok("BEGIN DEFERRED"),
    _ => Err(ClientError::Range(
      "Unknown transaction mode, supported values are \"write\", \"read\" and \"deferred\"".to_string(),
    )),
  }
}

/// Runs `body`, then the `finally { if (db.inTransaction) ROLLBACK }` block.
/// An error thrown by the rollback replaces the original outcome, like a
/// throwing `finally` does in JS.
fn with_rollback_finally<T>(conn: &Conn, int_mode: IntMode, body: impl FnOnce() -> Result<T>) -> Result<T> {
  let out = body();
  if conn.in_transaction() {
    conn.execute_sql("ROLLBACK", int_mode)?;
  }
  out
}

fn run_in_transaction(conn: &Conn, stmts: &[Statement], int_mode: IntMode) -> Result<Vec<ResultSet>> {
  stmts
    .iter()
    .map(|stmt| {
      if !conn.in_transaction() {
        return Err(ClientError::transaction_rolled_back());
      }
      conn.execute(stmt, int_mode)
    })
    .collect()
}

/// `Sqlite3Client.batch(stmts, mode)` after `#checkNotClosed()` and `#getDb()`.
pub fn batch(conn: &Conn, stmts: &[Statement], mode: &str, int_mode: IntMode) -> Result<Vec<ResultSet>> {
  with_rollback_finally(conn, int_mode, || {
    conn.execute_sql(transaction_mode_to_begin(mode)?, int_mode)?;
    let results = run_in_transaction(conn, stmts, int_mode)?;
    conn.execute_sql("COMMIT", int_mode)?;
    Ok(results)
  })
}

/// `Sqlite3Client.migrate(stmts)` after `#checkNotClosed()` and `#getDb()`.
pub fn migrate(conn: &Conn, stmts: &[Statement], int_mode: IntMode) -> Result<Vec<ResultSet>> {
  let out = (|| {
    conn.execute_sql("PRAGMA foreign_keys=off", int_mode)?;
    conn.execute_sql(transaction_mode_to_begin("deferred")?, int_mode)?;
    let results = run_in_transaction(conn, stmts, int_mode)?;
    conn.execute_sql("COMMIT", int_mode)?;
    Ok(results)
  })();
  if conn.in_transaction() {
    conn.execute_sql("ROLLBACK", int_mode)?;
  }
  conn.execute_sql("PRAGMA foreign_keys=on", int_mode)?;
  out
}

/// `Sqlite3Client.executeMultiple(sql)` after `#checkNotClosed()` and `#getDb()`.
pub fn execute_multiple(conn: &Conn, sql: &str, int_mode: IntMode) -> Result<()> {
  with_rollback_finally(conn, int_mode, || conn.exec(sql))
}

/// `Sqlite3Client.transaction(mode)`: the `BEGIN` part (the client then
/// detaches the connection and lazily opens a new one).
pub fn begin(conn: &Conn, mode: &str, int_mode: IntMode) -> Result<()> {
  conn.execute_sql(transaction_mode_to_begin(mode)?, int_mode).map(|_| ())
}

/// `Sqlite3Transaction.#checkNotClosed()`.
pub fn check_transaction_open(conn: &Conn) -> Result<()> {
  if conn.in_transaction() { Ok(()) } else { Err(ClientError::transaction_closed()) }
}

/// `Sqlite3Transaction.execute(stmt)`.
pub fn tx_execute(conn: &Conn, stmt: &Statement, int_mode: IntMode) -> Result<ResultSet> {
  check_transaction_open(conn)?;
  conn.execute(stmt, int_mode)
}

/// `Sqlite3Transaction.batch(stmts)`: no implicit transaction, stops at the
/// first error.
pub fn tx_batch(conn: &Conn, stmts: &[Statement], int_mode: IntMode) -> Result<Vec<ResultSet>> {
  stmts
    .iter()
    .map(|stmt| {
      check_transaction_open(conn)?;
      conn.execute(stmt, int_mode)
    })
    .collect()
}

/// `Sqlite3Transaction.executeMultiple(sql)`.
pub fn tx_execute_multiple(conn: &Conn, sql: &str) -> Result<()> {
  check_transaction_open(conn)?;
  conn.exec(sql)
}

/// `Sqlite3Transaction.commit()`.
pub fn tx_commit(conn: &Conn, int_mode: IntMode) -> Result<()> {
  check_transaction_open(conn)?;
  conn.execute_sql("COMMIT", int_mode).map(|_| ())
}

/// `Sqlite3Transaction.rollback()`. The transaction's database is never
/// closed by the client, so the `!this.#database.open` early return only
/// applies to a closed handle.
pub fn tx_rollback(conn: &Conn, int_mode: IntMode) -> Result<()> {
  if !conn.is_open() {
    return Ok(());
  }
  check_transaction_open(conn)?;
  conn.execute_sql("ROLLBACK", int_mode).map(|_| ())
}

/// `Sqlite3Transaction.close()`.
pub fn tx_close(conn: &Conn, int_mode: IntMode) -> Result<()> {
  if conn.in_transaction() {
    conn.execute_sql("ROLLBACK", int_mode)?;
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::value::{BindValue, Cell};

  fn setup() -> Conn {
    let c = Conn::open("file::memory:").unwrap();
    c.execute_sql("create table t (a text unique)", IntMode::Number).unwrap();
    c
  }

  fn count(c: &Conn) -> Cell {
    c.execute_sql("select count(*) from t", IntMode::Number).unwrap().rows[0][0].clone()
  }

  #[test]
  fn batch_is_atomic() {
    let c = setup();
    let stmts = vec![
      Statement::with_args("insert into t values (?)", vec![BindValue::Text("x".into())]),
      Statement::with_args("insert into t values (?)", vec![BindValue::Text("x".into())]),
    ];
    let err = batch(&c, &stmts, "deferred", IntMode::Number).unwrap_err();
    assert_eq!(err.code(), Some("SQLITE_CONSTRAINT_UNIQUE"));
    assert_eq!(count(&c), Cell::Number(0.0));
    assert!(!c.in_transaction());
  }

  #[test]
  fn batch_detects_commit_inside() {
    let c = setup();
    let stmts =
      vec![Statement::sql("insert into t values ('a')"), Statement::sql("commit"), Statement::sql("select 1")];
    let err = batch(&c, &stmts, "write", IntMode::Number).unwrap_err();
    assert_eq!(err, ClientError::transaction_rolled_back());
    assert_eq!(count(&c), Cell::Number(1.0));
  }

  #[test]
  fn execute_multiple_rolls_back_open_transaction() {
    let c = setup();
    execute_multiple(&c, "begin; insert into t values ('q');", IntMode::Number).unwrap();
    assert_eq!(count(&c), Cell::Number(0.0));
  }

  #[test]
  fn transaction_lifecycle() {
    let c = setup();
    begin(&c, "write", IntMode::Number).unwrap();
    tx_execute(&c, &Statement::sql("insert into t values ('z')"), IntMode::Number).unwrap();
    tx_commit(&c, IntMode::Number).unwrap();
    assert_eq!(tx_commit(&c, IntMode::Number).unwrap_err(), ClientError::transaction_closed());
    assert_eq!(tx_rollback(&c, IntMode::Number).unwrap_err(), ClientError::transaction_closed());
    assert!(tx_close(&c, IntMode::Number).is_ok());
    assert!(matches!(begin(&c, "nope", IntMode::Number).unwrap_err(), ClientError::Range(_)));
  }
}
