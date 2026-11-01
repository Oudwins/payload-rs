/**
 * `--import` entry added to NODE_OPTIONS by test/__rs/harness/databaseAdapter.ts
 * in shadow mode and for matrix variants, so Node child processes spawned by a
 * test (the `cli` fixture, test/queues' crash worker) use the same adapter as
 * the test process. See childProcessHooks.mjs.
 */
import { registerHooks } from 'node:module'

import { createResolveHook } from './childProcessHooks.mjs'

const harnessDir = new URL('./', import.meta.url).href

if (process.env.PAYLOAD_RS_SHADOW === 'true') {
  process.env.PAYLOAD_RS_SHADOW_CHILD = 'true'
  registerHooks({
    resolve: createResolveHook({
      dbSqliteTarget: new URL('childDbSqlite.ts', harnessDir).href,
      harnessDir,
      target: new URL('databaseAdapter.ts', harnessDir).href,
      testDir: new URL('../../', harnessDir).href,
    }),
  })
} else if (process.env.PAYLOAD_RS_VARIANT_ADAPTER === 'true') {
  // configs that build their own `sqliteAdapter` keep it, as with upstream's generated file
  process.env.PAYLOAD_RS_VARIANT_CHILD = 'true'
  registerHooks({
    resolve: createResolveHook({
      harnessDir,
      target: new URL('databaseAdapter.ts', harnessDir).href,
      testDir: new URL('../../', harnessDir).href,
    }),
  })
}
