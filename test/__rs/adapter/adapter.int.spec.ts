/**
 * Differential check of `withRustEngine` against the upstream TS sqlite adapter.
 *
 * Two Payload instances with the same config and their own database files run the same scripted
 * operations under the same faked clock: `reference` uses `sqliteAdapter(args)`, `candidate` uses
 * `withRustEngine(sqliteAdapter(args))`. Every result and every error (class, own properties,
 * cause chain) must be identical. Runs against the native engine, or against the TS loopback
 * engine with PAYLOAD_RS_ENGINE_LOOPBACK=true (then it verifies the glue alone):
 *
 *   PAYLOAD_ENGINE=ts PAYLOAD_ENGINE_ADDON=/tmp/x/payload-engine.node [PAYLOAD_RS_ENGINE_LOOPBACK=true] \
 *     SQLITE_URL=file:/tmp/rs-adapter.db pnpm test:int:sqlite test/__rs/adapter/adapter.int.spec.ts
 */
import type { Payload, PayloadRequest, SanitizedConfig } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { DrizzleQueryError, sql } from '@payloadcms/db-sqlite/drizzle'
import { customType, text } from '@payloadcms/db-sqlite/drizzle/sqlite-core'
import { rmSync } from 'node:fs'
import {
  buildConfig,
  commitTransaction,
  getPayload,
  initTransaction,
  killTransaction,
} from 'payload'
import { afterAll, beforeAll, expect, vi } from 'vitest'

import { buildEngineInput } from '../../../packages/engine-rs/src/adapter/schema.js'
import {
  createFunctionRegistry,
  getNativeEngine,
  getRustEngineStats,
  isRustEngineAdapter,
  serializeForEngine,
  withRustEngine,
} from '../../../packages/engine-rs/src/index.js'
import { createClient, getSqliteConnId } from '../../../packages/engine-rs/src/sqlite/client.js'
import { Sqlite3Client } from '../../../packages/engine-rs/src/sqlite/index.js'
import { getNativeSqlite } from '../../../packages/engine-rs/src/sqlite/native.js'
import { test } from '../../__helpers/int/vitest.js'
import { requireTsEngine } from '../requireTsEngine.js'

requireTsEngine({ file: 'test/__rs/adapter/adapter.int.spec.ts' })

const base = (process.env.SQLITE_URL || 'file:/tmp/rs-adapter.db')
  .replace(/^file:/, '')
  .replace(/\.db$/, '')
const files = {
  candidate: `${base}.adapter-candidate.db`,
  other: `${base}.adapter-other.db`,
  reference: `${base}.adapter-reference.db`,
}

const isLoopback = process.env.PAYLOAD_RS_ENGINE_LOOPBACK === 'true'

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
      // changed by the adapter's schema hooks (see `schemaHooks`)
      { slug: 'hooked', access, fields: [{ name: 'name', type: 'text' }] },
    ],
    db: db as SanitizedConfig['db'],
    // `payload-jobs` (updateJobs' markWrite cases)
    jobs: { tasks: [{ slug: 'noop', handler: () => ({ output: {} }) }] },
    globals: [
      {
        slug: 'settings',
        access: { read: () => true, update: () => true },
        fields: [{ name: 'siteName', type: 'text', localized: true }],
        versions: true,
      },
      {
        slug: 'fresh',
        access: { read: () => true, update: () => true },
        fields: [{ name: 'siteName', type: 'text' }],
      },
    ],
    localization: { defaultLocale: 'en', fallback: true, locales: ['en', 'de'] },
    secret: 'rs-adapter',
  })

/**
 * `beforeSchemaInit` adds a raw column (with a default drizzle binds on insert) to `hooked`,
 * `afterSchemaInit` a drizzle-only custom column whose `fromDriver` throws for `'boom'`: the engine
 * must run on this live schema (`setLiveSchema`), and rethrow the function's own error.
 */
