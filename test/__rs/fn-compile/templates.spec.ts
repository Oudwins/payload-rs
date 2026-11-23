/**
 * Compile-rate report of one template's config (see vitest.templates.config.ts): writes
 * `.rs-runs/fn-compile/template-<name>.json`.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect } from 'vitest'

import { test } from '../../__helpers/int/vitest.js'
import { reportConfig, writeReport } from './report.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const template = process.env.FN_COMPILE_TEMPLATE ?? 'website'

test.suite(`fn-compile: template ${template}`, {}, () => {
  test('should compile the functions of the template config', async () => {
    process.env.PAYLOAD_SECRET ??= 'fn-compile-report'
    process.env.DATABASE_URL ??= 'mongodb://127.0.0.1:1/unused'
    process.env.DATABASE_URI ??= process.env.DATABASE_URL
    const mod = await import(
      pathToFileURL(path.join(root, 'templates', template, 'src', 'payload.config.ts')).href
    )
    const config = await mod.default
    const rows = reportConfig(config).map((row) => ({ ...row, suite: template }))
    writeReport(`template-${template}`, rows)
    expect(rows.length).toBeGreaterThan(0)
  })
})
