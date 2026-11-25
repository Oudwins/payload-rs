import { fileURLToPath } from 'node:url'
import path from 'path'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Drafts on a localized config for the fused writes (packages/engine-rs/FUSED_WRITES.md):
 * `articles` has localized fields, so its `_status` is localized (`localizeStatus`); `notes` has
 * none (a publish then validates every locale: the exact lane).
 */
export default buildConfigWithDefaults({
  suite: 'fuse-writes-lane-drafts-localized',
  config: {
    admin: {
      importMap: {
        baseDir: path.resolve(dirname),
      },
    },
    localization: {
      defaultLocale: 'en',
      locales: ['en', 'de'],
    },
    collections: [
      {
        slug: 'articles',
        fields: [
          { name: 'title', type: 'text', localized: true },
          { name: 'views', type: 'number', defaultValue: 0 },
        ],
        versions: { drafts: true },
      },
      {
        slug: 'notes',
        fields: [{ name: 'title', type: 'text' }],
        versions: { drafts: true },
      },
    ],
  },
})
