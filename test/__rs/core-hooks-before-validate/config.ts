/**
 * Adversarial config for the beforeValidate differential suite: async field hooks with different
 * tick counts, thenables, cross-field mutation through siblingData/data/req.context, identity
 * stashing, access results that are not booleans, sync/async/access throws, defaults of every
 * kind, id coercion (number/text ids), relationship id coercion to numeric-id collections
 * (single, hasMany, polymorphic), points, checkboxes, numbers, blocks/blockReferences, tabs,
 * groups, rows and a top-level `_status` field (docForHooks policy doc). Hooks are deterministic
 * per request (all state lives in `req.context`), so TS and Rust runs are comparable.
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
    steps(context).push(`${label}:start:${path.join('.')}:${typeof value}`)
    await ticks(n)
    steps(context).push(`${label}:end:${path.join('.')}:${JSON.stringify(siblingData)?.length}`)
    return transform ? transform(value) : undefined
  }

const syncHook =
  (label: string, transform?: (v: any) => unknown): FieldHook =>
  ({ context, path, previousValue, value }) => {
    steps(context).push(`${label}:sync:${path.join('.')}:${JSON.stringify(previousValue)}`)
    return transform ? transform(value) : undefined
  }

class CustomHookError extends Error {
  code = 'CUSTOM'
}

const leafFields = (prefix: string): Field[] => [
  {
    name: `${prefix}A`,
    type: 'text',
    hooks: { beforeValidate: [tickHook(`${prefix}A`, 2, (v) => (v === undefined ? v : `${v}~`))] },
  },
  {
    name: `${prefix}B`,
    type: 'number',
    hooks: { beforeValidate: [syncHook(`${prefix}B`)] },
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
    { name: 'refText', type: 'text', hooks: { beforeValidate: [tickHook('refText', 1)] } },
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
        beforeValidate: [
          async ({ blockData, context, value }) => {
            steps(context).push(`blockText:${(blockData as any)?.blockType}`)
            await ticks(1)
            return value
          },
        ],
      },
    },
    { name: 'blockNumber', type: 'number', defaultValue: 7 },
  ],
})

const openAccess = { create: () => true, delete: () => true, read: () => true, update: () => true }

const NumericIDs: CollectionConfig = {
  slug: 'numeric-ids',
  access: openAccess,
  fields: [
    { name: 'id', type: 'number' },
    { name: 'label', type: 'text' },
  ],
}

const TextIDs: CollectionConfig = {
  slug: 'text-ids',
  access: openAccess,
  fields: [
    { name: 'id', type: 'text' },
    { name: 'label', type: 'text' },
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
        beforeValidate: [
          tickHook('title-a', 3, (v) => (v === undefined ? v : `${v}!`)),
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
        beforeValidate: [
          async ({ context, data, siblingData, value }) => {
            await ticks(1)
            steps(context).push(`counter:stash:${typeof context.stash}:${typeof value}`)
            await ticks(6)
            if (context.stash) {
              ;(context.stash as any).fromCounter = `seen-title:${siblingData.title}`
            }
            if (data) {
              ;(data as any).touchedByCounter = true
            }
            return typeof value === 'number' ? value * 10 : value
          },
        ],
      },
    },
    {
      name: 'thenable',
      type: 'text',
      hooks: {
        beforeValidate: [
          ({ context, value }) => ({
            then(resolve: (v: unknown) => void) {
              steps(context).push('thenable:then')
              resolve(`${value}-thenable`)
            },
          }),
          ({ value }) => Promise.resolve(Promise.resolve(`${value}-nested`)),
          () => null,
          () => 0,
          () => undefined,
        ],
      },
    },
    {
      name: 'secret',
      type: 'text',
      defaultValue: 'secret-default',
      access: {
        // not a boolean: exercises `operation === 'update' || ... || accessResult`
        create: () => undefined as any,
        update: async () => {
          await ticks(2)
          return 0 as any
        },
      },
      hooks: { beforeValidate: [syncHook('secret')] },
    },
    {
      name: 'denied',
      type: 'text',
      defaultValue: 'denied-default',
      access: {
        create: async ({ data, siblingData }: any) => {
          await ticks(2)
          return Boolean(data?.allow ?? siblingData?.allow)
        },
        update: ({ doc }: any) => (doc?.allow ? 'yes' : null) as any,
      },
    },
    { name: 'allow', type: 'checkbox' },
    {
      name: 'accessThis',
      type: 'text',
      access: {
        create(this: any, { id, req }: any) {
          return this === undefined ? false : Boolean(req) && id === undefined
        },
        update(this: any, { id }: any) {
          return typeof this?.update === 'function' && id !== undefined
        },
      },
    },
    { name: 'objectDefault', type: 'json', defaultValue: { nested: { a: 1 }, list: [1, 2] } },
    {
      name: 'functionObjectDefault',
      type: 'json',
      defaultValue: ({ locale, user }: any) => ({ locale, user: user ?? 'anon' }),
    },
    { name: 'nullDefault', type: 'text', defaultValue: null as any },
    {
      name: 'asyncDefault',
      type: 'text',
      defaultValue: async ({ locale }: any) => {
        await ticks(3)
        return `async-${locale}`
      },
    },
    { name: 'count', type: 'number' },
    { name: 'counts', type: 'number', hasMany: true },
    { name: 'flag', type: 'checkbox', defaultValue: true },
    { name: 'location', type: 'point' },
    { name: 'numericRef', type: 'relationship', relationTo: 'numeric-ids' },
    { name: 'numericRefs', type: 'relationship', relationTo: 'numeric-ids', hasMany: true },
    { name: 'textRef', type: 'relationship', relationTo: 'text-ids' },
    {
      name: 'polyRef',
      type: 'relationship',
      relationTo: ['numeric-ids', 'text-ids'],
    },
    {
      name: 'polyRefs',
      type: 'relationship',
      relationTo: ['numeric-ids', 'text-ids'],
      hasMany: true,
    },
    {
      type: 'row',
      fields: [{ name: 'inRow', type: 'text', hooks: { beforeValidate: [tickHook('inRow', 1)] } }],
    },
    {
      type: 'collapsible',
      label: 'c',
      fields: [
        {
          name: 'inCollapsible',
          type: 'text',
          hooks: { beforeValidate: [tickHook('inCollapsible', 4)] },
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
    {
      name: 'layout',
      type: 'blocks',
      blockReferences: ['referenced'],
      blocks: [],
    },
    { name: 'inlineLayout', type: 'blocks', blocks: [inlineBlock()] },
    {
      type: 'tabs',
      tabs: [
        {
          name: 'namedTab',
          fields: leafFields('namedTab'),
          hooks: { beforeValidate: [tickHook('namedTab', 1)] } as any,
        },
        { name: 'localizedTab', localized: true, fields: leafFields('locTab') },
        { label: 'Unnamed', fields: leafFields('unnamedTab') },
      ],
    },
    {
      // a plain top-level `_status`: hooks see `docForHooks` as originalDoc/previousSiblingDoc
      name: '_status',
      type: 'text',
      access: { update: ({ doc }: any) => doc?._status !== 'locked' },
      hooks: {
        beforeValidate: [
          ({ context, originalDoc, previousSiblingDoc, previousValue, value }) => {
            steps(context).push(
              `_status:${JSON.stringify(previousValue)}:${originalDoc === previousSiblingDoc}:${typeof value}`,
            )
            return value
          },
        ],
      },
    },
  ],
}

const Throwing: CollectionConfig = {
  slug: 'throwing',
  access: openAccess,
  fields: [
    { name: 'before', type: 'text', hooks: { beforeValidate: [tickHook('before', 1)] } },
    {
      name: 'syncThrow',
      type: 'text',
      hooks: {
        beforeValidate: [
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
        beforeValidate: [
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
        create: ({ data }: any) => {
          if (data?.accessThrow === 'access') {
            throw new TypeError('access throw')
          }
          return true
        },
        update: ({ data }: any) => {
          if (data?.accessThrow === 'access') {
            throw new TypeError('access throw')
          }
          return true
        },
      },
    },
    {
      name: 'defaultThrow',
      type: 'text',
      defaultValue: ({ req }: any) => {
        if (req.context.throwDefault) {
          throw new CustomHookError('default throw')
        }
        return 'ok'
      },
    },
    { name: 'after', type: 'text', hooks: { beforeValidate: [tickHook('after', 3)] } },
    { name: 'group', type: 'group', fields: leafFields('throwGroup') },
    { name: 'layout', type: 'blocks', blocks: [inlineBlock()] },
  ],
}

export default buildConfigWithDefaults({
  suite: '__rs/core-hooks-before-validate',
  config: {
    admin: { importMap: { baseDir: path.resolve(dirname) } },
    blocks: [referencedBlock],
    collections: [NumericIDs, TextIDs, Interleave, Throwing],
    localization: { defaultLocale: 'en', fallback: true, locales: ['en', 'es', 'de'] },
    typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
  },
  seed: async (payload) => {
    await payload.create({ collection: 'numeric-ids', data: { id: 11, label: 'eleven' } })
    await payload.create({ collection: 'text-ids', data: { id: 't1', label: 'tee' } })
    const leaf = { rowA: 'a', rowB: 1, innerRows: [{ innerA: 'x', innerB: 2 }, { innerA: 'y' }] }
    await payload.create({
      collection: 'interleave',
      data: {
        allow: true,
        counter: 3,
        count: 4,
        counts: [1, 2],
        group: { groupA: 'g', deepGroup: { deepA: 'd' } },
        inlineLayout: [{ blockType: 'inline', blockText: 'one' }],
        location: [10, 20],
        namedTab: { namedTabA: 'nt' },
        numericRef: 11,
        numericRefs: [11],
        polyRef: { relationTo: 'numeric-ids', value: 11 },
        polyRefs: [
          { relationTo: 'text-ids', value: 't1' },
          { relationTo: 'numeric-ids', value: 11 },
        ],
        rows: [leaf, { rowA: 'b' }],
        textRef: 't1',
        thenable: 't',
        title: 'Hello',
      } as any,
    })
    await payload.create({ collection: 'interleave', data: { title: 'second', counter: 1 } as any })
    for (const data of [{ before: 'ok' }, { after: 'fine', group: { throwGroupA: 'g' } }]) {
      await payload.create({ collection: 'throwing', data: data as any })
    }
  },
})
