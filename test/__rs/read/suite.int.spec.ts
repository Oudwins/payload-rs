/**
 * Runs an upstream int suite unchanged while recording every drizzle read
 * `transform` call into `fixtures/suite-<name>.json` (see ./capture/recorder.ts).
 * The upstream tests create far richer data than generic generators can.
 *
 * Run: SQLITE_URL=file:/tmp/rs-read.db PAYLOAD_ENGINE=ts RS_READ_SUITE=fields \
 *   pnpm test:int:sqlite test/__rs/read/suite.int.spec.ts
 * (`RS_READ_SUITE` may also name a spec file inside the suite dir, e.g. `fields/int.spec.ts`).
 * Upstream assertion failures do not matter here: only the captured pairs are used.
 */
import path from 'path'
import { afterAll, expect, vi } from 'vitest'

import { flushFixture } from './capture/recorder.js'

vi.mock('../../../packages/drizzle/src/transform/read/index.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../packages/drizzle/src/transform/read/index.js')>()
  const { wrapTransform } = await import('./capture/recorder.js')
  return { ...original, transform: wrapTransform(original.transform) }
})

const suite = process.env.RS_READ_SUITE ?? 'fields'
const specPath = path.resolve(
  import.meta.dirname,
  '../..',
  suite.endsWith('.ts') ? suite : `${suite}/int.spec.ts`,
)
const fixtureName = `suite-${suite.replace(/\.int\.spec\.ts$|\.spec\.ts$/, '').replace(/[/.]/g, '-')}`

afterAll(() => {
  const count = flushFixture(fixtureName)
  console.log(`[rs-read] ${fixtureName}: ${count} calls`)
})

// The upstream fixture resolves `test.suite(..., { config: './config.ts' })` relative to the
// current test file path, so point it at the upstream spec before importing it.
expect.setState({ testPath: specPath })

await import(specPath)
