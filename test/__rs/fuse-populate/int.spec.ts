import type { Payload } from 'payload'

import { createPayloadRequest } from 'payload'
import { expect } from 'vitest'

import { test } from '../../__helpers/int/vitest.js'

/**
 * Upstream's population behaviour the fused lanes reproduce (FUSE_CONTRACT.md section 9): run
 * with `PAYLOAD_RS_FUSE=shadow` (the runners' `--fuse shadow`) every read here is also compared
 * with the exact lane, including the dataloader cache and the request state it leaves.
 */
const seed = async (payload: Payload) => {
  const categories = []
  for (let i = 0; i < 4; i++) {
    categories.push(
      await payload.create({
        collection: 'categories',
        overrideAccess: true,
        data: { title: `category ${i}` },
      }),
    )
  }
  const tags = []
  for (let i = 0; i < 3; i++) {
    tags.push(
      await payload.create({
        collection: 'tags',
        overrideAccess: true,
        data: { name: `tag ${i}`, note: 'n' },
      }),
    )
  }
  const authors = []
  for (let i = 0; i < 3; i++) {
    authors.push(
      await payload.create({
        collection: 'authors',
        overrideAccess: true,
        data: { favorite: categories[i % 4]!.id, name: `author ${i}` },
      }),
    )
  }
  await payload.update({
    id: authors[0]!.id,
    collection: 'authors',
    overrideAccess: true,
    data: { bestFriend: authors[1]!.id },
  })
  await payload.update({
    id: authors[1]!.id,
    collection: 'authors',
    overrideAccess: true,
    data: { bestFriend: authors[0]!.id },
  })
  const posts = []
  for (let i = 0; i < 6; i++) {
    posts.push(
      await payload.create({
        collection: 'posts',
        overrideAccess: true,
        data: {
          author: authors[i % 2]!.id,
          categories: [categories[i % 4]!.id, categories[(i + 1) % 4]!.id],
          editor: authors[2]!.id,
          items: [{ category: categories[0]!.id }, { category: categories[i % 4]!.id }],
          meta: { reviewer: authors[i % 3]!.id },
          related:
            i % 2 === 0
              ? { relationTo: 'authors', value: authors[1]!.id }
              : { relationTo: 'categories', value: categories[2]!.id },
          relatedMany: [
            { relationTo: 'authors', value: authors[0]!.id },
            { relationTo: 'categories', value: categories[3]!.id },
          ],
          tags: [tags[i % 3]!.id],
          title: `post ${i}`,
        },
      }),
    )
  }
  return { authors, categories, posts, tags }
}

test.suite('fuse-populate', { config: './config.ts' }, () => {
  test('should share one object per related document and depth', async ({ payload }) => {
    await seed(payload)

    const result = await payload.find({
      collection: 'posts',
      overrideAccess: true,
      depth: 1,
      sort: 'title',
    })

    expect(result.docs).toHaveLength(6)
    const [first, , third] = result.docs
    expect(typeof first!.author).toBe('object')
    expect(first!.author).toBe(third!.author)
    expect(first!.items![0]!.category).toBe(third!.items![0]!.category)
  })

  test('should populate depth 2 and 3 like upstream', async ({ payload }) => {
    await seed(payload)

    const depth2 = await payload.find({
      collection: 'posts',
      overrideAccess: true,
      depth: 2,
      sort: 'title',
    })
    const depth3 = await payload.find({
      collection: 'posts',
      overrideAccess: true,
      depth: 3,
      sort: '-title',
    })

    const author = depth2.docs[0]!.author as { bestFriend: { name: string } }
    expect(author.bestFriend.name).toBe('author 1')
    expect(depth3.docs).toHaveLength(6)
  })

  test('should respect maxDepth, defaultPopulate and populate', async ({ payload }) => {
    await seed(payload)

    const result = await payload.find({
      collection: 'posts',
      overrideAccess: true,
      depth: 2,
      limit: 3,
    })
    const selected = await payload.find({
      collection: 'posts',
      overrideAccess: true,
      depth: 1,
      populate: { authors: { name: true } },
    })

    const editor = result.docs[0]!.editor as { favorite: unknown }
    expect(typeof editor.favorite).not.toBe('object')
    expect(Object.keys(result.docs[0]!.tags![0] as object).sort()).toEqual(['id', 'name'])
    expect(Object.keys(selected.docs[0]!.author as object).sort()).toEqual(['id', 'name'])
  })

  test('should populate findByID', async ({ payload }) => {
    const { posts } = await seed(payload)

    const doc = await payload.findByID({
      id: posts[1]!.id,
      collection: 'posts',
      overrideAccess: true,
      depth: 2,
    })

    expect(typeof doc.related!.value).toBe('object')
  })

  test('should keep ids of missing documents and drop trashed ones', async ({ payload }) => {
    const { authors, categories, posts } = await seed(payload)
    await payload.delete({ id: authors[2]!.id, collection: 'authors', overrideAccess: true })
    await payload.update({
      id: categories[1]!.id,
      collection: 'categories',
      overrideAccess: true,
      data: { deletedAt: new Date().toISOString() },
    })

    const doc = await payload.findByID({
      id: posts[0]!.id,
      collection: 'posts',
      overrideAccess: true,
      depth: 1,
    })

    // the id (MongoDB) or `null` (SQL adapters clear the reference)
    expect(doc.editor === null || typeof doc.editor !== 'object').toBe(true)
    expect(doc.categories).toHaveLength(1)
  })

  test('should leave the dataloader primed with the returned objects', async ({ payload }) => {
    await seed(payload)
    const req = await createPayloadRequest({ payload })

    const result = await payload.find({
      collection: 'posts',
      overrideAccess: true,
      depth: 2,
      req,
      sort: 'title',
    })

    const cache = (req.payloadDataLoader as unknown as { _cacheMap: Map<string, Promise<unknown>> })
      ._cacheMap
    expect(cache.size).toBeGreaterThan(0)
    const values = await Promise.all([...cache.values()])
    expect(values).toContain(result.docs[0]!.author)
    expect(req.transactionID).toBeNull()
    expect(req.query.depth).toBeTypeOf('number')
  })
})
