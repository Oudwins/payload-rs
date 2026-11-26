import { fileURLToPath } from 'node:url'
import path from 'path'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Join fields read without `overrideAccess` and join queries with values (FUSE_CONTRACT.md
 * section 8): `books`' read access returns a where constraint for anonymous requests (like the perf
 * suite's complex posts), `secrets`' denies them; `shelves` joins both, one join on a localized
 * relationship and one localized join field.
 */
export default buildConfigWithDefaults({
  suite: 'fuse-populate-joins-access',
  config: {
    admin: {
      importMap: {
        baseDir: path.resolve(dirname),
      },
    },
    collections: [
      {
        slug: 'users',
        access: { read: () => true },
        auth: true,
        fields: [{ name: 'name', type: 'text' }],
      },
      {
        slug: 'shelves',
        access: { read: () => true },
        fields: [
          { name: 'name', type: 'text' },
          // `maxDepth` (default 1): its documents also load in nested finds
          {
            name: 'books',
            type: 'join',
            collection: 'books',
            defaultLimit: 3,
            maxDepth: 3,
            on: 'shelf',
          },
          { name: 'secrets', type: 'join', collection: 'secrets', on: 'shelf' },
          { name: 'translated', type: 'join', collection: 'books', on: 'localShelf' },
          { name: 'localBooks', type: 'join', collection: 'books', localized: true, on: 'shelf' },
        ],
      },
      {
        slug: 'books',
        access: {
          read: ({ req }) => (req.user ? true : { status: { equals: 'published' } }),
        },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'status', type: 'select', options: ['draft', 'published'] },
          { name: 'shelf', type: 'relationship', relationTo: 'shelves' },
          { name: 'localShelf', type: 'relationship', localized: true, relationTo: 'shelves' },
        ],
      },
      {
        slug: 'secrets',
        access: { read: ({ req }) => Boolean(req.user) },
        fields: [
          { name: 'note', type: 'text' },
          { name: 'shelf', type: 'relationship', relationTo: 'shelves' },
        ],
      },
    ],
    localization: { defaultLocale: 'en', fallback: true, locales: ['en', 'de'] },
  },
})
