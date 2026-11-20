/**
 * Inputs for the live differential (differential.spec.ts). Every case builds a fresh, identical
 * input per engine run (deterministic, seeded), wrapped in recording proxies by the world.
 */
import type { Field } from 'payload'

import { Types } from 'mongoose'
import { flattenAllFields } from 'payload'

import type { World } from './world.js'

export type FnName =
  | 'getCollection'
  | 'getDBName'
  | 'getGlobal'
  | 'handleError'
  | 'isObjectID'
  | 'transform'

export type Built = {
  /** Runs after the call (inside the recording window, with `patch` applied again), e.g. calls a
   * callback user code kept; its outcome is part of the comparison. */
  after?: () => unknown
  args: unknown
  /** Installs a monkeypatch (globals, prototypes) right before the call; returns the restore. */
  patch?: () => () => void
  roots: Record<string, unknown>
}

export type Case = {
  build: (w: World) => Built
  /** Outcome the TS reference must have (asserted, so a case cannot pass vacuously). */
  expect?: { sentinel?: string; threw: boolean }
  fn: FnName
  name: string
}

/**
 * Deep copy of plain objects / arrays (prototypes, property attributes and sharing kept; functions,
 * class instances, Dates, ObjectIds by reference), so every run wraps its own config graph.
 */
export const cloneGraph = <T>(root: T): T => {
  const seen = new Map<object, object>()
  const clone = (v: unknown): unknown => {
    if (!v || typeof v !== 'object') {
      return v
    }
    const proto = Object.getPrototypeOf(v)
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) {
      return v
    }
    const existing = seen.get(v)
    if (existing) {
      return existing
    }
    const out = Array.isArray(v) ? [] : Object.create(proto)
    seen.set(v, out)
    for (const key of Reflect.ownKeys(v)) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!
      if ('value' in descriptor) {
        descriptor.value = clone(descriptor.value)
      }
      Object.defineProperty(out, key, descriptor)
    }
    if (Object.isFrozen(v)) {
      Object.freeze(out)
    }
    return out
  }
  return clone(root) as T
}

export const hex = (i: number) => (0xabc000 + i).toString(16).padStart(24, '0')
export const oid = (i: number) => new Types.ObjectId(hex(i))

const relFields: Field[] = [
  { name: 'rel', type: 'relationship', relationTo: 'rels' },
  { name: 'relL', type: 'relationship', localized: true, relationTo: 'rels' },
  { name: 'relMany', type: 'relationship', hasMany: true, relationTo: 'rels' },
  { name: 'relManyL', type: 'relationship', hasMany: true, localized: true, relationTo: 'rels' },
  { name: 'poly', type: 'relationship', relationTo: ['rels', 'custom'] },
  { name: 'polyMany', type: 'relationship', hasMany: true, relationTo: ['rels', 'custom', 'nums'] },
  { name: 'custom', type: 'relationship', relationTo: 'custom' },
  { name: 'nums', type: 'relationship', hasMany: true, relationTo: 'nums' },
  { name: 'upload', type: 'upload', relationTo: 'rels' },
  { name: 'uploadMany', type: 'upload', hasMany: true, relationTo: ['rels', 'nums'] },
]

const blockFields: Field[] = [{ name: 'title', type: 'text' }, ...relFields]
const sharedBlockFields: Field[] = [{ name: 'date', type: 'date' }, ...relFields]

export const fields: Field[] = [
  { name: 'title', type: 'text' },
  { name: 'count', type: 'number' },
  { name: 'countL', type: 'number', localized: true },
  { name: 'date', type: 'date' },
  { name: 'dateL', type: 'date', localized: true },
  ...relFields,
  {
    name: 'group',
    type: 'group',
    fields: [{ name: 'count', type: 'number' }, { name: 'other', type: 'number' }, ...relFields],
  },
  {
    name: 'groupL',
    type: 'group',
    localized: true,
    fields: [{ name: 'count', type: 'number' }, { name: 'date', type: 'date' }, ...relFields],
  },
  {
    type: 'row',
    fields: [
      { name: 'rowText', type: 'text' },
      { name: 'rowRel', type: 'relationship', relationTo: 'rels' },
    ],
  },
  { type: 'collapsible', label: 'c', fields: [{ name: 'colDate', type: 'date' }] },
  {
    type: 'tabs',
    tabs: [
      { name: 'tab', fields: [{ name: 'count', type: 'number' }, ...relFields] },
      { name: 'tabL', localized: true, fields: [{ name: 'tabDate', type: 'date' }, ...relFields] },
      {
        label: 'Unnamed',
        fields: [
          { name: 'unnamedDate', type: 'date' },
          { name: 'unnamedRel', type: 'relationship', relationTo: 'rels' },
        ],
      },
    ],
  },
  {
    name: 'array',
    type: 'array',
    fields: [
      { name: 'count', type: 'number' },
      { name: 'date', type: 'date' },
      ...relFields,
      {
        name: 'inner',
        type: 'array',
        fields: [{ name: 'rel', type: 'relationship', relationTo: 'rels' }],
      },
    ],
  },
  {
    name: 'arrayL',
    type: 'array',
    localized: true,
    fields: [{ name: 'date', type: 'date' }, ...relFields],
  },
  {
    name: 'blocks',
    type: 'blocks',
    blocks: [{ slug: 'inline', fields: blockFields }, 'shared'],
  },
  {
    name: 'blocksL',
    type: 'blocks',
    localized: true,
    blocks: [{ slug: 'inline', fields: blockFields }],
  },
  { name: 'join', type: 'join', collection: 'rels', on: 'rel' },
  { name: 'polyJoin', type: 'join', collection: ['rels', 'custom'], on: 'rel' },
]

