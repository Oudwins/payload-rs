import { expect } from 'vitest'

import { test } from '../../__helpers/int/vitest.js'

/**
 * Upstream's behaviour of user validators, which the fused writes reproduce with compiled
 * functions (packages/engine-rs/FUSED_WRITES.md section 12.7). Guard mode verifies the first 32
 * calls of each function on the exact lane, so every scenario runs past them. Run with
 * `PAYLOAD_RS_FUSE_WRITES=shadow` every eligible write here also runs on the exact lane and is
 * compared; the last test checks that the lane served calls and found no difference.
 */
type FuseWriteStats = {
  bails: Record<string, number>
  diffs: number
  hits: Record<string, number>
  ineligible: Record<string, number>
}

const fuseWriteStats = (): FuseWriteStats | undefined =>
  Reflect.get(globalThis, Symbol.for('@payloadcms/engine-rs/fuse-write-stats'))

/** More calls than guard mode verifies before a lane may use a compiled function. */
const warmCalls = 40

test.suite('fuse-writes compiled validators', { config: './validate.config.ts' }, () => {
  test('should create and reject by a value-only validator', async ({ payload }) => {
    for (let i = 0; i < warmCalls; i++) {
      const doc = await payload.create({
        collection: 'rated',
        data: { rating: i % 6, title: `t${i}` },
        overrideAccess: true,
      })

      expect(doc.rating).toBe(i % 6)
    }

    await expect(
      payload.create({
        collection: 'rated',
        data: { rating: 2.5, title: 'fraction' },
        overrideAccess: true,
      }),
    ).rejects.toThrow('The following field is invalid: Rating')
  })

  test('should validate with the request user', async ({ payload }) => {
    const user = await payload.create({
      collection: 'users',
      data: { email: 'owner@fuse.test', password: 'secret' },
      overrideAccess: true,
    })

    for (let i = 0; i < warmCalls; i++) {
      const doc = await payload.create({
        collection: 'rated',
        data: { owner: 'owner@fuse.test', title: `o${i}` },
        overrideAccess: true,
        user,
      })

      expect(doc.owner).toBe('owner@fuse.test')
    }

    await expect(
      payload.create({
        collection: 'rated',
        data: { owner: 'other@fuse.test', title: 'other' },
        overrideAccess: true,
        user,
      }),
    ).rejects.toThrow('The following field is invalid: Owner')
  })

  test('should validate updates against the stored value', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'rated',
      data: { code: 'locked', title: 'locked' },
      overrideAccess: true,
    })

    for (let i = 0; i < warmCalls; i++) {
      const updated = await payload.update({
        id: doc.id,
        collection: 'rated',
        data: { code: 'locked', title: `u${i}` },
        overrideAccess: true,
      })

      expect(updated.title).toBe(`u${i}`)
    }

    await expect(
      payload.update({
        id: doc.id,
        collection: 'rated',
        data: { code: 'open' },
        overrideAccess: true,
      }),
    ).rejects.toThrow('The following field is invalid: Code')
  })

  test('should write the values of compiled field hooks', async ({ payload }) => {
    for (let i = 0; i < warmCalls; i++) {
      const doc = await payload.create({
        collection: 'hooked',
        data: { meta: { kept: `k${i}` }, title: `  Title ${i} ` },
        overrideAccess: true,
      })

      expect(doc).toMatchObject({
        meta: { kept: `k${i}` },
        slug: `title ${i}`,
        title: `Title ${i}`,
      })
    }

    const doc = await payload.create({
      collection: 'hooked',
      data: { slug: 'given', title: 'x' },
      overrideAccess: true,
    })
    const updated = await payload.update({
      id: doc.id,
      collection: 'hooked',
      data: { meta: {}, title: ' y ' },
      overrideAccess: true,
    })

    expect(updated).toMatchObject({ slug: 'given', title: 'y' })
  })

  test('should keep an opted-out validator on the exact lane', async ({ payload }) => {
    const before = fuseWriteStats()?.ineligible['field:validate'] ?? 0

    const doc = await payload.create({
      collection: 'optedOut',
      data: { title: 'fine' },
      overrideAccess: true,
    })

    expect(doc.title).toBe('fine')
    await expect(
      payload.create({ collection: 'optedOut', data: { title: 'bad' }, overrideAccess: true }),
    ).rejects.toThrow('The following field is invalid: Title')

    if (process.env.PAYLOAD_RS_FUSE_WRITES !== 'off' && process.env.PAYLOAD_ENGINE !== 'ts') {
      expect(fuseWriteStats()?.ineligible['field:validate']).toBe(before + 2)
    }
  })

  test('should have served writes without lane differences', async () => {
    const stats = fuseWriteStats()

    if (process.env.PAYLOAD_RS_FUSE_WRITES === 'off' || process.env.PAYLOAD_ENGINE === 'ts') {
      return
    }

    expect(stats?.hits.create).toBeGreaterThan(0)
    expect(stats?.hits.updateByID).toBeGreaterThan(0)
    // guard mode saw the first calls of each validator on the exact lane
    expect(stats?.bails['prepare:fn:verify']).toBeGreaterThan(0)
    expect(stats?.diffs).toBe(0)
  })
})
