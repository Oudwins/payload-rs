/**
 * Golden fixtures for `transformForWrite` inputs the generated corpora do not produce:
 * - objects shared between several places of `data` (`data.a === data.b`): TS mutates the one
 *   object (array/block row ids move to `_uuid` once, groups get `_uuid`), and output rows keep
 *   referencing objects that later steps mutate
 * - typed values: `Date` instances (date fields `toISOString()`, text fields `JSON.stringify`,
 *   json values), invalid dates, `bigint`s
 * - user objects shaped like engine markers (`{"$bigint": "0"}`, `{"$date": ...}`, `{"$sql": ...}`)
 *
 *   pnpm tsx test/__rs/write/identityTypes.ts   # writes fixtures/manual__identity-types.json.gz
 */
import { transformForWrite } from '../../../packages/drizzle/src/transform/write/index.js'
import { flushFixtures, wrapTransformForWrite } from './capture.js'

const text = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  type: 'text',
  ...extra,
})

const rowFields = [
  text('label'),
  { name: 'when', type: 'date' },
  { name: 'tags', type: 'select', hasMany: true },
]

const fields = [
  text('title'),
  text('subtitle', { localized: true }),
  { name: 'count', type: 'number' },
  { name: 'publishedAt', type: 'date' },
  { name: 'localizedDate', type: 'date', localized: true },
  { name: 'data', type: 'json' },
  { name: 'items', type: 'array', flattenedFields: rowFields },
  { name: 'others', type: 'array', flattenedFields: rowFields },
  {
    name: 'meta',
    type: 'group',
    flattenedFields: [text('description'), { name: 'id', type: 'text' }],
  },
  { name: 'meta2', type: 'group', flattenedFields: [text('description')] },
  {
    name: 'layout',
    type: 'blocks',
    blocks: [{ slug: 'quote', flattenedFields: [text('quote'), { name: 'at', type: 'date' }] }],
  },
  { name: 'related', type: 'relationship', relationTo: 'posts', localized: true },
  { name: 'many', type: 'relationship', relationTo: 'posts', hasMany: true },
]

const adapter = {
  name: 'sqlite',
  blocksAsJSON: false,
  payload: { blocks: {}, config: { blocks: [] } },
  tableNameMap: new Map([
    ['posts', 'posts'],
    ['posts_blocks_quote', 'posts_blocks_quote'],
    ['posts_items', 'posts_items'],
    ['posts_items_tags', 'posts_items_tags'],
    ['posts_others', 'posts_others'],
    ['posts_others_tags', 'posts_others_tags'],
  ]),
  tables: {
    posts: {},
    posts_blocks_quote: { _uuid: {} },
    posts_items: { _uuid: {} },
    posts_items_tags: {},
    posts_others: { _uuid: {} },
    posts_others_tags: {},
  },
}

const run = wrapTransformForWrite(transformForWrite as any)

const date = (iso: string) => new Date(iso)

const cases: (() => Record<string, unknown>)[] = [
  // the same row twice in one array: its id moves to `_uuid` once
  () => {
    const row = { id: 'row-1', label: 'a' }
    return { items: [row, row] }
  },
  // one array in two fields
  () => {
    const rows = [
      { id: 'row-1', label: 'a' },
      { id: 'row-2', label: 'b' },
    ]
    return { items: rows, others: rows }
  },
  // a json value that is also an array row: the output row sees the deleted id
  () => {
    const row = { id: 'row-1', label: 'a' }
    return { data: row, items: [row] }
  },
  () => {
    const row = { id: 'row-1', label: 'a', tags: ['x', 'y'] }
    return { data: { nested: [row] }, items: [row], others: [row] }
  },
  // one group object in two group fields, and inside an array row
  () => {
    const group = { description: 'd' }
    return { meta: group, meta2: group }
  },
  () => {
    const group = { description: 'd' }
    return { id: 'doc-1', meta: group, items: [{ id: 'r', label: 'x' }], data: group }
  },
  // shared block rows
  () => {
    const block = { blockType: 'quote', id: 'b-1', quote: 'q' }
    return { layout: [block, block], data: block }
  },
  // relationship objects shared with a json value (localized ids are replaced in place)
  () => {
    const rel = { id: 7, title: 'x' }
    return { related: { en: rel, de: rel }, data: rel }
  },
  () => {
    const locales = { en: { id: 7 }, de: 8 }
    return { related: locales, data: locales }
  },
  () => {
    const many = [{ relationTo: 'posts', value: 1 }, 2]
    return { many, data: many }
  },
  // `Date` instances
  () => ({ publishedAt: date('2021-06-15T12:30:00.000Z') }),
  () => ({ publishedAt: new Date(Number.NaN) }),
  () => ({ localizedDate: { en: date('2020-01-01T00:00:00.000Z'), de: 0, fr: '2020' } }),
  () => ({ title: date('2020-01-01T00:00:00.000Z') }),
  () => ({ title: new Date(Number.NaN) }),
  () => ({ title: { at: date('2020-01-01T00:00:00.000Z'), bad: new Date(Number.NaN) } }),
  () => ({
    subtitle: { en: date('1999-03-04T05:06:07.000Z'), de: [date('2001-01-01T00:00:00.000Z')] },
  }),
  () => ({ data: { at: date('2020-01-01T00:00:00.000Z'), list: [new Date(Number.NaN)] } }),
  () => ({ count: date('2020-01-01T00:00:00.000Z') }),
  () => ({ meta: date('2020-01-01T00:00:00.000Z') }),
  () => ({
    items: [{ id: 'r', when: date('2022-02-02T02:02:02.000Z') }],
    updatedAt: date('2023-01-01T00:00:00.000Z'),
  }),
  () => {
    const when = date('2020-05-05T00:00:00.000Z')
    return {
      publishedAt: when,
      data: { when },
      layout: [{ blockType: 'quote', id: 'b', at: when }],
    }
  },
  // `bigint`s
  () => ({ count: 12n }),
  () => ({ title: 1n }),
  () => ({ title: 0n }),
  () => ({ data: { big: 12345678901234567890n } }),
  () => ({ items: [{ id: 5n, label: 'big id' }] }),
  // user objects shaped like engine markers
  () => ({ data: { $bigint: '0' } }),
  () => ({ data: { $date: '2020-01-01T00:00:00.000Z' } }),
  () => ({ data: { $sql: [{ str: 'x' }] } }),
  () => ({
    data: {
      nested: [{ $undefined: true }, { $num: 'NaN' }, { $fn: 1 }, { $ref: 0 }, { $obj: { a: 1 } }],
    },
  }),
  () => ({ title: { $date: null } }),
]

let errors = 0
for (const make of cases) {
  try {
    run({ adapter, data: make(), fields, tableName: 'posts' })
  } catch {
    errors++
  }
}

const written = flushFixtures('manual__identity-types')
// eslint-disable-next-line no-console
console.log(
  `[rs-write] ${cases.length} cases (${errors} TS errors) -> ${written?.file} (${written?.calls} calls)`,
)
if (!written || written.calls !== cases.length) {
  throw new Error(`expected ${cases.length} captured calls, got ${written?.calls ?? 0}`)
}
