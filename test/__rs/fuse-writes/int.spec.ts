/**
 * Differential corpus of the fused writes' write-side library (packages/engine-rs/FUSED_WRITES.md
 * section 12): every case runs upstream's `create` / `update` on the TS engine and
 * `fuseWritePrepare` on the same input with the same clock and row id readings; the BSON mongoose
 * sends, the stored document, the caller's data, `req.context` and validation errors must be equal
 * or the library must bail.
 *
 *   PAYLOAD_ENGINE=ts PAYLOAD_DATABASE=mongodb MONGODB_URL='mongodb://.../<db>?...' \
 *     pnpm test:int --config test/__rs/mongo-harness/vitest.config.ts test/__rs/fuse-writes/int.spec.ts
 */
import type { Case, Fixtures } from './corpus.js'

import { test } from '../../__helpers/int/vitest.js'
import { requireTsEngine } from '../requireTsEngine.js'
import { finish, fixtures, runAll } from './corpus.js'

requireTsEngine({ file: 'test/__rs/fuse-writes/int.spec.ts' })

const minimalCreates = (f: Fixtures): Case[] =>
  [
    { name: 'title only', data: { title: 'a' } },
    { name: 'all fields', data: { title: 'a', views: 5, revision: '7', author: f.author } },
    { name: 'number title', data: { title: 7 } },
    { name: 'padded number string', data: { title: 'x', views: '  12 ' } },
    { name: 'empty number string', data: { title: 'x', views: '' } },
    { name: 'empty relationship', data: { title: 'x', author: '' } },
    { name: 'none relationship', data: { title: 'x', author: 'none' } },
    { name: 'null relationship', data: { title: 'x', author: null } },
    { name: 'invalid relationship', data: { title: 'x', author: 'not-an-id' } },
    { name: 'missing required', data: {} },
    { name: 'empty required', data: { title: '' } },
    { name: 'negative zero', data: { title: 'x', views: -0 } },
    { name: 'double', data: { title: 'x', views: 1.5, revision: 2 ** 31 } },
    { name: 'large integer', data: { title: 'x', views: 2 ** 53 } },
    { name: 'unknown key', data: { title: 'x', extra: 'unknown', nested: { a: 1 } } },
    { name: 'given createdAt', data: { title: 'x', createdAt: '2020-01-01T00:00:00.000Z' } },
    { name: 'given updatedAt', data: { title: 'x', updatedAt: '2020-01-01T00:00:00.000Z' } },
    { name: 'null updatedAt', data: { title: 'x', updatedAt: null } },
    { name: 'date updatedAt', data: { title: 'x', createdAt: new Date(1_600_000_000_000) } },
    { name: 'populated relationship', data: { title: 'x', author: { id: f.author, name: 'a' } } },
    { name: 'undefined values', data: { title: 'x', views: undefined, author: undefined } },
    { name: 'boolean views', data: { title: 'x', views: true } },
    { name: 'object views', data: { title: 'x', views: { $inc: 1 } } },
    { name: 'user', data: { title: 'x' }, user: true },
    {
      name: 'user, createdBy given',
      data: { title: 'x', createdBy: { relationTo: 'users', value: f.author } },
      user: true,
    },
    { name: 'createdBy without user', data: { title: 'x', updatedBy: null } },
    { name: 'id given', data: { id: f.author, title: 'x' } },
    { name: 'dotted key', data: { title: 'x', 'a.b': 1 } },
  ].map((c) => ({ ...c, collection: 'minimal' }))

const minimalUpdates = (f: Fixtures): Case[] =>
  [
    { name: 'title', data: { title: 'b' }, seed: { data: { title: 'a', views: 3 } } },
    { name: 'views string', data: { views: '9' }, seed: { data: { title: 'a' } } },
    {
      name: 'author',
      data: { author: f.author2 },
      seed: { data: { title: 'a', author: f.author } },
    },
    {
      name: 'author null',
      data: { author: null },
      seed: { data: { title: 'a', author: f.author } },
    },
    { name: 'empty data', data: {}, seed: { data: { title: 'a' } } },
    { name: 'clear required', data: { title: '' }, seed: { data: { title: 'a' } } },
    { name: 'user', data: { revision: 1 }, seed: { data: { title: 'a' } }, user: true },
    { name: 'unknown key', data: { title: 'b', other: 1 }, seed: { data: { title: 'a' } } },
    {
      name: 'raw: double views, unknown key, string date',
      data: { revision: 2 },
      seed: {
        raw: {
          title: 'raw',
          views: 5.0,
          unknown: 'kept?',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: new Date(1_500_000_000_000),
        },
      },
    },
    {
      name: 'raw: negative zero and missing fields',
      data: { title: 'b' },
      seed: { raw: { title: 'raw', views: -0 } },
    },
    {
      name: 'raw: string author id',
      data: { views: 1 },
      seed: { raw: { title: 'raw', author: f.author, createdAt: new Date(1_500_000_000_000) } },
    },
  ].map((c) => ({ ...c, collection: 'minimal' }))

