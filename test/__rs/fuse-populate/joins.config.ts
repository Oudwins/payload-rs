import { fileURLToPath } from 'node:url'
import path from 'path'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Join fields in fused reads and population (FUSE_CONTRACT.md section 9), shaped like the perf
 * suite's complex shape: `writers` joins the `articles` that point to them (`articles` has drafts
 * and versions with `maxPerDoc`), `editors` has two joins, one with a `defaultSort` and no limit.
 */
export default buildConfigWithDefaults({
  suite: 'fuse-populate-joins',
  config: {
    admin: {
      importMap: {
        baseDir: path.resolve(dirname),
      },
    },
    collections: [
      {
        slug: 'writers',
        fields: [
          { name: 'name', type: 'text', required: true },
          { name: 'articles', type: 'join', collection: 'articles', on: 'writer', defaultLimit: 3 },
        ],
      },
      {
        slug: 'editors',
        fields: [
          { name: 'name', type: 'text' },
          {
            name: 'edited',
            type: 'join',
            collection: 'articles',
            defaultLimit: 0,
            defaultSort: 'title',
            on: 'editor',
          },
          { name: 'reviewed', type: 'join', collection: 'articles', on: 'meta.reviewer' },
        ],
      },
      {
        slug: 'articles',
        fields: [
          { name: 'title', type: 'text' },
          { name: 'writer', type: 'relationship', relationTo: 'writers' },
          { name: 'editor', type: 'relationship', relationTo: 'editors' },
          {
            name: 'meta',
            type: 'group',
            fields: [{ name: 'reviewer', type: 'relationship', relationTo: 'editors' }],
          },
        ],
        versions: { drafts: true, maxPerDoc: 3 },
      },
    ],
  },
})
