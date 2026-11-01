/**
 * Module shaped like `@libsql/client` (the subset `@payloadcms/db-sqlite` and
 * drizzle use) that can be aliased in place of it.
 *
 * `PAYLOAD_SQLITE_CLIENT` selects the implementation behind `createClient`:
 * - `rs` (default): the Rust SQLite runtime (`./client.ts`)
 * - `libsql`: the original `@libsql/client` (resolved through Node, so a
 *   bundler alias of `@libsql/client` to this file does not apply to it)
 */
import { writeFileSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'

import type { Config } from './client.js'

import { createClient as createRustClient } from './client.js'

export { ResultSetImpl, Sqlite3Client, Sqlite3Transaction } from './client.js'
export type { Config, Row } from './client.js'
export { LibsqlError } from './errors.js'

let transactionCount = 0

/**
 * `PAYLOAD_SQLITE_CLIENT_DEBUG`: logs which client is used and counts
 * `transaction()` calls into the file named by `PAYLOAD_SQLITE_TX_COUNT_FILE`
 * (diagnostics only: wrapping adds an own `transaction` property).
 */
const instrument = <T extends { transaction: (...args: never[]) => unknown }>(client: T): T => {
  const countFile = process.env.PAYLOAD_SQLITE_TX_COUNT_FILE
  if (!countFile) {
    return client
  }
  const transaction = client.transaction.bind(client)
  client.transaction = ((...args: never[]) => {
    transactionCount++
    writeFileSync(countFile, String(transactionCount))
    return transaction(...args)
  }) as T['transaction']
  return client
}

export const createClient = (config: Config) => {
  const isDebug = Boolean(process.env.PAYLOAD_SQLITE_CLIENT_DEBUG)
  if (isDebug) {
    writeSync(2, `[engine-rs/sqlite] createClient(${String(config?.url)}) via ${process.env.PAYLOAD_SQLITE_CLIENT === 'libsql' ? 'libsql' : 'rs'}\n`)
  }
  let client: ReturnType<typeof createRustClient>
  if (process.env.PAYLOAD_SQLITE_CLIENT === 'libsql') {
    const require = createRequire(import.meta.url)
    const libsql = require('@libsql/client') as { createClient: (config: Config) => unknown }
    client = libsql.createClient(config) as ReturnType<typeof createRustClient>
  } else {
    client = createRustClient(config)
  }
  return isDebug ? instrument(client) : client
}
