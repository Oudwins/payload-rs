import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { fileURLToPath } from 'node:url'
import path from 'path'

import { buildConfigWithDefaults } from '../../../buildConfigWithDefaults.js'
import { mongodbArgs } from '../../mongo-harness/args.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * The localized part of the write-side corpus (packages/engine-rs/FUSED_WRITES.md section 12):
 * localized scalars, relationships, rich text and containers (groups, arrays), localized fields
 * inside non-localized containers, on the TS engine (`PAYLOAD_ENGINE=ts`).
 */
export default buildConfigWithDefaults({
  suite: 'fuse-writes-localized',
  config: {
    admin: {
      importMap: {
        baseDir: path.resolve(dirname),
      },
    },
    // the harness reads the commands mongoose sends
    db: mongooseAdapter({ ...mongodbArgs(), connectOptions: { monitorCommands: true } }),
    localization: { defaultLocale: 'en', fallback: true, locales: ['en', 'de', 'fr'] },
    collections: [
      {
        slug: 'users',
        auth: true,
        fields: [{ name: 'name', type: 'text' }],
      },
      {
        slug: 'authors',
        fields: [
          { name: 'name', type: 'text', required: true },
          { name: 'bio', type: 'textarea', localized: true },
        ],
      },
      {
        slug: 'categories',
        fields: [{ name: 'title', type: 'text', required: true }],
      },
      {
        slug: 'posts',
        fields: [
          { name: 'title', type: 'text', localized: true, required: true },
          { name: 'views', type: 'number', defaultValue: 0 },
          { name: 'excerpt', type: 'textarea', localized: true },
          { name: 'content', type: 'richText', editor: lexicalEditor(), localized: true },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
          {
            name: 'editors',
            type: 'relationship',
            hasMany: true,
            localized: true,
            relationTo: 'authors',
          },
          {
            name: 'stage',
            type: 'select',
            defaultValue: 'draft',
            localized: true,
            options: ['draft', 'published'],
          },
          { name: 'publishedAt', type: 'date', localized: true },
          { name: 'count', type: 'number', defaultValue: 1, localized: true },
          {
            name: 'tags',
            type: 'array',
            localized: true,
            fields: [{ name: 'tag', type: 'text', required: true }],
          },
          {
            name: 'seo',
            type: 'group',
            localized: true,
            fields: [
              { name: 'title', type: 'text' },
              { name: 'description', type: 'textarea', defaultValue: 'd' },
            ],
          },
          {
            name: 'meta',
            type: 'group',
            fields: [
              { name: 'note', type: 'text', localized: true },
              { name: 'plain', type: 'text' },
            ],
          },
          {
            name: 'layout',
            type: 'blocks',
            localized: true,
            blocks: [
              { slug: 'hero', fields: [{ name: 'heading', type: 'text', required: true }] },
              { slug: 'quote', fields: [{ name: 'text', type: 'textarea', localized: true }] },
            ],
          },
          {
            name: 'rows',
            type: 'array',
            fields: [
              { name: 'label', type: 'text', localized: true },
              { name: 'size', type: 'number' },
            ],
          },
        ],
      },
    ],
  },
})