let slugs = 0

/** The perf suite's rich text (test/__rs/perf/configs.mjs `richText`). */
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

const emptyParagraph = {
  root: { type: 'root', children: [{ type: 'paragraph', children: [], version: 1 }], version: 1 },
}

const list = {
  root: {
    type: 'root',
    children: [
      {
        type: 'list',
        listType: 'bullet',
        tag: 'ul',
        children: [
          {
            type: 'listitem',
            value: 1,
            children: [{ type: 'text', text: 'a', version: 1 }],
            version: 1,
          },
          { type: 'listitem', value: 2, children: [], version: 1 },
        ],
        version: 1,
      },
      {
        type: 'heading',
        tag: 'h2',
        children: [{ type: 'text', text: 'h', version: 1 }],
        version: 1,
      },
      { type: 'quote', children: [{ type: 'linebreak', version: 1 }], version: 1 },
    ],
    version: 1,
  },
}

const headings = {
  root: {
    type: 'root',
    children: [
      {
        type: 'heading',
        tag: 'h2',
        children: [{ type: 'text', text: 'h', version: 1 }],
        version: 1,
      },
      { type: 'quote', children: [{ type: 'linebreak', version: 1 }], version: 1 },
      { type: 'paragraph', children: [], version: 1 },
      { type: 'horizontalrule', version: 1 },
    ],
    version: 1,
  },
}

const link = (url: string) => ({
  root: {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          {
            type: 'link',
            children: [{ type: 'text', text: 'l', version: 1 }],
            fields: { linkType: 'custom', newTab: false, url },
            version: 3,
          },
        ],
        version: 1,
      },
    ],
    version: 1,
  },
})

const block = {
  root: {
    type: 'root',
    children: [
      {
        type: 'block',
        fields: { id: '65f000000000000000000001', blockType: 'myBlock', someTextRequired: 'x' },
        version: 2,
      },
    ],
    version: 1,
  },
}

const typicalDoc = (f: Fixtures) => ({
  title: 'Post',
  views: 10,
  author: f.author,
  slug: `post-${++slugs}`,
  excerpt: 'An excerpt',
  content: richText('Body text'),
  stage: 'published',
  publishedAt: '2024-05-06T07:08:09.000Z',
  featured: true,
  categories: [f.category, f.category2],
  tags: [{ tag: 'one' }, { tag: 'two' }],
  seo: { title: 'SEO', description: 'Desc' },
})

