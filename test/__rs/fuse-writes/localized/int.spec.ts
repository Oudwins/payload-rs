/**
 * The localized part of the write-side corpus (see ../int.spec.ts): creates and updates in the
 * default and other locales, localized scalars, relationships, rich text, groups and arrays, and
 * localized fields inside non-localized containers.
 *
 *   PAYLOAD_ENGINE=ts PAYLOAD_DATABASE=mongodb MONGODB_URL='mongodb://.../<db>?...' \
 *     pnpm test:int --config test/__rs/mongo-harness/vitest.config.ts test/__rs/fuse-writes/localized/int.spec.ts
 */
import type { Case, Fixtures } from '../corpus.js'

import { test } from '../../../__helpers/int/vitest.js'
import { requireTsEngine } from '../../requireTsEngine.js'
import { finish, fixtures, runAll } from '../corpus.js'
import { BSON } from '../harness.js'

requireTsEngine({ file: 'test/__rs/fuse-writes/localized/int.spec.ts' })

const richText = (text: string) => ({
  root: {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', text, version: 1 }], version: 1 }],
    version: 1,
  },
})

const full = (f: Fixtures) => ({
  title: 'Title',
  views: 3,
  excerpt: 'Excerpt',
  content: richText('Body'),
  author: f.author,
  editors: [f.author, f.author2],
  stage: 'published',
  publishedAt: '2024-01-02T03:04:05.000Z',
  count: 4,
  tags: [{ tag: 'a' }, { tag: 'b' }],
  seo: { title: 'S', description: 'D' },
  meta: { note: 'n', plain: 'p' },
  rows: [{ label: 'l1', size: 1 }, { label: 'l2' }],
})

/** A stored document with every locale filled (as the driver stores it). */
const stored = (f: Fixtures) => {
  const id = (hex: string) => new BSON.ObjectId(hex)
  const locales = <T>(make: (locale: string) => T) =>
    Object.fromEntries(['en', 'de', 'fr'].map((locale) => [locale, make(locale)]))
  return {
    title: locales((l) => `title ${l}`),
    views: 1,
    excerpt: locales((l) => `excerpt ${l}`),
    content: locales((l) => richText(l)),
    author: id(f.author),
    editors: locales(() => [id(f.author)]),
    stage: locales(() => 'draft'),
    publishedAt: locales(() => new Date(1_700_000_000_000)),
    count: locales(() => 2),
    tags: locales((l) => [
      { id: `64b7f0f0f0f0f0f0f0f0f0${l === 'en' ? 'e1' : l === 'de' ? 'd1' : 'f1'}`, tag: l },
    ]),
    seo: locales((l) => ({ title: `seo ${l}`, description: 'd' })),
    meta: { note: locales((l) => `note ${l}`), plain: 'p' },
    rows: [{ id: '64b7f0f0f0f0f0f0f0f0f001', label: locales((l) => `row ${l}`), size: 1 }],
    createdAt: new Date(1_600_000_000_000),
    updatedAt: new Date(1_600_000_000_000),
  }
}

const creates = (f: Fixtures): Case[] =>
  [
    { name: 'en title only', data: { title: 't' }, locale: 'en' },
    { name: 'en full', data: full(f), locale: 'en' },
    { name: 'de full', data: full(f), locale: 'de' },
    { name: 'fr title only', data: { title: 'fr' }, locale: 'fr' },
    { name: 'de missing title', data: { views: 1 }, locale: 'de' },
    { name: 'de invalid stage', data: { title: 't', stage: 'nope' }, locale: 'de' },
    { name: 'de tags null', data: { title: 't', tags: null }, locale: 'de' },
    { name: 'de tag missing', data: { title: 't', tags: [{}] }, locale: 'de' },
    { name: 'en seo null', data: { title: 't', seo: null }, locale: 'en' },
    { name: 'en editors empty', data: { title: 't', editors: [] }, locale: 'en' },
    { name: 'de date local', data: { title: 't', publishedAt: '2024-01-02' }, locale: 'de' },
    { name: 'user', data: { title: 't' }, locale: 'de', user: true },
    {
      name: 'de blocks',
      data: {
        title: 't',
        layout: [
          { blockType: 'hero', heading: 'h' },
          { blockType: 'quote', text: 'q' },
        ],
      },
      locale: 'de',
    },
    { name: 'de blocks null', data: { title: 't', layout: null }, locale: 'de' },
    {
      name: 'en block missing heading',
      data: { title: 't', layout: [{ blockType: 'hero' }] },
      locale: 'en',
    },
  ].map((c) => ({ ...c, collection: 'posts' }))

