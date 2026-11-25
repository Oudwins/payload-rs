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
 * denied fields; `doc-access` and `row-access` read the document, its sibling data, its block
 * data and its id (evaluated per document and field inside the fused afterRead); `authored` has
 * the default authorship relationships to the users, whose `sessions` field access reads the
 * document.
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
        slug: 'tags',
        access: { read: () => true },
        fields: [{ name: 'name', type: 'text' }],
      },
      {
        // field write access without overrideAccess (the fused writes' `fieldAccess`)
        slug: 'entries',
        access: { create: () => true, read: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text' },
          {
            name: 'locked',
            type: 'text',
            access: { create: () => false, update: () => false },
            defaultValue: 'locked default',
          },
          { name: 'signedInOnly', type: 'text', access: { update: isSignedIn } },
          { name: 'tag', type: 'relationship', relationTo: 'tags' },
        ],
      },
      {
        // population without overrideAccess: `tags` grants read with `true` and has no field
        // access (no authorship relationship to the users either)
        slug: 'links',
        access: { create: () => true, read: () => true },
        authorship: false,
        fields: [
          { name: 'title', type: 'text' },
          { name: 'tag', type: 'relationship', relationTo: 'tags' },
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
      {
        slug: 'row-access',
        access: { read: () => true },
        authorship: false,
        fields: [
          { name: 'title', type: 'text' },
          {
            // denied: removed one tick after the access call, then refilled with `[]`, after the
            // later fields' synchronous work and before their defaults
            name: 'denied',
            type: 'array',
            access: { read: ({ doc }) => doc?.title === 'never' },
            fields: [{ name: 'value', type: 'text' }],
          },
          { name: 'later', type: 'group', fields: [{ name: 'value', type: 'text' }] },
          { name: 'afterDefault', type: 'text', defaultValue: 'after' },
          {
            name: 'rows',
            type: 'array',
            fields: [
              { name: 'visible', type: 'checkbox' },
              {
                name: 'secret',
                type: 'text',
                access: { read: ({ siblingData }) => siblingData?.visible === true },
                defaultValue: 'secret default',
              },
            ],
          },
          {
            name: 'layout',
            type: 'blocks',
            blocks: [
              {
                slug: 'card',
                fields: [
                  { name: 'public', type: 'checkbox' },
                  {
                    name: 'inner',
                    type: 'group',
                    fields: [
                      {
                        name: 'note',
                        type: 'text',
                        access: { read: ({ blockData }) => blockData?.public === true },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            name: 'signedInWithID',
            type: 'text',
            access: { read: ({ id, req: { user } }) => Boolean(user) && typeof id === 'string' },
          },
          {
            name: 'first',
            type: 'relationship',
            relationTo: 'tags',
            access: { read: ({ doc }) => typeof doc?.id === 'string' },
          },
          { name: 'second', type: 'relationship', relationTo: 'links' },
        ],
      },
      {
        slug: 'authored',
        access: { create: () => true, read: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'parent', type: 'relationship', relationTo: 'authored' },
        ],
      },
    ],
  },
})
