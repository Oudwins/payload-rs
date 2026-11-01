import { createRequire } from 'node:module'

/** A statement normalized by `normalizeStatement` (see client.ts). */
export type NativeStatement = {
  args?: unknown[]
  /** `[errorClassName, message]` thrown by `valueToSql`, raised when the statement is reached. */
  error?: [string, string]
  sql: string
}

export type NativeError = {
  code?: string
  kind: 'Error' | 'libsql' | 'libsqlUri' | 'native' | 'RangeError' | 'sqlite' | 'TypeError'
  message: string
  rawCode?: number
}

export type NativeOutcome<T> = { error: NativeError; ok?: undefined } | { error?: undefined; ok: T }

export type NativeResultSet = {
  columns: string[]
  columnTypes: string[]
  lastInsertRowid: bigint | undefined
  rows: unknown[][]
  rowsAffected: number
}

export type NativeSqlite = {
  sqliteClientClose: (id: number) => void
  sqliteCreateClient: (
    url: string,
    intModeJson: string,
    syncUrl: boolean,
    /** `config.authToken` is a string or nullish. */
    isAuthTokenValid: boolean,
    /** `config.encryptionKey ?? ""` when that is a string. */
    encryptionKey: string,
    /** `config.encryptionKey` is a string or nullish. */
    isEncryptionKeyValid: boolean,
  ) => NativeOutcome<{ id: number; intMode: 'bigint' | 'number' | 'string'; path: string }>
  /** Runs `sql` through plain rusqlite on the queue of `id` (engine-side SQL, tests). */
  sqliteEngineQuery: (id: number, sql: string) => Promise<Array<null | string>>
  sqliteExecute: (
    id: number,
    stmt: NativeStatement,
    intMode: string,
    inTransaction: boolean,
  ) => Promise<NativeOutcome<NativeResultSet>>
  sqliteExecuteMultiple: (
    id: number,
    sql: string,
    intMode: string,
    inTransaction: boolean,
  ) => Promise<NativeOutcome<undefined>>
  /** One `executeStmt` step, synchronously (blocks until earlier queued work is done). */
  sqliteExecuteSync: (
    id: number,
    stmt: NativeStatement,
    intMode: string,
  ) => NativeOutcome<NativeResultSet>
  /** `#getDb()` of a client (no-op for transactions), synchronously. */
  sqliteGetDbSync: (id: number) => NativeOutcome<undefined>
  sqliteInTransaction: (id: number) => NativeOutcome<boolean>
  /** `db.prepare(sql)` and its parameter names (`null` when nameless), synchronously. */
  sqliteParameterNamesSync: (id: number, sql: string) => NativeOutcome<Array<null | string>>
  sqliteRelease: (id: number) => void
  /**
   * Starts recording the statements of connections opened with `PAYLOAD_SQLITE_TRACE=true`
   * (diagnostics: the engine's SQL bypasses `client.execute`).
   */
  sqliteStartStatementTrace: () => void
  sqliteStats: () => [registered: number, liveWorkers: number]
  /** `[sql, bound parameter count]` of every statement recorded since the start; stops recording. */
  sqliteTakeStatementTrace: () => [sql: string, parameterCount: number][]
  sqliteTransaction: (id: number, mode: string, intMode: string) => Promise<NativeOutcome<number>>
  sqliteTransactionClose: (id: number, intMode: string) => void
  sqliteTransactionEnd: (
    id: number,
    action: 'commit' | 'rollback',
    intMode: string,
  ) => Promise<NativeOutcome<undefined>>
}

let native: NativeSqlite | undefined

/**
 * Loads the SQLite part of the addon. `PAYLOAD_ENGINE_ADDON` may point at an
 * alternative build of the addon (e.g. an agent-local cargo target dir).
 */
export const getNativeSqlite = (): NativeSqlite => {
  if (!native) {
    const require = createRequire(import.meta.url)
    native = require(
      process.env.PAYLOAD_ENGINE_ADDON || '../../payload-engine.node',
    ) as NativeSqlite
  }
  return native
}