const updates = (f: Fixtures): Case[] =>
  [
    { name: 'de title', data: { title: 'de' }, locale: 'de', seed: { data: full(f) } },
    { name: 'en title', data: { title: 'en2' }, locale: 'en', seed: { data: full(f) } },
    {
      name: 'fr whole document',
      data: { ...full(f), title: 'fr' },
      locale: 'fr',
      seed: { data: full(f) },
    },
    { name: 'de tags', data: { tags: [{ tag: 'x' }] }, locale: 'de', seed: { data: full(f) } },
    { name: 'de tags null', data: { tags: null }, locale: 'de', seed: { data: full(f) } },
    { name: 'en tags null', data: { tags: null }, locale: 'en', seed: { data: full(f) } },
    { name: 'de seo', data: { seo: { title: 'S2' } }, locale: 'de', seed: { data: full(f) } },
    { name: 'fr editors', data: { editors: [f.author2] }, locale: 'fr', seed: { data: full(f) } },
    { name: 'de meta note', data: { meta: { note: 'dn' } }, locale: 'de', seed: { data: full(f) } },
    {
      name: 'de rows by id keep',
      data: { views: 9 },
      locale: 'de',
      seed: { data: full(f) },
    },
    { name: 'de clear title', data: { title: '' }, locale: 'de', seed: { data: full(f) } },
    {
      name: 'de content',
      data: { content: richText('de') },
      locale: 'de',
      seed: { data: full(f) },
    },
    { name: 'user fr', data: { count: 2 }, locale: 'fr', seed: { data: full(f) }, user: true },
    {
      name: 'all locales: fr blocks',
      data: { layout: [{ blockType: 'quote', text: 'citation' }] },
      locale: 'fr',
      seed: { raw: stored(f) },
    },
    {
      name: 'all locales: de title',
      data: { title: 'neu' },
      locale: 'de',
      seed: { raw: stored(f) },
    },
    {
      name: 'all locales: fr tags',
      data: { tags: [{ tag: 'nouveau' }] },
      locale: 'fr',
      seed: { raw: stored(f) },
    },
    {
      name: 'all locales: de tags null',
      data: { tags: null },
      locale: 'de',
      seed: { raw: stored(f) },
    },
    {
      name: 'all locales: en seo',
      data: { seo: { title: 'x' } },
      locale: 'en',
      seed: { raw: stored(f) },
    },
    {
      name: 'all locales: de rows label',
      data: { rows: [{ id: '64b7f0f0f0f0f0f0f0f0f001', label: 'zeile' }] },
      locale: 'de',
      seed: { raw: stored(f) },
    },
    {
      name: 'all locales: fr editors',
      data: { editors: [f.author2] },
      locale: 'fr',
      seed: { raw: stored(f) },
    },
    {
      name: 'all locales: de meta note',
      data: { meta: { note: 'notiz' } },
      locale: 'de',
      seed: { raw: stored(f) },
    },
    {
      name: 'all locales: en whole document',
      data: full(f),
      locale: 'en',
      seed: { raw: stored(f) },
    },
    {
      name: 'all locales: de scalar',
      data: { views: 5 },
      locale: 'de',
      seed: { raw: stored(f) },
      user: true,
    },
    {
      name: 'raw: unknown locale keys',
      data: { views: 2 },
      locale: 'de',
      seed: {
        raw: {
          title: { en: 'x', xx: 'y' },
          seo: { en: { title: 'a', junk: 1 }, zz: { title: 'b' } },
          tags: { en: [{ id: 'r1', tag: 'q' }], de: [] },
          editors: { en: [f.author] },
        },
      },
    },
    {
      name: 'raw: scalar where locales expected',
      data: { title: 'b' },
      locale: 'en',
      seed: { raw: { title: 'plain', stage: { en: 'published' } } },
    },
  ].map((c) => ({ ...c, collection: 'posts' }))

