/**
 * Drop-in replacement for `@libsql/client`'s local sqlite3 client
 * (`@libsql/client/lib-esm/sqlite3.js` + `@libsql/core`), backed by the Rust
 * SQLite runtime (`crates/payload-sqlite`, bindings in
 * `crates/payload-node/src/sqlite.rs`).
 *
 * The JS-only state (`closed`, argument conversion, `Row` objects) is ported
 * here verbatim. The client's `#db` (lazily re-created after `transaction()`)
 * lives in Rust behind the client id; all database work runs in Rust on one
 * ordered queue per database file, shared by the client, its transactions and
 * every other client of the file, so calls take effect strictly in call order
 * as with libsql's synchronous binding.
 */
import type { NativeOutcome, NativeResultSet, NativeStatement } from './native.js'

import { LibsqlError, toJsError } from './errors.js'
import { getNativeSqlite } from './native.js'

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

/**
 * The argument handling of `executeStmt`. Errors are not thrown here but
 * attached to the statement, so Rust raises them at exactly the point where
 * `executeStmt` would throw (after earlier batch statements / closed checks).
 */
function normalizeStatement(stmt: InStatement, intMode: IntMode): NativeStatement {
  let sql: string = ''
  try {
    if (typeof stmt === 'string') {
      return { sql: stmt }
    }
    sql = stmt.sql
    if (Array.isArray(stmt.args)) {
      return { args: stmt.args.map((value) => valueToSql(value, intMode)), sql }
    }
    const args: Record<string, unknown> = {}
    for (const name in stmt.args) {
      const argName =
        name[0] === '@' || name[0] === '$' || name[0] === ':' ? name.substring(1) : name
      args[argName] = valueToSql((stmt.args as Record<string, unknown>)[name], intMode)
    }
    return { args: Object.values(args), names: Object.keys(args), sql }
  } catch (e) {
    const err = e as Error
    const kind =
      err instanceof RangeError ? 'RangeError' : err instanceof TypeError ? 'TypeError' : 'Error'
    return { error: [kind, String(err?.message)], sql: typeof sql === 'string' ? sql : '' }
  }
}

async function executeStmt(
  handle: Handle,
  stmt: InStatement,
  intMode: IntMode,
  inTransaction: boolean,
): Promise<ResultSetImpl> {
  const native = getNativeSqlite()
  return toResultSet(
    unwrap(
      await native.sqliteExecute(
        handle.id,
        normalizeStatement(stmt, intMode),
        intMode,
        inTransaction,
      ),
    ),
  )
}

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

  async batch(stmts: Array<InStatement>, mode: TransactionMode = 'deferred') {
    this.#checkNotClosed()
    const intMode = this.#intMode
    const normalized = stmts.map((stmt) => normalizeStatement(stmt, intMode))
    const results = unwrap(
      await getNativeSqlite().sqliteBatch(
        this.#handle.id,
        normalized,
        intMode,
        'batch',
        String(mode),
      ),
    )
    return results.map(toResultSet)
  }

  close() {
    this.closed = true
    getNativeSqlite().sqliteClientClose(this.#handle.id)
  }

  async execute(stmtOrSql: InStatement, args?: InArgs) {
    const stmt = toStatement(stmtOrSql, args)
    this.#checkNotClosed()
    return executeStmt(this.#handle, stmt, this.#intMode, false)
  }

  async executeMultiple(sql: string) {
    this.#checkNotClosed()
    unwrap(
      await getNativeSqlite().sqliteExecuteMultiple(this.#handle.id, sql, this.#intMode, false),
    )
  }

  async migrate(stmts: Array<InStatement>) {
    this.#checkNotClosed()
    const intMode = this.#intMode
    const normalized = stmts.map((stmt) => normalizeStatement(stmt, intMode))
    const results = unwrap(
      await getNativeSqlite().sqliteBatch(
        this.#handle.id,
        normalized,
        intMode,
        'migrate',
        'deferred',
      ),
    )
    return results.map(toResultSet)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async sync(): Promise<never> {
    this.#checkNotClosed()
    throw new LibsqlError(
      'sync() (embedded replicas) is not supported by the Rust SQLite runtime',
      'SYNC_NOT_SUPPORTED',
    )
  }

  /**
   * `BEGIN` runs on the current connection in queue order; on success that
   * connection moves to the transaction and the client reopens lazily.
   * Upstream does not check `closed` here.
   */
  async transaction(mode: TransactionMode = 'write') {
    const intMode = this.#intMode
    const id = unwrap(
      await getNativeSqlite().sqliteTransaction(this.#handle.id, String(mode), intMode),
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

  async batch(stmts: Array<InStatement>) {
    const intMode = this.#intMode
    const normalized = stmts.map((stmt) => normalizeStatement(stmt, intMode))
    const results = unwrap(
      await getNativeSqlite().sqliteBatch(
        this.#database.id,
        normalized,
        intMode,
        'transaction',
        '',
      ),
    )
    return results.map(toResultSet)
  }

  close() {
    getNativeSqlite().sqliteTransactionClose(this.#database.id, this.#intMode)
  }

  async commit() {
    unwrap(await getNativeSqlite().sqliteTransactionEnd(this.#database.id, 'commit', this.#intMode))
  }

  async execute(stmtOrSql: InStatement, args?: InArgs) {
    return executeStmt(this.#database, toStatement(stmtOrSql, args), this.#intMode, true)
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
  let { intMode } = config
  intMode ??= 'number'
  const created = unwrap(
    getNativeSqlite().sqliteCreateClient(
      String(url),
      String(JSON.stringify(intMode)),
      Boolean(config.syncUrl),
      Boolean(config.encryptionKey),
    ),
  )
  return new Sqlite3Client(newHandle(created.id), created.intMode)
}

/**
 * The Rust connection id (`payload_sqlite::ConnId`) behind a client or
 * transaction created by this module. Rust engine code queued for this id
 * runs in call order with every other call on the same database file, on the
 * client's current connection (`#getDb()`) or the transaction's connection.
 */
export function getSqliteConnId(target: Sqlite3Client | Sqlite3Transaction): number {
  const handle = handles.get(target)
  if (!handle) {
    throw new TypeError('Not a client or transaction of the Rust SQLite runtime')
  }
  return handle.id
}
