/**
 * Loads one template's payload config (`FN_COMPILE_TEMPLATE`, a directory of templates/) with the
 * template's `@/` alias, for the compile-rate report (templates.spec.ts):
 *
 *   FN_COMPILE_TEMPLATE=website pnpm exec vitest run --config test/__rs/fn-compile/vitest.templates.config.ts
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const template = process.env.FN_COMPILE_TEMPLATE ?? 'website'
const src = path.join(root, 'templates', template, 'src')

export default defineConfig({
  oxc: { jsx: { importSource: 'react', runtime: 'automatic' } },
  plugins: [
    {
      // Templates outside the pnpm workspace have no node_modules: resolve their packages from
      // test/, which depends on every workspace package.
      enforce: 'pre',
      name: 'fn-compile-template-deps',
      async resolveId(source, importer, options) {
        if (
          !importer?.includes('/templates/') ||
          source.startsWith('.') ||
          source.startsWith('/')
        ) {
          return null
        }
        const own = await this.resolve(source, importer, { ...options, skipSelf: true })
        return (
          own ??
          this.resolve(source, path.join(root, 'test', 'package.json'), {
            ...options,
            skipSelf: true,
          })
        )
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${src}/` },
      { find: /^@payload-config$/, replacement: path.join(src, 'payload.config.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/__rs/fn-compile/templates.spec.ts'],
    root,
    testTimeout: 300_000,
  },
})
