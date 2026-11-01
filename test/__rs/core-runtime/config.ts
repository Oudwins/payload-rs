/**
 * Adversarial config for the core runtime differential suite: async hooks with different tick
 * counts, cross-field mutation through siblingData/req.context, identity stashing, errors thrown
 * synchronously and asynchronously, thenables, localized hooks per locale, defaults, access,
 * blocks/blockReferences, tabs, virtual fields and population. Hooks are deterministic per request
 * (all state lives in `req.context`), so TS and Rust runs are comparable.
 */
import type { Block, CollectionConfig, Field, FieldHook } from 'payload'

import { fileURLToPath } from 'node:url'
import path from 'path'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) {
    await null
  }
}

const steps = (context: Record<string, unknown>): string[] =>
  ((context.steps as string[] | undefined) ??= [])

/** Logs its start, awaits `n` microtasks, logs its end, optionally transforms the value. */
const tickHook =
  (label: string, n: number, transform?: (v: any) => unknown): FieldHook =>
  async ({ context, path, siblingData, value }) => {
    steps(context).push(`${label}:start:${path.join('.')}`)
    await ticks(n)
    steps(context).push(`${label}:end:${path.join('.')}:${JSON.stringify(siblingData)?.length}`)
    return transform ? transform(value) : undefined
  }

const syncHook =
  (label: string, transform?: (v: any) => unknown): FieldHook =>
  ({ context, path, value }) => {
    steps(context).push(`${label}:sync:${path.join('.')}`)
    return transform ? transform(value) : undefined
  }

class CustomHookError extends Error {
  code = 'CUSTOM'
}

const leafFields = (prefix: string): Field[] => [
  {
    name: `${prefix}A`,
    type: 'text',
    hooks: { afterRead: [tickHook(`${prefix}A`, 2, (v) => `${v ?? ''}~`)] },
  },
  {
    name: `${prefix}B`,
    type: 'number',
    hooks: { afterRead: [syncHook(`${prefix}B`, (v) => (v ?? 0) + 1)] },
  },
  {
    name: `${prefix}C`,
    type: 'text',
    defaultValue: async () => {
      await null
      return `${prefix}-default`
    },
  },
]

const referencedBlock: Block = {
  slug: 'referenced',
  fields: [
    { name: 'refText', type: 'text', hooks: { afterRead: [tickHook('refText', 1)] } },
    { name: 'refArray', type: 'array', fields: leafFields('refRow') },
  ],
}

// A fresh object per blocks field: drizzle keys block tables by block object identity.
const inlineBlock = (slug = 'inline'): Block => ({
  slug,
  fields: [
    {
      name: 'blockText',
      type: 'text',
      hooks: {
        afterRead: [
          async ({ blockData, context, value }) => {
            steps(context).push(`blockText:${(blockData as any)?.blockType}`)
            await ticks(1)
            return value
          },
        ],
      },
    },
    { name: 'blockSecret', type: 'text', access: { read: () => false } },
  ],
})

const openAccess = { create: () => true, delete: () => true, read: () => true, update: () => true }

const Authors: CollectionConfig = {
  slug: 'authors',
  access: openAccess,
  fields: [
    {
      name: 'name',
      type: 'text',
      hooks: { afterRead: [tickHook('author.name', 1, (v) => `${v}!`)] },
    },
    { name: 'bio', type: 'text', localized: true, defaultValue: 'no bio' },
  ],
}

