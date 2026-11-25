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
  diffs: number
  hits: Record<string, number>
}

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
