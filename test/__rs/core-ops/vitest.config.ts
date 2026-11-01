/**
 * The `int` project (via test/__rs/harness/vitest.config.ts: own database adapter module, no
 * shared codegen) with payload's collection read operations
 * (`packages/payload/src/collections/operations/{find,findByID,count,countVersions,findDistinct,
 * findVersions,findVersionByID,docAccess}.ts`) replaced, for every importer, by `wrap/*.ts`, which
 * dispatch on `PAYLOAD_OPS=ts|rs|shadow` (see shadow.ts).
 *
 *   PAYLOAD_OPS=shadow RS_OPS_OUT=/tmp/rs-ops PAYLOAD_ENGINE_ADDON=/tmp/x.node \
 *   PAYLOAD_DATABASE=sqlite SQLITE_URL=file:/tmp/rs-operations.db \
 *     pnpm vitest run --config test/__rs/core-ops/vitest.config.ts --project int test/sort/int.spec.ts
 */
import type { Plugin } from 'vite'

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

import harness from '../harness/vitest.config.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(dirname, '../../..')
const opsDir = path.resolve(root, 'packages/payload/src/collections/operations')
const wrapDir = path.resolve(dirname, 'wrap')
const wrapped = new Set([
  'count',
  'countVersions',
  'docAccess',
  'find',
  'findByID',
  'findDistinct',
  'findVersionByID',
  'findVersions',
])
const sourcePattern = new RegExp(`(${[...wrapped].join('|')})(\\.js|\\.ts)?$`)

const operationsPlugin = (): Plugin => ({
  name: 'rs-core-ops',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || importer.startsWith(wrapDir) || !sourcePattern.test(source)) {
      return null
    }
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
    if (!resolved || path.dirname(resolved.id) !== opsDir) {
      return null
    }
    const base = path.basename(resolved.id, '.ts')
    return wrapped.has(base) ? path.join(wrapDir, `${base}.ts`) : null
  },
})

const intProject = (harness.test?.projects ?? [])[0] as Record<string, any>

export default defineConfig({
  ...harness,
  test: {
    ...harness.test,
    projects: [
      {
        ...intProject,
        plugins: [...(intProject.plugins ?? []), operationsPlugin()],
        test: {
          ...intProject.test,
          setupFiles: [...(intProject.test?.setupFiles ?? []), path.resolve(dirname, 'setup.ts')],
        },
      },
    ],
  },
})