const typicalCreates = (f: Fixtures): Case[] =>
  [
    { name: 'full', data: typicalDoc(f) },
    { name: 'title only', data: { title: 't' } },
    { name: 'checkbox strings', data: { title: 't', featured: 'false' } },
    { name: 'empty checkbox string', data: { title: 't', featured: '' } },
    { name: 'invalid select', data: { title: 't', stage: 'nope' } },
    { name: 'select null', data: { title: 't', stage: null } },
    { name: 'date forms', data: { title: 't', publishedAt: '2024-05-06' } },
    { name: 'date local form', data: { title: 't', publishedAt: '2024-05-06T07:08:09' } },
    { name: 'invalid date', data: { title: 't', publishedAt: 'not a date' } },
    { name: 'date number', data: { title: 't', publishedAt: 1_700_000_000_000 } },
    {
      name: 'categories populated',
      data: { title: 't', categories: [{ id: f.category }, f.category2] },
    },
    { name: 'categories empty string', data: { title: 't', categories: '' } },
    { name: 'categories single string', data: { title: 't', categories: f.category } },
    { name: 'categories with null', data: { title: 't', categories: [f.category, null] } },
    {
      name: 'tags with ids',
      data: { title: 't', tags: [{ id: '64b7f0f0f0f0f0f0f0f0f0f0', tag: 'x' }] },
    },
    { name: 'tags zero', data: { title: 't', tags: 0 } },
    { name: 'tags string', data: { title: 't', tags: 'abc' } },
    { name: 'tags with null row', data: { title: 't', tags: [null, { tag: 'a' }] } },
    { name: 'tag id null', data: { title: 't', tags: [{ id: null, tag: 'a' }] } },
    { name: 'tag numeric id', data: { title: 't', tags: [{ id: 5, tag: 'a' }] } },
    { name: 'tag unknown key', data: { title: 't', tags: [{ tag: 'a', other: 1 }] } },
    { name: 'seo partial', data: { title: 't', seo: { title: 's' } } },
    { name: 'seo string', data: { title: 't', seo: 'x' } },
    { name: 'seo null', data: { title: 't', seo: null } },
    { name: 'seo unknown key', data: { title: 't', seo: { title: 's', z: 1 } } },
    { name: 'user', data: typicalDoc(f), user: true },
  ].map((c) => ({ ...c, collection: 'typical' }))

const typicalUpdates = (f: Fixtures): Case[] =>
  [
    {
      name: 'whole document',
      data: { ...typicalDoc(f), title: 'b' },
      seed: { data: typicalDoc(f) },
    },
    { name: 'scalar', data: { revision: 3 }, seed: { data: typicalDoc(f) } },
    { name: 'relationship', data: { author: f.author2 }, seed: { data: typicalDoc(f) } },
    { name: 'categories', data: { categories: [f.category2] }, seed: { data: typicalDoc(f) } },
    { name: 'tags replaced', data: { tags: [{ tag: 'new' }] }, seed: { data: typicalDoc(f) } },
    { name: 'seo partial', data: { seo: { description: 'd2' } }, seed: { data: typicalDoc(f) } },
    { name: 'invalid stage', data: { stage: 'bad' }, seed: { data: typicalDoc(f) } },
    { name: 'user', data: { title: 'u' }, seed: { data: typicalDoc(f) }, user: true },
    {
      name: 'raw: rows without ids, missing group',
      data: { title: 'b' },
      seed: { raw: { title: 'raw', tags: [{ tag: 'a' }], featured: 'yes' } },
    },
    {
      name: 'raw: unknown keys everywhere',
      data: { views: 2 },
      seed: {
        raw: {
          title: 'raw',
          seo: { title: 's', junk: 1 },
          tags: [{ id: 'x1', tag: 'a', junk: 2 }],
          junk: { deep: true },
        },
      },
    },
  ].map((c) => ({ ...c, collection: 'typical' }))

const kindsCreates = (f: Fixtures): Case[] =>
  [
    { name: 'defaults only', data: {} },
    { name: 'text too long', data: { text: 'x'.repeat(11) } },
    { name: 'text too short', data: { text: 'x' } },
    { name: 'texts too many', data: { texts: ['a', 'b', 'c', 'd'] } },
    { name: 'texts', data: { texts: ['a', 'b'] } },
    { name: 'textarea long', data: { textarea: 'y'.repeat(21) } },
    { name: 'email invalid', data: { email: 'nope' } },
    { name: 'email', data: { email: 'a@b.co' } },
    { name: 'number over max', data: { number: 101 } },
    { name: 'number under min', data: { number: -101 } },
    { name: 'number ok', data: { number: 50, numbers: [1, 2.5, -0] } },
    { name: 'numbers empty', data: { numbers: [] } },
    { name: 'numbers strings', data: { numbers: ['1', '2'] } },
    { name: 'checkbox true string', data: { checkbox: 'true' } },
    { name: 'checkbox yes', data: { checkbox: 'yes' } },
    { name: 'date', data: { date: '2020-02-03T04:05:06.007Z' } },
    { name: 'select', data: { select: 'c', selects: ['a', 'b'] } },
    { name: 'select invalid', data: { select: 'z' } },
    { name: 'selects duplicates', data: { selects: ['a', 'a'] } },
    { name: 'rel', data: { rel: f.author, rels: [f.category] } },
    { name: 'poly', data: { poly: { relationTo: 'authors', value: f.author } } },
    { name: 'poly categories', data: { poly: { relationTo: 'categories', value: f.category } } },
    {
      name: 'polys',
      data: {
        polys: [
          { relationTo: 'authors', value: f.author },
          { relationTo: 'categories', value: { id: f.category } },
        ],
      },
    },
    { name: 'polys single object', data: { polys: { relationTo: 'authors', value: f.author } } },
    { name: 'group', data: { group: { a: 'x', n: 2, inner: { deep: 'd' } } } },
    { name: 'group empty', data: { group: {} } },
    {
      name: 'rows',
      data: {
        rows: [
          { label: 'r1', children: [{ name: 'c1' }, { name: 'c2' }] },
          { label: 'r2', count: 3, meta: { note: 'n' } },
        ],
      },
    },
    { name: 'rows missing label', data: { rows: [{ count: 2 }] } },
    {
      name: 'rows too many',
      data: {
        rows: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }, { label: 'e' }],
      },
    },
    { name: 'row and collapsible', data: { inRow: 'r', inCollapsible: 9, inTab: true } },
    {
      name: 'errors everywhere',
      data: { text: 'x', number: 1000, select: 'q', rows: [{}], email: 'x' },
    },
    { name: 'textRequired cleared', data: { textRequired: '' } },
  ].map((c) => ({ ...c, collection: 'kinds' }))

