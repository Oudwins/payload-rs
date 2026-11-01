/**
 * Drop-in replacement for `@libsql/client`'s local sqlite3 client
 * (`@libsql/client/lib-esm/sqlite3.js` + `@libsql/core`), backed by the Rust
 * SQLite runtime (`crates/payload-sqlite`, bindings in
 * `crates/payload-node/src/sqlite.rs`).
 *
 * The JS-only state (`closed`, argument conversion, `Row` objects) is ported
 * here verbatim. The client's `#db` (lazily re-created after `transaction()`)
 * lives in Rust behind the client id; all database work runs in Rust on one
 * process-wide ordered queue, shared by every client and transaction, so
 * calls take effect strictly in call order as with libsql's synchronous
 * binding.
 *
 * Single statements with positional arguments whose reads have no
 * observable effect (`hasUnobservableReads`, e.g. drizzle's) run as queued
 * jobs. Where upstream interleaves JS evaluation with statement execution
 * (batches and migrations read each statement only when it is reached; named
 * arguments are looked up by the parameter names of the prepared statement;
 * statement getters run after the client's `#getDb()` / the transaction's
 * closed check), the port runs upstream's code verbatim on top of blocking
 * native steps (`executeStmtSync`), exactly as the synchronous `libsql`
 * binding does.
 */
import { types } from 'node:util'

import type { NativeOutcome, NativeResultSet, NativeStatement } from './native.js'

import { LibsqlError, toJsError } from './errors.js'
import { getNativeSqlite } from './native.js'

type NativeHandleId = number

type IntMode = 'bigint' | 'number' | 'string'
type TransactionMode = 'deferred' | 'read' | 'write'
type InValue = ArrayBuffer | bigint | boolean | Date | null | number | string | Uint8Array
type InArgs = Array<InValue> | Record<string, InValue>
type InStatement = { args?: InArgs; sql: string } | string

export type Row = {
  [index: number]: unknown
  [name: string]: unknown
  length: number
}

/** A connection handle; its garbage collection releases the native connection. */
type Handle = { readonly id: number }

const finalizer = new FinalizationRegistry<number>((id) => {
  getNativeSqlite().sqliteRelease(id)
})

const newHandle = (id: number): Handle => {
  const handle = { id }
  finalizer.register(handle, id)
  return handle
}

/** Handle of every client / transaction, for `getSqliteConnId`. */
const handles = new WeakMap<object, Handle>()

const unwrap = <T>(outcome: NativeOutcome<T>): T => {
  if (outcome.error) {
    throw toJsError(outcome.error)
  }
  return outcome.ok as T
}

/**
 * Port of `ResultSetImpl` (`@libsql/core/lib-esm/util.js`). Fields are
 * `declare`d so the own-property order is the constructor's assignment order
 * (`columns, columnTypes, rows, rowsAffected, lastInsertRowid`), as upstream.
 */
export class ResultSetImpl {
  declare columns: string[]
  declare columnTypes: string[]
  declare lastInsertRowid: bigint | undefined
  declare rows: Row[]
  declare rowsAffected: number

  constructor(
    columns: string[],
    columnTypes: string[],
    rows: Row[],
    rowsAffected: number,
    lastInsertRowid: bigint | undefined,
  ) {
    this.columns = columns
    this.columnTypes = columnTypes
    this.rows = rows
    this.rowsAffected = rowsAffected
    this.lastInsertRowid = lastInsertRowid
  }

  toJSON() {
    // Built by assignment to keep upstream's key order.
    const json: Record<string, unknown> = {}
    json.columns = this.columns
    json.columnTypes = this.columnTypes
    json.rows = this.rows.map(rowToJson)
    json.rowsAffected = this.rowsAffected
    json.lastInsertRowid = this.lastInsertRowid !== undefined ? '' + this.lastInsertRowid : null
    return json
  }
}

function rowToJson(row: Row) {
  return Array.prototype.map.call(row, valueToJson)
}

function valueToJson(value: unknown) {
  if (typeof value === 'bigint') {
    return '' + value
  } else if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString('base64')
  }
  return value
}

