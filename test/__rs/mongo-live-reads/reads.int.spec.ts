/**
 * Live differential of the Mongo read methods: upstream TS (`payload.db.<method>`, db-mongodb as
 * shipped) vs the Rust live engine (crates/payload-mongo-live via `mongoLiveBinding()`), on the
 * same live inputs. See recorder.ts for what a run records. Every case runs
 *
 * - `real`: against MongoDB through spied models (property reads/writes on args/adapter, model calls
 *   and their argument snapshots, results, identity structure, final argument state), and
 * - `tape`: against a tape of the TS run's model results (or a synthetic tape) with a microtask
 *   pump, so every event is also compared by tick (await points, Promise.all, settle order).
 *
 * Guards: zero compared cases, a TS reference that never ran upstream code, Rust runs that never
 * entered the engine, tape mismatches and self-comparison all fail; negative controls (an extra
 * tick, an extra read, a different model argument, a tampered result) must be detected.
 *
 *   PAYLOAD_DATABASE=mongodb PAYLOAD_ENGINE_ADDON=/tmp/livereads-addon/payload-engine.node \
 *   MONGODB_URL='mongodb://payload:payload@localhost:27018/livereads_1?authSource=admin&directConnection=true&replicaSet=rs0' \
 *     pnpm test:int --config test/__rs/mongo-harness/vitest.config.ts test/__rs/mongo-live-reads/reads.int.spec.ts
 */
import type { Payload } from 'payload'

import { expect } from 'vitest'

import { aggregatePaginate as upstreamAggregatePaginate } from '../../../packages/db-mongodb/src/utilities/aggregatePaginate.js'
import {
  getCollection as upstreamGetCollection,
  getGlobal as upstreamGetGlobal,
} from '../../../packages/db-mongodb/src/utilities/getEntity.js'
import { getSession as upstreamGetSession } from '../../../packages/db-mongodb/src/utilities/getSession.js'
import { isObjectID as upstreamIsObjectID } from '../../../packages/db-mongodb/src/utilities/isObjectID.js'
import {
  getMongoLive,
  type MongoLiveReadMethod,
} from '../../../packages/engine-rs/src/mongo-live/index.js'
import { getCoreRuntime } from '../../../packages/engine-rs/src/runtime/index.js'
import { test } from '../../__helpers/int/vitest.js'
import { initLivePorts, portsMode } from './ports.js'
import { adapterView, firstDifference, Run, startPump, Tape, type TapeEntry } from './recorder.js'
import { categoriesSlug, draftsSlug, postsSlug, settingsSlug, sortedSlug } from './shared.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

type Seed = Awaited<ReturnType<typeof seed>>

type Ctx = {
  adapter: Any
  local: Record<string, Any>
  run: Run
  seed: Seed
  userErrors: unknown[]
}

type Mode = 'real' | 'tape'

type Case = {
  afterStart?: (ctx: Ctx, args: Any) => void
  args: (ctx: Ctx) => Any
  /** runs before each run; its return runs after it and reports extra state (then restores it) */
  around?: (payload: Payload) => () => unknown
  method: MongoLiveReadMethod
  modes?: Mode[]
  name: string
  overrides?: Record<string, unknown>
  sessions?: () => Record<string, unknown>
  /** synthetic tape (tape mode only) */
  tape?: (seed: Seed, payload: Payload) => TapeEntry[]
}

type Outcome = {
  after: unknown
  capture?: TapeEntry[]
  events: unknown[]
  extra?: unknown
  outcome: unknown
  sessionsAfter: unknown
  tapeMismatches?: string[]
}

type Impl = (view: Any, args: Any) => Promise<unknown>

const seed = async (payload: Payload) => {
  const c1 = await payload.create({
    overrideAccess: true,
    collection: categoriesSlug,
    data: { name: 'alpha', rank: 1 },
  })
  const c2 = await payload.create({
    overrideAccess: true,
    collection: categoriesSlug,
    data: { name: 'beta', rank: 2 },
  })
  const c3 = await payload.create({
    overrideAccess: true,
    collection: categoriesSlug,
    data: { name: 'gamma', rank: 3 },
  })
  const p1 = await payload.create({
    overrideAccess: true,
    collection: postsSlug,
    data: {
      category: c1.id,
      group: { inner: 'x' },
      localizedTitle: 'a-en',
      location: [10, 20],
      num: 1,
      numbers: [1, 2],
      tags: [c1.id, c2.id],
      title: 'a',
    },
  })
  await payload.update({
    overrideAccess: true,
    id: p1.id,
    collection: postsSlug,
    data: { localizedTitle: 'a-es' },
    locale: 'es',
  })
  const p2 = await payload.create({
    overrideAccess: true,
    collection: postsSlug,
    data: {
      category: c2.id,
      location: [11, 21],
      num: 2,
      numbers: [2, 3],
      tags: [c2.id],
      title: 'b',
    },
  })
  const p3 = await payload.create({
    overrideAccess: true,
    collection: postsSlug,
    data: { category: c1.id, location: [50, 50], num: 3, tags: [], title: 'c' },
  })
  await payload.create({
    overrideAccess: true,
    collection: sortedSlug,
    data: { num: 2, title: 's2' },
  })
  await payload.create({
    overrideAccess: true,
    collection: sortedSlug,
    data: { num: 1, title: 's1' },
  })
  const p4 = await payload.create({
    overrideAccess: true,
    collection: postsSlug,
    data: { num: 4, title: 'b' },
  })
  const BSON = (payload.db as Any).connection.base.mongo.BSON
  // a 64-bit value MongoDB returns as a bson Long (not representable as a JS number)
  await (payload.db as Any).collections[postsSlug].collection.updateOne(
    { _id: new BSON.ObjectId(p3.id) },
    { $set: { bigNum: BSON.Long.fromString('9007199254740993') } },
  )
  const d1 = await payload.create({
    overrideAccess: true,
    collection: draftsSlug,
    data: { _status: 'published', title: 'd1' },
  })
  await payload.update({
    overrideAccess: true,
    id: d1.id,
    collection: draftsSlug,
    data: { title: 'd1-draft' },
    draft: true,
  })
  const d2 = await payload.create({
    overrideAccess: true,
    collection: draftsSlug,
    data: { category: c2.id, title: 'd2' },
    draft: true,
  })
  await payload.updateGlobal({
    overrideAccess: true,
    slug: settingsSlug,
    data: { _status: 'published', label: 'v1' },
  })
  await payload.updateGlobal({
    overrideAccess: true,
    slug: settingsSlug,
    data: { label: 'v2' },
    draft: true,
  })
  return { BSON, c1, c2, c3, d1, d2, p1, p2, p3, p4 }
}

