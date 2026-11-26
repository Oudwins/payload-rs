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
      {
        slug: 'media',
        fields: [],
        upload: { staticDir: path.resolve(dirname, 'media') },
      },
      {
        slug: 'withUploads',
        fields: [
          { name: 'image', type: 'upload', relationTo: 'media' },
          { name: 'required', type: 'upload', relationTo: 'media', required: true },
          { name: 'gallery', type: 'upload', hasMany: true, maxRows: 2, relationTo: 'media' },
          { name: 'either', type: 'upload', relationTo: ['media', 'authors'] },
        ],
      },
      {
        slug: 'jsons',
        fields: [
          { name: 'data', type: 'json' },
          { name: 'required', type: 'json', required: true },
          { name: 'withDefault', type: 'json', defaultValue: { a: [1, 2], b: { c: null } } },
          {
            name: 'rows',
            type: 'array',
            fields: [{ name: 'payload', type: 'json' }],
          },
        ],
      },
      {
        // compiled user validators (FUSED_WRITES.md section 12.7): what they read of the
        // options object, the merged data, ticks, identity, a throwing one
        slug: 'validated',
        fields: [
          { name: 'title', type: 'text', required: true },
          {
            // the perf suite's complex shape
            name: 'rating',
            type: 'number',
            max: 5,
            min: 0,
            validate: (value: unknown) =>
              value === undefined ||
              value === null ||
              Number.isInteger(value) ||
              'whole numbers only',
          },
          {
            name: 'mustCheck',
            type: 'checkbox',
            defaultValue: true,
            validate: (value: unknown) => (value ? true : 'This field is required.'),
          },
          {
            name: 'code',
            type: 'text',
            validate: (value: unknown, { operation, previousValue }: any) =>
              operation === 'update' && previousValue === 'locked' && value !== 'locked'
                ? `locked (was ${previousValue})`
                : true,
          },
          {
            name: 'short',
            type: 'text',
            maxLength: 5,
            validate: (value: unknown, { maxLength, name, path }: any) =>
              typeof value !== 'string' ||
              value.length <= maxLength ||
              `${name} at ${path.join('/')} longer than ${maxLength}`,
          },
          {
            name: 'needsUser',
            type: 'text',
            validate: (value: unknown, { req }: any) =>
              value === undefined || req.user ? true : 'login required',
          },
          {
            name: 'titleEcho',
            type: 'text',
            validate: (value: unknown, { data }: any) =>
              value === undefined || value === data.title || `not the title (${data.title})`,
          },
          {
            name: 'list',
            type: 'text',
            hasMany: true,
            validate: (value: unknown, { siblingData }: any) =>
              value === undefined || value === siblingData.list || 'merged list copied',
          },
          {
            name: 'range',
            type: 'group',
            fields: [
              { name: 'min', type: 'number' },
              {
                name: 'max',
                type: 'number',
                validate: (value: any, { siblingData }: any) =>
                  value === undefined ||
                  value === null ||
                  siblingData.min === undefined ||
                  siblingData.min === null ||
                  value >= siblingData.min ||
                  `below min ${siblingData.min}`,
              },
            ],
          },
          {
            name: 'rows',
            type: 'array',
            fields: [
              {
                name: 'label',
                type: 'text',
                validate: (value: unknown, { path, siblingData }: any) =>
                  value !== 'bad' || `bad at ${path.join('.')} (${Object.keys(siblingData)})`,
              },
            ],
          },
          {
            name: 'layout',
            type: 'blocks',
            blocks: [
              {
                slug: 'a',
                fields: [
                  {
                    name: 'text',
                    type: 'text',
                    validate: (value: unknown, { blockData }: any) =>
                      value !== 'bad' || `bad in ${blockData.blockType}`,
                  },
                ],
              },
            ],
          },
          {
            name: 'asyncChecked',
            type: 'text',
            validate: async (value: unknown) => value !== 'async' || 'async error',
          },
          {
            name: 'awaited',
            type: 'text',
            validate: async (value: unknown) => {
              if (value === 'wait') {
                await null
              }
              return true
            },
          },
          {
            // a function `filterOptions`: called (and the database read) for a truthy value only
            name: 'filtered',
            type: 'relationship',
            relationTo: 'authors',
            hasMany: true,
            filterOptions: ({ req }: any) =>
              req.payloadAPI === 'REST' ? req.method === 'POST' : true,
          },
          {
            name: 'throws',
            type: 'text',
            validate: (value: any) => value === undefined || value.length > 0 || 'empty',
          },
        ],
      },
      {
        // compiled user field hooks (FUSED_WRITES.md section 12.7): beforeValidate and
        // beforeChange computing a value from their arguments
        slug: 'fieldHooks',
        fields: [
          {
            name: 'title',
            type: 'text',
            required: true,
            hooks: {
              beforeValidate: [
                ({ value }: any) => (typeof value === 'string' ? value.trim() : value),
              ],
            },
          },
          {
            name: 'slug',
            type: 'text',
            hooks: {
              beforeChange: [
                ({ data, value }: any) =>
                  value ?? (typeof data.title === 'string' ? data.title.toLowerCase() : undefined),
              ],
            },
          },
          {
            name: 'length',
            type: 'number',
            hooks: { beforeChange: [({ siblingData }: any) => siblingData.title?.length] },
          },
          {
            name: 'internal',
            type: 'text',
            hooks: { beforeChange: [() => 'internal hook'] },
          },
          {
            name: 'kept',
            type: 'text',
            hooks: {
              beforeChange: [
                ({ operation, previousValue, value }: any) =>
                  operation === 'update' && value === undefined ? previousValue : value,
              ],
            },
          },
          {
            name: 'origin',
            type: 'text',
            hooks: {
              beforeValidate: [
                ({ collection, originalDoc, value }: any) =>
                  value === 'keep'
                    ? (originalDoc.title ?? null)
                    : value === 'slug'
                      ? collection.slug
                      : value,
              ],
            },
          },
          {
            name: 'tags',
            type: 'text',
            hasMany: true,
            hooks: {
              beforeValidate: [({ value }: any) => value],
              beforeChange: [({ value }: any) => (Array.isArray(value) ? [...value] : value)],
            },
          },
          {
            name: 'count',
            type: 'number',
            defaultValue: 1,
            hooks: {
              beforeValidate: [({ value }: any) => (typeof value === 'number' ? value * 2 : value)],
            },
            validate: (value: any) => value === undefined || value < 100 || 'too many',
          },
          {
            name: 'meta',
            type: 'group',
            fields: [
              {
                name: 'note',
                type: 'text',
                hooks: {
                  beforeChange: [
                    ({ previousSiblingDoc, value }: any) =>
                      value === undefined ? previousSiblingDoc.note : `${value}.`,
                  ],
                },
              },
            ],
          },
          {
            name: 'layout',
            type: 'blocks',
            blocks: [
              {
                slug: 'a',
                fields: [
                  {
                    name: 'text',
                    type: 'text',
                    hooks: {
                      beforeChange: [
                        ({ blockData, value }: any) =>
                          blockData.blockType === 'a' && typeof value === 'string'
                            ? `${value}!`
                            : value,
                      ],
                      beforeValidate: [({ blockData, value }: any) => blockData && value],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        // unnamed groups (test/versions' `Drafts` has one) and radio fields
        slug: 'grouped',
        fields: [
          {
            type: 'group',
            fields: [
              { name: 'title', type: 'text', label: 'Title', required: true },
              { name: 'views', type: 'number', defaultValue: 0, max: 10 },
            ],
          },
          {
            type: 'group',
            label: 'Meta',
            fields: [
              { name: 'summary', type: 'text', required: true, defaultValue: 's' },
              {
                type: 'group',
                label: false,
                fields: [{ name: 'deep', type: 'text', minLength: 3 }],
              },
            ],
          },
          {
            name: 'radio',
            type: 'radio',
            options: [
              { label: { en: 'One en', es: 'One es' }, value: 'one' },
              { label: 'Two', value: 'two' },
              'three',
            ],
          },
          {
            name: 'choice',
            type: 'radio',
            defaultValue: 'a',
            options: ['a', 'b'],
            required: true,
          },
          {
            name: 'named',
            type: 'group',
            fields: [
              {
                type: 'group',
                label: 'Inner',
                fields: [{ name: 'inner', type: 'text', required: true }],
              },
            ],
          },
          {
            name: 'rows',
            type: 'array',
            fields: [
              {
                type: 'group',
                fields: [
                  { name: 'cell', type: 'text', required: true },
                  { name: 'author', type: 'relationship', relationTo: 'authors' },
                ],
              },
            ],
          },
        ],
        versions: { drafts: true },
      },
      {
        // named tabs (the perf suite's complex shape has one), next to unnamed ones
        slug: 'tabbed',
        fields: [
          { name: 'title', type: 'text', required: true },
          {
            type: 'tabs',
            label: 'Sections',
            tabs: [
              {
                name: 'details',
                fields: [
                  { name: 'summary', type: 'text', required: true },
                  { name: 'score', type: 'number', defaultValue: 1, max: 10 },
                  { name: 'author', type: 'relationship', relationTo: 'authors' },
                  {
                    name: 'links',
                    type: 'array',
                    fields: [{ name: 'url', type: 'text', required: true }],
                  },
                ],
              },
              { label: 'Plain', fields: [{ name: 'flat', type: 'text', defaultValue: 'f' }] },
              {
                name: 'seo',
                label: { de: 'Suche', en: 'Search' },
                fields: [
                  { name: 'keywords', type: 'text', hasMany: true, maxRows: 2 },
                  { name: 'meta', type: 'group', fields: [{ name: 'note', type: 'text' }] },
                  {
                    type: 'tabs',
                    tabs: [
                      {
                        name: 'inner',
                        fields: [{ name: 'deep', type: 'text', required: true, defaultValue: 'd' }],
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
  },
})
