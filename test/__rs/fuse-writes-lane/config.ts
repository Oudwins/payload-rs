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
    ],
    blocks: [{ slug: 'callout', fields: [{ name: 'note', type: 'text' }] }],
  },
})
