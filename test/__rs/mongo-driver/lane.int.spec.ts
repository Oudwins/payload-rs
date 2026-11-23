/**
 * The MongoDB driver lane (packages/engine-rs/MONGO_DRIVER_CONTRACT.md) on a real server, with the
 * default engine (PAYLOAD_ENGINE unset):
 *
 * - every read method is served by the Rust driver (hit counters) and, with the lane differential
 *   in strict mode, equals the mongoose lane's result for the same call (key order, types),
 * - calls the lane must not serve (spied models, transactions, values JSON cannot carry) run on the
 *   mongoose lane, with the counters naming why,
 * - mongoose stays unopened until something touches it; indexes and collections exist anyway
 *   (created through the Rust client) and mongoose works once touched.
 *
 *     PAYLOAD_DATABASE=mongodb MONGODB_URL=... pnpm test:int --config test/__rs/mongo-harness/vitest.config.ts \
 *       test/__rs/mongo-driver/lane.int.spec.ts
 */
import type { CollectionConfig, GlobalConfig, Payload } from 'payload'

import { mongooseAdapter } from '@payloadcms/db-mongodb'
import {
  buildConfig,
  createPayloadRequest,
  getPayload,
  initTransaction,
  killTransaction,
} from 'payload'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import {
  dropDatabases,
  mongoUrlFor,
} from '../../../packages/engine-rs/scripts/mongo/mongoDatabases.mjs'
import {
  getDriverLane,
  getDriverLaneStats,
} from '../../../packages/engine-rs/src/mongo-driver/index.js'
import { isMongooseUnopened } from '../../../packages/engine-rs/src/mongo-driver/lazy.js'
import {
  refreshVerifyMode,
  verifyStats,
} from '../../../packages/engine-rs/src/mongo-driver/verify.js'

if (process.env.PAYLOAD_ENGINE) {
  throw new Error('lane.int.spec.ts runs the default engine: unset PAYLOAD_ENGINE')
}

const baseName = new URL(process.env.MONGODB_URL!).pathname.replace(/^\//, '') || 'wpblane'
const createdDatabases: string[] = []
let counter = 0
const allow = () => true

const posts: CollectionConfig = {
  slug: 'posts',
  access: { create: allow, delete: allow, read: allow, readVersions: allow, update: allow },
  fields: [
    { name: 'title', type: 'text', unique: true },
    { name: 'views', type: 'number', index: true },
    { name: 'tags', type: 'text', hasMany: true },
    { name: 'localizedTitle', type: 'text', localized: true },
    { name: 'publishedAt', type: 'date' },
    { name: 'data', type: 'json' },
    { name: 'related', type: 'relationship', relationTo: 'posts' },
    { name: 'anyRelated', type: 'relationship', hasMany: true, relationTo: ['posts', 'authors'] },
    { name: 'items', type: 'array', fields: [{ name: 'label', type: 'text' }] },
    {
      name: 'layout',
      type: 'blocks',
      blocks: [{ slug: 'quote', fields: [{ name: 'text', type: 'text' }] }],
    },
    { name: 'meta', type: 'group', fields: [{ name: 'description', type: 'text' }] },
    {
      type: 'tabs',
      tabs: [
        { name: 'seo', fields: [{ name: 'keywords', type: 'text' }] },
        { fields: [{ name: 'unnamedTabField', type: 'text' }], label: 'Other' },
      ],
    },
    { name: 'relatedBy', type: 'join', collection: 'posts', on: 'related' },
  ],
  versions: { drafts: true },
}

const authors: CollectionConfig = {
  slug: 'authors',
  access: { create: allow, read: allow },
  fields: [{ name: 'name', type: 'text' }],
}

const settings: GlobalConfig = {
  slug: 'settings',
  access: { read: allow, readVersions: allow, update: allow },
  fields: [{ name: 'siteName', type: 'text' }],
  versions: true,
}

const instances: Payload[] = []

afterEach(async () => {
  delete process.env.PAYLOAD_MONGO_DRIVER_VERIFY
  refreshVerifyMode()
  vi.restoreAllMocks()
  while (instances.length) {
    await instances.pop()!.destroy()
  }
})

afterAll(async () => {
  await dropDatabases(createdDatabases)
})

const start = async () => {
  const name = `${baseName}_ln${counter++}`
  createdDatabases.push(name)
  const config = await buildConfig({
    collections: [posts, authors],
    db: mongooseAdapter({ ensureIndexes: true, url: mongoUrlFor(name) }),
    globals: [settings],
    localization: { defaultLocale: 'en', locales: ['en', 'es'] },
    secret: 'TEST_SECRET',
    telemetry: false,
    typescript: { autoGenerate: false },
  })
  const previousDrop = process.env.PAYLOAD_DROP_DATABASE
  process.env.PAYLOAD_DROP_DATABASE = 'true'
  try {
    const payload = await getPayload({ config, cron: false, key: `wpblane-${counter}` })
    instances.push(payload)
    return payload
  } finally {
    if (previousDrop === undefined) {
      delete process.env.PAYLOAD_DROP_DATABASE
    } else {
      process.env.PAYLOAD_DROP_DATABASE = previousDrop
    }
  }
}

const served = () => ({ ...getDriverLaneStats().served })
const fallbacks = (method: string) => ({ ...(getDriverLaneStats().fallback[method] ?? {}) })
const delta = (before: Record<string, number>, after: Record<string, number>) =>
  Object.fromEntries(
    Object.keys(after)
      .map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)] as const)
      .filter(([, count]) => count > 0),
  )

