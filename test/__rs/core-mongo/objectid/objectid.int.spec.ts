/**
 * MongoDB-only inputs for the Rust core engine (operations, field hooks, validators, query
 * validation) on the TS mongoose adapter: ObjectId instances as ids, in `where` (equals / in /
 * contains, `_id` and `id` paths, polymorphic `value`), as relationship data (single, hasMany,
 * polymorphic), ids of the wrong type for custom text / number id collections, geo operators,
 * `_id` / `id` sorts, joins and population, bulk update / delete and per-id operations.
 *
 * Every call's outcome (result or error, with 24-hex ids numbered by first appearance and
 * timestamps normalized) plus what hooks and access saw (`req.context.seen`) is appended to
 * `RS_CORE_MONGO_OUTCOMES` when set: test/__rs/core-mongo/compareOutcomes.mjs compares a TS run
 * with a `PAYLOAD_CORE_ENGINE=rs` run. The same file runs under the core-ops shadow harness
 * (reads) and the core-ops-write trace harness (writes), which compare full event logs.
 */
import type { Payload } from 'payload'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Types } from 'mongoose'

import { test } from '../../../__helpers/int/vitest.js'

type Any = any

const outcomes: string[] = []
const tokens = new Map<string, number>()

const normalize = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => {
    if (typeof v === 'string') {
      if (/^[0-9a-f]{24}$/.test(v)) {
        if (!tokens.has(v)) {
          tokens.set(v, tokens.size)
        }
        return `<oid ${tokens.get(v)}>`
      }
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
        return '<date>'
      }
    }
    return v === undefined ? '<undefined>' : v
  })

const rec = async (label: string, run: (context: Record<string, unknown>) => Promise<unknown>) => {
  const context: Record<string, unknown> = {}
  try {
    const result = await run(context)
    outcomes.push(`${label} ok ${normalize(result)} seen ${normalize(context.seen)}`)
    return result as Any
  } catch (error) {
    const e = error as Any
    outcomes.push(
      `${label} err ${e?.constructor?.name}:${e?.name}:${e?.status}:${e?.message}:${normalize(e?.data)} seen ${normalize(context.seen)}`,
    )
    return undefined
  }
}

const seed = async (payload: Payload) => {
  const ObjectId = Types.ObjectId
  const a1 = await payload.create({ collection: 'authors', data: { name: 'a1' }, overrideAccess: true })
  const a2 = await payload.create({ collection: 'authors', data: { name: 'a2' }, overrideAccess: true })
  const c1 = await payload.create({ collection: 'customs', data: { id: 'c-1', title: 'c1' }, overrideAccess: true })
  const n1 = await payload.create({ collection: 'numbered', data: { id: 7, title: 'n7' }, overrideAccess: true })
  return { a1, a2, c1, n1, ObjectId }
}

