/**
 * Hand-crafted edge cases for the drizzle read transform (quirks that seeded data rarely
 * reaches: integer-like locale codes, empty `_locales`, string numbers/points/dates, local-time
 * and overflowing dates, custom number IDs, polymorphic/hasMany/localized relationships, joins
 * with count/limit, InternalBlockTableNameIndex, long array relation names, thrown errors,
 * `Object.prototype` keys such as `constructor`/`__proto__` hitting the internal path/locale maps,
 * own `__proto__` properties, and lone UTF-16 surrogates in strings and keys).
 * Calls the real TS `transform` and records (args, output) into fixtures/synthetic.json.
 *
 * Run: SQLITE_URL=file:/tmp/rs-read.db pnpm test:int:sqlite test/__rs/read/synthetic.int.spec.ts
 */
import { afterAll, describe, expect, it } from 'vitest'

import { transform as tsTransform } from '../../../packages/drizzle/src/transform/read/index.js'
import { InternalBlockTableNameIndex } from '../../../packages/drizzle/src/utilities/validateExistingBlockIsIdentical.js'
import { flushFixture, wrapTransform } from './capture/recorder.js'

const transform = wrapTransform(tsTransform)

const localization = {
  defaultLocale: 'en',
  localeCodes: ['en', 'es', '1'],
  locales: [{ code: 'en' }, { code: 'es' }, { code: '1' }],
}

const blockA: any = {
  slug: 'blockA',
  flattenedFields: [
    { name: 'text', type: 'text' },
    { name: 'nums', type: 'number', hasMany: true },
    { name: 'rel', type: 'relationship', hasMany: true, relationTo: ['posts', 'users'] },
  ],
}
const blockB: any = {
  slug: 'block_b',
  flattenedFields: [{ name: 'when', type: 'date' }],
}
blockB[InternalBlockTableNameIndex] = 2

const fields: any[] = [
  { name: 'title', type: 'text', localized: true },
  { name: 'num', type: 'number' },
  { name: 'when', type: 'date' },
  { name: 'pt', type: 'point' },
  { name: 'flag', type: 'checkbox' },
  { name: 'virtualField', type: 'text', virtual: true },
  {
    name: 'grp',
    type: 'group',
    localized: true,
    flattenedFields: [
      { name: 'inner', type: 'text' },
      { name: 'innerNum', type: 'number' },
    ],
  },
  {
    name: 'plainGroup',
    type: 'group',
    flattenedFields: [
      { name: 'inner', type: 'text', localized: true },
      { name: 'deepJoin', type: 'join', collection: 'posts', on: 'x' },
    ],
  },
  {
    name: 'items',
    type: 'array',
    localized: true,
    flattenedFields: [
      { name: 'text', type: 'text' },
      { name: 'tags', type: 'text', hasMany: true },
    ],
  },
  {
    name: 'list',
    type: 'array',
    flattenedFields: [
      { name: 'label', type: 'text', localized: true },
      { name: 'sel', type: 'select', hasMany: true },
    ],
  },
  {
    name: 'anArrayFieldWithAVeryLongNameThatIsLongerThanSixtyThreeCharactersXYZ',
    type: 'array',
    dbName: 'long_arr',
    flattenedFields: [{ name: 'text', type: 'text' }],
  },
  { name: 'layout', type: 'blocks', blocks: [blockA, blockB] },
  { name: 'locLayout', type: 'blocks', localized: true, blocks: [blockA, blockB] },
  { name: 'polyOne', type: 'relationship', relationTo: ['posts', 'users'] },
  { name: 'polyMany', type: 'relationship', hasMany: true, relationTo: ['posts', 'users'] },
  { name: 'monoMany', type: 'relationship', hasMany: true, relationTo: 'posts' },
  { name: 'locMany', type: 'relationship', hasMany: true, localized: true, relationTo: 'posts' },
  { name: 'emptyMany', type: 'relationship', hasMany: true, localized: true, relationTo: 'posts' },
  { name: 'numRel', type: 'relationship', relationTo: 'numbered' },
  { name: 'upload', type: 'upload', relationTo: 'posts' },
  { name: 'texts', type: 'text', hasMany: true, localized: true },
  { name: 'missingTexts', type: 'text', hasMany: true, localized: true },
  { name: 'numbers', type: 'number', hasMany: true },
  { name: 'sels', type: 'select', hasMany: true, localized: true },
  { name: 'docs', type: 'join', collection: 'posts', on: 'x', defaultLimit: 2 },
  { name: 'polyDocs', type: 'join', collection: ['posts', 'users'], on: 'x' },
  { name: 'locDocs', type: 'join', localized: true, collection: 'posts', on: 'x' },
  { name: 'json', type: 'json' },
]

