import type { Payload } from 'payload'

import { expect } from 'vitest'

import { test } from '../../__helpers/int/vitest.js'

/**
 * Upstream's behaviour of join fields in reads and population, which the fused lanes reproduce
 * with db-mongodb's join aggregation (FUSE_CONTRACT.md section 9): run with `PAYLOAD_RS_FUSE=shadow`
 * (and `PAYLOAD_RS_FUSE_WRITES=shadow`) every read and write here is also compared with the exact
 * lane.
 */
const seed = async (payload: Payload) => {
  const writers = []
  for (let i = 0; i < 2; i++) {
    writers.push(
      await payload.create({
        collection: 'writers',
        data: { name: `writer ${i}` },
        overrideAccess: true,
      }),
    )
  }
  const editors = []
  for (let i = 0; i < 2; i++) {
    editors.push(
      await payload.create({
        collection: 'editors',
        data: { name: `editor ${i}` },
        overrideAccess: true,
      }),
    )
  }
  const articles = []
  for (let i = 0; i < 5; i++) {
    articles.push(
      await payload.create({
        collection: 'articles',
        data: {
          editor: editors[i % 2]!.id,
          meta: { reviewer: editors[(i + 1) % 2]!.id },
          title: `article ${4 - i}`,
          writer: writers[i < 4 ? 0 : 1]!.id,
        },
        overrideAccess: true,
      }),
    )
  }
  return { articles, editors, writers }
}

test.suite('fuse-populate joins', { config: './joins.config.ts' }, () => {
  test('should populate a relationship to a collection with joins', async ({ payload }) => {
    const { articles, writers } = await seed(payload)

    const article = await payload.findByID({
      id: articles[0]!.id,
      collection: 'articles',
      depth: 2,
      overrideAccess: true,
    })

    expect(article.writer).toMatchObject({ id: writers[0]!.id, name: 'writer 0' })
    const joined = (article.writer as { articles: { docs: string[]; hasNextPage: boolean } })
      .articles
    expect(joined.hasNextPage).toBe(true)
    expect(joined.docs).toHaveLength(3)
    for (const doc of joined.docs) {
      expect(articles.slice(0, 4).map((a) => a.id)).toContain(doc)
    }
  })

  test('should keep join ids past the populate depth', async ({ payload }) => {
    const { articles } = await seed(payload)

    const article = await payload.findByID({
      id: articles[4]!.id,
      collection: 'articles',
      depth: 1,
      overrideAccess: true,
    })

    expect(
      (article.writer as { articles: { docs: unknown[]; hasNextPage: boolean } }).articles,
    ).toStrictEqual({ docs: [articles[4]!.id], hasNextPage: false })
  })

  test('should read a document with joins by id', async ({ payload }) => {
    const { articles, editors } = await seed(payload)

    const editor = await payload.findByID({
      id: editors[0]!.id,
      collection: 'editors',
      depth: 1,
      overrideAccess: true,
    })

    expect(editor.edited?.docs?.map((doc) => (doc as { title: string }).title)).toStrictEqual([
      'article 0',
      'article 2',
      'article 4',
    ])
    expect(editor.reviewed?.docs?.map((doc) => (doc as { id: string }).id).sort()).toStrictEqual(
      [articles[1]!.id, articles[3]!.id].sort(),
    )
  })

  test('should populate joins in finds', async ({ payload }) => {
    await seed(payload)

    const result = await payload.find({
      collection: 'articles',
      depth: 2,
      limit: 10,
      overrideAccess: true,
      sort: 'title',
    })

    expect(result.docs).toHaveLength(5)
    expect(result.docs[0]!.editor).toMatchObject({ name: 'editor 0' })
  })

  test('should write documents whose results populate joins', async ({ payload }) => {
    const { writers } = await seed(payload)

    const created = await payload.create({
      collection: 'articles',
      data: { title: 'fresh', writer: writers[1]!.id },
      depth: 2,
      overrideAccess: true,
    })
    const updated = await payload.update({
      id: created.id,
      collection: 'articles',
      data: { title: 'fresher' },
      depth: 2,
      overrideAccess: true,
    })

    expect((created.writer as { articles: { docs: string[] } }).articles.docs).toContain(created.id)
    expect(updated).toMatchObject({ title: 'fresher', writer: { name: 'writer 1' } })
  })
})
