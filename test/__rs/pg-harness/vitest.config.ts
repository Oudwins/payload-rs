/**
 * Int-test config for PostgreSQL runs of the Rust port that must not touch the shared, generated
 * test/databaseAdapter.js (other agents run SQLite / Mongo suites concurrently).
 *
 *   PAYLOAD_DATABASE=postgres POSTGRES_URL=postgres://payload:payload@localhost:5433/<unique_db> \
 *     pnpm test:int --config test/__rs/pg-harness/vitest.config.ts test/hooks/int.spec.ts
 *
 * `databaseAdapter.js` imports, relative or absolute (`path.resolve(dirname,
 * '../databaseAdapter.js')`), resolve to test/__rs/pg-harness/databaseAdapter.ts and the codegen in
 * test/vitest.setup.ts is skipped. See test/__rs/pg-harness/README.md.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

import base from '../../../vitest.config.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(dirname, '../../..')
const harnessAdapter = path.resolve(dirname, 'databaseAdapter.ts')
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const intProject = (base.test?.projects ?? []).find(
  (project) => typeof project === 'object' && 'test' in project && project.test?.name === 'int',
) as Record<string, any> | undefined

if (!intProject) {
  throw new Error('int project not found in vitest.config.ts')
}

const baseAlias = intProject.resolve?.alias ?? []

export default defineConfig({
  ...base,
  root,
  test: {
    ...base.test,
    projects: [
      {
        ...intProject,
        resolve: {
          ...intProject.resolve,
          alias: [
            {
              find: /^(\.{1,2}\/)+databaseAdapter\.js$/,
              replacement: harnessAdapter,
            },
            {
              find: new RegExp(`^${escapeRegExp(path.join(root, 'test', 'databaseAdapter.js'))}$`),
              replacement: harnessAdapter,
            },
            ...(Array.isArray(baseAlias)
              ? baseAlias
              : Object.entries(baseAlias).map(([find, replacement]) => ({ find, replacement }))),
          ],
        },
        test: {
          ...intProject.test,
          env: {
            ...intProject.test?.env,
            PAYLOAD_RS_SKIP_ADAPTER_CODEGEN: 'true',
          },
        },
      },
    ],
  },
})
