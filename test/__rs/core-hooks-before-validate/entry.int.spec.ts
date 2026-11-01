/**
 * The beforeValidate `traverseFields` drop-in (packages/engine-rs/src/runtime/beforeValidate)
 * against upstream's `traverseFields` for argument shapes the engine does not model: paths that
 * are not strings (upstream's own function runs, e.g. a Symbol path throws V8's TypeError in
 * `getFieldPaths`) and throwing getters on the argument object (a rejection, not a throw).
 * Compares the settlement (value or error class/message), the getter reads and the data after.
 */
import { createPayloadRequest } from 'payload'
import { expect } from 'vitest'

import { traverseFields as traverseFieldsRS } from '../../../packages/engine-rs/src/runtime/beforeValidate/index.js'
import { traverseFields as traverseFieldsTS } from '../../../packages/payload/src/fields/hooks/beforeValidate/traverseFields.js'
import { test } from '../../__helpers/int/vitest.js'
import { assertDistinctEngines, startEngineRun } from '../dispatch/engineGuard.js'

assertDistinctEngines('beforeValidate traverseFields', traverseFieldsTS, traverseFieldsRS)

type Any = any

const pathCases: [string, unknown][] = [
  ['symbol', Symbol('p')],
  ['number', 5],
  ['undefined', undefined],
  ['null', null],
  ['object', { toString: () => 'obj' }],
  ['string', 'outer'],
]

test.suite('core-hooks beforeValidate: traverseFields entry', { config: './config.ts' }, () => {
  test('should match upstream for non-string paths and throwing getters', async ({ payload }) => {
    const collection = payload.collections[Object.keys(payload.collections)[0]!]!.config
    const req = await createPayloadRequest({ payload } as Any)
    let compared = 0
    // `reachesRust`: only string paths reach the port (the other cases run upstream's function
    // or reject while destructuring); the guard then requires a Rust call.
    const run = async (
      engine: 'rs' | 'ts',
      build: (reads: string[]) => Any,
      reachesRust = false,
    ) => {
      const fn = engine === 'ts' ? traverseFieldsTS : traverseFieldsRS
      const guard = startEngineRun(engine, 'beforeValidate traverseFields entry')
      const reads: string[] = []
      const args = build(reads)
      let outcome: unknown
      let returned: unknown
      try {
        returned = fn(args)
        outcome = { ok: await returned }
      } catch (error) {
        outcome = {
          error: (error as Error)?.constructor?.name,
          message: (error as Error)?.message,
          sync: returned === undefined,
        }
      }
      guard.finish(reachesRust ? 1 : 0)
      return JSON.stringify({ data: args.siblingData ?? null, outcome, reads })
    }
    const base = (reads: string[], key: string, value: unknown) => {
      const data = { title: 'x' }
      const args: Record<string, unknown> = {
        collection,
        context: req.context,
        data,
        doc: {},
        fields: collection.fields,
        global: null,
        operation: 'update',
        overrideAccess: true,
        parentIndexPath: '',
        parentIsLocalized: false,
        parentPath: '',
        parentSchemaPath: '',
        req,
        siblingData: data,
        siblingDoc: {},
      }
      args[key] = value
      return new Proxy(args, {
        get: (target, k, receiver) => {
          reads.push(String(k))
          return Reflect.get(target, k, receiver)
        },
      })
    }
    for (const key of ['parentPath', 'parentIndexPath', 'parentSchemaPath']) {
      for (const [label, value] of pathCases) {
        const ts = await run('ts', (reads) => base(reads, key, value))
        const rs = await run('rs', (reads) => base(reads, key, value), label === 'string')
        expect(rs, `${key} ${label}`).toBe(ts)
        compared++
      }
    }
    // a throwing getter in the destructured parameter: a rejected promise from both
    const throwing = (reads: string[]) =>
      Object.defineProperty(base(reads, 'parentPath', ''), 'operation', {
        get: () => {
          throw new Error('getter threw')
        },
      })
    expect(await run('rs', throwing)).toBe(await run('ts', throwing))
    compared++
    expect(compared).toBeGreaterThan(0)
  })
})
