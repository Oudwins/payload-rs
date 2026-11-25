import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { fileURLToPath } from 'node:url'
import path from 'path'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'
import { mongodbArgs } from '../mongo-harness/args.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const statuses = ['draft', 'review', 'published', 'archived']

/**
 * The write-side corpus of the fused MongoDB writes (packages/engine-rs/FUSED_WRITES.md section
 * 12), run on the TS engine (`PAYLOAD_ENGINE=ts`): `minimal` and `typical` are the perf suite's post shapes (test/__rs/perf/configs.mjs)
 * (`typical` with lexical's default features, like the perf suite's editor; `rich` with the test
 * suites' editor and its blocks, links and uploads), `kinds` covers every field type and validator
 * option the library models.
 */
export default buildConfigWithDefaults({
  suite: 'fuse-writes',
  config: {
    admin: {
      importMap: {
        baseDir: path.resolve(dirname),
      },
    },
    // the harness reads the commands mongoose sends
    db: mongooseAdapter({ ...mongodbArgs(), connectOptions: { monitorCommands: true } }),
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
          { name: 'bio', type: 'textarea' },
        ],
      },
      {
        slug: 'categories',
        fields: [{ name: 'title', type: 'text', required: true }],
      },
      {
        slug: 'drafts',
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'views', type: 'number', defaultValue: 0 },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
          { name: 'items', type: 'array', fields: [{ name: 'label', type: 'text' }] },
          { name: 'meta', type: 'group', fields: [{ name: 'note', type: 'text' }] },
        ],
        versions: { drafts: true },
      },
      {
        slug: 'validatedDrafts',
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'count', type: 'number', max: 10 },
        ],
        versions: { drafts: { validate: true } },
      },
      {
        slug: 'minimal',
        fields: [
          { name: 'title', type: 'text', index: true, required: true },
          { name: 'views', type: 'number', defaultValue: 0 },
          { name: 'revision', type: 'number', defaultValue: 0 },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
        ],
      },
      {
        slug: 'typical',
        fields: [
          { name: 'title', type: 'text', index: true, required: true },
          { name: 'views', type: 'number', defaultValue: 0 },
          { name: 'revision', type: 'number', defaultValue: 0 },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
          { name: 'slug', type: 'text', index: true, unique: true },
          { name: 'excerpt', type: 'textarea' },
          { name: 'content', type: 'richText', editor: lexicalEditor() },
          {
            name: 'stage',
            type: 'select',
            defaultValue: 'draft',
            index: true,
            options: statuses.map((value) => ({ label: value, value })),
          },
          { name: 'publishedAt', type: 'date', index: true },
          { name: 'featured', type: 'checkbox', defaultValue: false },
          { name: 'categories', type: 'relationship', hasMany: true, relationTo: 'categories' },
          { name: 'tags', type: 'array', fields: [{ name: 'tag', type: 'text' }] },
          {
            name: 'seo',
            type: 'group',
            fields: [
              { name: 'title', type: 'text' },
              { name: 'description', type: 'textarea' },
            ],
          },
        ],
      },
      {
        slug: 'pages',
        fields: [
          { name: 'title', type: 'text' },
          {
            name: 'layout',
            type: 'blocks',
            maxRows: 4,
            blocks: [
              {
                slug: 'hero',
                fields: [
                  { name: 'heading', type: 'text', required: true },
                  { name: 'sub', type: 'textarea', defaultValue: 's' },
                ],
              },
              {
                slug: 'gallery',
                labels: { plural: 'Galleries', singular: 'Gallery' },
                fields: [
                  { name: 'items', type: 'array', fields: [{ name: 'caption', type: 'text' }] },
                  { name: 'credit', type: 'group', fields: [{ name: 'name', type: 'text' }] },
                  { name: 'author', type: 'relationship', relationTo: 'authors' },
                ],
              },
              {
                slug: 'content',
                fields: [{ name: 'body', type: 'richText', editor: lexicalEditor() }],
              },
            ],
          },
        ],
      },
      {
        slug: 'rich',
        fields: [
          { name: 'body', type: 'richText' },
          { name: 'required', type: 'richText', editor: lexicalEditor(), required: true },
          {
            name: 'nested',
            type: 'group',
            fields: [{ name: 'text', type: 'richText', editor: lexicalEditor() }],
          },
          {
            name: 'items',
            type: 'array',
            fields: [{ name: 'text', type: 'richText', editor: lexicalEditor() }],
          },
        ],
      },
      {
        slug: 'kinds',
        fields: [
          { name: 'text', type: 'text', maxLength: 10, minLength: 2 },
          { name: 'textRequired', type: 'text', defaultValue: 'x', required: true },
          { name: 'texts', type: 'text', hasMany: true, maxRows: 3 },
          { name: 'textarea', type: 'textarea', maxLength: 20 },
          { name: 'email', type: 'email' },
          { name: 'number', type: 'number', max: 100, min: -100 },
          { name: 'numbers', type: 'number', hasMany: true, minRows: 1 },
          { name: 'checkbox', type: 'checkbox' },
          { name: 'date', type: 'date' },
          {
            name: 'select',
            type: 'select',
            options: ['a', 'b', { label: 'C', value: 'c' }],
          },
          { name: 'selects', type: 'select', hasMany: true, options: ['a', 'b', 'c'] },
          { name: 'rel', type: 'relationship', relationTo: 'authors' },
          { name: 'rels', type: 'relationship', hasMany: true, relationTo: 'categories' },
          { name: 'poly', type: 'relationship', relationTo: ['authors', 'categories'] },
          {
            name: 'polys',
            type: 'relationship',
            hasMany: true,
            relationTo: ['authors', 'categories'],
          },
          {
            name: 'group',
            type: 'group',
            fields: [
              { name: 'a', type: 'text', defaultValue: 'ga' },
              { name: 'n', type: 'number' },
              {
                name: 'inner',
                type: 'group',
                fields: [{ name: 'deep', type: 'text' }],
              },
            ],
          },
          {
            name: 'rows',
            type: 'array',
            maxRows: 4,
            fields: [
              { name: 'label', type: 'text', required: true },
              { name: 'count', type: 'number', defaultValue: 1 },
              { name: 'meta', type: 'group', fields: [{ name: 'note', type: 'text' }] },
              {
                name: 'children',
                type: 'array',
                fields: [{ name: 'name', type: 'text' }],
              },
            ],
          },
          {
            type: 'row',
            fields: [
              { name: 'inRow', type: 'text' },
              {
                type: 'collapsible',
                label: 'Collapsed',
                fields: [{ name: 'inCollapsible', type: 'number', defaultValue: 5 }],
              },
            ],
          },
          {
            type: 'tabs',
            tabs: [{ label: 'First', fields: [{ name: 'inTab', type: 'checkbox' }] }],
          },
        ],
      },
    ],
  },
})
