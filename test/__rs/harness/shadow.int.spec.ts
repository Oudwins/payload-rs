/**
 * Self-test of the differential shadow adapter (packages/engine-rs/src/shadow).
 *
 * - TS vs TS must produce zero divergences across all operation kinds.
 * - Deliberately broken candidates must be detected, while the caller still
 *   receives the reference result.
 * - Raw SQL mirroring, transaction id mapping, vi.spyOn and strict mode.
 */
import type { CollectionConfig, DatabaseAdapterObj, GlobalConfig, Payload } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildConfig, getPayload } from 'payload'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ShadowContext, ShadowRecord } from '../../../packages/engine-rs/src/shadow/index.js'

import {
  compareValues,
  createClockTapes,
  createShadowAdapter,
  getShadowState,
  installClockReplay,
} from '../../../packages/engine-rs/src/shadow/index.js'
import { forceSchemaPushOnConnect, loadContext } from './shadowDatabaseAdapter.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-shadow-selftest-'))
let counter = 0

const allow = () => true

const posts: CollectionConfig = {
  slug: 'posts',
  access: { create: allow, delete: allow, read: allow, readVersions: allow, update: allow },
  fields: [
    { name: 'title', type: 'text' },
    { name: 'views', type: 'number' },
    { name: 'tags', type: 'text', hasMany: true },
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

const settings: GlobalConfig = {
  slug: 'settings',
  access: { read: allow, readVersions: allow, update: allow },
  fields: [{ name: 'siteName', type: 'text' }],
  versions: true,
}

type Setup = {
  candidate?: (adapter: Record<string, any>) => void
  context?: () => ShadowContext
  mirrorRaw?: Parameters<typeof createShadowAdapter>[0]['mirrorRaw']
  onDivergence?: 'record' | 'throw'
  transactions?: boolean
}

const instances: Payload[] = []

afterEach(async () => {
  while (instances.length) {
    await instances.pop()!.destroy()
  }
})

/** Builds a payload whose db is a shadow adapter over two fresh sqlite files. */
async function setup({ candidate, context, mirrorRaw, onDivergence, transactions }: Setup = {}) {
  const id = ++counter
  const records: ShadowRecord[] = []
  const file = path.join(tmpDir, `report-${id}.jsonl`)
  const make = (name: string) =>
    forceSchemaPushOnConnect(
      sqliteAdapter({
        autoIncrement: true,
        client: { url: `file:${path.join(tmpDir, `${name}-${id}.db`)}` },
        ...(transactions ? { transactionOptions: {} } : {}),
      }),
    )
  const candidateObj = make('candidate')
  const wrapped: DatabaseAdapterObj = candidate
    ? {
        ...candidateObj,
        init: (args) => {
          const adapter = candidateObj.init(args)
          candidate(adapter as unknown as Record<string, any>)
          return adapter
        },
      }
    : candidateObj

  const db = createShadowAdapter({
    candidate: wrapped,
    mirrorRaw,
    onDivergence,
    reference: make('reference'),
    report: { context: context ?? (await loadContext()), file, onRecord: (r) => records.push(r) },
  })

  const config = await buildConfig({
    collections: [posts],
    db,
    globals: [settings],
    secret: 'TEST_SECRET',
    telemetry: false,
    typescript: { autoGenerate: false },
  })
  const payload = await getPayload({ config, cron: false, key: `shadow-selftest-${id}` })
  instances.push(payload)
  const divergences = () => records.filter((r) => r.type === 'divergence')
  return { divergences, file, payload, records }
}

/** Runs one of every adapter operation through the Local API. */
async function exercise(payload: Payload) {
  const a = await payload.create({
    collection: 'posts',
    data: { items: [{ label: 'x' }], tags: ['a', 'b'], title: 'first', views: 1 },
  })
  await payload.create({ collection: 'posts', data: { title: 'second', views: 2 } })
  await payload.find({
    collection: 'posts',
    sort: '-views',
    where: { views: { greater_than_equal: 1 } },
  })
  await payload.findByID({ collection: 'posts', id: a.id })
  await payload.count({ collection: 'posts' })
  await payload.findDistinct({ collection: 'posts', field: 'title' })
  await payload.update({ collection: 'posts', data: { title: 'first!' }, id: a.id })
  await payload.update({ collection: 'posts', data: { views: 5 }, where: { views: { equals: 2 } } })
  await payload.update({ collection: 'posts', data: { title: 'draft' }, draft: true, id: a.id })
  await payload.find({ collection: 'posts', draft: true })
  await payload.findVersions({ collection: 'posts' })
  await payload.countVersions({ collection: 'posts' })
  await payload.updateGlobal({ data: { siteName: 'site' }, slug: 'settings' })
  await payload.findGlobal({ slug: 'settings' })
  await payload.findGlobalVersions({ slug: 'settings' })
  await payload.countGlobalVersions({ global: 'settings' })
  await payload.delete({ collection: 'posts', id: a.id })
  await payload.delete({ collection: 'posts', where: { views: { equals: 5 } } })
}

describe('shadow adapter', () => {
  it('TS vs TS: zero divergences, every call shadowed', async () => {
    const { divergences, payload } = await setup()
    await exercise(payload)
    const state = getShadowState(payload.db)!
    expect(divergences()).toEqual([])
    expect(state.calls).toBeGreaterThan(30)
    expect(payload.db.name).toBe('sqlite')
    expect('drizzle' in payload.db).toBe(true)
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
    expect(found[0]!.collection).toBe('posts')
    expect(found[0]!.differences).toEqual([
      {
        candidate: 'hello (bug)',
        kind: 'value',
        path: 'docs[0].title',
        reference: 'hello',
      },
    ])
  })

  it('detects count, key order, missing keys and thrown errors', async () => {
    const { divergences, payload } = await setup({
      candidate: (adapter) => {
        const { count, create, findOne, updateOne } = adapter
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
        adapter.updateOne = async function () {
          throw new Error('candidate boom')
        }
        void updateOne
      },
    })
    const doc = await payload.create({ collection: 'posts', data: { title: 't', views: 3 } })
    expect(doc.views).toBe(3)
    expect((await payload.count({ collection: 'posts' })).totalDocs).toBe(1)
    await payload.findByID({ collection: 'posts', id: doc.id })
    const updated = await payload.update({
      collection: 'posts',
      data: { title: 'u' },
      id: doc.id,
    })
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
        reference: expect.objectContaining({ title: 'u' }),
      }),
    ])
  })

  it('writes divergences to the JSONL report', async () => {
    const { file, payload } = await setup({
      candidate: (adapter) => {
        adapter.count = async () => ({ totalDocs: -1 })
      },
    })
    await payload.count({ collection: 'posts' })
    const lines = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines[0].type).toBe('session')
    const divergence = lines.find((l) => l.type === 'divergence')
    expect(divergence).toMatchObject({
      collection: 'posts',
      method: 'count',
      testFile: expect.stringContaining('shadow.int.spec.ts'),
      testName: expect.stringContaining('writes divergences'),
    })
  })

  it('mirrors raw SQL to the candidate (and detects drift when not mirrored)', async () => {
    const mirrored = await setup()
    await mirrored.payload.db.execute({
      drizzle: mirrored.payload.db.drizzle,
      raw: `INSERT INTO posts (title, updated_at, created_at) VALUES ('raw', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
    })
    await mirrored.payload.find({ collection: 'posts' })
    expect(mirrored.divergences()).toEqual([])
    expect(getShadowState(mirrored.payload.db)!.rawMirrored).toBe(1)

    const unmirrored = await setup({ mirrorRaw: async () => false })
    await unmirrored.payload.db.execute({
      drizzle: unmirrored.payload.db.drizzle,
      raw: `INSERT INTO posts (title, updated_at, created_at) VALUES ('raw', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
    })
    await unmirrored.payload.find({ collection: 'posts' })
    expect(unmirrored.divergences().map((d) => d.method)).toEqual(['find'])
    expect(getShadowState(unmirrored.payload.db)!.unshadowed['client.execute']).toBe(1)
  })

  it('applies a test override of the reference client method to the candidate as well', async () => {
    const { divergences, payload } = await setup()
    await payload.create({ collection: 'posts', data: { title: 'one' } })
    const client = payload.db.drizzle.$client
    const saved = client.execute.bind(client)
    let calls = 0
    client.execute = async function execute(...args: Parameters<typeof saved>) {
      calls++
      const result = await saved(...args)
      if (JSON.stringify(args).includes('"one"')) {
        throw new Error('injected fault')
      }
      return result
    }

    await expect(
      payload.find({ collection: 'posts', where: { title: { equals: 'one' } } }),
    ).rejects.toThrow('Failed query')
    // reference and candidate both went through the override (each on its own client) and threw
    expect(calls).toBe(2)

    client.execute = saved
    await payload.find({ collection: 'posts' })
    expect(divergences()).toEqual([])
  })

  it('maps transaction ids (commit + rollback) with zero divergences', async () => {
    const { divergences, payload } = await setup({ transactions: true })
    const begin = vi.spyOn(payload.db, 'beginTransaction')
    await payload.create({ collection: 'posts', data: { title: 'committed' } })
    await expect(
      payload.create({
        collection: 'posts',
        data: { failAfterChange: true, title: 'rolled back' },
      }),
    ).rejects.toThrow('afterChange failure')
    const { docs } = await payload.find({ collection: 'posts' })
    expect(docs.map((d) => d.title)).toEqual(['committed'])
    expect(begin).toHaveBeenCalled()
    expect(await begin.mock.results[0]!.value).toEqual(expect.any(String))
    expect(divergences()).toEqual([])
  })

  it('keeps shadowing through vi.spyOn(payload.db, method)', async () => {
    const { payload } = await setup({
      candidate: (adapter) => {
        adapter.count = async () => ({ totalDocs: 42 })
      },
    })
    const spy = vi.spyOn(payload.db, 'count')
    const before = getShadowState(payload.db)!.divergences
    await payload.count({ collection: 'posts' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(getShadowState(payload.db)!.divergences).toBe(before + 1)
    spy.mockRestore()
  })

  it('does not call the candidate twice when a spied method is reached from inside a shadowed call', async () => {
    let candidateUpdateOneCalls = 0
    const { divergences, payload } = await setup({
      candidate: (adapter) => {
        const updateOne = adapter.updateOne
        adapter.updateOne = function (...callArgs: unknown[]) {
          candidateUpdateOneCalls++
          return updateOne.apply(this, callArgs)
        }
      },
    })
    await payload.create({ collection: 'posts', data: { title: 'spied' } })
    const spy = vi.spyOn(payload.db, 'updateOne')

    // drizzle upsert -> this.updateOne: `this` is the reference, whose updateOne is now the spy
    await payload.db.upsert({
      collection: 'posts',
      data: { title: 'spied!' },
      req: {},
      where: { title: { equals: 'spied' } },
    } as Parameters<typeof payload.db.upsert>[0])

    expect(spy).toHaveBeenCalledTimes(1)
    expect(candidateUpdateOneCalls).toBe(1)
    expect(divergences()).toEqual([])
    spy.mockRestore()
  })

  it('accepts differing now-stamped timestamps only when generated by the same call', async () => {
    const delayed = await setup({
      candidate: (adapter) => {
        const createGlobal = adapter.createGlobal
        adapter.createGlobal = async function (...callArgs: unknown[]) {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return createGlobal.apply(this, callArgs)
        }
      },
    })
    await delayed.payload.updateGlobal({ data: { siteName: 'a' }, slug: 'settings' })
    await delayed.payload.findGlobal({ slug: 'settings' })
    expect(delayed.divergences()).toEqual([])

    const stale = await setup({
      candidate: (adapter) => {
        const createGlobal = adapter.createGlobal
        adapter.createGlobal = async function (...callArgs: unknown[]) {
          const result = await createGlobal.apply(this, callArgs)
          return {
            ...result,
            createdAt: new Date(Date.parse(result.createdAt) - 5_000).toISOString(),
          }
        }
      },
    })
    await stale.payload.updateGlobal({ data: { siteName: 'b' }, slug: 'settings' })
    expect(stale.divergences().map((d) => [d.method, (d.differences as any[])[0].path])).toEqual([
      ['createGlobal', 'createdAt'],
    ])
  })

  it('diffs schema and rows of both database files', async () => {
    const { divergences, payload } = await setup({
      candidate: (adapter) => {
        const create = adapter.create
        adapter.create = async function (...callArgs: unknown[]) {
          const result = await create.apply(this, callArgs)
          await this.client.execute(
            `UPDATE posts SET created_at = substr(created_at, 1, 19) || 'Z'`,
          )
          await this.client.execute(
            'CREATE INDEX IF NOT EXISTS candidate_only_idx ON posts (title)',
          )
          return result
        }
      },
    })
    await payload.create({ collection: 'posts', data: { title: 'stored' } })
    // the first call after connect already diffed the freshly pushed schemas (equal)
    const checksBefore = getShadowState(payload.db)!.dbChecks
    const differences = await getShadowState(payload.db)!.diffDatabases()
    expect(differences.map((d) => [d.kind, d.path])).toEqual(
      expect.arrayContaining([
        ['extraKey', 'schema["index candidate_only_idx"]'],
        ['value', 'tables.posts[0].created_at'],
      ]),
    )
    expect(divergences().map((d) => d.method)).toEqual(['dbState'])
    expect(getShadowState(payload.db)!.dbChecks).toBe(checksBefore + 1)
  })

  it('diffs the databases when the next test starts, after a test that wrote', async () => {
    let testName = 'first test'
    const { divergences, payload } = await setup({
      candidate: (adapter) => {
        const create = adapter.create
        adapter.create = async function (...callArgs: unknown[]) {
          const result = await create.apply(this, callArgs)
          await this.client.execute(
            `UPDATE posts SET title = 'changed in storage only' WHERE id = (SELECT max(id) FROM posts)`,
          )
          return result
        }
        const find = adapter.find
        adapter.find = async function (...callArgs: unknown[]) {
          await this.client.execute(`UPDATE posts SET title = 'stored'`)
          return find.apply(this, callArgs)
        }
      },
      context: () => ({ testName }),
    })
    await payload.create({ collection: 'posts', data: { title: 'stored' } })
    await payload.find({ collection: 'posts' })
    expect(divergences()).toEqual([])

    await payload.create({ collection: 'posts', data: { title: 'stored' } })
    testName = 'second test'
    await payload.count({ collection: 'posts' })
    const [dbState] = divergences()
    expect(dbState).toMatchObject({
      finishedTest: 'first test',
      method: 'dbState',
      reason: 'testEnd',
    })
    expect(dbState!.differences).toEqual([
      {
        candidate: 'changed in storage only',
        kind: 'value',
        path: 'tables.posts[1].title',
        reference: 'stored',
      },
    ])
  })

  it('strict mode throws on divergence', async () => {
    const { payload } = await setup({
      candidate: (adapter) => {
        adapter.count = async () => ({ totalDocs: 42 })
      },
      onDivergence: 'throw',
    })
    await expect(payload.count({ collection: 'posts' })).rejects.toThrow(
      'Shadow divergence in count',
    )
  })
})

describe('clock replay', () => {
  it('replays the reference clock readings to the candidate half of the same call', async () => {
    installClockReplay()
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const tapes = createClockTapes()
    const read = async () => {
      const first = Date.now()
      await sleep(3)
      return [first, new Date().getTime(), new Date(0).getTime(), new Date(2020, 0).getTime()]
    }

    const referenceReadings = await tapes.reference(read)
    await sleep(3)
    const candidateReadings = await tapes.candidate(read)

    expect(candidateReadings).toEqual(referenceReadings)
    // past the end of the tape, and outside any call: the real clock
    expect(tapes.candidate(() => Date.now())).toBeGreaterThan(referenceReadings[1]!)
    expect(Date.now()).toBeGreaterThan(referenceReadings[1]!)
    expect(typeof Date()).toBe('string')
    expect(new Date(0)).toBeInstanceOf(Date)
    expect(Object.prototype.toString.call(new Date())).toBe('[object Date]')
  })

  it('replays crypto.randomUUID() of the reference to the candidate half of the same call', async () => {
    installClockReplay()
    const tapes = createClockTapes()
    const read = async () => {
      const first = crypto.randomUUID()
      await Promise.resolve()
      return [first, crypto.randomUUID()]
    }

    const referenceUUIDs = await tapes.reference(read)
    const candidateUUIDs = await tapes.candidate(read)

    expect(candidateUUIDs).toEqual(referenceUUIDs)
    expect(referenceUUIDs[0]).not.toBe(referenceUUIDs[1])
    // past the end of the tape, and outside any call: fresh values
    expect(referenceUUIDs).not.toContain(tapes.candidate(() => crypto.randomUUID()))
    expect(referenceUUIDs).not.toContain(crypto.randomUUID())
  })
})

describe('compareValues', () => {
  it('is strict about undefined vs missing, key order, types and arrays', () => {
    expect(compareValues({ a: undefined }, {})).toMatchObject([{ kind: 'missingKey', path: 'a' }])
    expect(compareValues({ a: 1, b: 2 }, { b: 2, a: 1 })).toMatchObject([{ kind: 'keyOrder' }])
    expect(compareValues({ a: 1 }, { a: '1' })).toMatchObject([{ kind: 'type', path: 'a' }])
    expect(compareValues([1, 2], [1])).toMatchObject([{ kind: 'length' }])
    expect(compareValues({ a: null }, { a: undefined })).toMatchObject([{ kind: 'type' }])
    expect(compareValues(NaN, NaN)).toEqual([])
    expect(compareValues(new Date(0), new Date(0))).toEqual([])
  })

  it('accepts differing timestamps only as now-pairs in exact toISOString format', () => {
    const t = '2024-01-01T00:00:00.000Z'
    const t2 = '2024-01-01T00:00:00.015Z'
    const always = { isNowPair: () => true }
    const never = { isNowPair: () => false }

    expect(compareValues({ createdAt: t }, { createdAt: t2 })).toHaveLength(1)
    expect(compareValues({ createdAt: t }, { createdAt: t2 }, never)).toHaveLength(1)
    expect(compareValues({ createdAt: t, other: t }, { createdAt: t2, other: t2 }, always)).toEqual(
      [],
    )
    expect(compareValues(new Date(t), new Date(t2), always)).toEqual([])
    for (const reformatted of [
      '2024-01-01T00:00:00Z',
      '2024-01-01T00:00:00+00:00',
      '2024-01-01T00:00:00.000000Z',
      '2024-01-01 00:00:00.015Z',
      '2024-01-01T00:00:00.015z',
    ]) {
      expect(compareValues({ createdAt: t }, { createdAt: reformatted }, always)).toHaveLength(1)
    }
    expect(compareValues({ createdAt: t }, { createdAt: new Date(t2) }, always)).toHaveLength(1)

    const received: number[][] = []
    compareValues(t, t2, {
      isNowPair: (a, b, precision) => (received.push([a, b, precision]), true),
    })
    expect(received).toEqual([[Date.parse(t), Date.parse(t2), 1]])
  })

  it('accepts differing SQLite CURRENT_TIMESTAMP values only as now-pairs in that exact format', () => {
    const t = '2024-01-01 00:00:00'
    const t2 = '2024-01-01 00:00:01'
    const always = { isNowPair: () => true }

    expect(compareValues(t, t2)).toHaveLength(1)
    expect(compareValues(t, t2, { isNowPair: () => false })).toHaveLength(1)
    expect(compareValues(t, t2, always)).toEqual([])
    for (const reformatted of [
      '2024-01-01T00:00:01.000Z',
      '2024-01-01 00:00:01.000',
      '2024-01-01 0:00:01',
    ]) {
      expect(compareValues(t, reformatted, always)).toHaveLength(1)
    }
    // not a real time: does not round-trip
    expect(compareValues(t, '2024-01-01 24:00:00', always)).toHaveLength(1)

    const received: number[][] = []
    compareValues(t, t2, {
      isNowPair: (a, b, precision) => (received.push([a, b, precision]), true),
    })
    expect(received).toEqual([
      [Date.parse('2024-01-01T00:00:00Z'), Date.parse('2024-01-01T00:00:01Z'), 1000],
    ])
  })

  it('compares errors by class, name, message, status and data', () => {
    expect(compareValues(new Error('a'), new Error('a'))).toEqual([])
    expect(compareValues(new Error('a'), new TypeError('a'))).not.toEqual([])
    expect(compareValues(new Error('a'), new Error('b'))).toMatchObject([{ path: 'message' }])
  })
})