/** Fields named after `Object.prototype` members and other JS-sensitive names. */
export const weirdFields: Field[] = [
  { name: 'toString', type: 'relationship', relationTo: 'rels' },
  { name: 'constructor', type: 'relationship', hasMany: true, relationTo: 'rels' },
  { name: 'valueOf', type: 'date' },
  { name: 'hasOwnProperty', type: 'number' },
  { name: '__proto__', type: 'relationship', relationTo: 'rels' },
  { name: '2', type: 'relationship', relationTo: 'rels' },
  { name: '10', type: 'number' },
  { name: 'length', type: 'relationship', relationTo: 'rels' },
  {
    name: 'group',
    type: 'group',
    fields: [
      { name: '0', type: 'relationship', relationTo: 'rels' },
      { name: 'length', type: 'date' },
      { name: 'isPrototypeOf', type: 'relationship', relationTo: 'rels' },
    ],
  },
  {
    name: 'loc',
    type: 'group',
    localized: true,
    fields: [{ name: 'rel', type: 'relationship', relationTo: 'rels' }],
  },
  {
    name: 'arr',
    type: 'array',
    fields: [
      { name: 'n', type: 'number' },
      { name: 'toLocaleString', type: 'date' },
    ],
  },
  { name: 'propertyIsEnumerable', type: 'join', collection: ['rels'], on: 'x' },
]

const collections = [
  { slug: 'docs', fields },
  { slug: 'rels', fields: [{ name: 'title', type: 'text' }] },
  { slug: 'custom', fields: [{ name: 'id', type: 'text' }] },
  { slug: 'nums', fields: [{ name: 'id', type: 'number' }] },
]

const blocks = [
  {
    slug: 'shared',
    fields: sharedBlockFields,
    flattenedFields: flattenAllFields({ fields: sharedBlockFields }),
  },
]

export const configs: Record<string, any> = {
  localized: {
    blocks,
    collections,
    localization: {
      defaultLocale: 'en',
      localeCodes: ['en', 'es'],
      locales: [{ code: 'en' }, { code: 'es' }],
    },
  },
  plain: { blocks, collections, localization: false },
}

/** The adapter with a traced copy of the config: every config / field read is in the trace. */
const adapterOf = (w: World, config: unknown, flags: Record<string, unknown> = {}) =>
  w.shallowWrap({ payload: w.wrap({ config }, 'payload'), ...flags }, 'adapter')

type TransformOptions = {
  config: string
  data: (w: World) => { data: unknown; retained?: unknown }
  extraArgs?: Record<string, unknown>
  fields?: Field[]
  flags?: Record<string, unknown>
  operation: unknown
  operators?: ('$addToSet' | '$inc' | '$pull' | '$push')[]
}

export const transformCase = (name: string, o: TransformOptions): Case => ({
  build: (w) => {
    const built = o.data(w)
    const data = w.wrap(built.data, 'data')
    const ops: Record<string, unknown> = {}
    for (const op of o.operators ?? []) {
      ops[op] = w.wrap({}, op)
    }
    // config and fields copied together (the config's collections share the fields arrays)
    const graph = cloneGraph({ config: configs[o.config], fields: o.fields ?? fields })
    const adapter = adapterOf(w, graph.config, o.flags)
    const args = w.shallowWrap(
      {
        ...ops,
        adapter,
        data,
        fields: w.wrap(graph.fields, 'fields'),
        operation: o.operation,
        ...o.extraArgs,
      },
      'args',
    )
    return { args, roots: { data, ...ops, retained: built.retained } }
  },
  fn: 'transform',
  name,
})

// -------------------------------------------------------------------------------------------------
// fixed cases (incl. the four findings of .rs-baseline/review-mongo-transform-sol.md)

