/**
 * Adversarial cases for the live differential (differential.spec.ts): one named case per finding
 * of .rs-baseline/review-mongo-live-transform-sol.md (config read caching / eager reads, real
 * `some` / `find` / `map` / iterators, retained and re-entered callbacks, monkeypatched built-ins,
 * error kinds) and review-mongo-live-writes-sol.md item 9 (handleError's string methods). Config,
 * fields, collections and localization are traced (world.wrap); getters / overridden methods /
 * patches record into per-run `log` roots, so counts and order of their calls are compared too.
 * Every case states the outcome the TS reference must have (`expect`), so none passes vacuously.
 */
import type { Built, Case, FnName } from './cases.js'
import type { World } from './world.js'

import { hex } from './cases.js'

const ok = { threw: false }
const throws = (sentinel?: string) => ({ sentinel, threw: true })

const adv = (
  name: string,
  expect: Case['expect'],
  build: (w: World) => Built,
  fn: FnName = 'transform',
): Case => ({ build, expect, fn, name })

const transformArgs = (
  w: World,
  o: {
    config: Record<string, unknown>
    data: unknown
    fields: unknown[]
    flags?: Record<string, unknown>
    operation: unknown
    operators?: Record<string, unknown>
  },
) => {
  const config = w.wrap(o.config, 'config')
  const adapter = w.wrap({ payload: { config }, ...o.flags }, 'adapter')
  const data = w.wrap(o.data, 'data')
  const fields = w.wrap(o.fields, 'fields')
  const operators = w.wrap(o.operators ?? {}, 'ops') as Record<string, unknown>
  const args = w.shallowWrap(
    { ...operators, adapter, data, fields, operation: o.operation },
    'args',
  )
  return { args, roots: { config, data, ...operators } }
}

const localization = (codes: unknown = ['en', 'es']) => ({
  defaultLocale: 'en',
  localeCodes: codes,
  locales: [{ code: 'en' }, { code: 'es' }],
})

const accessor = (target: object, key: string, get: () => unknown, set?: (v: unknown) => void) =>
  Object.defineProperty(target, key, { configurable: true, enumerable: true, get, set })

/** Replaces `owner[key]` with a spy (or override) while the call runs; returns the restore. */
const patchOf =
  <T extends object>(owner: T, key: keyof T, make: (original: any) => unknown) =>
  () => {
    const original = owner[key]
    ;(owner as any)[key] = make(original)
    return () => {
      ;(owner as any)[key] = original
    }
  }

