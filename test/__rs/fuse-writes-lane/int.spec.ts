import { expect } from 'vitest'

import { test } from '../../__helpers/int/vitest.js'

/**
 * Upstream's create behaviour the fused writes reproduce (packages/engine-rs/FUSED_WRITES.md).
 * Run with `PAYLOAD_RS_FUSE_WRITES=shadow` (the runner's `--fuse-writes shadow`) every eligible
 * write here also runs on the exact lane and is compared (result, raw BSON of the document and
 * its versions, the caller's `data`, `req.context`, clock and ObjectId readings); the last test
 * checks that the lane served calls and found no difference.
 */
type FuseWriteStats = {
  bails: Record<string, number>
  diffs: number
  guards: Record<string, number>
  hits: Record<string, number>
}

/** A stats key counted as a guard or a bail. */
const stopped = (stats: FuseWriteStats | undefined, key: string) =>
  (stats?.guards[key] ?? 0) + (stats?.bails[key] ?? 0)

const fuseWriteStats = (): FuseWriteStats | undefined =>
  Reflect.get(globalThis, Symbol.for('@payloadcms/engine-rs/fuse-write-stats'))

test.suite('fuse-writes', { config: './config.ts' }, () => {
  test('should create a document with defaults and timestamps', async ({ payload }) => {
    const author = await payload.create({
      collection: 'authors',
      data: { name: 'Ada' },
      overrideAccess: true,
    })
    const data = { author: author.id, title: 'first' }

    const post = await payload.create({ collection: 'posts', data, depth: 0, overrideAccess: true })

    expect(post).toMatchObject({ author: author.id, revision: 0, title: 'first', views: 0 })
    expect(typeof post.id).toBe('string')
    expect(Date.parse(post.updatedAt)).toBeGreaterThanOrEqual(Date.parse(post.createdAt))
    // the Local API runs the operation on a copy of the caller's data
    expect(data).toStrictEqual({ author: author.id, title: 'first' })
  })

  test('should populate the result at depth 1', async ({ payload }) => {
    const author = await payload.create({
      collection: 'authors',
      data: { name: 'Grace' },
      overrideAccess: true,
    })

    const post = await payload.create({
      collection: 'posts',
      data: { author: author.id, title: 'populated', views: 3 },
      depth: 1,
      overrideAccess: true,
    })

    expect(post.author).toMatchObject({ id: author.id, name: 'Grace' })
  })

  test('should write one latest version per create', async ({ payload }) => {
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'versioned' },
      overrideAccess: true,
    })

    const versions = await payload.findVersions({
      collection: 'posts',
      overrideAccess: true,
      where: { parent: { equals: post.id } },
    })

    expect(versions.docs).toHaveLength(1)
    expect(versions.docs[0]).toMatchObject({ parent: post.id })
    expect(versions.docs[0]!.version).toMatchObject({ title: 'versioned', views: 0 })
  })

  test('should create in a collection without versions', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'unversioned',
      data: { title: 'plain' },
      overrideAccess: true,
    })

    expect(doc).toMatchObject({ title: 'plain', views: 0 })
  })

  test('should create the typical shape and populate it at depth 2', async ({ payload }) => {
    const author = await payload.create({
      collection: 'authors',
      data: { name: 'Lin' },
      overrideAccess: true,
    })
    const category = await payload.create({
      collection: 'categories',
      data: { title: 'news' },
      overrideAccess: true,
    })
    const paragraph = (text: string) => ({
      type: 'paragraph',
      children: [
        { type: 'text', detail: 0, format: 0, mode: 'normal', style: '', text, version: 1 },
      ],
      direction: 'ltr',
      format: '',
      indent: 0,
      textFormat: 0,
      version: 1,
    })

    const doc = await payload.create({
      collection: 'typical',
      data: {
        author: author.id,
        categories: [category.id],
        content: {
          root: {
            type: 'root',
            children: [paragraph('hello')],
            direction: 'ltr',
            format: '',
            indent: 0,
            version: 1,
          },
        },
        excerpt: 'short',
        publishedAt: '2024-01-01T00:00:00.000Z',
        seo: { description: 'd', title: 't' },
        slug: 'typical-1',
        stage: 'review',
        tags: [{ tag: 'a' }, { tag: 'b' }],
        title: 'typical',
      } as never,
      depth: 2,
      overrideAccess: true,
    })

    expect(doc).toMatchObject({ featured: false, slug: 'typical-1', stage: 'review', views: 0 })
    expect(doc.author).toMatchObject({ name: 'Lin' })
    expect(doc.categories).toMatchObject([{ title: 'news' }])
    expect(doc.tags).toHaveLength(2)
  })

  test('should generate array row ids', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'rows',
      data: { items: [{ label: 'a' }, { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', label: 'b' }], meta: {} },
      overrideAccess: true,
    })

    expect(doc.items).toHaveLength(2)
    expect(typeof doc.items![0]!.id).toBe('string')
    expect(doc.items![1]!.id).toBe('aaaaaaaaaaaaaaaaaaaaaaaa')
  })

  test('should throw upstream validation errors', async ({ payload }) => {
    await expect(
      payload.create({ collection: 'posts', data: { views: 1 } as never, overrideAccess: true }),
    ).rejects.toThrow('The following field is invalid: Title')
  })

  test('should keep user hooks on the exact lane', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'hooked',
      data: { title: 'hook' },
      overrideAccess: true,
    })

    expect(doc.title).toBe('hook!')
  })

  test('should update by id and write a version', async ({ payload }) => {
    const author = await payload.create({
      collection: 'authors',
      data: { name: 'Ada' },
      overrideAccess: true,
    })
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'before' },
      overrideAccess: true,
    })
    const data = { author: author.id, views: 5 }

    const updated = await payload.update({
      id: post.id,
      collection: 'posts',
      data,
      depth: 1,
      overrideAccess: true,
    })
    const versions = await payload.findVersions({
      collection: 'posts',
      overrideAccess: true,
      sort: '-updatedAt',
      where: { parent: { equals: post.id } },
    })

    expect(updated).toMatchObject({ id: post.id, revision: 0, title: 'before', views: 5 })
    expect(updated.author).toMatchObject({ id: author.id, name: 'Ada' })
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(post.updatedAt))
    expect(versions.docs).toHaveLength(2)
    expect(versions.docs[0]).toMatchObject({ version: { views: 5 } })
    expect(versions.docs[1]).toMatchObject({ version: { views: 0 } })
    expect(data).toStrictEqual({ author: author.id, views: 5 })
  })

  test('should update the typical shape', async ({ payload }) => {
    const category = await payload.create({
      collection: 'categories',
      data: { title: 'news' },
      overrideAccess: true,
    })
    const doc = await payload.create({
      collection: 'typical',
      data: { slug: 'typical-update', tags: [{ tag: 'a' }], title: 'typical' } as never,
      overrideAccess: true,
    })

    const updated = await payload.update({
      id: doc.id,
      collection: 'typical',
      data: {
        categories: [category.id],
        seo: { title: 'seo' },
        tags: [...doc.tags!, { tag: 'b' }],
      } as never,
      depth: 2,
      overrideAccess: true,
    })

    expect(updated.tags!.map((row) => row.tag)).toStrictEqual(['a', 'b'])
    expect(updated.tags![0]!.id).toBe(doc.tags![0]!.id)
    expect(updated.categories).toMatchObject([{ title: 'news' }])
    expect(updated.seo).toMatchObject({ title: 'seo' })
  })

  test('should update in a collection without versions', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'unversioned',
      data: { title: 'plain' },
      overrideAccess: true,
    })

    const updated = await payload.update({
      id: doc.id,
      collection: 'unversioned',
      data: { views: 2 },
      overrideAccess: true,
    })

    expect(updated).toMatchObject({ title: 'plain', views: 2 })
  })

  test('should release the locks of an updated document', async ({ payload }) => {
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'locked' },
      overrideAccess: true,
    })
    const user = await payload.create({
      collection: 'users',
      data: { email: 'lock@example.com', password: 'test' },
      overrideAccess: true,
    })
    await payload.create({
      collection: 'payload-locked-documents',
      data: {
        document: { relationTo: 'posts', value: post.id },
        user: { relationTo: 'users', value: user.id },
      },
      overrideAccess: true,
    })

    await payload.update({
      id: post.id,
      collection: 'posts',
      data: { views: 1 },
      overrideAccess: true,
    })
    const locks = await payload.find({
      collection: 'payload-locked-documents',
      overrideAccess: true,
    })

    expect(locks.totalDocs).toBe(0)
  })

  test('should check locks with overrideLock false', async ({ payload }) => {
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'unlocked' },
      overrideAccess: true,
    })
    const user = await payload.create({
      collection: 'users',
      data: { email: 'holder@example.com', password: 'test' },
      overrideAccess: true,
    })

    const updated = await payload.update({
      id: post.id,
      collection: 'posts',
      data: { views: 3 },
      overrideAccess: true,
      overrideLock: false,
    })
    await payload.create({
      collection: 'payload-locked-documents',
      data: {
        document: { relationTo: 'posts', value: post.id },
        user: { relationTo: 'users', value: user.id },
      },
      overrideAccess: true,
    })

    expect(updated.views).toBe(3)
    await expect(
      payload.update({
        id: post.id,
        collection: 'posts',
        data: { views: 4 },
        overrideAccess: true,
        overrideLock: false,
      }),
    ).rejects.toThrow('currently locked')
    await expect(
      payload.delete({
        id: post.id,
        collection: 'posts',
        overrideAccess: true,
        overrideLock: false,
      }),
    ).rejects.toThrow('currently locked')
  })

  test('should throw upstream errors of updates', async ({ payload }) => {
    const post = await payload.create({
      collection: 'posts',
      data: { title: 'valid' },
      overrideAccess: true,
    })

    await expect(
      payload.update({
        id: post.id,
        collection: 'posts',
        data: { title: null } as never,
        overrideAccess: true,
      }),
    ).rejects.toThrow('The following field is invalid: Title')
    await expect(
      payload.update({
        id: '0123456789abcdef01234567',
        collection: 'posts',
        data: { views: 1 },
        overrideAccess: true,
      }),
    ).rejects.toThrow('Not Found')
  })

  test('should delete by id with its versions and preferences', async ({ payload }) => {
    const author = await payload.create({
      collection: 'authors',
      data: { name: 'Lin' },
      overrideAccess: true,
    })
    const post = await payload.create({
      collection: 'posts',
      data: { author: author.id, title: 'doomed' },
      overrideAccess: true,
    })
    await payload.update({
      id: post.id,
      collection: 'posts',
      data: { views: 2 },
      overrideAccess: true,
    })
    const user = await payload.create({
      collection: 'users',
      data: { email: 'preferences@example.com', password: 'test' },
      overrideAccess: true,
    })
    await payload.create({
      collection: 'payload-preferences',
      data: { key: `collection-posts-${post.id}`, value: { fields: {} } },
      overrideAccess: true,
      user,
    })

    const deleted = await payload.delete({
      id: post.id,
      collection: 'posts',
      depth: 1,
      overrideAccess: true,
    })
    const versions = await payload.countVersions({
      collection: 'posts',
      overrideAccess: true,
      where: { parent: { equals: post.id } },
    })
    const preferences = await payload.count({
      collection: 'payload-preferences',
      overrideAccess: true,
      where: { key: { equals: `collection-posts-${post.id}` } },
    })

    expect(deleted).toMatchObject({ id: post.id, title: 'doomed', views: 2 })
    expect(deleted.author).toMatchObject({ id: author.id, name: 'Lin' })
    expect(versions.totalDocs).toBe(0)
    expect(preferences.totalDocs).toBe(0)
    await expect(
      payload.delete({ id: post.id, collection: 'posts', overrideAccess: true }),
    ).rejects.toThrow('Not Found')
  })

  test('should write own blocks next to global blocks', async ({ payload }) => {
    const doc = await payload.create({
      collection: 'layouts',
      data: { layout: [{ blockType: 'text', body: 'b' }], title: 'own' },
      overrideAccess: true,
    })
    const withGlobal = await payload.create({
      collection: 'layouts',
      data: { layout: [{ blockType: 'callout', note: 'n' }], title: 'global' } as never,
      overrideAccess: true,
    })

    const updated = await payload.update({
      id: doc.id,
      collection: 'layouts',
      data: { layout: [...doc.layout!, { blockType: 'text', body: 'c' }] },
      overrideAccess: true,
    })

    expect(updated.layout!.map((row) => row.blockType)).toStrictEqual(['text', 'text'])
    expect(withGlobal.title).toBe('global')
  })

  test('should validate a static relationship filterOptions', async ({ payload }) => {
    const shown = await payload.create({
      collection: 'authors',
      data: { name: 'shown' },
      overrideAccess: true,
    })
    const hidden = await payload.create({
      collection: 'authors',
      data: { name: 'hidden' },
      overrideAccess: true,
    })

    const empty = await payload.create({
      collection: 'layouts',
      data: { title: 'no author' },
      overrideAccess: true,
    })
    const allowed = await payload.update({
      id: empty.id,
      collection: 'layouts',
      data: { author: shown.id },
      depth: 0,
      overrideAccess: true,
    })

    expect(allowed.author).toBe(shown.id)
    await expect(
      payload.update({
        id: empty.id,
        collection: 'layouts',
        data: { author: hidden.id },
        overrideAccess: true,
      }),
    ).rejects.toThrow('The following field is invalid: Author')
  })

  test('should update many documents and write their versions', async ({ payload }) => {
    const author = await payload.create({
      collection: 'authors',
      data: { name: 'Ada' },
      overrideAccess: true,
    })
    const ids: (number | string)[] = []
    for (const title of ['a', 'b', 'c']) {
      ids.push(
        (
          await payload.create({
            collection: 'posts',
            data: { author: author.id, title },
            overrideAccess: true,
          })
        ).id,
      )
    }
    const other = await payload.create({
      collection: 'posts',
      data: { title: 'other' },
      overrideAccess: true,
    })

    const result = await payload.update({
      collection: 'posts',
      data: { revision: 7 },
      overrideAccess: true,
      where: { id: { in: ids } },
    })

    expect(result.errors).toStrictEqual([])
    expect(result.docs.map((doc) => doc.revision)).toStrictEqual([7, 7, 7])
    expect(result.docs.map((doc) => (doc.author as { name: string }).name)).toStrictEqual([
      'Ada',
      'Ada',
      'Ada',
    ])
    const versions = await payload.findVersions({
      collection: 'posts',
      overrideAccess: true,
      where: { parent: { in: ids }, 'version.revision': { equals: 7 } },
    })
    expect(versions.totalDocs).toBe(3)
    const untouched = await payload.findByID({
      id: other.id,
      collection: 'posts',
      depth: 0,
      overrideAccess: true,
    })
    expect(untouched.revision).toBe(0)
  })

  test('should update many of the typical shape sorted, at depth 0', async ({ payload }) => {
    for (const title of ['z', 'y', 'x']) {
      await payload.create({
        collection: 'typical',
        data: { slug: title, title },
        overrideAccess: true,
      })
    }

    const result = await payload.update({
      collection: 'typical',
      data: { featured: true, seo: { title: 'bulk' }, tags: [{ tag: 'new' }] },
      depth: 0,
      overrideAccess: true,
      sort: 'title',
      where: { title: { in: ['x', 'y', 'z'] } },
    })

    expect(result.docs.map((doc) => doc.title)).toStrictEqual(['x', 'y', 'z'])
    expect(result.docs.every((doc) => doc.featured && doc.seo?.title === 'bulk')).toBe(true)
    // each document gets its own row id
    expect(new Set(result.docs.map((doc) => doc.tags?.[0]?.id)).size).toBe(3)
  })

  test('should update many without matches or versions', async ({ payload }) => {
    const none = await payload.update({
      collection: 'posts',
      data: { revision: 1 },
      overrideAccess: true,
      where: { title: { equals: 'missing' } },
    })
    await payload.create({
      collection: 'unversioned',
      data: { title: 'u' },
      overrideAccess: true,
    })
    const unversioned = await payload.update({
      collection: 'unversioned',
      data: { views: 3 },
      overrideAccess: true,
      where: { title: { equals: 'u' } },
    })

    expect(none).toStrictEqual({ docs: [], errors: [] })
    expect(unversioned.docs.map((doc) => doc.views)).toStrictEqual([3])
  })

  test('should report the validation errors of an update many', async ({ payload }) => {
    await payload.create({
      collection: 'posts',
      data: { title: 'valid' },
      overrideAccess: true,
    })

    const result = await payload.update({
      collection: 'posts',
      data: { title: '' },
      overrideAccess: true,
      where: { title: { equals: 'valid' } },
    })

    expect(result.docs).toStrictEqual([])
    expect(result.errors).toHaveLength(1)
  })

  test('should delete many documents with their versions and preferences', async ({ payload }) => {
    const author = await payload.create({
      collection: 'authors',
      data: { name: 'Ada' },
      overrideAccess: true,
    })
    const ids: (number | string)[] = []
    for (const title of ['d1', 'd2', 'd3']) {
      ids.push(
        (
          await payload.create({
            collection: 'posts',
            data: { author: author.id, title },
            overrideAccess: true,
          })
        ).id,
      )
    }
    await payload.update({
      id: ids[0]!,
      collection: 'posts',
      data: { revision: 1 },
      overrideAccess: true,
    })
    const user = await payload.create({
      collection: 'users',
      data: { email: 'bulk-preferences@example.com', password: 'test' },
      overrideAccess: true,
    })
    await payload.create({
      collection: 'payload-preferences',
      data: { key: `collection-posts-${ids[1]}`, value: { fields: {} } },
      overrideAccess: true,
      user,
    })
    await payload.create({
      collection: 'payload-locked-documents',
      data: {
        document: { relationTo: 'posts', value: ids[2]! },
        user: { relationTo: 'users', value: user.id },
      },
      overrideAccess: true,
    })

    const result = await payload.delete({
      collection: 'posts',
      overrideAccess: true,
      where: { id: { in: ids } },
    })

    expect(result.errors).toStrictEqual([])
    expect(result.docs.map((doc) => doc.title).sort()).toStrictEqual(['d1', 'd2', 'd3'])
    expect(result.docs.every((doc) => (doc.author as { name: string }).name === 'Ada')).toBe(true)
    const versions = await payload.countVersions({
      collection: 'posts',
      overrideAccess: true,
      where: { parent: { in: ids } },
    })
    expect(versions.totalDocs).toBe(0)
    const preferences = await payload.count({
      collection: 'payload-preferences',
      overrideAccess: true,
      where: { key: { equals: `collection-posts-${ids[1]}` } },
    })
    expect(preferences.totalDocs).toBe(0)
    const locks = await payload.count({
      collection: 'payload-locked-documents',
      overrideAccess: true,
    })
    expect(locks.totalDocs).toBe(0)
  })

  test('should delete many without matches', async ({ payload }) => {
    const result = await payload.delete({
      collection: 'posts',
      overrideAccess: true,
      where: { title: { equals: 'missing' } },
    })

    expect(result).toStrictEqual({ docs: [], errors: [] })
  })

  test('should write json fields and named tabs', async ({ payload }) => {
    const author = await payload.create({
      collection: 'authors',
      data: { name: 'Json' },
      overrideAccess: true,
    })
    const doc = await payload.create({
      collection: 'settings',
      data: { title: 's', config: { a: [1, { b: 2.5 }], c: null }, meta: { author: author.id } },
      depth: 1,
      overrideAccess: true,
    })

    const updated = await payload.update({
      id: doc.id,
      collection: 'settings',
      data: { config: [true], cover: author.id, meta: { extra: { on: false } } },
      depth: 0,
      overrideAccess: true,
    })

    expect(doc.meta).toMatchObject({ author: { id: author.id }, extra: { on: true } })
    expect(updated.config).toStrictEqual([true])
    expect(updated.cover).toBe(author.id)
    expect(updated.meta.extra).toStrictEqual({ on: false })
    await expect(
      payload.create({ collection: 'settings', data: { title: 'x' }, overrideAccess: true }),
    ).rejects.toThrow('The following field is invalid: Config')
  })

  test('should write json fields with a jsonSchema and dates with timezones', async ({
    payload,
  }) => {
    const hitsBefore = { ...fuseWriteStats()?.hits }
    const doc = await payload.create({
      collection: 'events',
      data: {
        title: 'e',
        details: { seats: 3, tags: ['a'], venue: 'hall' },
        startsAt: '2027-08-12T01:00:00.000Z',
        startsAt_tz: 'Asia/Tokyo',
        slots: [{ at: '2027-08-12T02:00:00.000Z', at_tz: 'Europe/Berlin' }, {}],
      },
      overrideAccess: true,
    })

    const updated = await payload.update({
      id: doc.id,
      collection: 'events',
      data: {
        details: { venue: 'park' },
        endsAt: '2027-08-13T00:00:00.000Z',
        endsAt_tz: 'Asia/Tokyo',
      },
      overrideAccess: true,
    })
    const many = await payload.update({
      collection: 'events',
      data: { startsAt: '2028-01-01T00:00:00.000Z' },
      overrideAccess: true,
      where: { id: { equals: doc.id } },
    })

    expect(doc).toMatchObject({
      details: { seats: 3, tags: ['a'], venue: 'hall' },
      endsAt_tz: 'Europe/London',
      startsAt_tz: 'Asia/Tokyo',
    })
    expect(doc.slots[0]).toMatchObject({ at_tz: 'Europe/Berlin' })
    expect(updated).toMatchObject({ details: { venue: 'park' }, endsAt_tz: 'Asia/Tokyo' })
    expect(many.docs[0]).toMatchObject({
      startsAt: '2028-01-01T00:00:00.000Z',
      startsAt_tz: 'Asia/Tokyo',
    })
    await expect(
      payload.create({
        collection: 'events',
        data: {
          title: 'x',
          details: { venue: 'roof' },
          startsAt: '2027-08-12T01:00:00.000Z',
          startsAt_tz: 'Asia/Tokyo',
        },
        overrideAccess: true,
      }),
    ).rejects.toThrow('The following field is invalid: Details')
    await expect(
      payload.create({
        collection: 'events',
        data: { title: 'x', startsAt: '2027-08-12T01:00:00.000Z' },
        overrideAccess: true,
      }),
    ).rejects.toThrow('The following field is invalid: Starts At')
    await payload.delete({ id: doc.id, collection: 'events', overrideAccess: true })
    const hits = fuseWriteStats()?.hits
    if (
      hits &&
      process.env.PAYLOAD_RS_FUSE_WRITES !== 'off' &&
      process.env.PAYLOAD_ENGINE !== 'ts'
    ) {
      expect(hits.create).toBeGreaterThan(hitsBefore.create ?? 0)
      expect(hits.updateByID).toBeGreaterThan(hitsBefore.updateByID ?? 0)
      expect(hits.updateMany).toBeGreaterThan(hitsBefore.updateMany ?? 0)
    }
  })

  test('should create documents with array defaults', async ({ payload }) => {
    const hitsBefore = fuseWriteStats()?.hits.create ?? 0
    const doc = await payload.create({ collection: 'presets', data: {}, overrideAccess: true })
    const given = await payload.create({
      collection: 'presets',
      data: { title: 'g', steps: [{ label: 'x' }], meta: {} },
      overrideAccess: true,
    })

    expect(doc.steps.map((step) => step.label)).toStrictEqual(['one', 'two'])
    expect(doc.steps.every((step) => typeof step.id === 'string')).toBe(true)
    expect(doc.layout).toMatchObject([{ blockType: 'card', note: 'n' }])
    expect(doc.meta.links).toMatchObject([{ url: 'u' }])
    expect(given.steps).toMatchObject([{ label: 'x' }])
    expect(given.meta.links).toMatchObject([{ url: 'u' }])
    if (process.env.PAYLOAD_RS_FUSE_WRITES !== 'off' && process.env.PAYLOAD_ENGINE !== 'ts') {
      expect(fuseWriteStats()?.hits.create).toBe(hitsBefore + 2)
    }
  })

  test('should update and delete many without overrideAccess', async ({ payload, restClient }) => {
    const author = await payload.create({
      collection: 'authors',
      data: { name: 'Bulk' },
      overrideAccess: true,
    })
    const create = (title: string) =>
      payload.create({
        collection: 'notices',
        data: { title, author: author.id, secret: 's' },
        overrideAccess: true,
      })
    const ids = [(await create('a')).id, (await create('b')).id, (await create('c')).id]
    const user = {
      ...(await payload.create({
        collection: 'users',
        data: { email: 'bulk@fuse.test', password: 'secret' },
        overrideAccess: true,
      })),
      collection: 'users',
    }
    // past guard sampling (the first 32 checked calls of each compiled access function run the
    // exact lane): collection, field and population read access, update and delete access
    const none = { id: { equals: '000000000000000000000000' } }
    for (let i = 0; i < 40; i++) {
      await payload.update({
        collection: 'notices',
        data: { title: 'w' },
        depth: 1,
        overrideAccess: false,
        user,
        where: { id: { equals: ids[2] } },
      })
      await payload.delete({ collection: 'notices', overrideAccess: false, user, where: none })
    }
    const hitsBefore = { ...fuseWriteStats()?.hits }

    const updated = await payload.update({
      collection: 'notices',
      data: { title: 'u' },
      depth: 1,
      overrideAccess: false,
      user,
      where: { id: { in: ids.slice(0, 2) } },
    })
    const patched = await restClient.PATCH('/notices', {
      body: JSON.stringify({ title: 'p' }),
      query: { where: { id: { in: ids } } },
    })
    const patchedJson = await patched.json()
    const deleted = await restClient.DELETE('/notices', {
      query: { where: { id: { in: ids.slice(1) } } },
    })
    const deletedJson = await deleted.json()
    const local = await payload.delete({
      collection: 'notices',
      depth: 2,
      overrideAccess: false,
      user,
      where: { id: { equals: ids[0] } },
    })
    const kept = await payload.create({
      collection: 'kept',
      data: { title: 'k' },
      overrideAccess: true,
    })
    const refused = await restClient.DELETE('/kept', {
      query: { where: { id: { equals: kept.id } } },
    })

    expect(updated.docs).toHaveLength(2)
    expect(updated.docs[0]).toMatchObject({ author: { id: author.id, name: 'Bulk' }, secret: 's' })
    expect(patched.status).toBe(200)
    expect(patchedJson.docs).toHaveLength(3)
    expect(patchedJson.docs[0].secret).toBeUndefined()
    expect(deleted.status).toBe(200)
    expect(deletedJson.docs.map((doc) => doc.title)).toStrictEqual(['p', 'p'])
    expect(local.docs[0]).toMatchObject({ title: 'p', secret: 's' })
    expect(refused.status).toBe(403)
    const hits = fuseWriteStats()?.hits
    if (
      hits &&
      process.env.PAYLOAD_RS_FUSE_WRITES !== 'off' &&
      process.env.PAYLOAD_ENGINE !== 'ts'
    ) {
      expect(hits.updateMany).toBeGreaterThanOrEqual((hitsBefore.updateMany ?? 0) + 2)
      expect(hits.deleteMany).toBeGreaterThanOrEqual((hitsBefore.deleteMany ?? 0) + 2)
    }
  })

  test('should keep writes whose result loads an unserved collection on the exact lane', async ({
    payload,
  }) => {
    const keys = ['populate:unserved', 'populate:related', 'backoff:populate:related']
    const before = Object.fromEntries(keys.map((key) => [key, stopped(fuseWriteStats(), key)]))
    const target = await payload.create({
      collection: 'readHooked',
      data: { title: 't' },
      overrideAccess: true,
    })
    const plain = await payload.create({
      collection: 'pointers',
      data: { title: 'plain' },
      depth: 1,
      overrideAccess: true,
    })
    const pointing = await payload.create({
      collection: 'pointers',
      data: { title: 'p', target: target.id },
      depth: 1,
      overrideAccess: true,
    })
    const updated = await payload.update({
      id: pointing.id,
      collection: 'pointers',
      data: { title: 'q' },
      depth: 1,
      overrideAccess: true,
    })
    const retargeted = await payload.update({
      id: plain.id,
      collection: 'pointers',
      data: { target: target.id },
      depth: 1,
      overrideAccess: true,
    })
    const deleted = await payload.delete({
      id: pointing.id,
      collection: 'pointers',
      depth: 1,
      overrideAccess: true,
    })

    expect(pointing.target).toMatchObject({ id: target.id, title: 't' })
    expect(updated).toMatchObject({ title: 'q', target: { id: target.id } })
    expect(retargeted.target).toMatchObject({ id: target.id })
    expect(deleted).toMatchObject({ title: 'q', target: { id: target.id } })
    const stats = fuseWriteStats()
    if (
      stats &&
      process.env.PAYLOAD_RS_FUSE_WRITES !== 'off' &&
      process.env.PAYLOAD_ENGINE !== 'ts'
    ) {
      const delta = (key: string) => stopped(stats, key) - before[key]!
      // the create holding the value and the update setting it stop before the native call, the
      // update and the delete of the stored value after the stored read, before any statement
      // (run lanes: calls after such a bail back off)
      expect(delta('populate:unserved')).toBeGreaterThanOrEqual(1)
      expect(keys.reduce((sum, key) => sum + delta(key), 0)).toBe(4)
    }
  })

  test('should update and delete by id and many with a where-constraint access', async ({
    payload,
    restClient,
  }) => {
    const create = (collection: 'constrained' | 'constrainedDrafts', views: number) =>
      payload.create({ collection, data: { title: 'c', views }, overrideAccess: true })
    const allowed = await create('constrained', 1)
    const denied = await create('constrained', -1)
    const none = { id: { equals: '000000000000000000000000' } }
    // past guard sampling (the first 32 checked calls of each compiled access function run the
    // exact lane)
    for (let i = 0; i < 40; i++) {
      await payload.update({
        id: allowed.id,
        collection: 'constrained',
        data: { title: `w${i}` },
        overrideAccess: false,
      })
      await payload.delete({ collection: 'constrained', overrideAccess: false, where: none })
    }
    const hitsBefore = { ...fuseWriteStats()?.hits }

    const updated = await payload.update({
      id: allowed.id,
      collection: 'constrained',
      data: { title: 'u', views: 2 },
      overrideAccess: false,
    })
    await expect(
      payload.update({
        id: denied.id,
        collection: 'constrained',
        data: { title: 'u' },
        overrideAccess: false,
      }),
    ).rejects.toThrow('You are not allowed to perform this action.')
    const patched = await restClient.PATCH(`/constrained/${denied.id}`, {
      body: JSON.stringify({ title: 'p' }),
    })
    const patchedJson = await patched.json()
    const missing = await restClient.PATCH(`/constrained/${none.id.equals}`, {
      body: JSON.stringify({ title: 'p' }),
    })
    const many = await payload.update({
      collection: 'constrained',
      data: { title: 'm' },
      overrideAccess: false,
      where: { id: { in: [allowed.id, denied.id] } },
    })
    const restMany = await restClient.PATCH('/constrained', {
      body: JSON.stringify({ title: 'r' }),
      query: { where: { id: { in: [allowed.id, denied.id] } } },
    })
    const restManyJson = await restMany.json()
    await expect(
      payload.delete({ id: denied.id, collection: 'constrained', overrideAccess: false }),
    ).rejects.toThrow('You are not allowed to perform this action.')
    const restDenied = await restClient.DELETE(`/constrained/${denied.id}`)
    const second = await create('constrained', 3)
    const deletedMany = await payload.delete({
      collection: 'constrained',
      overrideAccess: false,
      where: { id: { in: [denied.id, second.id] } },
    })
    const deleted = await payload.delete({
      id: allowed.id,
      collection: 'constrained',
      overrideAccess: false,
    })
    const left = await payload.find({ collection: 'constrained', overrideAccess: true })

    expect(updated).toMatchObject({ id: allowed.id, title: 'u', views: 2 })
    expect(patched.status).toBe(403)
    expect(patchedJson.errors[0].message).toBe('You are not allowed to perform this action.')
    expect(missing.status).toBe(403)
    expect(many.docs.map((doc) => doc.id)).toStrictEqual([allowed.id])
    expect(many.errors).toStrictEqual([])
    expect(restMany.status).toBe(200)
    expect(restManyJson.docs.map((doc) => doc.id)).toStrictEqual([allowed.id])
    expect(restDenied.status).toBe(403)
    expect(deletedMany.docs.map((doc) => doc.id)).toStrictEqual([second.id])
    expect(deleted).toMatchObject({ id: allowed.id, title: 'r' })
    expect(left.docs.map((doc) => doc.id)).toStrictEqual([denied.id])

    // drafts: the constraint on the latest version (`version.views`), else on the main document
    const draftDoc = await create('constrainedDrafts', 1)
    // past its access function's guard sampling
    for (let i = 0; i < 34; i++) {
      await payload.update({
        id: draftDoc.id,
        collection: 'constrainedDrafts',
        data: { title: `d${i}` },
        draft: true,
        overrideAccess: false,
      })
    }
    const draftSave = await payload.update({
      id: draftDoc.id,
      collection: 'constrainedDrafts',
      data: { views: -1 },
      draft: true,
      overrideAccess: false,
    })
    // the latest version no longer matches: upstream reads the main document (views 1)
    const fromMain = await payload.update({
      id: draftDoc.id,
      collection: 'constrainedDrafts',
      data: { title: 'main' },
      draft: true,
      overrideAccess: false,
    })
    const published = await payload.update({
      id: draftDoc.id,
      collection: 'constrainedDrafts',
      data: { _status: 'published', title: 'pub', views: -2 },
      overrideAccess: false,
    })
    await expect(
      payload.update({
        id: draftDoc.id,
        collection: 'constrainedDrafts',
        data: { title: 'no' },
        overrideAccess: false,
      }),
    ).rejects.toThrow('You are not allowed to perform this action.')

    expect(draftSave).toMatchObject({ title: 'd33', views: -1 })
    expect(fromMain).toMatchObject({ title: 'main', views: 1 })
    expect(published).toMatchObject({ title: 'pub', views: -2, _status: 'published' })
    const hits = fuseWriteStats()?.hits
    if (
      hits &&
      process.env.PAYLOAD_RS_FUSE_WRITES !== 'off' &&
      process.env.PAYLOAD_ENGINE !== 'ts'
    ) {
      // `updated`, and the draft saves and the publish after the drafts' warm-up
      expect(hits.updateByID).toBeGreaterThanOrEqual((hitsBefore.updateByID ?? 0) + 4)
      expect(hits.updateMany).toBeGreaterThanOrEqual((hitsBefore.updateMany ?? 0) + 2)
      expect(hits.deleteMany).toBeGreaterThanOrEqual((hitsBefore.deleteMany ?? 0) + 1)
      expect(hits.deleteByID).toBeGreaterThanOrEqual((hitsBefore.deleteByID ?? 0) + 1)
    }
  })

  test('should keep and generate slugs like upstream', async ({ payload }) => {
    const hitsBefore = { ...fuseWriteStats()?.hits }
    const first = await payload.create({
      collection: 'slugged',
      data: { title: 'Hello World' },
      overrideAccess: true,
    })
    const second = await payload.create({
      collection: 'slugged',
      data: { title: 'Hello World' },
      overrideAccess: true,
    })
    const kept = await payload.update({
      id: first.id,
      collection: 'slugged',
      data: { title: 'Renamed' },
      overrideAccess: true,
    })
    const same = await payload.update({
      id: first.id,
      collection: 'slugged',
      data: { slug: ' Hello World ' },
      overrideAccess: true,
    })
    const renamed = await payload.update({
      id: first.id,
      collection: 'slugged',
      data: { slug: 'Other Slug' },
      overrideAccess: true,
    })
    await expect(
      payload.update({
        id: second.id,
        collection: 'slugged',
        data: { slug: 'other-slug' },
        overrideAccess: true,
      }),
    ).rejects.toThrow('The following field is invalid: slug')
    const many = await payload.update({
      collection: 'slugged',
      data: { title: 'Many' },
      overrideAccess: true,
      where: { id: { in: [first.id, second.id] } },
    })

    expect(first.slug).toBe('hello-world')
    expect(second.slug).toBe('hello-world-1')
    expect(kept).toMatchObject({ slug: 'hello-world', title: 'Renamed' })
    expect(same.slug).toBe('hello-world')
    expect(renamed.slug).toBe('other-slug')
    expect(many.docs.map((doc) => doc.slug).sort()).toStrictEqual(['hello-world-1', 'other-slug'])
    const hits = fuseWriteStats()?.hits
    if (
      hits &&
      process.env.PAYLOAD_RS_FUSE_WRITES !== 'off' &&
      process.env.PAYLOAD_ENGINE !== 'ts'
    ) {
      expect(hits.updateByID).toBeGreaterThanOrEqual((hitsBefore.updateByID ?? 0) + 2)
      expect(hits.updateMany).toBeGreaterThanOrEqual((hitsBefore.updateMany ?? 0) + 1)
    }
  })

  test('should have served writes without lane differences', async () => {
    const stats = fuseWriteStats()

    if (process.env.PAYLOAD_RS_FUSE_WRITES === 'off' || process.env.PAYLOAD_ENGINE === 'ts') {
      return
    }

    expect(stats?.hits.create).toBeGreaterThan(0)
    expect(stats?.hits.updateByID).toBeGreaterThan(0)
    expect(stats?.hits.deleteByID).toBeGreaterThan(0)
    expect(stats?.hits.updateMany).toBeGreaterThan(0)
    expect(stats?.hits.deleteMany).toBeGreaterThan(0)
    expect(stats?.diffs).toBe(0)
  })
})
