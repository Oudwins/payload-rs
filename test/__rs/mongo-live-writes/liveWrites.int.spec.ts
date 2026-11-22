import { types as utilTypes } from 'node:util'
/**
 * Live differential of the db-mongodb write methods (harness.ts): every scenario of scenarios.ts runs
 * with upstream TS and with the live Rust port on the same inputs and database state and must record
 * identical traces, outcomes and database contents. Run through ./run.sh (MongoDB, own database,
 * PAYLOAD_ENGINE=ts, PAYLOAD_ENGINE_ADDON = the payload-node addon).
 */
import { afterAll, expect } from 'vitest'

import { create as upstreamCreate } from '../../../packages/db-mongodb/src/create.js'
import { createGlobal as upstreamCreateGlobal } from '../../../packages/db-mongodb/src/createGlobal.js'
import { createGlobalVersion as upstreamCreateGlobalVersion } from '../../../packages/db-mongodb/src/createGlobalVersion.js'
import { createVersion as upstreamCreateVersion } from '../../../packages/db-mongodb/src/createVersion.js'
import { deleteMany as upstreamDeleteMany } from '../../../packages/db-mongodb/src/deleteMany.js'
import { deleteOne as upstreamDeleteOne } from '../../../packages/db-mongodb/src/deleteOne.js'
import { deleteVersions as upstreamDeleteVersions } from '../../../packages/db-mongodb/src/deleteVersions.js'
import { updateGlobal as upstreamUpdateGlobal } from '../../../packages/db-mongodb/src/updateGlobal.js'
import { updateGlobalVersion as upstreamUpdateGlobalVersion } from '../../../packages/db-mongodb/src/updateGlobalVersion.js'
import { updateJobs as upstreamUpdateJobs } from '../../../packages/db-mongodb/src/updateJobs.js'
import { updateMany as upstreamUpdateMany } from '../../../packages/db-mongodb/src/updateMany.js'
import { updateOne as upstreamUpdateOne } from '../../../packages/db-mongodb/src/updateOne.js'
import { updateVersion as upstreamUpdateVersion } from '../../../packages/db-mongodb/src/updateVersion.js'
import { upsert as upstreamUpsert } from '../../../packages/db-mongodb/src/upsert.js'
import { resolveDbMongodbMongoose } from '../../../packages/engine-rs/src/mongo-live/host.js'
import { getMongoLive } from '../../../packages/engine-rs/src/mongo-live/index.js'
import { test } from '../../__helpers/int/vitest.js'
import { getMongoLiveWrite, liveWriteMethods } from './glue.js'
import {
  compare,
  firstDifference,
  internals,
  landmarkViolations,
  recordKeys,
  runOnce,
} from './harness.js'
import { scenarios } from './scenarios.js'

const upstream = {
  create: upstreamCreate,
  createGlobal: upstreamCreateGlobal,
  createGlobalVersion: upstreamCreateGlobalVersion,
  createVersion: upstreamCreateVersion,
  deleteMany: upstreamDeleteMany,
  deleteOne: upstreamDeleteOne,
  deleteVersions: upstreamDeleteVersions,
  updateGlobal: upstreamUpdateGlobal,
  updateGlobalVersion: upstreamUpdateGlobalVersion,
  updateJobs: upstreamUpdateJobs,
  updateMany: upstreamUpdateMany,
  updateOne: upstreamUpdateOne,
  updateVersion: upstreamUpdateVersion,
  upsert: upstreamUpsert,
}

let compared = 0
const exercised = new Set<string>()
/** LW_ONLY=<regexp>: run only the matching scenarios (debugging; the coverage checks are skipped) */
const only = process.env.LW_ONLY ? new RegExp(process.env.LW_ONLY) : undefined
const selected = only ? scenarios.filter((s) => only.test(s.name)) : scenarios
const parityScenarios = selected.filter((s) => !s.knownDivergence)

