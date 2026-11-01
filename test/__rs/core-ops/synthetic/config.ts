/**
 * Adversarial config for the collection read operation differential (test/__rs/core-ops): every
 * collection hook kind with different tick counts, hooks that replace args/docs/results, return
 * falsy values or throw (sync and async, custom error class), access returning `true`, `false`, a
 * where or a promise, field access and hidden fields, drafts, lock status, relationships with a
 * virtual field (sort and findDistinct through it), and an upload collection with versions.
 * Behaviour is steered per request through `req.context` and logged there, so TS and Rust runs on
 * cloned requests are comparable.
 */
import type { Access, CollectionConfig } from 'payload'

import os from 'node:os'
import path from 'node:path'

import { buildConfigWithDefaults } from '../../../buildConfigWithDefaults.js'

const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) {
    await null
  }
}

const log = (context: Record<string, any>, entry: string) => {
  ;(context.steps ??= []).push(entry)
}

export class OpsHookError extends Error {
  code = 'OPS_HOOK'
}

const steeredAccess =
  (prefix: string): Access =>
  ({ id, req }) => {
    const c = req.context as Record<string, any>
    log(c, `${prefix}:${String(id)}`)
    if (c[`${prefix}Deny`]) {
      return false
    }
    if (c[`${prefix}Where`]) {
      return { num: { greater_than: 1 } }
    }
    if (c[`${prefix}Null`]) {
      return null as any
    }
    if (c[`${prefix}Async`]) {
      return ticks(2).then(() => true)
    }
    if (c[`${prefix}Throw`]) {
      throw new OpsHookError(`${prefix} access threw`)
    }
    return true
  }

const posts: CollectionConfig = {
  slug: 'posts',
  access: {
    read: steeredAccess('read'),
    readVersions: steeredAccess('readVersions'),
  },
  fields: [
    { name: 'title', type: 'text' },
    { name: 'num', type: 'number' },
    { name: 'group', type: 'group', fields: [{ name: 'a', type: 'text' }] },
    { name: 'rows', type: 'array', fields: [{ name: 'x', type: 'text' }] },
    { name: 'rel', type: 'relationship', relationTo: 'targets' },
    { name: 'relMany', type: 'relationship', hasMany: true, relationTo: 'targets' },
    { name: 'relTitle', type: 'text', virtual: 'rel.title' },
    { name: 'secret', type: 'text', hidden: true },
    {
      name: 'guarded',
      type: 'text',
      access: {
        read: ({ req }) => !(req.context as Record<string, any>).denyField,
      },
    },
    {
      name: 'hooked',
      type: 'text',
      hooks: {
        afterRead: [
          async ({ context, value }) => {
            log(context, `field:hooked:${String(value)}`)
            await ticks((context.fieldTicks as number) ?? 1)
            return value
          },
        ],
      },
    },
  ],
  hooks: {
    afterOperation: [
      async ({ operation, req, result }) => {
        const context = req.context as Record<string, any>
        log(context, `afterOperation:${operation}`)
        await ticks(1)
        if (context.throwIn === 'afterOperation') {
          throw new OpsHookError('afterOperation threw')
        }
        if (context.replaceResult) {
          return { replaced: operation, result }
        }
        return undefined
      },
      ({ operation, req }) => {
        log(req.context as Record<string, any>, `afterOperation2:${operation}`)
      },
    ],
    afterRead: [
      async ({ context, doc, findMany, query }) => {
        log(context, `afterRead:${doc?.id}:${String(findMany)}:${JSON.stringify(query)?.length}`)
        await ticks((context.afterReadTicks as number) ?? 0)
        if (context.throwIn === 'afterRead') {
          throw new OpsHookError('afterRead threw')
        }
        if (context.throwIn === 'afterReadSync') {
          throw new TypeError('afterRead sync throw')
        }
        return { ...doc, afterRead: findMany ?? 'single' }
      },
      ({ doc }) => {
        doc.counter = (doc.counter ?? 0) + 1
        return context_falsy(doc)
      },
    ],
    beforeOperation: [
      async ({ args, context, operation }) => {
        log(context, `beforeOperation:${operation}`)
        await ticks(1)
        if (context.throwIn === 'beforeOperation') {
          throw new OpsHookError('beforeOperation threw')
        }
        if (context.replaceArgs) {
          return { ...args, ...(context.replaceArgs as object) }
        }
        return undefined
      },
      ({ context, operation }) => {
        log(context, `beforeOperation2:${operation}`)
        return undefined
      },
    ],
    beforeRead: [
      ({ context, doc, query }) => {
        log(context, `beforeRead:${doc?.id}:${JSON.stringify(query)?.length}`)
        if (context.throwIn === 'beforeRead') {
          throw new OpsHookError('beforeRead threw')
        }
        if (context.beforeReadFalsy) {
          return null
        }
        return { ...doc, beforeRead: true }
      },
      async ({ context, doc }) => {
        await ticks((context.beforeReadTicks as number) ?? 2)
        doc.br2 = true
      },
    ],
  },
  versions: { drafts: true },
}

/** Returns `undefined` (keeps the doc) unless the request asks for a falsy return of `0`. */
function context_falsy(doc: Record<string, unknown>): unknown {
  return doc.counter === 99 ? 0 : undefined
}

const targets: CollectionConfig = {
  slug: 'targets',
  access: { read: steeredAccess('targets') },
  fields: [
    { name: 'title', type: 'text' },
    { name: 'num', type: 'number' },
  ],
  hooks: {
    afterRead: [
      async ({ context, doc, findMany }) => {
        log(context, `targets:afterRead:${doc?.id}:${String(findMany)}`)
        await ticks(1)
        return undefined
      },
    ],
  },
}

const media: CollectionConfig = {
  slug: 'media',
  access: { read: steeredAccess('media'), readVersions: steeredAccess('mediaVersions') },
  fields: [{ name: 'alt', type: 'text' }],
  hooks: {
    afterRead: [
      ({ context, doc }) => {
        log(context, `media:afterRead:${doc?.id}`)
      },
    ],
  },
  upload: { staticDir: path.join(os.tmpdir(), 'rs-core-ops-media') },
  versions: true,
}

const users: CollectionConfig = {
  slug: 'users',
  auth: true,
  fields: [{ name: 'name', type: 'text' }],
}

export default buildConfigWithDefaults({
  config: {
    admin: { user: 'users' },
    collections: [users, posts, targets, media],
  },
})
