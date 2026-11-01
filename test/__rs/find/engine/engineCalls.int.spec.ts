/**
 * Differential checks of `SqliteEngine.call` against the upstream TS sqlite adapter for what the
 * per-call harnesses cannot see:
 *
 * - `setLiveSchema` end to end through napi: schema hooks rename a raw column
 *   (`beforeSchemaInit`, through `adapter.rawTables`) and replace drizzle columns with a custom
 *   type and a bigint numeric (`afterSchemaInit` `extendTable`). An engine created on the
 *   candidate's client gets `{ drizzle: describeDrizzleSchema(...), rawTables: adapter.rawTables }`
 *   and must answer like the TS adapter (where / sort columns, custom `toDriver` / `fromDriver`,
 *   `cast(... as text)` selections, writes through the renamed column).
 * - concurrent calls (`Promise.all`), which interleave statement by statement in TS, including a
 *   call whose client connection is taken by a transaction begun between its statements;
 * - typed arguments (`Date`, `bigint`) of the data methods.
 *
 * Reference: `sqliteAdapter(args)`; candidate: `withRustEngine(sqliteAdapter(args))`, each with its
 * own database file and the same faked clock. Fails when nothing was compared, or when the
 * candidate is not on the Rust engine.
 *
 *   PAYLOAD_ENGINE_ADDON=/tmp/x/payload-engine.node SQLITE_URL=file:/tmp/rs-engine.db \
 *     pnpm test:int:sqlite --config test/__rs/harness/vitest.config.ts \
 *     test/__rs/find/engine/engineCalls.int.spec.ts
 */
import type { Payload, SanitizedConfig } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { DrizzleQueryError } from '@payloadcms/db-sqlite/drizzle'
import { customType, numeric } from '@payloadcms/db-sqlite/drizzle/sqlite-core'
import { rmSync } from 'node:fs'
import { buildConfig, getPayload } from 'payload'
import { afterAll, beforeAll, expect, vi } from 'vitest'

import { buildEngineInput } from '../../../../packages/engine-rs/src/adapter/schema.js'
import {
  getNativeEngine,
  getRustEngineStats,
  isRustEngineAdapter,
  withRustEngine,
} from '../../../../packages/engine-rs/src/index.js'
import {
  createFunctionRegistry,
  deserializeFromEngine,
  serializeForEngine,
} from '../../../../packages/engine-rs/src/serialize.js'
import { getSqliteConnId } from '../../../../packages/engine-rs/src/sqlite/client.js'
import { test } from '../../../__helpers/int/vitest.js'
import { describeDrizzleSchema } from '../harness.js'

type Side = 'candidate' | 'reference'
type AnyObject = Record<string, any>

const base = (process.env.SQLITE_URL || 'file:/tmp/rs-engine.db')
  .replace(/^file:/, '')
  .replace(/\.db$/, '')
const files: Record<Side, string> = {
  candidate: `${base}.engine-calls-candidate.db`,
  reference: `${base}.engine-calls-reference.db`,
}

const removeDatabases = () => {
  for (const file of Object.values(files)) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      rmSync(`${file}${suffix}`, { force: true })
    }
  }
}

const access = { create: () => true, delete: () => true, read: () => true, update: () => true }

/** Stored as `enc:<value>`; JS `fromDriver` / `toDriver` on both sides. */
const encodedText = customType<{ data: string; driverData: string }>({
  dataType: () => 'text',
  fromDriver: (value) => (typeof value === 'string' ? value.replace(/^enc:/, '') : value),
  toDriver: (value) => `enc:${value}`,
})

const makeConfig = (db: unknown) =>
  buildConfig({
    collections: [
      {
        // changed by the schema hooks
        slug: 'posts',
        access,
        fields: [
          { name: 'title', type: 'text' },
          { name: 'code', type: 'text' },
          { name: 'views', type: 'number' },
          { name: 'tags', type: 'array', fields: [{ name: 'tag', type: 'text' }] },
        ],
      },
      {
        // untouched by the hooks: served by the glue's own engine
        slug: 'items',
        access,
        fields: [
          { name: 'name', type: 'text' },
          { name: 'n', type: 'number' },
          { name: 'when', type: 'date' },
          { name: 'tags', type: 'array', fields: [{ name: 'tag', type: 'text' }] },
        ],
      },
    ],
    db: db as SanitizedConfig['db'],
    secret: 'rs-engine-calls',
  })