/** What user code can observe about a function without calling it. */
const reflect = (f: any) => {
  const AsyncFunction = (async () => {}).constructor
  let constructible = true
  try {
    Reflect.construct(function () {}, [], f)
  } catch {
    constructible = false
  }
  return {
    descriptors: Object.fromEntries(
      Reflect.ownKeys(f).map((k) => {
        const d = Object.getOwnPropertyDescriptor(f, k)!
        return [String(k), { ...d, value: typeof d.value === 'function' ? 'fn' : d.value }]
      }),
    ),
    constructible,
    isAsyncFunction: utilTypes.isAsyncFunction(f),
    prototypeIsAsyncFunctionPrototype: Object.getPrototypeOf(f) === AsyncFunction.prototype,
    tag: Object.prototype.toString.call(f),
    toStringPrefix:
      Function.prototype.toString.call(f).match(/^async function \w+\(/)?.[0] !== undefined,
  }
}

test.suite(
  'mongo live writes: TS vs Rust',
  { config: './config.ts', db: 'mongo', resetBetweenTests: false },
  () => {
    test('the reference is upstream TS and the candidate is the live binding', ({ payload }) => {
      expect(process.env.PAYLOAD_ENGINE).toBe('ts')
      expect(process.env.PAYLOAD_CORE_ENGINE).toBeUndefined()
      const db = payload.db as any
      expect(payload.config.globals.map((g) => g.slug)).toContain('settings')
      expect(Object.keys(db.collections)).toContain('posts')
      expect(db.globals).toBeTruthy()
      for (const method of liveWriteMethods) {
        expect(db[method], method).toBe(upstream[method])
      }
      // the live host's mongoose (bson classes, Types.ObjectId) is the adapter's own
      expect(db.connection.base).toBe(resolveDbMongodbMongoose())
      // which db-mongodb functions the Rust runs use as Rust ports (vs upstream TS through the host)
      console.log('live deps ported:', JSON.stringify(getMongoLive().ported()))
      // every scenario declares its branch landmarks
      for (const scenario of scenarios) {
        expect(scenario.expect.reach.length, scenario.name).toBeGreaterThan(0)
      }
    })

    test('the installed methods are async functions like upstream (writes items 10 / 11)', () => {
      const binding = getMongoLiveWrite()
      for (const method of liveWriteMethods) {
        const rs = reflect(binding[method])
        const ts = reflect(upstream[method])
        expect(rs, method).toEqual(ts)
        expect(rs.isAsyncFunction, method).toBe(true)
        expect(rs.constructible, method).toBe(false)
        expect(binding[method].name, `${method}.name`).toBe(upstream[method].name)
        expect(binding[method].length, `${method}.length`).toBe(upstream[method].length)
        expect(() => new (binding[method] as any)({}), method).toThrow(TypeError)
      }
      // negative control: a plain Node-API function (what the methods were before) is told apart
      const native = reflect(binding.init)
      expect(native.isAsyncFunction).toBe(false)
      expect(native.constructible).toBe(true)
    })

    test('harness: snapshots run no getters / traps and keep identities and flags (gaps E / F)', () => {
      const r = new internals.Recorder()
      let getterCalls = 0
      const withGetter = {
        get stateful() {
          return ++getterCalls
        },
      }
      const userProxy = new Proxy(
        {},
        {
          get() {
            getterCalls++
            return 1
          },
          getOwnPropertyDescriptor() {
            getterCalls++
            return undefined
          },
          ownKeys() {
            getterCalls++
            return []
          },
        },
      )
      const cls = new (class Thing {
        get x() {
          return ++getterCalls
        }
      })()
      r.describe({ cls, userProxy, withGetter, arr: [withGetter] })
      expect(getterCalls).toBe(0)
      const f1 = function same() {}
      const f2 = function same() {}
      expect(JSON.stringify(r.describe(f1))).not.toBe(JSON.stringify(r.describe(f2)))
      const s1 = Symbol('same')
      const s2 = Symbol('same')
      expect(JSON.stringify(r.describe(s1))).not.toBe(JSON.stringify(r.describe(s2)))
      const a = { k: 1 }
      const b = {}
      Object.defineProperty(b, 'k', {
        enumerable: true,
        value: 1,
        writable: false,
        configurable: true,
      })
      const describeFresh = (v: unknown) => JSON.stringify(new internals.Recorder().describe(v))
      expect(describeFresh(a)).not.toBe(describeFresh(b))
      expect(describeFresh({})).not.toBe(describeFresh(Object.create(null)))
      // absolute hex strings are kept; only ids generated by this process are canonicalized
      const generated = new (resolveDbMongodbMongoose() as any).Types.ObjectId().toHexString()
      const json = JSON.stringify({
        a: '64b000000000000000000099',
        b: generated,
        c: `x ${generated}`,
      })
      expect(internals.canonicalize(json)).toBe(
        JSON.stringify({ a: '64b000000000000000000099', b: '<oid 0>', c: 'x <oid 0>' }),
      )
    })

    test('harness: tick counts are exact over long unlogged microtask runs (gap G)', async () => {
      const ticksBefore = async (n: number) => {
        const r = new internals.Recorder()
        const stop = r.hookJobs()
        r.active = true
        r.tracing = true
        r.kick()
        let p: Promise<unknown> = Promise.resolve()
        for (let i = 0; i < n; i++) {
          p = p.then(() => {})
        }
        await p
        r.log('event')
        r.active = false
        stop()
        return r.events[0]![0] as number
      }
      const [a, b] = [await ticksBefore(200), await ticksBefore(201)]
      expect(a).toBeGreaterThan(64)
      expect(b).toBe(a + 1)
    })

    for (const scenario of selected) {
      const title = scenario.knownDivergence
        ? `[known divergence, not a parity case] ${scenario.name}`
        : scenario.name
      test(title, { timeout: 120_000 }, async ({ payload }) => {
        const { diff, rs, ts } = await compare(payload, scenario)
        const raw = payload.db as any
        const violations = landmarkViolations(raw, scenario, ts.json)
        const context = () =>
          `TS outcome ${ts.outcome} ${ts.errorClass ?? ''}: ${JSON.stringify(JSON.parse(ts.json).outcome).slice(0, 600)}\n${ts.stack ?? ''}\nlandmark violations: ${violations.join('; ')}\nkeys: ${recordKeys(ts.json).join(' | ').slice(0, 4000)}`
        // the scenario reached what it exists for, in the reference (and so in the candidate)
        expect(ts.outcome, context()).toBe(scenario.expect.outcome)
        if (scenario.expect.outcome === 'error') {
          expect(ts.errorClass, context()).toBe(scenario.expect.error)
        }
        expect(violations, context()).toEqual([])
        if (scenario.knownDivergence) {
          console.log(
            `known divergence "${scenario.name}" (${scenario.knownDivergence}): ${diff ? `still differs\n${diff}` : 'now MATCHES upstream (promote it to a parity case)'}`,
          )
          return
        }
        compared++
        for (const [method, n] of Object.entries(rs.stats)) {
          if (n > 0) {
            exercised.add(method)
          }
        }
        expect(diff, diff).toBeUndefined()
      })
    }

    test('negative control: one extra clock read is detected', async ({ payload }) => {
      const scenario = scenarios.find((s) => s.name.startsWith('create: plain post'))!
      const ts = await runOnce(payload, scenario, 'ts')
      const mutant = await runOnce(payload, scenario, 'mutant')
      expect(firstDifference(ts.json, mutant.json)).toBeDefined()
      // and a TS run compared with itself is identical (the harness is deterministic)
      const again = await runOnce(payload, scenario, 'ts')
      expect(firstDifference(ts.json, again.json)).toBeUndefined()
    })

    afterAll(() => {
      // zero compared cases or an unexercised method fail the file
      expect(compared).toBe(parityScenarios.length)
      if (!only) {
        expect([...exercised].sort()).toEqual([...liveWriteMethods].sort())
      }
    })
  },
)