test.suite('core engine on MongoDB: ObjectId inputs', { config: './config.ts' }, () => {
  test('should handle ObjectId-shaped inputs in writes and reads', async ({ payload }) => {
    const { a1, a2, ObjectId } = await seed(payload)
    const oid = (id: string) => new ObjectId(id)

    // writes: relationship values as ObjectId instances, hex strings, wrong types
    const p1 = await rec('create oid relations', (context) =>
      payload.create({
        collection: 'posts',
        context,
        overrideAccess: true,
        data: {
          author: oid(a1.id),
          authors: [oid(a1.id), a2.id],
          location: [10, 20],
          num: 1,
          poly: { relationTo: 'authors', value: oid(a2.id) },
          title: 'p1',
        } as Any,
      }),
    )
    const p2 = await rec('create hex relations', (context) =>
      payload.create({
        collection: 'posts',
        context,
        overrideAccess: true,
        data: {
          author: a2.id,
          authors: [a2.id],
          custom: 'c-1',
          location: [11, 21],
          num: 2,
          numbered: 7,
          poly: { relationTo: 'numbered', value: 7 },
          title: 'p2',
        } as Any,
      }),
    )
    await rec('create invalid author string', (context) =>
      payload.create({
        collection: 'posts',
        context,
        overrideAccess: true,
        data: { author: 'not-an-id', num: 3 } as Any,
      }),
    )
    await rec('create numbered as string', (context) =>
      payload.create({ collection: 'posts', context, overrideAccess: true, data: { num: 4, numbered: '7' } as Any }),
    )
    await rec('create numbered NaN', (context) =>
      payload.create({ collection: 'posts', context, overrideAccess: true, data: { num: 5, numbered: NaN } as Any }),
    )
    await rec('create custom as ObjectId', (context) =>
      payload.create({ collection: 'posts', context, overrideAccess: true, data: { custom: oid(a1.id), num: 6 } as Any }),
    )
    await rec('create poly custom ObjectId', (context) =>
      payload.create({
        collection: 'posts',
        context,
        overrideAccess: true,
        data: { num: 7, poly: { relationTo: 'customs', value: oid(a1.id) } } as Any,
      }),
    )
    await rec('create with explicit id', (context) =>
      payload.create({
        collection: 'posts',
        context,
        overrideAccess: true,
        data: { id: new ObjectId().toHexString(), num: 8, title: 'explicit' } as Any,
      }),
    )
    await rec('create author id ObjectId value', (context) =>
      payload.create({ collection: 'authors', context, overrideAccess: true, data: { name: 'a3' } as Any }),
    )

    // reads
    const reads: [string, Record<string, unknown>][] = [
      ['where author equals oid', { where: { author: { equals: oid(a1.id) } } }],
      ['where author in oids', { where: { author: { in: [oid(a1.id), oid(a2.id)] } } }],
      ['where id equals oid', { where: { id: { equals: oid(p1?.id ?? a1.id) } } }],
      ['where _id equals hex', { where: { _id: { equals: p1?.id } } }],
      ['where id in mixed', { where: { id: { in: [oid(p1?.id ?? a1.id), p2?.id] } } }],
      ['where id not_in oid', { where: { id: { not_in: [oid(p1?.id ?? a1.id)] } } }],
      ['where authors contains oid', { where: { authors: { contains: oid(a2.id) } } }],
      ['where authors in oid', { where: { authors: { in: [oid(a2.id)] } } }],
      ['where poly.value equals oid', { where: { 'poly.value': { equals: oid(a2.id) } } }],
      [
        'where poly equals object',
        { where: { poly: { equals: { relationTo: 'authors', value: a2.id } } } },
      ],
      ['where author.name nested', { where: { 'author.name': { equals: 'a1' } } }],
      [
        'where authors contains nested',
        { where: { authors: { contains: { name: { equals: 'a2' } } } } },
      ],
      [
        'where author equals nested object',
        { where: { author: { equals: { name: { equals: 'a1' } } } } },
      ],
      ['where author like oid', { where: { author: { like: oid(a1.id) } } }],
      ['where custom equals', { where: { custom: { equals: 'c-1' } } }],
      ['where numbered equals string', { where: { numbered: { equals: '7' } } }],
      ['where near', { where: { location: { near: [10, 20, 100000, 0] } } }],
      ['where near string', { where: { location: { near: '10,20,100000' } } }],
      [
        'where within',
        {
          where: {
            location: {
              within: {
                type: 'Polygon',
                coordinates: [
                  [
                    [0, 0],
                    [0, 30],
                    [30, 30],
                    [30, 0],
                    [0, 0],
                  ],
                ],
              },
            },
          },
        },
      ],
      [
        'where intersects',
        { where: { location: { intersects: { type: 'Point', coordinates: [10, 20] } } } },
      ],
      ['sort _id', { sort: '_id' }],
      ['sort -id', { sort: '-id' }],
      ['sort author', { sort: 'author' }],
      ['sort localized title', { locale: 'es', sort: 'title' }],
      ['depth 2', { depth: 2 }],
      ['locale all', { locale: 'all' }],
      ['access where oid', { context: { readWhereAuthor: oid(a1.id) }, overrideAccess: false }],
      ['access where hex', { context: { readWhereAuthor: a1.id }, overrideAccess: false }],
      ['select author', { select: { author: true } }],
    ]
    for (const [label, args] of reads) {
      await rec(`find ${label}`, (context) =>
        payload.find({
          collection: 'posts',
          depth: 1,
          overrideAccess: true,
          sort: 'num',
          ...args,
          context: { ...(args.context as object), ...context },
        } as Any),
      )
    }
    await rec('count author oid', (context) =>
      payload.count({ collection: 'posts', context, overrideAccess: true, where: { author: { equals: oid(a1.id) } } }),
    )
    await rec('findDistinct author', (context) =>
      payload.findDistinct({
        collection: 'posts',
        context,
        overrideAccess: true,
        field: 'author',
        sort: 'author',
      } as Any),
    )
    await rec('find authors join', (context) =>
      payload.find({ collection: 'authors', context, overrideAccess: true, depth: 1, sort: 'name' }),
    )
    await rec('find authors join where oid', (context) =>
      payload.find({
        collection: 'authors',
        context,
        overrideAccess: true,
        joins: { posts: { where: { author: { equals: oid(a1.id) } } } },
        sort: 'name',
      } as Any),
    )
    for (const [label, id] of [
      ['oid instance', oid(p1?.id ?? a1.id)],
      ['hex', p1?.id],
      ['invalid string', 'abc'],
      ['number', 5],
      ['unknown hex', new ObjectId().toHexString()],
    ] as [string, unknown][]) {
      await rec(`findByID posts ${label}`, (context) =>
        payload.findByID({ id: id as Any, collection: 'posts', context, overrideAccess: true, depth: 1 }),
      )
    }
    await rec('findByID customs', (context) =>
      payload.findByID({ id: 'c-1', collection: 'customs', context, overrideAccess: true }),
    )
    await rec('findByID numbered string', (context) =>
      payload.findByID({ id: '7' as Any, collection: 'numbered', context, overrideAccess: true }),
    )
    await rec('findByID numbered number', (context) =>
      payload.findByID({ id: 7, collection: 'numbered', context, overrideAccess: true }),
    )

    // updates and deletes
    await rec('updateByID oid instance', (context) =>
      payload.update({
        id: oid(p1?.id ?? a1.id) as Any,
        collection: 'posts',
        context,
        overrideAccess: true,
        data: { author: oid(a2.id) } as Any,
      }),
    )
    await rec('updateByID hex', (context) =>
      payload.update({
        id: p1?.id,
        collection: 'posts',
        context,
        overrideAccess: true,
        data: { authors: [oid(a1.id)], poly: { relationTo: 'authors', value: a1.id } } as Any,
      }),
    )
    await rec('bulk update where author oid', (context) =>
      payload.update({
        collection: 'posts',
        context,
        overrideAccess: true,
        data: { title: 'bulk' } as Any,
        where: { author: { equals: oid(a2.id) } },
      }),
    )
    await rec('bulk update where id in', (context) =>
      payload.update({
        collection: 'posts',
        context,
        overrideAccess: true,
        data: { num: 42 } as Any,
        where: { id: { in: [oid(p1?.id ?? a1.id), p2?.id] } },
      }),
    )
    await rec('duplicate oid', (context) =>
      payload.duplicate({ id: p2?.id, collection: 'posts', context, overrideAccess: true } as Any),
    )
    await rec('deleteByID oid instance', (context) =>
      payload.delete({ id: oid(p2?.id ?? a1.id) as Any, collection: 'posts', context, overrideAccess: true }),
    )
    await rec('bulk delete where author in oids', (context) =>
      payload.delete({
        collection: 'posts',
        context,
        overrideAccess: true,
        where: { author: { in: [oid(a1.id), oid(a2.id)] } },
      }),
    )
    await rec('final posts', (context) =>
      payload.find({ collection: 'posts', context, overrideAccess: true, depth: 0, sort: 'num' }),
    )
  })

  test('should report the outcomes', () => {
    const file = process.env.RS_CORE_MONGO_OUTCOMES
    if (file) {
      fs.writeFileSync(file, JSON.stringify(outcomes, null, 1))
    }
    assert.ok(outcomes.length > 50, `only ${outcomes.length} outcomes recorded`)
  })
})
