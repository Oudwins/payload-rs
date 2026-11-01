/**
 * Rust-port parity suite: records FULL normalised outputs of the Local API
 * (and raw DB rows / schema) for every field type × localization × versions ×
 * where operators × sort × select × depth/populate × joins × pagination, and
 * asserts strict equality (incl. key order, undefined vs missing) against
 * golden files in ./golden.
 *
 *   PAYLOAD_RS_UPDATE_GOLDEN=1 SQLITE_URL=file:/tmp/rs-parity.db pnpm test:int:sqlite test/__rs/harness/parity.int.spec.ts
 *
 * Steps run in order and share state (resetBetweenTests: false). Date is faked
 * and advanced 1s per write so timestamps and default sorts are deterministic.
 */
import type { Payload, Where } from 'payload'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, vi } from 'vitest'

import { test } from '../../__helpers/int/vitest.js'
import { mediaDir } from './config.js'
import { capture, createGoldenStore, createNormaliser, dumpRows, dumpSchema } from './golden.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const golden = createGoldenStore(path.join(dirname, 'golden'))
const normalise = createNormaliser()

let now = Date.parse('2025-01-01T00:00:00.000Z')
const tick = () => {
  now += 1000
  vi.setSystemTime(now)
}

const ids: Record<string, Array<number | string>> = {}
const id = (collection: string, index: number) => ids[collection]![index]!

type Ctx = { payload: Payload; tick: typeof tick }
const step = (section: string, name: string, fn: (ctx: Ctx) => Promise<unknown> | unknown) =>
  test(`${section} > ${name}`, async ({ payload }) => {
    tick()
    golden.check(section, name, await capture(normalise, () => fn({ payload, tick })))
  })

const richText = (text: string) => ({
  root: {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'text', detail: 0, format: 0, mode: 'normal', style: '', text, version: 1 },
        ],
        direction: 'ltr',
        format: '',
        indent: 0,
        textFormat: 0,
        version: 1,
      },
    ],
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  },
})

/** Seed data for kitchen documents; index i varies values (incl. nulls and ties). */
const kitchenData = (i: number) => {
  const t = (n: number) => id('targets', n % 3)
  const m = (n: number) => id('media', n % 2)
  if (i === 5) {
    // sparse document: only a title, everything else empty
    return { text: 'sparse' }
  }
  return {
    array: [
      {
        localizedText: `arr-loc-${i}`,
        nestedArray: [{ text: `nested-${i}-a` }, { text: `nested-${i}-b` }],
        number: i * 10,
        rel: t(i),
        text: `arr-${i}-0`,
      },
      { nestedArray: [], number: i * 10 + 1, text: `arr-${i}-1` },
    ],
    blocks: [
      {
        blockType: 'blockA',
        nestedBlocks: [{ blockType: 'blockC', text: `deep-${i}` }],
        number: i,
        text: `blockA-${i}`,
      },
      {
        array: [{ text: `barr-${i}` }],
        blockType: 'blockB',
        select: ['x', 'y', 'z'][i % 3],
        text: `blockB-${i}`,
      },
    ],
    checkbox: i % 2 === 0,
    code: `const x = ${i}`,
    collapsibleText: `collapsible-${i}`,
    date: new Date(Date.UTC(2024, i, 10 + i)).toISOString(),
    email: `user${i}@example.com`,
    group: {
      groupArray: [{ text: `garr-${i}` }],
      localizedText: `group-loc-${i}`,
      nestedGroup: { text: `ng-${i}` },
      number: 100 - i,
      text: `group-${i % 3}`,
    },
    json: { flag: i % 2 === 0, list: [i, i + 1], name: `json-${i}`, nested: { deep: `d${i}` } },
    number: [5, 3, 5, 1, 9][i],
    numberMany: [i, i + 1, 42],
    point: [i, -i] as [number, number],
    poly:
      i % 2 === 0 ? { relationTo: 'targets', value: t(i) } : { relationTo: 'media', value: m(i) },
    polyMany: [
      { relationTo: 'targets', value: t(i + 1) },
      { relationTo: 'media', value: m(i) },
    ],
    radio: ['a', 'b', 'c'][i % 3],
    rel: t(i),
    relMany: [t(i), t(i + 1)],
    richText: richText(`hello world ${i}`),
    rowText: `row-${i}`,
    select: ['one', 'two', 'three'][i % 3],
    selectMany: [['red'], ['red', 'green'], ['blue'], ['green', 'blue'], []][i],
    tabNamed: { number: i * 2, text: `tab-${i}` },
    tabText: `tabText-${i}`,
    text: ['alpha', 'beta', 'gamma', 'beta', 'delta'][i],
    textarea: `line one ${i}\nline two`,
    textMany: [`tm-${i}`, 'shared'],
    upload: m(i),
    uploadMany: [m(i), m(i + 1)],
  }
}