const magazine = (f: Fixtures) => ({
  title: 'M',
  intro: { lead: 'L', words: 5, items: [{ item: 'i1' }] },
  facts: { caption: 'C', pages: 3, editor: f.author },
  flat: 'F',
})

const magazineStored = (f: Fixtures) => ({
  title: { en: 'm en', de: 'm de' },
  intro: {
    en: { lead: 'lead en', words: 1, items: [{ id: '64b7f0f0f0f0f0f0f0f0f0a1', item: 'x' }] },
    de: { lead: 'lead de', words: 2 },
  },
  facts: { caption: { en: 'c en', fr: 'c fr' }, pages: 4, editor: new BSON.ObjectId(f.author) },
  flat: { en: 'f en' },
  createdAt: new Date(1_600_000_000_000),
  updatedAt: new Date(1_600_000_000_000),
})

const magazines = (f: Fixtures): Case[] =>
  [
    { name: 'create en full', data: magazine(f), locale: 'en' },
    { name: 'create de full', data: magazine(f), locale: 'de' },
    { name: 'create fr title only', data: { title: 'fr' }, locale: 'fr' },
    { name: 'create de intro null', data: { title: 't', intro: null }, locale: 'de' },
    { name: 'create en missing lead', data: { title: 't', intro: { words: 1 } }, locale: 'en' },
    {
      name: 'update de lead',
      data: { intro: { lead: 'neu' } },
      locale: 'de',
      seed: { data: magazine(f) },
    },
    {
      name: 'update fr caption',
      data: { facts: { caption: 'cfr' } },
      locale: 'fr',
      seed: { data: magazine(f) },
    },
    {
      name: 'all locales: fr intro',
      data: { intro: { lead: 'fr lead' } },
      locale: 'fr',
      seed: { raw: magazineStored(f) },
    },
    {
      name: 'all locales: de pages',
      data: { facts: { pages: 9 } },
      locale: 'de',
      seed: { raw: magazineStored(f) },
    },
    {
      name: 'all locales: en clear lead',
      data: { intro: { lead: '' } },
      locale: 'en',
      seed: { raw: magazineStored(f) },
    },
    {
      name: 'raw: unknown locale key in a tab',
      data: { title: 'x' },
      locale: 'en',
      seed: { raw: { title: { en: 'a' }, intro: { en: { lead: 'l' }, zz: { lead: 'q' } } } },
    },
  ].map((c) => ({ ...c, collection: 'magazines' }))

const localizedTabs = (): Case[] =>
  [
    { name: 'empty localized tab', data: { tabLocalized: {} }, locale: 'en' },
    { name: 'title only', data: { tabLocalized: { title: 'hello en' } }, locale: 'en' },
    { name: 'array', data: { tabLocalized: { array: [{ title: 'a' }] } }, locale: 'en' },
    { name: 'group', data: { tabLocalized: { group: { heading: 'h' } } }, locale: 'de' },
    {
      name: 'deep',
      data: { deep: { array: [{ title: 't' }] }, tab: { title: 'x' } },
      locale: 'de',
    },
    {
      name: 'update es title',
      data: { tabLocalized: { title: 'hello es' } },
      locale: 'fr',
      seed: { data: { tabLocalized: { title: 'hello en' } } },
    },
    {
      name: 'update es array',
      data: { tabLocalized: { array: [{ title: 'hello es' }] } },
      locale: 'de',
      seed: { data: { tabLocalized: { array: [{ title: 'hello en' }] } } },
    },
  ].map((c) => ({ ...c, collection: 'tabs' }))

