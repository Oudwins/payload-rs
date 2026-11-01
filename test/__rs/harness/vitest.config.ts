/**
 * Int-test config for Rust port runs that must not touch the shared, generated
 * test/databaseAdapter.js (other agents / a baseline run may be using it).
 *
 *   PAYLOAD_DATABASE=sqlite-shadow SQLITE_URL=file:/tmp/x.db \
 *     pnpm vitest run --config test/__rs/harness/vitest.config.ts --project int test/hooks/int.spec.ts
 *
 * `databaseAdapter.js` imports are resolved to test/__rs/harness/databaseAdapter.ts
 * (PAYLOAD_DATABASE=sqlite|sqlite-shadow) and the codegen in test/vitest.setup.ts
 * is skipped.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

import base from '../../../vitest.config.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(dirname, '../../..')

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
              replacement: path.resolve(dirname, 'databaseAdapter.ts'),
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
