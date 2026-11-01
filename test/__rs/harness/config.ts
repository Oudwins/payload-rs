/**
 * Config of the Rust-port parity suite (parity.int.spec.ts): every field type,
 * localized and not, nested containers, hasMany/polymorphic relationships and
 * uploads, joins, versions + drafts + autosave, globals and custom ids.
 */
import type { Block, CollectionConfig, Field, GlobalConfig } from 'payload'

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export const mediaDir = path.resolve(dirname, '.media')

const allow = () => true
const openAccess = {
  create: allow,
  delete: allow,
  read: allow,
  readVersions: allow,
  update: allow,
}

const blockC: Block = {
  slug: 'blockC',
  fields: [{ name: 'text', type: 'text' }],
}

const blockA: Block = {
  slug: 'blockA',
  fields: [
    { name: 'text', type: 'text' },
    { name: 'number', type: 'number' },
    { name: 'nestedBlocks', type: 'blocks', blocks: [blockC] },
  ],
}

const blockB: Block = {
  slug: 'blockB',
  fields: [
    { name: 'text', type: 'text' },
    { name: 'select', type: 'select', options: ['x', 'y', 'z'] },
    { name: 'array', type: 'array', fields: [{ name: 'text', type: 'text' }] },
  ],
}

/**
 * Every data field type. With `localized` the top-level data fields are
 * localized; without it, a few nested fields are localized instead
 * (localized-in-non-localized-container case).
 */
export const allFields = (localized: boolean): Field[] => {
  const l = localized ? { localized: true } : {}
  const nestedL = localized ? {} : { localized: true }
  return [
    { name: 'text', type: 'text', ...l },
    { name: 'textarea', type: 'textarea', ...l },
    { name: 'email', type: 'email', ...l },
    { name: 'code', type: 'code', ...l },
    { name: 'json', type: 'json', ...l },
    { name: 'number', type: 'number', ...l },
    { name: 'checkbox', type: 'checkbox', ...l },
    { name: 'date', type: 'date', ...l },
    { name: 'point', type: 'point', ...l },
    { name: 'radio', type: 'radio', options: ['a', 'b', 'c'], ...l },
    { name: 'select', type: 'select', options: ['one', 'two', 'three'], ...l },
    {
      name: 'selectMany',
      type: 'select',
      hasMany: true,
      options: ['red', 'green', 'blue'],
      ...l,
    },
    { name: 'textMany', type: 'text', hasMany: true, ...l },
    { name: 'numberMany', type: 'number', hasMany: true, ...l },
    { name: 'rel', type: 'relationship', relationTo: 'targets', ...l },
    { name: 'relMany', type: 'relationship', hasMany: true, relationTo: 'targets', ...l },
    { name: 'poly', type: 'relationship', relationTo: ['targets', 'media'], ...l },
    {
      name: 'polyMany',
      type: 'relationship',
      hasMany: true,
      relationTo: ['targets', 'media'],
      ...l,
    },
    { name: 'upload', type: 'upload', relationTo: 'media', ...l },
    { name: 'uploadMany', type: 'upload', hasMany: true, relationTo: 'media', ...l },
    { name: 'richText', type: 'richText', ...l },
    {
      name: 'group',
      type: 'group',
      ...l,
      fields: [
        { name: 'text', type: 'text' },
        { name: 'number', type: 'number' },
        { name: 'localizedText', type: 'text', ...nestedL },
        { name: 'nestedGroup', type: 'group', fields: [{ name: 'text', type: 'text' }] },
        { name: 'groupArray', type: 'array', fields: [{ name: 'text', type: 'text' }] },
      ],
    },
    {
      type: 'tabs',
      tabs: [
        {
          name: 'tabNamed',
          ...l,
          fields: [
            { name: 'text', type: 'text' },
            { name: 'number', type: 'number' },
          ],
        },
        {
          label: 'Unnamed',
          fields: [{ name: 'tabText', type: 'text', ...l }],
        },
      ],
    },
    { type: 'row', fields: [{ name: 'rowText', type: 'text', ...l }] },
    {
      type: 'collapsible',
      fields: [{ name: 'collapsibleText', type: 'text', ...l }],
      label: 'Collapsible',
    },
    {
      name: 'array',
      type: 'array',
      ...l,
      fields: [
        { name: 'text', type: 'text' },
        { name: 'number', type: 'number' },
        { name: 'rel', type: 'relationship', relationTo: 'targets' },
        { name: 'localizedText', type: 'text', ...nestedL },
        { name: 'nestedArray', type: 'array', fields: [{ name: 'text', type: 'text' }] },
      ],
    },
    { name: 'blocks', type: 'blocks', blocks: [blockA, blockB], ...l },
  ]
}

