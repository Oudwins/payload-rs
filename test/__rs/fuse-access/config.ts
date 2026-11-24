import { fileURLToPath } from 'node:url'
import path from 'path'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export const isSignedIn = ({ req }: any) => Boolean(req.user)
export const isReader = ({ req: { user } }: any) => user?.email === 'reader@payloadcms.com'

/**
 * Compiled access on the fused read lanes (packages/engine-rs/FUSE_CONTRACT.md section 2): a
 * where-returning collection read access and field `access.read` functions that only read `req`
 * at every nesting the plan has (group, array, named and unnamed tabs, blocks), with defaults on
 * denied fields; `doc-access` reads the document, which keeps its reads on the exact lane.
 */
export default buildConfigWithDefaults({
  suite: 'fuse-access',
  config: {
    admin: {
      importMap: {
        baseDir: path.resolve(dirname),
      },
    },
    collections: [
      {
        slug: 'notes',
        access: {
          read: ({ req }) => (req.user ? true : { stage: { not_equals: 'archived' } }),
        },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'stage', type: 'text' },
          {
            name: 'secret',
            type: 'text',
            access: { read: isSignedIn },
            defaultValue: 'secret default',
          },
          {
            name: 'open',
            type: 'text',
            access: { read: () => true },
            defaultValue: 'open default',
          },
          {
            name: 'group',
            type: 'group',
            fields: [
              { name: 'inner', type: 'text', access: { read: isSignedIn } },
              { name: 'other', type: 'text' },
            ],
          },
          {
            name: 'rows',
            type: 'array',
            fields: [
              { name: 'cell', type: 'text', access: { read: isReader } },
              { name: 'plain', type: 'text' },
            ],
          },
          {
            type: 'tabs',
            tabs: [
              {
                name: 'meta',
                fields: [
                  { name: 'note', type: 'text', access: { read: isSignedIn } },
                  { name: 'shown', type: 'text' },
                ],
              },
              {
                label: 'Flat',
                fields: [{ name: 'flat', type: 'text', access: { read: isReader } }],
              },
            ],
          },
          {
            name: 'layout',
            type: 'blocks',
            blocks: [
              {
                slug: 'hero',
                fields: [
                  { name: 'heading', type: 'text', access: { read: isSignedIn } },
                  { name: 'caption', type: 'text' },
                ],
              },
            ],
          },
        ],
      },
      {
        slug: 'doc-access',
        access: { read: () => true },
        fields: [
          { name: 'title', type: 'text' },
          {
            name: 'onlyWhenShown',
            type: 'text',
            access: { read: ({ doc }) => doc?.title === 'show' },
          },
        ],
      },
    ],
  },
})