const bulletin = {
  title: 'B',
  items: [{ item: 'a' }, { item: 'b' }],
  meta: { count: 2 },
  extra: { note: 'x' },
  body: richText('body'),
}

const bulletins = (): Case[] =>
  [
    { name: 'create publish en', data: bulletin, locale: 'en' },
    { name: 'create publish de', data: bulletin, locale: 'de' },
    { name: 'create publish title only', data: { title: 't' }, locale: 'fr' },
    { name: 'create publish invalid', data: { title: 't', meta: { count: 10 } }, locale: 'en' },
    { name: 'create publish missing item', data: { title: 't', items: [{}] }, locale: 'de' },
    { name: 'create draft', data: { items: [{}] }, draft: true, locale: 'en' },
    { name: 'update publish', data: { title: 'u' }, locale: 'en', seed: { data: bulletin } },
    {
      name: 'update publish de',
      data: { meta: { count: 3 } },
      locale: 'de',
      seed: { data: bulletin },
    },
    { name: 'update publish invalid', data: { title: '' }, locale: 'en', seed: { data: bulletin } },
    {
      name: 'publish over a draft',
      data: { items: [{ item: 'c' }] },
      locale: 'fr',
      seed: {
        data: { title: 'd' },
        draft: true,
        updates: [{ data: { title: 'd2' }, draft: true }],
      },
    },
    {
      name: 'raw: publish over locale-keyed values',
      data: { title: 'r' },
      locale: 'de',
      seed: { raw: { title: { en: 'x' }, meta: { en: { count: 1 } }, _status: 'draft' } },
    },
  ].map((c) => ({ ...c, collection: 'bulletins' }))

const draftPost = {
  blocksField: [{ blockType: 'block', localized: 'l', text: 't' }],
  description: 'd',
  radio: 'test',
  select: ['test1', 'test2'],
  title: 'post',
}

const draftPosts = (): Case[] =>
  [
    { name: 'create draft', data: draftPost, draft: true, locale: 'en' },
    { name: 'create draft de', data: { ...draftPost, title: 'de' }, draft: true, locale: 'de' },
    { name: 'create draft, nothing', data: {}, draft: true, locale: 'en' },
    { name: 'create draft, radio invalid', data: { radio: 'x' }, draft: true, locale: 'en' },
    { name: 'create published', data: { ...draftPost, title: 'pub' }, locale: 'en' },
    {
      name: 'draft save',
      data: { description: 'd2', title: 'post2' },
      draft: true,
      locale: 'en',
      seed: { data: { ...draftPost, title: 'seed1' }, draft: true },
    },
    {
      name: 'draft save de',
      data: { title: 'hallo' },
      draft: true,
      locale: 'de',
      seed: { data: { ...draftPost, title: 'seed2' }, draft: true },
    },
    {
      name: 'draft save, blocks',
      data: { blocksField: [{ blockType: 'block', text: 'n' }] },
      draft: true,
      locale: 'en',
      seed: { data: { ...draftPost, title: 'seed3' }, draft: true },
    },
    {
      name: 'raw: draft save over locale-keyed title',
      data: { radio: 'test' },
      draft: true,
      locale: 'fr',
      seed: { raw: { title: { en: 'x', de: 'y' }, description: 'r', _status: 'draft' } },
    },
  ].map((c) => ({ ...c, collection: 'draftPosts' }))

