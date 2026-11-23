/**
 * Guard mode verifies compiled functions at their call sites (Rust core `js::call` and Payload's
 * `callUserFunction`) without touching the config: every call Payload makes to a compiled access
 * function, field access, field hook and validator must reach the guard, and all must match.
 */
import { expect } from 'vitest'

import { test } from '../../../__helpers/int/vitest.js'
import { guardStats } from '../../../../packages/engine-rs/src/compile/index.js'
import { fieldAccessRead, titleValidate, trimHook } from './config.js'

test.suite('fn-compile call sites', { config: './config.ts' }, () => {
  test('should verify every compiled function call without replacing config functions', async ({
    payload,
  }) => {
    const collection = payload.collections.guarded!.config
    expect(collection.fields.find((f: any) => f.name === 'title')!.hooks!.beforeChange![0]).toBe(
      trimHook,
    )

    await payload
      .create({ collection: 'guarded', data: { title: '  public  ' }, overrideAccess: true })
      .catch((e) => {
        throw new Error('create: ' + e.message)
      })
    await payload.find({ collection: 'guarded', overrideAccess: false }).catch((e) => {
      throw new Error('find anon: ' + e.message)
    })
    await payload.find({
      collection: 'guarded',
      overrideAccess: false,
      user: { id: 'u1', collection: 'users', email: 'a@b.c' } as never,
    })

    // `access.read` itself is called by Payload's `withBaseAccess` wrapper (checked below).
    const fns = { fieldAccessRead, titleValidate, trimHook }
    for (const [name, fn] of Object.entries(fns)) {
      const stats = guardStats(fn)
      expect(stats, name).toBeDefined()
      expect(stats!.compiled, name).toBe(true)
      expect(stats!.calls, name).toBeGreaterThan(0)
      expect(stats!.verified, name).toBeGreaterThan(0)
      expect(stats!.mismatches, name).toBe(0)
    }
    // The Rust core's read access (`withBaseAccess` wrapper around `access.read`).
    expect(guardStats(collection.access.read)!.verified).toBeGreaterThan(0)
  })
})
