/**
 * Targeted find differential checks (see ../../harness.ts): every query below is replayed through
 * the Rust port and compared exactly; these tests also assert the TS behaviour they rely on and
 * that the comparison ran without a difference.
 */
import type { PayloadRequest } from 'payload'

import { commitTransaction, initTransaction } from 'payload'
import { expect, vi } from 'vitest'

import { sql } from '../../../../../packages/drizzle/node_modules/drizzle-orm/index.js'
import { test } from '../../../../__helpers/int/vitest.js'
import { getMismatchCount, installFindHarness, stats } from '../../harness.js'
import { categoriesSlug, postsSlug, profilesTable } from './config.js'

vi.mock('../../../../../packages/drizzle/src/find/buildFindManyArgs.js', async (importOriginal) => {
  const mod = await importOriginal<any>()
  const { wrapBuildFindManyArgs } = await import('../../bridge.js')
  return { ...mod, buildFindManyArgs: wrapBuildFindManyArgs(mod.buildFindManyArgs) }
})

vi.mock('../../../../../packages/drizzle/src/find/findMany.js', async (importOriginal) => {
  const mod = await importOriginal<any>()
  const { wrapFindMany } = await import('../../bridge.js')
  return { ...mod, findMany: wrapFindMany(mod.findMany) }
})

installFindHarness('drizzle-columns', { hasSchemaExtensions: true })

const findManyStats = () => stats.findMany as { rustRan: number }

/** Runs `fn` and checks that Rust compared at least the given number of calls without a difference. */
const compared = async <T,>(
  { findMany = 0, rqb = 0 }: { findMany?: number; rqb?: number },
  fn: () => Promise<T>,
): Promise<T> => {
  const before = {
    findMany: findManyStats().rustRan,
    mismatches: getMismatchCount(),
    rqb: stats.rqb.rustRan,
  }
  const result = await fn()
  expect(getMismatchCount(), JSON.stringify(stats.mismatches.slice(-3))).toBe(before.mismatches)
  expect(stats.rqb.rustRan - before.rqb).toBeGreaterThanOrEqual(rqb)
  expect(findManyStats().rustRan - before.findMany).toBeGreaterThanOrEqual(findMany)
  return result
}

const run = (payload: any, raw: string) => payload.db.execute({ drizzle: payload.db.drizzle, raw })

