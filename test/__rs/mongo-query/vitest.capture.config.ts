/**
 * The mongo-harness int config (test/__rs/mongo-harness/vitest.config.ts) with db-mongodb's
 * `queries/parseParams`, `queries/buildSortParam` and `utilities/buildProjectionFromSelect` imports
 * resolved to the recording wrappers in ./wrap (see ./capture.ts; they pass through unless
 * RS_MQ_CAPTURE_DIR is set). Used by ./capture.sh.
 */
import type { Plugin } from 'vite'

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

import harness from '../mongo-harness/vitest.config.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const dbMongodbSrc = path.resolve(dirname, '../../../packages/db-mongodb/src')
const wrapDir = path.join(dirname, 'wrap')

const wrapped: Record<string, string> = {
  'queries/buildSortParam.ts': 'buildSortParam.ts',
  'queries/parseParams.ts': 'parseParams.ts',
  'utilities/buildProjectionFromSelect.ts': 'buildProjectionFromSelect.ts',
}

const recorderPlugin = (): Plugin => ({
  name: 'rs-mongo-query-recorder',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || importer.startsWith(wrapDir) || !source.startsWith('.')) {
      return null
    }
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
    if (!resolved) {
      return null
    }
    const wrapper = wrapped[path.relative(dbMongodbSrc, resolved.id.replace(/\?.*$/, ''))]
    return wrapper ? path.join(wrapDir, wrapper) : null
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
        // recording slows the suites down (timeouts only)
        test: {
          ...project.test,
          hookTimeout: 600_000,
          // flushes the recorded fixtures after each file (forks may exit without `exit` handlers)
          setupFiles: [...(project.test.setupFiles ?? []), path.join(dirname, 'captureSetup.ts')],
          testTimeout: 600_000,
        },
      },
    ],
  },
})