const seed = async (payload: Payload) => {
  const author = await payload.create({ collection: 'authors', data: { name: 'ada' } })
  const first = await payload.create({
    collection: 'posts',
    data: {
      anyRelated: [{ relationTo: 'authors', value: author.id }],
      data: { nested: [1, 'two', { three: true }] },
      items: [{ label: 'x' }, { label: 'y' }],
      layout: [{ blockType: 'quote', text: 'q' }],
      localizedTitle: 'hello',
      meta: { description: 'd' },
      publishedAt: '2026-01-02T03:04:05.678Z',
      seo: { keywords: 'k' },
      tags: ['a', 'b'],
      title: 'first',
      unnamedTabField: 'u',
      views: 1,
    },
    locale: 'en',
  })
  await payload.update({
    collection: 'posts',
    data: { localizedTitle: 'hola' },
    id: first.id,
    locale: 'es',
  })
  for (let i = 0; i < 12; i++) {
    await payload.create({
      collection: 'posts',
      data: { related: first.id, title: `post ${i}`, views: i },
    })
  }
  await payload.create({
    collection: 'posts',
    data: { title: 'draft one', views: 99 },
    draft: true,
  })
  await payload.updateGlobal({ data: { siteName: 'site' }, slug: 'settings' })
  return { author, first }
}

