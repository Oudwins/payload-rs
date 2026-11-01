/**
 * Adversarial config for the afterChange/beforeDuplicate differential suite: hooks with different
 * tick counts, thenables, cross-field mutation through stashed siblingData/req.context, hooks
 * mutating the shared `path` array, last-hook-wins beforeDuplicate chains, disableDuplicate,
 * localized fields/arrays/blocks/groups/tabs (beforeDuplicate's detached traversals), sync/async
 * throws with a custom error class, rich text editor hooks and broken editors. Hooks are
 * deterministic per request (all state lives in `req.context`), so TS and Rust runs compare.
 */
import type { Block, CollectionConfig, Field, FieldHook, GlobalConfig } from 'payload'

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

const describe = (v: unknown) => {
  try {
    return JSON.stringify(v)?.slice(0, 60)
  } catch {
    return typeof v
  }
}

/** Logs start (with value/previousValue), awaits `n` microtasks, logs end, maybe transforms. */
const tickHook =
  (label: string, n: number, transform?: (v: any) => unknown): FieldHook =>
  async ({ context, path, previousValue, siblingData, value }) => {
    steps(context).push(
      `${label}:start:${path.join('.')}:${describe(value)}:${describe(previousValue)}`,
    )
    await ticks(n)
    steps(context).push(`${label}:end:${path.join('.')}:${describe(siblingData)?.length}`)
    return transform ? transform(value) : undefined
  }

const syncHook =
  (label: string, transform?: (v: any) => unknown): FieldHook =>
  ({ context, path, value }) => {
    steps(context).push(`${label}:sync:${path.join('.')}:${describe(value)}`)
    return transform ? transform(value) : undefined
  }

class CustomHookError extends Error {
  code = 'CUSTOM'
}

const leafFields = (prefix: string): Field[] => [
  {
    name: `${prefix}A`,
    type: 'text',
    hooks: {
      afterChange: [tickHook(`${prefix}A`, 2, (v) => `${v ?? ''}~`)],
      beforeDuplicate: [tickHook(`${prefix}A:dup`, 1, (v) => (v === undefined ? v : `${v}+`))],
    },
  },
  {
    name: `${prefix}B`,
    type: 'number',
    hooks: {
      afterChange: [syncHook(`${prefix}B`, (v) => (v ?? 0) + 1)],
      beforeDuplicate: [syncHook(`${prefix}B:dup`)],
    },
  },
  { name: `${prefix}C`, type: 'text', disableDuplicate: true } as Field,
]

const referencedBlock: Block = {
  slug: 'referenced',
  fields: [
    {
      name: 'refText',
      type: 'text',
      hooks: { afterChange: [tickHook('refText', 1)], beforeDuplicate: [syncHook('refText:dup')] },
    },
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
        afterChange: [
          async ({ blockData, context, value }) => {
            steps(context).push(`blockText:${(blockData as any)?.blockType}:${describe(value)}`)
            await ticks(1)
            return value === undefined ? value : `${value}#`
          },
        ],
        beforeDuplicate: [
          async ({ blockData, context, value }) => {
            steps(context).push(`blockText:dup:${(blockData as any)?.blockType}`)
            await ticks(2)
            return value
          },
        ],
      },
    },
    { name: 'blockNoDup', type: 'text', disableDuplicate: true } as Field,
  ],
})

const openAccess = { create: () => true, delete: () => true, read: () => true, update: () => true }

