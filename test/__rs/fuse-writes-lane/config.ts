import { fileURLToPath } from 'node:url'
import path from 'path'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * The fused writes' shapes (packages/engine-rs/FUSED_WRITES.md section 11): `posts` is the perf
 * suite's `minimal` shape (text, number defaults, a relationship, versions on), `hooked` the same
 * with a user hook (ineligible: the exact lane), `rows` array rows (generated row ids) and a
 * group.
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
    ],
  },
})