describe('driver lane', () => {
  it('serves every read method from the Rust driver, equal to the mongoose lane', async () => {
    const payload = await start()
    expect(getDriverLane(payload.db)).toBeDefined()
    const { first } = await seed(payload)
    process.env.PAYLOAD_MONGO_DRIVER_VERIFY = 'strict'
    refreshVerifyMode()
    const divergentBefore = Object.values(verifyStats.divergent).reduce((a, b) => a + b, 0)
    const before = served()

    await payload.find({ collection: 'posts', depth: 0, limit: 5 })
    await payload.find({ collection: 'posts', depth: 0, limit: 5, page: 2 })
    await payload.find({ collection: 'posts', depth: 0, limit: 0 })
    await payload.find({ collection: 'posts', depth: 0, pagination: false })
    await payload.find({ collection: 'posts', depth: 1, limit: 3, sort: '-views' })
    await payload.find({ collection: 'posts', depth: 0, sort: ['title', '-createdAt'] })
    await payload.find({ collection: 'posts', depth: 0, select: { meta: true, title: true } })
    await payload.find({ collection: 'posts', depth: 0, locale: 'all' })
    await payload.find({ collection: 'posts', depth: 0, fallbackLocale: false, locale: 'es' })
    await payload.find({
      collection: 'posts',
      depth: 0,
      where: {
        and: [
          { views: { greater_than_equal: 2 } },
          { or: [{ title: { like: 'post' } }, { tags: { in: ['a'] } }] },
        ],
      },
    })
    await payload.find({ collection: 'posts', depth: 0, where: { related: { equals: first.id } } })
    await payload.find({ collection: 'posts', depth: 0, where: { related: { exists: false } } })
    await payload.find({
      collection: 'posts',
      depth: 0,
      where: { 'related.title': { equals: 'first' } },
    })
    await payload.find({ collection: 'posts', depth: 0, sort: 'related.title' })
    await payload.find({
      collection: 'posts',
      depth: 0,
      joins: { relatedBy: { limit: 2, sort: '-views' } },
      where: { id: { equals: first.id } },
    })
    await payload.findByID({ collection: 'posts', depth: 0, id: first.id })
    await payload.findByID({ collection: 'posts', depth: 2, id: first.id, locale: 'all' })
    await payload.findByID({ collection: 'posts', depth: 0, id: first.id, select: { title: true } })
    await payload.count({ collection: 'posts' })
    await payload.count({ collection: 'posts', where: { views: { less_than: 5 } } })
    await payload.find({ collection: 'posts', depth: 0, draft: true, limit: 50 })
    await payload.findVersions({ collection: 'posts', depth: 0, limit: 5 })
    await payload.countVersions({ collection: 'posts' })
    await payload.findGlobal({ depth: 0, slug: 'settings' })
    await payload.findGlobalVersions({ depth: 0, limit: 5, slug: 'settings' })
    await payload.countGlobalVersions({ global: 'settings' })

    const servedNow = delta(before, served())
    for (const method of [
      'count',
      'countGlobalVersions',
      'countVersions',
      'find',
      'findGlobal',
      'findGlobalVersions',
      'findOne',
      'findVersions',
      'queryDrafts',
    ]) {
      expect(servedNow[method], `${method} served by the driver`).toBeGreaterThan(0)
    }
    expect(Object.values(verifyStats.divergent).reduce((a, b) => a + b, 0)).toBe(divergentBefore)
  })

  it('runs spied models and transactions on the mongoose lane', async () => {
    const payload = await start()
    await seed(payload)
    // authors has no join field: upstream's find calls Model.paginate
    const Model = payload.db.collections.authors
    const paginate = vi.spyOn(Model, 'paginate')
    const before = fallbacks('find')
    const result = await payload.find({ collection: 'authors', depth: 0, limit: 3 })
    expect(result.docs).toHaveLength(1)
    expect(paginate).toHaveBeenCalledTimes(1)
    expect(delta(before, fallbacks('find'))).toEqual({ 'model not pristine': 1 })
    paginate.mockRestore()

    const req = await createPayloadRequest({ payload } as Parameters<
      typeof createPayloadRequest
    >[0])
    await initTransaction(req)
    const inTransaction = fallbacks('find')
    const servedBefore = served()
    await payload.find({ collection: 'posts', depth: 0, limit: 3, req })
    expect(delta(inTransaction, fallbacks('find'))).toEqual({ transaction: 1 })
    expect(delta(servedBefore, served())).toEqual({})
    await killTransaction(req)
  })

  it('re-runs reads whose documents hold values JSON cannot carry on the mongoose lane', async () => {
    const payload = await start()
    const { first } = await seed(payload)
    const { ObjectId } = payload.db.connection.base.Types
    const raw = new ObjectId()
    await payload.db.collections.posts.collection.updateOne(
      { _id: new ObjectId(first.id) },
      { $set: { data: { raw, when: new Date(0) } } },
    )
    const before = fallbacks('findOne')
    const doc = await payload.findByID({ collection: 'posts', depth: 0, id: first.id })
    expect(doc.data.raw).toBeInstanceOf(ObjectId)
    expect(doc.data.raw.toHexString()).toBe(raw.toHexString())
    expect(doc.data.when).toBeInstanceOf(Date)
    expect(delta(before, fallbacks('findOne'))).toEqual({ 'bail: ObjectId in result': 1 })
  })

  it('keeps mongoose unopened until it is touched, with indexes built through the driver', async () => {
    process.env.PAYLOAD_MONGO_DRIVER = 'lazy'
    const payload = await start().finally(() => delete process.env.PAYLOAD_MONGO_DRIVER)
    const adapter = payload.db as unknown as Record<string, any>
    expect(getDriverLaneStats().connects.lazy).toBeGreaterThan(0)
    expect(isMongooseUnopened(adapter)).toBe(true)
    // reads and the read part of the Local API need no mongoose
    await payload.find({ collection: 'posts', depth: 0 })
    await payload.count({ collection: 'authors' })
    expect(isMongooseUnopened(adapter)).toBe(true)
    expect(Object.getOwnPropertyDescriptor(adapter, 'collections')?.get).toBeTypeOf('function')

    // touching the mongoose objects opens the connection; mongoose works from then on
    const Model = adapter.collections.posts
    expect(isMongooseUnopened(adapter)).toBe(false)
    const indexes = await Model.listIndexes()
    const names = indexes.map((index: { name: string }) => index.name)
    expect(names).toEqual(expect.arrayContaining(['_id_', 'title_1', 'views_1']))
    expect(indexes.find((index: { name: string }) => index.name === 'title_1').unique).toBe(true)
    await adapter.connection.asPromise()
    expect(adapter.connection.readyState).toBe(1)

    // writes (transactions on mongoose) and reads see each other
    await payload.create({ collection: 'posts', data: { title: 'after touch' } })
    const found = await payload.find({
      collection: 'posts',
      depth: 0,
      where: { title: { equals: 'after touch' } },
    })
    expect(found.totalDocs).toBe(1)
    await expect(
      payload.create({ collection: 'posts', data: { title: 'after touch' } }),
    ).rejects.toThrow()
  })
})
