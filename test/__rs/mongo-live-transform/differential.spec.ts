/**
 * Live differential of crates/payload-mongo-live-transform against upstream
 * packages/db-mongodb/src/utilities/{transform,handleError,getEntity,getDBName,isObjectID}.ts.
 *
 * Every case builds two identical inputs (data, operator objects, adapter, args, errors, req,
 * configs) wrapped in recording proxies; the TS reference runs on one, the Rust port on the
 * other. Compared per case: the ordered log of every proxy trap (reads, writes with the written
 * value, deletes, `in` checks, key enumerations, descriptor reads, prototype reads), the final
 * state of every input root with object identity (which input object sits where, new vs reused
 * containers, shared references, prototypes, property attributes, frozen state), caller-retained
 * objects, the return value, and the thrown value (class, name, message, identity with thrown
 * sentinels / input errors, ValidationError data).
 *
 *   PAYLOAD_ENGINE_ADDON=/tmp/livetransform-addon/payload-engine.node \
 *     pnpm vitest run --config test/__rs/mongo-live-transform/vitest.config.ts --project live-transform-unit
 */
import mongoose from 'mongoose'
import { APIError, ValidationError } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { Case, FnName } from './cases.js'
import type { World } from './world.js'

import { getDBName as getDBNameTS } from '../../../packages/db-mongodb/src/utilities/getDBName.js'
import {
  getCollection as getCollectionTS,
  getGlobal as getGlobalTS,
} from '../../../packages/db-mongodb/src/utilities/getEntity.js'
import { handleError as handleErrorTS } from '../../../packages/db-mongodb/src/utilities/handleError.js'
import { isObjectID as isObjectIDTS } from '../../../packages/db-mongodb/src/utilities/isObjectID.js'
import { transform as transformTS } from '../../../packages/db-mongodb/src/utilities/transform.js'
import { adversarialCases } from './adversarial.js'
import { fixedCases, hex, randomCases, transformCase, utilityCases, weirdFields } from './cases.js'
import { getLiveTransformBinding } from './native.js'
import { createWorld } from './world.js'

type Impl = Record<FnName, (args: any) => unknown>

const ts: Impl = {
  getCollection: getCollectionTS as any,
  getDBName: getDBNameTS as any,
  getGlobal: getGlobalTS as any,
  handleError: handleErrorTS as any,
  isObjectID: isObjectIDTS,
  transform: transformTS as any,
}

const binding = getLiveTransformBinding()

const rs: Impl = {
  getCollection: binding.getCollection,
  getDBName: binding.getDBName,
  getGlobal: binding.getGlobal,
  handleError: binding.handleError,
  isObjectID: binding.isObjectID,
  transform: binding.transform,
}

const BSONError = (mongoose.mongo as any).BSON.BSONError

const errorExtra = (w: World) => (error: unknown) => ({
  data: error instanceof ValidationError ? w.describe({ data: error.data }).data : undefined,
  isAPIError: error instanceof APIError,
  isBSONError: error instanceof BSONError,
  isTypeError: error instanceof TypeError,
  isValidationError: error instanceof ValidationError,
  self: w.describe({ thrown: error }).thrown,
  status: (error as { status?: unknown })?.status,
})

const runOne = (c: Case, impl: Impl): string => {
  const w = createWorld()
  const { after, args, patch, roots } = c.build(w)
  let result: unknown
  let error: unknown
  let threw = false
  let afterOutcome: unknown
  w.start()
  let restore = patch?.()
  try {
    result = impl[c.fn](args)
  } catch (e) {
    threw = true
    error = e
  } finally {
    restore?.()
  }
  if (after) {
    restore = patch?.()
    let value: unknown
    try {
      value = after()
      restore?.()
      afterOutcome = { result: w.describe({ value }).value }
    } catch (e) {
      restore?.()
      afterOutcome = { error: w.describeError(e, errorExtra(w)) }
    }
  }
  w.stop()
  return JSON.stringify({
    after: afterOutcome,
    error: threw ? w.describeError(error, errorExtra(w)) : undefined,
    events: w.events,
    result: w.describe({ result }).result,
    state: w.describe(roots),
    threw,
  })
}

/** Fails when the TS reference does not have the outcome kind a case was written for. */
const expectedOutcomeMismatches = (cases: Case[]) =>
  cases.flatMap((c) => {
    if (!c.expect) {
      return []
    }
    const out = JSON.parse(runOne(c, ts))
    const sentinel = out.error?.sentinel
    const ok =
      out.threw === c.expect.threw && (!c.expect.sentinel || sentinel === c.expect.sentinel)
    return ok
      ? []
      : [`${c.name}: expected ${JSON.stringify(c.expect)}, TS ${JSON.stringify(out.error ?? 'ok')}`]
  })

