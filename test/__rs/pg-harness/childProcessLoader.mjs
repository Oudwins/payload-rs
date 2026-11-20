/**
 * `--import` entry added to NODE_OPTIONS by test/__rs/pg-harness/databaseAdapter.ts, so Node
 * child processes spawned by a test (the `cli` fixture, ...) build the same PostgreSQL adapter as
 * the test process instead of importing the shared generated test/databaseAdapter.js. See
 * childProcessHooks.mjs.
 */
import { registerHooks } from 'node:module'

import { createResolveHook } from './childProcessHooks.mjs'

const harnessDir = new URL('./', import.meta.url).href

if (process.env.PAYLOAD_RS_PG_HARNESS === 'true') {
  process.env.PAYLOAD_RS_PG_CHILD = 'true'
  registerHooks({
    resolve: createResolveHook({
      harnessDir,
      target: new URL('databaseAdapter.ts', harnessDir).href,
      testDir: new URL('../../', harnessDir).href,
    }),
  })
}
