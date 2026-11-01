/**
 * The `int` vitest project with payload's query validation modules replaced, for every importer
 * outside this directory (payload operations, the `payload` / `payload/shared` re-exports,
 * drizzle), by the Rust-backed glue (./glue.ts, crates/payload-core-query `live`):
 * `validateQueryPaths`, `validateSearchParam`, `validateSortQuery`, `sanitizeJoinQuery`,
 * `getLocalizedPaths`, `getFieldByPath`, `sanitizeWhereQuery`, `combineQueries`,
 * `prefixWherePaths`. `PAYLOAD_QUERY=ts` keeps the upstream modules (reference run, same config).
 *
 *   PAYLOAD_CORE_RUNTIME_ADDON=<query addon> SQLITE_URL=file:/tmp/x.db PAYLOAD_DATABASE=sqlite \
 *     pnpm vitest run --config test/__rs/core-query/vitest.upstream.config.ts test/joins/int.spec.ts
 */
import type { Plugin } from 'vite'

import { createRequire } from 'module'
import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(HERE, '../../..')
const _require = createRequire(path.resolve(ROOT_DIR, 'packages/graphql/package.json'))
const graphqlDir = path.dirname(_require.resolve('graphql/package.json'))

const src = path.resolve(ROOT_DIR, 'packages/payload/src')
const replaced = new Map(
  [
    'database/queryValidation/validateQueryPaths',
    'database/queryValidation/validateSearchParams',
    'database/queryValidation/validateSortQuery',
    'database/sanitizeJoinQuery',
    'database/getLocalizedPaths',
    'database/sanitizeWhereQuery',
    'database/combineQueries',
    'database/prefixWherePaths',
    'utilities/getFieldByPath',
  ].map((module) => [
    path.join(src, `${module}.ts`),
    path.join(HERE, 'shims', `${path.basename(module)}.ts`),
  ]),
)

const rustQueryPlugin = (): Plugin => ({
  name: 'rs-core-query',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || importer.startsWith(HERE) || !/[A-Za-z]+(\.js|\.ts)?$/.test(source)) {
      return null
    }
    const name = path.basename(source).replace(/\.(js|ts)$/, '')
    if (![...replaced.keys()].some((file) => path.basename(file, '.ts') === name)) {
      return null
    }
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
    return (resolved && replaced.get(resolved.id)) ?? null
  },
})

export default defineConfig({
  oxc: {
    jsx: {
      importSource: 'react',
      runtime: 'automatic',
    },
  },
  plugins: process.env.PAYLOAD_QUERY === 'ts' ? [] : [rustQueryPlugin()],
  resolve: {
    alias: [
      { find: /^graphql\/(.*)/, replacement: graphqlDir + '/$1' },
      { find: /^graphql$/, replacement: path.join(graphqlDir, 'index.js') },
    ],
  },
  root: ROOT_DIR,
  test: {
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 90000,
    include: ['test/**/*int.spec.ts'],
    name: 'int-rs-query',
    setupFiles: ['./test/vitest.setup.ts'],
    testTimeout: 90000,
    watch: false,
  },
})