const codes = (f: Fixtures): Case[] =>
  [
    { name: 'create publish without unique values', data: { items: [] }, locale: 'en' },
    { name: 'create publish code', data: { code: 'a' }, locale: 'en' },
    { name: 'create publish taken code', data: { code: 'a' }, locale: 'de' },
    { name: 'create publish rank', data: { code: 'r', meta: { rank: 1 } }, locale: 'fr' },
    { name: 'create publish taken rank', data: { meta: { rank: 1 } }, locale: 'en' },
    { name: 'create publish null code', data: { code: null, meta: { rank: null } }, locale: 'en' },
    {
      name: 'create publish ref',
      data: { hideout: { camera: { ref: f.author } } },
      locale: 'en',
    },
    {
      name: 'create publish taken ref',
      data: { hideout: { camera: { ref: f.author } } },
      locale: 'de',
    },
    { name: 'create publish rows', data: { items: [{ sku: 's' }] }, locale: 'en' },
    { name: 'create draft taken code', data: { code: 'a' }, draft: true, locale: 'en' },
    {
      name: 'update publish keeping its code',
      data: { meta: { rank: 5 } },
      locale: 'en',
      seed: { data: { code: 'u1' } },
    },
    {
      name: 'update publish to a taken code',
      data: { code: 'a' },
      locale: 'de',
      seed: { data: { code: 'u2' } },
    },
    {
      name: 'update publish over a draft',
      data: { code: 'u3' },
      locale: 'en',
      seed: {
        data: { code: 'd' },
        draft: true,
        updates: [{ data: { meta: { rank: 7 } }, draft: true }],
      },
    },
    {
      name: 'update publish with a stored ref',
      data: { code: 'u4' },
      locale: 'fr',
      seed: { data: { hideout: { camera: { ref: f.author2 } } } },
    },
    {
      name: 'raw: update publish clearing the stored code',
      data: { code: null },
      locale: 'en',
      seed: { raw: { code: 'raw', _status: 'published' } },
    },
  ].map((c) => ({ ...c, collection: 'codes' }))

const pairs = (): Case[] =>
  [
    { name: 'create publish with a unique compound index', data: { a: 'x', b: 'y' }, locale: 'en' },
  ].map((c) => ({ ...c, collection: 'pairs' }))

test.suite('fused writes: localized write-side corpus', { config: './config.ts' }, () => {
  test('localized publishes of unique values', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'unique publish', [...codes(f), ...pairs()], f)
    finish('unique publish')
  })

  test('localized publishes of all locales', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'all locales publish', bulletins(), f)
    finish('all locales publish')
  })

  test('localized unnamed groups (test/versions drafts)', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'localized unnamed groups', draftPosts(), f)
    finish('localized unnamed groups')
  })

  test('localized named tabs', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'localized tabs', [...magazines(f), ...localizedTabs()], f)
    finish('localized tabs')
  })

  test('localized drafts', async ({ payload }) => {
    const f = await fixtures(payload)
    const cases: Case[] = [
      { name: 'ls create en', collection: 'articles', data: { title: 'hello' }, locale: 'en' },
      {
        name: 'ls create de draft',
        collection: 'articles',
        data: { tags: [{ tag: 't' }] },
        draft: true,
        locale: 'de',
      },
      {
        name: 'ls create en published',
        collection: 'articles',
        data: { _status: 'published', title: 'p' },
        locale: 'en',
      },
      {
        name: 'ls draft save de over en',
        collection: 'articles',
        data: { title: 'hallo' },
        draft: true,
        locale: 'de',
        seed: { data: { title: 'hello' } },
      },
      {
        name: 'ls update en left draft',
        collection: 'articles',
        data: { views: 4 },
        locale: 'en',
        seed: { data: { title: 'one' }, updates: [{ data: { title: 'two' }, draft: true }] },
      },
      {
        name: 'ls publish en (bails)',
        collection: 'articles',
        data: { _status: 'published' },
        locale: 'en',
        seed: { data: { title: 'pub' } },
      },
      { name: 'notes create draft', collection: 'notes', data: {}, draft: true, locale: 'en' },
      {
        name: 'notes create publish (bails)',
        collection: 'notes',
        data: { title: 'n' },
        locale: 'en',
      },
      {
        name: 'notes draft save',
        collection: 'notes',
        data: { title: 'n2' },
        draft: true,
        locale: 'en',
        seed: { data: { title: 'n1' } },
      },
    ]
    await runAll(payload, 'localized drafts', cases, f)
    finish('localized drafts')
  })

  test('localized creates', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'localized create', creates(f), f)
    finish('localized create')
  })

  test('localized updates', async ({ payload }) => {
    const f = await fixtures(payload)
    await runAll(payload, 'localized update', updates(f), f)
    finish('localized update')
  })
})
