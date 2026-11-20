/**
 * Projects of the live transform verification (crates/payload-mongo-live-transform):
 *
 * - `live-transform-unit`: differential.spec.ts, the live differential against upstream
 *   (no database).
 * - `int`: test/__rs/mongo-harness/vitest.config.ts (MongoDB int runs without touching the shared
 *   test/databaseAdapter.js) with ./plugin.ts, which routes db-mongodb's `transform`, `handleError`,
 *   `getCollection` / `getGlobal`, `getDBName` and `isObjectID` through the Rust port
 *   (PAYLOAD_RS_LIVE_TRANSFORM=rs) or through the shadow comparison (=shadow: upstream on a clone,
 *   then Rust on the caller's objects; differences are counted in PAYLOAD_RS_LIVE_TRANSFORM_REPORT).
 */
import { defineConfig } from 'vitest/config'

import harness from '../mongo-harness/vitest.config.js'
import { liveTransformPlugin } from './plugin.js'

const [intProject] = (harness.test?.projects ?? []) as Record<string, any>[]

if (!intProject) {
  throw new Error('int project not found in test/__rs/mongo-harness/vitest.config.ts')
}

export default defineConfig({
  ...harness,
  test: {
    ...harness.test,
    projects: [
      {
        ...intProject,
        plugins: [...(intProject.plugins ?? []), liveTransformPlugin()],
      },
      {
        test: {
          environment: 'node',
          include: ['test/__rs/mongo-live-transform/*.spec.ts'],
          name: 'live-transform-unit',
          testTimeout: 600_000,
        },
      },
    ],
  },
})