const Changes: CollectionConfig = {
  slug: 'changes',
  access: openAccess,
  fields: [
    {
      name: 'title',
      type: 'text',
      hooks: {
        afterChange: [
          tickHook('title-a', 3, (v) => `${v}!`),
          syncHook('title-b'),
          async ({ context, siblingData, value }) => {
            // stash the sibling object; a later field mutates it after its own awaits
            context.stash = siblingData
            await new Promise((resolve) => setImmediate(resolve))
            steps(context).push(`title-c:after-immediate:${(siblingData as any)?.fromCounter}`)
            return value
          },
        ],
        beforeDuplicate: [
          async ({ context, value }) => {
            steps(context).push(`title:dup1:${describe(value)}`)
            await ticks(2)
            return `${value} (copy)`
          },
          // last hook wins (returns undefined: the value is left untouched)
          ({ context }) => {
            steps(context).push('title:dup2')
          },
        ],
      },
    },
    {
      name: 'counter',
      type: 'number',
      hooks: {
        afterChange: [
          async ({ context, siblingData, value }) => {
            await ticks(1)
            steps(context).push(`counter:stash:${typeof context.stash}`)
            await ticks(6)
            if (context.stash && typeof context.stash === 'object') {
              ;(context.stash as any).fromCounter = `seen-title:${(siblingData as any)?.title}`
            }
            return (value ?? 0) * 10
          },
        ],
        beforeDuplicate: [
          (args: any) => {
            args.context.lastDupArgs = args
            return args.value
          },
          (args: any) => {
            // every hook of a field gets the same args object
            steps(args.context).push(`counter:dup:same-args:${args.context.lastDupArgs === args}`)
            delete args.context.lastDupArgs
            return typeof args.value === 'number' ? args.value + 100 : args.value
          },
        ],
      },
    },
    {
      name: 'pathMutator',
      type: 'text',
      hooks: {
        afterChange: [
          ({ context, path }) => {
            // the path array is shared with the next hook (and its getNestedValue lookup)
            path.push('mutated')
            steps(context).push(`pathMutator:1:${path.join('.')}`)
          },
          ({ context, path, previousValue, value }) => {
            steps(context).push(
              `pathMutator:2:${path.join('.')}:${describe(value)}:${describe(previousValue)}`,
            )
            path.length = 0
          },
          ({ context, path, previousValue, value }) => {
            // empty path: getNestedValue returns the whole sibling object
            steps(context).push(`pathMutator:3:${typeof value}:${typeof previousValue}`)
            return path.length === 0 ? 'path-emptied' : value
          },
        ],
      },
    },
    {
      name: 'thenable',
      type: 'text',
      hooks: {
        afterChange: [
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
        beforeDuplicate: [
          ({ context, value }) => ({
            then(resolve: (v: unknown) => void) {
              steps(context).push('thenable:dup:then')
              resolve(`${value}-dup-thenable`)
            },
          }),
        ],
      },
    },
    {
      name: 'localizedTitle',
      type: 'text',
      localized: true,
      hooks: {
        afterChange: [tickHook('localizedTitle', 2, (v) => (v === undefined ? v : `[${v}]`))],
        beforeDuplicate: [
          async ({ context, value }) => {
            await ticks(1)
            steps(context).push(`localizedTitle:dup:${describe(value)}`)
            return value ? `${value}-dup` : undefined
          },
        ],
      },
    },
    { name: 'noDup', type: 'text', disableDuplicate: true } as Field,
    {
      type: 'row',
      fields: [
        {
          name: 'inRow',
          type: 'text',
          // the row traverses a `{ ...siblingDoc }` copy: this return value is lost upstream
          hooks: { afterChange: [tickHook('inRow', 1, (v) => `${v}-row`)] },
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'c',
      fields: [
        {
          name: 'inCollapsible',
          type: 'text',
          hooks: {
            afterChange: [tickHook('inCollapsible', 4)],
            beforeDuplicate: [syncHook('inCollapsible:dup', (v) => `${v}-c`)],
          },
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
    {
      name: 'localizedGroup',
      type: 'group',
      localized: true,
      fields: leafFields('locGroup'),
    },
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
      name: 'localizedRows',
      type: 'array',
      localized: true,
      fields: leafFields('locRow'),
      hooks: {
        beforeDuplicate: [
          ({ context, value }) => {
            steps(context).push(`localizedRows:dup:${describe(value)}`)
            return Array.isArray(value) ? value : undefined
          },
        ],
      },
    },
    { name: 'layout', type: 'blocks', blockReferences: ['referenced'], blocks: [] },
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
          hooks: {
            afterChange: [tickHook('namedTab', 1)],
            beforeDuplicate: [syncHook('namedTab:dup')],
          } as any,
        },
        { name: 'localizedTab', localized: true, fields: leafFields('locTab') },
        { label: 'Unnamed', fields: leafFields('unnamedTab') },
      ],
    },
    { name: 'body', type: 'richText' },
    { name: 'author', type: 'relationship', relationTo: 'changes' },
  ],
}

const Throwing: CollectionConfig = {
  slug: 'throwing',
  access: openAccess,
  fields: [
    { name: 'before', type: 'text', hooks: { afterChange: [tickHook('before', 1)] } },
    {
      name: 'syncThrow',
      type: 'text',
      hooks: {
        afterChange: [
          ({ value }) => {
            if (value === 'sync') {
              throw new CustomHookError('sync throw')
            }
            return value
          },
        ],
        beforeDuplicate: [
          ({ value }) => {
            if (value === 'sync') {
              throw new CustomHookError('dup sync throw')
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
        afterChange: [
          async ({ value }) => {
            await ticks(2)
            if (value === 'async') {
              throw new CustomHookError('async throw')
            }
            return value
          },
        ],
        beforeDuplicate: [
          async ({ value }) => {
            await ticks(1)
            if (value === 'async') {
              throw new TypeError('dup async throw')
            }
            return value
          },
        ],
      },
    },
    { name: 'after', type: 'text', hooks: { afterChange: [tickHook('after', 3)] } },
    { name: 'group', type: 'group', fields: leafFields('throwGroup') },
    {
      name: 'locRows',
      type: 'array',
      localized: true,
      fields: [
        {
          name: 'boom',
          type: 'text',
          hooks: {
            beforeDuplicate: [
              async ({ value }) => {
                await ticks(1)
                if (value === 'boom') {
                  // runs in a detached traversal upstream: an unhandled rejection
                  throw new CustomHookError('detached boom')
                }
                return value
              },
            ],
          },
        },
      ],
    },
    { name: 'layout', type: 'blocks', blocks: [inlineBlock()] },
    { name: 'locLayout', type: 'blocks', localized: true, blocks: [inlineBlock('throwLoc')] },
  ],
}

/** Rich text fields whose editor is broken in `prepare` (after sanitization), see synthetic spec. */
const BrokenEditors: CollectionConfig = {
  slug: 'brokenEditors',
  access: openAccess,
  fields: [
    { name: 'first', type: 'text', hooks: { afterChange: [tickHook('first', 2)] } },
    { name: 'missingEditor', type: 'richText' },
  ],
}

const UnsanitizedEditor: CollectionConfig = {
  slug: 'unsanitizedEditor',
  access: openAccess,
  fields: [{ name: 'functionEditor', type: 'richText' }],
}

const Settings: GlobalConfig = {
  slug: 'settings',
  access: { read: () => true, update: () => true },
  fields: [
    {
      name: 'siteName',
      type: 'text',
      hooks: { afterChange: [tickHook('siteName', 2, (v) => `${v}*`)] },
    },
    { name: 'links', type: 'array', fields: leafFields('link') },
    {
      type: 'tabs',
      tabs: [
        { name: 'seo', fields: leafFields('seo') },
        { label: 'Other', fields: leafFields('other') },
      ],
    },
  ],
}

export default buildConfigWithDefaults({
  suite: '__rs/core-hooks-after',
  config: {
    admin: { importMap: { baseDir: path.resolve(dirname) } },
    blocks: [referencedBlock],
    collections: [Changes, Throwing, BrokenEditors, UnsanitizedEditor],
    globals: [Settings],
    localization: { defaultLocale: 'en', fallback: true, locales: ['en', 'es', 'de'] },
    typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
  },
  seed: async (payload) => {
    const doc = await payload.create({
      collection: 'changes',
      data: {
        counter: 3,
        group: { groupA: 'g', deepGroup: { deepA: 'd' } },
        localizedRows: [{ locRowA: 'en-row' }],
        localizedTitle: 'en title',
        namedTab: { namedTabA: 'nt' },
        noDup: 'nd',
        rows: [{ rowA: 'a', rowB: 1, innerRows: [{ innerA: 'x' }] }, { rowA: 'b' }],
        thenable: 't',
        title: 'Hello',
      } as any,
    })
    await payload.update({
      collection: 'changes',
      id: doc.id,
      data: { localizedTitle: 'es title', localizedRows: [{ locRowA: 'es-row' }] } as any,
      locale: 'es',
    })
    await payload.create({ collection: 'changes', data: { title: 'second', counter: 1 } as any })
    await payload.create({ collection: 'throwing', data: { before: 'ok', after: 'fine' } as any })
    await payload.updateGlobal({
      slug: 'settings',
      data: { links: [{ linkA: 'l1' }], seo: { seoA: 's' }, siteName: 'Site' } as any,
    })
  },
})