const richCreates = (): Case[] =>
  [
    { name: 'paragraph', data: { required: richText('r'), body: richText('b') } },
    { name: 'required missing', data: { body: richText('b') } },
    { name: 'required empty paragraph', data: { required: emptyParagraph } },
    { name: 'required empty text', data: { required: richText('') } },
    { name: 'lists, headings, quotes', data: { required: list, body: list } },
    { name: 'link', data: { required: link('https://payloadcms.com') } },
    {
      name: 'link in body',
      data: { required: richText('r'), body: link('https://payloadcms.com') },
    },
    { name: 'block with id', data: { required: richText('r'), body: block } },
    {
      name: 'nested and rows',
      data: { required: richText('r'), nested: { text: list }, items: [{ text: richText('i') }] },
    },
    {
      name: 'nested and rows, no lists',
      data: {
        required: richText('r'),
        nested: { text: headings },
        items: [{ text: richText('i') }, {}],
      },
    },
    { name: 'headings and quotes', data: { required: headings, body: headings } },
    {
      name: 'invalid heading tag',
      data: {
        required: {
          root: { type: 'root', children: [{ type: 'heading', tag: 'h9', children: [] }] },
        },
      },
    },
    {
      name: 'list without tag, deep',
      data: {
        required: richText('r'),
        nested: {
          text: {
            root: {
              type: 'root',
              children: [{ type: 'quote', children: [{ type: 'list', children: [] }] }],
            },
          },
        },
      },
    },
    {
      name: 'list item value string',
      data: {
        required: {
          root: {
            type: 'root',
            children: [
              {
                type: 'list',
                tag: 'ol',
                children: [{ type: 'listitem', value: '1', children: [] }],
              },
            ],
          },
        },
      },
    },
    { name: 'string state', data: { required: JSON.stringify(richText('s')) } },
    { name: 'null state', data: { required: richText('r'), body: null } },
    { name: 'root without children', data: { required: { root: { type: 'root' } } } },
  ].map((c) => ({ ...c, collection: 'rich' }))

const richUpdates = (): Case[] =>
  [
    {
      name: 'replace',
      data: { required: richText('new') },
      seed: { data: { required: richText('old') } },
    },
    {
      name: 'other field',
      data: { items: [] },
      seed: { data: { required: richText('r'), body: richText('b') } },
    },
    {
      name: 'stored block with id',
      data: { required: richText('x') },
      seed: { data: { required: richText('r'), body: block } },
    },
    {
      name: 'raw: numbers as doubles',
      data: { body: richText('b') },
      seed: {
        raw: {
          required: {
            root: {
              type: 'root',
              children: [
                { type: 'paragraph', children: [{ type: 'text', text: 't', version: 1.5 }] },
              ],
            },
          },
        },
      },
    },
  ].map((c) => ({ ...c, collection: 'rich' }))