const Kitchen: CollectionConfig = {
  slug: 'kitchen',
  access: openAccess,
  fields: allFields(false),
}

const KitchenLocalized: CollectionConfig = {
  slug: 'kitchen-localized',
  access: openAccess,
  fields: allFields(true),
}

const Targets: CollectionConfig = {
  slug: 'targets',
  access: openAccess,
  fields: [
    { name: 'title', type: 'text' },
    { name: 'localizedTitle', type: 'text', localized: true },
    { name: 'number', type: 'number' },
    { name: 'kitchenRefs', type: 'join', collection: 'kitchen', on: 'rel' },
    { name: 'kitchenArrayRefs', type: 'join', collection: 'kitchen', on: 'array.rel' },
    { name: 'localizedRefs', type: 'join', collection: 'kitchen-localized', on: 'rel' },
  ],
}

const Media: CollectionConfig = {
  slug: 'media',
  access: openAccess,
  fields: [{ name: 'alt', type: 'text' }],
  upload: { staticDir: mediaDir },
}

const Drafts: CollectionConfig = {
  slug: 'drafts',
  access: openAccess,
  fields: [
    { name: 'title', type: 'text' },
    { name: 'localizedTitle', type: 'text', localized: true },
    { name: 'rel', type: 'relationship', relationTo: 'targets' },
    { name: 'array', type: 'array', fields: [{ name: 'text', type: 'text' }] },
  ],
  versions: { drafts: { autosave: true }, maxPerDoc: 5 },
}

const Versioned: CollectionConfig = {
  slug: 'versioned',
  access: openAccess,
  fields: [
    { name: 'title', type: 'text' },
    { name: 'localizedTitle', type: 'text', localized: true },
  ],
  versions: { drafts: false },
}

const CustomIDs: CollectionConfig = {
  slug: 'custom-ids',
  access: openAccess,
  fields: [
    { name: 'id', type: 'text' },
    { name: 'title', type: 'text' },
  ],
}

const Site: GlobalConfig = {
  slug: 'site',
  access: { read: allow, readVersions: allow, update: allow },
  fields: [
    { name: 'title', type: 'text' },
    { name: 'number', type: 'number' },
    { name: 'rel', type: 'relationship', relationTo: 'targets' },
    { name: 'array', type: 'array', fields: [{ name: 'text', type: 'text' }] },
  ],
  versions: { drafts: true },
}

const LocalizedGlobal: GlobalConfig = {
  slug: 'localized-global',
  access: { read: allow, readVersions: allow, update: allow },
  fields: [
    { name: 'title', type: 'text', localized: true },
    {
      name: 'items',
      type: 'array',
      localized: true,
      fields: [{ name: 'text', type: 'text' }],
    },
  ],
  versions: true,
}

export default buildConfigWithDefaults({
  config: {
    admin: { importMap: { baseDir: path.resolve(dirname) } },
    collections: [Kitchen, KitchenLocalized, Targets, Media, Drafts, Versioned, CustomIDs],
    globals: [Site, LocalizedGlobal],
    localization: {
      defaultLocale: 'en',
      fallback: true,
      locales: ['en', 'es', 'de'],
    },
    typescript: { autoGenerate: false },
  },
  disableMCP: true,
  suite: 'rs-parity',
})
