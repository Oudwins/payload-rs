/**
 * Test-only replacement for `test/databaseAdapter.js` (wired by
 * `test/__rs/sqlite/vitest.config.ts` when `PAYLOAD_SQLITE_TRANSACTIONS=1`):
 * the regular sqlite test adapter plus `transactionOptions`, so Payload runs
 * every operation in `client.transaction()` connections (begin / commit /
 * rollback across connections) instead of the no-op default transaction.
 */
import { sqliteAdapter } from '@payloadcms/db-sqlite'

export const databaseAdapter = sqliteAdapter({
  autoIncrement: true,
  client: {
    url: process.env.SQLITE_URL || process.env.DATABASE_URL || 'file:./payload.db',
  },
  transactionOptions: {},
})
