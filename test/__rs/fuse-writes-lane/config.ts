import { fileURLToPath } from 'node:url'
import path from 'path'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * The fused writes' shapes (packages/engine-rs/FUSED_WRITES.md section 11): `posts` is the perf
 * suite's `minimal` shape (text, number defaults, a relationship, versions on), `hooked` the same
 * with a user hook (ineligible: the exact lane), `rows` array rows (generated row ids) and a
 * group, `layouts` own blocks beside a global block and a relationship with a static
 * `filterOptions`.
 */
export default buildConfigWithDefaults({
  suite: 'fuse-writes-lane',
  config: {
    admin: {
      importMap: {
        baseDir: path.resolve(dirname),
      },
    },
    collections: [
      {
        slug: 'authors',
        fields: [{ name: 'name', type: 'text' }],
      },
      {
        slug: 'posts',
        fields: [
          { name: 'title', type: 'text', index: true, required: true },
          { name: 'views', type: 'number', defaultValue: 0 },
          { name: 'revision', type: 'number', defaultValue: 0 },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
        ],
      },
      {
        slug: 'unversioned',
        fields: [
          { name: 'title', type: 'text' },
          { name: 'views', type: 'number', defaultValue: 0 },
        ],
        versions: false,
      },
      {
        slug: 'categories',
        fields: [{ name: 'title', type: 'text' }],
      },
      {
        // the perf suite's `typical` post (test/__rs/perf/configs.mjs)
        slug: 'typical',
        fields: [
          { name: 'title', type: 'text', index: true, required: true },
          { name: 'views', type: 'number', defaultValue: 0 },
          { name: 'revision', type: 'number', defaultValue: 0 },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
          { name: 'slug', type: 'text', index: true, unique: true },
          { name: 'excerpt', type: 'textarea' },
          { name: 'content', type: 'richText' },
          {
            name: 'stage',
            type: 'select',
            defaultValue: 'draft',
            index: true,
            options: ['draft', 'review', 'published'].map((value) => ({ label: value, value })),
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
        slug: 'rows',
        fields: [
          { name: 'title', type: 'text' },
          { name: 'items', type: 'array', fields: [{ name: 'label', type: 'text' }] },
          { name: 'meta', type: 'group', fields: [{ name: 'note', type: 'text' }] },
        ],
      },
      {
        slug: 'hooked',
        fields: [{ name: 'title', type: 'text' }],
        hooks: {
          beforeChange: [({ data }) => ({ ...data, title: `${data.title}!` })],
        },
      },
      {
        // own blocks next to the config's global block, a static relationship filterOptions
        slug: 'layouts',
        fields: [
          { name: 'title', type: 'text' },
          {
            name: 'layout',
            type: 'blocks',
            blocks: [{ slug: 'text', fields: [{ name: 'body', type: 'text' }] }],
          },
          {
            name: 'author',
            type: 'relationship',
            filterOptions: { name: { not_equals: 'hidden' } },
            relationTo: 'authors',
          },
        ],
      },
      {
        slug: 'media',
        fields: [],
        upload: { staticDir: path.resolve(dirname, 'media') },
      },
      {
        // json, upload fields and named tabs
        slug: 'settings',
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'config', type: 'json', required: true },
          { name: 'cover', type: 'upload', relationTo: 'media' },
          {
            type: 'tabs',
            tabs: [
              {
                name: 'meta',
                fields: [
                  { name: 'extra', type: 'json', defaultValue: { on: true } },
                  { name: 'author', type: 'relationship', relationTo: 'authors' },
                ],
              },
            ],
          },
        ],
      },
      {
        // a json field with a `jsonSchema` and dates with timezones
        slug: 'events',
        fields: [
          { name: 'title', type: 'text', required: true },
          {
            name: 'details',
            type: 'json',
            jsonSchema: {
              fileMatch: ['a://b/details.json'],
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  seats: { type: 'integer', minimum: 1 },
                  tags: { type: 'array', items: { type: 'string' } },
                  venue: { enum: ['hall', 'park'] },
                },
                required: ['venue'],
              },
              uri: 'a://b/details.json',
            },
          },
          { name: 'startsAt', type: 'date', required: true, timezone: true },
          {
            name: 'endsAt',
            type: 'date',
            timezone: {
              defaultTimezone: 'Europe/London',
              supportedTimezones: [
                { label: 'London', value: 'Europe/London' },
                { label: 'Tokyo', value: 'Asia/Tokyo' },
              ],
            },
          },
          {
            name: 'slots',
            type: 'array',
            fields: [{ name: 'at', type: 'date', timezone: true }],
          },
        ],
        versions: { maxPerDoc: 2 },
      },
      {
        // array and blocks defaults (row ids for the default rows, mongoose's document array
        // defaults)
        slug: 'presets',
        fields: [
          { name: 'title', type: 'text' },
          {
            name: 'steps',
            type: 'array',
            defaultValue: [{ label: 'one' }, { label: 'two' }],
            fields: [{ name: 'label', type: 'text' }],
          },
          {
            name: 'layout',
            type: 'blocks',
            defaultValue: [{ blockType: 'card', note: 'n' }],
            blocks: [{ slug: 'card', fields: [{ name: 'note', type: 'text' }] }],
          },
          {
            name: 'meta',
            type: 'group',
            fields: [
              {
                name: 'links',
                type: 'array',
                defaultValue: [{ url: 'u' }],
                fields: [{ name: 'url', type: 'text' }],
              },
            ],
          },
        ],
        versions: true,
      },
      {
        // bulk writes without `overrideAccess` (REST): compiled collection access, field read
        // access, population of a collection whose read access depends on the user
        slug: 'notices',
        access: { delete: () => true, read: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
          {
            name: 'secret',
            type: 'text',
            access: { read: ({ req }) => Boolean(req.user) },
          },
        ],
      },
      {
        // a collection the fused reads do not serve (an afterRead hook) and documents relating
        // to it: their writes' result reads would load it
        slug: 'readHooked',
        fields: [{ name: 'title', type: 'text' }],
        hooks: { afterRead: [({ doc }) => doc] },
      },
      {
        slug: 'pointers',
        fields: [
          { name: 'title', type: 'text' },
          { name: 'target', type: 'relationship', relationTo: 'readHooked' },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
        ],
      },
      {
        slug: 'kept',
        access: { delete: () => true, read: () => true },
        disableBulkDelete: true,
        fields: [{ name: 'title', type: 'text' }],
      },
      {
        // slug fields: updates keeping the stored slug are fused, everything that looks one up
        // runs the exact lane
        slug: 'slugged',
        fields: [
          { name: 'title', type: 'text' },
          { name: 'slug', type: 'slug', useAsSlug: 'title' },
        ],
      },
      {
        // update / delete access returning a where constraint (the perf suite's complex posts):
        // combined into the stored-document read and the bulk writes' find
        slug: 'constrained',
        access: {
          delete: () => ({ views: { greater_than_equal: 0 } }),
          read: () => true,
          update: () => ({ views: { greater_than_equal: 0 } }),
        },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'views', type: 'number', defaultValue: 0 },
        ],
        versions: { maxPerDoc: 5 },
      },
      {
        // the same with drafts: getLatestCollectionVersion combines the constraint into the
        // latest version's find (`version.views`)
        slug: 'constrainedDrafts',
        access: {
          delete: () => ({ views: { greater_than_equal: 0 } }),
          read: () => true,
          update: () => ({ views: { greater_than_equal: 0 } }),
        },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'views', type: 'number', defaultValue: 0 },
        ],
        versions: { drafts: true },
      },
    ],
    blocks: [{ slug: 'callout', fields: [{ name: 'note', type: 'text' }] }],
  },
})
