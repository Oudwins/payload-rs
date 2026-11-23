/**
 * SQLite int runs (test/__rs/harness/vitest.config.ts) with ./plugin.ts: the HTTP fast paths,
 * including the byte lanes of the default read handlers (the fused lanes have a SQLite backend),
 * go through ./shadow.ts. Used by the SQLite runner:
 *
 *   PAYLOAD_RS_HTTP_SHADOW_REPORT=/tmp/report.jsonl node test/__rs/adapter/runSuites.mjs \
 *     --engine default --config test/__rs/http-lanes/vitest.sqlite.config.ts <files>
 *   node test/__rs/http-lanes/summarize.mjs --bytes /tmp/report.jsonl
 */
import { defineConfig } from 'vitest/config'

import harnessConfig from '../harness/vitest.config.js'
import { httpLanesPlugin } from './plugin.js'

const harness = await harnessConfig
const [intProject] = (harness.test?.projects ?? []) as Record<string, any>[]

if (!intProject) {
  throw new Error('int project not found in test/__rs/harness/vitest.config.ts')
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
    ],
  },
})