const fromDriverError = new Error('fromDriver boom')
const schemaHooks = {
  afterSchemaInit: [
    ({ extendTable, schema }: { extendTable: any; schema: any }) => {
      extendTable({
        columns: {
          custom: customType<{ data: string; driverData: string }>({
            dataType: () => 'text',
            fromDriver: (value) => {
              if (value === 'boom') {
                throw fromDriverError
              }
              return `decoded:${value}`
            },
          })('custom'),
        },
        table: schema.tables.hooked,
      })
      return schema
    },
  ],
  beforeSchemaInit: [
    ({ adapter, schema }: { adapter: any; schema: any }) => {
      adapter.rawTables.hooked.columns.rawExtra = {
        name: 'raw_extra',
        type: 'text',
        default: 'dflt',
      }
      return schema
    },
  ],
}

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

type Statement = [sql: string, boundParameterCount: number]

const describeStatement = (stmt: { args?: unknown[]; sql: string } | string): Statement =>
  typeof stmt === 'string' ? [stmt, 0] : [stmt.sql, stmt.args?.length ?? 0]

/** Transaction control, which the reference's libsql client runs without `execute`. */
const transactionControl = /^\s*(?:begin|commit|rollback)\b/i

/**
 * Runs `operation` and appends the `[sql, bound parameter count]` of every statement it ran to
 * `statements` (also when it throws): the reference's through its client's `execute` and its
 * transactions' `execute`, the candidate's from the SQLite statement trace of its connections (the
 * engine does not go through `execute`; it also records the transaction control statements libsql
 * runs internally, see `withoutTransactionControl`).
 */
const captureStatements = async <T>(
  payload: Payload,
  operation: (payload: Payload) => Promise<T>,
  statements: Statement[],
): Promise<T> => {
  if (payload === instances.candidate) {
    getNativeSqlite().sqliteStartStatementTrace()
    try {
      return await operation(payload)
    } finally {
      statements.push(...getNativeSqlite().sqliteTakeStatementTrace())
    }
  }
  const client = (payload.db as unknown as { drizzle: { $client: Record<string, any> } }).drizzle
    .$client
  const { execute, transaction } = client
  client.execute = function (this: unknown, ...args: [any]) {
    statements.push(describeStatement(args[0]))
    return execute.apply(this, args)
  }
  client.transaction = async function (this: unknown, ...args: unknown[]) {
    const tx = await transaction.apply(this, args)
    const txExecute = tx.execute
    tx.execute = function (this: unknown, ...txArgs: [any]) {
      statements.push(describeStatement(txArgs[0]))
      return txExecute.apply(this, txArgs)
    }
    return tx
  }
  try {
    return await operation(payload)
  } finally {
    delete client.execute
    delete client.transaction
  }
}

const withoutTransactionControl = (statements: Statement[]) =>
  statements.filter(([sql]) => !transactionControl.test(sql))

/**
 * `both`, plus the statements each side ran (`captureStatements`), which must be identical. Fails
 * when nothing ran.
 */
const expectSameStatements = async (operation: (payload: Payload) => Promise<unknown>) => {
  const recorded = { candidate: [], reference: [] } as Record<Side, Statement[]>
  const out = await both((payload) =>
    captureStatements(
      payload,
      operation,
      recorded[payload === instances.candidate ? 'candidate' : 'reference'],
    ),
  )
  const statements = {
    candidate: withoutTransactionControl(recorded.candidate),
    reference: withoutTransactionControl(recorded.reference),
  }
  expect(statements.reference.length).toBeGreaterThan(0)
  expect({ ...out.candidate!, statements: statements.candidate }).toEqual({
    ...out.reference!,
    statements: statements.reference,
  })
  return { ...out, statements }
}