const allOperators: TransformOptions['operators'] = ['$addToSet', '$inc', '$pull', '$push']

const readDocs = (): unknown[] => {
  const shared = { relationTo: 'rels', value: oid(1) }
  return [
    {
      _id: oid(2),
      __v: 3,
      title: 'a',
      extra: 1,
      date: new Date(0),
      dateL: { en: new Date(1), es: null, fr: 1 },
    },
    { id: 'x', _id: '', title: 'falsy _id' },
    { _id: 0 },
    { _id: BigInt(5), custom: 'c', nums: [BigInt(1), 2, null] },
    {
      _id: oid(3),
      rel: oid(4),
      relL: { en: oid(5), es: hex(6), fr: oid(7) },
      relMany: [oid(8), null, undefined, hex(9)],
    },
    {
      _id: oid(10),
      poly: shared,
      polyMany: [
        shared,
        shared,
        { relationTo: 'nums', value: BigInt(7) },
        { relationTo: 'nope', value: oid(11) },
      ],
    },
    { _id: oid(12), poly: { relationTo: 'missing', value: oid(13) }, upload: oid(14) },
    {
      _id: oid(15),
      group: { count: 1, rel: oid(16), stray: true, nested: { a: 1 } },
      groupL: { en: { rel: oid(17), x: 1 }, es: null, de: { rel: oid(18) } },
      rowText: 'row',
      tab: { rel: oid(19), junk: 1 },
      tabL: { en: { tabDate: new Date(2), rel: oid(20) }, es: 'str' },
      unnamedDate: new Date(3),
    },
    {
      _id: oid(21),
      array: [
        { id: 'r1', date: new Date(4), rel: oid(22), junk: 1 },
        null,
        'str',
        5,
        { rel: oid(23) },
      ],
      arrayL: { en: [{ date: new Date(5), rel: oid(24) }, null], es: 'x', fr: [] },
      blocks: [
        { blockType: 'inline', rel: oid(25), title: 't', junk: 1 },
        { blockType: 'shared', date: new Date(6), rel: oid(26) },
        { blockType: 'unknown', rel: oid(27) },
        null,
        { noBlockType: true },
      ],
      blocksL: { en: [{ blockType: 'inline', rel: oid(28) }, { blockType: 'x' }], es: [] },
    },
    {
      _id: oid(29),
      join: { docs: [oid(30), hex(31), { id: oid(32) }], hasNextPage: false },
      polyJoin: {
        docs: [
          { relationTo: 'rels', value: oid(33), when: new Date(7), n: Number.NaN, u: undefined },
          null,
          oid(34),
          'str',
        ],
      },
    },
    {
      _id: oid(35),
      'group.count': 1,
      'group.rel': oid(36),
      'a.b.c': 2,
      '__proto__.x': 1,
      'title.x': 'y',
      title: 'z',
    },
    {
      _id: oid(37),
      date: 'not a date',
      group: new Date(8),
      array: { not: 'an array' },
      tab: oid(38),
    },
    { _id: oid(39), shared, shared2: shared, rel: shared },
    { _id: oid(40), date: new Date(Number.NaN) },
  ]
}

const writeDocs = (): unknown[] => [
  {
    title: 'a',
    rel: hex(1),
    relMany: [hex(2), null, 'bad'],
    custom: 'not-an-object-id',
    updatedAt: null,
  },
  { rel: 'not-hex', updatedAt: '2020-01-01T00:00:00.000Z' },
  {
    poly: { relationTo: 'rels', value: hex(3) },
    polyMany: [
      { relationTo: 'custom', value: 'c' },
      { relationTo: 'rels', value: 'bad' },
    ],
  },
  { relL: { en: hex(4), es: 'bad' } },
  {
    count: { $inc: 2 },
    group: { count: { $inc: 3 } },
    tab: { count: { $inc: 1 } },
    array: [{ count: { $inc: 1 } }],
  },
  { group: { count: { $inc: 3 }, other: 1 } },
  { count: { $inc: 'x' }, group: { count: { notInc: 1 } }, countL: { en: { $inc: 1 } } },
  {
    array: { $push: [{ count: 1 }] },
    arrayL: { en: { $push: { date: 'x' } }, es: { $push: null }, fr: 1 },
    group: { rel: hex(5) },
  },
  { array: { $push: { count: 2 } }, blocks: { $push: [] } },
  {
    relMany: { $push: [hex(6), 'bad'] },
    relManyL: { en: { $push: hex(7) }, es: { $remove: [hex(8)] } },
    polyMany: { $remove: { relationTo: 'rels', value: hex(9) } },
    nums: { $push: 5 },
  },
  { relMany: { $remove: hex(10) }, group: { relMany: { $push: [hex(11)] } } },
  { 'group.count': { $inc: 1 }, 'group.rel': hex(12), 'x.y': 1 },
  { group: { relMany: { $push: [hex(13)] } }, tab: { relMany: { $remove: [hex(14)] } } },
  {
    rel: Buffer.from('0123456789ab'),
    relMany: [Buffer.from('abcdefabcdef'), hex(15)],
    poly: { relationTo: 'rels', value: 12345 },
  },
  { rel: 42, relMany: [BigInt(3), true, { x: 1 }], upload: oid(16) },
  {
    blocks: [
      { blockType: 'inline', rel: hex(17) },
      { blockType: 'shared', relMany: [hex(18)] },
      { blockType: 'none', rel: hex(19) },
    ],
  },
]

