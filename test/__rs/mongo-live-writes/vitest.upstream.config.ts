/**
 * test/__rs/mongo-harness/vitest.config.ts with `databaseAdapter.js` resolved to this directory's
 * databaseAdapter.ts (upstream mongoose adapter + live Rust write methods). Run upstream files with
 *
 *   node test/__rs/mongo-harness/runSuites.mjs --config test/__rs/mongo-live-writes/vitest.upstream.config.ts \
 *     --engine ts --jobs 1 --tag livewrites --baseline .rs-baseline/mongodb-all.json <files>
 *
 * (PAYLOAD_ENGINE_ADDON = the payload-node addon; PAYLOAD_ENGINE unset).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import harness from '../mongo-harness/vitest.config.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const harnessAdapter = path.resolve(dirname, '../mongo-harness/databaseAdapter.ts')
const liveWritesAdapter = path.resolve(dirname, 'databaseAdapter.ts')

const projects = (harness.test?.projects ?? []).map((project: any) => ({
  ...project,
  resolve: {
    ...project.resolve,
    alias: (project.resolve?.alias ?? []).map((entry: any) =>
      entry.replacement === harnessAdapter ? { ...entry, replacement: liveWritesAdapter } : entry,
    ),
  },
}))

if (
  !projects.some((p: any) => p.resolve.alias.some((e: any) => e.replacement === liveWritesAdapter))
) {
  throw new Error('mongo-harness vitest config has no databaseAdapter.js alias to replace')
}

export default { ...harness, test: { ...harness.test, projects } }
