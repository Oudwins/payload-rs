/**
 * Configs for the corners of `buildSchema` / `init` that no test/<suite>/config.ts reaches:
 * `dbName` functions (also a throwing one, after which upstream has registered some models),
 * localized unique points, localized polymorphic hasMany relationships, an `id` field nested in a
 * row, custom number IDs referenced by relationships, filename compound indexes, shared blocks.
 */
import type { Config } from 'payload'

import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { buildConfig } from 'payload'

const db = mongooseAdapter({ url: process.env.MONGODB_URL! })

const sharedDefault = ['a', 'b']

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
