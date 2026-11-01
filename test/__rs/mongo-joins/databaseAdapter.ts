/**
 * Alias target for `databaseAdapter.js` in test/__rs/mongo-joins/vitest.config.ts: the adapter of
 * test/__rs/mongo-harness/databaseAdapter.ts (upstream's `mongodb` entry of test/dbAdapters.ts),
 * with `useJoinAggregations: false` when PAYLOAD_RS_JOINS_NO_AGGREGATIONS=true so `resolveJoins`
 * runs instead of the join aggregation.
 */
import { mongooseAdapter } from '@payloadcms/db-mongodb'

if (process.env.PAYLOAD_DATABASE !== 'mongodb' || !process.env.MONGODB_URL) {
  throw new Error('test/__rs/mongo-joins: set PAYLOAD_DATABASE=mongodb and a MONGODB_URL of your own')
}

export const databaseAdapter = mongooseAdapter({
  ensureIndexes: true,
  url: process.env.MONGODB_URL,
  ...(process.env.PAYLOAD_RS_JOINS_NO_AGGREGATIONS === 'true' ? { useJoinAggregations: false } : {}),
})
