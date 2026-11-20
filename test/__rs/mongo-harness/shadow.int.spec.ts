/**
 * Self-test of the MongoDB shadow adapter (packages/engine-rs/src/shadow-mongo).
 *
 * - TS vs TS gives zero divergences across all operation kinds (incl. transactions, upserts with
 *   server-generated ids, raw collection writes, geo/regex queries), in serial and concurrent mode.
 * - Deliberately broken candidates are detected (values, key order, ObjectId vs string, RegExp,
 *   thrown errors, database state, argument mutations, extra / missing clock readings, ObjectId
 *   vs `{ $oid }` user data, argument identity, mutation timing before the first await, driver
 *   call order) while the caller still receives the reference result.
 *
 *   PAYLOAD_DATABASE=mongodb MONGODB_URL='mongodb://payload:payload@localhost:27018/<db>?authSource=admin&directConnection=true&replicaSet=rs0' \
 *     pnpm test:int --config test/__rs/mongo-harness/vitest.config.ts test/__rs/mongo-harness/shadow.int.spec.ts
 *
 * Instances use the databases `<db>_st<n>` / `<db>_st<n>c`, dropped afterwards.
 */
import type { CollectionConfig, DatabaseAdapterObj, GlobalConfig, Payload } from 'payload'

import { mongooseAdapter } from '@payloadcms/db-mongodb'
import mongoose from 'mongoose'
import { AsyncResource } from 'node:async_hooks'
import { buildConfig, getPayload } from 'payload'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import type { ShadowRecord } from '../../../packages/engine-rs/src/shadow-mongo/index.js'

import {
  dropDatabases,
  mongoUrlFor,
  withMongoClient,
} from '../../../packages/engine-rs/scripts/mongo/mongoDatabases.mjs'
import {
  compareMongoValues,
  createMongoShadowAdapter,
  getMongoShadowState,
  toComparable,
} from '../../../packages/engine-rs/src/shadow-mongo/index.js'
import { loadContext } from './shadowDatabaseAdapter.js'