/** Port of `rowFromSql`. */
function rowFromSql(sqlRow: unknown[], columns: string[]): Row {
  const row = {} as Row
  // make sure that the "length" property is not enumerable
  Object.defineProperty(row, 'length', { value: sqlRow.length })
  for (let i = 0; i < sqlRow.length; ++i) {
    const value = sqlRow[i]
    Object.defineProperty(row, i, { value })
    const column = columns[i]!
    if (!Object.hasOwn(row, column)) {
      Object.defineProperty(row, column, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      })
    }
  }
  return row
}

const toResultSet = (rs: NativeResultSet) =>
  new ResultSetImpl(
    rs.columns,
    rs.columnTypes,
    rs.rows.map((r) => rowFromSql(r, rs.columns)),
    rs.rowsAffected,
    rs.lastInsertRowid,
  )

const minInteger = -9223372036854775808n
const maxInteger = 9223372036854775807n

/** Port of `valueToSql`. */
function valueToSql(value: unknown, intMode: IntMode): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError('Only finite numbers (not Infinity or NaN) can be passed as arguments')
    }
    return value
  } else if (typeof value === 'bigint') {
    if (value < minInteger || value > maxInteger) {
      throw new RangeError(
        'bigint is too large to be represented as a 64-bit integer and passed as argument',
      )
    }
    return value
  } else if (typeof value === 'boolean') {
    switch (intMode) {
      case 'bigint':
        return value ? 1n : 0n
      case 'string':
        return value ? '1' : '0'
      default:
        return value ? 1 : 0
    }
  } else if (value instanceof ArrayBuffer) {
    return Buffer.from(value)
  } else if (value instanceof Date) {
    return value.valueOf()
  } else if (value === undefined) {
    throw new TypeError('undefined cannot be passed as argument to the database')
  }
  return value
}

/** A statement after the argument conversion of upstream `executeStmt`. */
type ConvertedStatement = { args: Record<string, unknown> | unknown[]; sql: unknown }

/**
 * The argument conversion of upstream `executeStmt`, verbatim: reads
 * `stmt.sql` once and `stmt.args` twice, and throws what `valueToSql` throws.
 * Anything but an array of args (including none) builds a named-arguments
 * object.
 */
function convertStatement(stmt: InStatement, intMode: IntMode): ConvertedStatement {
  if (typeof stmt === 'string') {
    return { args: [], sql: stmt }
  }
  const sql: unknown = stmt.sql
  if (Array.isArray(stmt.args)) {
    return { args: stmt.args.map((value) => valueToSql(value, intMode)), sql }
  }
  const args: Record<string, unknown> = {}
  for (const name in stmt.args) {
    const argName = name[0] === '@' || name[0] === '$' || name[0] === ':' ? name.substring(1) : name
    args[argName] = valueToSql((stmt.args as Record<string, unknown>)[name], intMode)
  }
  return { args, sql }
}

/** `db.prepare(sql)` of the binding reads `sql` as a string argument. */
const sqlTypeError = () => new TypeError('failed to downcast any to string')

/** A thrown error as `[class, message]` for `NativeStatement.error`. */
const describeThrown = (e: unknown): [string, string] => {
  const err = e as Error
  const kind =
    err instanceof RangeError ? 'RangeError' : err instanceof TypeError ? 'TypeError' : 'Error'
  return [kind, String(err?.message)]
}

/**
 * Whether reading `stmt` the way `executeStmt` does (`stmt.sql`, `stmt.args`,
 * each positional value) has no observable effect and gives positional
 * arguments: no proxies, getters or named arguments. Only then can the
 * statement be read before upstream's `#getDb()` / closed check (which run in
 * queue order in Rust) without a visible difference.
 */
function hasUnobservableReads(stmt: InStatement): stmt is { args: InValue[]; sql: string } {
  if (typeof stmt !== 'object' || stmt === null || types.isProxy(stmt)) {
    return false
  }
  const sql = Object.getOwnPropertyDescriptor(stmt, 'sql')
  const args = Object.getOwnPropertyDescriptor(stmt, 'args')
  if (!sql || !('value' in sql) || !args || !('value' in args)) {
    return false
  }
  const values: unknown = args.value
  if (
    !Array.isArray(values) ||
    types.isProxy(values) ||
    Object.getPrototypeOf(values) !== Array.prototype
  ) {
    return false
  }
  for (let i = 0; i < values.length; i++) {
    const value = Object.getOwnPropertyDescriptor(values, i)
    // holes are skipped by `map`
    if (value && (!('value' in value) || !isUnobservableValue(value.value))) {
      return false
    }
  }
  return true
}

