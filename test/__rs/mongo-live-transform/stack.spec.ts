/**
 * Stack exhaustion of crates/payload-mongo-live-transform vs upstream, in a fresh worker.
 *
 * Runs in its own file on purpose: once V8 has optimized upstream's `stripFields` (e.g. after the
 * thousands of differential.spec.ts cases), upstream itself reports the overflow of the deep block
 * case as `TypeError: undefined is not a function` instead of a RangeError, so the TS outcome at
 * the limit depends on JIT state, not only on the input. Cold, both report the RangeError. The
 * depth at which each starts failing is NOT compared (native frames between JS calls make the
 * port's limit lower; see the mongotransform entries in .rs-baseline/mongo-coordination.md).
 *
 *   PAYLOAD_ENGINE_ADDON=<addon> pnpm vitest run --config test/__rs/mongo-live-transform/vitest.config.ts --project live-transform-unit stack
 */
import { describe, expect, it } from 'vitest'

import { transform as transformTS } from '../../../packages/db-mongodb/src/utilities/transform.js'
import { getLiveTransformBinding } from './native.js'

const ts = { transform: transformTS as (args: any) => unknown }
const rs = { transform: getLiveTransformBinding().transform }

describe('payload-mongo-live-transform stack exhaustion', () => {
  it('should throw V8 RangeError instead of crashing where the TS recursion overflows the stack', () => {
    const outcomes: string[] = []
    for (const impl of [ts, rs]) {
      const data: Record<string, unknown> = {}
      for (let i = 0; i < 20_000; i++) {
        data[`k${i}.x`] = i
      }
      try {
        impl.transform({
          adapter: { payload: { config: { collections: [] } } },
          data,
          fields: [],
          operation: 'write',
        })
        outcomes.push('ok')
      } catch (e) {
        outcomes.push(`${(e as Error).constructor.name}: ${(e as Error).message}`)
      }
    }
    expect(outcomes[0]).toBe('RangeError: Maximum call stack size exceeded')
    expect(outcomes[1]).toBe(outcomes[0])

    // stripFields recursion over a self-referencing block (data depth, no config limit)
    const blockFields: any[] = [{ name: 'blocks', type: 'blocks', blocks: ['self'] }]
    const self = { slug: 'self', fields: blockFields, flattenedFields: [] as unknown[] }
    self.flattenedFields = [{ ...blockFields[0], blocks: ['self'] }]
    const config = { blocks: [self], collections: [] }
    const deep = () => {
      const root: Record<string, unknown> = { _id: 'x' }
      let cursor = root
      for (let i = 0; i < 50_000; i++) {
        const row: Record<string, unknown> = { blockType: 'self' }
        cursor.blocks = [row]
        cursor = row
      }
      return root
    }
    const deepOutcomes: string[] = []
    for (const impl of [ts, rs]) {
      try {
        impl.transform({
          adapter: { payload: { config } },
          data: deep(),
          fields: blockFields,
          operation: 'read',
        })
        deepOutcomes.push('ok')
      } catch (e) {
        deepOutcomes.push(`${(e as Error).constructor.name}: ${(e as Error).message}`)
      }
    }
    expect(deepOutcomes[0]).toBe('RangeError: Maximum call stack size exceeded')
    expect(deepOutcomes[1]).toBe(deepOutcomes[0])
  })

  it('should report the depth at which each implementation starts failing', () => {
    /** `true` when the call succeeds, `false` on the stack RangeError. */
    const succeeds = (impl: typeof ts, args: () => Record<string, unknown>) => {
      try {
        impl.transform(args())
        return true
      } catch (e) {
        if (!(e instanceof RangeError)) {
          throw e
        }
        return false
      }
    }
    const limitOf = (impl: typeof ts, args: (n: number) => () => Record<string, unknown>) => {
      let ok = 1
      let failing = 1
      while (succeeds(impl, args(failing))) {
        ok = failing
        failing *= 2
      }
      while (failing - ok > 1) {
        const mid = Math.floor((ok + failing) / 2)
        if (succeeds(impl, args(mid))) {
          ok = mid
        } else {
          failing = mid
        }
      }
      return failing
    }
    // dotted keys: the traverseFields fallback recursion (one level per expanded key)
    const dotted = (n: number) => () => {
      const data: Record<string, unknown> = {}
      for (let i = 0; i < n; i++) {
        data[`k${i}.x`] = i
      }
      return {
        adapter: { payload: { config: { collections: [] } } },
        data,
        fields: [],
        operation: 'write',
      }
    }
    // nested block rows: stripFields + traverseFields recursion over data depth
    const blockFields: any[] = [{ name: 'blocks', type: 'blocks', blocks: ['self'] }]
    const self = { slug: 'self', fields: blockFields, flattenedFields: [] as unknown[] }
    self.flattenedFields = [{ ...blockFields[0], blocks: ['self'] }]
    const rows = (n: number, operation: string) => () => {
      const root: Record<string, unknown> = { _id: 'x' }
      let cursor = root
      for (let i = 0; i < n; i++) {
        const row: Record<string, unknown> = { blockType: 'self' }
        cursor.blocks = [row]
        cursor = row
      }
      return {
        adapter: { payload: { config: { blocks: [self], collections: [] } } },
        data: root,
        fields: blockFields,
        operation,
      }
    }
    const limits = {
      dotted: { rs: limitOf(rs, dotted), ts: limitOf(ts, dotted) },
      readRows: {
        rs: limitOf(rs, (n) => rows(n, 'read')),
        ts: limitOf(ts, (n) => rows(n, 'read')),
      },
      writeRows: {
        rs: limitOf(rs, (n) => rows(n, 'write')),
        ts: limitOf(ts, (n) => rows(n, 'write')),
      },
    }
    console.log(`[live-transform] first failing depth: ${JSON.stringify(limits)}`)
    for (const { rs: r, ts: t } of Object.values(limits)) {
      expect(t).toBeGreaterThan(50)
      expect(r).toBeGreaterThan(50)
    }
  })
})
