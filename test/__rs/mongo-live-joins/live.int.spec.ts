/**
 * Live differential of the joins ports (crates/payload-mongo-live-joins) against upstream
 * db-mongodb on the test/joins config: the same live inputs go to upstream TS and to Rust, both
 * traced by tracer.ts (every proxy read/write on adapter/config/args/docs, every model call with
 * its arguments, every spied buildQuery/buildSortParam/transform call, microtask ticks, delivery
 * order, result, error identity, final input state). Covers the joins review items: fail-fast
 * Promise.all (1), awaits at ready query builders keep the db-call order (3), the count query is
 * constructed before the aggregate (4, aggregatePaginate of payload-mongo-live), -0 kept (the
 * stage-1 recorder defect). Negative controls (mutant candidates, self-comparison) must be
 * detected. Run with test/__rs/mongo-live-joins/vitest.config.ts (spies) and the addon at
 * PAYLOAD_ENGINE_ADDON.
 */
import type { Payload } from 'payload'

import fs from 'node:fs'
import { expect } from 'vitest'

import { aggregatePaginate as tsAggregatePaginate } from '../../../packages/db-mongodb/src/utilities/aggregatePaginate.js'
import { buildJoinAggregation as tsBuildJoinAggregation } from '../../../packages/db-mongodb/src/utilities/buildJoinAggregation.js'
import { resolveJoins as tsResolveJoins } from '../../../packages/db-mongodb/src/utilities/resolveJoins.js'
import { getMongoLive } from '../../../packages/engine-rs/src/mongo-live/index.js'
import { test } from '../../__helpers/int/vitest.js'
import { engineEntries, rsJoins } from './glue.js'
import {
  clonePlain,
  createTrace,
  describe as describeValue,
  diffOutcomes,
  runSide,
  spyOverrides,
} from './tracer.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- live inputs of arbitrary shape */
type Any = any

const HANG_MS = 5000

const withTimeout = (p: Promise<Any>) =>
  Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('hang')), HANG_MS)),
  ])

type Fn = (args: Any) => Promise<Any>

/**
 * Runs `reference` and `candidate` on fresh inputs from `inputs()` (same shape, same live adapter)
 * and returns the first difference. `minEvents` guards against vacuous traces.
 */
const differential = async ({
  candidate,
  inputs,
  reference,
}: {
  candidate: Fn
  inputs: () => Record<string, Any>
  reference: Fn
}) => {
  const run = (side: 'rs' | 'ts', fn: Fn) => {
    const all = inputs()
    const objects = Object.fromEntries(
      Object.entries(all).filter(
        ([, v]) => (typeof v === 'object' && v !== null) || typeof v === 'function',
      ),
    )
    return runSide(side, objects, (w) => withTimeout(fn({ ...all, ...w })))
  }
  const ts = await run('ts', reference)
  const before = engineEntries()
  const rs = await run('rs', candidate)
  const diff = diffOutcomes(ts, rs)
  if (diff && process.env.RS_LIVE_JOINS_DUMP) {
    const base = `${process.env.RS_LIVE_JOINS_DUMP}/diff-${Date.now()}`
    fs.writeFileSync(`${base}-ts.txt`, [ts.error, ts.result, ...ts.events].join('\n'))
    fs.writeFileSync(`${base}-rs.txt`, [rs.error, rs.result, ...rs.events].join('\n'))
  }
  return { diff, reachedRust: engineEntries() > before, rs, ts }
}

const rs = {
  aggregatePaginate: (a: Any) => getMongoLive().aggregatePaginate(a) as Promise<Any>,
  buildJoinAggregation: (a: Any) => rsJoins().buildJoinAggregation(a),
  resolveJoins: (a: Any) => rsJoins().resolveJoins(a),
}

const expectSame = async (args: {
  candidate: Fn
  inputs: () => Record<string, Any>
  minEvents?: number
  reference: Fn
}) => {
  const result = await differential(args)
  expect(result.diff).toBeUndefined()
  expect(result.reachedRust).toBe(true)
  expect(result.ts.events.length).toBeGreaterThan(args.minEvents ?? 60)
  return result
}