test.suite('RS parity', { config: './config.ts', cron: false, resetBetweenTests: false }, () => {
  beforeAll(() => {
    fs.rmSync(mediaDir, { force: true, recursive: true })
    vi.useFakeTimers({ now, toFake: ['Date'] })
  })

  afterAll(() => {
    vi.useRealTimers()
    golden.write()
  })

  // ---------------------------------------------------------------- seed
  step('seed', 'schema', () => dumpSchema())

  step('seed', 'targets', async ({ payload, tick }) => {
    const out = []
    for (let i = 0; i < 3; i++) {
      tick()
      const doc = await payload.create({
        collection: 'targets',
        data: { localizedTitle: `target-en-${i}`, number: i * 3, title: `target-${i}` },
      })
      tick()
      await payload.update({
        id: doc.id,
        collection: 'targets',
        data: { localizedTitle: `target-es-${i}` },
        locale: 'es',
      })
      out.push(doc)
    }
    ids.targets = out.map((d) => d.id)
    return out
  })

  step('seed', 'media', async ({ payload, tick }) => {
    const out = []
    for (let i = 0; i < 2; i++) {
      tick()
      const data = Buffer.from(`file contents ${i}`)
      out.push(
        await payload.create({
          collection: 'media',
          data: { alt: `alt-${i}` },
          file: { name: `file-${i}.txt`, data, mimetype: 'text/plain', size: data.length },
        }),
      )
    }
    ids.media = out.map((d) => d.id)
    return out
  })

  step('seed', 'kitchen', async ({ payload, tick }) => {
    const out = []
    for (let i = 0; i < 6; i++) {
      tick()
      out.push(
        await payload.create({ collection: 'kitchen', data: kitchenData(i) as any, depth: 0 }),
      )
    }
    ids.kitchen = out.map((d) => d.id)
    return out
  })

  step('seed', 'kitchen-localized', async ({ payload, tick }) => {
    const out = []
    for (let i = 0; i < 3; i++) {
      tick()
      const doc = await payload.create({
        collection: 'kitchen-localized',
        data: kitchenData(i) as any,
        depth: 0,
        locale: 'en',
      })
      tick()
      const es = await payload.update({
        id: doc.id,
        collection: 'kitchen-localized',
        data: {
          array: [{ number: i, text: `es-arr-${i}` }],
          blocks: [{ blockType: 'blockA', text: `es-block-${i}` }],
          group: { text: `es-group-${i}` },
          number: 10 - i,
          select: 'three',
          selectMany: ['blue'],
          tabNamed: { text: `es-tab-${i}` },
          text: `es-text-${i}`,
          textMany: [`es-${i}`],
        } as any,
        depth: 0,
        locale: 'es',
      })
      out.push({ en: doc, es })
    }
    ids['kitchen-localized'] = out.map((d) => d.en.id)
    return out
  })

  step('seed', 'custom-ids', async ({ payload, tick }) => {
    const out = []
    for (const key of ['b-key', 'a-key', 'c-key']) {
      tick()
      out.push(
        await payload.create({
          collection: 'custom-ids',
          data: { id: key, title: `title ${key}` },
        }),
      )
    }
    return out
  })

  step('seed', 'rows', () => dumpRows())

  // ---------------------------------------------------------------- read
  const read = (name: string, fn: (p: Payload) => Promise<unknown>) =>
    step('read', name, ({ payload }) => fn(payload))

  read('find kitchen default', (p) => p.find({ collection: 'kitchen' }))
  read('find kitchen depth 0', (p) => p.find({ collection: 'kitchen', depth: 0 }))
  read('find kitchen depth 2', (p) => p.find({ collection: 'kitchen', depth: 2, limit: 2 }))
  read('findByID kitchen depth 0', (p) =>
    p.findByID({ id: id('kitchen', 0), collection: 'kitchen', depth: 0 }),
  )
  read('findByID kitchen depth 1', (p) =>
    p.findByID({ id: id('kitchen', 1), collection: 'kitchen', depth: 1 }),
  )
  read('findByID kitchen sparse', (p) =>
    p.findByID({ id: id('kitchen', 5), collection: 'kitchen' }),
  )
  read('findByID missing', (p) => p.findByID({ id: 999999, collection: 'kitchen' }))
  read('findByID missing disableErrors', (p) =>
    p.findByID({ id: 999999, collection: 'kitchen', disableErrors: true }),
  )
  read('find localized en', (p) =>
    p.find({ collection: 'kitchen-localized', depth: 0, locale: 'en' }),
  )
  read('find localized es', (p) =>
    p.find({ collection: 'kitchen-localized', depth: 0, locale: 'es' }),
  )
  read('find localized de fallback', (p) =>
    p.find({ collection: 'kitchen-localized', depth: 0, locale: 'de' }),
  )
  read('find localized de no fallback', (p) =>
    p.find({ collection: 'kitchen-localized', depth: 0, fallbackLocale: false, locale: 'de' }),
  )
  read('find localized all', (p) =>
    p.find({ collection: 'kitchen-localized', depth: 0, locale: 'all' }),
  )
  read('find kitchen locale all (nested localized)', (p) =>
    p.find({ collection: 'kitchen', depth: 0, limit: 2, locale: 'all' }),
  )
  read('find targets with joins', (p) => p.find({ collection: 'targets', depth: 1 }))
  read('find targets joins options', (p) =>
    p.find({
      collection: 'targets',
      depth: 0,
      joins: {
        kitchenArrayRefs: false,
        kitchenRefs: { limit: 1, sort: '-number', where: { checkbox: { equals: true } } },
        localizedRefs: { count: true },
      },
    }),
  )
  read('find targets joins false', (p) => p.find({ collection: 'targets', joins: false }))
  read('find targets locale es', (p) => p.find({ collection: 'targets', depth: 0, locale: 'es' }))
  read('find media', (p) => p.find({ collection: 'media' }))
  read('find custom ids', (p) => p.find({ collection: 'custom-ids', sort: 'id' }))
  read('findByID custom id', (p) => p.findByID({ id: 'a-key', collection: 'custom-ids' }))
  read('count kitchen', (p) => p.count({ collection: 'kitchen' }))
  read('count kitchen where', (p) =>
    p.count({ collection: 'kitchen', where: { number: { equals: 5 } } }),
  )
  read('populate targets title', (p) =>
    p.find({ collection: 'kitchen', depth: 1, limit: 2, populate: { targets: { title: true } } }),
  )

  // ---------------------------------------------------------------- where
  const where: Array<[string, Where]> = []
  const op = (path: string, operator: string, value: unknown) =>
    where.push([`${path} ${operator} ${JSON.stringify(value)}`, { [path]: { [operator]: value } }])

  const scalar: Array<[string, unknown, unknown]> = [
    // path, equal-value, comparable-value
    ['text', 'beta', 'beta'],
    ['textarea', 'line one 1\nline two', 'line'],
    ['email', 'user2@example.com', 'user2'],
    ['code', 'const x = 3', 'const'],
    ['number', 5, 3],
    ['date', new Date(Date.UTC(2024, 1, 11)).toISOString(), '2024-03-01T00:00:00.000Z'],
    ['radio', 'b', 'a'],
    ['select', 'two', 'one'],
    ['group.text', 'group-1', 'group-0'],
    ['group.number', 99, 98],
    ['group.nestedGroup.text', 'ng-2', 'ng'],
    ['group.localizedText', 'group-loc-1', 'group-loc'],
    ['tabNamed.text', 'tab-3', 'tab'],
    ['tabNamed.number', 4, 4],
    ['tabText', 'tabText-1', 'tabText'],
    ['rowText', 'row-2', 'row'],
    ['collapsibleText', 'collapsible-0', 'coll'],
    ['id', 'ID1', 'ID3'],
    ['createdAt', 'CREATED2', 'CREATED2'],
  ]
  for (const [p, eq, cmp] of scalar) {
    for (const [operator, value] of [
      ['equals', eq],
      ['not_equals', eq],
      ['in', [eq, cmp]],
      ['not_in', [eq]],
      ['exists', true],
      ['exists', false],
      ['greater_than', cmp],
      ['greater_than_equal', cmp],
      ['less_than', cmp],
      ['less_than_equal', cmp],
      ['like', cmp],
      ['contains', cmp],
    ] as const) {
      op(p, operator, value)
    }
  }
  for (const [operator, value] of [
    ['equals', true],
    ['equals', false],
    ['not_equals', true],
    ['exists', false],
  ] as const) {
    op('checkbox', operator, value)
  }
  for (const p of ['selectMany', 'textMany', 'numberMany']) {
    const values = {
      numberMany: [42, 3],
      selectMany: ['red', 'blue'],
      textMany: ['shared', 'tm-1'],
    }[p]!
    op(p, 'equals', values[0])
    op(p, 'not_equals', values[0])
    op(p, 'in', values)
    op(p, 'not_in', values)
    op(p, 'all', values)
    op(p, 'contains', values[0])
    op(p, 'exists', true)
    op(p, 'exists', false)
  }
  op('numberMany', 'greater_than', 4)
  op('numberMany', 'less_than_equal', 1)
  op('json.name', 'equals', 'json-2')
  op('json.nested.deep', 'equals', 'd3')
  op('json.flag', 'equals', true)
  op('json.name', 'like', 'json')
  op('json.name', 'in', ['json-0', 'json-4'])
  op('json.name', 'exists', true)
  op('json', 'exists', false)
  op('point', 'near', '1,-1,10000,0')
  op('point', 'within', {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [3, 0],
        [3, -3],
        [0, -3],
        [0, 0],
      ],
    ],
  })
  op('point', 'intersects', { type: 'Point', coordinates: [1, -1] })
  op('point', 'exists', false)
  op('richText', 'like', 'world 2')
  op('richText', 'exists', true)
  for (const p of ['rel', 'upload']) {
    op(p, 'equals', 'REL0')
    op(p, 'not_equals', 'REL0')
    op(p, 'in', ['REL0', 'REL1'])
    op(p, 'not_in', ['REL0'])
    op(p, 'exists', false)
  }
  op('rel.title', 'equals', 'target-1')
  op('rel.number', 'greater_than', 2)
  op('rel.localizedTitle', 'like', 'target-en')
  op('upload.alt', 'equals', 'alt-1')
  op('relMany', 'in', ['REL1'])
  op('relMany', 'not_in', ['REL1'])
  op('relMany', 'all', ['REL0', 'REL1'])
  op('relMany', 'equals', 'REL2')
  op('relMany', 'exists', false)
  op('relMany.title', 'like', 'target-2')
  op('uploadMany', 'in', ['REL1'])
  op('poly.relationTo', 'equals', 'media')
  op('poly.value', 'equals', 'REL1')
  op('poly', 'equals', { relationTo: 'targets', value: 'REL0' })
  op('poly', 'exists', false)
  op('polyMany.relationTo', 'in', ['targets'])
  op('polyMany.value', 'in', ['REL2'])
  op('array.text', 'equals', 'arr-2-1')
  op('array.text', 'like', 'arr-3')
  op('array.number', 'greater_than', 25)
  op('array.rel', 'equals', 'REL1')
  op('array.localizedText', 'equals', 'arr-loc-0')
  op('array.nestedArray.text', 'like', 'nested-4')
  op('array', 'exists', false)
  op('array', 'exists', true)
  op('blocks.text', 'like', 'blockB')
  op('blocks.blockType', 'equals', 'blockA')
  op('blocks.number', 'less_than', 2)
  op('blocks.select', 'equals', 'y')
  op('blocks.nestedBlocks.text', 'equals', 'deep-3')
  op('blocks.array.text', 'equals', 'barr-1')
  op('group.groupArray.text', 'equals', 'garr-4')
  op('doesNotExist', 'equals', 1)
  op('text', 'unknownOperator', 1)
  where.push(['and', { and: [{ number: { equals: 5 } }, { checkbox: { equals: true } }] }])
  where.push(['or', { or: [{ text: { equals: 'alpha' } }, { number: { less_than: 2 } }] }])
  where.push([
    'nested and/or',
    {
      and: [
        { or: [{ select: { equals: 'one' } }, { select: { equals: 'two' } }] },
        { or: [{ 'rel.title': { equals: 'target-0' } }, { 'array.number': { greater_than: 30 } }] },
      ],
    },
  ])
  where.push(['implicit and', { checkbox: { equals: false }, number: { greater_than: 1 } }])
  where.push(['empty where', {}])
  where.push(['multiple operators one field', { number: { greater_than: 1, less_than: 9 } }])

  /** Replaces symbolic placeholders by seeded ids / timestamps. */
  const resolve = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const rel = /^REL(\d)$/.exec(value)
      if (rel) {
        return id('targets', Number(rel[1]))
      }
      const kid = /^ID(\d)$/.exec(value)
      if (kid) {
        return id('kitchen', Number(kid[1]))
      }
      if (value === 'CREATED2') {
        return '2025-01-01T00:00:15.000Z'
      }
      return value
    }
    if (Array.isArray(value)) {
      return value.map(resolve)
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]))
    }
    return value
  }

  for (const [name, w] of where) {
    step('where', `kitchen ${name}`, ({ payload }) =>
      payload.find({ collection: 'kitchen', depth: 0, sort: 'id', where: resolve(w) as Where }),
    )
  }

  const localizedWhere: Array<[string, Where, string]> = [
    ['text equals en', { text: { equals: 'beta' } }, 'en'],
    ['text equals es', { text: { equals: 'es-text-1' } }, 'es'],
    ['text like es', { text: { like: 'es-text' } }, 'es'],
    ['text exists de', { text: { exists: true } }, 'de'],
    ['number gt es', { number: { greater_than: 8 } }, 'es'],
    ['array.text es', { 'array.text': { equals: 'es-arr-2' } }, 'es'],
    ['blocks.text es', { 'blocks.text': { like: 'es-block' } }, 'es'],
    ['group.text es', { 'group.text': { equals: 'es-group-0' } }, 'es'],
    ['selectMany in es', { selectMany: { in: ['blue'] } }, 'es'],
    ['textMany contains es', { textMany: { contains: 'es-2' } }, 'es'],
    ['text.es path from en', { 'text.es': { equals: 'es-text-0' } }, 'en'],
    ['locale all where', { text: { equals: 'alpha' } }, 'all'],
  ]
  for (const [name, w, locale] of localizedWhere) {
    step('where', `localized ${name}`, ({ payload }) =>
      payload.find({
        collection: 'kitchen-localized',
        depth: 0,
        locale: locale as 'en',
        sort: 'id',
        where: w,
      }),
    )
  }

  // ---------------------------------------------------------------- sort
  const sorts: Array<string | string[]> = [
    'text',
    '-text',
    'number',
    '-number',
    ['number', '-text'],
    ['checkbox', '-number'],
    'date',
    '-date',
    'select',
    'radio',
    'group.text',
    '-group.number',
    'group.nestedGroup.text',
    'tabNamed.number',
    'tabText',
    'rel.title',
    '-rel.number',
    'array.number',
    '-createdAt',
    'updatedAt',
    '-id',
    'json.name',
    'doesNotExist',
  ]
  for (const sort of sorts) {
    step('sort', `kitchen ${JSON.stringify(sort)}`, ({ payload }) =>
      payload.find({ collection: 'kitchen', depth: 0, sort }),
    )
  }
  for (const [sort, locale] of [
    ['text', 'en'],
    ['text', 'es'],
    ['-number', 'es'],
    ['group.text', 'es'],
    ['text', 'de'],
  ] as const) {
    step('sort', `localized ${sort} ${locale}`, ({ payload }) =>
      payload.find({ collection: 'kitchen-localized', depth: 0, locale, sort }),
    )
  }
  step('sort', 'targets localizedTitle es', ({ payload }) =>
    payload.find({ collection: 'targets', depth: 0, locale: 'es', sort: '-localizedTitle' }),
  )

  // ---------------------------------------------------------------- select
  const selects: Record<string, Record<string, unknown>> = {
    'text only': { text: true },
    'group subfield': { group: { nestedGroup: { text: true }, text: true } },
    'array subfield': { array: { nestedArray: true, text: true } },
    'blocks by type': { blocks: { blockA: { text: true } } },
    'exclude heavy': { json: false, richText: false, blocks: false, array: false },
    'tabs and rows': { rowText: true, tabNamed: { number: true }, tabText: true },
    relationships: { poly: true, polyMany: true, rel: true, relMany: true, upload: true },
    'id only': { id: true },
  }
  for (const [name, select] of Object.entries(selects)) {
    step('select', `kitchen ${name}`, ({ payload }) =>
      payload.find({ collection: 'kitchen', depth: 1, limit: 3, select: select as any }),
    )
  }
  step('select', 'findByID select localized all', ({ payload }) =>
    payload.findByID({
      id: id('kitchen-localized', 0),
      collection: 'kitchen-localized',
      locale: 'all',
      select: { array: true, text: true },
    }),
  )
  step('select', 'targets join select', ({ payload }) =>
    payload.find({ collection: 'targets', depth: 1, select: { kitchenRefs: true, title: true } }),
  )

  // ---------------------------------------------------------------- pagination
  for (const [name, args] of [
    ['limit 2 page 1', { limit: 2, page: 1 }],
    ['limit 2 page 2', { limit: 2, page: 2 }],
    ['limit 2 page 3', { limit: 2, page: 3 }],
    ['limit 2 page 9', { limit: 2, page: 9 }],
    ['limit 0', { limit: 0 }],
    ['pagination false', { limit: 2, pagination: false }],
    ['limit 4 sorted', { limit: 4, page: 2, sort: '-number' }],
  ] as const) {
    step('pagination', name, ({ payload }) =>
      payload.find({ collection: 'kitchen', depth: 0, ...args }),
    )
  }

  // ---------------------------------------------------------------- distinct
  for (const [name, args] of [
    ['text', { field: 'text' }],
    ['text sorted desc', { field: 'text', sort: '-text' }],
    ['number', { field: 'number', sort: 'number' }],
    ['select where', { field: 'select', where: { checkbox: { equals: true } } }],
    ['rel depth 0', { depth: 0, field: 'rel' }],
    ['rel depth 1', { depth: 1, field: 'rel' }],
    ['group.text', { field: 'group.text' }],
    ['rel.title', { field: 'rel.title' }],
    ['paginated', { field: 'text', limit: 2, page: 2, sort: 'text' }],
  ] as const) {
    step('distinct', name, ({ payload }) =>
      payload.findDistinct({ collection: 'kitchen', ...(args as any) }),
    )
  }
  step('distinct', 'localized text es', ({ payload }) =>
    payload.findDistinct({ collection: 'kitchen-localized', field: 'text', locale: 'es' }),
  )

  // ---------------------------------------------------------------- update
  step('update', 'updateByID scalars + containers', ({ payload }) =>
    payload.update({
      id: id('kitchen', 0),
      collection: 'kitchen',
      data: {
        array: [{ nestedArray: [{ text: 'replaced' }], text: 'only-row' }],
        blocks: [{ blockType: 'blockB', select: 'z', text: 'swapped' }],
        checkbox: false,
        group: { nestedGroup: { text: 'ng-updated' } },
        json: { replaced: true },
        number: 77,
        numberMany: [1],
        poly: { relationTo: 'targets', value: id('targets', 2) },
        relMany: [],
        selectMany: ['green'],
        text: 'alpha-updated',
        textMany: [],
      } as any,
      depth: 0,
    }),
  )
  step('update', 'updateByID set nulls', ({ payload }) =>
    payload.update({
      id: id('kitchen', 1),
      collection: 'kitchen',
      data: { date: null, email: null, group: null, number: null, rel: null, upload: null } as any,
      depth: 0,
    }),
  )
  step('update', 'updateByID reorder array (keep ids)', async ({ payload }) => {
    const doc = await payload.findByID({ id: id('kitchen', 2), collection: 'kitchen', depth: 0 })
    return payload.update({
      id: doc.id,
      collection: 'kitchen',
      data: { array: [...(doc.array ?? [])].reverse(), blocks: [...(doc.blocks ?? [])].reverse() },
      depth: 0,
    })
  })
  step('update', 'updateMany where', ({ payload }) =>
    payload.update({
      collection: 'kitchen',
      data: { tabText: 'bulk' },
      depth: 0,
      where: { number: { greater_than_equal: 5 } },
    }),
  )
  step('update', 'update localized es', ({ payload }) =>
    payload.update({
      id: id('kitchen-localized', 1),
      collection: 'kitchen-localized',
      data: { group: { text: 'es-group-new' }, text: 'es-updated' } as any,
      depth: 0,
      locale: 'es',
    }),
  )
  step('update', 'update localized de (new locale)', ({ payload }) =>
    payload.update({
      id: id('kitchen-localized', 1),
      collection: 'kitchen-localized',
      data: { array: [{ text: 'de-row' }], number: 1, text: 'de-text' } as any,
      depth: 0,
      locale: 'de',
    }),
  )
  step('update', 'localized all after updates', ({ payload }) =>
    payload.findByID({
      id: id('kitchen-localized', 1),
      collection: 'kitchen-localized',
      depth: 0,
      locale: 'all',
    }),
  )
  step('update', 'custom id update', ({ payload }) =>
    payload.update({ id: 'b-key', collection: 'custom-ids', data: { title: 'updated b' } }),
  )
  step('update', 'duplicate kitchen', ({ payload }) =>
    payload.duplicate({ id: id('kitchen', 3), collection: 'kitchen', depth: 0 }),
  )
  step('update', 'validation error', ({ payload }) =>
    payload.update({
      id: id('kitchen', 3),
      collection: 'kitchen',
      data: { email: 'not-an-email' },
    }),
  )
  step('update', 'rows', () => dumpRows())

  // ---------------------------------------------------------------- versions
  step('versions', 'drafts lifecycle', async ({ payload, tick }) => {
    const out: Record<string, unknown> = {}
    out.create = await payload.create({
      collection: 'drafts',
      data: {
        array: [{ text: 'v1' }],
        localizedTitle: 'v1-en',
        rel: id('targets', 0),
        title: 'v1',
      },
    })
    const docID = (out.create as { id: number }).id
    ids.drafts = [docID]
    tick()
    out.draft1 = await payload.update({
      id: docID,
      collection: 'drafts',
      data: { title: 'draft-1' },
      draft: true,
    })
    tick()
    out.autosave1 = await payload.update({
      id: docID,
      autosave: true,
      collection: 'drafts',
      data: { title: 'autosave-1' },
      draft: true,
    })
    tick()
    out.autosave2 = await payload.update({
      id: docID,
      autosave: true,
      collection: 'drafts',
      data: { title: 'autosave-2' },
      draft: true,
    })
    tick()
    out.draftEs = await payload.update({
      id: docID,
      collection: 'drafts',
      data: { localizedTitle: 'draft-es' },
      draft: true,
      locale: 'es',
    })
    tick()
    out.publishedRead = await payload.findByID({ id: docID, collection: 'drafts' })
    out.draftRead = await payload.findByID({ id: docID, collection: 'drafts', draft: true })
    out.queryDrafts = await payload.find({ collection: 'drafts', draft: true })
    out.queryDraftsWhere = await payload.find({
      collection: 'drafts',
      draft: true,
      where: { title: { like: 'autosave' } },
    })
    out.publishedWhere = await payload.find({
      collection: 'drafts',
      where: { title: { like: 'autosave' } },
    })
    tick()
    out.publish = await payload.update({
      id: docID,
      collection: 'drafts',
      data: { _status: 'published', title: 'published-2' },
    })
    return out
  })
  step('versions', 'findVersions', ({ payload }) =>
    payload.findVersions({ collection: 'drafts', sort: '-updatedAt' }),
  )
  step('versions', 'findVersions where latest', ({ payload }) =>
    payload.findVersions({ collection: 'drafts', where: { latest: { equals: true } } }),
  )
  step('versions', 'findVersions where version.title', ({ payload }) =>
    payload.findVersions({
      collection: 'drafts',
      where: { 'version.title': { like: 'autosave' } },
    }),
  )
  step('versions', 'countVersions', ({ payload }) =>
    payload.countVersions({ collection: 'drafts' }),
  )
  step('versions', 'findVersionByID + restore', async ({ payload, tick }) => {
    const { docs } = await payload.findVersions({ collection: 'drafts', sort: 'updatedAt' })
    const first = docs[0]!
    const byID = await payload.findVersionByID({ id: first.id, collection: 'drafts' })
    tick()
    const restored = await payload.restoreVersion({ id: first.id, collection: 'drafts' })
    const after = await payload.findByID({ id: id('drafts', 0), collection: 'drafts' })
    return { after, byID, restored }
  })
  step('versions', 'maxPerDoc enforcement', async ({ payload, tick }) => {
    for (let i = 0; i < 6; i++) {
      tick()
      await payload.update({
        id: id('drafts', 0),
        collection: 'drafts',
        data: { title: `bulk-${i}` },
        draft: true,
      })
    }
    return payload.findVersions({ collection: 'drafts', limit: 20, sort: '-updatedAt' })
  })
  step('versions', 'versioned (no drafts) collection', async ({ payload, tick }) => {
    const doc = await payload.create({
      collection: 'versioned',
      data: { localizedTitle: 'en', title: 'v1' },
    })
    tick()
    await payload.update({ id: doc.id, collection: 'versioned', data: { title: 'v2' } })
    tick()
    await payload.update({
      id: doc.id,
      collection: 'versioned',
      data: { localizedTitle: 'es' },
      locale: 'es',
    })
    return {
      doc: await payload.findByID({ id: doc.id, collection: 'versioned', locale: 'all' }),
      versions: await payload.findVersions({
        collection: 'versioned',
        locale: 'all',
        sort: 'createdAt',
      }),
    }
  })

  // ---------------------------------------------------------------- globals
  step('globals', 'site lifecycle', async ({ payload, tick }) => {
    const out: Record<string, unknown> = {}
    out.initial = await payload.findGlobal({ slug: 'site' })
    tick()
    out.update = await payload.updateGlobal({
      slug: 'site',
      data: { array: [{ text: 'g1' }], number: 1, rel: id('targets', 1), title: 'site-1' },
    })
    tick()
    out.draft = await payload.updateGlobal({
      slug: 'site',
      data: { title: 'site-draft' },
      draft: true,
    })
    out.published = await payload.findGlobal({ slug: 'site', depth: 0 })
    out.draftRead = await payload.findGlobal({ slug: 'site', depth: 0, draft: true })
    out.versions = await payload.findGlobalVersions({ slug: 'site', sort: 'createdAt' })
    out.count = await payload.countGlobalVersions({ global: 'site' })
    const first = (out.versions as { docs: { id: number }[] }).docs[0]!
    out.byID = await payload.findGlobalVersionByID({ id: first.id, slug: 'site' })
    tick()
    out.restored = await payload.restoreGlobalVersion({ id: first.id, slug: 'site' })
    out.afterRestore = await payload.findGlobal({ slug: 'site', depth: 1 })
    out.select = await payload.findGlobal({ slug: 'site', select: { title: true } })
    return out
  })
  step('globals', 'localized global', async ({ payload, tick }) => {
    await payload.updateGlobal({
      slug: 'localized-global',
      data: { items: [{ text: 'en-item' }], title: 'en' },
    })
    tick()
    await payload.updateGlobal({
      slug: 'localized-global',
      data: { items: [{ text: 'es-item' }], title: 'es' },
      locale: 'es',
    })
    return {
      all: await payload.findGlobal({ slug: 'localized-global', locale: 'all' }),
      de: await payload.findGlobal({ slug: 'localized-global', locale: 'de' }),
      es: await payload.findGlobal({ slug: 'localized-global', locale: 'es' }),
      versions: await payload.findGlobalVersions({
        slug: 'localized-global',
        locale: 'all',
        sort: 'createdAt',
      }),
    }
  })
  step('globals', 'rows', () => dumpRows())

  // ---------------------------------------------------------------- delete
  step('delete', 'deleteByID', ({ payload }) =>
    payload.delete({ id: id('kitchen', 4), collection: 'kitchen', depth: 0 }),
  )
  step('delete', 'deleteByID missing', ({ payload }) =>
    payload.delete({ id: 999999, collection: 'kitchen' }),
  )
  step('delete', 'delete where', ({ payload }) =>
    payload.delete({ collection: 'kitchen', depth: 0, where: { checkbox: { equals: false } } }),
  )
  step('delete', 'delete target referenced by relationships', ({ payload }) =>
    payload.delete({ id: id('targets', 2), collection: 'targets', depth: 0 }),
  )
  step('delete', 'kitchen after deletes', ({ payload }) =>
    payload.find({ collection: 'kitchen', depth: 1 }),
  )
  step('delete', 'delete custom id', ({ payload }) =>
    payload.delete({ id: 'c-key', collection: 'custom-ids' }),
  )
  step('delete', 'delete drafts doc', ({ payload }) =>
    payload.delete({ id: id('drafts', 0), collection: 'drafts' }),
  )
  step('delete', 'counts', async ({ payload }) => ({
    customIDs: await payload.count({ collection: 'custom-ids' }),
    drafts: await payload.countVersions({ collection: 'drafts' }),
    kitchen: await payload.count({ collection: 'kitchen' }),
    targets: await payload.count({ collection: 'targets' }),
  }))
  step('delete', 'rows', () => dumpRows())
})
