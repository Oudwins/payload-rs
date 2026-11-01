/**
 * Config for synthetic.int.spec.ts: exercises the branches of the query/select utilities that the
 * upstream suites rarely reach (virtual paths, relationship hops with access `where`, hidden and
 * auth fields, joins, polymorphic relationships, localized segments, blocks, json, versions).
 */
import type { CollectionConfig } from 'payload'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'

const isAdmin = ({ req }: { req: any }) => req.user?.role === 'admin'

const Authors: CollectionConfig = {
  slug: 'cq-authors',
  access: {
    read: ({ req }) => (isAdmin({ req }) ? true : { name: { not_equals: 'secret' } }),
  },
  fields: [
    { name: 'name', type: 'text' },
    { name: 'bio', type: 'text', access: { read: isAdmin } },
    { name: 'team', type: 'relationship', relationTo: 'cq-teams' },
    { name: 'posts', type: 'join', collection: 'cq-posts', on: 'author' },
  ],
}

const Teams: CollectionConfig = {
  slug: 'cq-teams',
  access: { read: () => ({ title: { exists: true } }) },
  fields: [{ name: 'title', type: 'text' }],
}

const Posts: CollectionConfig = {
  slug: 'cq-posts',
  defaultSort: '-title',
  trash: true,
  versions: { drafts: true },
  fields: [
    { name: 'title', type: 'text' },
    { name: 'secret', type: 'text', hidden: true },
    { name: 'internal', type: 'text', access: { read: () => false } },
    { name: 'localizedTitle', type: 'text', localized: true },
    { name: 'author', type: 'relationship', relationTo: 'cq-authors' },
    { name: 'authors', type: 'relationship', relationTo: 'cq-authors', hasMany: true },
    { name: 'any', type: 'relationship', relationTo: ['cq-authors', 'cq-teams'] },
    { name: 'authorName', type: 'text', virtual: 'author.name' },
    { name: 'computed', type: 'text', virtual: true },
    { name: 'meta', type: 'json' },
    {
      name: 'group',
      type: 'group',
      fields: [
        { name: 'inner', type: 'text' },
        { name: 'teamTitle', type: 'text', virtual: 'author.team.title' },
        { name: 'localizedInner', type: 'text', localized: true },
      ],
    },
    {
      name: 'layout',
      type: 'blocks',
      blocks: [{ slug: 'cq-block', fields: [{ name: 'text', type: 'text' }] }],
    },
    { name: 'items', type: 'array', fields: [{ name: 'label', type: 'text' }] },
  ],
}

const Members: CollectionConfig = {
  slug: 'cq-members',
  auth: true,
  fields: [{ name: 'role', type: 'text' }],
}

export default buildConfigWithDefaults({
  suite: 'rs-core-query',
  config: {
    collections: [Authors, Teams, Posts, Members],
    globals: [
      {
        slug: 'cq-settings',
        versions: { drafts: true },
        fields: [
          { name: 'label', type: 'text' },
          { name: 'owner', type: 'relationship', relationTo: 'cq-authors' },
          { name: 'locked', type: 'text', access: { read: () => false } },
        ],
      },
    ],
    localization: { defaultLocale: 'en', locales: ['en', 'es'] },
  },
})
