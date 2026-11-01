/**
 * The mongo-harness int config (test/__rs/mongo-harness/vitest.config.ts) with `databaseAdapter.js`
 * resolved to ./databaseAdapter.ts (upstream mongodb adapter + recorder.ts). Codegen of the shared
 * test/databaseAdapter.js stays disabled.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

import harness from '../mongo-harness/vitest.config.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const project = (harness.test?.projects ?? [])[0] as Record<string, any>

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
            ...(project.resolve.alias as unknown[]).slice(1),
          ],
        },
      },
    ],
  },
})