const seed = async (payload: Payload) => {
  const category = await payload.create({
    overrideAccess: true,
    collection: 'categories',
    data: { name: 'c1' } as Any,
  })
  const other = await payload.create({
    overrideAccess: true,
    collection: 'categories',
    data: { name: 'c2' } as Any,
  })
  for (let i = 0; i < 4; i++) {
    await payload.create({
      overrideAccess: true,
      collection: 'posts',
      data: {
        array: [{ category: category.id }],
        category: i % 2 ? other.id : category.id,
        group: { category: category.id },
        polymorphic: { relationTo: 'categories', value: category.id },
        title: `post ${i}`,
      } as Any,
    })
  }
  await payload.create({
    overrideAccess: true,
    collection: 'versions',
    data: { category: category.id, title: 'v1' } as Any,
  })
  const categoryVersion = await payload.create({
    overrideAccess: true,
    collection: 'categories-versions',
    data: { title: 'cv' } as Any,
  })
  await payload.create({
    overrideAccess: true,
    collection: 'versions',
    data: { categoryVersion: categoryVersion.id, title: 'v2' } as Any,
    draft: true,
  })
  return { category, categoryVersion, other }
}

/** Lean parent docs like the read methods hand to resolveJoins. */
const leanDocs = async (payload: Payload, slug: string, versions = false) => {
  const Model = versions
    ? (payload.db as Any).versions[slug]
    : (payload.db as Any).collections[slug]
  return Model.find({}).lean()
}

const config = (payload: Payload, slug: string) => payload.collections[slug as 'posts']!.config

/**
 * Runs `fn` with the live adapter's `useJoinAggregations` set to `value` (restored afterwards), so
 * the aggregation path and the early return run in every database mode (PAYLOAD_DATABASE=firestore
 * has it false) on the very adapter object the tracer records.
 */
const withJoinAggregations = async <T>(payload: Payload, value: boolean, fn: () => Promise<T>) => {
  const adapter = payload.db as Any
  const previous = adapter.useJoinAggregations
  adapter.useJoinAggregations = value
  try {
    return await fn()
  } finally {
    adapter.useJoinAggregations = previous
  }
}

