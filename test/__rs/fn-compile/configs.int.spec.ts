/**
 * Compile-rate report over every loadable `test/<suite>/config.ts`: compiles each access
 * function, hook and validator and writes `.rs-runs/fn-compile/test-configs.json` (one row per
 * distinct function: compiled or why not, and where it is defined). `FN_COMPILE_SUITES=a,b`
 * limits the suites. Summarised by `node test/__rs/fn-compile/summarize.mjs`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect } from 'vitest'

import type { ReportRow } from './report.js'

import { test } from '../../__helpers/int/vitest.js'
import { reportConfig, writeReport } from './report.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const testDir = path.resolve(dirname, '../..')
const only = process.env.FN_COMPILE_SUITES?.split(',').filter(Boolean)
const suites = fs
  .readdirSync(testDir)
  .filter((dir) => fs.existsSync(path.join(testDir, dir, 'config.ts')))
  .filter((dir) => !only || only.includes(dir))
  .sort()

test.suite('fn-compile: test configs', {}, () => {
  const rows: (ReportRow & { suite: string })[] = []
  const failed: { error: string; suite: string }[] = []

  test.afterAll(() => {
    writeReport('test-configs', rows as ReportRow[])
    writeReport('test-configs-failed', failed as never)
  })

  for (const suite of suites) {
    test(`should compile the functions of ${suite}`, { timeout: 300_000 }, async () => {
      let config: Record<string, any>
      try {
        const mod = await import(pathToFileURL(path.join(testDir, suite, 'config.ts')).href)
        config = await mod.default
      } catch (error) {
        failed.push({ error: String((error as Error)?.message ?? error).slice(0, 300), suite })
        return
      }
      for (const row of reportConfig(config)) {
        rows.push({ ...row, suite })
      }
      expect(Array.isArray(config.collections)).toBe(true)
    })
  }
})