const adapterFor = (opts: { blocksAsJSON?: boolean; localized?: boolean }) => {
  const config = { localization: opts.localized === false ? false : localization }
  return {
    adapter: {
      blocksAsJSON: opts.blocksAsJSON ?? false,
      payload: {
        blocks: { blockA },
        collections: {
          numbered: { customIDType: 'number' },
          posts: { customIDType: undefined },
          users: { customIDType: 'text' },
        },
        config,
      },
      tableNameMap: new Map([
        [
          'docs_an_array_field_with_a_very_long_name_that_is_longer_than_sixty_three_characters_x_y_z',
          'long_arr',
        ],
        ['docs_blocks_block_a', 'docs_blocks_block_a'],
        ['docs_blocks_block_b', 'docs_blocks_block_b'],
        ['docs_items', 'docs_items'],
        ['docs_list', 'docs_list'],
      ]),
    },
    config,
  }
}

const baseRow = () => ({
  id: 7,
  num: '12.5abc',
  when: '2020-06-01T10:00:00',
  pt: '[1.5,-2]',
  flag: true,
  plainGroup_inner: 'raw-prefixed',
  plainGroup_deepJoin: '[{"id":1},{"id":2,"relationTo":"posts"}]',
  _locales: [
    { _locale: 'en', id: 1, _parentID: 7, title: 'Hello', grp_inner: 'g-en', grp_innerNum: '3' },
    { _locale: '1', id: 2, _parentID: 7, title: 'One', grp_inner: 'g-1', grp_innerNum: null },
    { _locale: 'es', id: 3, _parentID: 7, title: 'Hola' },
  ],
  items: [
    { _order: 2, _locale: 'es', _uuid: 'u2', _parentID: 7, text: 'b' },
    { _order: 1, _locale: 'en', _uuid: 'u1', _parentID: 7, text: 'a' },
    { _order: '3', _locale: 'en', id: 'x3', text: 'c' },
  ],
  list: [
    {
      _order: 1,
      id: 'l1',
      _locales: [
        { _locale: 'en', label: 'L-en' },
        { _locale: 'es', label: 'L-es' },
      ],
      sel: [
        { locale: null, value: 'a', order: 1 },
        { locale: null, value: 'b', order: 2 },
      ],
    },
    { _order: 2, id: 'l2', _locales: [], sel: [] },
  ],
  _long_arr: [{ _order: 1, id: 'la', text: 'long' }],
  _blocks_blockA: [
    { _order: 2, _path: 'layout', id: 'b2', text: 'second', _parentID: 7 },
    { _order: 1, _path: 'layout', _uuid: 'b1uuid', text: 'first' },
    { _order: 1, _path: 'locLayout', _locale: 'es', id: 'lb1', text: 'es-first' },
    { _order: 1, _path: 'locLayout', _locale: 'en', id: 'lb2', text: 'en-first' },
  ],
  _blocks_block_b_2: [
    { _order: 3, _path: 'layout', id: 'bb', when: '2019-02-30' },
    { _path: 'nowhere', id: 'orphan' },
  ],
  _rels: [
    { id: 1, order: 1, parent: 7, path: 'polyOne', locale: null, postsID: null, usersID: 5 },
    { id: 2, order: 1, parent: 7, path: 'polyMany', locale: null, postsID: 3, usersID: null },
    { id: 3, order: 2, parent: 7, path: 'polyMany', locale: null, postsID: null, usersID: 9 },
    { id: 4, order: 1, parent: 7, path: 'monoMany', locale: null, postsID: 11 },
    { id: 5, order: 2, parent: 7, path: 'monoMany', locale: null, postsID: null },
    { id: 6, order: 1, parent: 7, path: 'locMany', locale: 'es', postsID: 12 },
    { id: 7, order: 1, parent: 7, path: 'locMany', locale: '1', postsID: 13 },
    { id: 8, order: 1, parent: 7, path: 'layout.1.rel', locale: null, postsID: 14 },
  ],
  numRel: '42',
  upload: 'abc',
  _texts: [
    { order: 1, parent: 7, path: 'texts', locale: 'es', text: 'hola' },
    { order: 1, parent: 7, path: 'texts', locale: 'en', text: 'hi' },
    { order: 1, parent: 7, path: 'items.0.tags', locale: null, text: 'tag' },
  ],
  _numbers: [
    { order: 1, parent: 7, path: 'numbers', locale: null, number: '1.50' },
    { order: 2, parent: 7, path: 'numbers', locale: null, number: 2 },
    { order: 1, parent: 7, path: 'layout.0.nums', locale: null, number: '0x10' },
  ],
  sels: [
    { locale: 'es', value: 'x' },
    { locale: 'en', value: 'y' },
    { locale: 'es', value: 'z' },
  ],
  docs: '[{"id":1},{"id":2},{"id":3}]',
  docs_count: '17',
  polyDocs: [
    { id: 1, relationTo: 'posts' },
    { id: 'u', relationTo: 'users' },
  ],
  polyDocs_count: 'not-a-number',
  locDocs: [
    { id: 1, locale: 'en' },
    { id: 2, locale: 'es' },
    { id: 3, locale: 'en' },
  ],
  json: { a: [1, { b: null }], 2: 'two', 1: 'one' },
})

