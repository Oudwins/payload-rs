/**
 * `--import` entry added to NODE_OPTIONS by test/__rs/harness/databaseAdapter.ts
 * in shadow mode, so Node child processes spawned by a test (the `cli`
 * fixture, test/queues' crash worker) use the shadow adapter too. See
 * childProcessHooks.mjs.
 */
import { registerHooks } from 'node:module'

import { createResolveHook } from './childProcessHooks.mjs'

if (process.env.PAYLOAD_RS_SHADOW === 'true') {
  process.env.PAYLOAD_RS_SHADOW_CHILD = 'true'
  const harnessDir = new URL('./', import.meta.url).href
  registerHooks({
    resolve: createResolveHook({
      dbSqliteTarget: new URL('childDbSqlite.ts', harnessDir).href,
      harnessDir,
      target: new URL('databaseAdapter.ts', harnessDir).href,
      testDir: new URL('../../', harnessDir).href,
    }),
  })
}
