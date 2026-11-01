/**
 * Self-test of the MongoDB shadow adapter (packages/engine-rs/src/shadow-mongo).
 *
 * - TS vs TS gives zero divergences across all operation kinds (incl. transactions, upserts with
 *   server-generated ids, raw collection writes, geo/regex queries).
 * - Deliberately broken candidates are detected (values, key order, ObjectId vs string, RegExp,
 *   thrown errors, database state) while the caller still receives the reference result.
 *
 *   PAYLOAD_DATABASE=mongodb MONGODB_URL='mongodb://payload:payload@localhost:27018/<db>?authSource=admin&directConnection=true&replicaSet=rs0' \
 *     pnpm test:int --config test/__rs/mongo-harness/vitest.config.ts test/__rs/mongo-harness/shadow.int.spec.ts
 *
 * Instances use the databases `<db>_st<n>` / `<db>_st<n>c`, dropped afterwards.
 */
import type { CollectionConfig, DatabaseAdapterObj, GlobalConfig, Payload } from 'payload'

import { mongooseAdapter } from '@payloadcms/db-mongodb'
import mongoose from 'mongoose'
import { buildConfig, getPayload } from 'payload'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import type { ShadowRecord } from '../../../packages/engine-rs/src/shadow-mongo/index.js'

import {
  dropDatabases,
  mongoUrlFor,
  withMongoClient,
} from '../../../packages/engine-rs/scripts/mongo/mongoDatabases.mjs'
import { compareValues } from '../../../packages/engine-rs/src/shadow/compare.js'
import {
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
  onDivergence?: 'record' | 'throw'
}

const instances: Payload[] = []

afterEach(async () => {
  while (instances.length) {
    await instances.pop()!.destroy()
  }
})

afterAll(async () => {
  await dropDatabases(createdDatabases)
})

/** A payload whose db is a shadow adapter over two fresh databases. */
async function setup({ candidate, onDivergence }: Setup = {}) {
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
    onDivergence,
    reference: make(''),
    report: {
      context: await loadContext(),
      file: `/tmp/rs-mongo-shadow-selftest-${process.pid}-${id}.jsonl`,
      onRecord: (r) => records.push(r),
    },
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
    expect(byMethod('updateOne')[0]!.differences).toEqual([
      expect.objectContaining({
        candidate: expect.objectContaining({ message: 'candidate boom' }),
        kind: 'type',
        path: '$threw',
      }),
    ])
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
        reference: { $oid: a.id },
      }),
    ])
  })

  it('compares RegExp, Decimal128, Binary and Buffer values by type and content', () => {
    const { Binary, Decimal128 } = mongoose.mongo
    const diff = (a: unknown, b: unknown) => compareValues(toComparable(a), toComparable(b))
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