/** `valueToSql(value)` reads nothing user-defined from `value`. */
const isUnobservableValue = (value: unknown) =>
  value === null ||
  (typeof value !== 'object' && typeof value !== 'function') ||
  (typeof value === 'object' &&
    !types.isProxy(value) &&
    (ArrayBuffer.isView(value) ||
      types.isArrayBuffer(value) ||
      (types.isDate(value) &&
        Object.getPrototypeOf(value) === Date.prototype &&
        !Object.hasOwn(value, 'valueOf'))))

/**
 * Runs one statement (see `hasUnobservableReads`) as a queued job. Errors of
 * the conversion (and a non-string `sql`) are not thrown here but attached to
 * the statement, so Rust raises them in queue order exactly where
 * `executeStmt` would throw (after `#getDb()` / the transaction's closed
 * check).
 */
async function executeStmt(
  handle: Handle,
  stmt: { args: InValue[]; sql: string },
  intMode: IntMode,
  inTransaction: boolean,
): Promise<ResultSetImpl> {
  let converted: ConvertedStatement
  try {
    converted = convertStatement(stmt, intMode)
  } catch (e) {
    return runQueued(handle, { error: describeThrown(e), sql: '' }, intMode, inTransaction)
  }
  const { args, sql } = converted
  // `args` is an array (`hasUnobservableReads`)
  const native: NativeStatement =
    typeof sql === 'string' && Array.isArray(args)
      ? { args, sql }
      : { error: describeThrown(sqlTypeError()), sql: '' }
  return runQueued(handle, native, intMode, inTransaction)
}

async function runQueued(
  handle: Handle,
  native: NativeStatement,
  intMode: IntMode,
  inTransaction: boolean,
) {
  return toResultSet(
    unwrap(await getNativeSqlite().sqliteExecute(handle.id, native, intMode, inTransaction)),
  )
}

/** `transactionModeToBegin` of `@libsql/core/util`. */
function transactionModeToBegin(mode: unknown) {
  if (mode === 'write') {
    return 'BEGIN IMMEDIATE'
  } else if (mode === 'read') {
    return 'BEGIN TRANSACTION READONLY'
  } else if (mode === 'deferred') {
    return 'BEGIN DEFERRED'
  }
  throw RangeError('Unknown transaction mode, supported values are "write", "read" and "deferred"')
}

/**
 * Port of upstream `executeStmt(db, stmt, intMode)`, run synchronously on the
 * connection behind `id` (the client's `#getDb()` or the transaction's
 * `#database`).
 */
const executeStmtSync = (id: NativeHandleId, stmt: InStatement, intMode: IntMode) =>
  executeConvertedSync(id, convertStatement(stmt, intMode), intMode)

/**
 * The binding part of `executeStmtSync`. Named arguments are looked up like
 * the binding's `convert_params_object`: `args[name.slice(1)]` (a JS property
 * lookup, prototype included) for each parameter name of the prepared
 * statement. A nameless `?` parameter with named arguments aborts the process
 * in the binding (`unwrap` on `None`); here it is bound to NULL.
 */
function executeConvertedSync(
  id: NativeHandleId,
  { args, sql }: ConvertedStatement,
  intMode: IntMode,
) {
  const native = getNativeSqlite()
  if (typeof sql !== 'string') {
    throw sqlTypeError()
  }
  const values = Array.isArray(args)
    ? args
    : unwrap(native.sqliteParameterNamesSync(id, sql)).map((name) =>
        name === null ? null : args[name.substring(1)],
      )
  return toResultSet(unwrap(native.sqliteExecuteSync(id, { args: values, sql }, intMode)))
}

/** `db.inTransaction` of the connection behind `id`, synchronously. */
const inTransactionSync = (id: NativeHandleId) => unwrap(getNativeSqlite().sqliteInTransaction(id))

