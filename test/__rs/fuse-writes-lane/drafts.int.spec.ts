import { expect } from 'vitest'

import { test } from '../../__helpers/int/vitest.js'

/**
 * Upstream's behaviour of writes to collections with drafts, which the fused writes reproduce
 * (packages/engine-rs/FUSED_WRITES.md sections 12 and 13). Run with `PAYLOAD_RS_FUSE_WRITES=shadow`
 * every eligible write here also runs on the exact lane and is compared; the last test checks
 * that the lane served calls and found no difference.
 */
type FuseWriteStats = {
  diffs: number
  hits: Record<string, number>
}

const fuseWriteStats = (): FuseWriteStats | undefined =>
  Reflect.get(globalThis, Symbol.for('@payloadcms/engine-rs/fuse-write-stats'))

test.suite('fuse-writes drafts', { config: './drafts.config.ts' }, () => {
  test('should create a published document with a latest version', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'drafts',
      data: { _status: 'published', items: [{ label: 'a' }], title: 'first' },
      overrideAccess: true,
    })

    const versions = await payload.findVersions({
      collection: 'drafts',
      overrideAccess: true,
      where: { parent: { equals: doc.id } },
    })

    expect(doc).toMatchObject({ _status: 'published', title: 'first', views: 0 })
    expect(versions.docs).toHaveLength(1)
    expect(versions.docs[0]).toMatchObject({ latest: true, parent: doc.id })
    expect(versions.docs[0]!.version).toMatchObject({ _status: 'published', title: 'first' })
  })

  test('should default the status of a create to draft', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'drafts',
      data: { title: 'defaulted' },
      overrideAccess: true,
    })

    expect(doc._status).toBe('draft')
  })

  test('should create a draft without validating it', async ({ payload }) => {
    const data = { views: 2 }

    const doc = await payload.create({
      collection: 'drafts',
      data: data as never,
      draft: true,
      overrideAccess: true,
    })

    expect(doc).toMatchObject({ _status: 'draft', views: 2 })
    expect(doc.title).toBeUndefined()
    expect(data).toStrictEqual({ views: 2 })
  })

  test('should validate drafts when the collection asks for it', async ({ payload }) => {
    await expect(
      payload.create({
        collection: 'validated',
        data: {} as never,
        draft: true,
        overrideAccess: true,
      }),
    ).rejects.toThrow('The following field is invalid: Title')
  })

  test('should save a draft as a version only', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'drafts',
      data: { _status: 'published', title: 'live' },
      overrideAccess: true,
    })

    const draft = await payload.update({
      id: doc.id,
      collection: 'drafts',
      data: { title: 'next' },
      draft: true,
      overrideAccess: true,
    })
    const main = await payload.findByID({ id: doc.id, collection: 'drafts', overrideAccess: true })
    const latest = await payload.findByID({
      id: doc.id,
      collection: 'drafts',
      draft: true,
      overrideAccess: true,
    })
    const versions = await payload.findVersions({
      collection: 'drafts',
      overrideAccess: true,
      sort: 'createdAt',
      where: { parent: { equals: doc.id } },
    })

    expect(draft).toMatchObject({ _status: 'draft', id: doc.id, title: 'next' })
    expect(main).toMatchObject({ _status: 'published', title: 'live' })
    expect(latest).toMatchObject({ _status: 'draft', title: 'next' })
    expect(versions.docs.map((version) => version.latest)).toStrictEqual([undefined, true])
  })

  test('should publish over the latest draft', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'drafts',
      data: { title: 'v1' },
      draft: true,
      overrideAccess: true,
    })

    await payload.update({
      id: doc.id,
      collection: 'drafts',
      data: { items: [{ label: 'x' }], title: 'v2' },
      draft: true,
      overrideAccess: true,
    })
    const published = await payload.update({
      id: doc.id,
      collection: 'drafts',
      data: { _status: 'published' },
      overrideAccess: true,
    })
    const main = await payload.findByID({ id: doc.id, collection: 'drafts', overrideAccess: true })

    expect(published).toMatchObject({ _status: 'published', title: 'v2' })
    expect(main).toMatchObject({ _status: 'published', items: [{ label: 'x' }], title: 'v2' })
  })

  test('should publish when a draft update sends the published status', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'drafts',
      data: { title: 'a' },
      overrideAccess: true,
    })

    const updated = await payload.update({
      id: doc.id,
      collection: 'drafts',
      data: { _status: 'published', title: 'b' },
      draft: true,
      overrideAccess: true,
    })
    const main = await payload.findByID({ id: doc.id, collection: 'drafts', overrideAccess: true })

    expect(updated).toMatchObject({ _status: 'published', title: 'b' })
    expect(main).toMatchObject({ _status: 'published', title: 'b' })
  })

  test('should populate a draft save', async ({ payload }) => {
    const author = await payload.create({
      collection: 'authors',
      data: { name: 'Ada' },
      overrideAccess: true,
    })
    const doc = await payload.create({
      collection: 'drafts',
      data: { title: 'pop' },
      overrideAccess: true,
    })

    const draft = await payload.update({
      id: doc.id,
      collection: 'drafts',
      data: { author: author.id },
      depth: 1,
      draft: true,
      overrideAccess: true,
    })

    expect(draft.author).toMatchObject({ id: author.id, name: 'Ada' })
  })

  test('should keep at most maxPerDoc versions', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'capped',
      data: { title: '0' },
      overrideAccess: true,
    })

    for (const title of ['1', '2', '3']) {
      await payload.update({
        id: doc.id,
        collection: 'capped',
        data: { title },
        draft: true,
        overrideAccess: true,
      })
    }
    const versions = await payload.findVersions({
      collection: 'capped',
      overrideAccess: true,
      where: { parent: { equals: doc.id } },
    })

    expect(versions.docs.map((version) => version.version.title).sort()).toStrictEqual(['2', '3'])
  })

  test('should delete a document with drafts and its versions', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'drafts',
      data: { title: 'gone' },
      overrideAccess: true,
    })
    await payload.update({
      id: doc.id,
      collection: 'drafts',
      data: { title: 'gone 2' },
      draft: true,
      overrideAccess: true,
    })

    await payload.delete({ id: doc.id, collection: 'drafts', overrideAccess: true })
    const versions = await payload.findVersions({
      collection: 'drafts',
      overrideAccess: true,
      where: { parent: { equals: doc.id } },
    })

    expect(versions.docs).toHaveLength(0)
  })

  test('should delete many documents with drafts', async ({ payload }) => {
    for (const title of ['m1', 'm2']) {
      await payload.create({ collection: 'drafts', data: { title }, overrideAccess: true })
    }

    const deleted = await payload.delete({
      collection: 'drafts',
      overrideAccess: true,
      where: { title: { in: ['m1', 'm2'] } },
    })

    expect(deleted.docs).toHaveLength(2)
  })

  test('should have served writes without lane differences', () => {
    if (process.env.PAYLOAD_RS_FUSE_WRITES === 'off' || process.env.PAYLOAD_ENGINE === 'ts') {
      return
    }
    const stats = fuseWriteStats()

    expect(stats?.hits.create).toBeGreaterThan(0)
    expect(stats?.hits.updateByID).toBeGreaterThan(0)
    expect(stats?.hits.deleteByID).toBeGreaterThan(0)
    expect(stats?.hits.deleteMany).toBeGreaterThan(0)
    expect(stats?.diffs).toBe(0)
  })
})
