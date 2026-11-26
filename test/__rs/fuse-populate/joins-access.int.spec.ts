import type { Payload } from 'payload'

import { expect } from 'vitest'

import { fuseStats } from '../../../packages/engine-rs/src/fuse/index.js'
import { test } from '../../__helpers/int/vitest.js'

/** Whether the fused lanes run in this process (the Rust engine with them on). */
const isFused = () => process.env.PAYLOAD_ENGINE !== 'ts' && process.env.PAYLOAD_RS_FUSE !== 'off'

const total = (counts: Record<string, number> | undefined) =>
  Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0)

/** Enough calls for the compiled access functions to pass guard mode's first verified calls. */
const rounds = 40

type Join = { docs: unknown[]; hasNextPage: boolean; totalDocs?: number }

/**
 * Join fields read without `overrideAccess` (the joined collection's read access combined into
 * the join's `$match`), finds of collections with joins (`aggregatePaginate`'s result meta), join
 * queries with values and localized joins (FUSE_CONTRACT.md section 8). Run with
 * `PAYLOAD_RS_FUSE=shadow` every read here is also compared with the exact lane.
 */
const seed = async (payload: Payload) => {
  const shelves = []
  for (const name of ['first', 'second']) {
    shelves.push(
      await payload.create({ collection: 'shelves', data: { name }, overrideAccess: true }),
    )
  }
  const books = []
  for (let i = 0; i < 5; i++) {
    books.push(
      await payload.create({
        collection: 'books',
        data: {
          localShelf: shelves[1]!.id,
          shelf: shelves[i < 4 ? 0 : 1]!.id,
          status: i % 2 === 0 ? 'published' : 'draft',
          title: `book ${i}`,
        },
        overrideAccess: true,
      }),
    )
  }
  await payload.update({
    id: books[0]!.id,
    collection: 'books',
    data: { localShelf: shelves[0]!.id },
    locale: 'de',
    overrideAccess: true,
  })
  await payload.create({
    collection: 'secrets',
    data: { note: 'secret', shelf: shelves[0]!.id },
    overrideAccess: true,
  })
  const user = await payload.create({
    collection: 'users',
    data: { email: 'reader@payloadcms.com', password: 'test' },
    overrideAccess: true,
  })
  return { books, shelves, user }
}

const published = (books: { id: number | string; status?: null | string }[]) =>
  books.filter((book) => book.status === 'published').map((book) => book.id)