export const fixedCases = (): Case[] => {
  const out: Case[] = []
  for (const config of Object.keys(configs)) {
    readDocs().forEach((_, i) => {
      for (const flags of [{}, { allowAdditionalKeys: true }, { useBigIntForNumberIDs: true }]) {
        out.push(
          transformCase(`read ${config} #${i} ${JSON.stringify(flags)}`, {
            config,
            data: () => ({ data: readDocs()[i] }),
            flags,
            operation: 'read',
          }),
        )
      }
    })
    out.push(
      transformCase(`read ${config} array`, {
        config,
        data: () => ({ data: readDocs().slice(0, 4) }),
        operation: 'read',
      }),
    )
    out.push(
      transformCase(`read ${config} nested arrays`, {
        config,
        data: () => ({ data: [[{ _id: oid(41) }], null, { _id: oid(42) }] }),
        operation: 'read',
      }),
    )
    for (const data of [null, undefined, 0, '', 'a string', 5]) {
      for (const operation of ['read', 'write']) {
        out.push(
          transformCase(`${operation} ${config} primitive ${String(data)}`, {
            config,
            data: () => ({ data }),
            operation,
          }),
        )
      }
    }
    writeDocs().forEach((_, i) => {
      for (const validateRelationships of [undefined, false, true, 0, 'yes']) {
        for (const operators of [allOperators, undefined]) {
          out.push(
            transformCase(
              `write ${config} #${i} vr=${String(validateRelationships)} ops=${Boolean(operators)}`,
              {
                config,
                data: () => ({ data: writeDocs()[i] }),
                extraArgs: { validateRelationships },
                operation: 'write',
                operators,
              },
            ),
          )
        }
      }
      out.push(
        transformCase(`other-operation ${config} #${i}`, {
          config,
          data: () => ({ data: writeDocs()[i] }),
          operation: 'update',
          operators: allOperators,
        }),
      )
    })
    out.push(
      transformCase(`write ${config} globalSlug`, {
        config,
        data: () => ({ data: { title: 'g' } }),
        extraArgs: { globalSlug: 'my-global' },
        operation: 'write',
      }),
    )
    out.push(
      transformCase(`write ${config} array`, {
        config,
        data: () => ({
          data: [{ title: 'a' }, { title: 'b', updatedAt: null }, null, { rel: hex(20) }],
        }),
        operation: 'write',
      }),
    )
    for (const parentIsLocalized of [true, 1, null]) {
      out.push(
        transformCase(`write ${config} parentIsLocalized=${String(parentIsLocalized)}`, {
          config,
          data: () => ({
            data: {
              rel: hex(21),
              relL: { en: hex(22) },
              groupL: { rel: hex(23) },
              arrayL: [{ rel: hex(24) }],
            },
          }),
          extraArgs: { parentIsLocalized },
          operation: 'write',
        }),
      )
    }

    // finding 1: relationship arrays are replaced via `.map()`; arrays the caller retains stay untouched
    for (const operation of ['write', 'read']) {
      out.push(
        transformCase(`${config} ${operation} retained relationship arrays`, {
          config,
          data: () => {
            const relMany = operation === 'write' ? [hex(25), hex(26)] : [oid(25), oid(26)]
            const polyMany = [
              { relationTo: 'rels', value: operation === 'write' ? hex(27) : oid(27) },
            ]
            const relManyL = { en: [operation === 'write' ? hex(28) : oid(28)] }
            return {
              data: { _id: oid(29), relMany, polyMany, relManyL, group: { relMany } },
              retained: { relMany, polyMany, relManyL },
            }
          },
          operation,
        }),
      )
    }

    // finding 2: prototype-named fields read inherited values like TS; finding 3: own `__proto__` in
    // polymorphic join docs survives the JSON round trip; finding 4: Buffer ids pass through
    const weird = (): unknown[] => [
      { _id: oid(43), title: 1, '2': hex(44), '10': 5, b: 1, '1': 2 },
      { _id: oid(45), group: [oid(46), 'x'], loc: oid(47), arr: [[1], { n: 1 }] },
      {
        _id: oid(48),
        group: { '0': oid(49), length: new Date(9), '5': 1 },
        loc: { en: [oid(50)], es: oid(51) },
      },
      { _id: oid(52), length: oid(53), constructor: [oid(54)] },
      JSON.parse('{"__proto__": {"x": 1}, "group": {"__proto__": 1}}'),
      {},
      { toString: hex(55), valueOf: new Date(10), hasOwnProperty: { $inc: 2 } },
      {
        propertyIsEnumerable: {
          docs: [
            JSON.parse('{"__proto__": {"y": 2}, "a": 1}'),
            oid(56),
            { toJSON: () => ({ j: 1 }) },
          ],
        },
      },
      { rel: Buffer.from('0123456789ab'), '2': new Uint8Array([1, 2, 3]) },
    ]
    weird().forEach((_, i) => {
      for (const operation of ['read', 'write']) {
        for (const validateRelationships of [undefined, false]) {
          out.push(
            transformCase(
              `${config} weird #${i} ${operation} vr=${String(validateRelationships)}`,
              {
                config,
                data: () => ({ data: weird()[i] }),
                extraArgs: { validateRelationships },
                fields: weirdFields,
                operation,
                operators: ['$inc'],
              },
            ),
          )
        }
      }
    })
  }
  return out
}

