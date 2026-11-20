/**
 * `withRustMongoEngine` never falls back silently: with an addon that lacks any part of the live
 * engine, the adapter's creation throws a clear error before anything is initialized; stage 1 runs
 * only behind its explicit flags. No database needed (stub addon, fixtures/stubAddon.cjs).
 *
 *   pnpm test:int --config test/__rs/mongo-harness/vitest.config.ts test/__rs/mongo-adapter/required.int.spec.ts
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const stubAddon = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/stubAddon.cjs',
)

const methods = ['find', 'create', 'updateOne'] as const

/** A db-mongodb-shaped adapter object whose methods are recognisable. */
const createAdapterObj = () => {
  const upstreamInit = async () => {}
  const adapter: Record<string, unknown> = { init: upstreamInit, name: 'mongoose' }
  for (const method of methods) {
    adapter[method] = function upstreamMethod() {}
  }
  return { adapter, adapterObj: { init: () => adapter }, upstreamInit }
}

const loadGlue = async ({ missing }: { missing: string[] }) => {
  vi.resetModules()
  vi.stubEnv('PAYLOAD_ENGINE_ADDON', stubAddon)
  vi.stubEnv('PAYLOAD_CORE_RUNTIME_ADDON', stubAddon)
  vi.stubEnv('RS_STUB_ADDON_MISSING', missing.join(','))
  vi.stubEnv('PAYLOAD_RS_MONGO_ENGINE', undefined as unknown as string)
  vi.stubEnv('PAYLOAD_RS_MONGO_LOOPBACK', undefined as unknown as string)
  const glue = await import('../../../packages/engine-rs/src/mongo-adapter/index.js')
  const live = await import('../../../packages/engine-rs/src/mongo-adapter/live.js')
  return { ...glue, requiredLiveBindings: live.requiredLiveBindings }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('withRustMongoEngine requires the complete live engine', () => {
  it('lists every live binding as required', async () => {
    const { requiredLiveBindings } = await loadGlue({ missing: [] })

    expect([...requiredLiveBindings].sort()).toEqual([
      'mongoLiveBinding',
      'mongoLiveJoinsBinding',
      'mongoLiveQueryBinding',
      'mongoLiveSchemaBinding',
      'mongoLiveTransformBinding',
      'mongoLiveWriteBinding',
    ])
  })

  for (const binding of [
    'mongoLiveBinding',
    'mongoLiveQueryBinding',
    'mongoLiveTransformBinding',
    'mongoLiveJoinsBinding',
    'mongoLiveSchemaBinding',
    'mongoLiveWriteBinding',
  ]) {
    it(`should throw at init when the addon lacks ${binding}, before initializing anything`, async () => {
      const { withRustMongoEngine } = await loadGlue({ missing: [binding] })
      const { adapter, adapterObj, upstreamInit } = createAdapterObj()

      let thrown: unknown
      try {
        withRustMongoEngine(adapterObj as never).init({ payload: {} })
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(Error)
      const message = (thrown as Error).message
      expect(message).toContain('PAYLOAD_ENGINE=rs')
      expect(message).toContain(binding)
      expect(message).toContain(stubAddon)
      // the check ran before any binding of the stub was called
      expect(message).not.toContain('stub addon:')
      // nothing was swapped: no stage-1 fallback
      expect(adapter.init).toBe(upstreamInit)
      for (const method of methods) {
        expect((adapter[method] as { name: string }).name).toBe('upstreamMethod')
      }
    })
  }

  for (const flag of [
    ['PAYLOAD_RS_MONGO_ENGINE', 'stage1'],
    ['PAYLOAD_RS_MONGO_LOOPBACK', 'true'],
  ] as const) {
    it(`should run stage 1 only behind ${flag[0]}=${flag[1]}`, async () => {
      const { withRustMongoEngine } = await loadGlue({
        missing: ['mongoLiveBinding', 'mongoLiveWriteBinding', 'mongoLiveSchemaBinding'],
      })
      vi.stubEnv(flag[0], flag[1])
      const { adapter, adapterObj, upstreamInit } = createAdapterObj()

      const result = withRustMongoEngine(adapterObj as never).init({ payload: {} })

      expect(result).toBe(adapter)
      expect(adapter.init).not.toBe(upstreamInit)
      for (const method of methods) {
        expect((adapter[method] as { name: string }).name).not.toBe('upstreamMethod')
      }
    })
  }
})