/** A mongoose-paginate-v2 result as the tape value of `Model.paginate`. */
const paginated = (docs: unknown[], limit: number) => ({
  docs,
  hasNextPage: false,
  hasPrevPage: false,
  limit,
  nextPage: null,
  page: 1,
  pagingCounter: 1,
  prevPage: null,
  totalDocs: docs.length,
  totalPages: 1,
})

const postDoc = ({ BSON, p1 }: Seed) => ({
  _id: new BSON.ObjectId(p1.id),
  __v: 0,
  category: new BSON.ObjectId(),
  createdAt: new Date('2020-01-01T00:00:00.000Z'),
  tags: [new BSON.ObjectId()],
  title: 'a',
  updatedAt: new Date('2020-01-02T00:00:00.000Z'),
})

const fakeSession = (inTransaction: boolean) => ({ id: 'fake', inTransaction: () => inTransaction })

const cases: Case[] = [
  // ---------------------------------------------------------------- find
  {
    name: 'find: defaults',
    method: 'find',
    args: ({ run }) => run.wrap({ collection: postsSlug }, 'args'),
  },
  {
    name: 'find: where + limit + page + sort string',
    method: 'find',
    args: ({ run }) =>
      run.wrap(
        {
          collection: postsSlug,
          limit: 2,
          page: 1,
          sort: '-num',
          where: { title: { equals: 'b' } },
        },
        'args',
      ),
  },
  {
    name: 'find: caller sort array (fallback push), pagination',
    method: 'find',
    args: ({ run }) =>
      run.wrap(
        {
          collection: postsSlug,
          limit: 10,
          pagination: true,
          sort: ['num', '-title'],
          where: { num: { greater_than: 0 } },
        },
        'args',
      ),
  },
  {
    name: 'find: select + locale',
    method: 'find',
    args: ({ run }) =>
      run.wrap(
        {
          collection: postsSlug,
          limit: 5,
          locale: 'es',
          select: { localizedTitle: true, title: true },
        },
        'args',
      ),
  },
  {
    name: 'find: near (no sort, estimated count)',
    method: 'find',
    args: ({ run }) =>
      run.wrap(
        {
          collection: postsSlug,
          limit: 10,
          where: { location: { near: '10,20,100000000,0' } },
        },
        'args',
      ),
  },
  {
    name: 'find: relationship equals (ObjectId assigned into the caller where)',
    method: 'find',
    args: ({ run, seed }) =>
      run.wrap(
        { collection: postsSlug, limit: 10, where: { category: { equals: seed.c1.id } } },
        'args',
      ),
  },
  {
    name: 'find: polymorphic relationship (sanitizeQueryValue assigns into the caller where)',
    method: 'find',
    args: ({ run, seed }) =>
      run.wrap(
        {
          collection: postsSlug,
          limit: 5,
          where: { poly: { equals: { relationTo: categoriesSlug, value: seed.c1.id } } },
        },
        'args',
      ),
  },
  {
    name: 'find: array defaultSort (fallback pushed into the config array)',
    method: 'find',
    args: ({ run }) => run.wrap({ collection: sortedSlug, limit: 5 }, 'args'),
    around: (payload) => {
      const defaultSort = payload.collections[sortedSlug]!.config.defaultSort as string[]
      const before = [...defaultSort]
      return () => {
        const after = [...defaultSort]
        defaultSort.length = 0
        defaultSort.push(...before)
        return {
          after,
          isSameArray: payload.collections[sortedSlug]!.config.defaultSort === defaultSort,
        }
      }
    },
  },
  {
    name: 'queryDrafts: caller sort array',
    method: 'queryDrafts',
    args: ({ run }) => run.wrap({ collection: draftsSlug, limit: 5, sort: ['title'] }, 'args'),
  },
  {
    name: 'find: and/or/in',
    method: 'find',
    args: ({ run, seed }) =>
      run.wrap(
        {
          collection: postsSlug,
          limit: 10,
          where: {
            or: [
              { and: [{ num: { in: [1, 2] } }, { title: { not_equals: 'z' } }] },
              { tags: { in: [seed.c2.id] } },
            ],
          },
        },
        'args',
      ),
  },
  {
    name: 'find: sort by relationship path (sortAggregation -> aggregatePaginate)',
    method: 'find',
    args: ({ run }) =>
      run.wrap(
        {
          collection: postsSlug,
          limit: 2,
          page: 2,
          sort: 'category.name',
          where: { num: { exists: true } },
        },
        'args',
      ),
  },
  {
    name: 'find: joins (join aggregation)',
    method: 'find',
    args: ({ run }) => run.wrap({ collection: categoriesSlug, limit: 10 }, 'args'),
  },
  {
    name: 'find: joins without join aggregations (resolveJoins)',
    method: 'find',
    overrides: { useJoinAggregations: false },
    args: ({ run }) => run.wrap({ collection: categoriesSlug, limit: 10, sort: 'rank' }, 'args'),
  },
  {
    name: 'find: collation (custom count fn, locale all)',
    method: 'find',
    overrides: { collation: { strength: 1 } },
    args: ({ run }) =>
      run.wrap(
        { collection: postsSlug, limit: 2, locale: 'all', where: { title: { like: 'b' } } },
        'args',
      ),
  },
  {
    name: 'find: pagination false',
    method: 'find',
    args: ({ run }) => run.wrap({ collection: postsSlug, limit: 3, pagination: false }, 'args'),
  },
  {
    name: 'find: unknown collection (APIError)',
    method: 'find',
    args: ({ run }) => run.wrap({ collection: 'nope' }, 'args'),
  },
  // ---------------------------------------------------------------- sessions / req / timing
  {
    name: 'find: session from req.transactionID',
    method: 'find',
    modes: ['tape'],
    tape: (seed) => [
      { label: 'collections.posts', method: 'paginate', value: paginated([postDoc(seed)], 1) },
    ],
    sessions: () => ({ tx1: fakeSession(true) }),
    args: ({ run }) =>
      run.wrap({ collection: postsSlug, limit: 1, req: { transactionID: 'tx1' } }, 'args'),
  },
  {
    name: 'count: transactionID assigned after the call started (engine review 2)',
    method: 'count',
    modes: ['tape'],
    tape: () => [{ label: 'collections.posts', method: 'countDocuments', value: 1 }],
    sessions: () => ({ tx1: fakeSession(true) }),
    args: ({ run }) =>
      run.wrap({ collection: postsSlug, req: {}, where: { num: { equals: 1 } } }, 'args'),
    afterStart: (_ctx, args) => {
      args.req.transactionID = 'tx1'
    },
  },
  {
    name: 'find: transactionID assigned after the call started',
    method: 'find',
    modes: ['tape'],
    tape: (seed) => [
      { label: 'collections.posts', method: 'paginate', value: paginated([postDoc(seed)], 1) },
    ],
    sessions: () => ({ tx1: fakeSession(true) }),
    args: ({ run }) => run.wrap({ collection: postsSlug, limit: 1, req: {} }, 'args'),
    afterStart: (_ctx, args) => {
      args.req.transactionID = 'tx1'
    },
  },
  {
    name: 'findOne: promised transactionID',
    method: 'findOne',
    modes: ['tape'],
    tape: (seed) => [{ label: 'collections.posts', method: 'findOne', value: postDoc(seed) }],
    sessions: () => ({ tx1: fakeSession(true) }),
    args: ({ run }) =>
      run.wrap({ collection: postsSlug, req: { transactionID: Promise.resolve('tx1') } }, 'args'),
  },
  {
    name: 'count: orphaned session is dropped',
    method: 'count',
    modes: ['tape'],
    tape: () => [{ label: 'collections.posts', method: 'estimatedDocumentCount', value: 4 }],
    sessions: () => ({ tx1: fakeSession(false) }),
    args: ({ run }) => run.wrap({ collection: postsSlug, req: { transactionID: 'tx1' } }, 'args'),
  },
  {
    name: 'find: model replaced after the call started (captured Model)',
    method: 'find',
    modes: ['tape'],
    tape: (seed) => [
      { label: 'collections.posts', method: 'paginate', value: paginated([postDoc(seed)], 1) },
    ],
    args: ({ run }) =>
      run.wrap({ collection: postsSlug, limit: 1, where: { num: { equals: 1 } } }, 'args'),
    afterStart: (ctx) => {
      ctx.local.collections[postsSlug] = ctx.local.collections[categoriesSlug]
    },
  },
  {
    name: 'find: throwing getter in the args (rejection identity)',
    method: 'find',
    args: ({ run, userErrors }) => {
      const error = new Error('getter threw')
      userErrors.push(error)
      const args = { collection: postsSlug }
      Object.defineProperty(args, 'where', {
        enumerable: true,
        get() {
          throw error
        },
      })
      return run.wrap(args, 'args')
    },
  },
  {
    name: 'find: count rejects while aggregate pending (Promise.all fail-fast)',
    method: 'find',
    modes: ['tape'],
    args: ({ run }) =>
      run.wrap(
        {
          collection: postsSlug,
          limit: 2,
          sort: 'category.name',
          where: { num: { exists: true } },
        },
        'args',
      ),
    tape: () => [
      { error: new Error('count failed'), label: 'collections.posts', method: 'countDocuments' },
      { delay: 6, label: 'collections.posts', method: 'aggregate', value: [] },
    ],
  },
  {
    name: 'find: aggregate rejects while count pending',
    method: 'find',
    modes: ['tape'],
    args: ({ run }) =>
      run.wrap(
        {
          collection: postsSlug,
          limit: 2,
          sort: 'category.name',
          where: { num: { exists: true } },
        },
        'args',
      ),
    tape: () => [
      { delay: 6, label: 'collections.posts', method: 'countDocuments', value: 3 },
      { error: new Error('aggregate failed'), label: 'collections.posts', method: 'aggregate' },
    ],
  },
  {
    name: 'find: paginate rejects',
    method: 'find',
    modes: ['tape'],
    args: ({ run }) => run.wrap({ collection: postsSlug, limit: 1 }, 'args'),
    tape: () => [
      { error: new Error('paginate failed'), label: 'collections.posts', method: 'paginate' },
    ],
  },
  // ---------------------------------------------------------------- findOne
  {
    name: 'findOne: by id + select',
    method: 'findOne',
    args: ({ run, seed }) =>
      run.wrap(
        { collection: postsSlug, select: { title: true }, where: { id: { equals: seed.p1.id } } },
        'args',
      ),
  },
  {
    name: 'findOne: joins',
    method: 'findOne',
    args: ({ run, seed }) =>
      run.wrap(
        { collection: categoriesSlug, joins: {}, where: { id: { equals: seed.c1.id } } },
        'args',
      ),
  },
  {
    name: 'findOne: joins without join aggregations',
    method: 'findOne',
    overrides: { useJoinAggregations: false },
    args: ({ run, seed }) =>
      run.wrap(
        { collection: categoriesSlug, joins: {}, where: { id: { equals: seed.c1.id } } },
        'args',
      ),
  },
  {
    name: 'findOne: not found',
    method: 'findOne',
    args: ({ run }) =>
      run.wrap({ collection: postsSlug, where: { title: { equals: 'zzz' } } }, 'args'),
  },
  // ---------------------------------------------------------------- counts
  {
    name: 'count: all (estimated)',
    method: 'count',
    args: ({ run }) => run.wrap({ collection: postsSlug }, 'args'),
  },
  {
    name: 'count: where',
    method: 'count',
    args: ({ run }) =>
      run.wrap({ collection: postsSlug, where: { num: { greater_than: 1 } } }, 'args'),
  },
  {
    name: 'count: near',
    method: 'count',
    args: ({ run }) =>
      run.wrap(
        { collection: postsSlug, where: { location: { near: '10,20,100000000,0' } } },
        'args',
      ),
  },
  {
    name: 'count: collation',
    method: 'count',
    overrides: { collation: { strength: 2 } },
    args: ({ run }) =>
      run.wrap({ collection: postsSlug, locale: 'es', where: { title: { equals: 'B' } } }, 'args'),
  },
  {
    name: 'countVersions: all',
    method: 'countVersions',
    args: ({ run }) => run.wrap({ collection: draftsSlug }, 'args'),
  },
  {
    name: 'countVersions: where',
    method: 'countVersions',
    args: ({ run }) =>
      run.wrap({ collection: draftsSlug, where: { 'version.title': { equals: 'd1' } } }, 'args'),
  },
  {
    name: 'countGlobalVersions: where',
    method: 'countGlobalVersions',
    args: ({ run }) =>
      run.wrap({ global: settingsSlug, where: { latest: { equals: true } } }, 'args'),
  },
  {
    name: 'countGlobalVersions: unknown global',
    method: 'countGlobalVersions',
    args: ({ run }) => run.wrap({ global: 'nope' }, 'args'),
  },
  // ---------------------------------------------------------------- globals
  {
    name: 'findGlobal',
    method: 'findGlobal',
    args: ({ run }) => run.wrap({ slug: settingsSlug }, 'args'),
  },
  {
    name: 'findGlobal: select + locale',
    method: 'findGlobal',
    args: ({ run }) =>
      run.wrap({ locale: 'es', select: { label: true }, slug: settingsSlug }, 'args'),
  },
  {
    name: 'findGlobal: unknown',
    method: 'findGlobal',
    args: ({ run }) => run.wrap({ slug: 'nope' }, 'args'),
  },
  // ---------------------------------------------------------------- versions
  {
    name: 'findVersions: defaults',
    method: 'findVersions',
    args: ({ run }) => run.wrap({ collection: draftsSlug }, 'args'),
  },
  {
    name: 'findVersions: limit + page (skip) + select',
    method: 'findVersions',
    args: ({ run }) =>
      run.wrap(
        { collection: draftsSlug, limit: 1, page: 2, select: { version: { title: true } } },
        'args',
      ),
  },
  {
    name: 'findVersions: pagination false + where + sort',
    method: 'findVersions',
    args: ({ run }) =>
      run.wrap(
        {
          collection: draftsSlug,
          limit: 5,
          pagination: false,
          sort: 'createdAt',
          where: { latest: { equals: true } },
        },
        'args',
      ),
  },
  {
    name: 'findGlobalVersions: defaults',
    method: 'findGlobalVersions',
    args: ({ run }) => run.wrap({ global: settingsSlug }, 'args'),
  },
  {
    name: 'findGlobalVersions: limit + page + locale',
    method: 'findGlobalVersions',
    args: ({ run }) => run.wrap({ global: settingsSlug, limit: 1, locale: 'es', page: 2 }, 'args'),
  },
  // ---------------------------------------------------------------- queryDrafts
  {
    name: 'queryDrafts: defaults',
    method: 'queryDrafts',
    args: ({ run }) => run.wrap({ collection: draftsSlug }, 'args'),
  },
  {
    name: 'queryDrafts: where + sort + limit',
    method: 'queryDrafts',
    args: ({ run }) =>
      run.wrap(
        {
          collection: draftsSlug,
          limit: 1,
          page: 1,
          sort: '-title',
          where: { title: { exists: true } },
        },
        'args',
      ),
  },
  {
    name: 'queryDrafts: sort by relationship (aggregatePaginate)',
    method: 'queryDrafts',
    args: ({ run }) =>
      run.wrap({ collection: draftsSlug, limit: 5, sort: 'category.name' }, 'args'),
  },
  // ---------------------------------------------------------------- findDistinct
  {
    name: 'findDistinct: text',
    method: 'findDistinct',
    args: ({ run }) => run.wrap({ collection: postsSlug, field: 'title', sort: 'title' }, 'args'),
  },
  {
    name: 'findDistinct: limit + page as a string (joins review 5)',
    method: 'findDistinct',
    args: ({ run }) =>
      run.wrap({ collection: postsSlug, field: 'title', limit: 1, page: '2' }, 'args'),
  },
  {
    name: 'findDistinct: relationship',
    method: 'findDistinct',
    args: ({ run }) =>
      run.wrap({ collection: postsSlug, field: 'category', limit: 5, page: 1 }, 'args'),
  },
  {
    name: 'findDistinct: through a relationship + relatedAccess',
    method: 'findDistinct',
    args: ({ run }) =>
      run.wrap(
        {
          collection: postsSlug,
          field: 'category.name',
          limit: 2,
          page: 1,
          relatedAccess: { category: { name: { not_equals: 'gamma' } } },
        },
        'args',
      ),
  },
  {
    name: 'findDistinct: hasMany numbers',
    method: 'findDistinct',
    args: ({ run }) =>
      run.wrap({ collection: postsSlug, field: 'numbers', sort: '-numbers' }, 'args'),
  },
  {
    name: 'findDistinct: localized + locale',
    method: 'findDistinct',
    args: ({ run }) =>
      run.wrap({ collection: postsSlug, field: 'localizedTitle', locale: 'es' }, 'args'),
  },
  {
    name: 'findDistinct: Long values (engine review 3 / joins review 2)',
    method: 'findDistinct',
    args: ({ run }) => run.wrap({ collection: postsSlug, field: 'bigNum' }, 'args'),
  },
  {
    name: 'findDistinct: synthetic opaque bson values',
    method: 'findDistinct',
    modes: ['tape'],
    args: ({ run }) => run.wrap({ collection: postsSlug, field: 'bigNum', limit: 3 }, 'args'),
    tape: ({ BSON }) => [
      {
        label: 'collections.posts',
        method: 'aggregate',
        value: [{ count: BSON.Long.fromString('7') }],
      },
      {
        label: 'collections.posts',
        method: 'aggregate',
        value: [
          { _id: BSON.Long.fromString('9007199254740993') },
          { _id: BSON.Decimal128.fromString('1.5') },
          { _id: { _field: new BSON.Timestamp({ i: 1, t: 2 }) } },
        ],
      },
    ],
  },
]

