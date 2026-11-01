/**
 * Adversarial config for the beforeChange differential suite: field hooks with different tick
 * counts (sync, async, thenables, setImmediate), cross-field mutation through siblingData and
 * req.context, custom validators (sync/async, string/non-string results, throws), admin
 * conditions, label functions / `label: false` / translated labels, localized fields (scalars,
 * arrays, blocks, groups, tabs), blocks with filterOptions, json and point transforms, invalid
 * value shapes and polymorphic hasMany relationships. Everything is deterministic per request (all
 * state lives in `req.context`), so TS and Rust runs are comparable.
 */
import type { Block, CollectionConfig, Field, FieldHook, GlobalConfig, Validate } from 'payload'

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
    // generated row ids are masked so a truncated id is not compared
    return JSON.stringify(v)
      ?.replace(/[0-9a-f]{24}/g, '<oid>')
      .slice(0, 80)
  } catch {
    return typeof v
  }
}

/** Logs start/end around `n` microtasks, optionally transforms the value. */
const tickHook =
  (label: string, n: number, transform?: (v: any) => unknown): FieldHook =>
  async ({ context, path, previousValue, siblingData, value }) => {
    steps(context).push(
      `${label}:start:${path.join('.')}:${describe(value)}:${describe(previousValue)}`,
    )
    await ticks(n)
    steps(context).push(`${label}:end:${path.join('.')}:${describe(siblingData)}`)
    return transform ? transform(value) : undefined
  }

const syncHook =
  (label: string, transform?: (v: any) => unknown): FieldHook =>
  ({ context, operation, path, schemaPath, indexPath, value }) => {
    steps(context).push(
      `${label}:sync:${operation}:${path.join('.')}:${schemaPath.join('.')}:${indexPath.join('-')}:${describe(value)}`,
    )
    return transform ? transform(value) : undefined
  }

class CustomError extends Error {
  code = 'CUSTOM'
}

/** Validator: logs, awaits `n` ticks, fails for `bad*` strings. */
const tickValidate =
  (label: string, n: number): Validate =>
  async (value, { data, event, operation, path, previousValue, req, siblingData }: any) => {
    steps(req.context).push(
      `validate:${label}:${req.locale}:${path?.join('.')}:${event}:${operation}:${describe(value)}:${describe(previousValue)}:${describe(siblingData)?.length}:${describe(data)?.length}`,
    )
    await ticks(n)
    if (typeof value === 'string' && value.startsWith('bad')) {
      return `${label} is bad (${req.locale})`
    }
    return true
  }

const leafFields = (prefix: string): Field[] => [
  {
    name: `${prefix}A`,
    type: 'text',
    hooks: {
      beforeChange: [tickHook(`${prefix}A`, 2, (v) => (typeof v === 'string' ? `${v}~` : v))],
    },
    validate: tickValidate(`${prefix}A`, 1),
  },
  {
    name: `${prefix}B`,
    type: 'number',
    hooks: { beforeChange: [syncHook(`${prefix}B`)] },
  },
  {
    name: `${prefix}C`,
    type: 'text',
    label: ({ t }) => `label-${prefix}C-${typeof t}`,
    required: true,
  },
]

