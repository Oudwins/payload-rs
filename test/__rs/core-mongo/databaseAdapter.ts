/**
 * Alias target for `databaseAdapter.js` used by test/__rs/core-mongo/vitest.config.ts: the
 * `mongodb` entry of test/dbAdapters.ts, built at runtime so the shared, generated
 * test/databaseAdapter.js is never written. Every run must set its own database name in
 * MONGODB_URL (suites drop their database on start).
 */
import { mongooseAdapter } from '@payloadcms/db-mongodb'

if (process.env.PAYLOAD_DATABASE !== 'mongodb') {
  throw new Error(
    `test/__rs/core-mongo/vitest.config.ts needs PAYLOAD_DATABASE=mongodb, got ${process.env.PAYLOAD_DATABASE}`,
  )
}
if (!process.env.MONGODB_URL) {
  throw new Error('test/__rs/core-mongo/vitest.config.ts needs MONGODB_URL with a unique database')
}

export const databaseAdapter = mongooseAdapter({
  ensureIndexes: true,
  url:
    process.env.MONGODB_URL ||
    process.env.DATABASE_URL ||
    'mongodb://payload:payload@localhost:27018/payload?authSource=admin&directConnection=true&replicaSet=rs0',
})