test.suite('mongo live reads differential', { config: './config.ts' }, () => {
  test('should run every read method exactly like upstream (real and tape)', async ({
    payload,
  }) => {
    const data = await seed(payload)
    const ported = initLivePorts()
    const live = getMongoLive()
    const runtime = getCoreRuntime() as Any
    // the configuration under test really is the one selected (no vacuous "all ports" run)
    if (portsMode === 'all') {
      expect(Object.values(ported).every(Boolean), JSON.stringify(ported)).toBe(true)
    } else if (portsMode === 'upstream') {
      expect(Object.values(ported).some(Boolean), JSON.stringify(ported)).toBe(false)
    }
    console.log(`[livereads] ports ${portsMode}: ${JSON.stringify(ported)}`)
    const db = payload.db as Any
    expect(typeof db.find).toBe('function')
    for (const method of ['find', 'count', 'findDistinct'] as const) {
      expect(db[method]).not.toBe(live[method])
    }

    const upstream: Record<string, Impl> = {}
    const rust: Record<string, Impl> = {}
    for (const c of cases) {
      upstream[c.method] = (view, args) => db[c.method].call(view, args)
      rust[c.method] = (view, args) => live[c.method](view, args)
    }

    let compared = 0
    let tapeCompared = 0
    const failures: unknown[] = []
    const dump: unknown[] = []
    for (const c of cases) {
      const modes = c.modes ?? ['real', 'tape']
      let recorded: TapeEntry[] | undefined
      if (modes.includes('real')) {
        const ts = await execute({ c, data, impl: upstream[c.method]!, mode: 'real', payload })
        const entriesBefore = runtime.stats().entries
        const rs = await execute({ c, data, impl: rust[c.method]!, mode: 'real', payload })
        expect(
          runtime.stats().entries,
          `${c.name}: the Rust run entered the engine`,
        ).toBeGreaterThan(entriesBefore)
        expect(ts.events.length, `${c.name}: the TS reference ran`).toBeGreaterThan(1)
        const diff = compare(ts, rs)
        if (diff) {
          failures.push({ case: c.name, mode: 'real', ...diff })
        }
        dump.push({
          after: ts.after,
          case: c.name,
          events: ts.events.length,
          extra: ts.extra,
          mode: 'real',
          outcome: ts.outcome,
        })
        compared++
        recorded = ts.capture
      }
      if (modes.includes('tape')) {
        const entries = c.tape ? c.tape(data, payload) : (recorded ?? [])
        const ts = await execute({
          c,
          data,
          entries,
          impl: upstream[c.method]!,
          mode: 'tape',
          payload,
        })
        const rs = await execute({ c, data, entries, impl: rust[c.method]!, mode: 'tape', payload })
        expect(ts.tapeMismatches, `${c.name}: TS replays its own tape`).toEqual([])
        const diff = compare(ts, rs)
        if (diff) {
          failures.push({ case: c.name, mode: 'tape', ...diff })
        }
        dump.push({
          case: c.name,
          events: ts.events.length,
          maxTick: ts.events.at(-1)?.[0],
          mode: 'tape',
          outcome: ts.outcome,
        })
        tapeCompared++
      }
    }
    if (process.env.LIVEREADS_DUMP_FILE) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(process.env.LIVEREADS_DUMP_FILE, JSON.stringify(dump))
    }
    if (failures.length && process.env.LIVEREADS_FAILURES_FILE) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(process.env.LIVEREADS_FAILURES_FILE, JSON.stringify(failures, null, 1))
    }
    expect(failures).toEqual([])
    expect(compared).toBeGreaterThanOrEqual(30)
    expect(tapeCompared).toBeGreaterThanOrEqual(cases.length)
  })

  test('should detect deviations (negative controls)', async ({ payload }) => {
    const data = await seed(payload)
    const db = payload.db as Any
    const find: Impl = (view, args) => db.find.call(view, args)
    const c: Case = {
      name: 'control',
      method: 'find',
      args: ({ run }) =>
        run.wrap({ collection: postsSlug, limit: 2, where: { num: { greater_than: 0 } } }, 'args'),
    }
    const reference = await execute({ c, data, impl: find, mode: 'real', payload })
    const entries = reference.capture!
    const tapeReference = await execute({ c, data, entries, impl: find, mode: 'tape', payload })

    // the reference agrees with itself (deterministic)
    expect(
      compare(
        tapeReference,
        await execute({ c, data, entries, impl: find, mode: 'tape', payload }),
      ),
    ).toBeNull()

    const variants: Record<string, Impl> = {
      'extra tick': async (view, args) => {
        await null
        return db.find.call(view, args)
      },
      'extra read': (view, args) => {
        void args.where
        return db.find.call(view, args)
      },
      'different model argument': (view, args) => {
        const swapped = new Proxy(view, {
          get: (t, k) => (k === 'collation' ? { strength: 1 } : Reflect.get(t, k)),
        })
        return db.find.call(swapped, args)
      },
      'tampered result': async (view, args) => {
        const result: Any = await db.find.call(view, args)
        result.totalDocs++
        return result
      },
    }
    for (const [name, impl] of Object.entries(variants)) {
      const tape = await execute({ c, data, entries, impl, mode: 'tape', payload })
      expect(compare(tapeReference, tape), `tape: ${name}`).not.toBeNull()
    }
    for (const name of ['extra read', 'different model argument', 'tampered result']) {
      const real = await execute({ c, data, impl: variants[name]!, mode: 'real', payload })
      expect(compare(reference, real), `real: ${name}`).not.toBeNull()
    }
  })

  test('should run aggregatePaginate exactly like upstream', async ({ payload }) => {
    const data = await seed(payload)
    initLivePorts()
    const live = getMongoLive()
    const db = payload.db as Any
    type PaginateCase = { args: (model: Any, run: Run) => Any; name: string; tape: TapeEntry[] }
    const label = 'collections.posts'
    const paginateCases: PaginateCase[] = [
      {
        name: 'count + aggregate, page 2',
        args: (Model, run) =>
          run.wrap(
            {
              adapter: db,
              joinAggregation: [{ $addFields: { x: 1 } }],
              limit: 2,
              Model,
              page: 2,
              projection: { title: true },
              query: { num: { $gt: 0 } },
              sort: { title: 'desc', num: 'asc' },
              sortAggregation: [{ $addFields: { y: 1 } }],
            },
            'args',
          ),
        tape: [
          { delay: 2, label, method: 'countDocuments', value: 5 },
          { label, method: 'aggregate', value: [{ title: 'b' }, { title: 'a' }] },
        ],
      },
      {
        name: 'estimated count, no pagination metadata',
        args: (Model, run) =>
          run.wrap({ adapter: db, limit: 1, Model, query: {}, useEstimatedCount: true }, 'args'),
        tape: [
          { label, method: 'estimatedDocumentCount', value: 9 },
          { label, method: 'aggregate', value: [{ title: 'a' }] },
        ],
      },
      {
        name: 'pagination false, page as a string',
        args: (Model, run) =>
          run.wrap(
            { adapter: db, limit: 3, Model, page: '2', pagination: false, query: {} },
            'args',
          ),
        tape: [{ label, method: 'aggregate', value: [{ title: 'a' }] }],
      },
      {
        name: 'count rejects first',
        args: (Model, run) => run.wrap({ adapter: db, limit: 2, Model, query: { a: 1 } }, 'args'),
        tape: [
          { error: new Error('count'), label, method: 'countDocuments' },
          { delay: 4, label, method: 'aggregate', value: [] },
        ],
      },
    ]
    let compared = 0
    for (const pc of paginateCases) {
      const outcomes: Outcome[] = []
      for (const impl of [upstreamAggregatePaginate as Any, live.aggregatePaginate]) {
        const run = new Run(pc.name)
        const tape = new Tape(pc.tape)
        const { local } = adapterView({ adapter: db, overrides: {}, run, sessions: {}, tape })
        run.opaque.add(db)
        const args = run.quiet(() => pc.args(local.collections[postsSlug], run))
        const stop = startPump(run)
        run.log('start')
        const promise = impl(args)
        promise.then(
          () => run.log('settled', 'ok'),
          () => run.log('settled', 'error'),
        )
        let outcome: unknown
        try {
          outcome = { ok: run.describe(await promise) }
        } catch (error) {
          outcome = {
            error: run.describe(error),
            isTapeError: pc.tape.some((e) => e.error === error),
          }
        }
        stop()
        outcomes.push({
          after: run.describe(args),
          events: run.events,
          outcome,
          sessionsAfter: null,
        })
        expect(tape.mismatches).toEqual([])
      }
      expect(outcomes[0]!.events.length).toBeGreaterThan(2)
      const diff = compare(outcomes[0]!, outcomes[1]!)
      expect(diff, pc.name).toBeNull()
      compared++
    }
    expect(compared).toBe(paginateCases.length)
    void data
  })

  test('should match upstream getSession, getEntity and bson helpers', async ({ payload }) => {
    await seed(payload)
    initLivePorts()
    const live = getMongoLive()
    const db = payload.db as Any
    const BSON = db.connection.base.mongo.BSON

    // getSession
    const sessionCases: [string, () => { db: Any; req: Any }][] = [
      ['no req', () => ({ db: { sessions: {} }, req: undefined })],
      ['no transaction', () => ({ db: { sessions: {} }, req: {} })],
      [
        'active',
        () => ({ db: { sessions: { t: fakeSession(true) } }, req: { transactionID: 't' } }),
      ],
      [
        'orphan',
        () => ({ db: { sessions: { t: fakeSession(false) } }, req: { transactionID: 't' } }),
      ],
      [
        'promised id',
        () => ({
          db: { sessions: { 7: fakeSession(true) } },
          req: { transactionID: Promise.resolve(7) },
        }),
      ],
      ['unknown id', () => ({ db: { sessions: {} }, req: { transactionID: 'x' } })],
    ]
    for (const [name, make] of sessionCases) {
      const outcomes: Outcome[] = []
      for (const impl of [upstreamGetSession as Any, live.getSession]) {
        const run = new Run(name)
        const input = make()
        const dbView = run.wrap(input.db, 'db')
        const req = input.req && run.wrap(input.req, 'req')
        const stop = startPump(run)
        const promise = impl(dbView, req)
        promise.then(() => run.log('settled'))
        const value = await promise
        stop()
        outcomes.push({
          after: run.describe(dbView),
          events: run.events,
          outcome: run.describe(value),
          sessionsAfter: null,
        })
      }
      expect(compare(outcomes[0]!, outcomes[1]!), `getSession: ${name}`).toBeNull()
    }

    // getCollection / getGlobal (models, configs, APIError class and message)
    const entityCases: [string, boolean, string, boolean][] = [
      ['collection', true, postsSlug, false],
      ['collection versions', true, draftsSlug, true],
      ['missing collection', true, 'nope', false],
      ['missing version model', true, postsSlug, true],
      ['global', false, settingsSlug, false],
      ['global versions', false, settingsSlug, true],
      ['missing global', false, 'nope', false],
    ]
    for (const [name, isCollection, slug, versions] of entityCases) {
      const results: unknown[] = []
      for (const kind of ['ts', 'rs']) {
        const run = new Run(name)
        let out: unknown
        try {
          if (kind === 'ts') {
            const r: Any = isCollection
              ? upstreamGetCollection({ adapter: db, collectionSlug: slug, versions })
              : upstreamGetGlobal({ adapter: db, globalSlug: slug, versions } as Any)
            out = isCollection
              ? [r.collectionConfig, r.customIDType, r.Model]
              : [r.globalConfig, r.Model]
          } else {
            out = isCollection
              ? live.getCollection(db, slug, versions)
              : live.getGlobal(db, slug, versions)
          }
          out = (out as unknown[]).map((v) =>
            typeof v === 'object' && v ? v : { primitive: run.describe(v) },
          )
        } catch (error: Any) {
          out = {
            class: error.constructor.name,
            message: error.message,
            name: error.name,
            status: error.status,
          }
        }
        results.push(out)
      }
      expect(results[1], `entity: ${name}`).toEqual(results[0])
      if (Array.isArray(results[0])) {
        ;(results[0] as unknown[]).forEach((v: Any, i) => {
          if (!('primitive' in v)) {
            expect((results[1] as unknown[])[i], `entity: ${name} identity ${i}`).toBe(v)
          }
        })
      }
    }

    // isObjectID (duck typed like upstream), bsonClassOf (real instanceof), ObjectId helpers
    const oid = new BSON.ObjectId()
    const values: unknown[] = [
      oid,
      { _bsontype: 'ObjectId', toHexString: () => 'forged' },
      { _bsontype: 'ObjectId' },
      { _bsontype: 'ObjectId', toHexString: 1 },
      Object.create(oid),
      new Proxy(oid, {}),
      BSON.Decimal128.fromString('1'),
      BSON.Long.fromNumber(1),
      new BSON.Binary(Buffer.from('x')),
      null,
      undefined,
      0,
      'abc',
      '0123456789abcdef01234567',
      Buffer.from('012345678901'),
    ]
    for (const v of values) {
      expect(live.isObjectID(v)).toBe(upstreamIsObjectID(v))
      expect(live.objectIdIsValid(v)).toBe(BSON.ObjectId.isValid(v as Any))
    }
    expect(live.bsonClassOf(oid)).toBe('ObjectId')
    expect(live.bsonClassOf({ _bsontype: 'ObjectId', toHexString: () => '' })).toBeNull()
    expect(live.bsonClassOf({ _bsontype: 'Decimal128' })).toBeNull()
    expect(live.bsonClassOf(BSON.Decimal128.fromString('1'))).toBe('Decimal128')
    expect(live.bsonClassOf(BSON.Long.fromNumber(1))).toBe('Long')
    expect(live.bsonClassOf(new BSON.Binary(Buffer.from('x')))).toBe('Binary')
    const created = live.newObjectId('0123456789abcdef01234567') as Any
    expect(created).toBeInstanceOf(BSON.ObjectId)
    expect(created.toHexString()).toBe('0123456789abcdef01234567')
    let bsonError: Any
    try {
      live.newObjectId('nope')
    } catch (error) {
      bsonError = error
    }
    expect(bsonError).toBeInstanceOf(BSON.BSONError)
    let upstreamError: Any
    try {
      new BSON.ObjectId('nope')
    } catch (error) {
      upstreamError = error
    }
    expect(bsonError.message).toBe(upstreamError.message)
    expect(typeof live.nowISO()).toBe('string')
  })
})