const adapterArgs = (file: string) => ({
  afterSchemaInit: [
    ({ extendTable, schema }: AnyObject) => {
      extendTable({
        columns: { code: encodedText('code'), views: numeric('views', { mode: 'bigint' }) },
        table: schema.tables.posts,
      })
      return schema
    },
  ],
  beforeSchemaInit: [
    ({ adapter, schema }: AnyObject) => {
      adapter.rawTables.posts.columns.title.name = 'headline'
      return schema
    },
  ],
  client: { url: `file:${file}` },
  transactionOptions: {},
})

const instances = {} as Record<Side, Payload>

const OBJECT_ID = /^[0-9a-f]{24}$/

/** Comparable description: classes, own keys in order, `undefined` vs missing, errors. */
const describeValue = (value: unknown, seen = new Set<unknown>()): unknown => {
  if (value instanceof Error) {
    return { $error: value.name, message: value.message }
  }
  if (value instanceof Date) {
    return { $date: Number.isNaN(value.getTime()) ? 'invalid' : value.toISOString() }
  }
  if (typeof value === 'bigint') {
    return { $bigint: value.toString() }
  }
  if (typeof value === 'string' && OBJECT_ID.test(value)) {
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
    ? value.map((item) => describeValue(item, seen))
    : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, describeValue(v, seen)]))
  seen.delete(value)
  return out
}

const settle = async (run: () => Promise<unknown>) => {
  try {
    return { ok: describeValue(await run()) }
  } catch (error) {
    return { error: describeValue(error) }
  }
}

const report = { concurrent: 0, live: 0, typed: 0 }

/** An array row id (the data methods take rows with ids; the Local API generates them). */
const rowId = (n: number) => n.toString(16).padStart(24, '0')

/** Runs `operation` on both instances at the same faked time and expects the same outcome. */
const expectSame = async (
  kind: keyof typeof report,
  operation: (payload: Payload) => Promise<unknown>,
) => {
  const out = {} as Record<Side, unknown>
  for (const side of ['reference', 'candidate'] as const) {
    vi.setSystemTime(new Date('2026-01-02T03:04:05.678Z'))
    out[side] = await settle(() => operation(instances[side]))
  }
  expect(out.candidate).toEqual(out.reference)
  report[kind]++
  return out.reference as { error?: unknown; ok?: unknown }
}

/** Identical rows on both databases, through each side's client (raw SQL). */
const seed = async (statements: string[]) => {
  for (const side of ['reference', 'candidate'] as const) {
    const db = instances[side].db as AnyObject
    for (const raw of statements) {
      await db.execute({ drizzle: db.drizzle, raw })
    }
  }
}

