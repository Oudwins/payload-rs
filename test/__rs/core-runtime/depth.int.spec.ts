/**
 * Nesting depth of the afterRead traversal: the deepest nested-group document (with a field hook
 * at the innermost level, so user JS runs at the full native depth) that upstream TS accepts
 * versus the Rust core runtime. Both run in the same process on the same stack; a depth TS
 * accepts must be accepted by Rust (every rejection must be V8's RangeError).
 *
 *   PAYLOAD_CORE_RUNTIME_ADDON=<addon> pnpm test:int test/__rs/core-runtime/depth.int.spec.ts
 */
import type { Field, SanitizedCollectionConfig } from 'payload'

import { createPayloadRequest } from 'payload'
import { expect } from 'vitest'

import { upstreamAfterRead as afterReadTS } from '../../../packages/payload/src/fields/hooks/afterRead/index.js'
import { afterRead as afterReadRS } from '../../../packages/engine-rs/src/runtime/index.js'
import { test } from '../../__helpers/int/vitest.js'

const nestedFields = (depth: number): Field[] => {
  let fields: Field[] = [
    { name: 't', type: 'text', hooks: { afterRead: [({ value }) => `${value}!`] } },
  ]
  for (let i = 0; i < depth; i++) {
    fields = [{ name: 'g', type: 'group', fields }]
  }
  return fields
}

const nestedDoc = (depth: number) => {
  let doc: Record<string, unknown> = { t: 'leaf' }
  for (let i = 0; i < depth; i++) {
    doc = { g: doc }
  }
  return { id: 'deep', ...doc }
}

test.suite('core-runtime afterRead nesting depth', { config: './config.ts' }, () => {
  test('should accept every nesting depth upstream TS accepts', async ({ payload }) => {
    const base = Object.values(payload.collections)[0]!.config
    const req = await createPayloadRequest({ payload, user: null } as any)
    const attempt = async (engine: 'rs' | 'ts', depth: number): Promise<'ok' | 'range'> => {
      const collection = { ...base, fields: nestedFields(depth) } as SanitizedCollectionConfig
      const afterRead = engine === 'ts' ? afterReadTS : afterReadRS
      try {
        const doc: any = await afterRead({
          collection,
          context: req.context,
          depth: 0,
          doc: nestedDoc(depth),
          draft: false,
          fallbackLocale: null as any,
          global: null,
          locale: null as any,
          overrideAccess: true,
          req,
          showHiddenFields: false,
        })
        let leaf = doc
        for (let i = 0; i < depth; i++) {
          leaf = leaf.g
        }
        expect(leaf.t).toBe('leaf!')
        return 'ok'
      } catch (error) {
        expect(error).toBeInstanceOf(RangeError)
        return 'range'
      }
    }
    const maxDepth = async (engine: 'rs' | 'ts') => {
      let lo = 0
      let hi = 16
      while ((await attempt(engine, hi)) === 'ok') {
        lo = hi
        hi *= 2
        if (hi > 1 << 16) {
          return Infinity
        }
      }
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if ((await attempt(engine, mid)) === 'ok') {
          lo = mid
        } else {
          hi = mid
        }
      }
      return lo
    }
    const ts = await maxDepth('ts')
    const rs = await maxDepth('rs')
    console.log(`afterRead nested groups: ts accepts ${ts}, rs accepts ${rs}`)
    expect(ts).toBeGreaterThan(16)
    expect(rs).toBeGreaterThanOrEqual(ts)
    // the emulated overflow keeps the limit comparable (V8's RangeError, not unbounded nesting)
    expect(rs).toBeLessThan(ts * 4)
  })
})
