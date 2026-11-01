/**
 * Config for the `rsq-*` query corpus suites: covers adapter options the upstream test configs
 * don't use with sqlite (`idType: 'uuid' | 'uuidv7'`, `blocksAsJSON`), plus drafts / versions,
 * localization, polymorphic and has-many relationships and join fields in one place.
 *
 * `RS_QUERY_ID_TYPE` (default `uuid`) and `RS_QUERY_BLOCKS_AS_JSON` (default `true`) pick the
 * adapter options.
 */
import type { CollectionConfig } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'

const idType = (process.env.RS_QUERY_ID_TYPE || 'uuid') as 'number' | 'uuid' | 'uuidv7'
const blocksAsJSON = process.env.RS_QUERY_BLOCKS_AS_JSON !== 'false'

const Categories: CollectionConfig = {
  slug: 'categories',
  fields: [
    { name: 'name', type: 'text' },
    { name: 'rank', type: 'number' },
    { name: 'posts', type: 'join', collection: 'posts', on: 'category' },
    { name: 'taggedPosts', type: 'join', collection: 'posts', on: 'categories' },
  ],
  versions: { drafts: true },
}

const Posts: CollectionConfig = {
  slug: 'posts',
  fields: [
    { name: 'title', type: 'text', localized: true },
    { name: 'views', type: 'number' },
    { name: 'publishedAt', type: 'date' },
    { name: 'featured', type: 'checkbox' },
    { name: 'tags', type: 'text', hasMany: true },
    { name: 'scores', type: 'number', hasMany: true },
    {
      name: 'flavors',
      type: 'select',
      hasMany: true,
      options: ['sweet', 'sour', 'salty'],
    },
    { name: 'status', type: 'select', options: ['draft', 'live'] },
    { name: 'category', type: 'relationship', relationTo: 'categories' },
    { name: 'categories', type: 'relationship', relationTo: 'categories', hasMany: true },
    { name: 'related', type: 'relationship', relationTo: ['categories', 'posts'] },
    {
      name: 'relatedMany',
      type: 'relationship',
      relationTo: ['categories', 'posts'],
      hasMany: true,
    },
    {
      name: 'meta',
      type: 'group',
      fields: [
        { name: 'summary', type: 'text', localized: true },
        { name: 'owner', type: 'relationship', relationTo: 'categories' },
      ],
    },
    {
      name: 'items',
      type: 'array',
      fields: [
        { name: 'label', type: 'text' },
        { name: 'amount', type: 'number' },
      ],
    },
    {
      name: 'layout',
      type: 'blocks',
      blocks: [
        {
          slug: 'hero',
          fields: [
            { name: 'heading', type: 'text' },
            { name: 'size', type: 'number' },
          ],
        },
        {
          slug: 'quote',
          fields: [
            { name: 'text', type: 'text' },
            { name: 'author', type: 'relationship', relationTo: 'categories' },
          ],
        },
      ],
    },
    { name: 'data', type: 'json' },
  ],
  versions: { drafts: true },
}

export default buildConfigWithDefaults({
  suite: 'rs-query',
  config: {
    collections: [Categories, Posts],
    db: sqliteAdapter({
      blocksAsJSON,
      client: { url: process.env.SQLITE_URL || 'file:./payload.db' },
      idType,
    }),
    localization: { defaultLocale: 'en', locales: ['en', 'es'] },
  },
})
