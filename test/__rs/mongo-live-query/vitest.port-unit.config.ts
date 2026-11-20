/**
 * db-mongodb's own unit specs of the query modules (queries/*.spec.ts) against the Rust port: the
 * spec files import `./buildSortParam.js`, `./buildSearchParams.js`, `./getLocalizedSortProperty.js`,
 * which the redirect of vitest.port.config.ts resolves to ./shims (importer inside
 * packages/db-mongodb/src).
 *
 *   PAYLOAD_ENGINE_ADDON=/tmp/livequery-addon/payload-engine.node pnpm vitest --config test/__rs/mongo-live-query/vitest.port-unit.config.ts --run
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

import port from './vitest.port.config.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(dirname, '../../..')

const redirect = (port as any).plugins.at(-1)

export default defineConfig({
  plugins: [redirect],
  root,
  test: {
    environment: 'node',
    include: ['packages/db-mongodb/src/queries/*.spec.ts'],
    name: 'port-unit',
  },
})
