/**
 * Int-test config running upstream suites with the Rust mongoose model building
 * (test/__rs/mongo-schema/databaseAdapter.ts). Same as test/__rs/mongo-harness/vitest.config.ts
 * otherwise (no adapter codegen):
 *
 *   PAYLOAD_DATABASE=mongodb PAYLOAD_ENGINE_ADDON=... MONGODB_URL='mongodb://.../<unique_db>?...' \
 *     pnpm test:int --config test/__rs/mongo-schema/vitest.config.ts test/mongodb-schema-build-cache/int.spec.ts
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

import harness from '../mongo-harness/vitest.config.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const [intProject] = (harness.test?.projects ?? []) as Record<string, any>[]

export default defineConfig({
  ...harness,
  test: {
    ...harness.test,
    projects: [
      {
        ...intProject,
        resolve: {
          ...intProject!.resolve,
          alias: [
            {
              find: /^(\.{1,2}\/)+databaseAdapter\.js$/,
              replacement: path.resolve(dirname, 'databaseAdapter.ts'),
            },
            ...intProject!.resolve.alias.slice(1),
          ],
        },
      },
    ],
  },
})
