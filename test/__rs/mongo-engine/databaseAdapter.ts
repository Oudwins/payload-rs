/**
 * Alias target for `databaseAdapter.js` in test/__rs/mongo-engine/vitest.config.ts: upstream's
 * `mongodb` adapter (test/__rs/mongo-harness/args.ts) with the data methods and mongoose models
 * recorded by ./recorder.ts once `init` built the models (PAYLOAD_RS_MONGO_ENGINE_RECORD_DIR).
 * PAYLOAD_RS_MONGO_ENGINE_NO_AGGREGATIONS=true builds it with `useJoinAggregations: false`.
 */
import { mongooseAdapter } from '@payloadcms/db-mongodb'

import { mongodbArgs } from '../mongo-harness/args.js'
import { recordAdapter } from './recorder.js'

if (process.env.PAYLOAD_DATABASE !== 'mongodb' || !process.env.MONGODB_URL) {
  throw new Error('test/__rs/mongo-engine: set PAYLOAD_DATABASE=mongodb and a MONGODB_URL of your own')
}

export { mongodbArgs }

const adapterObj = mongooseAdapter({
  ...mongodbArgs(),
  ...(process.env.PAYLOAD_RS_MONGO_ENGINE_NO_AGGREGATIONS === 'true'
    ? { useJoinAggregations: false }
    : {}),
})

export const databaseAdapter = {
  ...adapterObj,
  init: (args: { payload: any }) => {
    const adapter = adapterObj.init(args) as Record<string, any>
    const upstreamInit = adapter.init
    adapter.init = async function (this: Record<string, any>) {
      await upstreamInit.call(this)
      recordAdapter(this)
    }
    return adapter
  },
}
