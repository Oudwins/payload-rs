/**
 * "Fails before" runs of the live query differentials: the JS host of the live query binding
 * (packages/engine-rs/src/mongo-live/query.ts) is replaced by the snapshot of the host an older
 * addon was built against (RS_LQ_BEFORE_HOST, e.g. .rs-runs/mongoquery/before/query.ts for the
 * API-version-1 addon of 2026-11-11), so the same specs run against the pre-fix port:
 *
 *   RS_LQ_BEFORE_HOST=.rs-runs/mongoquery/before/query.ts PAYLOAD_ENGINE_ADDON=<old addon> \
 *     pnpm test:int --config test/__rs/mongo-live-query/vitest.before.config.ts <spec>
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

import harness from '../mongo-harness/vitest.config.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(dirname, '../../..')
const hostFile = path.join(root, 'packages/engine-rs/src/mongo-live/query')
const beforeHost = path.resolve(
  root,
  process.env.RS_LQ_BEFORE_HOST ?? '.rs-runs/mongoquery/before/query.ts',
)

const beforePlugin = {
  enforce: 'pre' as const,
  name: 'rs-mongo-live-query-before-host',
  resolveId(source: string, importer?: string) {
    if (!importer || !source.startsWith('.')) {
      return null
    }
    const target = path.resolve(path.dirname(importer), source).replace(/\.(js|ts)$/, '')
    return target === hostFile ? beforeHost : null
  },
}

export default defineConfig({
  ...harness,
  plugins: [...((harness as any).plugins ?? []), beforePlugin],
  test: {
    ...harness.test,
    projects: (harness.test?.projects ?? []).map((project: any) => ({
      ...project,
      plugins: [...(project.plugins ?? []), beforePlugin],
    })),
  },
})
