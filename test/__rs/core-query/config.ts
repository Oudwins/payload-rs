/**
 * Config for synthetic.int.spec.ts: exercises the branches of the query/select utilities that the
 * upstream suites rarely reach (virtual paths, relationship hops with access `where`, hidden and
 * auth fields, joins, polymorphic relationships, localized segments, blocks, json, versions).
 */
import type { CollectionConfig } from 'payload'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'

const isAdmin = ({ req }: { req: any }) => req.user?.role === 'admin'

/**
 * Access functions of the `cq-adv*` collections (live differential, ./live/synthetic.int.spec.ts):
 * behaviour selected by `req.context.mode`. They log into `req.context.log`, take 0 to 3
 * microtasks or a macrotask, throw tagged errors, return `where` results, or mutate the `where`
 * object the case stashed in `req.context.where` while the validation is suspended.
 */
const adversarial =
  (label: string) =>
  async ({ req }: { req: any }): Promise<any> => {
    const context = req.context ?? {}
    ;(context.log ??= []).push(label)
    switch (context.mode) {
      case 'immediate':
        await new Promise((resolve) => setImmediate(resolve))
        return true
      case 'mutate': {
        await null
        const where = context.where
        if (where && typeof where === 'object' && !Object.isFrozen(where)) {
          const [first] = Object.keys(where)
          if (first) {
            delete where[first]
          }
          where[`late_${label}`] = { equals: 1 }
        }
        return label.length % 2 === 0
      }
      case 'throw':
        if (label.includes('title')) {
          throw Object.assign(new Error(`denied ${label}`), { [Symbol.for('cq.userError')]: label })
        }
        return true
      case 'ticks':
        for (let i = 0; i < label.length % 4; i++) {
          await null
        }
        return label.length % 3 !== 0
      case 'where':
        return { title: { equals: label } }
      default:
        return true
    }
  }

const AdvTargets: CollectionConfig = {
  slug: 'cq-adv-targets',
  access: { read: adversarial('targets.read') },
  fields: [
    { name: 'title', type: 'text', access: { read: adversarial('targets.title') } },
    { name: 'secret', type: 'text', hidden: true },
    { name: 'owner', type: 'relationship', relationTo: 'cq-adv' },
  ],
}

const Adv: CollectionConfig = {
  slug: 'cq-adv',
  access: { read: adversarial('adv.read') },
  fields: [
    { name: 'title', type: 'text', access: { read: adversarial('adv.title') } },
    { name: 'plain', type: 'text' },
    { name: 'target', type: 'relationship', relationTo: 'cq-adv-targets' },
    { name: 'targets', type: 'relationship', hasMany: true, relationTo: 'cq-adv-targets' },
    { name: 'owned', type: 'join', collection: 'cq-adv-targets', on: 'owner' },
    {
      name: 'group',
      type: 'group',
      fields: [{ name: 'inner', type: 'text', access: { read: adversarial('adv.group.inner') } }],
    },
  ],
}

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
    collections: [Authors, Teams, Posts, Members, Adv, AdvTargets],
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
