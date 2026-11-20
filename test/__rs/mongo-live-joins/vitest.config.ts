/**
 * The mongo-harness int config (test/__rs/mongo-harness/vitest.config.ts) plus a resolve hook:
 * - imports of db-mongodb's `queries/buildQuery`, `queries/buildSortParam`, `utilities/transform`
 *   resolve to the recording spies in ./spies (from every importer but the spies themselves, incl.
 *   upstream's joins modules and the live helpers' host, so both sides of a differential call the
 *   same spied functions);
 * - imports of `utilities/buildJoinAggregation` / `utilities/resolveJoins` from db-mongodb's data
 *   methods resolve to the dual-run wrappers in ./dual (see dual.ts, `RS_LIVE_JOINS_MODE`).
 *
 *   PAYLOAD_DATABASE=mongodb|firestore PAYLOAD_ENGINE_ADDON=/tmp/livejoins-addon/payload-engine.node \
 *   RS_LIVE_JOINS_REPORT=/tmp/livejoins-report.jsonl MONGODB_URL=... \
 *     pnpm vitest run --project int --config test/__rs/mongo-live-joins/vitest.config.ts test/joins/int.spec.ts
 */
import type { Plugin } from 'vite'

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

import harness from '../mongo-harness/vitest.config.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const dbMongodbSrc = path.resolve(dirname, '../../../packages/db-mongodb/src')

const spied: Record<string, string> = {
  'queries/buildQuery.ts': 'spies/buildQuery.ts',
  'queries/buildSortParam.ts': 'spies/buildSortParam.ts',
  'utilities/transform.ts': 'spies/transform.ts',
}
const dual: Record<string, string> = {
  'utilities/buildJoinAggregation.ts': 'dual/buildJoinAggregation.ts',
  'utilities/resolveJoins.ts': 'dual/resolveJoins.ts',
}

const redirectPlugin = (): Plugin => ({
  enforce: 'pre',
  name: 'rs-mongo-live-joins',
  async resolveId(source, importer, options) {
    if (!importer || !source.startsWith('.') || importer.startsWith(path.join(dirname, 'spies'))) {
      return null
    }
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
    if (!resolved) {
      return null
    }
    const file = path.relative(dbMongodbSrc, resolved.id.replace(/\?.*$/, ''))
    if (spied[file]) {
      return path.join(dirname, spied[file])
    }
    // only db-mongodb's own data methods go through the dual wrappers
    if (dual[file] && importer.startsWith(dbMongodbSrc)) {
      return path.join(dirname, dual[file])
    }
    return null
  },
})

const project = (harness.test?.projects ?? [])[0] as Record<string, any>

export default defineConfig({
  ...harness,
  test: {
    ...harness.test,
    projects: [{ ...project, plugins: [...(project.plugins ?? []), redirectPlugin()] }],
  },
})