test.suite('rs find: drizzle columns, relations and connections', { config: './config.ts' }, () => {
  test('should decode afterSchemaInit column modes like drizzle', async ({ payload }) => {
    const a = await payload.create({ collection: postsSlug, data: { title: 'a' } })
    const b = await payload.create({ collection: postsSlug, data: { title: 'b' } })
    await payload.create({ collection: postsSlug, data: { title: 'nulls' } })

    await run(
      payload,
      `UPDATE posts SET when_sec = 1700000000, when_ms = 1700000000123, is_on = 1,
         blob_buf = X'00ff10', blob_json = CAST('{"a":[1,2.5],"$date":"x"}' AS BLOB),
         blob_big = CAST('12345678901234567890' AS BLOB), num_big = '1234567890123456789',
         num_str = 1.5, real_val = 2.25, custom_val = 'x', custom_plain = 7 WHERE id = ${a.id}`,
    )
    // Values whose storage class differs from the column mode (text in integer / blob columns).
    await run(
      payload,
      `UPDATE posts SET when_sec = '12', when_ms = '2024-01-02T03:04:05Z', is_on = 'yes',
         blob_buf = 'abc', blob_json = '{"t":1}', blob_big = '42', num_big = 7, num_str = 'abc',
         real_val = 'x', custom_val = 5 WHERE id = ${b.id}`,
    )

    const rows = await compared({ rqb: 1 }, () =>
      payload.db.drizzle.query.posts.findMany({ orderBy: (t: any, { asc }: any) => asc(t.id) }),
    )

    expect(rows[0].whenSec).toBeInstanceOf(Date)
    expect(rows[0].whenMs.getTime()).toBe(1700000000123)
    expect(rows[0].isOn).toBe(true)
    expect(Buffer.isBuffer(rows[0].blobBuf)).toBe(true)
    expect(rows[0].blobJson).toEqual({ $date: 'x', a: [1, 2.5] })
    expect(rows[0].blobBig).toBe(12345678901234567890n)
    expect(rows[0].numBig).toBe(1234567890123456789n)
    expect(rows[0].custom).toBe('custom:x:string')
    expect(rows[1].whenMs).toBeInstanceOf(Date)
    expect(rows[2].whenSec).toBeNull()
    expect(stats.hostCalls).toBeGreaterThan(0)

    await compared({ findMany: 1, rqb: 1 }, () =>
      payload.find({ collection: postsSlug, sort: 'createdAt' }),
    )

    // A REAL in a bigint numeric column reads as '9.87654321098765e+19': BigInt() throws.
    await run(payload, `UPDATE posts SET num_big = '98765432109876543210' WHERE id = ${a.id}`)
    const bigintError = await compared({ rqb: 1 }, () =>
      payload.db.drizzle.query.posts.findMany({ columns: { numBig: true } }).catch((e: any) => e),
    )
    expect(bigintError).toBeInstanceOf(SyntaxError)
  })

  test('should select numeric bigint sort columns as text in select distinct', async ({
    payload,
  }) => {
    const category = await payload.create({ collection: categoriesSlug, data: { name: 'c' } })
    for (const rank of [3, 1, 2]) {
      await payload.create({
        collection: postsSlug,
        data: { category: category.id, rank, title: `rank ${rank}` },
      })
    }
    // `select` keeps `rank` out of the relational query: only the select distinct reads it
    const find = () =>
      payload.db.find({
        collection: postsSlug,
        select: { title: true },
        sort: 'rank',
        where: { 'category.name': { equals: 'c' } },
      })

    // sort + join: findMany selects the distinct ids together with the sort column, which drizzle
    // selects as `cast("posts"."rank" as text)` and maps with BigInt()
    const result = await compared({ findMany: 1 }, find)
    expect(result.docs.map((doc: any) => doc.title)).toEqual(['rank 1', 'rank 2', 'rank 3'])

    // a REAL in the column reads as '1.23456789012346e+19': mapping the selected (otherwise
    // unused) sort column throws
    await run(payload, `UPDATE posts SET rank = '12345678901234567890' WHERE title = 'rank 2'`)
    const error = await compared({ findMany: 1 }, () => find().catch((e: unknown) => e))
    expect(error).toBeInstanceOf(SyntaxError)
  })

  test('should map a reverse one-to-one relation to an object or null', async ({ payload }) => {
    const a = await payload.create({ collection: postsSlug, data: { title: 'with profile' } })
    await payload.create({ collection: postsSlug, data: { title: 'without profile' } })
    await run(payload, `INSERT INTO ${profilesTable} (bio, post_id) VALUES (7, ${a.id})`)

    try {
      const posts = await compared({ rqb: 1 }, () =>
        payload.db.drizzle.query.posts.findMany({
          columns: { id: true },
          orderBy: (t: any, { asc }: any) => asc(t.id),
          with: { profile: true },
        }),
      )

      expect(posts[0].profile).toMatchObject({ bio: '7', postId: a.id })
      expect(posts[1].profile).toBeNull()

      await compared({ rqb: 1 }, () =>
        payload.db.drizzle.query[profilesTable].findMany({ with: { post: { columns: { id: true } } } }),
      )
    } finally {
      await run(payload, `DELETE FROM ${profilesTable}`)
    }
  })

  test('should return undefined from an empty findFirst', async ({ payload }) => {
    const post = await payload.create({ collection: postsSlug, data: { title: 'first' } })

    const missing = await compared({ rqb: 1 }, () =>
      payload.db.drizzle.query.posts.findFirst({ where: (t: any, { eq }: any) => eq(t.id, -1) }),
    )
    const found = await compared({ rqb: 1 }, () =>
      payload.db.drizzle.query.posts.findFirst({
        columns: { title: true },
        where: (t: any, { eq }: any) => eq(t.id, post.id),
      }),
    )

    expect(missing).toBeUndefined()
    expect(found).toEqual({ title: 'first' })
  })

  test('should handle malformed polymorphic join filters like TS', async ({ payload }) => {
    const category = await payload.create({ collection: categoriesSlug, data: { name: 'c' } })
    await payload.create({ collection: postsSlug, data: { category: category.id, title: 'ab' } })

    const filters: unknown[] = [
      { title: null },
      { title: undefined },
      { title: 'ab' },
      { title: ['x'] },
      { title: 5 },
      { title: true },
      'title',
      ['x'],
      { and: 'x' },
      { or: [null, { title: { equals: 'ab' } }] },
      { title: { equals: 'ab' } },
    ]
    const outcomes: string[] = []
    for (const where of filters) {
      const outcome = await compared({ findMany: 1 }, () =>
        payload.db
          .find({ collection: categoriesSlug, joins: { relatedDocs: { where } } } as any)
          .then(
            () => 'ok',
            (err: Error) => `${err.name}: ${err.message}`,
          ),
      )
      outcomes.push(outcome)
    }

    expect(outcomes[0]).toBe('TypeError: Cannot convert undefined or null to object')
    expect(outcomes[1]).toBe('TypeError: Cannot convert undefined or null to object')
    expect(outcomes.at(-1)).toBe('ok')
  })

  // Needs the shared payload-sqlite client: with the real libsql client (PAYLOAD_SQLITE_CLIENT=libsql)
  // Rust reads through its own connection and cannot see the open transaction.
  const sharedConnectionTest = process.env.PAYLOAD_SQLITE_CLIENT === 'libsql' ? test.skip : test

  sharedConnectionTest('should read uncommitted rows of the request transaction', async ({ payload }) => {
    const req = { payload } as PayloadRequest
    await initTransaction(req)
    expect(req.transactionID).toBeDefined()

    const before = stats.connections.transaction
    for (const title of ['t1', 't2', 't3']) {
      await payload.create({ collection: postsSlug, data: { title }, req })
    }

    let inTransaction: any
    let outside: any
    try {
      inTransaction = await compared({ findMany: 1 }, () =>
        payload.find({ collection: postsSlug, req, sort: 'title' }),
      )
      outside = await compared({ findMany: 1 }, () => payload.find({ collection: postsSlug }))
    } finally {
      await commitTransaction(req)
    }

    expect(inTransaction.docs.map((d: any) => d.title)).toEqual(['t1', 't2', 't3'])
    expect(outside.totalDocs).toBe(0)
    if (stats.connections.shared > 0) {
      expect(stats.connections.transaction).toBeGreaterThan(before)
    }

    const after = await compared({ findMany: 1 }, () => payload.find({ collection: postsSlug }))
    expect(after.totalDocs).toBe(3)
  })

  test('should wrap driver errors in DrizzleQueryError like drizzle', async ({ payload }) => {
    const post = await payload.create({ collection: postsSlug, data: { title: 'e' } })
    const before = stats.drizzleQueryErrors

    const sqliteError = await compared({ rqb: 1 }, () =>
      payload.db.drizzle.query.posts.findMany({ where: sql`no_such_column = ${1}` }).catch((e: any) => e),
    )
    expect(sqliteError.constructor.name).toBe('DrizzleQueryError')
    expect(sqliteError.cause?.name).toBe('LibsqlError')

    await run(payload, `UPDATE posts SET custom_plain = 9007199254740993 WHERE id = ${post.id}`)
    const rangeError = await compared({ findMany: 1, rqb: 1 }, () =>
      payload.find({ collection: postsSlug }).catch((e: any) => e),
    )
    expect(rangeError.constructor.name).toBe('DrizzleQueryError')
    expect(rangeError.cause).toBeInstanceOf(RangeError)

    expect(stats.drizzleQueryErrors - before).toBeGreaterThanOrEqual(2)
  })
})
