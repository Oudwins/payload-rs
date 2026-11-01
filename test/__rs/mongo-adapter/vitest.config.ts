/**
 * test/__rs/mongo-harness/vitest.config.ts with `databaseAdapter.js` resolved to
 * test/__rs/mongo-adapter/databaseAdapter.ts: the harness adapter wrapped by
 * `withRustMongoEngine` (imported by path) while `@payloadcms/db-mongodb` has no PAYLOAD_ENGINE
 * switch yet. Configs that build their own `mongooseAdapter` are not wrapped.
 *
 *   PAYLOAD_DATABASE=mongodb PAYLOAD_RS_MONGO_LOOPBACK=true MONGODB_URL=... \
 *     pnpm test:int --config test/__rs/mongo-adapter/vitest.config.ts test/hooks/int.spec.ts
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

import harness from '../mongo-harness/vitest.config.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const [project] = (harness.test?.projects ?? []) as Record<string, any>[]

if (!project) {
  throw new Error('int project not found in test/__rs/mongo-harness/vitest.config.ts')
}

export default defineConfig({
  ...harness,
  test: {
    ...harness.test,
    projects: [
      {
        ...project,
        resolve: {
          ...project.resolve,
          alias: [
            {
              find: /^(\.{1,2}\/)+databaseAdapter\.js$/,
              replacement: path.resolve(dirname, 'databaseAdapter.ts'),
            },
            ...project.resolve.alias.slice(1),
          ],
        },
      },
    ],
  },
})
