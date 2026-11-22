/**
 * Alias target for `databaseAdapter.js` of test/__rs/mongo-live-reads/vitest.config.ts: the
 * upstream `mongodb` adapter of the mongo harness (test/__rs/mongo-harness/args.ts) with its read
 * methods served by the live Rust engine (`installLiveReads`, crates/payload-mongo-live); every
 * other method, the core engine and payload stay upstream TS. Writes the number of live read calls
 * per method to `<PAYLOAD_RS_MONGO_ENGINE_STATS_DIR>/livereads-<pid>.json` (proof of native
 * execution for runSuites.mjs runs).
 */
import { mongooseAdapter } from '@payloadcms/db-mongodb'
import fs from 'node:fs'
import path from 'node:path'

import {
  getMongoLiveReadStats,
  installLiveReads,
  mongoLiveReadMethods,
} from '../../../packages/engine-rs/src/mongo-live/index.js'
import { mongodbArgs } from '../mongo-harness/args.js'
import { initLivePorts } from './ports.js'

if (!process.env.MONGODB_URL) {
  throw new Error('test/__rs/mongo-live-reads: set MONGODB_URL to a database of your own')
}
if (process.env.PAYLOAD_ENGINE !== 'ts') {
  throw new Error(
    'test/__rs/mongo-live-reads: run with PAYLOAD_ENGINE=ts (live reads on the TS adapter)',
  )
}

const statsDir = process.env.PAYLOAD_RS_MONGO_ENGINE_STATS_DIR
let ported: Record<string, boolean> = {}
let lastWrite = 0
// written synchronously, throttled, and at exit (vitest workers may not emit `exit`)
const writeStats = () => {
  if (!statsDir) {
    return
  }
  fs.mkdirSync(statsDir, { recursive: true })
  fs.writeFileSync(
    path.join(statsDir, `livereads-${process.pid}.json`),
    JSON.stringify({ calls: getMongoLiveReadStats(), ported }),
  )
}
const recordCall = () => {
  const now = performance.now()
  if (now - lastWrite > 250) {
    lastWrite = now
    writeStats()
  }
}
process.once('exit', writeStats)

const upstream = mongooseAdapter(mongodbArgs())

export const databaseAdapter: typeof upstream = {
  ...upstream,
  init: (args) => {
    const adapter = upstream.init(args)
    installLiveReads(adapter as any)
    ported = initLivePorts()
    for (const method of mongoLiveReadMethods) {
      const live = (adapter as any)[method]
      ;(adapter as any)[method] = function (this: unknown, methodArgs: unknown) {
        const result = live.call(this, methodArgs)
        recordCall()
        return result
      }
    }
    return adapter
  },
}
