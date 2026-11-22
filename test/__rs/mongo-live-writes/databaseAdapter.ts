/**
 * Alias target of `databaseAdapter.js` for upstream int suites with ONLY the write data methods on
 * the live Rust port (vitest.upstream.config.ts): upstream's `mongooseAdapter(mongodbArgs())` (the
 * mongo-harness adapter args) whose `init` result gets `installLiveWrites(adapter)` before anything
 * calls it. Reads, the core engine and everything else stay upstream TS (PAYLOAD_ENGINE=ts), so
 * a status difference against the TS baseline is attributable to the live writes.
 *
 * With PAYLOAD_RS_LIVE_WRITE_STATS_DIR set, each process writes the binding's per-method call counts
 * to `<dir>/live-writes-<pid>.json` at exit (proof that the suites ran on the Rust writes).
 */
import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { threadId } from 'node:worker_threads'

import { mongodbArgs } from '../mongo-harness/args.js'
import { getMongoLiveWrite, installLiveWrites } from './glue.js'

if (process.env.PAYLOAD_ENGINE !== 'ts' || process.env.PAYLOAD_CORE_ENGINE) {
  throw new Error(
    'test/__rs/mongo-live-writes/databaseAdapter.ts: set PAYLOAD_ENGINE=ts, unset PAYLOAD_CORE_ENGINE',
  )
}

const statsDir = process.env.PAYLOAD_RS_LIVE_WRITE_STATS_DIR
const statsFile = statsDir
  ? path.join(statsDir, `live-writes-${process.pid}-${threadId}.json`)
  : undefined
const writeStats = () => {
  if (statsFile) {
    writeFileSync(statsFile, JSON.stringify(getMongoLiveWrite().stats()))
  }
}
if (statsFile) {
  // vitest may end worker threads without an `exit` event: also write periodically
  setInterval(writeStats, 1000).unref()
  process.once('exit', writeStats)
}

const base = mongooseAdapter(mongodbArgs())

export const databaseAdapter = {
  ...base,
  init: (args: Parameters<typeof base.init>[0]) => {
    const adapter = base.init(args) as unknown as Record<string, any>
    installLiveWrites(adapter)
    if (statsFile) {
      const destroy = adapter.destroy
      adapter.destroy = function (this: unknown, ...rest: unknown[]) {
        writeStats()
        return destroy.apply(this, rest)
      }
    }
    return adapter as unknown as ReturnType<typeof base.init>
  },
}
