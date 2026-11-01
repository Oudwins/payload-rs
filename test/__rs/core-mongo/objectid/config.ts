/**
 * MongoDB-shaped inputs for the Rust core engine (./objectid.int.spec.ts): relationships (single,
 * hasMany, polymorphic, to custom text / number id collections), a join, a point field (geo
 * operators), a custom text id, a custom number id and a localized field. Field hooks and access
 * record the class of the values they see in `req.context.seen`, so ObjectId instances versus
 * strings show up in the harness logs and outcomes.
 */
import type { CollectionConfig, FieldHook } from 'payload'

import { buildConfigWithDefaults } from '../../../buildConfigWithDefaults.js'

const kindOf = (value: unknown): string =>
  value === null
    ? 'null'
    : typeof value === 'object'
      ? `object:${(value as object).constructor?.name ?? 'null-proto'}`
      : typeof value

const recordValue =
  (label: string): FieldHook =>
  ({ req, value }) => {
    const context = req.context as Record<string, any>
    ;(context.seen ??= []).push(
      `${label}:${Array.isArray(value) ? `[${value.map(kindOf).join(',')}]` : kindOf(value)}`,
    )
    return value
  }

const Authors: CollectionConfig = {
  slug: 'authors',
  fields: [
    { name: 'name', type: 'text' },
    { name: 'posts', type: 'join', collection: 'posts', on: 'author' },
  ],
}

const Posts: CollectionConfig = {
  slug: 'posts',
  access: {
    read: ({ id, req }) => {
      const context = req.context as Record<string, any>
      ;(context.seen ??= []).push(`access.read:${kindOf(id)}`)
      return context.readWhereAuthor ? { author: { equals: context.readWhereAuthor } } : true
    },
  },
  fields: [
    { name: 'title', type: 'text', localized: true },
    { name: 'num', type: 'number' },
    {
      name: 'author',
      type: 'relationship',
      hooks: {
        afterRead: [recordValue('author.afterRead')],
        beforeChange: [recordValue('author.beforeChange')],
        beforeValidate: [recordValue('author.beforeValidate')],
      },
      relationTo: 'authors',
    },
    {
      name: 'authors',
      type: 'relationship',
      hasMany: true,
      hooks: { beforeChange: [recordValue('authors.beforeChange')] },
      relationTo: 'authors',
    },
    {
      name: 'poly',
      type: 'relationship',
      hooks: { beforeChange: [recordValue('poly.beforeChange')] },
      relationTo: ['authors', 'customs', 'numbered'],
    },
    { name: 'custom', type: 'relationship', relationTo: 'customs' },
    { name: 'numbered', type: 'relationship', relationTo: 'numbered' },
    { name: 'location', type: 'point' },
  ],
}

const Customs: CollectionConfig = {
  slug: 'customs',
  fields: [
    { name: 'id', type: 'text' },
    { name: 'title', type: 'text' },
  ],
}

const Numbered: CollectionConfig = {
  slug: 'numbered',
  fields: [
    { name: 'id', type: 'number' },
    { name: 'title', type: 'text' },
  ],
}

export default buildConfigWithDefaults({
  config: {
    collections: [Authors, Posts, Customs, Numbered],
    localization: { defaultLocale: 'en', locales: ['en', 'es'] },
  },
})
