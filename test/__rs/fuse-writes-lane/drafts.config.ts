import { fileURLToPath } from 'node:url'
import path from 'path'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Collections with drafts for the fused writes (packages/engine-rs/FUSED_WRITES.md sections 12
 * and 13): `drafts` (drafts without draft validation, a relationship, array rows), `validated`
 * (`drafts.validate`), `scheduled` (`schedulePublish`: deletes stay on the exact lane), `capped`
 * (`maxPerDoc: 2`).
 */
export default buildConfigWithDefaults({
  suite: 'fuse-writes-lane-drafts',
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
        slug: 'drafts',
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'views', type: 'number', defaultValue: 0 },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
          { name: 'items', type: 'array', fields: [{ name: 'label', type: 'text' }] },
        ],
        versions: { drafts: true },
      },
      {
        slug: 'validated',
        fields: [{ name: 'title', type: 'text', required: true }],
        versions: { drafts: { validate: true } },
      },
      {
        slug: 'scheduled',
        fields: [{ name: 'title', type: 'text' }],
        versions: { drafts: { schedulePublish: true } },
      },
      {
        slug: 'capped',
        fields: [{ name: 'title', type: 'text' }],
        versions: { drafts: true, maxPerDoc: 2 },
      },
    ],
  },
})
