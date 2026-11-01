/**
 * Differential check of `withRustEngine` against the upstream TS sqlite adapter.
 *
 * Two Payload instances with the same config and their own database files run the same scripted
 * operations under the same faked clock: `reference` uses `sqliteAdapter(args)`, `candidate` uses
 * `withRustEngine(sqliteAdapter(args))`. Every result and every error (class, own properties,
 * cause chain) must be identical. Runs against the native engine, or against the TS loopback
 * engine with PAYLOAD_RS_ENGINE_LOOPBACK=true (then it verifies the glue alone):
 *
 *   PAYLOAD_ENGINE_ADDON=/tmp/x/payload-engine.node [PAYLOAD_RS_ENGINE_LOOPBACK=true] \
 *     SQLITE_URL=file:/tmp/rs-adapter.db pnpm test:int:sqlite test/__rs/adapter/adapter.int.spec.ts
 */
import type { Payload, PayloadRequest, SanitizedConfig } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { sql } from '@payloadcms/db-sqlite/drizzle'
import { rmSync } from 'node:fs'
import {
  buildConfig,
  commitTransaction,
  getPayload,
  initTransaction,
  killTransaction,
} from 'payload'
import { afterAll, beforeAll, expect, vi } from 'vitest'

import {
  getRustEngineStats,
  isRustEngineAdapter,
  withRustEngine,
} from '../../../packages/engine-rs/src/index.js'
import { Sqlite3Client } from '../../../packages/engine-rs/src/sqlite/index.js'
import { test } from '../../__helpers/int/vitest.js'

const base = (process.env.SQLITE_URL || 'file:/tmp/rs-adapter.db')
  .replace(/^file:/, '')
  .replace(/\.db$/, '')
const files = {
  candidate: `${base}.adapter-candidate.db`,
  reference: `${base}.adapter-reference.db`,
}

const removeDatabases = () => {
  for (const file of Object.values(files)) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      rmSync(`${file}${suffix}`, { force: true })
    }
  }
}

const access = { create: () => true, delete: () => true, read: () => true, update: () => true }

const makeConfig = (db: ReturnType<typeof sqliteAdapter> | SanitizedConfig['db']) =>
  buildConfig({
    collections: [
      {
        slug: 'posts',
        access,
        fields: [
          { name: 'title', type: 'text', required: true, unique: true },
          { name: 'views', type: 'number' },
          { name: 'tags', type: 'array', fields: [{ name: 'tag', type: 'text' }] },
          { name: 'meta', type: 'json' },
          { name: 'related', type: 'relationship', hasMany: true, relationTo: 'posts' },
          {
            name: 'layout',
            type: 'blocks',
            blocks: [
              { slug: 'hero', fields: [{ name: 'heading', type: 'text', localized: true }] },
            ],
          },
          { name: 'publishedAt', type: 'date' },
          { name: 'localizedTitle', type: 'text', localized: true },
          { name: 'select', type: 'select', hasMany: true, options: ['a', 'b', 'c'] },
        ],
        versions: { drafts: true },
      },
      {
        slug: 'strict',
        access,
        fields: [{ name: 'code', type: 'text', required: true }],
      },
      {
        slug: 'categories',
        access,
        fields: [
          { name: 'name', type: 'text' },
          { name: 'posts', type: 'join', collection: 'posts', on: 'related' },
        ],
      },
    ],
    db: db as SanitizedConfig['db'],
    globals: [
      {
        slug: 'settings',
        access: { read: () => true, update: () => true },
        fields: [{ name: 'siteName', type: 'text', localized: true }],
        versions: true,
      },
    ],
    localization: { defaultLocale: 'en', fallback: true, locales: ['en', 'de'] },
    secret: 'rs-adapter',
  })

type Side = 'candidate' | 'reference'

const instances = {} as Record<Side, Payload>

const OBJECT_ID = /^[0-9a-f]{24}$/
const ISO_DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/