test.suite('SqliteEngine.call', {}, () => {
  beforeAll(async () => {
    removeDatabases()
    vi.useFakeTimers({ toFake: ['Date'] })
    const previousForce = process.env.PAYLOAD_FORCE_DRIZZLE_PUSH
    process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = 'true'
    try {
      instances.reference = await getPayload({
        config: makeConfig(sqliteAdapter(adapterArgs(files.reference))),
        key: 'rs-engine-calls-reference',
      })
      instances.candidate = await getPayload({
        config: makeConfig(
          withRustEngine(sqliteAdapter(adapterArgs(files.candidate)), { DrizzleQueryError }),
        ),
        key: 'rs-engine-calls-candidate',
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
    // a differential that compared nothing proves nothing
    expect(report.live).toBeGreaterThan(0)
    expect(report.concurrent).toBeGreaterThan(0)
    expect(report.typed).toBeGreaterThan(0)
  })

  test('should run the candidate on the Rust engine', () => {
    expect(isRustEngineAdapter(instances.candidate.db)).toBe(true)
    expect(isRustEngineAdapter(instances.reference.db)).toBe(false)
  })

  test('should answer like TS with the live schema of the schema hooks', async () => {
    const adapter = instances.candidate.db as AnyObject
    const registry = createFunctionRegistry()
    const register = (fn: unknown) => {
      if (typeof fn !== 'function') {
        return null
      }
      const existing = registry.functions.indexOf(fn)
      return existing === -1 ? registry.functions.push(fn) - 1 : existing
    }
    const { graphJson, optionsJson } = buildEngineInput({ adapter: adapter as never, registry })
    const SqliteEngine = getNativeEngine().SqliteEngine!
    const engine = SqliteEngine.create(graphJson, optionsJson, (id: number, argJson: string) =>
      serializeForEngine(
        registry.functions[id]!(deserializeFromEngine(JSON.parse(argJson), registry)),
        registry,
      ),
    )
    const description = {
      drizzle: describeDrizzleSchema(
        adapter.drizzle._.schema,
        adapter.drizzle._.tableNamesMap,
        register,
      ),
      rawTables: adapter.rawTables,
    }
    // the hooks reached the description that is checked below
    expect((description.drizzle as AnyObject).posts.columns.title.name).toBe('headline')
    expect((description.drizzle as AnyObject).posts.columns.code.columnType).toBe(
      'SQLiteCustomColumn',
    )
    expect((description.drizzle as AnyObject).posts.columns.views.columnType).toBe(
      'SQLiteNumericBigInt',
    )
    engine.setLiveSchema(JSON.stringify(description))
    const clientId = getSqliteConnId(adapter.drizzle.session.client)
    engine.attachClient(clientId)

    await seed([
      `insert into posts (id, headline, code, views, updated_at, created_at) values (1, 'first', 'enc:a', 10, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
      `insert into posts (id, headline, code, views, updated_at, created_at) values (2, 'second', 'enc:b', 9007199254740993, '2025-01-02T00:00:00.000Z', '2025-01-02T00:00:00.000Z')`,
      `insert into posts (id, headline, code, views, updated_at, created_at) values (3, 'third', 'enc:a', 10, '2025-01-03T00:00:00.000Z', '2025-01-03T00:00:00.000Z')`,
      `insert into posts_tags (_order, _parent_id, id, tag) values (1, 1, '000000000000000000000001', 'x')`,
      `insert into posts_tags (_order, _parent_id, id, tag) values (1, 2, '000000000000000000000002', 'y')`,
    ])

    const callBoth = (method: string, args: AnyObject) =>
      expectSame('live', async (payload) => {
        if (payload === instances.reference) {
          return (payload.db as AnyObject)[method](args)
        }
        let result: string
        try {
          result = await engine.call(
            method,
            serializeForEngine(args, registry),
            clientId,
            JSON.stringify({ now: Date.now() }),
          )
        } catch (error) {
          // the error JSON of the contract; drizzle's DrizzleQueryError is an `Error` by name
          const parsed = JSON.parse((error as Error).message)
          throw Object.assign(new Error(parsed.message), {
            name: parsed.name === 'DrizzleQueryError' ? 'Error' : parsed.name,
          })
        }
        return deserializeFromEngine(JSON.parse(result), registry)
      })

    const collection = 'posts'
    // where / sort through the renamed column, the custom column (toDriver) and the bigint column
    await callBoth('find', { collection, sort: '-title', where: { title: { like: 'i' } } })
    await callBoth('find', { collection, sort: 'code', where: { code: { equals: 'a' } } })
    await callBoth('find', { collection, where: { views: { equals: 10 } } })
    await callBoth('find', { collection, where: { 'tags.tag': { in: ['x', 'y'] } } })
    await callBoth('count', { collection, where: { code: { not_equals: 'b' } } })
    await callBoth('count', { collection, where: { 'tags.tag': { exists: true } } })
    // `_selected` decoded by its column: custom `fromDriver`, `cast(... as text)` + `BigInt`
    await callBoth('findDistinct', { collection, field: 'code', sort: 'code' })
    await callBoth('findDistinct', { collection, field: 'views', sort: 'views' })
    await callBoth('findDistinct', { collection, field: 'title', limit: 1, page: 2 })
    // write path through the raw tables of `beforeSchemaInit` (the renamed column), read back
    // with the live drizzle columns; the join makes it a `selectDistinct`
    await callBoth('updateOne', {
      collection,
      data: { title: 'renamed' },
      where: { 'tags.tag': { equals: 'x' } },
    })
    await callBoth('create', {
      collection,
      data: { tags: [{ id: '000000000000000000000004', tag: 'z' }], title: 'fourth' },
    })
    // a failing write statement (array row without id)
    await callBoth('create', { collection, data: { tags: [{ tag: 'w' }], title: 'fifth' } })
    await callBoth('deleteOne', { collection, where: { 'tags.tag': { equals: 'z' } } })
    await callBoth('find', { collection, sort: 'id' })
  })

  test('should interleave concurrent calls like TS', async () => {
    await expectSame('concurrent', (payload) =>
      payload.create({ collection: 'items', data: { name: 'base', tags: [{ tag: 'a' }] } }),
    )
    // both array replacements delete before either inserts
    await expectSame('concurrent', (payload) =>
      Promise.all(
        ['b', 'c'].map((tag) =>
          payload.db.updateOne({
            id: 1,
            collection: 'items',
            data: { tags: [{ id: rowId(tag.charCodeAt(0)), tag }] },
          }),
        ),
      ),
    )
    await expectSame('concurrent', (payload) =>
      Promise.all(
        [1, 2, 3].map((i) =>
          payload.db.create({
            collection: 'items',
            data: {
              n: i,
              name: `item ${i}`,
              tags: [
                { id: rowId(100 + i), tag: `t${i}` },
                { id: rowId(200 + i), tag: `u${i}` },
              ],
            },
          }),
        ),
      ),
    )
    // a read on the client while a create begins its transaction (libsql moves the client's
    // connection to the transaction; the read continues on the client's new connection)
    await expectSame('concurrent', (payload) =>
      Promise.all([
        payload.find({ collection: 'items', depth: 0, sort: 'id' }),
        payload.create({ collection: 'items', data: { name: 'in tx', tags: [{ tag: 'tx' }] } }),
        payload.count({ collection: 'items' }),
      ]),
    )
    await expectSame('concurrent', (payload) =>
      Promise.all([
        payload.update({ collection: 'items', data: { n: 7 }, where: { n: { exists: true } } }),
        payload.db.find({ collection: 'items', sort: 'id', where: { n: { equals: 7 } } }),
      ]),
    )
    await expectSame('concurrent', (payload) =>
      payload.find({ collection: 'items', depth: 0, sort: 'id' }),
    )
  })

  test('should take typed Date and bigint arguments like TS', async () => {
    // a `Date` for a text field is stored as `JSON.stringify(date)`
    await expectSame('typed', (payload) =>
      payload.db.create({
        collection: 'items',
        data: {
          name: new Date('2020-02-02T02:02:02.002Z'),
          when: new Date('2021-01-01T00:00:00.000Z'),
        },
      }),
    )
    // an invalid date for a date field: `toISOString()` throws
    await expectSame('typed', (payload) =>
      payload.db.create({ collection: 'items', data: { name: 'bad', when: new Date(Number.NaN) } }),
    )
    // where values: a `Date` binds its time value, a `bigint` a 64-bit integer
    await expectSame('typed', (payload) =>
      payload.db.find({ collection: 'items', where: { n: { less_than: new Date(5) } } }),
    )
    await expectSame('typed', (payload) =>
      payload.db.count({ collection: 'items', where: { n: { equals: 7n } } }),
    )
    await expectSame('typed', (payload) =>
      payload.db.find({ collection: 'items', where: { n: { equals: 7n } } }),
    )
    await expectSame('typed', (payload) =>
      payload.db.updateOne({
        collection: 'items',
        data: { n: 12n },
        where: { name: { equals: 'base' } },
      }),
    )
    await expectSame('typed', (payload) =>
      payload.db.find({ collection: 'items', sort: 'id', where: {} }),
    )
  })

  test('should have run the candidate calls on the engine', () => {
    const calls = Object.values(getRustEngineStats().calls).reduce((a, b) => a + b, 0)
    expect(calls).toBeGreaterThan(0)
  })
})
