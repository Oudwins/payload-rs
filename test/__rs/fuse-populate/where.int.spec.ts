import type { Payload, Where } from 'payload'

import { expect } from 'vitest'

import { fuseStats } from '../../../packages/engine-rs/src/fuse/index.js'
import { test } from '../../__helpers/int/vitest.js'

/**
 * Relationship-path `where` constraints (db-mongodb `buildSearchParam`'s sub-query of the related
 * collection, then `$in` of its ids), which the fused MongoDB read lane runs natively
 * (FUSE_CONTRACT.md section 8). Run with `PAYLOAD_RS_FUSE=shadow` (the runners' `--fuse shadow`)
 * every read is also compared with the exact lane, including the driver commands of the
 * sub-queries. The expected results come from the seed, so the spec holds on every engine.
 */
const seed = async (payload: Payload) => {
  const create = (collection: 'authors' | 'categories' | 'posts', data: Record<string, unknown>) =>
    payload.create({ collection, data, overrideAccess: true })
  const categories = []
  for (const title of ['news', 'sport', 'travel']) {
    categories.push(await create('categories', { title }))
  }
  const ada = await create('authors', { favorite: categories[0]!.id, name: 'ada lovelace' })
  const alan = await create('authors', { bestFriend: ada.id, name: 'alan turing' })
  const grace = await create('authors', { bestFriend: alan.id, name: 'grace hopper' })
  const authors = [ada, alan, grace]
  for (let i = 0; i < 6; i++) {
    await create('posts', {
      author: authors[i % 3]!.id,
      categories: [categories[i % 3]!.id],
      items: [{ category: categories[(i + 1) % 3]!.id }],
      meta: { reviewer: authors[(i + 1) % 3]!.id },
      related:
        i % 2 === 0
          ? { relationTo: 'authors', value: authors[0]!.id }
          : { relationTo: 'categories', value: categories[1]!.id },
      title: `post ${i}`,
    })
  }
  return { authors, categories }
}

const titles = async (payload: Payload, where: Where, collection: 'authors' | 'posts' = 'posts') =>
  (
    await payload.find({
      collection,
      depth: 0,
      overrideAccess: true,
      pagination: false,
      sort: collection === 'posts' ? 'title' : 'name',
      where,
    })
  ).docs.map((doc) => ('title' in doc ? doc.title : doc.name))

const isFusedMongo = (payload: Payload) =>
  process.env.PAYLOAD_ENGINE !== 'ts' &&
  process.env.PAYLOAD_RS_FUSE !== 'off' &&
  payload.db.name === 'mongoose'

const relationshipPathGuards = () => fuseStats.guards['mongo:where:relationship-path'] ?? 0
const total = (counts: Record<string, number>) =>
  Object.values(counts).reduce((sum, n) => sum + n, 0)

test.suite('fuse-populate where', { config: './config.ts' }, () => {
  test('should query through a relationship', async ({ payload }) => {
    await seed(payload)
    const guardsBefore = relationshipPathGuards()
    const hitsBefore = total(fuseStats.hits)

    const byName = await titles(payload, { 'author.name': { equals: 'alan turing' } })
    const byLike = await titles(payload, { 'author.name': { like: 'hopper' } })
    const none = await titles(payload, { 'author.name': { equals: 'nobody' } })

    expect(byName).toEqual(['post 1', 'post 4'])
    expect(byLike).toEqual(['post 2', 'post 5'])
    expect(none).toEqual([])
    if (isFusedMongo(payload)) {
      expect(relationshipPathGuards()).toBe(guardsBefore)
      expect(total(fuseStats.hits) - hitsBefore).toBeGreaterThanOrEqual(3)
    }
  })

  test('should query through hasMany, group and array relationships', async ({ payload }) => {
    await seed(payload)

    const hasMany = await titles(payload, { 'categories.title': { equals: 'sport' } })
    const inGroup = await titles(payload, { 'meta.reviewer.name': { like: 'ada' } })
    const inArray = await titles(payload, { 'items.category.title': { in: ['news', 'travel'] } })

    expect(hasMany).toEqual(['post 1', 'post 4'])
    expect(inGroup).toEqual(['post 2', 'post 5'])
    expect(inArray).toEqual(['post 1', 'post 2', 'post 4', 'post 5'])
  })

  test('should combine relationship paths with and / or', async ({ payload }) => {
    await seed(payload)

    const both = await titles(payload, {
      and: [
        { or: [{ title: { equals: 'post 0' } }, { 'author.name': { like: 'grace' } }] },
        { 'categories.title': { not_equals: 'travel' } },
      ],
    })
    const twoOperators = await titles(payload, {
      'author.name': { like: 'a', not_equals: 'ada lovelace' },
    })
    const samePathTwice = await titles(payload, {
      and: [{ 'author.name': { like: 'a' } }, { 'author.name': { like: 'turing' } }],
    })

    expect(both).toEqual(['post 0'])
    expect(twoOperators).toEqual(['post 1', 'post 2', 'post 4', 'post 5'])
    expect(samePathTwice).toEqual(['post 1', 'post 4'])
  })

  test('should paginate and count with a relationship path', async ({ payload }) => {
    await seed(payload)
    const where: Where = { 'author.name': { not_equals: 'ada lovelace' } }

    const page = await payload.find({
      collection: 'posts',
      depth: 0,
      limit: 3,
      overrideAccess: true,
      page: 2,
      sort: 'title',
      where,
    })
    const { totalDocs } = await payload.count({ collection: 'posts', overrideAccess: true, where })

    expect(page.docs.map((doc) => doc.title)).toEqual(['post 5'])
    expect(page.totalDocs).toBe(4)
    expect(page.hasPrevPage).toBe(true)
    expect(totalDocs).toBe(4)
  })

  test('should query a self relationship and populate the results', async ({ payload }) => {
    await seed(payload)

    const names = await titles(payload, { 'bestFriend.name': { like: 'ada' } }, 'authors')
    const populated = await payload.find({
      collection: 'posts',
      depth: 1,
      overrideAccess: true,
      sort: 'title',
      where: { 'author.name': { equals: 'ada lovelace' } },
    })

    expect(names).toEqual(['alan turing'])
    expect(populated.docs.map((doc) => doc.author?.name)).toEqual(['ada lovelace', 'ada lovelace'])
  })

  test('should keep upstream semantics outside one hop', async ({ payload }) => {
    await seed(payload)

    // `exists` through a relationship builds no constraint (upstream's `rawQuery` needs one path)
    const exists = await titles(payload, { 'author.name': { exists: false } })
    // two hops: the sub-queries depend on each other
    const twoHops = await titles(payload, { 'author.favorite.title': { equals: 'news' } })
    const polymorphic = await titles(payload, { 'related.relationTo': { equals: 'categories' } })

    expect(exists).toHaveLength(6)
    expect(twoHops).toEqual(['post 0', 'post 3'])
    expect(polymorphic).toEqual(['post 1', 'post 3', 'post 5'])
  })
})
