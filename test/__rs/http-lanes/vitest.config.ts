/**
 * Projects of the HTTP fast path verification (JWT HS256 sync path, GraphQL document cache,
 * REST endpoint matchers):
 *
 * - `http-lanes-unit`: *.spec.ts here, differentials against jose / graphql-js (no database).
 * - `int`: test/__rs/mongo-harness/vitest.config.ts (MongoDB int runs) with ./plugin.ts, which
 *   routes the fast paths through ./shadow.ts: every call is compared with the exact reference and
 *   counted in PAYLOAD_RS_HTTP_SHADOW_REPORT (see ./run.sh and ./summarize.mjs).
 *
 *   pnpm vitest run --config test/__rs/http-lanes/vitest.config.ts --project http-lanes-unit
 */
import { defineConfig } from 'vitest/config'

import harness from '../mongo-harness/vitest.config.js'
import { httpLanesPlugin } from './plugin.js'

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
        plugins: [...(intProject.plugins ?? []), httpLanesPlugin()],
      },
      {
        resolve: intProject.resolve,
        test: {
          environment: 'node',
          include: ['test/__rs/http-lanes/*.spec.ts'],
          name: 'http-lanes-unit',
          testTimeout: 120_000,
        },
      },
    ],
  },
})