const toStatement = (stmtOrSql: InStatement, args?: InArgs): InStatement =>
  typeof stmtOrSql === 'string' ? { args: args || [], sql: stmtOrSql } : stmtOrSql

/**
 * Port of `Sqlite3Client`. `#getDb()` (lazy reconnect) runs in Rust, in queue
 * order, on the connection addressed by `#handle`.
 */
export class Sqlite3Client {
  #handle: Handle
  #intMode: IntMode
  // `closed` before `protocol`: own-property order of upstream.
  declare closed: boolean
  declare protocol: 'file'

  /** @private */
  constructor(handle: Handle, intMode: IntMode) {
    this.#handle = handle
    this.#intMode = intMode
    handles.set(this, handle)
    this.closed = false
    this.protocol = 'file'
  }

  #checkNotClosed() {
    if (this.closed) {
      throw new LibsqlError('The client is closed', 'CLIENT_CLOSED')
    }
  }

  /** `#getDb()`: opens `#db` in Rust if a transaction detached it, synchronously. */
  #getDb() {
    unwrap(getNativeSqlite().sqliteGetDbSync(this.#handle.id))
    return this.#handle.id
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async batch(stmts: Array<InStatement>, mode: TransactionMode = 'deferred') {
    this.#checkNotClosed()
    const db = this.#getDb()
    try {
      executeStmtSync(db, transactionModeToBegin(mode), this.#intMode)
      const resultSets = stmts.map((stmt) => {
        if (!inTransactionSync(db)) {
          throw new LibsqlError('The transaction has been rolled back', 'TRANSACTION_CLOSED')
        }
        return executeStmtSync(db, stmt, this.#intMode)
      })
      executeStmtSync(db, 'COMMIT', this.#intMode)
      return resultSets
    } finally {
      if (inTransactionSync(db)) {
        executeStmtSync(db, 'ROLLBACK', this.#intMode)
      }
    }
  }

  close() {
    this.closed = true
    getNativeSqlite().sqliteClientClose(this.#handle.id)
  }

  async execute(stmtOrSql: InStatement, args?: InArgs) {
    const stmt = toStatement(stmtOrSql, args)
    this.#checkNotClosed()
    if (!hasUnobservableReads(stmt)) {
      // upstream order: `#getDb()`, then `executeStmt` reads the statement
      return executeStmtSync(this.#getDb(), stmt, this.#intMode)
    }
    return executeStmt(this.#handle, stmt, this.#intMode, false)
  }

  async executeMultiple(sql: string) {
    this.#checkNotClosed()
    unwrap(
      await getNativeSqlite().sqliteExecuteMultiple(this.#handle.id, sql, this.#intMode, false),
    )
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async migrate(stmts: Array<InStatement>) {
    this.#checkNotClosed()
    const db = this.#getDb()
    try {
      executeStmtSync(db, 'PRAGMA foreign_keys=off', this.#intMode)
      executeStmtSync(db, transactionModeToBegin('deferred'), this.#intMode)
      const resultSets = stmts.map((stmt) => {
        if (!inTransactionSync(db)) {
          throw new LibsqlError('The transaction has been rolled back', 'TRANSACTION_CLOSED')
        }
        return executeStmtSync(db, stmt, this.#intMode)
      })
      executeStmtSync(db, 'COMMIT', this.#intMode)
      return resultSets
    } finally {
      if (inTransactionSync(db)) {
        executeStmtSync(db, 'ROLLBACK', this.#intMode)
      }
      executeStmtSync(db, 'PRAGMA foreign_keys=on', this.#intMode)
    }
  }

  /**
   * `this.#getDb().sync()`: a local (non-replica) database rejects with the
   * binding's `libsql::Error::SyncNotSupported("File")` (plain `Error`,
   * `code: ""`).
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async sync(): Promise<never> {
    this.#checkNotClosed()
    this.#getDb()
    throw toJsError({ code: '', kind: 'Error', message: 'SyncNotSupported("File")' })
  }

  /**
   * `BEGIN` runs on the current connection in queue order; on success that
   * connection moves to the transaction and the client reopens lazily.
   * Upstream does not check `closed` here.
   */
  async transaction(mode: TransactionMode = 'write') {
    const intMode = this.#intMode
    // Any non-string mode fails `transactionModeToBegin` like '' does.
    const id = unwrap(
      await getNativeSqlite().sqliteTransaction(
        this.#handle.id,
        typeof mode === 'string' ? mode : '',
        intMode,
      ),
    )
    return new Sqlite3Transaction(newHandle(id), intMode)
  }
}

/** Port of `Sqlite3Transaction`. The `#checkNotClosed()` calls run in Rust, in order. */
export class Sqlite3Transaction {
  #database: Handle
  #intMode: IntMode

  /** @private */
  constructor(database: Handle, intMode: IntMode) {
    this.#database = database
    this.#intMode = intMode
    handles.set(this, database)
  }

  #checkNotClosed() {
    if (this.closed) {
      throw new LibsqlError('The transaction is closed', 'TRANSACTION_CLOSED')
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async batch(stmts: Array<InStatement>) {
    return stmts.map((stmt) => {
      this.#checkNotClosed()
      return executeStmtSync(this.#database.id, stmt, this.#intMode)
    })
  }

  close() {
    getNativeSqlite().sqliteTransactionClose(this.#database.id, this.#intMode)
  }

  async commit() {
    unwrap(await getNativeSqlite().sqliteTransactionEnd(this.#database.id, 'commit', this.#intMode))
  }

  async execute(stmtOrSql: InStatement, args?: InArgs) {
    const stmt = toStatement(stmtOrSql, args)
    if (!hasUnobservableReads(stmt)) {
      // upstream order: `#checkNotClosed()`, then `executeStmt` reads the statement
      this.#checkNotClosed()
      return executeStmtSync(this.#database.id, stmt, this.#intMode)
    }
    return executeStmt(this.#database, stmt, this.#intMode, true)
  }

  async executeMultiple(sql: string) {
    unwrap(
      await getNativeSqlite().sqliteExecuteMultiple(this.#database.id, sql, this.#intMode, true),
    )
  }

  async rollback() {
    unwrap(
      await getNativeSqlite().sqliteTransactionEnd(this.#database.id, 'rollback', this.#intMode),
    )
  }

  get closed(): boolean {
    return !unwrap(getNativeSqlite().sqliteInTransaction(this.#database.id))
  }
}

export type Config = {
  [key: string]: unknown
  authToken?: string
  encryptionKey?: string
  intMode?: IntMode
  syncUrl?: string
  url: string
}

/**
 * Drop-in for `createClient` of `@libsql/client` for local (`file:` /
 * `:memory:`) databases.
 */
export function createClient(config: Config): Sqlite3Client {
  // expandConfig
  if (typeof config !== 'object') {
    throw new TypeError(`Expected client configuration as object, got ${typeof config}`)
  }
  // `let { url, authToken, tls, intMode, concurrency } = config`: `url` is
  // destructured first (matters for the TypeError message when config is null).
  const { url } = config
  let { authToken, intMode } = config
  intMode ??= 'number'
  // `new Database(path, opts)` reads `opts.authToken ?? ""` and
  // `opts.encryptionKey ?? ""` as string arguments.
  authToken ??= ''
  const encryptionKey: unknown = config.encryptionKey ?? ''
  const created = unwrap(
    getNativeSqlite().sqliteCreateClient(
      String(url),
      String(JSON.stringify(intMode)),
      Boolean(config.syncUrl),
      typeof authToken === 'string',
      typeof encryptionKey === 'string' ? encryptionKey : '',
      typeof encryptionKey === 'string',
    ),
  )
  return new Sqlite3Client(newHandle(created.id), created.intMode)
}

/**
 * The Rust connection id (`payload_sqlite::ConnId`) behind a client or
 * transaction created by this module. Rust engine code queued for this id
 * runs in call order with every other call (one process-wide queue), on the
 * client's current connection (`#getDb()`) or the transaction's connection.
 */
export function getSqliteConnId(target: Sqlite3Client | Sqlite3Transaction): number {
  const handle = handles.get(target)
  if (!handle) {
    throw new TypeError('Not a client or transaction of the Rust SQLite runtime')
  }
  return handle.id
}
