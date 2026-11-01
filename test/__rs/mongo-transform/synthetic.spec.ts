/**
 * Edge-case inputs for upstream `transform`, run through the recorder plugin
 * (test/__rs/mongo-transform/vitest.config.ts, `unit` project) so the Rust replay compares them
 * with what upstream does: dotted keys, `$inc` / `$push` / `$remove` operators (localized and in
 * groups, emptied containers), invalid relationship ids, invalid dates, bigint ids, polymorphic
 * joins, unknown blocks, malformed rows, `allowAdditionalKeys`, `globalSlug`, `updatedAt: null`.
 * Upstream's own results are not asserted here: the recording is the expectation.
 */
import type { Field } from 'payload'

import { Types } from 'mongoose'
import { flattenAllFields } from 'payload'
import { describe, expect, it } from 'vitest'

import { transform } from '../../../packages/db-mongodb/src/utilities/transform.js'

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
]

const blockFields: Field[] = [{ name: 'title', type: 'text' }, ...relFields]

const fields: Field[] = [
  { name: 'title', type: 'text' },
  { name: 'count', type: 'number' },
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
    fields: [{ name: 'count', type: 'number' }, ...relFields],
  },
  { type: 'row', fields: [{ name: 'rowText', type: 'text' }] },
  {
    type: 'tabs',
    tabs: [
      { name: 'tab', fields: [{ name: 'count', type: 'number' }, ...relFields] },
      { name: 'tabL', localized: true, fields: [{ name: 'tabDate', type: 'date' }, ...relFields] },
      { label: 'Unnamed', fields: [{ name: 'unnamedDate', type: 'date' }] },
    ],
  },
  {
    name: 'array',
    type: 'array',
    fields: [{ name: 'count', type: 'number' }, { name: 'date', type: 'date' }, ...relFields],
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

const sharedBlockFields: Field[] = [{ name: 'date', type: 'date' }, ...relFields]

const config: any = {
  blocks: [
    {
      slug: 'shared',
      fields: sharedBlockFields,
      flattenedFields: flattenAllFields({ fields: sharedBlockFields }),
    },
  ],
  collections: [
    { slug: 'docs', fields },
    { slug: 'rels', fields: [{ name: 'title', type: 'text' }] },
    { slug: 'custom', fields: [{ name: 'id', type: 'text' }] },
    { slug: 'nums', fields: [{ name: 'id', type: 'number' }] },
  ],
  localization: {
    defaultLocale: 'en',
    localeCodes: ['en', 'es'],
    locales: [{ code: 'en' }, { code: 'es' }],
  },
}

const adapterOf = (flags: Record<string, unknown> = {}): any => ({ payload: { config }, ...flags })

const id = () => new Types.ObjectId()
const hex = () => new Types.ObjectId().toHexString()

const run = (args: Record<string, unknown>) => {
  try {
    transform({ adapter: adapterOf(), fields, ...args } as any)
    return undefined
  } catch (error) {
    return error
  }
}

describe('transform edge cases (recorded for the Rust replay)', () => {
  it('should run read edge cases', () => {
    const shared = { relationTo: 'rels', value: id() }
    const cases: any[] = [
      {
        _id: id(),
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
        _id: id(),
        rel: id(),
        relL: { en: id(), es: hex(), fr: id() },
        relMany: [id(), null, undefined, hex()],
      },
      {
        _id: id(),
        poly: shared,
        polyMany: [
          shared,
          shared,
          { relationTo: 'nums', value: BigInt(7) },
          { relationTo: 'nope', value: id() },
        ],
      },
      { _id: id(), poly: { relationTo: 'missing', value: id() }, upload: id() },
      {
        _id: id(),
        group: { count: 1, rel: id(), stray: true, nested: { a: 1 } },
        groupL: { en: { rel: id(), x: 1 }, es: null, de: { rel: id() } },
        rowText: 'row',
        tab: { rel: id(), junk: 1 },
        tabL: { en: { tabDate: new Date(2), rel: id() }, es: 'str' },
        unnamedDate: new Date(3),
      },
      {
        _id: id(),
        array: [{ id: 'r1', date: new Date(4), rel: id(), junk: 1 }, null, 'str', 5, { rel: id() }],
        arrayL: { en: [{ date: new Date(5), rel: id() }, null], es: 'x', fr: [] },
        blocks: [
          { blockType: 'inline', rel: id(), title: 't', junk: 1 },
          { blockType: 'shared', date: new Date(6), rel: id() },
          { blockType: 'unknown', rel: id() },
          null,
          { noBlockType: true },
        ],
        blocksL: { en: [{ blockType: 'inline', rel: id() }, { blockType: 'x' }], es: [] },
      },
      {
        _id: id(),
        join: { docs: [id(), hex(), { id: id() }], hasNextPage: false },
        polyJoin: {
          docs: [
            { relationTo: 'rels', value: id(), when: new Date(7), n: NaN, u: undefined },
            null,
            id(),
            'str',
          ],
        },
      },
      {
        _id: id(),
        'group.count': 1,
        'group.rel': id(),
        'a.b.c': 2,
        '__proto__.x': 1,
        'title.x': 'y',
        title: 'z',
      },
      { _id: id(), date: 'not a date', group: new Date(8), array: { not: 'an array' }, tab: id() },
      { _id: id(), shared, shared2: shared, rel: shared },
    ]
    for (const data of cases) {
      run({ data, operation: 'read' })
    }
    run({ data: cases.slice(0, 3), operation: 'read' })
    run({ data: [[{ _id: id() }], null, { _id: id() }], operation: 'read' })
    run({ data: null, operation: 'read' })
    run({ data: { _id: id(), date: new Date(NaN) }, operation: 'read' })
    for (const flags of [{ allowAdditionalKeys: true }, { useBigIntForNumberIDs: true }]) {
      try {
        transform({
          adapter: adapterOf(flags),
          data: {
            _id: BigInt(9),
            extra: 1,
            nums: [BigInt(1)],
            polyMany: [{ relationTo: 'nums', value: BigInt(2) }],
          },
          fields,
          operation: 'read',
        } as any)
      } catch {
        // recorded
      }
    }
    expect(true).toBe(true)
  })

  it('should run write edge cases', () => {
    const writes: any[] = [
      {
        title: 'a',
        rel: hex(),
        relMany: [hex(), null, 'bad'],
        custom: 'not-an-object-id',
        updatedAt: null,
      },
      { rel: 'not-hex', updatedAt: '2020-01-01T00:00:00.000Z' },
      {
        poly: { relationTo: 'rels', value: hex() },
        polyMany: [
          { relationTo: 'custom', value: 'c' },
          { relationTo: 'rels', value: 'bad' },
        ],
      },
      { relL: { en: hex(), es: 'bad' } },
      {
        count: { $inc: 2 },
        group: { count: { $inc: 3 } },
        tab: { count: { $inc: 1 } },
        array: [{ count: { $inc: 1 } }],
      },
      { group: { count: { $inc: 3 }, other: 1 } },
      { count: { $inc: 'x' }, group: { count: { notInc: 1 } } },
      {
        array: { $push: [{ count: 1 }] },
        arrayL: { en: { $push: { date: 'x' } }, es: { $push: null }, fr: 1 },
        group: { rel: hex() },
      },
      { array: { $push: { count: 2 } }, blocks: { $push: [] } },
      {
        relMany: { $push: [hex(), 'bad'] },
        relManyL: { en: { $push: hex() }, es: { $remove: [hex()] } },
        polyMany: { $remove: { relationTo: 'rels', value: hex() } },
        nums: { $push: 5 },
      },
      { relMany: { $remove: hex() }, group: { relMany: { $push: [hex()] } } },
      { 'group.count': { $inc: 1 }, 'group.rel': hex(), 'x.y': 1 },
    ]
    for (const data of writes) {
      for (const validateRelationships of [undefined, false]) {
        run({
          $addToSet: {},
          $inc: {},
          $pull: {},
          $push: {},
          data: structuredClone(data),
          operation: 'write',
          validateRelationships,
        })
      }
      run({ data: structuredClone(data), operation: 'write', validateRelationships: false })
    }
    run({ data: { title: 'g' }, globalSlug: 'my-global', operation: 'write' })
    run({ data: [{ title: 'a' }, { title: 'b', updatedAt: null }], operation: 'write' })
    run({ data: { rel: hex() }, operation: 'write', parentIsLocalized: true })
    run({ data: { relL: { en: hex() } }, operation: 'write', parentIsLocalized: true })
    run({ data: 'a string', operation: 'write' })
    run({ data: 'a string', operation: 'read' })
    expect(true).toBe(true)
  })

  it('should run JS-semantics edge cases', () => {
    const weirdFields: Field[] = [
      { name: 'constructor', type: 'relationship', relationTo: 'rels' },
      { name: 'toString', type: 'date' },
      { name: '2', type: 'relationship', relationTo: 'rels' },
      { name: '10', type: 'number' },
      { name: 'length', type: 'relationship', relationTo: 'rels' },
      { name: 'group', type: 'group', fields: [{ name: '0', type: 'relationship', relationTo: 'rels' }, { name: 'length', type: 'date' }] },
      { name: 'loc', type: 'group', localized: true, fields: [{ name: 'rel', type: 'relationship', relationTo: 'rels' }] },
      { name: 'arr', type: 'array', fields: [{ name: 'n', type: 'number' }] },
    ]
    const cases: any[] = [
      { _id: id(), title: 1, '2': hex(), '10': 5, b: 1, '1': 2 },
      { _id: id(), group: [id(), 'x'], loc: id(), arr: [[1], { n: 1 }] },
      { _id: id(), group: { '0': id(), length: new Date(9), '5': 1 }, loc: { en: [id()], es: id() } },
      { _id: id(), length: id(), constructor: id() },
      JSON.parse('{"__proto__": {"x": 1}, "group": {"__proto__": 1}}'),
    ]
    for (const data of cases) {
      for (const operation of ['read', 'write']) {
        try {
          transform({
            $inc: {},
            adapter: adapterOf(),
            data: operation === 'read' ? data : structuredClone({ ...data, _id: undefined }),
            fields: weirdFields,
            operation,
            validateRelationships: false,
          } as any)
        } catch {
          // recorded
        }
      }
    }
    try {
      transform({
        $inc: {},
        adapter: adapterOf(),
        data: { '10': { $inc: 1 }, group: { '0': hex() }, arr: [{ n: { $inc: 2 } }, { n: { $inc: 3 } }] },
        fields: weirdFields,
        operation: 'write',
      } as any)
    } catch {
      // recorded
    }
    expect(true).toBe(true)
  })
})