const baseName = new URL(process.env.MONGODB_URL!).pathname.replace(/^\//, '') || 'rsm_selftest'
const createdDatabases: string[] = []
let counter = 0

const allow = () => true

const posts: CollectionConfig = {
  slug: 'posts',
  access: { create: allow, delete: allow, read: allow, readVersions: allow, update: allow },
  fields: [
    { name: 'title', type: 'text' },
    { name: 'views', type: 'number' },
    { name: 'tags', type: 'text', hasMany: true },
    { name: 'localizedTitle', type: 'text', localized: true },
    { name: 'location', type: 'point' },
    { name: 'related', type: 'relationship', relationTo: 'posts' },
    { name: 'items', type: 'array', fields: [{ name: 'label', type: 'text' }] },
    {
      name: 'failAfterChange',
      type: 'checkbox',
      hooks: {
        afterChange: [
          ({ value }) => {
            if (value) {
              throw new Error('afterChange failure (rollback test)')
            }
            return value
          },
        ],
      },
    },
  ],
  versions: { drafts: true },
}

const prefs: CollectionConfig = {
  slug: 'prefs',
  access: { create: allow, delete: allow, read: allow, update: allow },
  fields: [
    { name: 'key', type: 'text' },
    { name: 'user', type: 'relationship', relationTo: ['posts'] },
    { name: 'value', type: 'json' },
  ],
}

const settings: GlobalConfig = {
  slug: 'settings',
  access: { read: allow, readVersions: allow, update: allow },
  fields: [{ name: 'siteName', type: 'text' }],
  versions: true,
}

type Setup = {
  candidate?: (adapter: Record<string, any>) => void
  mode?: 'concurrent' | 'serial'
  onDivergence?: 'record' | 'throw'
  upstreamRaces?: Record<string, string>
}

/** Runs `fn` outside every async context of this file's tests (no replay tape). */
const outsideContexts = AsyncResource.bind(<T>(fn: () => T) => fn())

const instances: Payload[] = []

/** Differences outside the event trace and the first-await snapshot. */
const untraced = (differences: { path: string }[]) =>
  differences.filter((d) => !d.path.startsWith('$events') && !d.path.startsWith('$firstAwait'))

afterEach(async () => {
  while (instances.length) {
    await instances.pop()!.destroy()
  }
})

afterAll(async () => {
  await dropDatabases(createdDatabases)
})

/** A payload whose db is a shadow adapter over two fresh databases. */
async function setup({ candidate, mode, onDivergence, upstreamRaces }: Setup = {}) {
  const id = ++counter
  const records: ShadowRecord[] = []
  const make = (suffix: string) => {
    const dbName = `${baseName}_st${id}${suffix}`
    createdDatabases.push(dbName)
    return mongooseAdapter({ ensureIndexes: true, url: mongoUrlFor(dbName) })
  }
  let candidateAdapter: Record<string, any> | undefined
  const candidateObj = make('c')
  const wrapped: DatabaseAdapterObj = {
    ...candidateObj,
    init: (args) => {
      const adapter = candidateObj.init(args)
      candidateAdapter = adapter as unknown as Record<string, any>
      candidate?.(candidateAdapter)
      return adapter
    },
  }
  const db = createMongoShadowAdapter({
    candidate: wrapped,
    mode,
    onDivergence,
    reference: make(''),
    report: {
      context: await loadContext(),
      file: `/tmp/rs-mongo-shadow-selftest-${process.pid}-${id}.jsonl`,
      onRecord: (r) => records.push(r),
    },
    upstreamRaces,
  }) as DatabaseAdapterObj

  const config = await buildConfig({
    collections: [posts, prefs],
    db,
    globals: [settings],
    localization: { defaultLocale: 'en', locales: ['en', 'es'] },
    secret: 'TEST_SECRET',
    telemetry: false,
    typescript: { autoGenerate: false },
  })
  const previousDrop = process.env.PAYLOAD_DROP_DATABASE
  process.env.PAYLOAD_DROP_DATABASE = 'true'
  let payload: Payload
  try {
    payload = await getPayload({ config, cron: false, key: `mongo-shadow-selftest-${id}` })
  } finally {
    if (previousDrop === undefined) {
      delete process.env.PAYLOAD_DROP_DATABASE
    } else {
      process.env.PAYLOAD_DROP_DATABASE = previousDrop
    }
  }
  instances.push(payload)
  const divergences = () => records.filter((r) => r.type === 'divergence')
  return { candidate: () => candidateAdapter!, divergences, payload, records }
}

/** One of every adapter operation through the Local API. */
async function exercise(payload: Payload) {
  const a = await payload.create({
    collection: 'posts',
    data: {
      items: [{ label: 'x' }],
      localizedTitle: 'hola',
      location: [10, 20],
      tags: ['a', 'b'],
      title: 'first',
      views: 1,
    },
  })
  const b = await payload.create({
    collection: 'posts',
    data: { related: a.id, title: 'second', views: 2 },
  })
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      payload.create({ collection: 'posts', data: { title: `concurrent ${i}`, views: 10 } }),
    ),
  )
  await payload.find({
    collection: 'posts',
    sort: '-views',
    where: { views: { greater_than_equal: 1 } },
  })
  await payload.find({ collection: 'posts', where: { title: { like: 'CONC' } } })
  await payload.find({
    collection: 'posts',
    where: { location: { near: '10,20,100000,0' } },
  })
  await payload.find({ collection: 'posts', where: { 'related.title': { equals: 'first' } } })
  await payload.findByID({ collection: 'posts', id: b.id, depth: 1 })
  await payload.count({ collection: 'posts' })
  await payload.findDistinct({ collection: 'posts', field: 'title' })
  await payload.update({ collection: 'posts', data: { title: 'first!' }, id: a.id })
  await payload.update({
    collection: 'posts',
    data: { localizedTitle: 'uno' },
    id: a.id,
    locale: 'es',
  })
  await payload.update({ collection: 'posts', data: { views: 5 }, where: { views: { equals: 2 } } })
  await payload.update({ collection: 'posts', data: { title: 'draft' }, draft: true, id: a.id })
  await payload.find({ collection: 'posts', draft: true })
  await payload.findVersions({ collection: 'posts' })
  await payload.countVersions({ collection: 'posts' })
  await payload.updateGlobal({ data: { siteName: 'site' }, slug: 'settings' })
  await payload.findGlobal({ slug: 'settings' })
  await payload.findGlobalVersions({ slug: 'settings' })
  await payload.countGlobalVersions({ global: 'settings' })
  await payload.db.upsert({
    collection: 'posts',
    data: { title: 'upserted' },
    where: { title: { equals: 'upserted' } },
  })
  await payload.db.upsert({
    collection: 'posts',
    data: { title: 'upserted', views: 7 },
    where: { title: { equals: 'upserted' } },
  })
  await payload.delete({ collection: 'posts', id: a.id })
  await payload.delete({ collection: 'posts', where: { views: { equals: 5 } } })
}