const hero = (heading: string) => ({ blockType: 'hero', heading })

const pagesCreates = (f: Fixtures): Case[] =>
  [
    {
      name: 'blocks',
      data: {
        layout: [hero('h'), { blockType: 'gallery', items: [{ caption: 'c' }], author: f.author }],
      },
    },
    { name: 'content block', data: { layout: [{ blockType: 'content', body: richText('b') }] } },
    { name: 'missing required in block', data: { layout: [hero('h'), { blockType: 'hero' }] } },
    {
      name: 'too many blocks',
      data: { layout: [hero('1'), hero('2'), hero('3'), hero('4'), hero('5')] },
    },
    { name: 'unknown block type', data: { layout: [{ blockType: 'nope', x: 1 }, hero('h')] } },
    { name: 'no block type', data: { layout: [{ heading: 'h' }] } },
    { name: 'block with id', data: { layout: [{ ...hero('h'), id: '64b7f0f0f0f0f0f0f0f0f0aa' }] } },
    { name: 'block unknown key', data: { layout: [{ ...hero('h'), junk: 1 }] } },
    { name: 'layout zero', data: { layout: 0 } },
    { name: 'layout object', data: { layout: { blockType: 'hero' } } },
    { name: 'gallery invalid author', data: { layout: [{ blockType: 'gallery', author: 'x' }] } },
  ].map((c) => ({ ...c, collection: 'pages' }))

const pagesUpdates = (f: Fixtures): Case[] =>
  [
    {
      name: 'replace blocks',
      data: { layout: [hero('new')] },
      seed: { data: { layout: [hero('old'), { blockType: 'gallery' }] } },
    },
    {
      name: 'title only',
      data: { title: 't' },
      seed: { data: { layout: [hero('old'), { blockType: 'gallery', author: f.author }] } },
    },
    { name: 'clear layout', data: { layout: [] }, seed: { data: { layout: [hero('old')] } } },
    {
      name: 'raw: unknown blocks and keys',
      data: { title: 't' },
      seed: {
        raw: {
          layout: [{ blockType: 'hero', heading: 'h', junk: 1 }, { blockType: 'gone', a: 1 }, null],
        },
      },
    },
  ].map((c) => ({ ...c, collection: 'pages' }))

const kindsUpdates = (f: Fixtures): Case[] =>
  [
    {
      name: 'rows kept by id',
      data: { rows: [{ label: 'changed' }] },
      seed: { data: { rows: [{ label: 'r1', children: [{ name: 'c' }] }] } },
    },
    {
      name: 'group partial',
      data: { group: { n: 5 } },
      seed: { data: { group: { a: 'x', inner: { deep: 'd' } } } },
    },
    {
      name: 'poly change',
      data: { poly: { relationTo: 'categories', value: f.category } },
      seed: { data: { poly: { relationTo: 'authors', value: f.author } } },
    },
    { name: 'numbers', data: { numbers: [9] }, seed: { data: { numbers: [1, 2] } } },
    {
      name: 'raw: group as string, rows null',
      data: { text: 'ok' },
      seed: { raw: { group: 'str', rows: null, numbers: [1] } },
    },
  ].map((c) => ({ ...c, collection: 'kinds' }))

test.suite('fused writes: write-side corpus', { config: './config.ts' }, () => {
  test('minimal creates', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'minimal create', minimalCreates(f), f)
    finish('minimal create')
  })

  test('minimal updates', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'minimal update', minimalUpdates(f), f)
    finish('minimal update')
  })

  test('typical creates', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'typical create', typicalCreates(f), f)
    finish('typical create')
  })

  test('typical updates', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'typical update', typicalUpdates(f), f)
    finish('typical update')
  })

  test('kinds creates', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'kinds create', kindsCreates(f), f)
    finish('kinds create')
  })

  test('pages creates', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'pages create', pagesCreates(f), f)
    finish('pages create')
  })

  test('pages updates', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'pages update', pagesUpdates(f), f)
    finish('pages update')
  })

  test('rich creates', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'rich create', richCreates(), f)
    finish('rich create')
  })

  test('rich updates', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'rich update', richUpdates(), f)
    finish('rich update')
  })

  test('kinds updates', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'kinds update', kindsUpdates(f), f)
    finish('kinds update')
  })
})
