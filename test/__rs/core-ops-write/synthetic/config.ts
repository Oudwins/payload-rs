/**
 * Adversarial config for the collection write operation differential (test/__rs/core-ops-write):
 * every collection hook of the write operations (beforeOperation, beforeValidate, beforeChange,
 * afterChange, afterRead, beforeDelete, afterDelete, afterOperation) with different tick counts,
 * hooks that replace args/data/docs/results, return falsy values, thenables, or throw (sync and
 * async, custom error class); field hooks of every write traversal; access returning `true`,
 * `false`, a where or a promise (create/update/delete/validate); drafts with autosave and
 * localization; trash; an auth collection with sessions (password updates); disabled duplicate /
 * bulk edit / bulk delete; a required field (validation errors).
 * Behaviour is steered per request through `req.context` and logged there, so TS and Rust runs
 * on cloned requests are comparable.
 */
import type { Access, CollectionConfig, CollectionSlug, Field } from 'payload'

import { buildConfigWithDefaults } from '../../../buildConfigWithDefaults.js'

const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) {
    await null
  }
}

const log = (context: Record<string, any>, entry: string) => {
  ;(context.steps ??= []).push(entry)
}

export class OpsWriteHookError extends Error {
  code = 'OPS_WRITE_HOOK'
}

/** Access steered by `req.context[<prefix>Deny|Where|Async|Throw]`. */
const steeredAccess =
  (prefix: string): Access =>
  ({ id, data, req }) => {
    const c = req.context as Record<string, any>
    log(c, `${prefix}:${String(id)}:${typeof data}`)
    if (c[`${prefix}Deny`]) {
      return false
    }
    if (c[`${prefix}Throw`]) {
      throw new OpsWriteHookError(`${prefix} access threw`)
    }
    if (c[`${prefix}Where`]) {
      return { num: { greater_than: 1 } }
    }
    if (c[`${prefix}Async`]) {
      return ticks(2).then(() => true)
    }
    return true
  }

/**
 * A collection hook steered by `req.context`: logs, waits `context.<name>Ticks` microtasks (or
 * returns a thenable / sync value), throws when `context.throwIn === name` (`<name>Sync` throws
 * synchronously), and replaces its target when `context.replace === name`.
 */
const hook =
  (name: string, replace: (args: any) => unknown) =>
  (args: any): any => {
    const c = args.context ?? args.req?.context ?? {}
    log(c, `${name}:${args.operation ?? ''}`)
    if (c.throwIn === `${name}Sync`) {
      throw new OpsWriteHookError(`${name} threw synchronously`)
    }
    // per-document failures in bulk operations
    const target = args.originalDoc ?? args.doc
    if (c.throwForNum !== undefined && target?.num === c.throwForNum && name === c.throwForHook) {
      throw new OpsWriteHookError(`${name} threw for num ${c.throwForNum}`)
    }
    if (c.thenableIn === name) {
      return { then: (resolve: (v: unknown) => void) => resolve(replace(args)) }
    }
    if (c.syncIn === name) {
      return c.replace === name ? replace(args) : undefined
    }
    return (async () => {
      await ticks(c[`${name}Ticks`] ?? name.length % 3)
      if (c.throwIn === name) {
        throw new OpsWriteHookError(`${name} threw`)
      }
      if (c.falsyIn === name) {
        return 0
      }
      return c.replace === name ? replace(args) : undefined
    })()
  }

const collectionHooks = {
  afterChange: [
    hook('afterChange', ({ doc }) => ({ ...doc, afterChangeReplaced: true })),
    hook('afterChange2', () => undefined),
  ],
  afterDelete: [hook('afterDelete', ({ doc }) => ({ ...doc, afterDeleteReplaced: true }))],
  afterOperation: [
    hook('afterOperation', ({ result }) =>
      result && typeof result === 'object' ? { ...result, afterOperationReplaced: true } : result,
    ),
  ],
  afterRead: [hook('afterRead', ({ doc }) => ({ ...doc, afterReadReplaced: true }))],
  beforeChange: [hook('beforeChange', ({ data }) => ({ ...data, num: (data?.num ?? 0) + 100 }))],
  beforeDelete: [hook('beforeDelete', () => undefined)],
  beforeOperation: [hook('beforeOperation', ({ args }) => ({ ...args, depth: 0 }))],
  beforeValidate: [
    hook('beforeValidate', ({ data }) => ({ ...data, title: `${data?.title ?? ''}!` })),
    hook('beforeValidate2', () => undefined),
  ],
}