test.suite('withRustEngine', {}, () => {
  beforeAll(async () => {
    removeDatabases()
    vi.useFakeTimers({ toFake: ['Date'] })
    const previousForce = process.env.PAYLOAD_FORCE_DRIZZLE_PUSH
    // each instance has its own database file: never skip the push via drizzle's process cache
    process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = 'true'
    try {
      const args = (file: string) => ({
        ...schemaHooks,
        client: { url: `file:${file}` },
        transactionOptions: {},
      })
      instances.reference = await getPayload({
        config: makeConfig(sqliteAdapter(args(files.reference))),
        key: 'rs-adapter-reference',
      })
      // record the candidate's statements (`expectSameStatements`)
      process.env.PAYLOAD_SQLITE_TRACE = 'true'
      instances.candidate = await getPayload({
        // as db-sqlite's PAYLOAD_ENGINE=rs path: errors use its drizzle-orm copy's class
        config: makeConfig(
          withRustEngine(sqliteAdapter(args(files.candidate)), { DrizzleQueryError }),
        ),
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
    delete process.env.PAYLOAD_SQLITE_TRACE
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

  // `rawSchema()` JSON drops own properties holding `undefined` (e.g.
  // `rawTables[t].indexes[i].unique`); the glue restores them from `undefinedProperties`
  test('should keep own undefined properties of the raw schema', () => {
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

  test('should throw the DrizzleQueryError class of the adapter drizzle-orm copy', async () => {
    const { candidate, reference } = await both(async (payload) => {
      try {
        await payload.db.create({ collection: 'strict', data: {} } as never)
        return 'resolved'
      } catch (error) {
        return {
          isDrizzleQueryError: error instanceof DrizzleQueryError,
          name: Object.getPrototypeOf(error).constructor.name,
        }
      }
    })
    expect(reference).toEqual({ ok: { isDrizzleQueryError: true, name: 'DrizzleQueryError' } })
    expect(candidate).toEqual(reference)
  })

  const engineCalls = () => Object.values(getRustEngineStats().calls).reduce((a, b) => a + b, 0)

  test('should honour replaced adapter internals like upstream', async () => {
    await expectSame((payload) =>
      payload.create({ collection: 'posts', data: { title: 'spied', views: 1 } }),
    )
    const spied = await expectSame(async (payload) => {
      const db = payload.db as unknown as Record<string, any>
      const countDistinct = vi.spyOn(db, 'countDistinct')
      const deleteWhere = vi.spyOn(db, 'deleteWhere').mockImplementation(async () => {})
      try {
        const counted = await payload.count({ collection: 'posts' })
        const found = await payload.find({ collection: 'posts', depth: 0, limit: 1 })
        const deleted = await payload.db.deleteOne({
          collection: 'posts',
          where: { title: { equals: 'spied' } },
        } as never)
        const stillThere = await payload.count({
          collection: 'posts',
          where: { title: { equals: 'spied' } },
        })
        return {
          countDistinctCalls: countDistinct.mock.calls.length,
          counted,
          deleted: (deleted as { title?: string } | null)?.title,
          deleteWhereCalls: deleteWhere.mock.calls.length,
          found: found.totalDocs,
          stillThere,
        }
      } finally {
        countDistinct.mockRestore()
        deleteWhere.mockRestore()
      }
    })
    expect((spied.ok as { countDistinctCalls: number }).countDistinctCalls).toBeGreaterThan(0)
    expect(spied.ok).toMatchObject({
      deleteWhereCalls: 1,
      stillThere: { totalDocs: 1 },
    })
    const before = engineCalls()
    await expectSame((payload) => payload.count({ collection: 'posts' }))
    expect(engineCalls()).toBe(before + 1)
  })

  test('should send upsert through a replaced updateOne like upstream', async () => {
    const upserted = await expectSame(async (payload) => {
      const db = payload.db as unknown as Record<string, any>
      const original = db.updateOne
      const seen: unknown[] = []
      db.updateOne = function (this: unknown, args: Record<string, unknown>) {
        seen.push(args.options)
        return original.call(this, { ...args, data: { ...(args.data as object), views: 99 } })
      }
      try {
        const doc = await payload.db.upsert({
          collection: 'posts',
          // an upsert's insert leaves createdAt to the SQLite column default (the database clock)
          data: { createdAt: '2026-01-02T03:04:05.678Z', title: 'upserted' },
          where: { title: { equals: 'upserted' } },
        } as never)
        return { seen, views: (doc as { views?: number }).views }
      } finally {
        db.updateOne = original
      }
    })
    expect(upserted.ok).toMatchObject({ seen: [{ upsert: true }], views: 99 })
  })

  test('should run statements through a replaced client execute like upstream', async () => {
    const executed = await expectSame(async (payload) => {
      const client = (payload.db as unknown as { drizzle: { $client: Record<string, any> } })
        .drizzle.$client
      const statements: unknown[] = []
      const ownExecute = Object.getOwnPropertyDescriptor(client, 'execute')
      const execute = client.execute.bind(client)
      client.execute = async function (...args: [{ args: unknown[]; sql: string }]) {
        statements.push({ args: args[0].args, sql: args[0].sql })
        if (args[0].args?.length > 8) {
          throw new Error('too many bound parameters')
        }
        return execute(...args)
      }
      try {
        const small = await payload.find({
          collection: 'posts',
          depth: 0,
          where: { id: { in: [1] } },
        })
        let large: unknown
        try {
          await payload.find({
            collection: 'posts',
            depth: 0,
            where: { id: { in: Array.from({ length: 10 }, (_, i) => i) } },
          })
        } catch (error) {
          large = { cause: ((error as Error).cause as Error | undefined)?.message }
        }
        return { large, small: small.totalDocs, statements }
      } finally {
        if (ownExecute) {
          Object.defineProperty(client, 'execute', ownExecute)
        } else {
          delete client.execute
        }
      }
    })
    expect(executed.ok).toMatchObject({ large: { cause: 'too many bound parameters' } })
    expect((executed.ok as { statements: unknown[] }).statements.length).toBeGreaterThan(1)
    const before = engineCalls()
    await expectSame((payload) => payload.count({ collection: 'posts' }))
    expect(engineCalls()).toBe(before + 1)
  })

  test('should set lastWriteTimestamp like upstream markWrite', async () => {
    const operations: Record<string, (payload: Payload) => Promise<unknown>> = {
      create: (payload) =>
        payload.db.create({ collection: 'posts', data: { title: 'mw' } } as never),
      deleteOneMatch: (payload) =>
        payload.db.deleteOne({ collection: 'posts', where: { title: { equals: 'mw' } } } as never),
      deleteOneReturningFalse: async (payload) => {
        await payload.db.create({ collection: 'posts', data: { title: 'mw-rf' } } as never)
        ;(payload.db as unknown as { lastWriteTimestamp?: number }).lastWriteTimestamp = undefined
        return payload.db.deleteOne({
          collection: 'posts',
          returning: false,
          where: { title: { equals: 'mw-rf' } },
        } as never)
      },
      deleteOneReturningFalseMissing: (payload) =>
        payload.db.deleteOne({
          collection: 'posts',
          returning: false,
          where: { title: { equals: 'missing' } },
        } as never),
      notNullCreate: (payload) => payload.db.create({ collection: 'strict', data: {} } as never),
      notNullUpdateById: async (payload) => {
        const doc = (await payload.db.create({
          collection: 'strict',
          data: { code: 'c' },
        } as never)) as { id: number }
        ;(payload.db as unknown as { lastWriteTimestamp?: number }).lastWriteTimestamp = undefined
        return payload.db.updateOne({
          id: doc.id,
          collection: 'strict',
          data: { code: null },
        } as never)
      },
      notNullUpdateManyNone: (payload) =>
        payload.db.updateMany({
          collection: 'strict',
          data: { code: null },
          where: { code: { equals: 'missing' } },
        } as never),
      deleteOneMissing: (payload) =>
        payload.db.deleteOne({
          collection: 'posts',
          where: { title: { equals: 'missing' } },
        } as never),
      deleteVersionsNone: (payload) =>
        payload.db.deleteVersions({
          collection: 'posts',
          where: { parent: { equals: 99999 } },
        } as never),
      find: (payload) => payload.db.find({ collection: 'posts', limit: 1 } as never),
      updateManyNone: (payload) =>
        payload.db.updateMany({
          collection: 'posts',
          data: { views: 1 },
          where: { title: { equals: 'missing' } },
        } as never),
      updateOneMissing: (payload) =>
        payload.db.updateOne({
          collection: 'posts',
          data: { views: 1 },
          where: { title: { equals: 'missing' } },
        } as never),
      uniqueViolation: (payload) =>
        payload.db.create({ collection: 'posts', data: { title: 'unique' } } as never),
      // a trigger makes every update of payload_jobs fail (`updateJobsFailing`)
      ...updateJobsFailing({
        // `{}` after `delete data.log`: not an initial claim upstream, the per-job `upsertRow`
        // path marks before its failing update
        emptyAfterLog: { log: [] },
        // non-string token / until: not an initial claim either
        nonStringToken: { processingToken: 5, processingUntil: '2026-01-02T03:04:05.678Z' },
        // the initial claim: marks only after its update succeeded
        initialClaim: {
          processingToken: 'token',
          processingUntil: '2026-01-02T03:04:05.678Z',
        },
      }),
    }
    for (const side of ['reference', 'candidate'] as const) {
      const db = instances[side].db as unknown as { drizzle: any }
      await instances[side].db.create({
        collection: 'payload-jobs',
        data: { input: {}, taskSlug: 'noop' },
      } as never)
      await db.drizzle.run(
        sql`create trigger fail_job_updates before update on payload_jobs begin select raise(abort, 'job updates fail'); end`,
      )
    }
    try {
      await expectMarkWrites(operations)
    } finally {
      for (const side of ['reference', 'candidate'] as const) {
        await (instances[side].db as unknown as { drizzle: any }).drizzle.run(
          sql`drop trigger fail_job_updates`,
        )
      }
    }
  })

  const updateJobsFailing = (cases: Record<string, Record<string, unknown>>) =>
    Object.fromEntries(
      Object.entries(cases).map(([name, data]) => [
        `updateJobs ${name}`,
        (payload: Payload) =>
          payload.db.updateJobs({
            data: { ...data },
            limit: 1,
            where: { taskSlug: { equals: 'noop' } },
          } as never),
      ]),
    )

  /** Every operation's outcome and `lastWriteTimestamp` must match upstream's. */
  const expectMarkWrites = async (
    operations: Record<string, (payload: Payload) => Promise<unknown>>,
  ) => {
    for (const [name, operation] of Object.entries(operations)) {
      const { candidate, reference } = await both(async (payload) => {
        const db = payload.db as unknown as { lastWriteTimestamp?: number }
        db.lastWriteTimestamp = undefined
        let outcome: unknown
        try {
          outcome = { result: describe(await operation(payload)) }
        } catch (error) {
          outcome = { error: (error as Error).name }
        }
        return { outcome, timestamp: db.lastWriteTimestamp }
      })
      expect({ name, ...(candidate as object) }).toEqual({ name, ...(reference as object) })
    }
  }

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

  test('should apply the caller-visible argument mutations of upstream', async () => {
    const updatedGlobal = await expectSame(async (payload) => {
      const data: Record<string, unknown> = { siteName: 'first' }
      const created = await payload.db.updateGlobal({ slug: 'fresh', data } as never)
      const again: Record<string, unknown> = { siteName: 'second' }
      await payload.db.updateGlobal({ slug: 'fresh', data: again } as never)
      return { again, created, data }
    })
    expect(updatedGlobal.ok).toMatchObject({
      again: { siteName: 'second' },
      data: { createdAt: '2026-01-02T03:04:05.678Z', siteName: 'first' },
    })
    const version = await expectSame(async (payload) => {
      const doc = (await payload.db.create({
        collection: 'posts',
        data: { title: 'versioned' },
      } as never)) as { id: number }
      const select: Record<string, unknown> = { title: true }
      await payload.db.createVersion({
        autosave: false,
        collectionSlug: 'posts',
        createdAt: '2026-01-02T03:04:05.678Z',
        parent: doc.id,
        select,
        updatedAt: '2026-01-02T03:04:05.678Z',
        versionData: { title: 'versioned' },
      } as never)
      return select
    })
    expect(version.ok).toEqual({ title: true, updatedAt: true })
    const nullSelect = await expectSame((payload) =>
      payload.db.createVersion({
        autosave: false,
        collectionSlug: 'posts',
        parent: 1,
        select: null,
        versionData: { title: 'versioned' },
      } as never),
    )
    expect(nullSelect.error).toMatchObject({ $error: 'TypeError' })
    // unknown slugs: upstream's TypeError, thrown before `getTransaction`
    const unknownCollection = await expectSame((payload) =>
      payload.db.createVersion({
        autosave: false,
        collectionSlug: 'nope',
        parent: 1,
        versionData: {},
      } as never),
    )
    expect(unknownCollection.error).toMatchObject({ $error: 'TypeError' })
    const unknownGlobal = await expectSame(async (payload) => {
      const data: Record<string, unknown> = {}
      try {
        return await payload.db.createGlobal({ slug: 'nope', data } as never)
      } catch (error) {
        return { data, error: describe(error) }
      }
    })
    expect(unknownGlobal.ok).toMatchObject({ data: {}, error: { $error: 'TypeError' } })
  })

  test('should run limitedBoundParameters statements like upstream', async () => {
    for (const side of ['reference', 'candidate'] as const) {
      ;(
        instances[side].db as unknown as { limitedBoundParameters?: boolean }
      ).limitedBoundParameters = true
    }
    try {
      const created = await expectSameStatements(async (payload) => {
        const ids: number[] = []
        for (let i = 0; i < 120; i++) {
          ids.push(
            (
              (await payload.db.create({
                collection: 'strict',
                data: { code: `bound-${i}` },
              } as never)) as { id: number }
            ).id,
          )
        }
        return ids
      })
      const ids = created.reference.ok as number[]
      const many = Array.from({ length: 300 }, (_, i) => ids[0]! + i)
      await expectSameStatements((payload) =>
        payload.find({ collection: 'strict', pagination: false, where: { id: { in: many } } }),
      )
      await expectSameStatements((payload) =>
        payload.find({ collection: 'strict', pagination: false, where: { id: { not_in: many } } }),
      )
      const wide = await expectSameStatements((payload) =>
        payload.db.create({
          collection: 'posts',
          data: {
            layout: Array.from({ length: 30 }, (_, i) => ({ blockType: 'hero', heading: `h${i}` })),
            related: Array.from({ length: 60 }, () => 1),
            select: ['a', 'b', 'c'],
            tags: Array.from({ length: 40 }, (_, i) => ({ tag: `t${i}` })),
            title: 'wide',
          },
        } as never),
      )
      expect(Math.max(...wide.statements.candidate.map(([, count]) => count))).toBeLessThanOrEqual(
        100,
      )
      expect(wide.statements.candidate.length).toBeGreaterThan(5)
    } finally {
      for (const side of ['reference', 'candidate'] as const) {
        ;(
          instances[side].db as unknown as { limitedBoundParameters?: boolean }
        ).limitedBoundParameters = undefined
      }
    }
  })

  test('should run on the live schema of the schema hooks', async () => {
    const written = await expectSame(async (payload) => {
      const statements: Statement[] = []
      const doc = await captureStatements(
        payload,
        () => payload.db.create({ collection: 'hooked', data: { name: 'one' } } as never),
        statements,
      )
      // `beforeSchemaInit`'s raw column (with its default) is written by both
      return {
        doc,
        hasRawExtra: statements.some(([text]) => /^insert into "hooked" .*"raw_extra"/.test(text)),
      }
    })
    expect(written.ok).toMatchObject({ hasRawExtra: true })
    await expectSameStatements(async (payload) => {
      const raw = await (payload.db as unknown as { drizzle: any }).drizzle.all(
        sql`select raw_extra, custom from hooked`,
      )
      await (payload.db as unknown as { drizzle: any }).drizzle.run(
        sql`update hooked set custom = 'fine'`,
      )
      return { found: await payload.find({ collection: 'hooked' }), raw }
    })
    if (isLoopback) {
      // the loopback runs drizzle, which calls `fromDriver` itself, not through the engine host
      return
    }
    const thrown = await expectSame(async (payload) => {
      await (payload.db as unknown as { drizzle: any }).drizzle.run(
        sql`update hooked set custom = 'boom'`,
      )
      try {
        return await payload.find({ collection: 'hooked' })
      } catch (error) {
        return { isOwnError: error === fromDriverError }
      }
    })
    expect(thrown.ok).toEqual({ isOwnError: true })
    await expectSame((payload) =>
      (payload.db as unknown as { drizzle: any }).drizzle.run(sql`update hooked set custom = null`),
    )
  })

  // ENGINE_CONTRACT.md "Columns added to drizzle tables only": upstream drizzle builds the insert
  // from the drizzle table, so `afterSchemaInit`'s drizzle-only column is returned (and inserted
  // only when it has a value). Strict: every statement must equal upstream's.
  test('should write the drizzle-only columns of afterSchemaInit like upstream', async () => {
    await expectSameStatements((payload) =>
      payload.db.create({ collection: 'hooked', data: { name: 'two' } } as never),
    )
  })

  test.skipIf(isLoopback)('should reject connections of another database', async () => {
    const registry = createFunctionRegistry()
    const { graphJson, optionsJson } = buildEngineInput({
      adapter: instances.candidate.db as never,
      registry,
    })
    const engine = getNativeEngine().SqliteEngine!.create(graphJson, optionsJson, () => '{}')
    const client = (instances.candidate.db as unknown as { drizzle: { $client: Sqlite3Client } })
      .drizzle.$client
    engine.attachClient(getSqliteConnId(client))
    const args = serializeForEngine({ collection: 'posts' }, registry)
    const context = JSON.stringify({ now: Date.now() })
    const others = [createClient({ url: `file:${files.other}` }), createClient({ url: ':memory:' })]
    for (const other of others) {
      await expect(engine.call('count', args, getSqliteConnId(other), context)).rejects.toThrow(
        /does not belong to the adapter's client/,
      )
    }
    const sameFile = createClient({ url: `file:${files.candidate}` })
    const transaction = await client.transaction('deferred')
    try {
      for (const target of [client, sameFile, transaction]) {
        const counted = JSON.parse(
          await engine.call('count', args, getSqliteConnId(target), context),
        )
        expect(counted.totalDocs).toBeGreaterThan(0)
      }
    } finally {
      await transaction.rollback()
      for (const other of [...others, sameFile]) {
        other.close()
      }
    }
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

  // packages/payload/src/index.ts hot reload: `db.init()`, then `db.connect({ hotReload: true })`,
  // which builds a new drizzle instance while requests may still be running. No call may fail.
  test('should keep serving calls across a hot reload like upstream', async () => {
    const upstreamCalls = () =>
      Object.values(getRustEngineStats().upstream).reduce((a, b) => a + b, 0)
    const reasonsBefore = { ...getRustEngineStats().upstreamReasons }
    const reloaded = await expectSame(async (payload) => {
      const db = payload.db as unknown as Record<string, any>
      await db.init()
      // between init and connect: the previous drizzle instance
      const beforeConnect = await payload.find({ collection: 'posts', depth: 0, sort: 'id' })
      // a call still running when connect replaces the drizzle instance, and one started right then
      const callsBefore = engineCalls()
      // `limit: 1` with more documents: a select and a count statement, so the engine still runs it
      const running = payload.db.find({ collection: 'posts', limit: 1, sort: 'id' } as never)
      let isRunningSettled = false
      void running.then(
        () => (isRunningSettled = true),
        () => (isRunningSettled = true),
      )
      // until the candidate's call is inside the engine (its first statement ran)
      for (
        let i = 0;
        i < 3 || (payload === instances.candidate && engineCalls() === callsBefore && i < 100);
        i++
      ) {
        await Promise.resolve()
      }
      const connecting = db.connect({ hotReload: true })
      const startedDuringConnect = payload.db.find({ collection: 'posts', sort: 'id' } as never)
      const wasRunning = !isRunningSettled
      const [runningResult, duringResult] = await Promise.all([
        running,
        startedDuringConnect,
        connecting,
      ])
      const afterConnect = await payload.find({ collection: 'posts', depth: 0, sort: 'id' })
      return { afterConnect, beforeConnect, duringResult, runningResult, wasRunning }
    })
    expect(reloaded.ok).toMatchObject({ wasRunning: true })
    // the call after the reload runs on the engine, on the new live schema
    const before = { calls: engineCalls(), upstream: upstreamCalls() }
    await expectSame((payload) => payload.db.find({ collection: 'hooked', sort: 'id' } as never))
    expect({ calls: engineCalls(), upstream: upstreamCalls() }).toEqual({
      calls: before.calls + 1,
      upstream: before.upstream,
    })
    // only the engine's need for exclusive access to swap the live schema may send a call upstream
    const reasons = getRustEngineStats().upstreamReasons
    for (const reason of Object.keys(reasons)) {
      if (reasons[reason] !== reasonsBefore[reason]) {
        expect(reason).toBe('live schema: engine calls in progress')
      }
    }
  })
})
