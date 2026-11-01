/**
 * The `int` vitest project with payload's default field validators
 * (`packages/payload/src/fields/validations.ts`) replaced by the Rust-backed module
 * (`packages/engine-rs/src/validate/validations.ts`) for every importer: `sanitizeFields`, the auth
 * base fields, `generatePasswordSaltHash`, and the `payload` / `payload/shared` re-exports.
 * `PAYLOAD_VALIDATIONS=ts` keeps the upstream module (reference run with the same config).
 *
 *   SQLITE_URL=file:/tmp/rs-validate.db PAYLOAD_DATABASE=sqlite \
 *     pnpm vitest run --config test/__rs/core-validate/vitest.config.ts test/validate/int.spec.ts
 */
import type { Plugin } from 'vite'

import { createRequire } from 'module'
import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const _require = createRequire(path.resolve(ROOT_DIR, 'packages/graphql/package.json'))
const graphqlDir = path.dirname(_require.resolve('graphql/package.json'))

const upstreamValidations = path.resolve(ROOT_DIR, 'packages/payload/src/fields/validations.ts')
const rustValidations = path.resolve(ROOT_DIR, 'packages/engine-rs/src/validate/validations.ts')

const rustValidationsPlugin = (): Plugin => ({
  name: 'rs-core-validate',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (
      !importer ||
      !/validations(\.js|\.ts)?$/.test(source) ||
      importer.startsWith(path.dirname(rustValidations))
    ) {
      return null
    }
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
    return resolved?.id === upstreamValidations ? rustValidations : null
  },
})

export default defineConfig({
  oxc: {
    jsx: {
      importSource: 'react',
      runtime: 'automatic',
    },
  },
  plugins: process.env.PAYLOAD_VALIDATIONS === 'ts' ? [] : [rustValidationsPlugin()],
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
    name: 'int-rs-validate',
    setupFiles: ['./test/vitest.setup.ts'],
    testTimeout: 90000,
    watch: false,
  },
})
