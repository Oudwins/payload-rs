/**
 * `withRustMongoEngine` on the live engine (packages/engine-rs/src/mongo-adapter/live.ts):
 *
 * - every data method of the adapter is the live Rust port (no copy of the arguments), proven by
 *   the addon's own call counters, except the collection writes of `upstreamWriteMethods`, which
 *   stay upstream's db-mongodb methods (owner decision 2026-11-24);
 * - shadow differential, serial and concurrent mode: reference = upstream TS adapter, candidate =
 *   `withRustMongoEngine(mongooseAdapter(args))` on a second database; zero divergences required
 *   (results, thrown errors, argument mutations, generated values, database state).
 *
 *   PAYLOAD_ENGINE_ADDON=/tmp/liveglue-addon/payload-engine.node PAYLOAD_DATABASE=mongodb \
 *   MONGODB_URL='mongodb://payload:payload@localhost:27018/<db>?authSource=admin&directConnection=true&replicaSet=rs0' \
 *     pnpm test:int --config test/__rs/mongo-harness/vitest.config.ts test/__rs/mongo-adapter/live.int.spec.ts
 *
 * Databases `<db>_lv<n>` / `<db>_lv<n>c`, dropped afterwards.
 */
import type { CollectionConfig, DatabaseAdapterObj, GlobalConfig, Payload } from 'payload'

import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { buildConfig, getPayload } from 'payload'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import type { ShadowRecord } from '../../../packages/engine-rs/src/shadow-mongo/index.js'

import {
  dropDatabases,
  mongoUrlFor,
} from '../../../packages/engine-rs/scripts/mongo/mongoDatabases.mjs'
import {
  getRustMongoEngineStats,
  isRustMongoEngineAdapter,
  mongoEngineMethods,
  upstreamWriteMethods,
  withRustMongoEngine,
} from '../../../packages/engine-rs/src/mongo-adapter/index.js'
import {
  getLiveEngineCalls,
  getMongoLiveWrite,
} from '../../../packages/engine-rs/src/mongo-adapter/live.js'
import { getDriverLaneStats } from '../../../packages/engine-rs/src/mongo-driver/index.js'
import {
  createMongoShadowAdapter,
  getMongoShadowState,
} from '../../../packages/engine-rs/src/shadow-mongo/index.js'
import { loadContext } from '../mongo-harness/shadowDatabaseAdapter.js'

const baseName = new URL(process.env.MONGODB_URL!).pathname.replace(/^\//, '') || 'liveglue'
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
    { name: 'relatedBy', type: 'join', collection: 'posts', on: 'related' },
  ],
  versions: { drafts: true },
}

const settings: GlobalConfig = {
  slug: 'settings',
  access: { read: allow, readVersions: allow, update: allow },
  fields: [{ name: 'siteName', type: 'text' }],
  versions: true,
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

const dbURL = (suffix: string) => {
  const name = `${baseName}_lv${counter}${suffix}`
  createdDatabases.push(name)
  return mongoUrlFor(name)
}

const start = async (db: DatabaseAdapterObj) => {
  const config = await buildConfig({
    collections: [posts],
    db,
    globals: [settings],
    localization: { defaultLocale: 'en', locales: ['en', 'es'] },
    secret: 'TEST_SECRET',
    telemetry: false,
    typescript: { autoGenerate: false },
  })
  const previousDrop = process.env.PAYLOAD_DROP_DATABASE
  process.env.PAYLOAD_DROP_DATABASE = 'true'
  try {
    const payload = await getPayload({ config, cron: false, key: `liveglue-${counter}` })
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

/** Every adapter data method through the Local API (sequential and concurrent). */
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
      payload.create({
        collection: 'posts',
        data: { related: a.id, title: `concurrent ${i}`, views: 10 },
      }),
    ),
  )
  await payload.find({
    collection: 'posts',
    sort: '-views',
    where: { views: { greater_than_equal: 1 } },
  })
  await payload.find({ collection: 'posts', where: { title: { like: 'CONC' } } })
  // with a join field upstream's find aggregates, where $near is not allowed: both sides throw
  await payload.find({ collection: 'posts', where: { location: { near: '10,20,100000,0' } } }).then(
    () => {
      throw new Error('near in an aggregation should throw')
    },
    () => undefined,
  )
  await payload.find({ collection: 'posts', where: { 'related.title': { equals: 'first' } } })
  await payload.findByID({
    id: a.id,
    collection: 'posts',
    depth: 1,
    joins: { relatedBy: { limit: 3, sort: 'title' } },
  })
  await payload.findByID({ id: b.id, collection: 'posts', depth: 1 })
  await payload.count({ collection: 'posts' })
  await payload.findDistinct({ collection: 'posts', field: 'title', sort: 'title' })
  await payload.update({ id: a.id, collection: 'posts', data: { title: 'first!' } })
  await payload.update({
    id: a.id,
    collection: 'posts',
    data: { localizedTitle: 'uno' },
    locale: 'es',
  })
  await payload.update({
    collection: 'posts',
    data: { views: 5 },
    where: { views: { equals: 10 } },
  })
  await payload.update({ id: a.id, collection: 'posts', data: { title: 'draft' }, draft: true })
  await payload.find({ collection: 'posts', draft: true, sort: 'title' })
  await payload.findVersions({ collection: 'posts', sort: '-updatedAt' })
  await payload.countVersions({ collection: 'posts' })
  await payload.updateGlobal({ data: { siteName: 'site' }, slug: 'settings' })
  await payload.findGlobal({ slug: 'settings' })
  await payload.findGlobalVersions({ slug: 'settings' })
  await payload.countGlobalVersions({ global: 'settings' })
  await payload.db.upsert({
    collection: 'posts',
    data: { title: 'upserted' },
    req: {},
    where: { title: { equals: 'upserted' } },
  })
  await payload.db.upsert({
    collection: 'posts',
    data: { title: 'upserted', views: 7 },
    req: {},
    where: { title: { equals: 'upserted' } },
  })
  await payload.delete({ id: b.id, collection: 'posts' })
  await payload.delete({ collection: 'posts', where: { views: { equals: 5 } } })
}

