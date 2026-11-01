/**
 * Alias target for `databaseAdapter.js` used by test/__rs/mongo-schema/vitest.config.ts: upstream
 * `mongooseAdapter` (the `mongodb` entry of test/dbAdapters.ts) whose `init` is the Rust model
 * building (`createMongoInitRS`), everything else upstream TS. Runs upstream int suites against
 * the models the Rust port builds.
 */
import { mongooseAdapter } from '@payloadcms/db-mongodb'
import mongoose from 'mongoose'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { getBuildQueryPlugin } from '../../../packages/db-mongodb/src/queries/getBuildQueryPlugin.js'
import { createMongoInitRS } from '../../../packages/engine-rs/src/mongo-schema/index.js'

if (process.env.PAYLOAD_DATABASE !== 'mongodb' || !process.env.MONGODB_URL) {
  throw new Error('test/__rs/mongo-schema: set PAYLOAD_DATABASE=mongodb and a MONGODB_URL of your own')
}

const dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.resolve(dirname, '../../../packages/db-mongodb/package.json'))
const paginate = (await import(pathToFileURL(require.resolve('mongoose-paginate-v2')).href)).default

const initRS = createMongoInitRS({ getBuildQueryPlugin, mongoose, paginate })

const upstream = mongooseAdapter({ ensureIndexes: true, url: process.env.MONGODB_URL })

export const databaseAdapter: typeof upstream = {
  ...upstream,
  init: (args) => {
    const adapter = upstream.init(args)
    adapter.init = initRS as any
    return adapter
  },
}