const execute = async ({
  c,
  data,
  entries,
  impl,
  mode,
  payload,
}: {
  c: Case
  data: Seed
  entries?: TapeEntry[]
  impl: Impl
  mode: Mode
  payload: Payload
}): Promise<Outcome> => {
  const run = new Run(c.name)
  const tape = mode === 'tape' ? new Tape(entries ?? []) : undefined
  const capture: TapeEntry[] | undefined = mode === 'real' ? [] : undefined
  const { local, view } = adapterView({
    adapter: payload.db,
    capture,
    overrides: c.overrides ?? {},
    run,
    sessions: c.sessions?.() ?? {},
    tape,
  })
  const ctx: Ctx = { adapter: view, local, run, seed: data, userErrors: [] }
  const finish = c.around?.(payload)
  const args = run.quiet(() => c.args(ctx))
  const stop = mode === 'tape' ? startPump(run) : () => {}
  run.log('start')
  const promise = impl(view, args)
  promise.then(
    () => run.log('settled', 'ok'),
    () => run.log('settled', 'error'),
  )
  c.afterStart?.(ctx, args)
  let outcome: unknown
  try {
    outcome = { ok: run.describe(await promise) }
  } catch (error) {
    outcome = {
      error: run.describe(error),
      isTapeError: (entries ?? []).some((e) => e.error === error),
      isUserError: ctx.userErrors.includes(error),
    }
  }
  stop()
  return {
    after: run.describe(args),
    capture,
    extra: finish ? run.describe(finish()) : undefined,
    events: run.events,
    outcome,
    sessionsAfter: run.describe(local.sessions),
    tapeMismatches: tape?.mismatches,
  }
}

/** `null` when equal, else the first difference. */
const compare = (ts: Outcome, rs: Outcome) => {
  if (ts === rs) {
    throw new Error('self-comparison')
  }
  const events = firstDifference(ts.events, rs.events)
  if (events) {
    return { what: 'events', ...events }
  }
  for (const key of ['outcome', 'after', 'sessionsAfter', 'extra'] as const) {
    if (JSON.stringify(ts[key]) !== JSON.stringify(rs[key])) {
      return { rs: rs[key], ts: ts[key], what: key }
    }
  }
  if (ts.capture && rs.capture) {
    const a = new Run('capture-ts').describe(ts.capture)
    const b = new Run('capture-rs').describe(rs.capture)
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      return { rs: b, ts: a, what: 'database results' }
    }
  }
  if (JSON.stringify(ts.tapeMismatches ?? []) !== JSON.stringify(rs.tapeMismatches ?? [])) {
    return { rs: rs.tapeMismatches, ts: ts.tapeMismatches, what: 'tape mismatches' }
  }
  return null
}
