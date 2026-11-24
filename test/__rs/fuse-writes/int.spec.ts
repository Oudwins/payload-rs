/**
 * Differential corpus of the fused writes' write-side library (packages/engine-rs/FUSED_WRITES.md
 * section 12): every case runs upstream's `create` / `update` on the TS engine and
 * `fuseWritePrepare` on the same input with the same clock and row id readings; the BSON mongoose
 * sends, the stored document, the caller's data, `req.context` and validation errors must be equal
 * or the library must bail.
 *
 *   PAYLOAD_ENGINE=ts PAYLOAD_DATABASE=mongodb MONGODB_URL='mongodb://.../<db>?...' \
 *     pnpm test:int --config test/__rs/mongo-harness/vitest.config.ts test/__rs/fuse-writes/int.spec.ts
 */
import type { Payload } from 'payload'

import { writeFileSync } from 'node:fs'
import { expect } from 'vitest'

import { test } from '../../__helpers/int/vitest.js'
import { requireTsEngine } from '../requireTsEngine.js'
import { BSON, type CaseResult, ensureMonitoring, runCase } from './harness.js'

requireTsEngine({ file: 'test/__rs/fuse-writes/int.spec.ts' })

type Case = {
  collection: string
  data: Record<string, unknown>
  name: string
  /** A raw stored document (inserted through the driver) or Payload data to create first. */
  seed?: { data?: Record<string, unknown>; raw?: Record<string, unknown> }
  user?: boolean
}

const summary: Record<string, Record<string, number>> = {}
const report: string[] = []

const record = (group: string, name: string, result: CaseResult) => {
  const counts = (summary[group] ??= {})
  const key = result.kind === 'equal' ? `equal:${result.outcome}` : result.kind
  counts[key] = (counts[key] ?? 0) + 1
  if (result.kind === 'bail') {
    report.push(`${group} / ${name}: bail ${result.reason}`)
  }
  if (result.kind === 'diff') {
    report.push(`${group} / ${name}: DIFF\n${result.diffs.join('\n')}`)
  }
}

const fixtures = async (payload: Payload) => {
  const author = await payload.create({
    collection: 'authors',
    data: { name: 'a' },
    overrideAccess: true,
  })
  const author2 = await payload.create({
    collection: 'authors',
    data: { name: 'b' },
    overrideAccess: true,
  })
  const category = await payload.create({
    collection: 'categories',
    data: { title: 'c' },
    overrideAccess: true,
  })
  const category2 = await payload.create({
    collection: 'categories',
    data: { title: 'd' },
    overrideAccess: true,
  })
  const user = await payload.create({
    collection: 'users',
    data: { email: 'fuse@writes.test', password: 'secret' },
    overrideAccess: true,
  })
  return {
    author: String(author.id),
    author2: String(author2.id),
    category: String(category.id),
    category2: String(category2.id),
    user: { ...user, collection: 'users' },
  }
}

type Fixtures = Awaited<ReturnType<typeof fixtures>>

const runAll = async (payload: Payload, group: string, cases: Case[], f: Fixtures) => {
  ensureMonitoring(payload)
  for (const c of cases) {
    let id: string | undefined
    if (c.seed?.data) {
      const seeded = await payload.create({
        collection: c.collection as any,
        data: c.seed.data as any,
        overrideAccess: true,
      })
      id = String(seeded.id)
    } else if (c.seed?.raw) {
      const _id = new BSON.ObjectId()
      await payload.db.connection
        .db!.collection(payload.db.collections[c.collection]!.collection.name)
        .insertOne({ _id, ...c.seed.raw })
      id = _id.toHexString()
    }
    const result = await runCase({
      collection: c.collection,
      data: c.data,
      id,
      payload,
      user: c.user ? f.user : undefined,
    })
    record(group, c.name, result)
  }
}

/** Writes the cumulative report and fails on any difference of `group`. */
const finish = (group: string) => {
  writeFileSync(
    process.env.PAYLOAD_RS_FUSE_WRITES_REPORT ?? '/tmp/fuse-writes-corpus.txt',
    `${JSON.stringify(summary, null, 1)}\n${report.join('\n')}\n`,
  )
  const diffs = report.filter((line) => line.startsWith(`${group} / `) && line.includes(': DIFF'))
  expect(diffs).toEqual([])
}