export const adversarialCases = (): Case[] => [
  // ---------------------------------------------------------------------------------------------
  // item 1: config.localization read where upstream reads it (not eagerly, not cached)
  adv('1 localization getter throws but read with fields [] never reads it', ok, (w) => {
    const config: Record<string, unknown> = { collections: [] }
    const s = w.sentinel('localization')
    accessor(config, 'localization', () => {
      throw s
    })
    return transformArgs(w, {
      config,
      data: { __v: 1, _id: 'x' },
      fields: [],
      flags: { allowAdditionalKeys: true },
      operation: 'read',
    })
  }),
  adv('1 data._id getter disables localization before the localized date is read', ok, (w) => {
    const config: Record<string, unknown> = { collections: [], localization: localization() }
    const data: Record<string, unknown> = { dateL: { en: new Date(1), es: new Date(2) } }
    let id: unknown = 'x'
    accessor(
      data,
      '_id',
      () => {
        config.localization = false
        return id
      },
      (v) => {
        id = v
      },
    )
    return transformArgs(w, {
      config,
      data,
      fields: [{ name: 'dateL', type: 'date', localized: true }],
      flags: { allowAdditionalKeys: true },
      operation: 'read',
    })
  }),

  // ---------------------------------------------------------------------------------------------
  // item 2: collections `.find` short-circuits and sees live slugs / a replaced collections array
  adv('2 collections.find stops before an unrelated throwing slug', ok, (w) => {
    const throwing = {}
    const s = w.sentinel('slug')
    accessor(throwing, 'slug', () => {
      throw s
    })
    return transformArgs(w, {
      config: { collections: [{ slug: 'rels', fields: [] }, throwing], localization: false },
      data: { rel: hex(1) },
      fields: [{ name: 'rel', type: 'relationship', relationTo: 'rels' }],
      operation: 'write',
    })
  }),
  adv('2 relationTo getter renames a later collection during find', ok, (w) => {
    const collections = [
      { slug: 'x', fields: [] },
      { slug: 'y', fields: [] },
    ]
    const field: Record<string, unknown> = { name: 'rel', type: 'relationship' }
    accessor(field, 'relationTo', () => {
      collections[1]!.slug = 'rels'
      return 'rels'
    })
    return transformArgs(w, {
      config: { collections, localization: false },
      data: { rel: hex(2) },
      fields: [field],
      operation: 'write',
    })
  }),
  adv('2 a value getter replaces config.collections between relationship fields', ok, (w) => {
    const config: Record<string, unknown> = {
      collections: [{ slug: 'rels', fields: [] }],
      localization: false,
    }
    const data: Record<string, unknown> = { rel: hex(3) }
    let rel2: unknown = hex(4)
    accessor(
      data,
      'rel2',
      () => {
        config.collections = [{ slug: 'other', fields: [] }]
        return rel2
      },
      (v) => {
        rel2 = v
      },
    )
    return transformArgs(w, {
      config,
      data,
      fields: [
        { name: 'rel', type: 'relationship', relationTo: 'rels' },
        { name: 'rel2', type: 'relationship', relationTo: 'rels' },
      ],
      operation: 'write',
    })
  }),

  // ---------------------------------------------------------------------------------------------
  // item 3: field.type / field.name / field.localized read at every upstream evaluation point
  adv('3 number field with a throwing name getter is never asked for its name', ok, (w) => {
    const field: Record<string, unknown> = { type: 'number' }
    const s = w.sentinel('name')
    accessor(field, 'name', () => {
      throw s
    })
    return transformArgs(w, {
      config: { collections: [], localization: false },
      data: {},
      fields: [field],
      operation: 'write',
    })
  }),
  adv('3 $inc with a stateful name getter (separate in / value / path / delete reads)', ok, (w) => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    let i = 0
    const field: Record<string, unknown> = { type: 'number' }
    accessor(field, 'name', () => names[i++ % names.length])
    return transformArgs(w, {
      config: { collections: [], localization: false },
      data: { a: 1, b: 1, c: { $inc: 5 }, d: 0, e: 0, f: 0 },
      fields: [field],
      operation: 'write',
      operators: { $inc: {} },
    })
  }),
  adv('3 relationship value getter turns the field into a group before traversal', ok, (w) => {
    const field: Record<string, unknown> = { name: 'g', type: 'relationship', relationTo: 'rels' }
    let store: unknown = { d: new Date(0) }
    const data: Record<string, unknown> = { _id: 'x' }
    accessor(
      data,
      'g',
      () => {
        field.type = 'group'
        field.fields = [{ name: 'd', type: 'date' }]
        return store
      },
      (v) => {
        store = v
      },
    )
    return {
      ...transformArgs(w, {
        config: { collections: [{ slug: 'rels', fields: [] }], localization: false },
        data,
        fields: [field],
        flags: { allowAdditionalKeys: true },
        operation: 'read',
      }),
      after: () => store,
    }
  }),
  adv('3 stripFields reads field names per key with short-circuit some()', throws('name'), (w) => {
    const throwing: Record<string, unknown> = { type: 'text' }
    const s = w.sentinel('name')
    accessor(throwing, 'name', () => {
      throw s
    })
    return transformArgs(w, {
      config: { collections: [], localization: false },
      data: { _id: 'x', a: 1 },
      fields: [{ name: 'a', type: 'text' }, throwing],
      operation: 'read',
    })
  }),
  adv('3 stripFields reads field.localized / flattenedFields at the TS points', ok, (w) => {
    const log: string[] = []
    // flattenAllFields keeps a non-container field object as is, accessors included
    const field: Record<string, unknown> = { name: 'grp', type: 'text' }
    accessor(field, 'flattenedFields', () => {
      log.push('flattenedFields')
      return [{ name: 'x', type: 'text' }]
    })
    accessor(field, 'localized', () => {
      log.push('localized')
      return false
    })
    const built = transformArgs(w, {
      config: { collections: [], localization: false },
      data: { _id: 'x', grp: { x: 1, y: 2 } },
      fields: [field],
      operation: 'read',
    })
    return { ...built, roots: { ...built.roots, log } }
  }),

  // ---------------------------------------------------------------------------------------------
  // item 4: the custom-ID lookup runs per relationship value
  adv('4 second relationship item adds a custom id field to the related collection', ok, (w) => {
    const relatedFields: unknown[] = []
    const relMany: unknown[] = [hex(5)]
    accessor(relMany, '1', () => {
      relatedFields.push({ name: 'id', type: 'text' })
      return hex(6)
    })
    return transformArgs(w, {
      config: { collections: [{ slug: 'rels', fields: relatedFields }], localization: false },
      data: { relMany },
      fields: [{ name: 'relMany', type: 'relationship', hasMany: true, relationTo: 'rels' }],
      operation: 'write',
    })
  }),

  // ---------------------------------------------------------------------------------------------
  // item 5: own `some` / `find` methods of config arrays are called
  adv('5 fields with an own throwing some()', throws('some'), (w) => {
    const fields: unknown[] = []
    const s = w.sentinel('some')
    Object.defineProperty(fields, 'some', {
      value: () => {
        throw s
      },
    })
    return transformArgs(w, {
      config: { collections: [], localization: false },
      data: {},
      fields,
      operation: 'write',
    })
  }),
  adv('5 fields.some() returning true keeps own dotted keys', ok, (w) => {
    const fields: unknown[] = [
      { name: 'a', type: 'group', fields: [{ name: 'b', type: 'number' }] },
    ]
    Object.defineProperty(fields, 'some', { value: () => true })
    return transformArgs(w, {
      config: { collections: [], localization: false },
      data: { 'a.b': 1 },
      fields,
      operation: 'other',
    })
  }),
  adv('5 collections.find override returns a collection without calling the predicate', ok, (w) => {
    const collections: unknown[] = []
    const chosen = { slug: 'zzz', fields: [] }
    Object.defineProperty(collections, 'find', { value: () => chosen })
    return transformArgs(w, {
      config: { collections, localization: false },
      data: { rel: hex(7) },
      fields: [{ name: 'rel', type: 'relationship', relationTo: 'rels' }],
      operation: 'write',
    })
  }),
  adv('5 config.blocks.find override in stripFields', ok, (w) => {
    const blocks: unknown[] = [
      { slug: 'b', fields: [], flattenedFields: [{ name: 'keep', type: 'text' }] },
    ]
    const other = { slug: 'z', fields: [], flattenedFields: [{ name: 'drop', type: 'text' }] }
    Object.defineProperty(blocks, 'find', { value: () => other })
    return transformArgs(w, {
      config: { blocks, collections: [], localization: false },
      data: { _id: 'x', bl: [{ blockType: 'b', keep: 1, drop: 2 }] },
      fields: [{ name: 'bl', type: 'blocks', blocks: ['b'] }],
      operation: 'read',
    })
  }),
  adv(
    '5 getGlobal with an own globals.find returning a global directly',
    ok,
    (w) => {
      const globals: unknown[] = []
      Object.defineProperty(globals, 'find', { value: () => ({ slug: 'direct' }) })
      const adapter = w.wrap(
        { globals: { modelName: 'globals' }, payload: { config: { globals } }, versions: {} },
        'adapter',
      )
      return { args: w.shallowWrap({ adapter, globalSlug: 'other' }, 'args'), roots: { adapter } }
    },
    'getGlobal',
  ),
  adv(
    '5 getGlobal with an own throwing globals.find',
    throws('find'),
    (w) => {
      const globals: unknown[] = [{ slug: 'g' }]
      const s = w.sentinel('find')
      Object.defineProperty(globals, 'find', {
        value: () => {
          throw s
        },
      })
      const adapter = w.wrap({ payload: { config: { globals } } }, 'adapter')
      return { args: w.shallowWrap({ adapter, globalSlug: 'g' }, 'args'), roots: { adapter } }
    },
    'getGlobal',
  ),

  // ---------------------------------------------------------------------------------------------
  // item 6: live iterators
  adv('6 localeCodes grows while the localized date loop runs', ok, (w) => {
    const codes = ['en']
    const en = new Date(1)
    Object.defineProperty(en, 'toISOString', {
      value() {
        if (!codes.includes('fr')) {
          codes.push('fr')
        }
        return Date.prototype.toISOString.call(this)
      },
    })
    return transformArgs(w, {
      config: { collections: [], localization: { localeCodes: codes, locales: [{ code: 'en' }] } },
      data: { _id: 'x', dateL: { en, fr: new Date(5) } },
      fields: [{ name: 'dateL', type: 'date', localized: true }],
      flags: { allowAdditionalKeys: true },
      operation: 'read',
    })
  }),
  adv('6 localeCodes with an own Symbol.iterator', ok, (w) => {
    const codes = ['en', 'es']
    Object.defineProperty(codes, Symbol.iterator, {
      value: function* () {
        yield 'es'
      },
    })
    return transformArgs(w, {
      config: { collections: [], localization: { localeCodes: codes, locales: [{ code: 'en' }] } },
      data: { _id: 'x', dateL: { en: new Date(1), es: new Date(2) } },
      fields: [{ name: 'dateL', type: 'date', localized: true }],
      flags: { allowAdditionalKeys: true },
      operation: 'read',
    })
  }),
  adv(
    '6 iterable localeCodes: next() interleaved with the body, return() on a throw',
    throws('iso'),
    (w) => {
      const log: string[] = []
      const s = w.sentinel('iso')
      const codes = {
        [Symbol.iterator]() {
          let i = 0
          return {
            next() {
              log.push(`next ${i}`)
              return i < 2
                ? { done: false, value: ['es', 'en'][i++] }
                : { done: true, value: undefined }
            },
            return() {
              log.push('return')
              return { done: true, value: undefined }
            },
          }
        },
      }
      const en = new Date(1)
      let isFirst = true
      Object.defineProperty(en, 'toISOString', {
        value() {
          // throws once (the harness describes Dates through toISOString afterwards)
          if (isFirst) {
            isFirst = false
            log.push('toISOString')
            throw s
          }
          return Date.prototype.toISOString.call(this)
        },
      })
      const built = transformArgs(w, {
        config: {
          collections: [],
          localization: { localeCodes: codes, locales: [{ code: 'en' }] },
        },
        data: { _id: 'x', dateL: { en, es: new Date(2) } },
        fields: [{ name: 'dateL', type: 'date', localized: true }],
        flags: { allowAdditionalKeys: true },
        operation: 'read',
      })
      return { ...built, roots: { ...built.roots, log } }
    },
  ),
  adv('6 tabs iterable with an own Symbol.iterator', ok, (w) => {
    const tabs = [
      { name: 'one', fields: [{ name: 'd', type: 'date' }] },
      { name: 'two', fields: [{ name: 'd', type: 'date' }] },
    ]
    Object.defineProperty(tabs, Symbol.iterator, {
      value: function* () {
        yield tabs[1]
      },
    })
    return transformArgs(w, {
      config: { collections: [], localization: false },
      data: { _id: 'x', one: { d: new Date(1) }, two: { d: new Date(2) } },
      fields: [{ type: 'tabs', tabs }],
      flags: { allowAdditionalKeys: true },
      operation: 'read',
    })
  }),

  // ---------------------------------------------------------------------------------------------
  // item 7: callbacks user code keeps, re-enters and reflects on
  adv('7 a map callback kept by user code still converts after transform returns', ok, (w) => {
    const log: unknown[] = []
    const saved: { cb?: (v: unknown) => unknown } = {}
    const relMany: unknown[] = [hex(8)]
    Object.defineProperty(relMany, 'map', {
      value(cb: (v: unknown) => unknown) {
        saved.cb = cb
        log.push(['map', cb.length, cb.name, typeof cb])
        return Array.prototype.map.call(this, cb)
      },
    })
    const built = transformArgs(w, {
      config: { collections: [{ slug: 'rels', fields: [] }], localization: false },
      data: { relMany },
      fields: [{ name: 'relMany', type: 'relationship', hasMany: true, relationTo: 'rels' }],
      operation: 'write',
    })
    return { ...built, after: () => saved.cb!(hex(9)), roots: { ...built.roots, log } }
  }),
  adv('7 a kept processRelationshipValues callback ($addToSet) called later', ok, (w) => {
    const saved: { cb?: (v: unknown) => unknown } = {}
    const push: unknown[] = [hex(10)]
    Object.defineProperty(push, 'map', {
      value(cb: (v: unknown) => unknown) {
        saved.cb = cb
        return Array.prototype.map.call(this, cb)
      },
    })
    const built = transformArgs(w, {
      config: { collections: [{ slug: 'rels', fields: [] }], localization: false },
      data: { relMany: { $push: push } },
      fields: [{ name: 'relMany', type: 'relationship', hasMany: true, relationTo: 'rels' }],
      operation: 'write',
      operators: { $addToSet: {} },
    })
    return { ...built, after: () => saved.cb!(hex(11)) }
  }),
  adv('7 a kept traverseFields some() callback called later on a new ref', ok, (w) => {
    const saved: { cb?: (field: unknown) => unknown } = {}
    const fields: unknown[] = [{ name: 'd', type: 'date' }]
    Object.defineProperty(fields, 'some', {
      value(cb: (field: unknown) => unknown) {
        saved.cb = cb
        return Array.prototype.some.call(this, cb)
      },
    })
    const built = transformArgs(w, {
      config: { collections: [], localization: false },
      data: { _id: 'x', d: new Date(3) },
      fields,
      flags: { allowAdditionalKeys: true },
      operation: 'read',
    })
    return {
      ...built,
      after: () => [saved.cb!({ name: 'd', type: 'date' }), (built.roots.data as any).d],
    }
  }),
  adv('7 the map callback re-entered from a related-collection fields getter', ok, (w) => {
    const log: unknown[] = []
    const saved: { cb?: (v: unknown) => unknown } = {}
    let busy = false
    const rels: Record<string, unknown> = { slug: 'rels' }
    accessor(rels, 'fields', () => {
      if (saved.cb && !busy) {
        busy = true
        log.push(String(saved.cb(hex(12))))
        busy = false
      }
      return []
    })
    const relMany: unknown[] = [hex(13), hex(14)]
    Object.defineProperty(relMany, 'map', {
      value(cb: (v: unknown) => unknown) {
        saved.cb = cb
        return Array.prototype.map.call(this, cb)
      },
    })
    const built = transformArgs(w, {
      config: { collections: [rels], localization: false },
      data: { relMany },
      fields: [{ name: 'relMany', type: 'relationship', hasMany: true, relationTo: 'rels' }],
      operation: 'write',
    })
    return { ...built, roots: { ...built.roots, log } }
  }),
  adv('7 a kept localized forEach callback ($pull) called later', ok, (w) => {
    const saved: { cb?: (entry: unknown) => unknown } = {}
    const built = transformArgs(w, {
      config: { collections: [{ slug: 'rels', fields: [] }], localization: localization() },
      data: { relL: { en: { $remove: [hex(15)] } } },
      fields: [
        { name: 'relL', type: 'relationship', hasMany: true, localized: true, relationTo: 'rels' },
      ],
      operation: 'write',
      operators: { $pull: {} },
    })
    return {
      ...built,
      after: () => [saved.cb!(['es', { $remove: hex(16) }]), (built.roots as any).$pull],
      patch: patchOf(
        Array.prototype,
        'forEach',
        (original) =>
          function (this: unknown[], cb: (entry: unknown) => unknown) {
            saved.cb ??= cb
            return original.call(this, cb)
          },
      ),
    }
  }),

  // ---------------------------------------------------------------------------------------------
  // items 8 / 9: string methods and global built-ins are the live ones
  adv('8 String.prototype.includes says a dotted key has no dot', ok, (w) => ({
    ...transformArgs(w, {
      config: { collections: [], localization: false },
      data: { 'a.b': 1, 'c.d': 2 },
      fields: [{ name: 'c', type: 'group', fields: [{ name: 'd', type: 'number' }] }],
      operation: 'write',
    }),
    patch: patchOf(
      String.prototype,
      'includes',
      (original) =>
        function (this: string, ...args: unknown[]) {
          if (String(this) === 'a.b') {
            return false
          }
          return original.apply(this, args)
        },
    ),
  })),
  adv('8 String.prototype.indexOf / substring spies during dotted-key expansion', ok, (w) => {
    const log: unknown[] = []
    const built = transformArgs(w, {
      config: { collections: [], localization: false },
      data: { 'g.n': 1 },
      fields: [{ name: 'g', type: 'group', fields: [{ name: 'n', type: 'number' }] }],
      operation: 'write',
    })
    const indexOf = patchOf(
      String.prototype,
      'indexOf',
      (original) =>
        function (this: string, ...args: unknown[]) {
          log.push(['indexOf', String(this), ...args])
          return original.apply(this, args)
        },
    )
    const substring = patchOf(
      String.prototype,
      'substring',
      (original) =>
        function (this: string, ...args: unknown[]) {
          log.push(['substring', String(this), ...args])
          return original.apply(this, args)
        },
    )
    return {
      ...built,
      patch: () => {
        const a = indexOf()
        const b = substring()
        return () => {
          b()
          a()
        }
      },
      roots: { ...built.roots, log },
    }
  }),
  adv('9 Array.isArray spy sees every upstream array test', ok, (w) => {
    const log: unknown[] = []
    const built = transformArgs(w, {
      config: { collections: [{ slug: 'rels', fields: [] }], localization: false },
      data: [
        { _id: 'a', rel: [hex(17)], arr: [{ d: new Date(1) }] },
        { _id: 'b', rel: hex(18) },
      ],
      fields: [
        { name: 'rel', type: 'relationship', hasMany: true, relationTo: 'rels' },
        { name: 'arr', type: 'array', fields: [{ name: 'd', type: 'date' }] },
      ],
      flags: { allowAdditionalKeys: true },
      operation: 'read',
    })
    return {
      ...built,
      patch: patchOf(Array, 'isArray', (original) => (v: unknown) => {
        const r = original(v)
        log.push(r)
        return r
      }),
      roots: { ...built.roots, log },
    }
  }),
  adv('9 a throwing Array.isArray override', throws('isArray'), (w) => {
    const s = w.sentinel('isArray')
    return {
      ...transformArgs(w, {
        config: { collections: [], localization: false },
        data: { a: 1 },
        fields: [],
        operation: 'write',
      }),
      patch: patchOf(Array, 'isArray', () => () => {
        throw s
      }),
    }
  }),
  adv('9 Object.hasOwn spy during dotted-key expansion', ok, (w) => {
    const log: unknown[] = []
    const built = transformArgs(w, {
      config: { collections: [], localization: false },
      data: { 'g.n': 1, plain: 2 },
      fields: [{ name: 'g', type: 'group', fields: [{ name: 'n', type: 'number' }] }],
      operation: 'write',
    })
    return {
      ...built,
      patch: patchOf(Object, 'hasOwn', (original) => (o: object, k: PropertyKey) => {
        const r = original(o, k)
        log.push([String(k), r])
        return r
      }),
      roots: { ...built.roots, log },
    }
  }),
  adv(
    '9 Array.prototype.filter / includes / push / reverse / forEach spies in stripFields + traversal',
    ok,
    (w) => {
      const log: unknown[] = []
      const built = transformArgs(w, {
        config: {
          blocks: [{ slug: 'b', fields: [], flattenedFields: [{ name: 'x', type: 'text' }] }],
          collections: [],
          localization: false,
        },
        data: {
          _id: 'x',
          bl: [{ blockType: 'b', x: 1, y: 2 }, null, { blockType: 'nope' }],
          stray: 1,
        },
        fields: [{ name: 'bl', type: 'blocks', blocks: ['b'] }],
        operation: 'read',
      })
      // records by index assignment: the spied methods must not call themselves
      const spy = (name: 'filter' | 'forEach' | 'includes' | 'push' | 'reverse') =>
        patchOf(
          Array.prototype,
          name,
          (original) =>
            function (this: unknown[], ...args: unknown[]) {
              log[log.length] = [name, this.length]
              return original.apply(this, args)
            },
        )
      const spies = (['filter', 'forEach', 'includes', 'push', 'reverse'] as const).map(spy)
      return {
        ...built,
        patch: () => {
          const restores: (() => void)[] = []
          for (let i = 0; i < spies.length; i++) {
            restores[i] = spies[i]!()
          }
          return () => {
            for (let i = restores.length - 1; i >= 0; i--) {
              restores[i]!()
            }
          }
        },
        roots: { ...built.roots, log },
      }
    },
  ),
  adv('9 Boolean / Number / JSON / Date globals are looked up at call time', ok, (w) => {
    const log: unknown[] = []
    const built = transformArgs(w, {
      config: {
        collections: [{ slug: 'nums', fields: [{ name: 'id', type: 'number' }] }],
        localization: localization(),
      },
      data: {
        _id: BigInt(3),
        loc: { en: { a: 1 } },
        join: { docs: [{ a: 1 }] },
        n: BigInt(4),
      },
      fields: [
        { name: 'loc', type: 'group', localized: true, fields: [{ name: 'a', type: 'number' }] },
        { name: 'join', type: 'join', collection: ['nums'], on: 'x' },
        { name: 'n', type: 'relationship', relationTo: 'nums' },
      ],
      flags: { allowAdditionalKeys: true, useBigIntForNumberIDs: true },
      operation: 'read',
    })
    const patches = [
      patchOf(globalThis, 'Boolean', (original) => (v: unknown) => {
        log.push(['Boolean', typeof v])
        return original(v)
      }),
      patchOf(globalThis, 'Number', (original) => (v: unknown) => {
        log.push(['Number', typeof v])
        return original(v)
      }),
      patchOf(JSON, 'stringify', (original) => (v: unknown) => {
        log.push(['stringify'])
        return original(v)
      }),
    ]
    return {
      ...built,
      patch: () => {
        const restores = patches.map((p) => p())
        return () => restores.reverse().forEach((r) => r())
      },
      roots: { ...built.roots, log },
    }
  }),

  // ---------------------------------------------------------------------------------------------
  // item 10: `in` on a primitive is V8's TypeError
  adv("10 related collection fields containing 1 ('name' in 1)", throws(), (w) =>
    transformArgs(w, {
      config: { collections: [{ slug: 'rels', fields: [1] }], localization: false },
      data: { rel: hex(19) },
      fields: [{ name: 'rel', type: 'relationship', relationTo: 'rels' }],
      operation: 'write',
    }),
  ),
  adv("10 a tab that is a number ('localized' in 3)", throws(), (w) =>
    transformArgs(w, {
      config: { collections: [], localization: localization() },
      data: {},
      fields: [{ type: 'tabs', tabs: [3] }],
      operation: 'write',
    }),
  ),

  // ---------------------------------------------------------------------------------------------
  // item 11: argument destructuring of the exported functions
  ...(['transform', 'handleError', 'getCollection', 'getGlobal', 'getDBName'] as const).flatMap(
    (fn) =>
      [undefined, null].map((args) =>
        adv(`11 ${fn}(${String(args)})`, throws(), () => ({ args, roots: {} }), fn),
      ),
  ),
  adv(
    '11 getDBName({}) (nested config pattern)',
    throws(),
    () => ({ args: {}, roots: {} }),
    'getDBName',
  ),
  adv(
    '11 getDBName({ config: null })',
    throws(),
    () => ({ args: { config: null }, roots: {} }),
    'getDBName',
  ),

  // ---------------------------------------------------------------------------------------------
  // review-mongo-live-writes-sol.md item 9: handleError calls the live string methods
  adv(
    'writes-9 handleError: throwing String.prototype.lastIndexOf',
    throws('lastIndexOf'),
    (w) => {
      const s = w.sentinel('lastIndexOf')
      const error = w.wrap(
        Object.assign(new Error('dup'), { code: 11000, keyValue: { 'slug.en': 'x' } }),
        'error',
      )
      const req = w.wrap({ payload: { config: { localization: { localeCodes: ['en'] } } } }, 'req')
      return {
        args: w.shallowWrap({ collection: 'posts', error, req }, 'args'),
        patch: patchOf(String.prototype, 'lastIndexOf', () => () => {
          throw s
        }),
        roots: { error, req },
      }
    },
    'handleError',
  ),
  adv(
    'writes-9 handleError: lastIndexOf / substring spies',
    throws(),
    (w) => {
      const log: unknown[] = []
      const error = w.wrap(
        Object.assign(new Error('dup'), { code: 11000, keyValue: { 'title.es': 'x' } }),
        'error',
      )
      const req = w.wrap(
        { payload: { config: { localization: { localeCodes: ['en', 'es'] } } } },
        'req',
      )
      const spy = (name: 'lastIndexOf' | 'substring') =>
        patchOf(
          String.prototype,
          name,
          (original) =>
            function (this: string, ...args: unknown[]) {
              log.push([name, String(this), ...args])
              return original.apply(this, args)
            },
        )
      return {
        args: w.shallowWrap({ collection: 'posts', error, req }, 'args'),
        patch: () => {
          const a = spy('lastIndexOf')()
          const b = spy('substring')()
          return () => {
            b()
            a()
          }
        },
        roots: { error, log, req },
      }
    },
    'handleError',
  ),
  adv(
    'writes-9 handleError: lastIndexOf override returns a string index',
    throws(),
    (w) => {
      const error = w.wrap(
        Object.assign(new Error('dup'), { code: 11000, keyValue: { 'title.es': 'x' } }),
        'error',
      )
      const req = w.wrap(
        { payload: { config: { localization: { localeCodes: ['es', 'itle.es'] } } } },
        'req',
      )
      return {
        args: w.shallowWrap({ collection: 'posts', error, req }, 'args'),
        patch: patchOf(String.prototype, 'lastIndexOf', () => () => '0'),
        roots: { error, req },
      }
    },
    'handleError',
  ),
  adv(
    'writes-9 handleError: own includes on localeCodes',
    throws(),
    (w) => {
      const localeCodes: unknown[] = []
      Object.defineProperty(localeCodes, 'includes', { value: () => true })
      const error = w.wrap(
        Object.assign(new Error('dup'), { code: 11000, keyValue: { 'a.b.c': 'x' } }),
        'error',
      )
      const req = w.wrap({ payload: { config: { localization: { localeCodes } } } }, 'req')
      return { args: w.shallowWrap({ global: 'g', error, req }, 'args'), roots: { error, req } }
    },
    'handleError',
  ),
]