type Outcome = {
  events: number
  mismatches: { a: string; b: string; name: string }[]
  ran: number
  threw: number
}

const compare = (cases: Case[], a: Impl, b: Impl): Outcome => {
  const outcome: Outcome = { events: 0, mismatches: [], ran: 0, threw: 0 }
  for (const c of cases) {
    const ra = runOne(c, a)
    const rb = runOne(c, b)
    outcome.ran++
    const parsed = JSON.parse(ra)
    outcome.events += parsed.events.length
    if (parsed.threw) {
      outcome.threw++
    }
    if (ra !== rb) {
      outcome.mismatches.push({ a: ra, b: rb, name: c.name })
    }
  }
  return outcome
}

const report = (label: string, o: Outcome) => {
  console.log(
    `[live-transform] ${label}: ${o.ran} cases, ${o.events} recorded operations, ${o.threw} throwing, ${o.mismatches.length} mismatches`,
  )
  for (const m of o.mismatches.slice(0, 3)) {
    console.log(
      `  MISMATCH ${m.name}\n    ts: ${m.a.slice(0, 3000)}\n    rs: ${m.b.slice(0, 3000)}`,
    )
  }
}

describe('payload-mongo-live-transform live differential', () => {
  beforeAll(() => {
    // `new Date()` stamps (`updatedAt`) must read the same clock in both runs
    vi.useFakeTimers({ now: new Date('2026-01-02T03:04:05.678Z'), toFake: ['Date'] })
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  it('should compare a real TS reference with the native port', () => {
    expect(rs.transform).not.toBe(ts.transform)
    expect(Function.prototype.toString.call(rs.transform)).toContain('[native code]')
    expect(Function.prototype.toString.call(ts.transform)).toContain('sanitizeRelationship')
    expect(Function.prototype.toString.call(ts.handleError)).toContain('valueMustBeUnique')
  })

  it('should match upstream transform on the fixed cases', () => {
    const cases = fixedCases()
    const o = compare(cases, ts, rs)
    report('transform fixed', o)
    expect(o.ran).toBeGreaterThan(300)
    expect(o.threw).toBeGreaterThan(10)
    expect(o.mismatches.map((m) => m.name)).toEqual([])
  })

  it('should match upstream transform on seeded random documents', () => {
    const cases = randomCases(Number(process.env.PAYLOAD_RS_LIVE_TRANSFORM_RANDOM || 3000))
    const o = compare(cases, ts, rs)
    report('transform random', o)
    expect(o.ran).toBeGreaterThan(500)
    expect(o.mismatches.map((m) => m.name)).toEqual([])
  })

  it('should match upstream handleError, getCollection, getGlobal, getDBName and isObjectID', () => {
    const cases = utilityCases()
    const o = compare(cases, ts, rs)
    report('utilities', o)
    expect(o.ran).toBeGreaterThan(200)
    expect(o.threw).toBeGreaterThan(100)
    expect(o.mismatches.map((m) => m.name)).toEqual([])
  })

  // .rs-baseline/review-mongo-live-transform-sol.md items 1-11 and review-mongo-live-writes-sol.md
  // item 9: config getters / proxies / overridden methods / iterators / monkeypatched built-ins /
  // retained and re-entered callbacks / invalid arguments (adversarial.ts, one named case each)
  it('should match upstream on adversarial config, built-in and callback cases', () => {
    const cases = adversarialCases()
    expect(expectedOutcomeMismatches(cases)).toEqual([])
    const o = compare(cases, ts, rs)
    report('adversarial', o)
    expect(o.ran).toBeGreaterThan(30)
    expect(o.threw).toBeGreaterThan(8)
    expect(o.mismatches.map((m) => m.name)).toEqual([])
  })

  it('should detect a deviating implementation (negative control)', () => {
    const extraRead: Impl = {
      ...ts,
      transform: (args) => {
        void (args.data as Record<string, unknown> | undefined)?.__probe
        return ts.transform(args)
      },
    }
    const lateWrite: Impl = {
      ...ts,
      transform: (args) => {
        const r = ts.transform(args)
        if (
          args.data &&
          typeof args.data === 'object' &&
          !Array.isArray(args.data) &&
          !Object.isFrozen(args.data)
        ) {
          const target = args.data as Record<string, unknown>
          const keys = Object.keys(target)
          if (keys.length) {
            target[keys[0]!] = target[keys[0]!]
          }
        }
        return r
      },
    }
    const cases = fixedCases().slice(0, 200)
    expect(compare(cases, ts, extraRead).mismatches.length).toBeGreaterThan(150)
    expect(compare(cases, ts, lateWrite).mismatches.length).toBeGreaterThan(50)
    expect(compare(cases, ts, ts).mismatches).toEqual([])
  })

  // The four findings of .rs-baseline/review-mongo-transform-sol.md, asserted directly on the port.
  describe('review findings', () => {
    const adapter = (config: unknown) => ({ payload: { config } })
    const config = {
      collections: [
        { slug: 'rels', fields: [] },
        { slug: 'custom', fields: [{ name: 'id', type: 'text' }] },
      ],
      localization: false,
    }

    it('should replace relationship arrays and leave caller-retained arrays untouched', () => {
      const old = [hex(1), hex(2)]
      const data: Record<string, unknown> = { relMany: old }
      rs.transform({
        adapter: adapter(config),
        data,
        fields: [{ name: 'relMany', type: 'relationship', hasMany: true, relationTo: 'rels' }],
        operation: 'write',
      })
      expect(data.relMany).not.toBe(old)
      expect(old).toEqual([hex(1), hex(2)])
      expect((data.relMany as unknown[])[0]).toBeInstanceOf(mongoose.Types.ObjectId)
    })

    it('should store the inherited value of a prototype-named relationship field like TS', () => {
      const data: Record<string, unknown> = {}
      rs.transform({
        adapter: adapter(config),
        data,
        fields: [{ name: 'toString', type: 'relationship', relationTo: 'rels' }],
        operation: 'write',
      })
      expect(Object.hasOwn(data, 'toString')).toBe(true)
      expect(data.toString).toBe(Object.prototype.toString)
    })

    it('should keep an own __proto__ key of polymorphic join docs (JSON round trip)', () => {
      const doc = JSON.parse('{"__proto__": {"x": 1}, "a": 1}')
      const data: Record<string, any> = { _id: 'id', join: { docs: [doc] } }
      rs.transform({
        adapter: { ...adapter(config), allowAdditionalKeys: true },
        data,
        fields: [{ name: 'join', type: 'join', collection: ['rels'], on: 'x' }],
        operation: 'read',
      })
      const out = data.join.docs[0]
      expect(out).not.toBe(doc)
      expect(Object.hasOwn(out, '__proto__')).toBe(true)
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
      expect(JSON.stringify(out)).toBe('{"__proto__":{"x":1},"a":1}')
    })

    it('should pass Buffer relationship ids through to mongoose', () => {
      const id = Buffer.from('0123456789ab')
      const data: Record<string, unknown> = { rel: id, relMany: [id] }
      rs.transform({
        adapter: adapter(config),
        data,
        fields: [
          { name: 'rel', type: 'relationship', relationTo: 'rels' },
          { name: 'relMany', type: 'relationship', hasMany: true, relationTo: 'rels' },
        ],
        operation: 'write',
      })
      expect(data.rel).toBe(id)
      expect((data.relMany as unknown[])[0]).toBe(id)
    })

    it('should run every weird-field case without an engine refusal', () => {
      for (const c of fixedCases().filter((each) => each.name.includes('weird'))) {
        const out = JSON.parse(runOne(c, rs))
        expect(JSON.stringify(out.error ?? {})).not.toMatch(/not supported by the engine/)
      }
      expect(weirdFields.length).toBeGreaterThan(5)
    })

    it('should rethrow the identical error object a getter throws', () => {
      const sentinel = new Error('getter')
      const data = {}
      Object.defineProperty(data, 'rel', {
        enumerable: true,
        get: () => {
          throw sentinel
        },
      })
      let thrown: unknown
      try {
        rs.transform({
          adapter: adapter(config),
          data,
          fields: [{ name: 'rel', type: 'relationship', relationTo: 'rels' }],
          operation: 'write',
        })
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBe(sentinel)
    })

    it('should throw the BSONError instance mongoose throws for invalid ids', () => {
      let thrown: unknown
      try {
        rs.transform({
          adapter: adapter(config),
          data: { rel: 'bad' },
          fields: [{ name: 'rel', type: 'relationship', relationTo: 'rels' }],
          operation: 'write',
        })
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(BSONError)
    })
  })

  it('should keep transformCase usable for single ad-hoc cases', () => {
    const c = transformCase('adhoc', {
      config: 'plain',
      data: () => ({ data: { rel: hex(3) } }),
      operation: 'write',
    })
    expect(runOne(c, ts)).toBe(runOne(c, rs))
  })
})
