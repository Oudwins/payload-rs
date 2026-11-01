/**
 * Vitest setup file (see vitest.capture.config.ts): wraps drizzle's `transformForWrite` so running
 * any upstream int suite records golden fixtures into ./fixtures/upstream__<suite>.json.
 */
import path from 'node:path'
import { afterAll, expect, vi } from 'vitest'

import { flushFixtures, setCaptureLabel } from './capture.js'

vi.mock('../../../packages/drizzle/src/transform/write/index.js', async (importOriginal) => {
  const mod =
    await importOriginal<typeof import('../../../packages/drizzle/src/transform/write/index.js')>()
  const { wrapTransformForWrite } = await import('./capture.js')
  return { ...mod, transformForWrite: wrapTransformForWrite(mod.transformForWrite) }
})

const testPath = expect.getState().testPath ?? 'unknown'
const suite = path.relative(path.resolve(process.cwd(), 'test'), testPath).replace(/\.ts$/, '')
setCaptureLabel(`upstream__${suite}`)

afterAll(() => {
  const result = flushFixtures()
  if (result) {
    // eslint-disable-next-line no-console
    console.log(`[rs-write] captured ${result.calls} transformForWrite calls -> ${result.file}`)
  }
})
