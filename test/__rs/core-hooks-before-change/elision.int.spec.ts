/**
 * The synthetic suite with sanitize's default validators left unwrapped, so the Rust port's
 * validation merge elision (packages/engine-rs/src/runtime/beforeChange/mergeElision.ts) applies,
 * plus documents whose merge would be observable: accessors (top level and nested), proxies, class
 * instances, symbol keys, `$$typeof` keys, deep nesting. Getter and trap invocations are recorded
 * callbacks, so a skipped or reordered merge read is a diff.
 */
import type { BeforeChangeInput, Variant } from './differential.js'

import { wrap } from './differential.js'
import { registerBeforeChangeSuite } from './suite.js'

const isCreate = (variant: Variant) => variant.operation === 'create'

const input = (variant: Variant, data: Record<string, unknown>, doc: Record<string, unknown>) => ({
  id: isCreate(variant) ? undefined : 'edge',
  data,
  doc: { ...(isCreate(variant) ? {} : { id: 'edge' }), ...doc },
  docWithLocales: isCreate(variant) ? {} : { id: 'edge' },
})

/** An enumerable accessor whose reads are recorded. */
const withGetter = (target: Record<string, unknown>, key: string, value: unknown, id: string) => {
  const read = wrap(() => undefined, 'getter', id)
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get() {
      read()
      return value
    },
  })
  return target
}

/** A proxy whose `get` / `ownKeys` / `getOwnPropertyDescriptor` / `has` traps are recorded. */
const recordingProxy = (target: Record<string, unknown>, id: string) => {
  const trap = wrap((_kind: string, _key: string) => undefined, 'trap', id)
  return new Proxy(target, {
    get: (t, key, receiver) => {
      trap('get', String(key))
      return Reflect.get(t, key, receiver)
    },
    getOwnPropertyDescriptor: (t, key) => {
      trap('getOwnPropertyDescriptor', String(key))
      return Reflect.getOwnPropertyDescriptor(t, key)
    },
    has: (t, key) => {
      trap('has', String(key))
      return Reflect.has(t, key)
    },
    ownKeys: (t) => {
      trap('ownKeys', '')
      return Reflect.ownKeys(t)
    },
  })
}

class Instance {
  kind = 'instance'
}

const deep = (levels: number): Record<string, unknown> =>
  levels === 0 ? { leaf: 'x' } : { next: deep(levels - 1) }

const leaf = (p: string) => ({ [`${p}A`]: 'a', [`${p}B`]: 1, [`${p}C`]: 'c' })

registerBeforeChangeSuite({
  configPath: './config.ts',
  extraInputs: {
    nested: (variant): BeforeChangeInput[][] => {
      const data = () => ({ g: { g2: leaf('g2'), arr: [leaf('arr')] }, loc: 'x', stash: 's' })
      return [
        // plain: elided
        [input(variant, data(), { g: { g2: leaf('g2') } })],
        // accessors on the original document, top level and inside a group
        [input(variant, data(), withGetter({}, 'trap', 'v', 'doc.trap'))],
        [input(variant, data(), { g: withGetter({ g2: leaf('g2') }, 'g2B', 2, 'doc.g.g2B') })],
        // an accessor inside an array element: never read by the merge
        [input(variant, data(), { rows: [withGetter({}, 'cell', 1, 'doc.rows.0.cell')] })],
        // proxies
        [input(variant, data(), { g: recordingProxy({ g2: leaf('g2') }, 'doc.g') })],
        [input(variant, data(), { list: recordingProxy([1, 2] as any, 'doc.list') })],
        // values the merge treats specially or that are not plain
        [input(variant, data(), { inst: new Instance(), when: new Date(0), re: /x/g })],
        [input(variant, data(), { [Symbol('s')]: 1, sym: 'x' } as Record<string, unknown>)],
        [input(variant, data(), { node: { $$typeof: 'react', props: {} } })],
        [input(variant, data(), { deep: deep(80) })],
        [input(variant, data(), { nullProto: Object.assign(Object.create(null), { a: 1 }) })],
      ]
    },
  },
  keepDefaultValidators: true,
  name: 'core-hooks-before-change: elision',
  only: ['nested', 'changes', 'settings'],
})