const minimalCreates = (f: Fixtures): Case[] =>
  [
    { name: 'title only', data: { title: 'a' } },
    { name: 'all fields', data: { title: 'a', views: 5, revision: '7', author: f.author } },
    { name: 'number title', data: { title: 7 } },
    { name: 'padded number string', data: { title: 'x', views: '  12 ' } },
    { name: 'empty number string', data: { title: 'x', views: '' } },
    { name: 'empty relationship', data: { title: 'x', author: '' } },
    { name: 'none relationship', data: { title: 'x', author: 'none' } },
    { name: 'null relationship', data: { title: 'x', author: null } },
    { name: 'invalid relationship', data: { title: 'x', author: 'not-an-id' } },
    { name: 'missing required', data: {} },
    { name: 'empty required', data: { title: '' } },
    { name: 'negative zero', data: { title: 'x', views: -0 } },
    { name: 'double', data: { title: 'x', views: 1.5, revision: 2 ** 31 } },
    { name: 'large integer', data: { title: 'x', views: 2 ** 53 } },
    { name: 'unknown key', data: { title: 'x', extra: 'unknown', nested: { a: 1 } } },
    { name: 'given createdAt', data: { title: 'x', createdAt: '2020-01-01T00:00:00.000Z' } },
    { name: 'given updatedAt', data: { title: 'x', updatedAt: '2020-01-01T00:00:00.000Z' } },
    { name: 'null updatedAt', data: { title: 'x', updatedAt: null } },
    { name: 'date updatedAt', data: { title: 'x', createdAt: new Date(1_600_000_000_000) } },
    { name: 'populated relationship', data: { title: 'x', author: { id: f.author, name: 'a' } } },
    { name: 'undefined values', data: { title: 'x', views: undefined, author: undefined } },
    { name: 'boolean views', data: { title: 'x', views: true } },
    { name: 'object views', data: { title: 'x', views: { $inc: 1 } } },
    { name: 'user', data: { title: 'x' }, user: true },
    {
      name: 'user, createdBy given',
      data: { title: 'x', createdBy: { relationTo: 'users', value: f.author } },
      user: true,
    },
    { name: 'createdBy without user', data: { title: 'x', updatedBy: null } },
    { name: 'id given', data: { id: f.author, title: 'x' } },
    { name: 'dotted key', data: { title: 'x', 'a.b': 1 } },
  ].map((c) => ({ ...c, collection: 'minimal' }))

const minimalUpdates = (f: Fixtures): Case[] =>
  [
    { name: 'title', data: { title: 'b' }, seed: { data: { title: 'a', views: 3 } } },
    { name: 'views string', data: { views: '9' }, seed: { data: { title: 'a' } } },
    {
      name: 'author',
      data: { author: f.author2 },
      seed: { data: { title: 'a', author: f.author } },
    },
    {
      name: 'author null',
      data: { author: null },
      seed: { data: { title: 'a', author: f.author } },
    },
    { name: 'empty data', data: {}, seed: { data: { title: 'a' } } },
    { name: 'clear required', data: { title: '' }, seed: { data: { title: 'a' } } },
    { name: 'user', data: { revision: 1 }, seed: { data: { title: 'a' } }, user: true },
    { name: 'unknown key', data: { title: 'b', other: 1 }, seed: { data: { title: 'a' } } },
    {
      name: 'raw: double views, unknown key, string date',
      data: { revision: 2 },
      seed: {
        raw: {
          title: 'raw',
          views: 5.0,
          unknown: 'kept?',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: new Date(1_500_000_000_000),
        },
      },
    },
    {
      name: 'raw: negative zero and missing fields',
      data: { title: 'b' },
      seed: { raw: { title: 'raw', views: -0 } },
    },
    {
      name: 'raw: string author id',
      data: { views: 1 },
      seed: { raw: { title: 'raw', author: f.author, createdAt: new Date(1_500_000_000_000) } },
    },
  ].map((c) => ({ ...c, collection: 'minimal' }))

let slugs = 0

const typicalDoc = (f: Fixtures) => ({
  title: 'Post',
  views: 10,
  author: f.author,
  slug: `post-${++slugs}`,
  excerpt: 'An excerpt',
  stage: 'published',
  publishedAt: '2024-05-06T07:08:09.000Z',
  featured: true,
  categories: [f.category, f.category2],
  tags: [{ tag: 'one' }, { tag: 'two' }],
  seo: { title: 'SEO', description: 'Desc' },
})