const Interleave: CollectionConfig = {
  slug: 'interleave',
  access: openAccess,
  fields: [
    {
      name: 'title',
      type: 'text',
      hooks: {
        afterRead: [
          tickHook('title-a', 3, (v) => `${v}!`),
          syncHook('title-b'),
          async ({ context, siblingData, value }) => {
            // stash the sibling object; a later field mutates it after its own awaits
            context.stash = siblingData
            await new Promise((resolve) => setImmediate(resolve))
            steps(context).push(`title-c:after-immediate:${siblingData.counter}`)
            return value
          },
        ],
      },
    },
    {
      name: 'counter',
      type: 'number',
      hooks: {
        afterRead: [
          async ({ context, siblingData, value }) => {
            await ticks(1)
            steps(context).push(`counter:stash:${typeof context.stash}`)
            await ticks(6)
            if (context.stash) {
              ;(context.stash as any).fromCounter = `seen-title:${siblingData.title}`
            }
            return (value ?? 0) * 10
          },
        ],
      },
    },
    {
      name: 'thenable',
      type: 'text',
      hooks: {
        afterRead: [
          ({ context, value }) => ({
            then(resolve: (v: unknown) => void) {
              steps(context).push('thenable:then')
              resolve(`${value}-thenable`)
            },
          }),
          ({ value }) => Promise.resolve(Promise.resolve(`${value}-nested`)),
          () => null,
          () => 0,
        ],
      },
    },
    {
      name: 'localizedTitle',
      type: 'text',
      localized: true,
      hooks: {
        afterRead: [tickHook('localizedTitle', 2, (v) => (v === undefined ? v : `[${v}]`))],
      },
    },
    {
      name: 'secret',
      type: 'text',
      hidden: true,
      defaultValue: 'hidden-default',
      hooks: { afterRead: [syncHook('secret')] },
    },
    {
      name: 'denied',
      type: 'text',
      access: {
        read: async ({ context, doc, siblingData }: any) => {
          await ticks(2)
          return Boolean(doc?.allow ?? siblingData?.allow)
        },
      },
      defaultValue: 'denied-default',
    },
    { name: 'allow', type: 'checkbox' },
    {
      name: 'accessThis',
      type: 'text',
      access: {
        read(this: any, { req }: any) {
          return this === undefined ? false : Boolean(req)
        },
      },
    },
    { name: 'objectDefault', type: 'json', defaultValue: { nested: { a: 1 }, list: [1, 2] } },
    { name: 'nullDefault', type: 'text', defaultValue: null as any },
    {
      name: 'asyncDefault',
      type: 'text',
      defaultValue: async ({ locale }: any) => {
        await ticks(3)
        return `async-${locale}`
      },
    },
    { name: 'location', type: 'point' },
    {
      type: 'row',
      fields: [{ name: 'inRow', type: 'text', hooks: { afterRead: [tickHook('inRow', 1)] } }],
    },
    {
      type: 'collapsible',
      label: 'c',
      fields: [
        {
          name: 'inCollapsible',
          type: 'text',
          hooks: { afterRead: [tickHook('inCollapsible', 4)] },
        },
      ],
    },
    {
      name: 'group',
      type: 'group',
      fields: [
        ...leafFields('group'),
        { name: 'deepGroup', type: 'group', fields: leafFields('deep') },
      ],
    },
    { name: 'localizedGroup', type: 'group', localized: true, fields: leafFields('locGroup') },
    { type: 'group', label: 'unnamed', fields: leafFields('unnamedGroup') },
    {
      name: 'rows',
      type: 'array',
      fields: [
        ...leafFields('row'),
        { name: 'innerRows', type: 'array', fields: leafFields('inner') },
      ],
    },
    { name: 'localizedRows', type: 'array', localized: true, fields: leafFields('locRow') },
    {
      name: 'layout',
      type: 'blocks',
      blockReferences: ['referenced'],
      blocks: [],
    },
    { name: 'inlineLayout', type: 'blocks', blocks: [inlineBlock()] },
    {
      name: 'localizedLayout',
      type: 'blocks',
      localized: true,
      blocks: [inlineBlock('inlineLoc')],
    },
    {
      type: 'tabs',
      tabs: [
        {
          name: 'namedTab',
          fields: leafFields('namedTab'),
          hooks: { afterRead: [tickHook('namedTab', 1)] } as any,
        },
        { name: 'localizedTab', localized: true, fields: leafFields('locTab') },
        { label: 'Unnamed', fields: leafFields('unnamedTab') },
      ],
    },
    { name: 'author', type: 'relationship', relationTo: 'authors' },
    { name: 'authorName', type: 'text', virtual: 'author.name' },
    { name: 'authors', type: 'relationship', relationTo: 'authors', hasMany: true },
  ],
}