const referencedBlock: Block = {
  slug: 'referenced',
  labels: { plural: 'Refs', singular: ({ t }) => `Ref-${typeof t}` },
  fields: [
    {
      name: 'refText',
      type: 'text',
      hooks: { beforeChange: [tickHook('refText', 1)] },
      validate: tickValidate('refText', 2),
    },
    { name: 'refArray', type: 'array', fields: leafFields('refRow') },
    { name: 'refLocalized', type: 'text', localized: true, validate: tickValidate('refLoc', 0) },
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
        beforeChange: [
          async ({ blockData, context, value }) => {
            steps(context).push(`blockText:${(blockData as any)?.blockType}:${describe(value)}`)
            await ticks(1)
            return value
          },
        ],
      },
      validate: tickValidate('blockText', 1),
    },
    { name: 'blockNumber', type: 'number', min: 0 },
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
        beforeChange: [
          tickHook('title-a', 3, (v) => (typeof v === 'string' ? `${v}!` : v)),
          syncHook('title-b'),
          async ({ context, siblingData, value }) => {
            // stash the sibling object; a later field mutates it after its own awaits
            context.stash = siblingData
            await new Promise((resolve) => setImmediate(resolve))
            steps(context).push(`title-c:after-immediate:${describe(siblingData.counter)}`)
            return value
          },
        ],
      },
      validate: tickValidate('title', 2),
    },
    {
      name: 'counter',
      type: 'number',
      hooks: {
        beforeChange: [
          async ({ context, siblingData, value }) => {
            await ticks(1)
            steps(context).push(`counter:stash:${typeof context.stash}`)
            await ticks(6)
            if (context.stash) {
              ;(context.stash as any).fromCounter = `seen-title:${describe(siblingData.title)}`
            }
            return typeof value === 'number' ? value * 10 : value
          },
        ],
      },
      max: 1000,
    },
    {
      name: 'thenable',
      type: 'text',
      hooks: {
        beforeChange: [
          ({ context, value }) => ({
            then(resolve: (v: unknown) => void) {
              steps(context).push('thenable:then')
              resolve(typeof value === 'string' ? `${value}-thenable` : value)
            },
          }),
          ({ value }) => Promise.resolve(Promise.resolve(value)),
          () => undefined,
          ({ value }) => (value === 'null-it' ? null : undefined),
        ],
      },
    },
    {
      name: 'validated',
      type: 'text',
      validate: ((value: unknown, { req }: any) => {
        steps(req.context).push(`validated:${describe(value)}`)
        if (value === 'false') {
          return false
        }
        if (value === 'number') {
          return 42
        }
        if (value === 'object') {
          return { message: 'not a string' }
        }
        if (value === 'empty') {
          return ''
        }
        if (value === 'thenable') {
          return { then: (resolve: (v: unknown) => void) => resolve('thenable says no') }
        }
        if (value === 'throw') {
          throw new CustomError('validate throw')
        }
        return value === 'bad' ? 'validated is bad' : true
      }) as any,
    },
    {
      name: 'conditional',
      type: 'text',
      admin: {
        condition: (data, siblingData, { operation, path, user }) => {
          return (
            Boolean(
              (siblingData as any)?.showConditional ??
              (data as any)?.title ??
              operation ??
              path ??
              user,
            ) && (siblingData as any)?.showConditional !== false
          )
        },
      },
      validate: tickValidate('conditional', 0),
    },
    { name: 'showConditional', type: 'checkbox' },
    {
      name: 'labelFalse',
      type: 'text',
      label: false,
      validate: tickValidate('labelFalse', 0),
    },
    {
      name: 'translatedLabel',
      type: 'text',
      label: { en: 'translated en', es: 'traducido' },
      validate: tickValidate('translated', 0),
    },
    {
      name: 'localizedTitle',
      type: 'text',
      localized: true,
      validate: tickValidate('locTitle', 1),
    },
    {
      name: 'localizedRequired',
      type: 'text',
      localized: true,
      hooks: { beforeChange: [syncHook('localizedRequired')] },
    },
    { name: 'jsonField', type: 'json' },
    {
      name: 'jsonCustom',
      type: 'json',
      validate: ((value: unknown, { jsonError, req }: any) => {
        steps(req.context).push(`jsonCustom:${jsonError?.constructor?.name}:${describe(value)}`)
        return jsonError ? `json error: ${jsonError.message}` : true
      }) as any,
    },
    { name: 'location', type: 'point' },
    { name: 'numbers', type: 'number', hasMany: true },
    { name: 'single', type: 'number' },
    { name: 'author', type: 'relationship', relationTo: 'authors' },
    { name: 'poly', type: 'relationship', relationTo: ['authors', 'changes'], hasMany: true },
    {
      type: 'row',
      fields: [{ name: 'inRow', type: 'text', hooks: { beforeChange: [tickHook('inRow', 1)] } }],
    },
    {
      type: 'collapsible',
      label: 'collapsed',
      fields: [
        {
          name: 'inCollapsible',
          type: 'text',
          hooks: { beforeChange: [tickHook('inCollapsible', 4)] },
          validate: tickValidate('inCollapsible', 3),
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
      label: ({ t }) => `Rows-${typeof t}`,
      fields: [
        ...leafFields('row'),
        { name: 'innerRows', type: 'array', label: false, fields: leafFields('inner') },
      ],
      minRows: 0,
      maxRows: 4,
    },
    { name: 'localizedRows', type: 'array', localized: true, fields: leafFields('locRow') },
    {
      name: 'layout',
      type: 'blocks',
      blockReferences: ['referenced'],
      blocks: [],
    },
    {
      name: 'inlineLayout',
      type: 'blocks',
      blocks: [inlineBlock(), inlineBlock('inlineOther')],
      filterOptions: ({ siblingData }: any) => {
        return siblingData?.title === 'only-inline' ? ['inline'] : true
      },
    },
    {
      name: 'restrictedLayout',
      type: 'blocks',
      blocks: [inlineBlock('restrictedA'), inlineBlock('restrictedB')],
      filterOptions: ['restrictedA'],
    },
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
          hooks: { beforeChange: [tickHook('namedTab', 1)] } as any,
        },
        { name: 'localizedTab', localized: true, fields: leafFields('locTab') },
        { label: 'Unnamed', fields: leafFields('unnamedTab') },
      ],
    },
  ],
}

