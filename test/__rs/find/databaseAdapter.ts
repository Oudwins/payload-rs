/**
 * Alias target for `databaseAdapter.js` used by test/__rs/find/vitest.config.ts, so find
 * differential runs never rewrite the shared, generated test/databaseAdapter.js.
 *
 * RS_FIND_ADAPTER selects the adapter flavour (options mirror test/dbAdapters.ts):
 * - `sqlite` (default): `{ autoIncrement: true }`
 * - `sqlite-uuid` / `sqlite-uuidv7`: `{ idType }`
 * RS_FIND_BLOCKS_AS_JSON=true additionally sets `blocksAsJSON: true`.
 * RS_FIND_TRANSACTIONS=true sets `transactionOptions: {}` (operations run in transactions, so the
 * differential checks run on transaction connections).
 */
import { sqliteAdapter } from '@payloadcms/db-sqlite'

const flavour = process.env.RS_FIND_ADAPTER || 'sqlite'
const url = process.env.SQLITE_URL || process.env.DATABASE_URL || 'file:./payload.db'
const blocksAsJSON = process.env.RS_FIND_BLOCKS_AS_JSON === 'true'
const transactions = process.env.RS_FIND_TRANSACTIONS === 'true'

const flavours = {
  sqlite: { autoIncrement: true },
  'sqlite-uuid': { idType: 'uuid' },
  'sqlite-uuidv7': { idType: 'uuidv7' },
} as const

if (!(flavour in flavours)) {
  throw new Error(`RS_FIND_ADAPTER must be one of ${Object.keys(flavours).join(', ')}`)
}

export const databaseAdapter = sqliteAdapter({
  ...flavours[flavour as keyof typeof flavours],
  ...(blocksAsJSON ? { blocksAsJSON } : {}),
  ...(transactions ? { transactionOptions: {} } : {}),
  client: { url },
})