/**
 * Diagnostic only: PAYLOAD_RS_ADAPTER_IGNORE_CLOCK=true masks ISO timestamps, to look past the
 * known engine gap (it stamps with its own clock instead of the JS one, ENGINE_STATUS.md).
 */
const isClockIgnored = process.env.PAYLOAD_RS_ADAPTER_IGNORE_CLOCK === 'true'

/** Comparable description of a value: class names, own keys in order, errors with their causes. */
const describe = (value: unknown, seen = new Set<unknown>()): unknown => {
  if (value instanceof Error) {
    const own: Record<string, unknown> = {}
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key !== 'stack') {
        own[key] = describe((value as unknown as Record<string, unknown>)[key], seen)
      }
    }
    return { $error: Object.getPrototypeOf(value).constructor.name, name: value.name, own }
  }
  if (value instanceof Date) {
    return { $date: value.toISOString() }
  }
  if (isClockIgnored && typeof value === 'string' && ISO_DATE.test(value)) {
    return '<date>'
  }
  if (typeof value === 'string' && OBJECT_ID.test(value)) {
    // array / block row ids come from one process-wide ObjectId counter shared by both sides
    return '<objectid>'
  }
  if (typeof value !== 'object' || value === null) {
    return value === undefined ? { $undefined: true } : value
  }
  if (seen.has(value)) {
    return '[cycle]'
  }
  seen.add(value)
  const out = Array.isArray(value)
    ? value.map((item) => describe(item, seen))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, describe(item, seen)]))
  seen.delete(value)
  return out
}

/** Runs `operation` on both instances at the same faked time; returns both descriptions. */
const both = async (operation: (payload: Payload) => Promise<unknown>) => {
  const out = {} as Record<Side, unknown>
  for (const side of ['reference', 'candidate'] as const) {
    vi.setSystemTime(new Date('2026-01-02T03:04:05.678Z'))
    try {
      out[side] = { ok: describe(await operation(instances[side])) }
    } catch (error) {
      out[side] = { error: describe(error) }
    }
  }
  return out
}

const expectSame = async (operation: (payload: Payload) => Promise<unknown>) => {
  const { candidate, reference } = await both(operation)
  expect(candidate).toEqual(reference)
  return reference as { error?: unknown; ok?: unknown }
}

