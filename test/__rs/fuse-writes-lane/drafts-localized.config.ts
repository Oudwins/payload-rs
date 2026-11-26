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
      {
        // test/versions' `Drafts`: an unnamed group holding a localized, unique title, a radio
        slug: 'draftPosts',
        fields: [
          {
            type: 'group',
            fields: [
              {
                name: 'title',
                type: 'text',
                label: 'Title',
                localized: true,
                required: true,
                unique: true,
              },
            ],
          },
          { name: 'description', type: 'textarea', label: 'Description', required: true },
          {
            name: 'radio',
            type: 'radio',
            options: [{ label: { de: 'Test de', en: 'Test en' }, value: 'test' }],
          },
          {
            name: 'blocksField',
            type: 'blocks',
            blocks: [
              {
                slug: 'block',
                fields: [
                  { name: 'text', type: 'text' },
                  { name: 'localized', type: 'text', localized: true },
                ],
              },
            ],
          },
          { name: 'relation', type: 'relationship', relationTo: 'draftPosts' },
        ],
        versions: { drafts: true, maxPerDoc: 0 },
      },
      {
        // no localized fields: every publish validates all locales
        slug: 'bulletins',
        fields: [
          { name: 'title', type: 'text', required: true },
          {
            name: 'items',
            type: 'array',
            fields: [{ name: 'item', type: 'text', required: true }],
          },
          {
            type: 'tabs',
            tabs: [{ name: 'extra', fields: [{ name: 'count', type: 'number', max: 9 }] }],
          },
        ],
        versions: { drafts: true },
      },
    ],
  },
})
