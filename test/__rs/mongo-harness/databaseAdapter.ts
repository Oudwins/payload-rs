/**
 * Alias target for `databaseAdapter.js` used by test/__rs/mongo-harness/vitest.config.ts.
 *
 * Builds exactly what upstream codegen writes for PAYLOAD_DATABASE=mongodb (the `mongodb` entry of
 * test/dbAdapters.ts): `mongooseAdapter({ ensureIndexes: true, url })` with the same URL
 * precedence; PAYLOAD_DATABASE=cosmosdb|documentdb|firestore build those entries
 * (`compatibilityOptions`, see args.ts) against the same server. `mongooseAdapter` is imported from `@payloadcms/db-mongodb` like upstream, so
 * PAYLOAD_ENGINE=rs selects the Rust engine there (MONGO_ENGINE_CONTRACT.md).
 *
 * MONGODB_URL is required: suites drop their database on start and several runs
 * share one server, so every run must name its own database.
 *
 * PAYLOAD_RS_MONGO_SHADOW=true: the differential adapter of shadowDatabaseAdapter.ts instead
 * (reference: upstream TS adapter on MONGODB_URL, candidate: PAYLOAD_RS_MONGO_CANDIDATE on a
 * second database). PAYLOAD_DATABASE stays `mongodb`, so suites select the same tests.
 */
import { mongooseAdapter } from '@payloadcms/db-mongodb'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { mongodbArgs, SUPPORTED_DATABASES } from './args.js'

if (
  !(SUPPORTED_DATABASES as readonly (string | undefined)[]).includes(process.env.PAYLOAD_DATABASE)
) {
  throw new Error(
    `test/__rs/mongo-harness/vitest.config.ts supports PAYLOAD_DATABASE=${SUPPORTED_DATABASES.join('|')}, got ${process.env.PAYLOAD_DATABASE}`,
  )
}

if (!process.env.MONGODB_URL) {
  throw new Error(
    'test/__rs/mongo-harness: set MONGODB_URL to a database of your own (suites drop it on start)',
  )
}

const loader = new URL('childProcessLoader.mjs', import.meta.url).pathname

// Node child processes spawned by tests (the `cli` fixture) import test/databaseAdapter.js
// natively; upstream codegen would have written the mongodb adapter there. They resolve it to this
// module instead (childProcessLoader.mjs) and build the same adapter as the test process.
if (process.env.PAYLOAD_RS_MONGO_CHILD !== 'true') {
  process.env.PAYLOAD_RS_MONGO_HARNESS = 'true'
  if (process.env.PAYLOAD_RS_MONGO_SHADOW === 'true') {
    // pair windows shared with shadow adapters of child processes (timestamp rule)
    const windowsFile = path.join(os.tmpdir(), `rs-mongo-shadow-windows-${process.pid}.jsonl`)
    fs.rmSync(windowsFile, { force: true })
    process.env.PAYLOAD_RS_MONGO_SHADOW_WINDOWS_FILE = windowsFile
    process.once('exit', () => fs.rmSync(windowsFile, { force: true }))
  }
  const nodeOptions = process.env.NODE_OPTIONS ?? ''
  if (!nodeOptions.includes(loader)) {
    process.env.NODE_OPTIONS = `${nodeOptions} --import ${loader}`.trim()
  }
}

export { mongodbArgs }

export const databaseAdapter =
  process.env.PAYLOAD_RS_MONGO_SHADOW === 'true'
    ? await (await import('./shadowDatabaseAdapter.js')).createShadowMongoAdapter()
    : mongooseAdapter(mongodbArgs())