const fieldHook =
  (name: string) =>
  async ({ context, value }: any) => {
    log(context, `field:${name}`)
    await ticks(context?.fieldTicks ?? 1)
    if (context?.throwIn === `field:${name}`) {
      throw new OpsWriteHookError(`field ${name} threw`)
    }
    if (context?.fieldReplace === name && typeof value === 'string') {
      return `${value}~`
    }
    return value
  }

const hookedFields: Field[] = [
  {
    name: 'title',
    type: 'text',
    hooks: {
      afterChange: [fieldHook('title.afterChange')],
      afterRead: [fieldHook('title.afterRead')],
      beforeChange: [fieldHook('title.beforeChange')],
      beforeValidate: [fieldHook('title.beforeValidate')],
    },
    validate: (value: unknown) =>
      value === 'invalid!' || value === 'invalid' ? 'title is invalid' : true,
  },
  { name: 'num', type: 'number' },
  {
    name: 'secret',
    type: 'text',
    access: {
      create: ({ req }) => !(req.context as any).denyField,
      read: ({ req }) => !(req.context as any).denyField,
      update: ({ req }) => !(req.context as any).denyField,
    },
  },
  {
    name: 'group',
    type: 'group',
    fields: [
      {
        name: 'inner',
        type: 'text',
        hooks: { beforeChange: [fieldHook('group.inner.beforeChange')] },
      },
    ],
  },
  {
    name: 'rows',
    type: 'array',
    fields: [{ name: 'label', type: 'text', hooks: { afterRead: [fieldHook('rows.label')] } }],
  },
]

const access = {
  create: steeredAccess('create'),
  delete: steeredAccess('delete'),
  read: steeredAccess('read'),
  update: steeredAccess('update'),
  validate: steeredAccess('validate'),
}

const Hooked: CollectionConfig = {
  slug: 'hooked',
  access,
  fields: hookedFields,
  hooks: collectionHooks,
}

const Drafts: CollectionConfig = {
  slug: 'drafts',
  access,
  fields: [
    { name: 'title', type: 'text', localized: true },
    { name: 'num', type: 'number' },
    { name: 'required', type: 'text', required: true },
  ],
  hooks: collectionHooks,
  versions: { drafts: { autosave: true, validate: false }, maxPerDoc: 4 },
}

const Trashable: CollectionConfig = {
  slug: 'trashable',
  access,
  fields: [
    { name: 'title', type: 'text' },
    { name: 'num', type: 'number' },
  ],
  hooks: collectionHooks,
  trash: true,
  versions: { drafts: true },
}

const Accounts: CollectionConfig = {
  slug: 'accounts',
  access: { ...access, admin: () => true },
  auth: { useSessions: true },
  fields: [
    { name: 'name', type: 'text' },
    { name: 'num', type: 'number' },
  ],
  hooks: collectionHooks,
}

/** `ensureUsernameOrEmail` (validate's `beforeValidation`) throws when neither is given here. */
const Usernames: CollectionConfig = {
  slug: 'usernames',
  access: { ...access, admin: () => true },
  auth: {
    // neither required: `ensureUsernameOrEmail` itself requires one of them
    loginWithUsername: { allowEmailLogin: true, requireEmail: false, requireUsername: false },
  },
  fields: [{ name: 'name', type: 'text' }],
  hooks: collectionHooks,
}

const Restricted: CollectionConfig = {
  slug: 'restricted',
  access,
  disableBulkEdit: true,
  disableDuplicate: true,
  fields: [
    { name: 'title', type: 'text' },
    { name: 'num', type: 'number' },
  ],
  hooks: { ...collectionHooks },
}

const NoBulkDelete: CollectionConfig = {
  slug: 'no-bulk-delete',
  access,
  disableBulkDelete: true,
  fields: [{ name: 'title', type: 'text' }],
}

export const syntheticSlugs = [
  'hooked',
  'drafts',
  'trashable',
  'accounts',
  'restricted',
  'no-bulk-delete',
] as CollectionSlug[]

export default buildConfigWithDefaults({
  config: {
    collections: [Hooked, Drafts, Trashable, Accounts, Usernames, Restricted, NoBulkDelete],
    localization: { defaultLocale: 'en', fallback: true, locales: ['en', 'es'] },
  },
})
