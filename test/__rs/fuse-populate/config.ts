import { fileURLToPath } from 'node:url'
import path from 'path'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Relationship population of the fused read lanes (packages/engine-rs/FUSE_CONTRACT.md section
 * 9): every relationship shape `afterRead` populates, without localization (the lanes' subset).
 */
export default buildConfigWithDefaults({
  suite: 'fuse-populate',
  config: {
    admin: {
      importMap: {
        baseDir: path.resolve(dirname),
      },
    },
    collections: [
      {
        slug: 'authors',
        fields: [
          { name: 'name', type: 'text' },
          { name: 'bestFriend', type: 'relationship', relationTo: 'authors' },
          { name: 'favorite', type: 'relationship', relationTo: 'categories' },
        ],
      },
      {
        slug: 'categories',
        fields: [{ name: 'title', type: 'text' }],
        trash: true,
      },
      {
        slug: 'tags',
        defaultPopulate: { name: true },
        fields: [
          { name: 'name', type: 'text' },
          { name: 'note', type: 'text' },
        ],
      },
      {
        slug: 'posts',
        fields: [
          { name: 'title', type: 'text' },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
          { name: 'editor', type: 'relationship', maxDepth: 1, relationTo: 'authors' },
          { name: 'categories', type: 'relationship', hasMany: true, relationTo: 'categories' },
          { name: 'tags', type: 'relationship', hasMany: true, relationTo: 'tags' },
          { name: 'related', type: 'relationship', relationTo: ['authors', 'categories'] },
          {
            name: 'relatedMany',
            type: 'relationship',
            hasMany: true,
            relationTo: ['authors', 'categories'],
          },
          {
            name: 'meta',
            type: 'group',
            fields: [{ name: 'reviewer', type: 'relationship', relationTo: 'authors' }],
          },
          {
            name: 'items',
            type: 'array',
            fields: [{ name: 'category', type: 'relationship', relationTo: 'categories' }],
          },
        ],
      },
    ],
  },
})