test.suite('Mongo live joins differential', { config: '../../joins/config.ts' }, () => {
  test.afterEach(() => {
    for (const key of Object.keys(spyOverrides)) {
      delete spyOverrides[key]
    }
  })

  test('should describe -0 distinctly from 0 (stage-1 recorder defect)', () => {
    const t = createTrace('ts')
    expect(describeValue(t, -0)).not.toBe(describeValue(t, 0))
  })

  test('should match upstream resolveJoins for regular, polymorphic and nested joins', async ({
    payload,
  }) => {
    await seed(payload)
    const docs = await leanDocs(payload, 'categories')
    await expectSame({
      candidate: rs.resolveJoins,
      inputs: () => ({
        adapter: payload.db,
        collectionSlug: 'categories',
        docs: clonePlain(docs),
        joins: {
          'group.relatedPosts': { limit: 1, sort: 'title' },
          noRowTypes: { count: true },
          polymorphic: { count: true, limit: 0 },
          polymorphicJoin: { count: true, limit: 1, page: 2 },
          relatedPosts: { count: true, limit: 2, where: { title: { not_equals: 'post 1' } } },
        },
        locale: 'en',
      }),
      reference: tsResolveJoins,
    })
  })

  test('should match upstream resolveJoins for drafts (versions: true)', async ({ payload }) => {
    await seed(payload)
    const docs = await leanDocs(payload, 'categories-versions', true)
    await expectSame({
      candidate: rs.resolveJoins,
      inputs: () => ({
        adapter: payload.db,
        collectionSlug: 'categories-versions',
        docs: clonePlain(docs),
        joins: { relatedVersions: { count: true }, relatedVersionsMany: { limit: 3 } },
        locale: 'all',
        versions: true,
      }),
      reference: tsResolveJoins,
    })
  })

  test('should keep coercions and -0 of join queries', async ({ payload }) => {
    await seed(payload)
    const docs = await leanDocs(payload, 'categories')
    await expectSame({
      candidate: rs.resolveJoins,
      inputs: () => ({
        adapter: payload.db,
        collectionSlug: 'categories',
        docs: clonePlain(docs),
        joins: {
          polymorphicJoin: {
            count: 1,
            limit: '2',
            page: '2',
            where: { and: [{ relationTo: { in: ['posts'] } }, { title: { exists: true } }] },
          },
          relatedPosts: { limit: -0, page: -0 },
          'group.relatedPosts': false,
        },
        projection: { 'group.relatedPosts': true, polymorphicJoin: true, relatedPosts: true },
      }),
      reference: tsResolveJoins,
    })
  })

  test('should fail fast like Promise.all when one join fails while a sibling is pending', async ({
    payload,
  }) => {
    await seed(payload)
    const docs = await leanDocs(payload, 'categories')
    const error = new Error('join failed')
    for (const failFirst of [true, false]) {
      let calls = 0
      spyOverrides.buildQuery = () => {
        const n = calls++ % 2
        return (n === 0) === failFirst ? Promise.reject(error) : new Promise(() => {})
      }
      const result = await expectSame({
        candidate: rs.resolveJoins,
        inputs: () => ({
          adapter: payload.db,
          collectionSlug: 'categories',
          docs: clonePlain(docs),
          joins: { 'group.relatedPosts': {}, relatedPosts: {} },
        }),
        minEvents: 20,
        reference: tsResolveJoins,
      })
      expect(result.rs.thrown).toBe(error)
      expect(result.ts.thrown).toBe(error)
    }
  })

  test('should yield at ready query builders like upstream (db-call order)', async ({
    payload,
  }) => {
    await seed(payload)
    const docs = await leanDocs(payload, 'categories')
    // resolved immediately: the order of the find/countDocuments calls of the joins is decided by
    // the awaits alone
    spyOverrides.buildQuery = () => Promise.resolve({})
    const result = await expectSame({
      candidate: rs.resolveJoins,
      inputs: () => ({
        adapter: payload.db,
        collectionSlug: 'categories',
        docs: clonePlain(docs),
        joins: {
          'group.relatedPosts': {},
          polymorphicJoin: {},
          relatedPosts: {},
        },
      }),
      reference: tsResolveJoins,
    })
    const calls = result.rs.events.filter((e) => /\.(find|countDocuments)\(/.test(e))
    expect(calls.length).toBeGreaterThan(3)
  })

  test('should propagate a throwing getter of the joins argument as the same error', async ({
    payload,
  }) => {
    await seed(payload)
    const docs = await leanDocs(payload, 'categories')
    const error = new Error('getter')
    const result = await expectSame({
      candidate: rs.resolveJoins,
      inputs: () => {
        const joins: Any = { relatedPosts: { limit: 1 } }
        Object.defineProperty(joins, 'group.relatedPosts', {
          enumerable: true,
          get() {
            throw error
          },
        })
        return {
          adapter: payload.db,
          collectionSlug: 'categories',
          docs: clonePlain(docs),
          joins,
        }
      },
      minEvents: 20,
      reference: tsResolveJoins,
    })
    expect(result.rs.thrown).toBe(error)
  })

  test('should match upstream buildJoinAggregation', async ({ payload }) => {
    const cases: Record<string, Any>[] = [
      { collection: 'categories', locale: 'en' },
      { collection: 'categories', locale: 'all' },
      {
        collection: 'categories',
        joins: {
          'group.relatedPosts': false,
          polymorphicJoin: { count: true, limit: '2', page: '3', sort: '-title' },
          relatedPosts: { count: 1, limit: -0, page: 2, where: { title: { exists: true } } },
        },
        locale: 'es',
      },
      { collection: 'categories', projection: { polymorphicJoin: true, relatedPosts: true } },
      { collection: 'categories-versions', draftsEnabled: true, locale: 'en' },
      {
        collection: 'categories-versions',
        joins: { relatedVersions: { count: true, limit: 0 } },
        projection: { 'version.relatedVersions': true },
        versions: true,
      },
    ]
    for (const c of cases) {
      await withJoinAggregations(payload, true, () =>
        expectSame({
          candidate: rs.buildJoinAggregation,
          inputs: () => ({
            adapter: payload.db,
            collectionConfig: config(payload, c.collection),
            ...structuredClone(c),
          }),
          reference: tsBuildJoinAggregation,
        }),
      )
    }
  })

  test('should throw the same APIError for an unknown collection', async ({ payload }) => {
    const result = await withJoinAggregations(payload, true, () =>
      expectSame({
        candidate: rs.buildJoinAggregation,
        inputs: () => ({
          adapter: payload.db,
          collection: 'unknown-slug',
          collectionConfig: config(payload, 'categories'),
        }),
        minEvents: 5,
        reference: tsBuildJoinAggregation,
      }),
    )
    expect(result.rs.thrown?.constructor?.name).toBe('APIError')
  })

  test('should return early like upstream without join aggregations', async ({ payload }) => {
    const result = await withJoinAggregations(payload, false, () =>
      expectSame({
        candidate: rs.buildJoinAggregation,
        inputs: () => ({
          adapter: payload.db,
          collection: 'categories',
          collectionConfig: config(payload, 'categories'),
          joins: { relatedPosts: { limit: 1 } },
        }),
        minEvents: 0,
        reference: tsBuildJoinAggregation,
      }),
    )
    expect(result.ts.value).toEqual([])
  })

  test('should construct the count query before the aggregate (aggregatePaginate)', async ({
    payload,
  }) => {
    await seed(payload)
    const result = await expectSame({
      candidate: rs.aggregatePaginate,
      inputs: () => ({
        adapter: payload.db,
        limit: 2,
        Model: (payload.db as Any).collections.posts,
        page: 2,
        query: {},
        sort: { title: 'desc' },
      }),
      minEvents: 20,
      reference: tsAggregatePaginate,
    })
    const order = result.rs.events.filter((e) => /\.(aggregate|countDocuments)\(|^then /.test(e))
    expect(order[0]).toMatch(/countDocuments/)
    expect(order[1]).toMatch(/aggregate/)
  })

  test('should detect deviating candidates (negative controls)', async ({ payload }) => {
    await seed(payload)
    const docs = await leanDocs(payload, 'categories')
    const inputs = () => ({
      adapter: payload.db,
      collectionSlug: 'categories',
      docs: clonePlain(docs),
      joins: { polymorphicJoin: { limit: 1 }, relatedPosts: { count: true } },
    })
    // self-comparison is clean (the harness is deterministic) ...
    const self = await differential({
      candidate: tsResolveJoins,
      inputs,
      reference: tsResolveJoins,
    })
    expect(self.diff).toBeUndefined()
    expect(self.reachedRust).toBe(false)
    // ... and every mutant is caught
    const mutants: Record<string, Fn> = {
      'copies the joins argument': (a) => rs.resolveJoins({ ...a, joins: { ...a.joins } }),
      'extra await before the call': async (a) => {
        await null
        return rs.resolveJoins(a)
      },
      'reads an argument twice': (a) => {
        void a.joins.relatedPosts
        return rs.resolveJoins(a)
      },
      'serial joins (no Promise.all)': async (a) => {
        for (const [k, v] of Object.entries(a.joins)) {
          await rs.resolveJoins({ ...a, joins: { [k]: v } })
        }
      },
    }
    for (const [name, candidate] of Object.entries(mutants)) {
      const result = await differential({ candidate, inputs, reference: tsResolveJoins })
      expect(result.diff, name).toBeDefined()
    }
  })
})