// -------------------------------------------------------------------------------------------------
// seeded random documents

const rng = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Gen = { op: 'read' | 'write'; r: () => number; shared: unknown[]; w: World }

const pick = <T>(g: Gen, items: T[]): T => items[Math.floor(g.r() * items.length)]!

const scalarId = (g: Gen): unknown =>
  pick(g, [
    () => (g.op === 'read' ? oid(Math.floor(g.r() * 50)) : hex(Math.floor(g.r() * 50))),
    () => (g.op === 'read' ? hex(1) : oid(2)),
    () => (g.r() < 0.15 ? 'bad' : hex(Math.floor(g.r() * 50))),
    () => null,
    () => undefined,
    () => 42,
    () => BigInt(7),
    () => Buffer.from('abcdefabcdef'),
    () => '',
    () => ({ id: hex(3) }),
  ])()

const relValue = (g: Gen, field: any): unknown => {
  const one = (): unknown => {
    if (Array.isArray(field.relationTo) || g.r() < 0.2) {
      if (g.r() < 0.7) {
        const o: Record<string, unknown> = {
          relationTo: pick(g, ['rels', 'custom', 'nums', 'nope']),
          value: scalarId(g),
        }
        if (g.r() < 0.1) {
          delete o.value
        }
        return o
      }
    }
    if (g.shared.length && g.r() < 0.1) {
      return pick(g, g.shared)
    }
    return scalarId(g)
  }
  const many = () => {
    const arr: unknown[] = []
    const n = Math.floor(g.r() * 4)
    for (let i = 0; i < n; i++) {
      arr.push(one())
    }
    if (g.r() < 0.1) {
      arr[n + 1] = one()
    }
    return arr
  }
  const base = () => {
    if (field.hasMany && g.op === 'write' && g.r() < 0.35) {
      const operand = g.r() < 0.5 ? '$push' : '$remove'
      return { [operand]: g.r() < 0.5 ? many() : one() }
    }
    return field.hasMany && g.r() < 0.8 ? many() : one()
  }
  if (field.localized && g.r() < 0.7) {
    const o: Record<string, unknown> = {}
    for (const locale of ['en', 'es', 'fr']) {
      if (g.r() < 0.7) {
        o[locale] = base()
      }
    }
    return o
  }
  return base()
}

const dateValue = (g: Gen): unknown =>
  pick(g, [
    () => new Date(Math.floor(g.r() * 1e12)),
    () => (g.r() < 0.1 ? new Date(Number.NaN) : new Date(Math.floor(g.r() * 1e12))),
    () => '2020-01-01',
    () => null,
    () => 0,
    () => 5,
  ])()

const numberValue = (g: Gen): unknown =>
  pick(g, [
    () => 1,
    () => ({ $inc: 2 }),
    () => ({ $inc: 'x' }),
    () => null,
    () => '3',
    () => ({ $inc: 1, other: 1 }),
  ])()

