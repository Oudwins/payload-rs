/**
 * The mongo-harness int config (test/__rs/mongo-harness/vitest.config.ts) plus the recorder of
 * test/__rs/mongo-joins/recorder.ts: imports of the db-mongodb modules ported by
 * crates/payload-mongo-joins (and of the modules they call) are resolved to the wrappers in ./wrap, which record calls when PAYLOAD_RS_JOINS_RECORD_DIR is set and
 * pass through otherwise. `databaseAdapter.js` resolves to ./databaseAdapter.ts.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'

import harness from '../mongo-harness/vitest.config.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const dbMongodbSrc = path.resolve(dirname, '../../../packages/db-mongodb/src')
const wrapDir = path.join(dirname, 'wrap')

const wrapped: Record<string, string> = {
  'findDistinct.ts': 'findDistinct.ts',
  'queries/buildQuery.ts': 'buildQuery.ts',
  'queries/buildSortParam.ts': 'buildSortParam.ts',
  'queryDrafts.ts': 'queryDrafts.ts',
  'utilities/aggregatePaginate.ts': 'aggregatePaginate.ts',
  'utilities/buildJoinAggregation.ts': 'buildJoinAggregation.ts',
  'utilities/buildProjectionFromSelect.ts': 'buildProjectionFromSelect.ts',
  'utilities/getSession.ts': 'getSession.ts',
  'utilities/resolveJoins.ts': 'resolveJoins.ts',
  'utilities/transform.ts': 'transform.ts',
}

const recorderPlugin = (): Plugin => ({
  enforce: 'pre',
  name: 'rs-mongo-joins-recorder',
  async resolveId(source, importer, options) {
    // every importer but the wrappers (test files import some of these modules directly)
    if (!importer || importer.startsWith(wrapDir) || !source.startsWith('.')) {
      return null
    }
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
    if (!resolved) {
      return null
    }
    const file = resolved.id.replace(/\?.*$/, '')
    const wrapper = wrapped[path.relative(dbMongodbSrc, file)]
    return wrapper ? path.join(dirname, 'wrap', wrapper) : null
  },
})

const project = (harness.test?.projects ?? [])[0] as Record<string, any>

export default defineConfig({
  ...harness,
  test: {
    ...harness.test,
    projects: [
      {
        ...project,
        plugins: [...(project.plugins ?? []), recorderPlugin()],
        resolve: {
          ...project.resolve,
          alias: [
            {
              find: /^(\.{1,2}\/)+databaseAdapter\.js$/,
              replacement: path.resolve(dirname, 'databaseAdapter.ts'),
            },
            ...(project.resolve.alias as unknown[]).slice(1),
          ],
        },
      },
    ],
  },
})