/** Plain leaf fields (no hooks): the engine's leaf fast paths. */
const plainLeaves = (prefix: string, withDefaults = true): Field[] => [
  { name: `${prefix}Text`, type: 'text' },
  { name: `${prefix}Num`, type: 'number' },
  {
    name: `${prefix}Def`,
    type: 'text',
    ...(withDefaults ? { defaultValue: () => `${prefix}-fn-default` } : {}),
  },
  { name: `${prefix}Json`, type: 'json', ...(withDefaults ? { defaultValue: { d: [1] } } : {}) },
]

/**
 * Mostly plain leaves around a few tick-counting hooks: runs of plain fields, hidden/access/
 * default/localized-in-localized plain leaves, unnamed containers, arrays whose rows are all
 * plain (with and without defaults), hooked plain leaves (hidden, default, several hooks).
 */
const Plain: CollectionConfig = {
  slug: 'plain',
  access: openAccess,
  fields: [
    ...plainLeaves('top'),
    { name: 'hiddenText', type: 'text', hidden: true },
    {
      name: 'readAccess',
      type: 'text',
      access: { read: ({ doc }: any) => doc?.allow !== false },
    },
    { name: 'allow', type: 'checkbox' },
    { name: 'staticDefault', type: 'text', defaultValue: 'static' },
    {
      // Awaits as many microtasks as its value is long, so concurrent docs settle around it at
      // points that depend on how many (already settled) promises each traversal pushed.
      name: 'probe',
      type: 'text',
      hooks: {
        afterRead: [
          async ({ context, value }) => {
            steps(context).push(`probe:start:${value}`)
            await ticks(typeof value === 'string' ? value.length : 0)
            steps(context).push(`probe:end:${value}`)
          },
        ],
      },
    },
    {
      type: 'row',
      fields: [
        ...plainLeaves('row', false),
        { name: 'rowProbe', type: 'text', hooks: { afterRead: [syncHook('rowProbe')] } },
      ],
    },
    { type: 'collapsible', label: 'c', fields: plainLeaves('coll') },
    { type: 'group', label: 'unnamed', fields: [{ type: 'row', fields: plainLeaves('nested') }] },
    {
      name: 'plainGroup',
      type: 'group',
      fields: [...plainLeaves('g', false), { name: 'id', type: 'text', hidden: true }],
    },
    { name: 'plainRows', type: 'array', fields: plainLeaves('r', false) },
    { name: 'defaultRows', type: 'array', fields: plainLeaves('d') },
    {
      name: 'mixedRows',
      type: 'array',
      fields: [
        ...plainLeaves('m', false),
        { name: 'mProbe', type: 'text', hooks: { afterRead: [tickHook('mProbe', 1)] } },
      ],
    },
    {
      name: 'locRows',
      type: 'array',
      localized: true,
      fields: [
        { name: 'locLeaf', type: 'text', localized: true },
        { name: 'locPlain', type: 'text' },
      ],
    },
    { name: 'locText', type: 'text', localized: true },
    {
      name: 'hookedHidden',
      type: 'text',
      hidden: true,
      hooks: { afterRead: [syncHook('hookedHidden', (v) => v)] },
    },
    {
      name: 'hookedDefault',
      type: 'text',
      defaultValue: 'hd',
      hooks: { afterRead: [tickHook('hookedDefault', 2)] },
    },
    {
      name: 'multiHook',
      type: 'text',
      hooks: {
        afterRead: [
          syncHook('mh1', (v) => `${v}1`),
          tickHook('mh2', 1, (v) => `${v}2`),
          syncHook('mh3'),
        ],
      },
    },
    ...plainLeaves('tail', false),
  ],
}

