/**
 * Alias target of test/__rs/mongo-adapter/vitest.config.ts: the mongo-harness adapter
 * (`mongooseAdapter({ ensureIndexes: true, url })`), wrapped by `withRustMongoEngine` unless
 * PAYLOAD_RS_MONGO_ADAPTER_WRAP=false (reference runs through the same config).
 */
import { withRustMongoEngine } from '../../../packages/engine-rs/src/mongo-adapter/index.js'
import { databaseAdapter as harnessAdapter } from '../mongo-harness/databaseAdapter.js'

export { mongodbArgs } from '../mongo-harness/databaseAdapter.js'

export const databaseAdapter =
  process.env.PAYLOAD_RS_MONGO_ADAPTER_WRAP === 'false'
    ? harnessAdapter
    : withRustMongoEngine(harnessAdapter)
