/**
 * Live differential of the transform the live engine runs (`deps::transform` = fast.js of
 * crates/payload-mongo-live-transform, exposed as `mongoLiveTransformBinding().fastTransform`)
 * against upstream packages/db-mongodb/src/utilities/transform.ts.
 *
 * Same cases and recording world as differential.spec.ts (data, operator objects and the adapter in
 * recording proxies; final state with object identity; results and thrown values), with one
 * difference: fast.js plans the sanitized config once (the engine treats it as immutable,
 * RUST_CORE_DESIGN.md section 3), so the operations on the config graph itself (`payload.config...`,
 * the fields arrays) are not part of the compared trace. Every operation on data, operators and the
 * adapter is, in order. Adversarial cases that replace built-ins must reach the exhaustive port
 * (and match there); cases that mutate the config while it is read are out of scope here
 * (differential.spec.ts covers them for the exhaustive port).
 *
 *   PAYLOAD_ENGINE_ADDON=<addon> pnpm vitest run --config test/__rs/mongo-live-transform/vitest.config.ts \
 *     --project live-transform-unit test/__rs/mongo-live-transform/fast.spec.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { Case } from './cases.js'

import { transform as transformTS } from '../../../packages/db-mongodb/src/utilities/transform.js'
import { fixedCases, randomCases, transformCase } from './cases.js'
import { getLiveTransformBinding } from './native.js'
import { createWorld } from './world.js'

type TransformFn = (args: any) => unknown

const binding = getLiveTransformBinding() as {
  fastTransform: TransformFn
  fastTransformStats: () => { fastDocs: number; slowCalls: number; slowDocs: number }
} & ReturnType<typeof getLiveTransformBinding>

/** How many documents the cases sent through fast.js itself vs the exhaustive port. */
const paths = (run: () => void) => {
  const before = binding.fastTransformStats()
  run()
  const after = binding.fastTransformStats()
  return {
    fastDocs: after.fastDocs - before.fastDocs,
    slowCalls: after.slowCalls - before.slowCalls,
    slowDocs: after.slowDocs - before.slowDocs,
  }
}

/** Events on the config graph (planned once by fast.js) are not compared. */
const isConfigEvent = (event: string) => {
  const label = event.split(' ')[1] ?? ''
  return label.startsWith('payload.config') || label.startsWith('fields')
}

const runOne = (c: Case, impl: TransformFn): string => {
  const w = createWorld()
  const { args, patch, roots } = c.build(w)
  let result: unknown
  let error: unknown
  let threw = false
  w.start()
  const restore = patch?.()
  try {
    result = impl(args)
  } catch (e) {
    threw = true
    error = e
  } finally {
    restore?.()
  }
  w.stop()
  return JSON.stringify({
    error: threw ? w.describeError(error, () => ({})) : undefined,
    events: w.events.filter((event) => !isConfigEvent(event)),
    result: w.describe({ result }).result,
    state: w.describe(roots),
    threw,
  })
}

const compare = (cases: Case[], a: TransformFn, b: TransformFn) => {
  const mismatches: { a: string; b: string; name: string }[] = []
  let events = 0
  for (const c of cases) {
    const ra = runOne(c, a)
    const rb = runOne(c, b)
    events += JSON.parse(ra).events.length
    if (ra !== rb) {
      mismatches.push({ a: ra, b: rb, name: c.name })
    }
  }
  for (const m of mismatches.slice(0, 3)) {
    console.log(
      `  MISMATCH ${m.name}\n    ts:   ${m.a.slice(0, 4000)}\n    fast: ${m.b.slice(0, 4000)}`,
    )
  }
  return { events, mismatches: mismatches.map((m) => m.name), ran: cases.length }
}

describe('live engine transform (fast.js) differential', () => {
  beforeAll(() => {
    vi.useFakeTimers({ now: new Date('2026-01-02T03:04:05.678Z'), toFake: ['Date'] })
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  it('should match upstream transform on the fixed cases', () => {
    let o!: ReturnType<typeof compare>
    const p = paths(() => {
      o = compare(fixedCases(), transformTS, binding.fastTransform)
    })
    console.log(
      `[fast-transform] fixed: ${o.ran} cases, ${o.events} operations, ${JSON.stringify(p)}`,
    )
    expect(p.fastDocs).toBeGreaterThan(300)
    expect(p.slowCalls).toBe(0)
    expect(o.ran).toBeGreaterThan(300)
    expect(o.events).toBeGreaterThan(1000)
    expect(o.mismatches).toEqual([])
  })

  it('should match upstream transform on seeded random documents', () => {
    let o!: ReturnType<typeof compare>
    const p = paths(() => {
      o = compare(
        randomCases(Number(process.env.PAYLOAD_RS_LIVE_TRANSFORM_RANDOM || 3000)),
        transformTS,
        binding.fastTransform,
      )
    })
    console.log(
      `[fast-transform] random: ${o.ran} cases, ${o.events} operations, ${JSON.stringify(p)}`,
    )
    expect(p.fastDocs).toBeGreaterThan(2000)
    expect(p.slowCalls).toBe(0)
    expect(o.ran).toBeGreaterThan(500)
    expect(o.mismatches).toEqual([])
  })

  it('should run the exhaustive port when a built-in it does not call is replaced', () => {
    const original = Array.prototype.some
    const calls: number[] = []
    const c = fixedCases()[0]!
    const patched = (impl: TransformFn) => (args: unknown) => {
      Array.prototype.some = function (this: unknown[], ...rest: any[]) {
        calls.push(1)
        return original.apply(this, rest as any)
      }
      try {
        return impl(args)
      } finally {
        Array.prototype.some = original
      }
    }
    const ts = runOne(c, patched(transformTS))
    const tsCalls = calls.length
    calls.length = 0
    let fast!: string
    const p = paths(() => {
      fast = runOne(c, patched(binding.fastTransform))
    })
    expect(p.slowCalls).toBe(1)
    expect(fast).toBe(ts)
    expect(calls.length).toBe(tsCalls)
    expect(tsCalls).toBeGreaterThan(0)
  })

  it('should hand configs it cannot plan to the exhaustive port, per document', () => {
    // an array / tabs / group without fields: upstream throws only once data reaches them
    const unplannable = [
      [{ name: 'arr', type: 'array' }],
      [{ type: 'tabs', tabs: [{ name: 't' }] }],
      [{ name: 'g', type: 'group', localized: true }],
    ]
    const datas = [
      {},
      { arr: [{ a: 1 }], t: { x: 1 }, g: { en: { x: 1 } } },
      { _id: 'x', arr: 'no' },
    ]
    const cases = unplannable.flatMap((fields, i) =>
      (['read', 'write'] as const).flatMap((operation) =>
        datas.map((data, j) =>
          transformCase(`unplannable ${i} ${operation} ${j}`, {
            config: 'localized',
            data: () => ({ data: structuredClone(data) }),
            fields: fields as any,
            operation,
          }),
        ),
      ),
    )
    let o!: ReturnType<typeof compare>
    const p = paths(() => {
      o = compare(cases, transformTS, binding.fastTransform)
    })
    expect(p.slowDocs).toBe(cases.length)
    expect(o.mismatches).toEqual([])
  })

  it('should detect a deviating implementation (negative control)', () => {
    const extraRead: TransformFn = (args) => {
      void (args.data as Record<string, unknown> | undefined)?.__probe
      return binding.fastTransform(args)
    }
    expect(
      compare(fixedCases().slice(0, 200), transformTS, extraRead).mismatches.length,
    ).toBeGreaterThan(150)
  })
})
