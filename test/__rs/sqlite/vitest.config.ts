/**
 * The `int` vitest project with `@libsql/client` aliased to the Rust-backed
 * drop-in (`packages/engine-rs/src/sqlite/libsql.ts`), so any upstream int
 * suite runs on the Rust SQLite runtime without touching
 * `@payloadcms/db-sqlite`. `PAYLOAD_SQLITE_CLIENT=libsql` switches the shim
 * back to the real client (reference run with identical module graph).
 * `PAYLOAD_SQLITE_TRANSACTIONS=1` swaps `test/databaseAdapter.js` for
 * `./transactionAdapter.ts` (the same adapter with `transactionOptions`).
 *
 *   SQLITE_URL=file:/tmp/rs-sqlite-runtime.db PAYLOAD_DATABASE=sqlite \
 *     pnpm vitest run --config test/__rs/sqlite/vitest.config.ts test/hooks/int.spec.ts
 */
import { createRequire } from 'module'
import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const _require = createRequire(path.resolve(ROOT_DIR, 'packages/graphql/package.json'))
const graphqlDir = path.dirname(_require.resolve('graphql/package.json'))

export default defineConfig({
  oxc: {
    jsx: {
      importSource: 'react',
      runtime: 'automatic',
    },
  },
  resolve: {
    alias: [
      {
        find: /^@libsql\/client$/,
        replacement: path.resolve(ROOT_DIR, 'packages/engine-rs/src/sqlite/libsql.ts'),
      },
      ...(process.env.PAYLOAD_SQLITE_TRANSACTIONS === '1'
        ? [
            {
              find: /^\.\/databaseAdapter\.js$/,
              replacement: path.resolve(ROOT_DIR, 'test/__rs/sqlite/transactionAdapter.ts'),
            },
          ]
        : []),
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
    name: 'int-rs-sqlite',
    server: {
      deps: {
        inline: [/@payloadcms\/figma/],
      },
    },
    setupFiles: ['./test/vitest.setup.ts'],
    testTimeout: 90000,
    watch: false,
  },
})