const joinValue = (g: Gen): unknown => {
  if (g.r() < 0.15) {
    return pick(g, ['str', 5, null, [oid(1)]])
  }
  const docs: unknown[] = []
  const n = Math.floor(g.r() * 4)
  for (let i = 0; i < n; i++) {
    docs.push(
      pick(g, [
        () => oid(Math.floor(g.r() * 50)),
        () => hex(4),
        () => ({ id: oid(5), when: new Date(6) }),
        () => null,
        () => 'str',
        () => JSON.parse('{"__proto__": {"x": 1}, "a": 1}'),
        () => ({ toJSON: () => ({ j: 1 }) }),
        () => ({ relationTo: 'rels', value: oid(7), n: Number.NaN, u: undefined }),
      ])(),
    )
  }
  return { docs, hasNextPage: g.r() < 0.5 }
}

const genFields = (g: Gen, fieldList: any[], into: Record<string, unknown>, depth: number) => {
  for (const field of fieldList) {
    if (field.type === 'row' || field.type === 'collapsible') {
      genFields(g, field.fields, into, depth)
      continue
    }
    if (field.type === 'tabs') {
      for (const tab of field.tabs) {
        if (!tab.name) {
          genFields(g, tab.fields, into, depth)
        } else if (g.r() < 0.7) {
          into[tab.name] =
            tab.localized && g.r() < 0.7
              ? { en: genDoc(g, tab.fields, depth + 1), es: genDoc(g, tab.fields, depth + 1) }
              : genDoc(g, tab.fields, depth + 1)
        }
      }
      continue
    }
    if (g.r() < 0.35) {
      continue
    }
    into[field.name] = genValue(g, field, depth)
  }
}

const rows = (g: Gen, field: any, depth: number): unknown[] => {
  const out: unknown[] = []
  const n = Math.floor(g.r() * 3)
  for (let i = 0; i < n; i++) {
    if (g.r() < 0.15) {
      out.push(pick(g, [null, 'str', 5, []]))
      continue
    }
    if (field.type === 'blocks') {
      const blockType = pick(g, ['inline', 'shared', 'unknown', undefined, 5])
      const block = field.blocks.find(
        (b: any) => (typeof b === 'string' ? b : b.slug) === blockType,
      )
      const blockFields =
        typeof block === 'string'
          ? sharedBlockFields
          : (block?.fields ?? [{ name: 'rel', type: 'relationship', relationTo: 'rels' }])
      out.push(genDoc(g, blockFields, depth + 1, blockType === undefined ? {} : { blockType }))
    } else {
      out.push(genDoc(g, field.fields, depth + 1))
    }
  }
  return out
}

const genValue = (g: Gen, field: any, depth: number): unknown => {
  switch (field.type) {
    case 'array':
    case 'blocks': {
      if (depth > 3) {
        return []
      }
      const base = () =>
        g.op === 'write' && g.r() < 0.2
          ? { $push: g.r() < 0.5 ? rows(g, field, depth) : (rows(g, field, depth)[0] ?? {}) }
          : rows(g, field, depth)
      if (field.localized && g.r() < 0.7) {
        return { en: base(), es: g.r() < 0.3 ? 'x' : base(), fr: base() }
      }
      return g.r() < 0.1 ? { not: 'rows' } : base()
    }
    case 'date':
      if (field.localized && g.r() < 0.7) {
        return { en: dateValue(g), es: dateValue(g), fr: dateValue(g) }
      }
      return dateValue(g)
    case 'group':
      if (depth > 3) {
        return {}
      }
      if (field.localized && g.r() < 0.7) {
        return {
          en: genDoc(g, field.fields, depth + 1),
          es: g.r() < 0.3 ? null : genDoc(g, field.fields, depth + 1),
          de: genDoc(g, field.fields, depth + 1),
        }
      }
      return g.r() < 0.1 ? pick(g, [null, 'str', new Date(1)]) : genDoc(g, field.fields, depth + 1)
    case 'join':
      return joinValue(g)
    case 'number':
      if (field.localized && g.r() < 0.5) {
        return { en: numberValue(g), es: numberValue(g) }
      }
      return numberValue(g)
    case 'relationship':
    case 'upload':
      return relValue(g, field)
    default:
      return pick(g, ['text', 1, null, { nested: true }, undefined])
  }
}

