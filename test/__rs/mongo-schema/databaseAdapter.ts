/**
 * Alias target for `databaseAdapter.js` used by test/__rs/mongo-schema/vitest.config.ts: upstream
 * `mongooseAdapter` (the `mongodb` entry of test/dbAdapters.ts) whose `init` is the Rust model
 * building (`createMongoInitRS`), everything else upstream TS. Runs upstream int suites against
 * the models the Rust port builds.
 *
 * Proof of native execution: with `RS_MONGO_SCHEMA_PROOF_DIR`, every process appends one line per
 * finished Rust `init` (models built, core runtime entries) to `<dir>/schema-<pid>.jsonl`.
 */
import { mongooseAdapter } from '@payloadcms/db-mongodb'
import mongoose from 'mongoose'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { getBuildQueryPlugin } from '../../../packages/db-mongodb/src/queries/getBuildQueryPlugin.js'
import { createMongoInitRS } from '../../../packages/engine-rs/src/mongo-schema/index.js'
import { getCoreRuntime } from '../../../packages/engine-rs/src/runtime/index.js'
import { requireTsEngine } from '../requireTsEngine.js'

requireTsEngine({ file: 'test/__rs/mongo-schema/databaseAdapter.ts' })

if (process.env.PAYLOAD_DATABASE !== 'mongodb' || !process.env.MONGODB_URL) {
  throw new Error(
    'test/__rs/mongo-schema: set PAYLOAD_DATABASE=mongodb and a MONGODB_URL of your own',
  )
}

const dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.resolve(dirname, '../../../packages/db-mongodb/package.json'))
const paginate = (await import(pathToFileURL(require.resolve('mongoose-paginate-v2')).href)).default

const initRS = createMongoInitRS({ getBuildQueryPlugin, mongoose, paginate })
const proofDir = process.env.RS_MONGO_SCHEMA_PROOF_DIR

const upstream = mongooseAdapter({ ensureIndexes: true, url: process.env.MONGODB_URL })

export const databaseAdapter: typeof upstream = {
  ...upstream,
  init: (args) => {
    const adapter = upstream.init(args)
    adapter.init = proofDir
      ? async function (this: any) {
          await initRS.call(this)
          fs.mkdirSync(proofDir, { recursive: true })
          fs.appendFileSync(
            path.join(proofDir, `schema-${process.pid}.jsonl`),
            `${JSON.stringify({
              collections: Object.keys(this.collections).length,
              engineEntries: getCoreRuntime().stats().entries,
              versions: Object.keys(this.versions).length,
            })}\n`,
          )
        }
      : (initRS as any)
    return adapter
  },
}
