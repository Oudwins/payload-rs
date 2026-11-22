/**
 * test/__rs/mongo-harness/vitest.config.ts (MongoDB int runs without touching the shared
 * test/databaseAdapter.js) plus the recorder plugin around upstream `transform`, and the unit
 * project for packages/db-mongodb/src/utilities/transform.spec.ts with the same plugin.
 *
 *   PAYLOAD_RS_MONGO_TRANSFORM_RECORD_DIR=/tmp/rs-mongo-transform/<suite> PAYLOAD_DATABASE=mongodb \
 *   MONGODB_URL='mongodb://payload:payload@localhost:27018/<unique_db>?authSource=admin&directConnection=true&replicaSet=rs0' \
 *     pnpm test:int --config test/__rs/mongo-transform/vitest.config.ts test/relationships/int.spec.ts
 *
 * See test/__rs/mongo-transform/record.mjs (runs many files) and
 * test/__rs/mongo-live-transform/replay.spec.ts (replays the recordings live).
 */
import { defineConfig } from 'vitest/config'

import harness from '../mongo-harness/vitest.config.js'
import { transformRecorderPlugin } from './plugin.js'

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
        plugins: [...(intProject.plugins ?? []), transformRecorderPlugin()],
      },
      {
        plugins: [transformRecorderPlugin()],
        test: {
          environment: 'node',
          include: [
            'packages/db-mongodb/src/utilities/transform.spec.ts',
            'test/__rs/mongo-transform/synthetic.spec.ts',
          ],
          name: 'unit',
        },
      },
    ],
  },
})
