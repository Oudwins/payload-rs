import { expect } from 'vitest'

import { test } from '../../__helpers/int/vitest.js'

/**
 * Localized creates of the typical shape with blocks (packages/engine-rs/FUSED_WRITES.md section
 * 13): run with `PAYLOAD_RS_FUSE_WRITES=shadow` every eligible create is compared with the exact
 * lane; the last test checks that the lane served them without a difference.
 */
type FuseWriteStats = { diffs: number; hits: Record<string, number> }

const fuseWriteStats = (): FuseWriteStats | undefined =>
  Reflect.get(globalThis, Symbol.for('@payloadcms/engine-rs/fuse-write-stats'))

const richText = (text: string) => ({
  root: {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'text', detail: 0, format: 0, mode: 'normal', style: '', text, version: 1 },
        ],
        direction: 'ltr',
        format: '',
        indent: 0,
        textFormat: 0,
        version: 1,
      },
    ],
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  },
})

test.suite('fuse-writes-lane localized', { config: './localized.config.ts' }, () => {
  test('should create in the default locale and populate at depth 2', async ({ payload }) => {
    const author = await payload.create({
      collection: 'authors',
      data: { name: 'Ada' },
      overrideAccess: true,
    })
    const category = await payload.create({
      collection: 'categories',
      data: { title: 'news' },
      overrideAccess: true,
    })

    const post = await payload.create({
      collection: 'posts',
      data: {
        author: author.id,
        categories: [category.id],
        content: richText('hello'),
        excerpt: 'short',
        layout: [{ blockType: 'hero', heading: 'h', items: [{ label: 'x' }] }],
        publishedAt: '2024-01-01T00:00:00.000Z',
        seo: { description: 'd', title: 't' },
        slug: 'post-1',
        tags: [{ tag: 'a' }],
        title: 'english',
      } as never,
      depth: 2,
      overrideAccess: true,
    })

    expect(post).toMatchObject({ slug: 'post-1', stage: 'draft', title: 'english' })
    expect(post.author).toMatchObject({ name: 'Ada' })
    expect(post.layout).toMatchObject([{ blockType: 'hero', heading: 'h' }])
  })

  test('should create in another locale', async ({ payload }) => {
    const post = await payload.create({
      collection: 'posts',
      data: { excerpt: 'kurz', seo: { title: 'titel' }, slug: 'post-de', title: 'deutsch' },
      depth: 0,
      locale: 'de',
      overrideAccess: true,
    })

    const all = await payload.findByID({
      id: post.id,
      collection: 'posts',
      locale: 'all',
      overrideAccess: true,
    })

    expect(post.title).toBe('deutsch')
    expect(all.title).toStrictEqual({ de: 'deutsch' })
  })

  test('should have served creates without lane differences', () => {
    if (!process.env.PAYLOAD_RS_FUSE_WRITES || process.env.PAYLOAD_RS_FUSE_WRITES === 'off') {
      return
    }
    const stats = fuseWriteStats()

    expect(stats?.hits.create).toBeGreaterThan(0)
    expect(stats?.diffs).toBe(0)
  })
})