const run = (name: string, args: Record<string, unknown>) => {
  it(name, () => {
    try {
      transform(args as any)
    } catch {
      // the error is recorded in the fixture
    }
    expect(true).toBe(true)
  })
}

describe('synthetic drizzle read transform fixtures', () => {
  afterAll(() => {
    console.log(`[rs-read] synthetic: ${flushFixture('synthetic')} calls`)
  })

  const localized = adapterFor({})
  run('rich localized row', { ...localized, data: baseRow(), fields, tableName: 'docs' })
  run('join query count/limit', {
    ...localized,
    data: baseRow(),
    fields,
    joinQuery: {
      docs: { count: true, limit: 1 },
      locDocs: { count: true, limit: 1 },
      'plainGroup.deepJoin': { count: true, limit: 0 },
      polyDocs: { count: true, limit: 5 },
    },
    tableName: 'docs',
  })
  run('parent is localized', {
    ...localized,
    data: baseRow(),
    fields,
    parentIsLocalized: true,
    tableName: 'docs',
  })
  run('blocks as JSON', {
    ...adapterFor({ blocksAsJSON: true }),
    data: { ...baseRow(), layout: [{ blockType: 'blockA', text: 'json' }] },
    fields,
    tableName: 'docs',
  })
  run('no localization', {
    ...adapterFor({ localized: false }),
    data: baseRow(),
    fields,
    tableName: 'docs',
  })
  run('empty _locales row is filled from localeCodes', {
    ...localized,
    data: { id: 'e', _locales: [] },
    fields: fields.slice(0, 7),
    tableName: 'docs',
  })
  run('empty data', { ...localized, data: {}, fields, tableName: 'docs' })
  for (const when of [
    '2020-01-01T10:00:00.123456Z',
    '2020-01-01 10:00:00',
    '2020-01-01t10:00:00+05:30',
    '2020-1-1',
    '+002020-02-29',
    '2020-01-01T24:00:00Z',
    '1969-12-31T23:59:59.999Z',
    '2020-07-15T02:30:00',
  ]) {
    run(`date ${when}`, {
      ...localized,
      data: { id: 1, when },
      fields: [{ name: 'when', type: 'date' }],
      tableName: 'docs',
    })
  }
  run('invalid date throws RangeError', {
    ...localized,
    data: { id: 1, when: '2020-13-45' },
    fields: [{ name: 'when', type: 'date' }],
    tableName: 'docs',
  })
  run('count without join data throws TypeError', {
    ...localized,
    data: { id: 1, docs_count: 3 },
    fields: [{ name: 'docs', type: 'join', collection: 'posts', on: 'x' }],
    joinQuery: { docs: { count: true } },
    tableName: 'docs',
  })
  run('invalid point JSON throws SyntaxError', {
    ...localized,
    data: { id: 1, pt: '[1,' },
    fields: [{ name: 'pt', type: 'point' }],
    tableName: 'docs',
  })
  // Object.prototype keys in the internal maps (createPathMap / createBlocksMap / *ByLocale)
  const one = (field: Record<string, unknown>) => [field]
  run('rel path "constructor" throws in createPathMap', {
    ...localized,
    data: { id: 1, _rels: [{ id: 1, order: 1, parent: 1, path: 'constructor', locale: null, postsID: 2 }] },
    fields: one({ name: 'monoMany', type: 'relationship', hasMany: true, relationTo: 'posts' }),
    tableName: 'docs',
  })
  run('rel path "__proto__" throws in createPathMap', {
    ...localized,
    data: { id: 1, _rels: [{ id: 1, order: 1, parent: 1, path: '__proto__', locale: null, postsID: 2 }] },
    fields: one({ name: 'monoMany', type: 'relationship', hasMany: true, relationTo: 'posts' }),
    tableName: 'docs',
  })
  run('text path "toString" throws in createPathMap', {
    ...localized,
    data: { id: 1, _texts: [{ order: 1, parent: 1, path: 'toString', locale: null, text: 'x' }] },
    fields: one({ name: 'tags', type: 'text', hasMany: true }),
    tableName: 'docs',
  })
  run('block _path "constructor" throws in createBlocksMap', {
    ...localized,
    data: { id: 1, _blocks_blockA: [{ _order: 1, _path: 'constructor', id: 'b', text: 't' }] },
    fields: one({ name: 'layout', type: 'blocks', blocks: [blockA] }),
    tableName: 'docs',
  })
  run('hasMany relationship field "constructor" finds the inherited function', {
    ...localized,
    data: { id: 1 },
    fields: one({ name: 'constructor', type: 'relationship', hasMany: true, relationTo: 'posts' }),
    tableName: 'docs',
  })
  run('hasOne polymorphic field "toString" without rels', {
    ...localized,
    data: { id: 1 },
    fields: one({ name: 'toString', type: 'relationship', relationTo: ['posts', 'users'] }),
    tableName: 'docs',
  })
  run('hasMany text field "valueOf" without texts', {
    ...localized,
    data: { id: 1 },
    fields: one({ name: 'valueOf', type: 'text', hasMany: true }),
    tableName: 'docs',
  })
  run('hasMany number field "hasOwnProperty" without numbers (localized)', {
    ...localized,
    data: { id: 1 },
    fields: one({ name: 'hasOwnProperty', type: 'number', hasMany: true, localized: true }),
    tableName: 'docs',
  })
  run('missing columns named like Object.prototype members', {
    ...localized,
    data: { id: 1 },
    fields: [
      { name: 'constructor', type: 'text' },
      { name: 'toLocaleString', type: 'number' },
      { name: '__proto__', type: 'json' },
    ],
    tableName: 'docs',
  })
  run('localized rel with locale "constructor"', {
    ...localized,
    data: { id: 1, _rels: [{ id: 1, order: 1, parent: 1, path: 'locMany', locale: 'constructor', postsID: 2 }] },
    fields: one({ name: 'locMany', type: 'relationship', hasMany: true, localized: true, relationTo: 'posts' }),
    tableName: 'docs',
  })
  run('localized select with locale "toString"', {
    ...localized,
    data: { id: 1, sels: [{ locale: 'toString', value: 'x' }] },
    fields: one({ name: 'sels', type: 'select', hasMany: true, localized: true }),
    tableName: 'docs',
  })
  run('localized join with locale "constructor"', {
    ...localized,
    data: { id: 1, locDocs: [{ id: 1, locale: 'constructor' }] },
    fields: one({ name: 'locDocs', type: 'join', localized: true, collection: 'posts', on: 'x' }),
    tableName: 'docs',
  })
  run('localized array row with _locale "__proto__"', {
    ...localized,
    data: { id: 1, items: [{ _order: 1, _locale: '__proto__', id: 'i', text: 'x' }] },
    fields: one(fields.find((f) => f.name === 'items')),
    tableName: 'docs',
  })
  run('localized block row with _locale "valueOf"', {
    ...localized,
    data: { id: 1, _blocks_blockA: [{ _order: 1, _path: 'locLayout', _locale: 'valueOf', id: 'b', text: 'x' }] },
    fields: one(fields.find((f) => f.name === 'locLayout')),
    tableName: 'docs',
  })
  const constructorBlock = { slug: 'constructor', flattenedFields: [{ name: 'text', type: 'text' }] }
  run('field block with slug "constructor" resolves to the inherited payload.blocks member', {
    ...localized,
    data: { id: 1, _blocks_constructor: [{ _order: 1, _path: 'layout', id: 'b', text: 'x' }] },
    fields: one({ name: 'layout', type: 'blocks', blocks: [constructorBlock] }),
    tableName: 'docs',
  })
  run('relationTo "constructor" reads customIDType of the inherited function', {
    ...localized,
    data: { id: 1, rel: '5' },
    fields: one({ name: 'rel', type: 'relationship', relationTo: 'constructor' }),
    tableName: 'docs',
  })
  // own `__proto__` properties (JSON.parse / computed keys) and the `__proto__` setter on results
  run('own __proto__ keys', {
    ...localized,
    data: {
      id: 1,
      ['__proto__']: 'own-column',
      json: JSON.parse('{"__proto__":{"x":1},"a":2}'),
      _locales: [{ _locale: 'en', ['__proto__']: 'loc', title: 'T' }],
    },
    fields: [
      { name: '__proto__', type: 'text' },
      { name: 'json', type: 'json' },
      { name: 'title', type: 'text', localized: true },
    ],
    tableName: 'docs',
  })
  run('__proto__ field with an object value replaces the result prototype', {
    ...localized,
    data: { id: 1, ['__proto__']: { inherited: true }, other: 'x' },
    fields: [
      { name: '__proto__', type: 'json' },
      { name: 'other', type: 'text' },
    ],
    tableName: 'docs',
  })
  // lone UTF-16 surrogates in values, keys, JSON strings, numbers and dates
  run('lone surrogates', {
    ...localized,
    data: {
      id: 1,
      text: 'truncated \ud83d',
      json: { 'k\udc00': 'v\ud800', pair: '\ud83d\ude00' },
      pt: '["\ud800", "\\udc01"]',
      num: '12\ud800',
      _locales: [
        { _locale: 'e\ud800', title: 'surrogate locale' },
        { _locale: 'en', title: '\udfff' },
      ],
      _rels: [{ id: 1, order: 1, parent: 1, path: 'polyMany\ud800', locale: null, postsID: 3 }],
      docs: '[{"id":"\\ud800"},{"id":2}]',
    },
    fields: [
      { name: 'text', type: 'text' },
      { name: 'json', type: 'json' },
      { name: 'pt', type: 'point' },
      { name: 'num', type: 'number' },
      { name: 'title', type: 'text', localized: true },
      { name: 'polyMany', type: 'relationship', hasMany: true, relationTo: ['posts', 'users'] },
      { name: 'docs', type: 'join', collection: 'posts', on: 'x' },
    ],
    tableName: 'docs',
  })
  run('date with a lone surrogate throws RangeError', {
    ...localized,
    data: { id: 1, when: '2020-01-01\ud800' },
    fields: [{ name: 'when', type: 'date' }],
    tableName: 'docs',
  })
  run('relationship to unknown collection throws TypeError', {
    ...localized,
    data: { id: 1, rel: 5 },
    fields: [{ name: 'rel', type: 'relationship', relationTo: 'missing' }],
    tableName: 'docs',
  })
})
