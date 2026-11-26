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
        // localized fields: `_status` is localized (`localizeStatus`)
        slug: 'articles',
        fields: [
          { name: 'title', type: 'text', localized: true, required: true },
          { name: 'views', type: 'number', defaultValue: 0 },
          { name: 'tags', type: 'array', fields: [{ name: 'tag', type: 'text' }] },
        ],
        versions: { drafts: true },
      },
      {
        // no localized fields: a publish validates all locales (the prepare bails), drafts do not
        slug: 'notes',
        fields: [{ name: 'title', type: 'text', required: true }],
        versions: { drafts: true },
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
      {
        // drafts without localized fields: every publish validates all locales
        slug: 'bulletins',
        fields: [
          { name: 'title', type: 'text', required: true, maxLength: 20 },
          {
            name: 'items',
            type: 'array',
            fields: [{ name: 'item', type: 'text', required: true }],
          },
          { name: 'meta', type: 'group', fields: [{ name: 'count', type: 'number', max: 9 }] },
          {
            type: 'tabs',
            tabs: [{ name: 'extra', fields: [{ name: 'note', type: 'text', defaultValue: 'n' }] }],
          },
          { name: 'body', type: 'richText', editor: lexicalEditor() },
        ],
        versions: { drafts: true },
      },
      {
        // named tabs: localized, and not localized holding localized fields
        slug: 'magazines',
        fields: [
          { name: 'title', type: 'text', localized: true, required: true },
          {
            type: 'tabs',
            tabs: [
              {
                name: 'intro',
                localized: true,
                fields: [
                  { name: 'lead', type: 'text', required: true },
                  { name: 'words', type: 'number', defaultValue: 0 },
                  { name: 'items', type: 'array', fields: [{ name: 'item', type: 'text' }] },
                ],
              },
              {
                name: 'facts',
                fields: [
                  { name: 'caption', type: 'text', localized: true },
                  { name: 'pages', type: 'number', defaultValue: 1 },
                  { name: 'editor', type: 'relationship', relationTo: 'authors' },
                ],
              },
              { label: 'Plain', fields: [{ name: 'flat', type: 'text', localized: true }] },
            ],
          },
        ],
      },
    ],
  },
})
