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

test.suite('fused writes: localized write-side corpus', { config: './config.ts' }, () => {
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
