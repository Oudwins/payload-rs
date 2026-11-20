/**
 * afterRead on live values that observe how built-ins are used: an array field whose rows are a
 * Proxy of an array (every trap recorded), and the global `Array.isArray` / `Array.prototype.push`
 * / `Object.values` replaced by counting wrappers for the duration of the run. Upstream TS and the
 * Rust core runtime must make the same trap calls, the same built-in calls (count and order) and
 * produce the same document.
 *
 *   PAYLOAD_ENGINE_ADDON=<addon> pnpm test:int:sqlite test/__rs/core-runtime/builtins.int.spec.ts
 */
import type { Field, SanitizedCollectionConfig } from 'payload'

import { createPayloadRequest } from 'payload'
import { expect } from 'vitest'

import { upstreamAfterRead as afterReadTS } from '../../../packages/payload/src/fields/hooks/afterRead/index.js'
import {
  afterRead as afterReadRS,
  getCoreRuntime,
} from '../../../packages/engine-rs/src/runtime/index.js'
import { test } from '../../__helpers/int/vitest.js'

const fields: Field[] = [
  {
    name: 'rows',
    type: 'array',
    fields: [{ name: 't', type: 'text', hooks: { afterRead: [({ value }) => `${value}!`] } }],
  },
  {
    name: 'blocks',
    type: 'blocks',
    blocks: [{ slug: 'b', fields: [{ name: 'x', type: 'text' }] }],
  },
  { name: 'point', type: 'point' },
]

const makeDoc = (log: string[]) => {
  const rows = [{ t: 'a' }, { t: 'b' }]
  const proxyRows = new Proxy(rows, {
    get(target, key, receiver) {
      log.push(`get ${String(key)}`)
      return Reflect.get(target, key, receiver)
    },
    has(target, key) {
      log.push(`has ${String(key)}`)
      return Reflect.has(target, key)
    },
  })
  return {
    id: 'doc',
    blocks: new Proxy([{ blockType: 'b', x: 'y' }], {
      get(target, key, receiver) {
        log.push(`blocks get ${String(key)}`)
        return Reflect.get(target, key, receiver)
      },
    }),
    point: { coordinates: new Proxy([1, 2], {}) },
    rows: proxyRows,
  }
}

test.suite('core-runtime afterRead built-ins', { config: './config.ts' }, () => {
  test('should use live built-ins and proxies of arrays like upstream', async ({ payload }) => {
    const base = Object.values(payload.collections)[0]!.config
    const collection = { ...base, fields } as SanitizedCollectionConfig
    const run = async (engine: 'rs' | 'ts') => {
      const req = await createPayloadRequest({ payload, user: null } as any)
      const log: string[] = []
      const doc = makeDoc(log)
      const afterRead = engine === 'ts' ? afterReadTS : afterReadRS
      const saved = {
        isArray: Array.isArray,
        push: Array.prototype.push,
        values: Object.values,
      }
      let counting = false
      Array.isArray = function (v: unknown) {
        if (counting) {
          log.push('Array.isArray')
        }
        return saved.isArray(v)
      } as typeof Array.isArray
      // eslint-disable-next-line no-extend-native
      Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
        if (counting && (items[0] as any) instanceof Promise) {
          counting = false
          log.push('push(promise)')
          counting = true
        }
        return Reflect.apply(saved.push, this, items)
      }
      Object.values = function (o: any) {
        if (counting) {
          log.push('Object.values')
        }
        return saved.values(o)
      } as typeof Object.values
      let result: any
      try {
        counting = true
        const promise = afterRead({
          collection,
          context: req.context,
          depth: 0,
          doc,
          draft: false,
          fallbackLocale: null as any,
          global: null,
          locale: null as any,
          overrideAccess: true,
          req,
          showHiddenFields: false,
        })
        result = await promise
      } finally {
        counting = false
        Array.isArray = saved.isArray
        // eslint-disable-next-line no-extend-native
        Array.prototype.push = saved.push
        Object.values = saved.values
      }
      return {
        log,
        result: { blocks: [...result.blocks], point: result.point, rows: [...result.rows] },
      }
    }
    const before = getCoreRuntime().stats().entries
    const rs = await run('rs')
    const after = getCoreRuntime().stats().entries
    const ts = await run('ts')
    expect(after).toBeGreaterThan(before)
    expect(ts.result.rows).toEqual([{ t: 'a!' }, { t: 'b!' }])
    expect(ts.log.length).toBeGreaterThan(5)
    expect(rs.result).toEqual(ts.result)
    expect(rs.log).toEqual(ts.log)
  })
})