const Throwing: CollectionConfig = {
  slug: 'throwing',
  access: openAccess,
  fields: [
    { name: 'before', type: 'text', hooks: { afterRead: [tickHook('before', 1)] } },
    {
      name: 'syncThrow',
      type: 'text',
      hooks: {
        afterRead: [
          ({ value }) => {
            if (value === 'sync') {
              throw new CustomHookError('sync throw')
            }
            return value
          },
        ],
      },
    },
    {
      name: 'asyncThrow',
      type: 'text',
      hooks: {
        afterRead: [
          async ({ value }) => {
            await ticks(2)
            if (value === 'async') {
              throw new CustomHookError('async throw')
            }
            return value
          },
        ],
      },
    },
    {
      name: 'accessThrow',
      type: 'text',
      access: {
        read: ({ doc }: any) => {
          if (doc?.accessThrow === 'access') {
            throw new TypeError('access throw')
          }
          return true
        },
      },
    },
    { name: 'after', type: 'text', hooks: { afterRead: [tickHook('after', 3)] } },
    { name: 'group', type: 'group', fields: leafFields('throwGroup') },
    { name: 'layout', type: 'blocks', blocks: [inlineBlock()] },
  ],
}

export default buildConfigWithDefaults({
  suite: '__rs/core-runtime',
  config: {
    admin: { importMap: { baseDir: path.resolve(dirname) } },
    blocks: [referencedBlock],
    collections: [Authors, Interleave, Throwing, Plain],
    localization: { defaultLocale: 'en', fallback: true, locales: ['en', 'es', 'de'] },
    typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
  },
  seed: async (payload) => {
    const author = await payload.create({
      collection: 'authors',
      data: { name: 'Ann', bio: 'en bio' },
    })
    await payload.update({
      collection: 'authors',
      id: author.id,
      data: { bio: 'es bio' },
      locale: 'es',
    })
    const leaf = { rowA: 'a', rowB: 1, innerRows: [{ innerA: 'x', innerB: 2 }, { innerA: 'y' }] }
    const doc = await payload.create({
      collection: 'interleave',
      data: {
        allow: true,
        author: author.id,
        authors: [author.id, author.id],
        counter: 3,
        group: { groupA: 'g', deepGroup: { deepA: 'd' } },
        localizedRows: [{ locRowA: 'en-row' }],
        localizedTitle: 'en title',
        location: [10, 20],
        namedTab: { namedTabA: 'nt' },
        rows: [leaf, { rowA: 'b' }],
        thenable: 't',
        title: 'Hello',
      } as any,
    })
    await payload.update({
      collection: 'interleave',
      id: doc.id,
      data: { localizedTitle: '', localizedRows: [], localizedTab: { locTabA: 'es tab' } } as any,
      locale: 'es',
    })
    await payload.create({ collection: 'interleave', data: { title: 'second', counter: 1 } as any })
    const plainRow = { rText: 'r', rNum: 1, rJson: { x: 1 } }
    const plain = await payload.create({
      collection: 'plain',
      data: {
        allow: true,
        defaultRows: [{ dText: 'd', dNum: 2 }, { dText: 'e' }],
        hiddenText: 'h',
        hookedHidden: 'hh',
        locRows: [{ locLeaf: 'en-leaf', locPlain: 'en-plain' }],
        locText: 'en',
        mixedRows: [{ mText: 'm' }, { mNum: 3 }],
        multiHook: 'v',
        probe: 'abcdefgh',
        plainGroup: { gText: 'g', id: 'gid' },
        plainRows: [plainRow, { rText: 's' }, plainRow],
        readAccess: 'ra',
        topText: 'top',
        topNum: 7,
      } as any,
    })
    await payload.update({
      collection: 'plain',
      id: plain.id,
      data: { locRows: [{ locLeaf: 'es-leaf' }], locText: 'es' } as any,
      locale: 'es',
    })
    await payload.create({ collection: 'plain', data: { allow: false, topText: 'denied' } as any })
    // throwing values only come from raw edge docs (create would run afterRead and throw)
    for (const data of [{ before: 'ok' }, { after: 'fine', group: { throwGroupA: 'g' } }]) {
      await payload.create({ collection: 'throwing', data: data as any })
    }
  },
})