test.suite('withRustEngine', {}, () => {
  beforeAll(async () => {
    removeDatabases()
    vi.useFakeTimers({ toFake: ['Date'] })
    const previousForce = process.env.PAYLOAD_FORCE_DRIZZLE_PUSH
    // each instance has its own database file: never skip the push via drizzle's process cache
    process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = 'true'
    try {
      const args = (file: string) => ({ client: { url: `file:${file}` }, transactionOptions: {} })
      instances.reference = await getPayload({
        config: makeConfig(sqliteAdapter(args(files.reference))),
        key: 'rs-adapter-reference',
      })
      instances.candidate = await getPayload({
        config: makeConfig(withRustEngine(sqliteAdapter(args(files.candidate)))),
        key: 'rs-adapter-candidate',
      })
    } finally {
      if (previousForce === undefined) {
        delete process.env.PAYLOAD_FORCE_DRIZZLE_PUSH
      } else {
        process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = previousForce
      }
    }
  })

  afterAll(async () => {
    vi.useRealTimers()
    await instances.reference?.destroy()
    await instances.candidate?.destroy()
    removeDatabases()
  })

  test('should run the candidate on the Rust client and engine', () => {
    expect(isRustEngineAdapter(instances.candidate.db)).toBe(true)
    expect(isRustEngineAdapter(instances.reference.db)).toBe(false)
    expect((instances.candidate.db as unknown as { client: unknown }).client).toBeInstanceOf(
      Sqlite3Client,
    )
    expect((instances.reference.db as unknown as { client: unknown }).client).not.toBeInstanceOf(
      Sqlite3Client,
    )
  })

  const pickSchema = (payload: Payload) => {
    const db = payload.db as unknown as Record<string, any>
    return describe({
      fieldConstraints: db.fieldConstraints,
      foreignKeys: [...db.foreignKeys],
      indexes: [...db.indexes],
      rawRelations: db.rawRelations,
      rawTables: db.rawTables,
      tableNameMap: [...db.tableNameMap],
      tables: Object.keys(db.tables),
    })
  }

  const dropUndefined = (value: unknown): unknown =>
    JSON.parse(
      JSON.stringify(value, (_key, item) => (item?.$undefined === true ? undefined : item)),
    )

  test('should build the same raw schema and drizzle tables', () => {
    expect(dropUndefined(pickSchema(instances.candidate))).toEqual(
      dropUndefined(pickSchema(instances.reference)),
    )
  })

  // Engine gap (ENGINE_STATUS.md): `rawSchema()` JSON drops own properties holding `undefined`
  // (e.g. `rawTables[t].indexes[i].unique`), which upstream keeps. Flips to failing once fixed.
  test.fails('should keep own undefined properties of the raw schema', () => {
    expect(pickSchema(instances.candidate)).toEqual(pickSchema(instances.reference))
  })

  test('should create, read, update and delete identically', async () => {
    const callsBefore = Object.values(getRustEngineStats().calls).reduce((a, b) => a + b, 0)

    await expectSame((payload) =>
      payload.create({
        collection: 'posts',
        data: {
          layout: [{ blockType: 'hero', heading: 'Hello' }],
          localizedTitle: 'Hallo',
          meta: { nested: [1, 'two', { three: true }] },
          publishedAt: new Date('2025-05-05T05:05:05.000Z').toISOString(),
          select: ['a', 'c'],
          tags: [{ tag: 'x' }, { tag: 'y' }],
          title: 'first',
          views: 3,
        },
      }),
    )
    await expectSame((payload) =>
      payload.create({ collection: 'posts', data: { related: [1], title: 'second', views: 10 } }),
    )
    await expectSame((payload) =>
      payload.create({ collection: 'categories', data: { name: 'c1' } }),
    )
    await expectSame((payload) =>
      payload.update({
        id: 1,
        collection: 'posts',
        data: { localizedTitle: 'Hallo DE' },
        locale: 'de',
      }),
    )
    await expectSame((payload) =>
      payload.find({ collection: 'posts', depth: 2, locale: 'all', sort: '-views' }),
    )
    await expectSame((payload) =>
      payload.find({
        collection: 'posts',
        limit: 1,
        page: 2,
        select: { tags: true, title: true },
        where: { or: [{ views: { greater_than: 1 } }, { 'tags.tag': { equals: 'x' } }] },
      }),
    )
    await expectSame((payload) =>
      payload.find({ collection: 'posts', where: { 'related.title': { like: 'fir' } } }),
    )
    await expectSame((payload) =>
      payload.count({ collection: 'posts', where: { views: { exists: true } } }),
    )
    await expectSame((payload) =>
      payload.findDistinct({ collection: 'posts', field: 'title', sort: 'title' }),
    )
    await expectSame((payload) => payload.findByID({ id: 2, collection: 'posts', depth: 0 }))
    await expectSame((payload) =>
      payload.update({
        collection: 'posts',
        data: { views: 7 },
        where: { title: { in: ['first', 'second'] } },
      }),
    )
    await expectSame((payload) =>
      payload.update({ id: 1, collection: 'posts', data: { title: 'draft-title' }, draft: true }),
    )
    await expectSame((payload) => payload.find({ collection: 'posts', draft: true }))
    await expectSame((payload) => payload.findVersions({ collection: 'posts', sort: 'createdAt' }))
    await expectSame((payload) => payload.countVersions({ collection: 'posts' }))
    await expectSame((payload) =>
      payload.updateGlobal({ slug: 'settings', data: { siteName: 'Site' } }),
    )
    await expectSame((payload) => payload.findGlobal({ slug: 'settings', locale: 'all' }))
    await expectSame((payload) => payload.findGlobalVersions({ slug: 'settings' }))
    await expectSame((payload) => payload.find({ collection: 'categories', depth: 1 }))
    await expectSame((payload) => payload.delete({ id: 2, collection: 'posts' }))
    await expectSame((payload) =>
      payload.delete({ collection: 'posts', where: { title: { equals: 'missing' } } }),
    )
    await expectSame((payload) =>
      payload.find({ collection: 'posts', depth: 0, pagination: false }),
    )

    const callsAfter = Object.values(getRustEngineStats().calls).reduce((a, b) => a + b, 0)
    expect(callsAfter - callsBefore).toBeGreaterThan(40)
  })

  test('should rebuild a unique-violation ValidationError with the translated message', async () => {
    await expectSame((payload) =>
      payload.create({ collection: 'posts', data: { title: 'unique' } }),
    )
    const { error } = await expectSame((payload) =>
      payload.create({ collection: 'posts', data: { title: 'unique' } }),
    )
    expect(error).toMatchObject({ $error: 'ValidationError' })
  })

  test('should rebuild QueryError, APIError and DrizzleQueryError', async () => {
    const queryError = await expectSame((payload) =>
      payload.db.find({ collection: 'posts', where: { nope: { equals: 1 } } } as never),
    )
    expect(queryError.error).toMatchObject({ $error: 'APIError' })
    const relationshipQuery = await expectSame((payload) =>
      payload.db.find({ collection: 'posts', where: { 'related.nope': { equals: 1 } } } as never),
    )
    expect(relationshipQuery.error).toBeDefined()
    await expectSame((payload) =>
      payload.db.find({
        collection: 'posts',
        where: { 'meta.a': { equals: "x'); drop table posts;--" } },
      } as never),
    )
    const notNull = await expectSame((payload) =>
      payload.db.create({ collection: 'strict', data: {} } as never),
    )
    expect(notNull.error).toMatchObject({ $error: 'DrizzleQueryError' })
    await expectSame((payload) => payload.db.deleteVersions({ where: {} } as never))
  })

  test('should run engine calls on the transaction connection', async () => {
    const rolledBack = await expectSame(async (payload) => {
      const req = { payload } as PayloadRequest
      await initTransaction(req)
      const created = await payload.create({ collection: 'posts', data: { title: 'in-tx' }, req })
      const insideTx = await payload.count({
        collection: 'posts',
        req,
        where: { title: { equals: 'in-tx' } },
      })
      await killTransaction(req)
      const afterRollback = await payload.count({
        collection: 'posts',
        where: { title: { equals: 'in-tx' } },
      })
      return { afterRollback, created, insideTx }
    })
    expect(rolledBack.ok).toMatchObject({
      afterRollback: { totalDocs: 0 },
      insideTx: { totalDocs: 1 },
    })
    await expectSame(async (payload) => {
      const req = { payload } as PayloadRequest
      await initTransaction(req)
      await payload.create({ collection: 'posts', data: { title: 'committed' }, req })
      await commitTransaction(req)
      return payload.count({ collection: 'posts', where: { title: { equals: 'committed' } } })
    })
  })

  test('should share the connection with payload.db.drizzle', async () => {
    await expectSame(async (payload) => {
      await payload.create({ collection: 'posts', data: { title: 'raw', views: 42 } })
      const rows = await (payload.db as unknown as { drizzle: any }).drizzle.all(
        sql`select title, views from posts where title = 'raw'`,
      )
      return rows
    })
  })

  test('should keep raw schema state across re-init like upstream', async () => {
    const pick = (payload: Payload) => {
      const db = payload.db as unknown as Record<string, any>
      return describe({
        fieldConstraints: db.fieldConstraints,
        rawTables: Object.keys(db.rawTables),
        tableNameMap: [...db.tableNameMap],
      })
    }
    for (const side of ['reference', 'candidate'] as const) {
      await instances[side].db.init?.()
    }
    expect(pick(instances.candidate)).toEqual(pick(instances.reference))
    await expectSame((payload) => payload.find({ collection: 'posts', depth: 0, sort: 'id' }))
  })
})
