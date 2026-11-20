/**
 * Config of the live write differential (crates/payload-mongo-live-write): collections that reach
 * every branch of the db-mongodb write methods (custom text / number ids, unique and localized
 * unique indexes for duplicate key errors, numbers / arrays / hasMany relationships for the
 * `$inc` / `$push` / `$addToSet` / `$pull` operators, a point field for `near`, drafts for the
 * version models, a versioned global, the jobs collection).
 */
import { fileURLToPath } from 'node:url'
import path from 'path'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'
import { slugs } from './slugs.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default buildConfigWithDefaults({
  suite: 'mongo-live-writes',
  config: {
    admin: { importMap: { baseDir: path.resolve(dirname) } },
    collections: [
      {
        slug: slugs.categories,
        fields: [{ name: 'name', type: 'text' }],
      },
      {
        slug: slugs.posts,
        fields: [
          { name: 'title', type: 'text', unique: true },
          { name: 'slug', type: 'text', localized: true, unique: true },
          { name: 'count', type: 'number' },
          { name: 'rows', type: 'array', fields: [{ name: 'label', type: 'text' }] },
          { name: 'categories', type: 'relationship', hasMany: true, relationTo: slugs.categories },
          { name: 'category', type: 'relationship', relationTo: slugs.categories },
          { name: 'publishedAt', type: 'date' },
          { name: 'location', type: 'point' },
          { name: 'group', type: 'group', fields: [{ name: 'inner', type: 'text' }] },
        ],
        versions: { drafts: true },
      },
      {
        slug: slugs.customText,
        fields: [
          { name: 'id', type: 'text' },
          { name: 'title', type: 'text' },
        ],
      },
      {
        slug: slugs.customNumber,
        fields: [
          { name: 'id', type: 'number' },
          { name: 'title', type: 'text' },
        ],
      },
    ],
    globals: [
      {
        slug: slugs.settings,
        fields: [
          { name: 'siteName', type: 'text' },
          { name: 'count', type: 'number' },
          { name: 'featured', type: 'relationship', relationTo: slugs.categories },
        ],
        versions: { drafts: true },
      },
    ],
    jobs: {
      tasks: [
        {
          slug: 'noop',
          handler: () => ({ output: {} }),
        },
      ],
    },
    localization: { defaultLocale: 'en', locales: ['en', 'es'] },
  },
})
