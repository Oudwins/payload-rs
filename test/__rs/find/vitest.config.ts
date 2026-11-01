/**
 * Int-test config for the find differential suites (test/__rs/find/suites/*). Like
 * test/__rs/harness/vitest.config.ts it resolves `databaseAdapter.js` to a local module
 * (test/__rs/find/databaseAdapter.ts, flavour picked by RS_FIND_ADAPTER /
 * RS_FIND_BLOCKS_AS_JSON / RS_FIND_TRANSACTIONS) and skips the shared adapter codegen.
 *
 * `@libsql/client` is aliased to the Rust-backed drop-in (packages/engine-rs/src/sqlite/libsql.ts),
 * served by the find test addon (PAYLOAD_ENGINE_ADDON, built by build-addon.sh), so TS drizzle and
 * the Rust port share `payload-sqlite` connections and transactions. PAYLOAD_SQLITE_CLIENT=libsql
 * makes the TS side use the real libsql client (Rust then reads through its own client).
 *
 *   test/__rs/find/build-addon.sh
 *   PAYLOAD_ENGINE_ADDON=/tmp/rs-find-addon/payload-find-test.node \
 *   PAYLOAD_DATABASE=sqlite SQLITE_URL=file:/tmp/rs-find.db TZ=UTC \
 *     pnpm vitest run --config test/__rs/find/vitest.config.ts --project int test/__rs/find/suites/joins
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
              find: /^@libsql\/client$/,
              replacement: path.resolve(root, 'packages/engine-rs/src/sqlite/libsql.ts'),
            },
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
