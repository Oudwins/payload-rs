/**
 * Alias target for `databaseAdapter.js` used by test/__rs/harness/vitest.config.ts.
 *
 * That config runs the int suite without writing the shared, generated
 * test/databaseAdapter.js (other runs may be using it concurrently), so the
 * adapter is chosen here at runtime from PAYLOAD_DATABASE. Only the sqlite
 * flavours used by the Rust port are supported; options mirror the `sqlite`
 * entry of test/dbAdapters.ts.
 */
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createShadowSqliteAdapter, referenceURL, sqliteArgs } from './shadowDatabaseAdapter.js'

// test/vitest.setup.ts rewrites PAYLOAD_DATABASE=sqlite-shadow to sqlite + PAYLOAD_RS_SHADOW=true
const selected =
  process.env.PAYLOAD_RS_SHADOW === 'true' ? 'sqlite-shadow' : process.env.PAYLOAD_DATABASE

if (selected !== 'sqlite' && selected !== 'sqlite-shadow') {
  throw new Error(
    `test/__rs/harness/vitest.config.ts supports PAYLOAD_DATABASE=sqlite|sqlite-shadow, got ${selected}`,
  )
}

const isChildProcess = process.env.PAYLOAD_RS_SHADOW_CHILD === 'true'

if (selected === 'sqlite-shadow' && !isChildProcess) {
  // Node child processes spawned by tests (the `cli` fixture) inherit these and run the shadow
  // adapter too (childProcessLoader.mjs). They write to the same database files, so all processes
  // coordinate through one file (createShadowAdapter `crossProcessFile`).
  const loader = fileURLToPath(new URL('childProcessLoader.mjs', import.meta.url))
  const nodeOptions = process.env.NODE_OPTIONS ?? ''
  if (!nodeOptions.includes(loader)) {
    process.env.NODE_OPTIONS = `${nodeOptions} --import ${loader}`.trim()
  }
  const crossProcessFile = path.join(os.tmpdir(), `rs-shadow-${process.pid}.jsonl`)
  fs.rmSync(crossProcessFile, { force: true })
  process.env.PAYLOAD_RS_SHADOW_CROSS_PROCESS_FILE = crossProcessFile
  process.once('exit', () => fs.rmSync(crossProcessFile, { force: true }))
}

export const databaseAdapter =
  selected === 'sqlite-shadow'
    ? await createShadowSqliteAdapter()
    : sqliteAdapter(sqliteArgs(referenceURL()))