const typicalCreates = (f: Fixtures): Case[] =>
  [
    { name: 'full', data: typicalDoc(f) },
    { name: 'title only', data: { title: 't' } },
    { name: 'checkbox strings', data: { title: 't', featured: 'false' } },
    { name: 'empty checkbox string', data: { title: 't', featured: '' } },
    { name: 'invalid select', data: { title: 't', stage: 'nope' } },
    { name: 'select null', data: { title: 't', stage: null } },
    { name: 'date forms', data: { title: 't', publishedAt: '2024-05-06' } },
    { name: 'date local form', data: { title: 't', publishedAt: '2024-05-06T07:08:09' } },
    { name: 'invalid date', data: { title: 't', publishedAt: 'not a date' } },
    { name: 'date number', data: { title: 't', publishedAt: 1_700_000_000_000 } },
    {
      name: 'categories populated',
      data: { title: 't', categories: [{ id: f.category }, f.category2] },
    },
    { name: 'categories empty string', data: { title: 't', categories: '' } },
    { name: 'categories single string', data: { title: 't', categories: f.category } },
    { name: 'categories with null', data: { title: 't', categories: [f.category, null] } },
    {
      name: 'tags with ids',
      data: { title: 't', tags: [{ id: '64b7f0f0f0f0f0f0f0f0f0f0', tag: 'x' }] },
    },
    { name: 'tags zero', data: { title: 't', tags: 0 } },
    { name: 'tags string', data: { title: 't', tags: 'abc' } },
    { name: 'tags with null row', data: { title: 't', tags: [null, { tag: 'a' }] } },
    { name: 'tag id null', data: { title: 't', tags: [{ id: null, tag: 'a' }] } },
    { name: 'tag numeric id', data: { title: 't', tags: [{ id: 5, tag: 'a' }] } },
    { name: 'tag unknown key', data: { title: 't', tags: [{ tag: 'a', other: 1 }] } },
    { name: 'seo partial', data: { title: 't', seo: { title: 's' } } },
    { name: 'seo string', data: { title: 't', seo: 'x' } },
    { name: 'seo null', data: { title: 't', seo: null } },
    { name: 'seo unknown key', data: { title: 't', seo: { title: 's', z: 1 } } },
    { name: 'user', data: typicalDoc(f), user: true },
  ].map((c) => ({ ...c, collection: 'typical' }))

const typicalUpdates = (f: Fixtures): Case[] =>
  [
    {
      name: 'whole document',
      data: { ...typicalDoc(f), title: 'b' },
      seed: { data: typicalDoc(f) },
    },
    { name: 'scalar', data: { revision: 3 }, seed: { data: typicalDoc(f) } },
    { name: 'relationship', data: { author: f.author2 }, seed: { data: typicalDoc(f) } },
    { name: 'categories', data: { categories: [f.category2] }, seed: { data: typicalDoc(f) } },
    { name: 'tags replaced', data: { tags: [{ tag: 'new' }] }, seed: { data: typicalDoc(f) } },
    { name: 'seo partial', data: { seo: { description: 'd2' } }, seed: { data: typicalDoc(f) } },
    { name: 'invalid stage', data: { stage: 'bad' }, seed: { data: typicalDoc(f) } },
    { name: 'user', data: { title: 'u' }, seed: { data: typicalDoc(f) }, user: true },
    {
      name: 'raw: rows without ids, missing group',
      data: { title: 'b' },
      seed: { raw: { title: 'raw', tags: [{ tag: 'a' }], featured: 'yes' } },
    },
    {
      name: 'raw: unknown keys everywhere',
      data: { views: 2 },
      seed: {
        raw: {
          title: 'raw',
          seo: { title: 's', junk: 1 },
          tags: [{ id: 'x1', tag: 'a', junk: 2 }],
          junk: { deep: true },
        },
      },
    },
  ].map((c) => ({ ...c, collection: 'typical' }))