const Throwing: CollectionConfig = {
  slug: 'throwing',
  access: openAccess,
  fields: [
    { name: 'before', type: 'text', hooks: { beforeChange: [tickHook('before', 1)] } },
    {
      name: 'syncThrow',
      type: 'text',
      hooks: {
        beforeChange: [
          ({ value }) => {
            if (value === 'sync') {
              throw new CustomError('sync throw')
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
        beforeChange: [
          async ({ value }) => {
            await ticks(2)
            if (value === 'async') {
              throw new CustomError('async throw')
            }
            return value
          },
        ],
      },
    },
    {
      name: 'validateThrow',
      type: 'text',
      validate: (async (value: unknown) => {
        await ticks(1)
        if (value === 'validate') {
          throw new TypeError('validate throw')
        }
        return true
      }) as any,
    },
    {
      name: 'conditionThrow',
      type: 'text',
      admin: {
        condition: (_data, siblingData) => {
          if ((siblingData as any)?.conditionThrow === 'condition') {
            throw new CustomError('condition throw')
          }
          return true
        },
      },
    },
    {
      name: 'freezer',
      type: 'text',
      hooks: {
        beforeChange: [
          ({ siblingData, value }) => {
            if (value === 'freeze') {
              Object.freeze(siblingData)
            }
            return undefined
          },
        ],
      },
    },
    {
      name: 'afterFreeze',
      type: 'text',
      hooks: { beforeChange: [async ({ value }) => (await ticks(1), `${value}-changed`)] },
    },
    { name: 'after', type: 'text', hooks: { beforeChange: [tickHook('after', 3)] } },
    { name: 'group', type: 'group', fields: leafFields('throwGroup') },
    { name: 'layout', type: 'blocks', blocks: [inlineBlock()] },
  ],
}

const Authors: CollectionConfig = {
  slug: 'authors',
  access: openAccess,
  fields: [
    { name: 'name', type: 'text', hooks: { beforeChange: [tickHook('author.name', 1)] } },
    { name: 'bio', type: 'text', localized: true },
  ],
}

const Settings: GlobalConfig = {
  slug: 'settings',
  access: { read: () => true, update: () => true },
  fields: [
    {
      name: 'siteName',
      type: 'text',
      hooks: {
        beforeChange: [tickHook('siteName', 2, (v) => (typeof v === 'string' ? v.trim() : v))],
      },
      validate: tickValidate('siteName', 1),
    },
    { name: 'localizedTagline', type: 'text', localized: true, required: true },
    { name: 'links', type: 'array', fields: leafFields('link') },
  ],
}

/**
 * Completion timing probe: `watcher` (doc B) logs, every microtask, the localized value of the
 * docs stashed by `stash` (doc A). Doc A's value changes when its merge-locale actions run, i.e.
 * after its whole (deeply nested) traversal settled, so the log pins the traversal's tick count.
 */
const Nested: CollectionConfig = {
  slug: 'nested',
  access: openAccess,
  fields: [
    {
      name: 'stash',
      type: 'text',
      hooks: {
        beforeChange: [
          ({ context, data, value }) => {
            if (value) {
              ;((context.stashes as undefined | unknown[]) ??= []).push(data)
            }
          },
        ],
      },
    },
    { name: 'loc', type: 'text', localized: true },
    {
      name: 'watcher',
      type: 'text',
      hooks: {
        beforeChange: [
          async ({ context, value }) => {
            if (value !== 'watch') {
              return
            }
            for (let i = 0; i < 60; i++) {
              await null
              steps(context).push(
                `watch:${i}:${describe((context.stashes as any[] | undefined)?.map((d) => d.loc))}`,
              )
            }
          },
        ],
      },
    },
    {
      type: 'tabs',
      tabs: [
        {
          label: 'outer',
          fields: [
            {
              type: 'collapsible',
              label: 'c',
              fields: [
                {
                  type: 'row',
                  fields: [
                    {
                      name: 'g',
                      type: 'group',
                      fields: [
                        { name: 'g2', type: 'group', fields: leafFields('g2') },
                        { name: 'arr', type: 'array', fields: leafFields('arr') },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
}

export default buildConfigWithDefaults({
  suite: '__rs/core-hooks-before-change',
  config: {
    admin: { importMap: { baseDir: path.resolve(dirname) } },
    blocks: [referencedBlock],
    collections: [Authors, Changes, Nested, Throwing],
    globals: [Settings],
    localization: {
      defaultLocale: 'en',
      fallback: true,
      locales: ['en', 'es', { code: 'de', fallbackLocale: 'en', label: 'German' }],
    },
    typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
  },
  seed: async (payload) => {
    const author = await payload.create({
      collection: 'authors',
      data: { name: 'Ann', bio: 'en bio' },
    })
    const leaf = (p: string) => ({ [`${p}A`]: 'a', [`${p}B`]: 1, [`${p}C`]: 'c' })
    const doc = await payload.create({
      collection: 'changes',
      data: {
        author: author.id,
        counter: 3,
        group: { ...leaf('group'), deepGroup: leaf('deep') },
        inlineLayout: [{ blockType: 'inline', blockText: 'one', blockNumber: 1 }],
        jsonCustom: { a: 1 },
        jsonField: [1, 2],
        localizedGroup: leaf('locGroup'),
        localizedLayout: [{ blockType: 'inlineLoc', blockText: 'loc' }],
        localizedRows: [leaf('locRow')],
        localizedTab: leaf('locTab'),
        localizedTitle: 'en title',
        location: [10, 20],
        namedTab: leaf('namedTab'),
        numbers: [1, 2, 3],
        poly: [{ relationTo: 'authors', value: author.id }],
        restrictedLayout: [{ blockType: 'restrictedA', blockText: 'ra' }],
        rows: [{ ...leaf('row'), innerRows: [leaf('inner'), leaf('inner')] }, leaf('row')],
        thenable: 't',
        title: 'Hello',
        unnamedGroupC: 'u',
        unnamedTabC: 'ut',
      } as any,
    })
    await payload.update({
      collection: 'changes',
      id: doc.id,
      data: {
        localizedTitle: 'es title',
        localizedRows: [],
        localizedTab: leaf('locTab'),
        localizedGroup: leaf('locGroup'),
      } as any,
      locale: 'es',
    })
    await payload.create({
      collection: 'changes',
      data: {
        title: 'second',
        counter: 1,
        unnamedGroupC: 'u',
        unnamedTabC: 'ut',
        group: { groupC: 'c', deepGroup: { deepC: 'c' } },
        localizedGroup: { locGroupC: 'c' },
        localizedTab: { locTabC: 'c' },
        namedTab: { namedTabC: 'c' },
      } as any,
    })
    for (const data of [{ before: 'ok' }, { after: 'fine', group: { throwGroupC: 'g' } }]) {
      await payload.create({
        collection: 'throwing',
        data: { ...data, group: { throwGroupC: 'g' } } as any,
      })
    }
    await payload.updateGlobal({
      slug: 'settings',
      data: { siteName: ' site ', localizedTagline: 'tag', links: [leaf('link')] } as any,
    })
  },
})
