import { fileURLToPath } from 'node:url'
import path from 'path'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * The perf suite's typical post with localization (en / de / fr) and a blocks field: the fused
 * creates' localized slice (packages/engine-rs/FUSED_WRITES.md section 13).
 */
export default buildConfigWithDefaults({
  suite: 'fuse-writes-lane-localized',
  config: {
    admin: {
      importMap: {
        baseDir: path.resolve(dirname),
      },
    },
    localization: {
      defaultLocale: 'en',
      fallback: true,
      locales: ['en', 'de', 'fr'],
    },
    collections: [
      {
        slug: 'authors',
        fields: [{ name: 'name', type: 'text' }],
      },
      {
        slug: 'categories',
        fields: [{ name: 'title', type: 'text', localized: true }],
      },
      {
        slug: 'posts',
        fields: [
          { name: 'title', type: 'text', index: true, localized: true, required: true },
          { name: 'views', type: 'number', defaultValue: 0 },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
          { name: 'slug', type: 'text', index: true, unique: true },
          { name: 'excerpt', type: 'textarea', localized: true },
          { name: 'content', type: 'richText', localized: true },
          {
            name: 'stage',
            type: 'select',
            defaultValue: 'draft',
            options: ['draft', 'review', 'published'].map((value) => ({ label: value, value })),
          },
          { name: 'publishedAt', type: 'date' },
          { name: 'featured', type: 'checkbox', defaultValue: false },
          { name: 'categories', type: 'relationship', hasMany: true, relationTo: 'categories' },
          { name: 'tags', type: 'array', fields: [{ name: 'tag', type: 'text' }] },
          {
            name: 'seo',
            type: 'group',
            fields: [
              { name: 'title', type: 'text', localized: true },
              { name: 'description', type: 'textarea', localized: true },
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
                  { name: 'items', type: 'array', fields: [{ name: 'label', type: 'text' }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
})