const kindsCreates = (f: Fixtures): Case[] =>
  [
    { name: 'defaults only', data: {} },
    { name: 'text too long', data: { text: 'x'.repeat(11) } },
    { name: 'text too short', data: { text: 'x' } },
    { name: 'texts too many', data: { texts: ['a', 'b', 'c', 'd'] } },
    { name: 'texts', data: { texts: ['a', 'b'] } },
    { name: 'textarea long', data: { textarea: 'y'.repeat(21) } },
    { name: 'email invalid', data: { email: 'nope' } },
    { name: 'email', data: { email: 'a@b.co' } },
    { name: 'number over max', data: { number: 101 } },
    { name: 'number under min', data: { number: -101 } },
    { name: 'number ok', data: { number: 50, numbers: [1, 2.5, -0] } },
    { name: 'numbers empty', data: { numbers: [] } },
    { name: 'numbers strings', data: { numbers: ['1', '2'] } },
    { name: 'checkbox true string', data: { checkbox: 'true' } },
    { name: 'checkbox yes', data: { checkbox: 'yes' } },
    { name: 'date', data: { date: '2020-02-03T04:05:06.007Z' } },
    { name: 'select', data: { select: 'c', selects: ['a', 'b'] } },
    { name: 'select invalid', data: { select: 'z' } },
    { name: 'selects duplicates', data: { selects: ['a', 'a'] } },
    { name: 'rel', data: { rel: f.author, rels: [f.category] } },
    { name: 'poly', data: { poly: { relationTo: 'authors', value: f.author } } },
    { name: 'poly categories', data: { poly: { relationTo: 'categories', value: f.category } } },
    {
      name: 'polys',
      data: {
        polys: [
          { relationTo: 'authors', value: f.author },
          { relationTo: 'categories', value: { id: f.category } },
        ],
      },
    },
    { name: 'polys single object', data: { polys: { relationTo: 'authors', value: f.author } } },
    { name: 'group', data: { group: { a: 'x', n: 2, inner: { deep: 'd' } } } },
    { name: 'group empty', data: { group: {} } },
    {
      name: 'rows',
      data: {
        rows: [
          { label: 'r1', children: [{ name: 'c1' }, { name: 'c2' }] },
          { label: 'r2', count: 3, meta: { note: 'n' } },
        ],
      },
    },
    { name: 'rows missing label', data: { rows: [{ count: 2 }] } },
    {
      name: 'rows too many',
      data: {
        rows: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }, { label: 'e' }],
      },
    },
    { name: 'row and collapsible', data: { inRow: 'r', inCollapsible: 9, inTab: true } },
    {
      name: 'errors everywhere',
      data: { text: 'x', number: 1000, select: 'q', rows: [{}], email: 'x' },
    },
    { name: 'textRequired cleared', data: { textRequired: '' } },
  ].map((c) => ({ ...c, collection: 'kinds' }))

const kindsUpdates = (f: Fixtures): Case[] =>
  [
    {
      name: 'rows kept by id',
      data: { rows: [{ label: 'changed' }] },
      seed: { data: { rows: [{ label: 'r1', children: [{ name: 'c' }] }] } },
    },
    {
      name: 'group partial',
      data: { group: { n: 5 } },
      seed: { data: { group: { a: 'x', inner: { deep: 'd' } } } },
    },
    {
      name: 'poly change',
      data: { poly: { relationTo: 'categories', value: f.category } },
      seed: { data: { poly: { relationTo: 'authors', value: f.author } } },
    },
    { name: 'numbers', data: { numbers: [9] }, seed: { data: { numbers: [1, 2] } } },
    {
      name: 'raw: group as string, rows null',
      data: { text: 'ok' },
      seed: { raw: { group: 'str', rows: null, numbers: [1] } },
    },
  ].map((c) => ({ ...c, collection: 'kinds' }))

test.suite('fused writes: write-side corpus', { config: './config.ts' }, () => {
  test('minimal creates', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'minimal create', minimalCreates(f), f)
    finish('minimal create')
  })

  test('minimal updates', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'minimal update', minimalUpdates(f), f)
    finish('minimal update')
  })

  test('typical creates', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'typical create', typicalCreates(f), f)
    finish('typical create')
  })

  test('typical updates', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'typical update', typicalUpdates(f), f)
    finish('typical update')
  })

  test('kinds creates', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'kinds create', kindsCreates(f), f)
    finish('kinds create')
  })

  test('kinds updates', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'kinds update', kindsUpdates(f), f)
    finish('kinds update')
  })
})
