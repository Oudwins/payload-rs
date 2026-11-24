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

  test('should have served creates without lane differences', async () => {
    const stats = fuseWriteStats()

    if (!process.env.PAYLOAD_RS_FUSE_WRITES || process.env.PAYLOAD_RS_FUSE_WRITES === 'off') {
      return
    }

    expect(stats?.hits.create).toBeGreaterThan(0)
    expect(stats?.diffs).toBe(0)
  })
})