describe('mongo shadow adapter', () => {
  it('TS vs TS: zero divergences, every call shadowed, databases equal', async () => {
    const { divergences, payload } = await setup()
    await exercise(payload)
    const state = getMongoShadowState(payload.db)!
    expect(await state.diffDatabases()).toEqual([])
    expect(divergences()).toEqual([])
    expect(state.calls).toBeGreaterThan(40)
    expect(state.dbChecks).toBe(1)
    expect(state.serverIDsAligned).toBe(1)
    // the event traces were not empty (driver operations and readings compared)
    expect(state.tracedEvents).toBeGreaterThan(80)
    expect(state.unshadowed).toEqual({})
    expect(payload.db.name).toBe('mongoose')
  })

  it('detects a wrong value and returns the reference result', async () => {
    const { divergences, payload } = await setup({
      candidate: (adapter) => {
        const find = adapter.find
        adapter.find = async function (args: unknown) {
          const result = await find.call(this, args)
          if (result.docs[0]) {
            result.docs[0].title = `${result.docs[0].title} (bug)`
          }
          return result
        }
      },
    })
    await payload.create({ collection: 'posts', data: { title: 'hello' } })
    const { docs } = await payload.find({ collection: 'posts' })
    expect(docs[0]!.title).toBe('hello')
    const found = divergences().filter((d) => d.method === 'find')
    expect(found).toHaveLength(1)
    expect(found[0]!.differences).toEqual([
      { candidate: 'hello (bug)', kind: 'value', path: 'docs[0].title', reference: 'hello' },
    ])
  })

  it('detects count, key order, missing keys and thrown errors', async () => {
    const { divergences, payload } = await setup({
      candidate: (adapter) => {
        const { count, create, findOne } = adapter
        adapter.count = async function (args: unknown) {
          const result = await count.call(this, args)
          return { totalDocs: result.totalDocs + 1 }
        }
        adapter.create = async function (args: unknown) {
          const { views: _views, ...rest } = await create.call(this, args)
          return rest
        }
        adapter.findOne = async function (args: unknown) {
          const doc = await findOne.call(this, args)
          return doc && Object.fromEntries(Object.entries(doc).reverse())
        }
        adapter.updateOne = () => Promise.reject(new Error('candidate boom'))
      },
    })
    const doc = await payload.create({ collection: 'posts', data: { title: 't', views: 3 } })
    expect(doc.views).toBe(3)
    expect((await payload.count({ collection: 'posts' })).totalDocs).toBe(1)
    await payload.findByID({ collection: 'posts', id: doc.id })
    const updated = await payload.update({ collection: 'posts', data: { title: 'u' }, id: doc.id })
    expect(updated.title).toBe('u')

    const byMethod = (m: string) => divergences().filter((d) => d.method === m)
    expect(byMethod('count')[0]!.differences).toEqual([
      { candidate: 2, kind: 'value', path: 'totalDocs', reference: 1 },
    ])
    expect(byMethod('create')[0]!.differences).toEqual([
      expect.objectContaining({ kind: 'missingKey', path: 'views', reference: 3 }),
    ])
    expect(byMethod('findOne')[0]!.differences[0]).toMatchObject({ kind: 'keyOrder', path: '$' })
    // the rejecting candidate also never reads the clock the reference read (updatedAt) and
    // never reaches the driver
    const updateOne = byMethod('updateOne')[0]!.differences
    expect(untraced(updateOne)).toEqual([
      expect.objectContaining({
        candidate: expect.objectContaining({ message: 'candidate boom' }),
        kind: 'type',
        path: '$threw',
      }),
      expect.objectContaining({ candidate: { extra: 0, replayed: 0 }, path: '$generated.clock' }),
    ])
    expect(updateOne).toContainEqual(expect.objectContaining({ kind: 'length', path: '$events' }))
  })

  it('detects a stored ObjectId replaced by its hex string (database state)', async () => {
    const { candidate, payload } = await setup()
    const a = await payload.create({ collection: 'posts', data: { title: 'a' } })
    await payload.create({ collection: 'posts', data: { related: a.id, title: 'b' } })
    const state = getMongoShadowState(payload.db)!
    expect(await state.diffDatabases()).toEqual([])

    // candidate-only write: bypasses the shadow
    await candidate()
      .connection.db.collection('posts')
      .updateOne({ title: 'b' }, { $set: { related: a.id } })
    const differences = await state.diffDatabases()
    expect(differences).toEqual([
      expect.objectContaining({
        candidate: a.id,
        kind: 'type',
        path: 'collections.posts.documents[1].related',
        reference: { $proto: expect.any(Number), value: { $oid: a.id } },
      }),
    ])
  })

  it('compares RegExp, Decimal128, Binary and Buffer values by type and content', () => {
    const { Binary, Decimal128 } = mongoose.mongo
    const diff = (a: unknown, b: unknown) => compareMongoValues(toComparable(a), toComparable(b))
    expect(diff({ r: /a/i }, { r: /a/i })).toEqual([])
    expect(diff({ r: /a/i }, { r: /a/g })).toHaveLength(1)
    expect(
      diff({ d: Decimal128.fromString('1.10') }, { d: Decimal128.fromString('1.1') }),
    ).toHaveLength(1)
    expect(
      diff({ b: new Binary(Buffer.from('x'), 4) }, { b: new Binary(Buffer.from('x'), 0) }),
    ).toHaveLength(1)
    expect(diff({ b: Buffer.from('x') }, { b: new Binary(Buffer.from('x'), 0) })).toHaveLength(1)
    expect(diff({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([
      expect.objectContaining({ kind: 'keyOrder' }),
    ])
  })

  it('mirrors raw collection writes and detects writes it cannot see', async () => {
    const { divergences, payload } = await setup()
    const db = payload.db as any
    await db.collections.posts.collection.insertOne({ title: 'raw insertOne' })
    await db.collections.posts.insertMany([
      { title: 'raw insertMany 1' },
      { title: 'raw insertMany 2' },
    ])
    await db.connection.collection('posts').updateMany({}, { $set: { views: 9 } })
    // the native driver below mongoose
    await db.connection.db
      .collection('posts')
      .updateOne({ title: 'raw insertOne' }, { $set: { views: 1 } })
    await db.connection.db.collection('posts').insertOne({ title: 'driver insertOne' })
    await payload.find({ collection: 'posts' })
    const state = getMongoShadowState(payload.db)!
    expect(await state.diffDatabases()).toEqual([])
    expect(divergences()).toEqual([])
    expect(state.rawMirrored).toBe(5)

    // a write through another client never reaches the candidate: the drift shows up
    await withMongoClient((client: any) =>
      client.db(db.connection.name).collection('posts').deleteMany({}),
    )
    await payload.find({ collection: 'posts' })
    expect(divergences().map((d) => d.method)).toEqual(['find'])
    expect((await state.diffDatabases()).length).toBeGreaterThan(0)
  })

  it('upserts on a polymorphic relationship query (server-generated ids) with zero divergences', async () => {
    const { divergences, payload } = await setup()
    const owner = await payload.create({ collection: 'posts', data: { title: 'owner' } })
    const upsert = (value: unknown) =>
      payload.db.upsert({
        collection: 'prefs',
        data: { key: 'k', user: { relationTo: 'posts', value: owner.id }, value },
        req: {},
        where: {
          and: [
            { key: { equals: 'k' } },
            { 'user.value': { equals: owner.id } },
            { 'user.relationTo': { equals: 'posts' } },
          ],
        },
      })
    await upsert({ a: 1 })
    await upsert({ a: 2 })
    await payload.find({ collection: 'prefs' })
    expect(await getMongoShadowState(payload.db)!.diffDatabases()).toEqual([])
    expect(divergences()).toEqual([])
    expect(getMongoShadowState(payload.db)!.serverIDsAligned).toBe(1)
  })

  it('maps transactions (commit + rollback) with zero divergences', async () => {
    const { divergences, payload } = await setup()
    await payload.create({ collection: 'posts', data: { title: 'committed' } })
    await expect(
      payload.create({
        collection: 'posts',
        data: { failAfterChange: true, title: 'rolled back' },
      }),
    ).rejects.toThrow('afterChange failure')
    const { docs } = await payload.find({ collection: 'posts' })
    expect(docs.map((d) => d.title)).toEqual(['committed'])
    expect(await getMongoShadowState(payload.db)!.diffDatabases()).toEqual([])
    expect(divergences()).toEqual([])
  })

  it('keeps the candidate on its own connection when a test restores a replaced one', async () => {
    const { candidate, divergences, payload } = await setup()
    const db = payload.db as unknown as Record<string, unknown>
    const original = db.connection
    const candidateConnection = candidate().connection
    db.connection = {
      getClient: () => ({
        startSession: () => {
          throw new Error('connection refused')
        },
      }),
    }
    await expect(payload.db.beginTransaction()).rejects.toThrow('connection refused')
    db.connection = original
    expect(candidate().connection).toBe(candidateConnection)
    await payload.create({ collection: 'posts', data: { title: 'after restore' } })
    expect(divergences()).toEqual([])
  })

  it('never equates typed values with user data spelled like their markers', () => {
    const { ObjectId } = mongoose.Types
    const diff = (a: unknown, b: unknown) => compareMongoValues(toComparable(a), toComparable(b))
    const id = new ObjectId()
    expect(diff({ v: id }, { v: { $oid: id.toHexString() } })).toEqual([
      expect.objectContaining({ kind: 'missingKey', path: 'v.$oid' }),
      expect.objectContaining({ kind: 'extraKey', path: 'v.$obj' }),
    ])
    expect(diff({ v: /a/ }, { v: { $regex: { flags: '', source: 'a' } } })).not.toEqual([])
    expect(diff({ v: new Date(0) }, { v: { $date: new Date(0).toISOString() } })).not.toEqual([])
    // a plain object carrying `_bsontype` is not a bson value
    const forged = { _bsontype: 'ObjectId', toHexString: () => id.toHexString() }
    expect(diff({ v: id }, { v: forged })).not.toEqual([])
    expect(toComparable({ v: forged })).toEqual({
      v: { _bsontype: 'ObjectId', toHexString: { $function: { length: 0, name: 'toHexString' } } },
    })
    // functions differ by name / length, -0 differs from 0
    expect(diff({ f: function a() {} }, { f: function b() {} })).toHaveLength(1)
    expect(diff({ n: -0 }, { n: 0 })).toHaveLength(1)
    // argument identity: the caller's very object vs an equal copy
    const where = { title: { equals: 'x' } }
    const identities = new Map<unknown, string>([[where, '0.where']])
    expect(
      compareMongoValues(
        toComparable({ where }, { identities }),
        toComparable({ where: { title: { equals: 'x' } } }, { identities }),
      ),
    ).toEqual([
      expect.objectContaining({ kind: 'missingKey', path: 'where.$arg' }),
      expect.objectContaining({ kind: 'missingKey', path: 'where.value' }),
      expect.objectContaining({ kind: 'extraKey', path: 'where.title' }),
    ])
    // prototypes: equally named, distinct classes differ
    const makeClass = () =>
      class Same {
        x = 1
      }
    const [A, B] = [makeClass(), makeClass()]
    expect(
      compareMongoValues(
        toComparable(new A(), { prototypes: true }),
        toComparable(new B(), { prototypes: true }),
      ),
    ).toEqual([expect.objectContaining({ path: '$proto' })])
    // class instances: own keys cannot impersonate the class marker
    class Point {
      constructor(public x: number) {}
    }
    expect(diff(new Point(1), { $class: 'Point', value: { x: 1 } })).not.toEqual([])
    // no SQL table-alias rule: different snake-cased uuids differ
    expect(
      diff('x 0123abcd_0000_4000_8000_000000000001 y', 'x 0123abcd_0000_4000_8000_000000000002 y'),
    ).toHaveLength(1)
    // a differing Date is never tolerated outside lifecycle windows
    expect(diff({ at: new Date(1000) }, { at: new Date(1001) })).toHaveLength(1)
  })

  it('applies the lifecycle timestamp rule to Dates and to their ISO strings only', () => {
    // a lifecycle pair: reference window [1000, 1010], candidate window [2000, 2010]
    const isNowPair = (reference: number, candidate: number) =>
      reference >= 1000 && reference <= 1010 && candidate >= 2000 && candidate <= 2010
    const diff = (a: unknown, b: unknown) =>
      compareMongoValues(toComparable(a), toComparable(b), { isNowPair })
    const iso = (ms: number) => new Date(ms).toISOString()
    expect(diff({ at: new Date(1005) }, { at: new Date(2005) })).toEqual([])
    // db-mongodb's read transform returns the stamps as ISO strings
    expect(diff({ at: iso(1005) }, { at: iso(2005) })).toEqual([])
    // outside the windows, swapped sides, other spellings, a Date vs its string: differ
    expect(diff({ at: iso(1005) }, { at: iso(3000) })).toHaveLength(1)
    expect(diff({ at: iso(2005) }, { at: iso(1005) })).toHaveLength(1)
    expect(diff({ at: '1970-01-01T00:00:01.005' }, { at: '1970-01-01T00:00:02.005' })).toHaveLength(
      1,
    )
    expect(diff({ at: iso(1005) }, { at: new Date(2005) })).toHaveLength(1)
  })

  it('applies the lifecycle rule to ObjectId time bytes only (seconds, inside the windows)', () => {
    const { ObjectId } = mongoose.Types
    // a lifecycle pair: reference seconds [100, 101], candidate seconds [200, 201]
    const isNowSecondPair = (reference: number, candidate: number) =>
      reference >= 100 && reference <= 101 && candidate >= 200 && candidate <= 201
    const diff = (a: unknown, b: unknown) =>
      compareMongoValues(toComparable(a), toComparable(b), { isNowSecondPair })
    const id = (seconds: number, rest = '0123456789abcdef') =>
      `${seconds.toString(16).padStart(8, '0')}${rest}`
    expect(diff({ v: new ObjectId(id(100)) }, { v: new ObjectId(id(200)) })).toEqual([])
    expect(diff({ v: id(101) }, { v: id(201) })).toEqual([])
    // other bytes, outside the windows, swapped sides: differ
    expect(diff({ v: id(100) }, { v: id(200, '0123456789abcde0') })).toHaveLength(1)
    expect(diff({ v: id(100) }, { v: id(300) })).toHaveLength(1)
    expect(diff({ v: id(200) }, { v: id(100) })).toHaveLength(1)
  })

  it('keeps the prototype of null-prototype arguments in the candidate copy (graphql where)', async () => {
    const { divergences, payload } = await setup()
    const where = Object.assign(Object.create(null), { title: { equals: 'x' } })
    await payload.find({ collection: 'posts', where })
    expect(divergences()).toEqual([])
  })

  it('detects argument mutations the candidate does not make (and extra ones)', async () => {
    const { divergences, payload } = await setup({
      candidate: (adapter) => {
        const { create, find } = adapter
        // copies `data`: upstream's in-place mutations never reach the caller's object
        adapter.create = function (args: Record<string, any>) {
          return create.call(this, { ...args, data: { ...args.data } })
        }
        adapter.find = function (args: Record<string, any>) {
          args.extra = true
          return find.call(this, args)
        }
      },
    })
    await payload.create({ collection: 'posts', data: { title: 'mutated' } })
    await payload.find({ collection: 'posts' })
    const byMethod = (m: string) => divergences().filter((d) => d.method === m)
    expect(byMethod('create')).toHaveLength(1)
    const create = byMethod('create')[0]!.differences
    expect(create.length).toBeGreaterThan(0)
    // the data upstream mutates is the caller's: differs after the call, before the first await
    // and at every driver operation
    expect(
      create.every(
        (d) =>
          d.path.startsWith('$args[0].data') ||
          d.path.startsWith('$firstAwait[0].data') ||
          /^\$events\[\d+\]\.(state|args)/.test(d.path),
      ),
    ).toBe(true)
    expect(create.some((d) => d.path.startsWith('$args[0].data'))).toBe(true)
    expect(create.some((d) => d.path.startsWith('$firstAwait[0].data'))).toBe(true)
    expect(untraced(byMethod('find')[0]!.differences)).toEqual([
      expect.objectContaining({ kind: 'extraKey', path: '$args[0].extra' }),
    ])
  })

  it('detects argument identity, mutation timing and driver call order the results do not show', async () => {
    const { divergences, payload } = await setup({
      candidate: (adapter) => {
        const { count, create, find } = adapter
        // the same where, but an equal copy instead of the caller's object
        adapter.find = function (args: Record<string, any>) {
          args.where = JSON.parse(JSON.stringify(args.where))
          return find.call(this, args)
        }
        // the same mutations, but after an await upstream does not make
        adapter.create = async function (args: unknown) {
          await Promise.resolve()
          return create.call(this, args)
        }
        // the same result, but with an extra driver operation first
        adapter.count = async function (args: unknown) {
          await this.collections.posts.collection.estimatedDocumentCount()
          return count.call(this, args)
        }
      },
    })
    await payload.create({ collection: 'posts', data: { title: 'timing' } })
    await payload.find({ collection: 'posts', where: { title: { equals: 'timing' } } })
    await payload.count({ collection: 'posts' })
    const byMethod = (m: string) => divergences().filter((d) => d.method === m)
    const find = byMethod('find')[0]!.differences
    expect(find.some((d) => d.path.startsWith('$args[0].where'))).toBe(true)
    expect(untraced(find).every((d) => d.path.startsWith('$args[0].where'))).toBe(true)
    const create = byMethod('create')[0]!.differences
    expect(create.some((d) => d.path.startsWith('$firstAwait[0].data'))).toBe(true)
    // the final state is the same: only the timing differs
    expect(create.filter((d) => d.path.startsWith('$args'))).toEqual([])
    const count = byMethod('count')[0]!.differences
    expect(count.length).toBeGreaterThan(0)
    expect(count.every((d) => d.path.startsWith('$events'))).toBe(true)
  })

  it('detects extra and missing clock readings', async () => {
    const { divergences, payload } = await setup({
      candidate: (adapter) => {
        const { count, create } = adapter
        adapter.count = function (args: unknown) {
          Date.now()
          return count.call(this, args)
        }
        // reads its clock / ObjectId counter outside the replay: none of the recorded values
        adapter.create = function (args: unknown) {
          return outsideContexts(() => create.call(this, args))
        }
      },
    })
    await payload.count({ collection: 'posts' })
    await payload.create({ collection: 'posts', data: { title: 'clock' } })
    const byMethod = (m: string) => divergences().filter((d) => d.method === m)
    const count = byMethod('count')[0]!.differences
    expect(untraced(count)).toEqual([
      {
        candidate: { extra: 1, replayed: 0 },
        kind: 'value',
        path: '$generated.clock',
        reference: { recorded: 0 },
      },
    ])
    // the extra reading also shows in the event order (before the driver operation)
    expect(count.some((d) => d.path.startsWith('$events[0]'))).toBe(true)
    expect(byMethod('create')[0]!.differences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidate: { extra: 0, replayed: 0 },
          path: '$generated.clock',
        }),
        expect.objectContaining({ candidate: { extra: 0, replayed: 0 }, path: '$generated.incs' }),
      ]),
    )
  })

  it('concurrent mode: TS vs TS zero divergences with candidate halves overlapping', async () => {
    const { divergences, payload } = await setup({ mode: 'concurrent' })
    await exercise(payload)
    await Promise.all([
      ...Array.from({ length: 6 }, (_, i) =>
        payload.create({ collection: 'posts', data: { title: `parallel ${i}`, views: i } }),
      ),
      payload.updateGlobal({ data: { siteName: 'parallel' }, slug: 'settings' }),
    ])
    const { docs } = await payload.find({
      collection: 'posts',
      sort: 'title',
      where: { title: { like: 'parallel' } },
    })
    expect(docs).toHaveLength(6)
    await payload.update({
      collection: 'posts',
      data: { views: 100 },
      where: { title: { like: 'parallel' } },
    })
    const state = getMongoShadowState(payload.db)!
    expect(await state.diffDatabases()).toEqual([])
    expect(divergences()).toEqual([])
    expect(state.mode).toBe('concurrent')
    expect(state.overlappingCandidates).toBeGreaterThan(0)
    expect(state.orderedCandidates).toBeGreaterThan(0)
    expect(state.pairsReleased).toBe(0)
  })

  it('concurrent mode detects a wrong value and a reorder of non-tied documents', async () => {
    const { divergences, payload } = await setup({
      candidate: (adapter) => {
        const { count, find } = adapter
        adapter.count = async function (args: unknown) {
          return { totalDocs: (await count.call(this, args)).totalDocs + 1 }
        }
        adapter.find = async function (args: { sort?: unknown }) {
          const result = await find.call(this, args)
          if (args.sort === 'title') {
            result.docs.reverse()
          }
          return result
        }
      },
      mode: 'concurrent',
    })
    await Promise.all([
      payload.create({ collection: 'posts', data: { title: 'a' } }),
      payload.create({ collection: 'posts', data: { title: 'b' } }),
    ])
    expect((await payload.count({ collection: 'posts' })).totalDocs).toBe(2)
    const { docs } = await payload.find({ collection: 'posts', sort: 'title' })
    expect(docs.map((d) => d.title)).toEqual(['a', 'b'])
    expect(divergences().map((d) => d.method)).toEqual(['count', 'find'])
    expect(getMongoShadowState(payload.db)!.orderAccepted).toBe(0)
  })

  describe('concurrent mode upstream races', () => {
    const raceTest =
      'mongo shadow adapter > concurrent mode upstream races > a listed race: divergences become unshadowed upstreamRace entries'
    let shared: Awaited<ReturnType<typeof setup>> | undefined
    let isCorrupting = true

    it('a listed race: divergences become unshadowed upstreamRace entries', async () => {
      shared = await setup({
        candidate: (adapter) => {
          const { create } = adapter
          adapter.create = async function (args: { data: { title?: string } }) {
            if (isCorrupting) {
              args.data.title = `${args.data.title}!`
            }
            return create.call(this, args)
          }
        },
        mode: 'concurrent',
        upstreamRaces: { [raceTest]: 'self-test race' },
      })
      // kept for the next test (the boundary diff runs when that test makes its first call)
      instances.splice(instances.indexOf(shared.payload), 1)
      await Promise.all([
        shared.payload.create({ collection: 'posts', data: { title: 'r1' } }),
        shared.payload.create({ collection: 'posts', data: { title: 'r2' } }),
      ])
      expect(shared.divergences()).toEqual([])
      const state = getMongoShadowState(shared.payload.db)!
      expect(state.unshadowed[`upstreamRace:${raceTest}`]).toBeGreaterThan(0)
      isCorrupting = false
    })

    it('the next test starts from the reference state (candidate resynced) and is strict again', async () => {
      const { divergences, payload, records } = shared!
      instances.push(payload)
      const state = getMongoShadowState(payload.db)!
      // first call of this test: boundary diff of the race test (tolerated), then resync
      const { docs } = await payload.find({ collection: 'posts', sort: 'title' })
      expect(docs.map((doc) => doc.title)).toEqual(['r1', 'r2'])
      expect(state.racesResynced).toBe(1)
      expect(divergences()).toEqual([])
      expect(await state.diffDatabases()).toEqual([])
      expect(
        records.some(
          (r) => r.type === 'unshadowed' && r.method === 'dbState' && r.finishedTest === raceTest,
        ),
      ).toBe(true)
      // not listed: the same corruption is a divergence again
      isCorrupting = true
      await payload.create({ collection: 'posts', data: { title: 'r3' } })
      expect(divergences().map((d) => d.method)).toEqual(['create'])
    })

    it('serial mode never applies the race list', async () => {
      const { divergences, payload } = await setup({
        candidate: (adapter) => {
          adapter.count = async () => ({ totalDocs: -1 })
        },
        mode: 'serial',
        upstreamRaces: {
          'mongo shadow adapter > concurrent mode upstream races > serial mode never applies the race list':
            'self-test race',
        },
      })
      await payload.count({ collection: 'posts' })
      expect(divergences().map((d) => d.method)).toEqual(['count'])
    })
  })

  it('throws in strict mode', async () => {
    const { payload } = await setup({
      candidate: (adapter) => {
        adapter.count = () => Promise.resolve({ totalDocs: -1 })
      },
      onDivergence: 'throw',
    })
    await expect(payload.count({ collection: 'posts' })).rejects.toThrow(
      'Shadow divergence in count',
    )
  })
})