describe('withRustMongoEngine (live engine)', () => {
  it('serves every data method and model building with the live Rust ports', async () => {
    counter++
    const liveInitBefore = getRustMongoEngineStats().liveInit
    const payload = await start(
      withRustMongoEngine(
        mongooseAdapter({ ensureIndexes: true, url: dbURL('') }),
      ) as DatabaseAdapterObj,
    )
    expect(isRustMongoEngineAdapter(payload.db)).toBe(true)
    const stats = getRustMongoEngineStats()
    // model building is the live port by default
    expect(stats.liveInit - liveInitBefore).toBe(1)
    expect(payload.db.init.toString()).toContain('getMongoLiveSchema()')
    expect(stats.upstreamMethods).toEqual([...upstreamWriteMethods].sort())
    expect([...stats.liveMethods, ...stats.upstreamMethods].sort()).toEqual(
      [...mongoEngineMethods].sort(),
    )
    // reads outside transactions are served by the Rust driver lane (mongo-driver), the others by
    // the live engine's methods: both are Rust
    const before = getLiveEngineCalls()
    const driverBefore = { ...getDriverLaneStats().served }
    await exercise(payload)
    const after = getLiveEngineCalls()
    const driverAfter = getDriverLaneStats().served
    const served = (method: string) =>
      (after[method] ?? 0) -
      (before[method] ?? 0) +
      (driverAfter[method] ?? 0) -
      (driverBefore[method] ?? 0)
    for (const method of [
      'find',
      'findOne',
      'count',
      'findDistinct',
      'upsert',
      'findVersions',
      'createGlobal',
      'findGlobal',
      'queryDrafts',
    ]) {
      expect(served(method), method).toBeGreaterThan(0)
    }
    // the live write methods are the live write binding's own functions, the others upstream's
    const writes = getMongoLiveWrite()!
    for (const method of ['upsert', 'updateJobs', 'createGlobal', 'updateGlobal']) {
      expect(payload.db[method], method).toBe(writes[method])
    }
    for (const method of upstreamWriteMethods) {
      expect(payload.db[method], method).not.toBe(writes[method])
      expect(served(method), method).toBe(0)
    }
    expect(payload.db.create.name).toBe('create')
  })

  for (const mode of ['serial', 'concurrent'] as const) {
    it(`shadow (${mode}): TS reference vs live Rust candidate, zero divergences`, async () => {
      counter++
      const records: ShadowRecord[] = []
      const db = createMongoShadowAdapter({
        candidate: withRustMongoEngine(mongooseAdapter({ ensureIndexes: true, url: dbURL('c') })),
        mode,
        reference: mongooseAdapter({ ensureIndexes: true, url: dbURL('') }),
        report: {
          context: await loadContext(),
          file: `/tmp/liveglue-live-shadow-${process.pid}-${counter}.jsonl`,
          onRecord: (r) => records.push(r),
        },
      }) as DatabaseAdapterObj
      const payload = await start(db)
      const rustCalls = () =>
        [
          ...Object.values(getLiveEngineCalls()),
          ...Object.values(getDriverLaneStats().served),
        ].reduce((x, y) => x + y, 0)
      const before = rustCalls()
      await exercise(payload)
      // the candidate really ran on the Rust engine (live methods and driver lane)
      expect(rustCalls() - before).toBeGreaterThan(40)
      const state = getMongoShadowState(payload.db)!
      await state.diffDatabases()
      expect(records.filter((r) => r.type === 'divergence')).toEqual([])
      expect(state.calls).toBeGreaterThan(40)
      expect(state.unshadowed).toEqual({})
    })
  }

  it('shadow (serial): models built by the live init port by default, zero divergences', async () => {
    counter++
    {
      const liveInitBefore = getRustMongoEngineStats().liveInit
      const records: ShadowRecord[] = []
      const db = createMongoShadowAdapter({
        candidate: withRustMongoEngine(mongooseAdapter({ ensureIndexes: true, url: dbURL('c') })),
        mode: 'serial',
        reference: mongooseAdapter({ ensureIndexes: true, url: dbURL('') }),
        report: {
          context: await loadContext(),
          file: `/tmp/liveglue-live-shadow-${process.pid}-${counter}.jsonl`,
          onRecord: (r) => records.push(r),
        },
      }) as DatabaseAdapterObj
      const payload = await start(db)
      expect(getRustMongoEngineStats().liveInit - liveInitBefore).toBe(1)
      await exercise(payload)
      const state = getMongoShadowState(payload.db)!
      await state.diffDatabases()
      expect(records.filter((r) => r.type === 'divergence')).toEqual([])
      expect(state.calls).toBeGreaterThan(40)
    }
  })
})
