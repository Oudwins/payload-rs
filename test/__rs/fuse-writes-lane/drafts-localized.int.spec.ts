import { expect } from 'vitest'

import { test } from '../../__helpers/int/vitest.js'

/**
 * Upstream's behaviour of writes to collections with drafts on a localized config, which the
 * fused writes reproduce where they can (packages/engine-rs/FUSED_WRITES.md section 13): a
 * localized `_status` (`localizeStatus`) per locale, draft saves of a collection without
 * localized fields. Run with `PAYLOAD_RS_FUSE_WRITES=shadow` every eligible write here also runs
 * on the exact lane and is compared.
 */
type FuseWriteStats = {
  bails: Record<string, number>
  diffs: number
  hits: Record<string, number>
}

const fuseWriteStats = (): FuseWriteStats | undefined =>
  Reflect.get(globalThis, Symbol.for('@payloadcms/engine-rs/fuse-write-stats'))

test.suite('fuse-writes drafts localized', { config: './drafts-localized.config.ts' }, () => {
  test('should create with a localized status', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'articles',
      data: { title: 'hello' },
      locale: 'en',
      overrideAccess: true,
    })

    const all = await payload.findByID({
      id: doc.id,
      collection: 'articles',
      locale: 'all',
      overrideAccess: true,
    })

    expect(doc).toMatchObject({ _status: 'draft', title: 'hello' })
    expect(all._status).toStrictEqual({ de: 'draft', en: 'draft' })
  })

  test('should save a draft in another locale', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'articles',
      data: { title: 'hello' },
      draft: true,
      locale: 'en',
      overrideAccess: true,
    })

    const draft = await payload.update({
      id: doc.id,
      collection: 'articles',
      data: { title: 'hallo' },
      draft: true,
      locale: 'de',
      overrideAccess: true,
    })
    const latest = await payload.findByID({
      id: doc.id,
      collection: 'articles',
      draft: true,
      locale: 'all',
      overrideAccess: true,
    })

    expect(draft).toMatchObject({ _status: 'draft', title: 'hallo' })
    expect(latest.title).toStrictEqual({ de: 'hallo', en: 'hello' })
  })

  test('should update a locale left as a draft without publishing it', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'articles',
      data: { title: 'one' },
      locale: 'en',
      overrideAccess: true,
    })

    const updated = await payload.update({
      id: doc.id,
      collection: 'articles',
      data: { views: 5 },
      locale: 'en',
      overrideAccess: true,
    })

    expect(updated).toMatchObject({ _status: 'draft', title: 'one', views: 5 })
  })

  test('should publish one locale', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'articles',
      data: { title: 'pub' },
      draft: true,
      locale: 'en',
      overrideAccess: true,
    })

    const published = await payload.update({
      id: doc.id,
      collection: 'articles',
      data: { _status: 'published' },
      locale: 'en',
      overrideAccess: true,
    })

    expect(published).toMatchObject({ _status: 'published', title: 'pub' })
  })

  test('should save drafts of a collection without localized fields', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'notes',
      data: { title: 'n1' },
      draft: true,
      overrideAccess: true,
    })

    const draft = await payload.update({
      id: doc.id,
      collection: 'notes',
      data: { title: 'n2' },
      draft: true,
      overrideAccess: true,
    })
    const published = await payload.update({
      id: doc.id,
      collection: 'notes',
      data: { _status: 'published' },
      overrideAccess: true,
    })

    expect(draft).toMatchObject({ _status: 'draft', title: 'n2' })
    expect(published).toMatchObject({ _status: 'published', title: 'n2' })
  })

  test('should publish all locales of a collection without localized fields', async ({
    payload,
  }) => {
    const doc = await payload.create({
      collection: 'bulletins',
      data: { title: 'b', items: [{ item: 'a' }], extra: { count: 1 } },
      locale: 'de',
      overrideAccess: true,
    })

    const updated = await payload.update({
      id: doc.id,
      collection: 'bulletins',
      data: { extra: { count: 2 } },
      locale: 'en',
      overrideAccess: true,
    })
    const many = await payload.update({
      collection: 'bulletins',
      data: { title: 'many' },
      overrideAccess: true,
      where: { id: { equals: doc.id } },
    })

    expect(doc).toMatchObject({ _status: 'draft', title: 'b' })
    expect(updated.extra.count).toBe(2)
    expect(many.docs[0]).toMatchObject({ title: 'many' })
  })

  test('should reject an invalid publish of all locales', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'bulletins',
      data: { title: 'b' },
      overrideAccess: true,
    })

    await expect(
      payload.update({
        id: doc.id,
        collection: 'bulletins',
        data: { extra: { count: 10 } },
        overrideAccess: true,
      }),
    ).rejects.toThrow('The following field is invalid: Extra > Count')
  })

  test('should delete documents with a localized status', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'articles',
      data: { title: 'bye' },
      locale: 'en',
      overrideAccess: true,
    })

    const deleted = await payload.delete({
      id: doc.id,
      collection: 'articles',
      overrideAccess: true,
    })

    expect(deleted).toMatchObject({ _status: 'draft', id: doc.id })
  })

  test('should write documents with an unnamed group and a radio', async ({ payload }) => {
    const hitsBefore = fuseWriteStats()?.hits.create ?? 0
    const doc = await payload.create({
      collection: 'draftPosts',
      data: {
        blocksField: [{ blockType: 'block', localized: 'l', text: 't' }],
        description: 'd',
        radio: 'test',
        title: 'grouped',
      },
      draft: true,
      locale: 'en',
      overrideAccess: true,
    })
    const related = await payload.create({
      collection: 'draftPosts',
      data: { description: 'r', relation: doc.id, title: 'related' },
      locale: 'en',
      overrideAccess: true,
    })

    const draft = await payload.update({
      id: doc.id,
      collection: 'draftPosts',
      data: { title: 'gruppiert' },
      draft: true,
      locale: 'de',
      overrideAccess: true,
    })
    const published = await payload.update({
      id: doc.id,
      collection: 'draftPosts',
      data: { _status: 'published', description: 'p' },
      locale: 'en',
      overrideAccess: true,
    })
    const all = await payload.findByID({
      id: doc.id,
      collection: 'draftPosts',
      draft: true,
      locale: 'all',
      overrideAccess: true,
    })

    expect(related).toMatchObject({ relation: { id: doc.id }, title: 'related' })
    expect(draft).toMatchObject({ _status: 'draft', radio: 'test', title: 'gruppiert' })
    expect(published).toMatchObject({ _status: 'published', description: 'p', title: 'grouped' })
    expect(all.title).toStrictEqual({ de: 'gruppiert', en: 'grouped' })
    if (fuseWriteStats() && process.env.PAYLOAD_RS_FUSE_WRITES !== 'off') {
      expect(fuseWriteStats()!.hits.create).toBeGreaterThan(hitsBefore)
    }
  })

  test('should reject writes to an unnamed group the same way', async ({ payload }) => {
    await payload.create({
      collection: 'draftPosts',
      data: { description: 'd', title: 'taken' },
      locale: 'en',
      overrideAccess: true,
    })

    await expect(
      payload.create({
        collection: 'draftPosts',
        data: { description: 'd' },
        locale: 'en',
        overrideAccess: true,
      }),
    ).rejects.toThrow('The following field is invalid: Group > Title')
    await expect(
      payload.create({
        collection: 'draftPosts',
        data: { description: 'd', radio: 'other', title: 'radio' },
        locale: 'en',
        overrideAccess: true,
      }),
    ).rejects.toThrow('The following field is invalid: Radio')
    await expect(
      payload.create({
        collection: 'draftPosts',
        data: { description: 'd', title: 'taken' },
        locale: 'en',
        overrideAccess: true,
      }),
    ).rejects.toThrow('The following field is invalid: title')
  })

  test('should look up unique values when publishing all locales', async ({ payload }) => {
    const note = await payload.create({
      collection: 'notes',
      data: { title: 'n' },
      overrideAccess: true,
    })
    const before = { ...fuseWriteStats()?.hits }
    const conflictsBefore = fuseWriteStats()?.bails['drafts:localizedPublish:unique:conflict'] ?? 0

    const first = await payload.create({
      collection: 'codes',
      data: { code: 'a', hideout: { note: note.id }, meta: { rank: 1 } },
      locale: 'de',
      overrideAccess: true,
    })
    await expect(
      payload.create({
        collection: 'codes',
        data: { code: 'a' },
        locale: 'en',
        overrideAccess: true,
      }),
    ).rejects.toThrow('The following field is invalid: Code')
    await expect(
      payload.create({
        collection: 'codes',
        data: { hideout: { note: note.id } },
        overrideAccess: true,
      }),
    ).rejects.toThrow('The following field is invalid: Note')
    const second = await payload.create({
      collection: 'codes',
      data: { code: 'b' },
      overrideAccess: true,
    })
    // the stored code is looked up again and only matches the document itself
    const kept = await payload.update({
      id: first.id,
      collection: 'codes',
      data: { meta: { rank: 2 } },
      locale: 'en',
      overrideAccess: true,
    })
    await expect(
      payload.update({
        id: second.id,
        collection: 'codes',
        data: { code: 'a' },
        overrideAccess: true,
      }),
    ).rejects.toThrow('The following field is invalid: Code')
    await expect(
      payload.update({
        id: second.id,
        collection: 'codes',
        data: { meta: { rank: 2 } },
        overrideAccess: true,
      }),
    ).rejects.toThrow('The following field is invalid: Rank')
    const many = await payload.update({
      collection: 'codes',
      data: { code: 'a' },
      overrideAccess: true,
      where: { id: { in: [first.id, second.id] } },
    })
    const draft = await payload.create({
      collection: 'codes',
      data: { code: 'c' },
      draft: true,
      overrideAccess: true,
    })

    expect(first).toMatchObject({ code: 'a', meta: { rank: 1 } })
    expect(kept).toMatchObject({ code: 'a', meta: { rank: 2 } })
    expect(many.docs.map((doc) => doc.id)).toStrictEqual([first.id])
    expect(many.errors.map((error) => error.id)).toStrictEqual([second.id])
    expect(draft.code).toBe('c')
    const stats = fuseWriteStats()
    if (
      stats &&
      process.env.PAYLOAD_RS_FUSE_WRITES !== 'off' &&
      process.env.PAYLOAD_ENGINE !== 'ts'
    ) {
      expect(stats.hits.create).toBeGreaterThanOrEqual((before.create ?? 0) + 3)
      expect(stats.hits.updateByID).toBeGreaterThanOrEqual((before.updateByID ?? 0) + 1)
      expect(stats.bails['drafts:localizedPublish:unique:conflict'] ?? 0).toBeGreaterThan(
        conflictsBefore,
      )
    }
  })

  test('should have served writes without lane differences', () => {
    if (process.env.PAYLOAD_RS_FUSE_WRITES === 'off' || process.env.PAYLOAD_ENGINE === 'ts') {
      return
    }
    const stats = fuseWriteStats()

    expect(stats?.hits.create).toBeGreaterThan(0)
    expect(stats?.hits.updateByID).toBeGreaterThan(0)
    expect(stats?.hits.deleteByID).toBeGreaterThan(0)
    expect(stats?.diffs).toBe(0)
  })
})
