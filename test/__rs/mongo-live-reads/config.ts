/**
 * Config of the live read differentials (crates/payload-mongo-live): plain, relationship, hasMany,
 * localized, nested, point and join fields, a drafts collection (versions / queryDrafts) and a
 * versioned global.
 */
import { fileURLToPath } from 'node:url'
import path from 'path'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'
import { categoriesSlug, draftsSlug, postsSlug, settingsSlug, sortedSlug } from './shared.js'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default buildConfigWithDefaults({
  suite: '__rs-mongo-live-reads',
  config: {
    admin: { importMap: { baseDir: path.resolve(dirname) } },
    collections: [
      {
        slug: categoriesSlug,
        fields: [
          { name: 'name', type: 'text' },
          { name: 'rank', type: 'number' },
          { name: 'posts', type: 'join', collection: postsSlug, on: 'category' },
        ],
      },
      {
        slug: postsSlug,
        defaultSort: 'title',
        fields: [
          { name: 'title', type: 'text' },
          { name: 'num', type: 'number' },
          { name: 'bigNum', type: 'number' },
          { name: 'category', type: 'relationship', relationTo: categoriesSlug },
          { name: 'tags', type: 'relationship', hasMany: true, relationTo: categoriesSlug },
          { name: 'localizedTitle', type: 'text', localized: true },
          { name: 'group', type: 'group', fields: [{ name: 'inner', type: 'text' }] },
          { name: 'location', type: 'point' },
          { name: 'numbers', type: 'number', hasMany: true },
          { name: 'poly', type: 'relationship', relationTo: [categoriesSlug, postsSlug] },
        ],
      },
      {
        // an array `defaultSort`: buildSortParam pushes its fallback into this config array
        slug: sortedSlug,
        defaultSort: ['num'],
        fields: [
          { name: 'title', type: 'text' },
          { name: 'num', type: 'number' },
        ],
      },
      {
        slug: draftsSlug,
        fields: [
          { name: 'title', type: 'text' },
          { name: 'category', type: 'relationship', relationTo: categoriesSlug },
        ],
        versions: { drafts: true },
      },
    ],
    globals: [
      {
        slug: settingsSlug,
        fields: [{ name: 'label', type: 'text', localized: true }],
        versions: { drafts: true },
      },
    ],
    localization: { defaultLocale: 'en', locales: ['en', 'es'] },
    typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
  },
})