const genDoc = (
  g: Gen,
  fieldList: any[],
  depth: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => {
  const doc: Record<string, unknown> = {}
  if (depth === 0 && g.op === 'read') {
    if (g.r() < 0.8) {
      doc._id = pick(g, [
        () => oid(Math.floor(g.r() * 50)),
        () => BigInt(9),
        () => 'string-id',
        () => 0,
      ])()
    }
    if (g.r() < 0.3) {
      doc.__v = 0
    }
    if (g.r() < 0.1) {
      doc.id = 'given'
    }
  }
  genFields(g, fieldList, doc, depth)
  Object.assign(doc, extra)
  if (g.r() < 0.2) {
    doc[`extra${Math.floor(g.r() * 3)}`] = pick(g, [1, { x: 1 }, null])
  }
  if (g.r() < 0.1) {
    const target = pick(g, ['group', 'tab', 'x', 'title', '__proto__'])
    doc[`${target}.${pick(g, ['count', 'rel', 'y', '__proto__'])}`] = pick(g, [
      1,
      hex(8),
      { $inc: 1 },
    ])
  }
  if (g.r() < 0.05) {
    Object.defineProperty(doc, 'title', {
      enumerable: true,
      configurable: true,
      get: () => 'from getter',
    })
  }
  if (g.r() < 0.02) {
    const error = g.w.sentinel(`getter ${depth}`)
    Object.defineProperty(doc, pick(g, ['rel', 'group', 'array', 'updatedAt']), {
      enumerable: true,
      configurable: true,
      get: () => {
        throw error
      },
    })
  }
  if (g.op === 'write' && g.r() < 0.1) {
    Object.defineProperty(doc, 'updatedAt', {
      configurable: true,
      enumerable: true,
      value: pick(g, [null, '2020-01-01T00:00:00.000Z', undefined, 0]),
      writable: true,
    })
  }
  if (g.r() < 0.1 && depth > 0) {
    g.shared.push(doc)
  }
  if (g.r() < 0.02) {
    Object.freeze(doc)
  }
  return doc
}

export const randomCases = (count: number): Case[] => {
  const out: Case[] = []
  for (let i = 0; i < count; i++) {
    const config = i % 2 === 0 ? 'localized' : 'plain'
    const op = i % 4 < 2 ? 'read' : 'write'
    out.push({
      build: (w) => {
        const r = rng(1000 + i)
        const g: Gen = { op, r, shared: [], w }
        const flags =
          op === 'read' ? { allowAdditionalKeys: r() < 0.2, useBigIntForNumberIDs: r() < 0.3 } : {}
        const data = r() < 0.1 ? [genDoc(g, fields, 0), genDoc(g, fields, 0)] : genDoc(g, fields, 0)
        const extra: Record<string, unknown> = {}
        if (op === 'write') {
          extra.validateRelationships = pick(g, [undefined, false, false, false, true])
          if (r() < 0.1) {
            extra.globalSlug = 'glob'
          }
        }
        const operators =
          op === 'write' && r() < 0.8 ? (['$addToSet', '$inc', '$pull', '$push'] as const) : []
        return transformCase('', {
          config,
          data: () => ({ data }),
          extraArgs: extra,
          flags,
          operation: op,
          operators: [...operators],
        }).build(w)
      },
      fn: 'transform',
      name: `random #${i} ${config} ${op}`,
    })
  }
  return out
}

// -------------------------------------------------------------------------------------------------
// handleError / getCollection / getGlobal / getDBName / isObjectID

const mongoError = (message: string, extra: Record<string, unknown>) =>
  Object.assign(new Error(message), extra)

export const utilityCases = (): Case[] => {
  const out: Case[] = []
  const errors: (() => unknown)[] = [
    () =>
      mongoError('E11000 duplicate key error collection: db.posts index: email_1 dup key', {
        code: 11000,
        keyValue: { email: 'a' },
      }),
    () =>
      mongoError('E11000 duplicate key error collection: db.posts index: title.es_1 dup key', {
        code: 11000,
        keyValue: { 'title.es': 'a' },
      }),
    () =>
      mongoError('E11000 duplicate key error collection: db.posts index: slug_1 dup key', {
        code: 11000,
      }),
    () => mongoError('E11000 index:   group.title.en_1', { code: 11000 }),
    () => mongoError('no index here', { code: 11000 }),
    () => mongoError('x', { code: 11000, keyValue: {} }),
    () => mongoError('x', { code: 11000, keyValue: null, message: 5 }),
    () => mongoError('x', { code: '11000', keyValue: { a: 1 } }),
    () => mongoError('other', { code: 2 }),
    () => ({ code: 11000, keyValue: { 'deep.path.fr': 1 } }),
    () => 'a string error',
    () => null,
    () => undefined,
    () => 11000,
    () => new TypeError('boom'),
  ]
  const reqs: ((w: World) => unknown)[] = [
    () => undefined,
    () => null,
    (w) => ({
      t: w.label(
        (key: string, opts?: unknown) => `t(${key}${opts ? JSON.stringify(opts) : ''})`,
        'req.t',
      ),
    }),
    (w) => ({
      payload: { config: { localization: { localeCodes: ['en', 'es'] } } },
      t: w.label((key: string) => `T:${key}`, 'req.t'),
    }),
    () => ({ payload: { config: { localization: false } } }),
    () => ({ payload: { config: { localization: { localeCodes: ['es'] } } }, t: 'not callable' }),
  ]
  errors.forEach((_, i) => {
    reqs.forEach((__, j) => {
      for (const target of [{ collection: 'posts' }, { global: 'settings' }, {}]) {
        out.push({
          build: (w) => {
            const error = w.wrap(errors[i]!(), 'error')
            const req = w.wrap(reqs[j]!(w), 'req')
            return { args: w.shallowWrap({ ...target, error, req }, 'args'), roots: { error, req } }
          },
          fn: 'handleError',
          name: `handleError error#${i} req#${j} ${JSON.stringify(target)}`,
        })
      }
    })
  })

  const models = { posts: { modelName: 'posts' }, onlyVersions: undefined }
  const adapter = (w: World) =>
    w.wrap(
      {
        collections: { posts: models.posts, noModel: undefined },
        globals: { modelName: 'globals' },
        payload: {
          collections: {
            noModel: { config: { slug: 'noModel' }, customIDType: undefined },
            posts: { config: { slug: 'posts' }, customIDType: 'text' },
          },
          config: { globals: [{ slug: 'settings' }, { slug: 'noVersions' }] },
        },
        versions: {
          posts: { modelName: '_posts_versions' },
          settings: { modelName: '_settings_versions' },
        },
      },
      'adapter',
    )
  for (const slug of ['posts', 'noModel', 'missing', 5, { toString: () => 'posts' }]) {
    for (const versions of [undefined, false, true, 1]) {
      out.push({
        build: (w) => {
          const a = adapter(w)
          return {
            args: w.shallowWrap({ adapter: a, collectionSlug: slug, versions }, 'args'),
            roots: { adapter: a },
          }
        },
        fn: 'getCollection',
        name: `getCollection ${String(slug)} versions=${String(versions)}`,
      })
    }
  }
  for (const slug of ['settings', 'noVersions', 'missing', 7]) {
    for (const versions of [undefined, true]) {
      out.push({
        build: (w) => {
          const a = adapter(w)
          return {
            args: w.shallowWrap({ adapter: a, globalSlug: slug, versions }, 'args'),
            roots: { adapter: a },
          }
        },
        fn: 'getGlobal',
        name: `getGlobal ${String(slug)} versions=${String(versions)}`,
      })
    }
  }
  const dbConfigs: (() => Record<string, unknown>)[] = [
    () => ({ slug: 'posts' }),
    () => ({ name: 'settings' }),
    () => ({ name: 'n', slug: 's' }),
    () => ({ dbName: 'custom', slug: 's' }),
    () => ({ dbName: (args: unknown) => `fn:${JSON.stringify(args)}`, slug: 's' }),
    () => ({ enumName: 'enum', slug: 's' }),
    () => ({ dbName: 'db', enumName: '', slug: 's' }),
    () => ({}),
    () => ({ dbName: '' }),
    () => ({ dbName: () => '' }),
    () => ({ dbName: () => 5, name: 'x' }),
    () => ({ name: null, slug: undefined }),
  ]
  dbConfigs.forEach((_, i) => {
    for (const target of [undefined, 'dbName', 'enumName']) {
      for (const versions of [undefined, true]) {
        out.push({
          build: (w) => {
            const config = w.wrap(dbConfigs[i]!(), 'config')
            return { args: w.shallowWrap({ config, target, versions }, 'args'), roots: { config } }
          },
          fn: 'getDBName',
          name: `getDBName #${i} target=${String(target)} versions=${String(versions)}`,
        })
      }
    }
  })
  const values: ((w: World) => unknown)[] = [
    () => oid(1),
    (w) => w.wrap({ _bsontype: 'ObjectId', toHexString: () => 'x' }, 'fake'),
    (w) => w.wrap({ _bsontype: 'ObjectId' }, 'noHex'),
    (w) => w.wrap({ _bsontype: 'ObjectID', toHexString: () => 'x' }, 'wrongCase'),
    (w) => w.wrap({ _bsontype: 'ObjectId', toHexString: 'x' }, 'hexNotFn'),
    (w) =>
      w.wrap(
        Object.create({
          _bsontype: 'ObjectId',
          toHexString() {
            return 'p'
          },
        }),
        'inherited',
      ),
    () => null,
    () => 'str',
    () => Object.assign(() => {}, { _bsontype: 'ObjectId', toHexString: () => 'x' }),
    () => 0,
  ]
  values.forEach((_, i) => {
    out.push({
      build: (w) => {
        const value = values[i]!(w)
        return { args: value, roots: { value } }
      },
      fn: 'isObjectID',
      name: `isObjectID #${i}`,
    })
  })
  return out
}
