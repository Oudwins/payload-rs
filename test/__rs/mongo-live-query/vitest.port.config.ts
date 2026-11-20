/**
 * Upstream suites on MongoDB with `@payloadcms/db-mongodb`'s query builders replaced by the Rust
 * port (crates/payload-mongo-live-query): every import of `queries/buildQuery`, `buildSortParam`,
 * `getBuildQueryPlugin` (the `Model.buildQuery` statics), `getLocalizedSortProperty`,
 * `buildSearchParams` and `utilities/buildProjectionFromSelect` made from inside
 * packages/db-mongodb/src resolves to ./shims (the glue's drop-ins). Everything else (adapter
 * methods, transform, joins, core engine) stays upstream TS, so a status difference against the
 * TS baseline is the port's.
 *
 *   PAYLOAD_ENGINE_ADDON=/tmp/livequery-addon/payload-engine.node node test/__rs/mongo-harness/runSuites.mjs \
 *     --config test/__rs/mongo-live-query/vitest.port.config.ts --baseline .rs-baseline/mongodb-all.json <files>
 *
 * Also runs db-mongodb's own unit specs of these modules (unit project) against the port.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

import harness from '../mongo-harness/vitest.config.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(dirname, '../../..')
const dbMongodbSrc = path.join(root, 'packages/db-mongodb/src')

const redirects: Record<string, string> = {
  'queries/buildQuery': 'buildQuery.ts',
  'queries/buildSearchParams': 'buildSearchParams.ts',
  'queries/buildSortParam': 'buildSortParam.ts',
  'queries/getBuildQueryPlugin': 'getBuildQueryPlugin.ts',
  'queries/getLocalizedSortProperty': 'getLocalizedSortProperty.ts',
  'utilities/buildProjectionFromSelect': 'buildProjectionFromSelect.ts',
}

const redirectPlugin = {
  enforce: 'pre' as const,
  name: 'rs-mongo-live-query-redirect',
  resolveId(source: string, importer?: string) {
    if (!importer || !importer.startsWith(dbMongodbSrc) || !source.startsWith('.')) {
      return null
    }
    const target = path.resolve(path.dirname(importer), source).replace(/\.(js|ts)$/, '')
    const rel = path.relative(dbMongodbSrc, target)
    const shim = redirects[rel]
    return shim ? path.join(dirname, 'shims', shim) : null
  },
}

export default defineConfig({
  ...harness,
  plugins: [...((harness as any).plugins ?? []), redirectPlugin],
  test: {
    ...harness.test,
    projects: (harness.test?.projects ?? []).map((project: any) => ({
      ...project,
      plugins: [...(project.plugins ?? []), redirectPlugin],
    })),
  },
})
