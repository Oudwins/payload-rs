/**
 * Generates golden fixtures for the Rust port of drizzle's `transformForWrite`
 * (crates/payload-sql-write) by booting upstream test configs with the sqlite adapter and driving
 * the transform with generated data. Replay: `cargo test -p payload-sql-write --test replay`.
 *
 *   SQLITE_URL=file:/tmp/rs-write.db pnpm test:int:sqlite test/__rs/write/capture.int.spec.ts
 *
 * Fixtures from the upstream suites themselves are recorded with vitest.capture.config.ts.
 */
import { describe, expect, it, vi } from 'vitest'

import { captureConfig } from './runCapture.js'

vi.mock('../../../packages/drizzle/src/transform/write/index.js', async (importOriginal) => {
  const mod =
    await importOriginal<typeof import('../../../packages/drizzle/src/transform/write/index.js')>()
  const { wrapTransformForWrite } = await import('./capture.js')
  return { ...mod, transformForWrite: wrapTransformForWrite(mod.transformForWrite) }
})

const suites = (
  process.env.RS_WRITE_SUITES ??
  'fields,localization,relationships,versions,database,fields-relationship,joins,field-paths,array-update,hooks,select,sort,trash,uploads,globals,plugin-nested-docs,folders,hierarchy,auth,nested-fields,lexical,query-presets,locked-documents,plugin-multi-tenant,plugin-ecommerce,plugin-form-builder'
)
  .split(',')
  .filter(Boolean)

describe('capture transformForWrite fixtures', () => {
  for (const suite of suites) {
    it(`captures ${suite}`, { timeout: 600_000 }, async () => {
      const result = await captureConfig({ label: `generated__${suite}`, suite })
      // eslint-disable-next-line no-console
      console.log(`[rs-write] ${suite}: ${result?.calls ?? 0} calls -> ${result?.file}`)
      expect(result?.calls).toBeGreaterThan(0)
    })
  }
})
