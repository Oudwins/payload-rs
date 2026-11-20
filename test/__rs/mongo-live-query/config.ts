/**
 * Config of probes.int.spec.ts: the field shapes the reviewers' probes need (hasMany / polymorphic /
 * custom-number-id relationships, hasMany select / text / number in a group, a join, blocks, arrays,
 * localized fields, versions, a global).
 */
import type { CollectionConfig } from 'payload'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'

export const tagsSlug = 'lq-tags'
export const postsSlug = 'lq-posts'
export const numIDsSlug = 'lq-numids'

const Tags: CollectionConfig = {
  slug: tagsSlug,
  fields: [
    { name: 'name', type: 'text' },
    { name: 'num', type: 'number' },
    { name: 'post', type: 'relationship', relationTo: postsSlug },
    { name: 'label', type: 'text', localized: true },
  ],
}

const NumIDs: CollectionConfig = {
  slug: numIDsSlug,
  fields: [
    { name: 'id', type: 'number' },
    { name: 'title', type: 'text' },
  ],
}

const Posts: CollectionConfig = {
  slug: postsSlug,
  versions: { drafts: true },
  fields: [
    { name: 'title', type: 'text' },
    { name: 'localizedTitle', type: 'text', localized: true },
    { name: 'tag', type: 'relationship', relationTo: tagsSlug },
    { name: 'tags', type: 'relationship', relationTo: tagsSlug, hasMany: true },
    {
      name: 'localizedTags',
      type: 'relationship',
      relationTo: tagsSlug,
      hasMany: true,
      localized: true,
    },
    { name: 'poly', type: 'relationship', relationTo: [tagsSlug, postsSlug] },
    { name: 'polyMany', type: 'relationship', relationTo: [tagsSlug, numIDsSlug], hasMany: true },
    { name: 'numRel', type: 'relationship', relationTo: numIDsSlug },
    { name: 'selectMany', type: 'select', hasMany: true, options: ['a', 'b', 'c'] },
    {
      name: 'group',
      type: 'group',
      fields: [
        { name: 'tags', type: 'select', hasMany: true, options: ['x', 'y', 'z'] },
        { name: 'words', type: 'text', hasMany: true },
        { name: 'nums', type: 'number', hasMany: true },
        { name: 'rel', type: 'relationship', relationTo: tagsSlug },
      ],
    },
    { name: 'date', type: 'date' },
    { name: 'checkbox', type: 'checkbox' },
    { name: 'number', type: 'number' },
    { name: 'point', type: 'point' },
    { name: 'json', type: 'json' },
    {
      name: 'items',
      type: 'array',
      localized: true,
      fields: [
        { name: 'label', type: 'text' },
        { name: 'ref', type: 'relationship', relationTo: tagsSlug },
      ],
    },
    {
      name: 'layout',
      type: 'blocks',
      blocks: [
        { slug: 'hero', fields: [{ name: 'heading', type: 'text', localized: true }] },
        {
          slug: 'cta',
          fields: [
            { name: 'link', type: 'text' },
            { name: 'target', type: 'relationship', relationTo: tagsSlug },
          ],
        },
      ],
    },
    { name: 'tagJoin', type: 'join', collection: tagsSlug, on: 'post' },
  ],
}

export default buildConfigWithDefaults({
  suite: 'rs-mongo-live-query',
  config: {
    collections: [Tags, NumIDs, Posts],
    globals: [
      {
        slug: 'lq-settings',
        versions: true,
        fields: [
          { name: 'title', type: 'text' },
          { name: 'owner', type: 'relationship', relationTo: tagsSlug },
        ],
      },
    ],
    localization: { defaultLocale: 'en', locales: ['en', 'es'] },
  },
})
