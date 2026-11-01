/**
 * Alias target for `databaseAdapter.js` used by test/__rs/harness/vitest.config.ts.
 *
 * That config runs the int suite without writing the shared, generated
 * test/databaseAdapter.js (other runs may be using it concurrently), so the
 * adapter is chosen here at runtime from PAYLOAD_DATABASE. Only the sqlite
 * flavours used by the Rust port are supported; options mirror the `sqlite`,
 * `sqlite-uuid` and `sqlite-uuidv7` entries of test/dbAdapters.ts, plus
 * `transactionOptions: {}` with PAYLOAD_RS_SQLITE_TRANSACTIONS=true (see `sqliteArgs`).
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

const supported = ['sqlite', 'sqlite-shadow', 'sqlite-uuid', 'sqlite-uuidv7']

if (!supported.includes(selected ?? '')) {
  throw new Error(
    `test/__rs/harness/vitest.config.ts supports PAYLOAD_DATABASE=${supported.join('|')}, got ${selected}`,
  )
}

const isChildProcess =
  process.env.PAYLOAD_RS_SHADOW_CHILD === 'true' || process.env.PAYLOAD_RS_VARIANT_CHILD === 'true'

const loader = fileURLToPath(new URL('childProcessLoader.mjs', import.meta.url))

/** Node child processes spawned by tests (the `cli` fixture, test/queues' crash worker). */
const addChildProcessLoader = () => {
  const nodeOptions = process.env.NODE_OPTIONS ?? ''
  if (!nodeOptions.includes(loader)) {
    process.env.NODE_OPTIONS = `${nodeOptions} --import ${loader}`.trim()
  }
}

if (selected === 'sqlite-shadow' && !isChildProcess) {
  // Child processes inherit these and run the shadow adapter too (childProcessLoader.mjs). They
  // write to the same database files, so all processes coordinate through one file
  // (createShadowAdapter `crossProcessFile`).
  addChildProcessLoader()
  const crossProcessFile = path.join(os.tmpdir(), `rs-shadow-${process.pid}.jsonl`)
  fs.rmSync(crossProcessFile, { force: true })
  process.env.PAYLOAD_RS_SHADOW_CROSS_PROCESS_FILE = crossProcessFile
  process.once('exit', () => fs.rmSync(crossProcessFile, { force: true }))
} else if (!isChildProcess) {
  // Upstream generates test/databaseAdapter.js for the selected adapter, and child processes
  // import it. That file is shared with every other run in this checkout (which may regenerate it
  // for another database at any time), so children resolve it to this module instead
  // (childProcessLoader.mjs) and build the same adapter as the test process.
  process.env.PAYLOAD_RS_VARIANT_ADAPTER = 'true'
  addChildProcessLoader()
}

export const databaseAdapter =
  selected === 'sqlite-shadow'
    ? await createShadowSqliteAdapter()
    : sqliteAdapter(sqliteArgs(referenceURL()))
