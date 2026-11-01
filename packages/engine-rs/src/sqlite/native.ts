import { createRequire } from 'node:module'

/** A statement normalized by `normalizeStatement` (see client.ts). */
export type NativeStatement = {
  args?: unknown[]
  /** `[errorClassName, message]` thrown by `valueToSql`, raised when the statement is reached. */
  error?: [string, string]
  /** Present for named arguments (`args` is then the list of values). */
  names?: string[]
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
  sqliteBatch: (
    id: number,
    stmts: NativeStatement[],
    intMode: string,
    kind: 'batch' | 'migrate' | 'transaction',
    mode: string,
  ) => Promise<NativeOutcome<NativeResultSet[]>>
  sqliteClientClose: (id: number) => void
  sqliteCreateClient: (
    url: string,
    intModeJson: string,
    syncUrl: boolean,
    encryptionKey: boolean,
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
  sqliteInTransaction: (id: number) => NativeOutcome<boolean>
  sqliteRelease: (id: number) => void
  sqliteStats: () => [registered: number, liveWorkers: number]
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
