/**
 * Configs for the corners of `buildSchema` / `init` that no test/<suite>/config.ts reaches:
 * `dbName` functions (also a throwing one, after which upstream has registered some models),
 * localized unique points, localized polymorphic hasMany relationships, an `id` field nested in a
 * row, custom number IDs referenced by relationships, filename compound indexes, shared blocks.
 *
 * Review items of the live port (.rs-baseline/review-mongo-schema-sol.md):
 * - `interleaving`: a later collection's `dbName` function reads the models registered so far
 *   (`buildState.adapter.collections.first`), so it sees upstream's interleaving (item 1);
 * - `getters`: a `defaultValue` getter counting its reads (upstream reads it three times per
 *   `formatDefaultValue`) and a non-enumerable, an inherited `indexSortableFields` (items 3, 4);
 * - `throwingGetter`: an `index` getter that throws mid-build (the same error object must reject
 *   both builds, after the same partial registration; item 3).
 */
import type { Config } from 'payload'

import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { buildConfig } from 'payload'

const db = mongooseAdapter({ url: process.env.MONGODB_URL! })

const sharedDefault = ['a', 'b']

/** Per-build state the synthetic configs' callbacks read (reset by the spec before each build). */
export const buildState: { adapter: any; reads: number } = { adapter: undefined, reads: 0 }

export const getterError = new Error('index getter threw')

const base = (overrides: Partial<Config>): Promise<any> =>
  buildConfig({
    db,
    secret: 'mongo-schema-differential',
    typescript: { autoGenerate: false },
    ...overrides,
  } as Config)

export const syntheticConfigs = async (): Promise<Record<string, any>> => ({
  corners: await base({
    blocks: [
      {
        slug: 'sharedBlock',
        fields: [
          { name: 'title', type: 'text', unique: true },
          { name: 'items', type: 'array', fields: [{ name: 'value', type: 'number' }] },
        ],
      },
    ],
    collections: [
      {
        slug: 'numbered',
        dbName: (args: Record<string, unknown>) => `numbered_${Object.keys(args).length}`,
        fields: [
          { name: 'id', type: 'number' },
          { name: 'title', type: 'text', required: true, unique: true },
        ],
        versions: { drafts: { autosave: true } },
      },
      {
        slug: 'corners',
        fields: [
          { name: 'location', type: 'point', localized: true, unique: true },
          { name: 'plainLocation', type: 'point', defaultValue: [1, 2], index: false },
          {
            name: 'poly',
            type: 'relationship',
            hasMany: true,
            localized: true,
            relationTo: ['numbered', 'media'],
          },
          { name: 'single', type: 'relationship', relationTo: 'numbered', unique: true },
          { name: 'tags', type: 'select', hasMany: true, localized: true, options: ['x', 'y'] },
          { name: 'choice', type: 'radio', options: [{ label: 'A', value: 'a' }, 'b'] },
          { name: 'list', type: 'text', hasMany: true, defaultValue: sharedDefault },
          { name: 'secret', type: 'text', hidden: true, index: true },
          { name: 'when', type: 'date', defaultValue: new Date('2020-01-01T00:00:00.000Z') },
          {
            type: 'row',
            fields: [{ name: 'id', type: 'text' }],
          },
          {
            name: 'layout',
            type: 'blocks',
            localized: true,
            blockReferences: ['sharedBlock'],
            blocks: [],
          },
          {
            name: 'otherLayout',
            type: 'blocks',
            blockReferences: ['sharedBlock'],
            blocks: [{ slug: 'inline', fields: [{ name: 'json', type: 'json' }] }],
          },
          {
            type: 'tabs',
            tabs: [
              { name: 'named', localized: true, fields: [{ name: 'inner', type: 'text' }] },
              { label: 'Unnamed', fields: [{ name: 'flat', type: 'checkbox', unique: true }] },
            ],
          },
          {
            name: 'group',
            type: 'group',
            fields: [
              { name: 'id', type: 'text' },
              { name: 'nested', type: 'code' },
            ],
          },
        ],
        indexes: [{ fields: ['single', 'location'], unique: true }],
        versions: { drafts: true },
      },
      {
        slug: 'media',
        fields: [{ name: 'alt', type: 'text' }],
        upload: { filenameCompoundIndex: ['filename', 'alt'] },
      },
    ],
    globals: [
      {
        slug: 'settings',
        dbName: () => 'custom_settings',
        fields: [
          { name: 'id', type: 'text' },
          { name: 'site', type: 'text', localized: true },
        ],
        versions: { drafts: true },
      },
      { slug: 'plain', fields: [{ name: 'flag', type: 'checkbox' }] },
    ],
    localization: { defaultLocale: 'en', locales: ['en', 'de'] },
  }),
  interleaving: await base({
    collections: [
      { slug: 'first', fields: [{ name: 'title', type: 'text' }] },
      {
        slug: 'later',
        dbName: () => (buildState.adapter?.collections?.first ? 'later_after_first' : 'later_before_first'),
        fields: [{ name: 'title', type: 'text' }],
        versions: true,
      },
    ],
    globals: [
      {
        slug: 'globalAfter',
        dbName: () => (buildState.adapter?.globals ? 'global_after_globals' : 'global_before_globals'),
        fields: [{ name: 'flag', type: 'checkbox' }],
        versions: true,
      },
    ],
  }),
  getters: await (async () => {
    const config = await base({
      collections: [
        {
          slug: 'counted',
          fields: [
            { name: 'counter', type: 'text' },
            { name: 'sortable', type: 'number' },
          ],
          versions: { drafts: true },
        },
      ],
    })
    const field = config.collections[0].fields.find((f: any) => f.name === 'counter')
    Object.defineProperty(field, 'defaultValue', {
      configurable: true,
      enumerable: true,
      get: () => `read ${++buildState.reads}`,
    })
    // non-enumerable own indexSortableFields (still read by `payload.config.indexSortableFields`)
    Object.defineProperty(config, 'indexSortableFields', {
      configurable: true,
      enumerable: false,
      value: true,
      writable: true,
    })
    return config
  })(),
  inheritedIndexSortable: await (async () => {
    const config = await base({
      collections: [{ slug: 'plain', fields: [{ name: 'n', type: 'number' }], versions: true }],
    })
    delete config.indexSortableFields
    Object.setPrototypeOf(config, Object.create(Object.getPrototypeOf(config), {
      indexSortableFields: { configurable: true, enumerable: true, value: 1, writable: true },
    }))
    return config
  })(),
  throwingGetter: await (async () => {
    const config = await base({
      collections: [
        { slug: 'before', fields: [{ name: 'title', type: 'text' }], versions: true },
        {
          slug: 'throws',
          fields: [
            { name: 'ok', type: 'text' },
            { name: 'bad', type: 'text' },
          ],
        },
        { slug: 'after', fields: [{ name: 'title', type: 'text' }] },
      ],
    })
    const field = config.collections[1].fields.find((f: any) => f.name === 'bad')
    Object.defineProperty(field, 'index', {
      configurable: true,
      enumerable: true,
      get: () => {
        throw getterError
      },
    })
    return config
  })(),
  throwingDbName: await base({
    collections: [
      { slug: 'first', fields: [{ name: 'title', type: 'text' }], versions: true },
      {
        slug: 'second',
        dbName: () => {
          throw new Error('dbName threw')
        },
        fields: [{ name: 'title', type: 'text' }],
      },
      { slug: 'third', fields: [{ name: 'title', type: 'text' }] },
    ],
  }),
})
