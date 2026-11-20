/**
 * Int-test config for MongoDB runs of the Rust port that must not touch the shared, generated
 * test/databaseAdapter.js (other agents run SQLite / Mongo suites concurrently).
 *
 *   PAYLOAD_DATABASE=mongodb \
 *   MONGODB_URL='mongodb://payload:payload@localhost:27018/<unique_db>?authSource=admin&directConnection=true&replicaSet=rs0' \
 *     pnpm test:int --config test/__rs/mongo-harness/vitest.config.ts test/hooks/int.spec.ts
 *
 * `databaseAdapter.js` imports are resolved to test/__rs/mongo-harness/databaseAdapter.ts and the
 * codegen in test/vitest.setup.ts is skipped. See test/__rs/README-mongo.md.
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

/**
 * Shadow runs execute every database call twice (packages/engine-rs/src/shadow-mongo; serial mode:
 * one pair at a time):
 * timeouts are multiplied by PAYLOAD_RS_TIMEOUT_FACTOR (default 3 with PAYLOAD_RS_MONGO_SHADOW=true,
 * otherwise 1, i.e. upstream's values).
 */
const timeoutFactor =
  Number(process.env.PAYLOAD_RS_TIMEOUT_FACTOR) ||
  (process.env.PAYLOAD_RS_MONGO_SHADOW === 'true' ? 3 : 1)
const scaled = (value: unknown, fallback: number) =>
  (typeof value === 'number' ? value : fallback) * timeoutFactor

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
          setupFiles: [
            ...(intProject.test?.setupFiles ?? []),
            path.resolve(dirname, 'flushOnFileEnd.ts'),
          ],
          ...(timeoutFactor === 1
            ? {}
            : {
                hookTimeout: scaled(intProject.test?.hookTimeout, 10_000),
                testTimeout: scaled(intProject.test?.testTimeout, 5_000),
              }),
          env: {
            ...intProject.test?.env,
            PAYLOAD_RS_SKIP_ADAPTER_CODEGEN: 'true',
          },
        },
      },
    ],
  },
})