test.suite('fuse-populate joins access', { config: './joins-access.config.ts' }, () => {
  test('should populate joins with the joined collection access without overrideAccess', async ({
    payload,
  }) => {
    const { books, shelves, user } = await seed(payload)
    const populatedBefore = fuseStats.populated.find ?? 0

    for (let i = 0; i < rounds; i++) {
      // depth 3: the join's documents load, with `books`' where constraint
      const anonymous = await payload.find({ collection: 'books', depth: 3, overrideAccess: false })
      const signedIn = await payload.find({
        collection: 'books',
        depth: 2,
        overrideAccess: false,
        user,
      })

      expect(anonymous.docs.map((book) => book.id).sort()).toEqual(published(books).sort())
      const shelf = anonymous.docs.find((book) => book.title === 'book 0')!.shelf as {
        books: Join
        secrets?: Join
      }
      expect(shelf.books.docs.map((doc) => (doc as { id: string }).id).sort()).toEqual(
        published(books.slice(0, 4)).sort(),
      )
      expect(shelf.secrets).toBeUndefined()
      expect(signedIn.docs).toHaveLength(5)
      const signedInShelf = signedIn.docs.find((book) => book.title === 'book 1')!.shelf as {
        books: Join
        secrets: Join
      }
      expect(signedInShelf.books.docs).toHaveLength(3)
      expect(signedInShelf.books.hasNextPage).toBe(true)
      expect(signedInShelf.secrets.docs).toHaveLength(1)
      expect(shelves[0]!.id).toBe((signedInShelf as unknown as { id: string }).id)
    }

    if (isFused()) {
      expect((fuseStats.populated.find ?? 0) - populatedBefore).toBeGreaterThan(rounds)
    }
  })

  test('should read collections with joins over REST', async ({ payload, restClient }) => {
    const { books, shelves } = await seed(payload)
    const hitsBefore = total(fuseStats.hits)

    for (let i = 0; i < rounds; i++) {
      const byID = await (await restClient.GET(`/shelves/${shelves[0]!.id}`)).json()
      const page = await (await restClient.GET('/shelves?limit=1&page=2')).json()
      const populated = await (await restClient.GET('/books?depth=2&limit=2')).json()

      expect(byID.books.docs.map((doc: { id: string }) => doc.id).sort()).toEqual(
        published(books.slice(0, 4)).sort(),
      )
      expect(byID.secrets).toBeUndefined()
      expect(page).toMatchObject({
        hasNextPage: false,
        hasPrevPage: true,
        limit: 1,
        nextPage: null,
        page: 2,
        pagingCounter: 2,
        prevPage: 1,
        totalDocs: 2,
        totalPages: 2,
      })
      expect(page.docs[0].id).toBe(shelves[0]!.id)
      expect(populated.docs.map((book: { title: string }) => book.title)).toEqual([
        'book 4',
        'book 2',
      ])
      expect(populated.docs[1].shelf.books.docs).toHaveLength(2)
    }

    if (isFused()) {
      expect(total(fuseStats.hits) - hitsBefore).toBeGreaterThan(rounds)
    }
  })

  test('should apply the join query to the caller joins like upstream', async ({ payload }) => {
    const { shelves } = await seed(payload)

    for (let i = 0; i < rounds; i++) {
      const joins = {}
      await payload.findByID({
        id: shelves[0]!.id,
        collection: 'shelves',
        joins,
        overrideAccess: false,
      })

      const where = { and: [{}, { status: { equals: 'published' } }] }
      expect(joins).toStrictEqual({
        books: { where },
        localBooks: { where },
        secrets: false,
        translated: { where },
      })
      expect(Object.keys(joins)).toEqual(['books', 'translated', 'localBooks', 'secrets'])
    }
  })

  test('should read join queries with limit, sort, page, count and where', async ({ payload }) => {
    const { books, shelves } = await seed(payload)
    const hitsBefore = total(fuseStats.hits)

    for (let i = 0; i < rounds; i++) {
      const shelf = await payload.findByID({
        id: shelves[0]!.id,
        collection: 'shelves',
        depth: 0,
        joins: {
          books: { count: true, limit: 1, page: 2, sort: '-title' },
          secrets: false,
          translated: { limit: 0, where: { status: { equals: 'published' } } },
        },
        overrideAccess: true,
      })
      const found = await payload.find({
        collection: 'shelves',
        depth: 1,
        joins: { books: { limit: 2, sort: 'title' } },
        limit: 0,
        overrideAccess: true,
        sort: 'name',
      })

      expect(shelf.books).toStrictEqual({ docs: [books[2]!.id], hasNextPage: true, totalDocs: 4 })
      expect(shelf.secrets).toBeUndefined()
      expect(found.totalDocs).toBe(2)
      expect(found.pagingCounter).toBe(1)
      expect(
        (found.docs[0]!.books as Join).docs.map((doc) => (doc as { title: string }).title),
      ).toEqual(['book 0', 'book 1'])
    }

    if (isFused()) {
      expect(total(fuseStats.hits) - hitsBefore).toBeGreaterThan(rounds)
    }
  })

  test('should read localized joins', async ({ payload }) => {
    const { books, shelves } = await seed(payload)
    const hitsBefore = total(fuseStats.hits)

    for (let i = 0; i < rounds; i++) {
      const en = await payload.findByID({
        id: shelves[1]!.id,
        collection: 'shelves',
        depth: 0,
        overrideAccess: true,
      })
      const de = await payload.findByID({
        id: shelves[0]!.id,
        collection: 'shelves',
        depth: 0,
        locale: 'de',
        overrideAccess: true,
      })

      expect(en.translated?.docs).toHaveLength(5)
      expect(en.localBooks?.docs).toEqual([books[4]!.id])
      expect(de.translated?.docs).toEqual([books[0]!.id])
      expect(de.localBooks?.docs).toHaveLength(4)
    }

    if (isFused()) {
      expect(total(fuseStats.hits) - hitsBefore).toBeGreaterThan(rounds)
    }
  })
})
