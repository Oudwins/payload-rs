/**
 * Adversarial config for the global / auth operation differential (../run.sh): every global and
 * auth hook kind, each registered twice, with different tick counts (sync returns, 0-3 awaits,
 * thenables), hooks that replace args / docs / data / results, return falsy values or throw
 * (sync and async, custom error class); access returning `true`, `false`, a where, a promise or
 * throwing; a versioned, localized global with drafts; auth collections with login attempts,
 * sessions, email verification, username login and custom forgot-password emails.
 * Behaviour is steered per request through `req.context` and logged there.
 */
import type { Access, CollectionConfig, GlobalConfig } from 'payload'

import { buildConfigWithDefaults } from '../../../buildConfigWithDefaults.js'

const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) {
    await null
  }
}

const ctx = (req: any): Record<string, any> => (req?.context ?? {}) as Record<string, any>

const log = (context: Record<string, any>, entry: string) => {
  ;(context.steps ??= []).push(entry)
}

export class GlobalHookError extends Error {
  code = 'GLOBAL_HOOK'
}

const steeredAccess =
  (prefix: string): Access =>
  ({ data, req }) => {
    const c = ctx(req)
    log(c, `${prefix}:${typeof data}`)
    if (c[`${prefix}Deny`]) {
      return false
    }
    if (c[`${prefix}Where`]) {
      return { title: { equals: 'allowed' } }
    }
    if (c[`${prefix}Async`]) {
      return ticks(2).then(() => true)
    }
    if (c[`${prefix}Throw`]) {
      throw new GlobalHookError(`${prefix} access threw`)
    }
    return true
  }

/** A hook of kind `kind` (`n` = 0 / 1 for the two registrations of each kind). */
const hook =
  (kind: string, n: number, pick: (args: any) => any) =>
  (args: any): any => {
    const c = ctx(args.req ?? args.args?.req)
    log(c, `${kind}${n}`)
    if (c.throwIn === `${kind}${n}`) {
      throw new GlobalHookError(`${kind}${n} threw`)
    }
    const value = pick(args)
    const replace = c.replace === `${kind}${n}`
    const result =
      replace && value && typeof value === 'object'
        ? { ...value, replacedBy: `${kind}${n}` }
        : undefined
    const mode = c.tickMode ?? n
    if (mode === 0) {
      return result
    }
    if (mode === 1) {
      return ticks(1).then(() => result)
    }
    if (mode === 2) {
      return { then: (resolve: (v: any) => void) => resolve(result) }
    }
    return (async () => {
      await ticks(3)
      if (c.throwIn === `${kind}${n}Async`) {
        throw new GlobalHookError(`${kind}${n} async threw`)
      }
      return result
    })()
  }

const twice = (kind: string, pick: (args: any) => any) => [hook(kind, 0, pick), hook(kind, 1, pick)]

const globalHooks: GlobalConfig['hooks'] = {
  afterChange: twice('afterChange', (a) => a.doc),
  afterRead: twice('afterRead', (a) => a.doc),
  beforeChange: twice('beforeChange', (a) => a.data),
  beforeOperation: twice('beforeOperation', (a) => a.args),
  beforeRead: twice('beforeRead', (a) => a.doc),
  beforeValidate: twice('beforeValidate', (a) => a.data),
}

const hooked: GlobalConfig = {
  slug: 'hooked',
  access: {
    read: steeredAccess('read'),
    readVersions: steeredAccess('readVersions'),
    update: steeredAccess('update'),
    validate: steeredAccess('validate'),
  },
  fields: [
    { name: 'title', type: 'text' },
    { name: 'count', type: 'number' },
    { name: 'label', type: 'text', localized: true },
    {
      name: 'tagged',
      type: 'text',
      hooks: {
        afterRead: [({ value }) => (value ? `${value}!` : value)],
      },
    },
    { name: 'required', type: 'text', validate: (v: any) => (v === 'bad' ? 'bad value' : true) },
  ],
  hooks: globalHooks,
  versions: { drafts: true, max: 20 },
}

const plain: GlobalConfig = {
  slug: 'plain',
  fields: [
    { name: 'title', type: 'text' },
    { name: 'hidden', type: 'text', hidden: true },
  ],
  lockDocuments: { duration: 30 },
}

const authHooks = (prefix: string): CollectionConfig['hooks'] => ({
  afterForgotPassword: twice(`${prefix}afterForgotPassword`, () => undefined),
  afterLogin: twice(`${prefix}afterLogin`, (a) => a.user),
  afterLogout: twice(`${prefix}afterLogout`, (a) => a.args),
  afterMe: twice(`${prefix}afterMe`, (a) => a.response),
  afterOperation: twice(`${prefix}afterOperation`, (a) => a.result),
  afterRead: twice(`${prefix}afterRead`, (a) => a.doc),
  afterRefresh: twice(`${prefix}afterRefresh`, (a) => ({ exp: a.exp, refreshedToken: a.token })),
  beforeLogin: twice(`${prefix}beforeLogin`, (a) => a.user),
  beforeOperation: twice(`${prefix}beforeOperation`, (a) => a.args),
  beforeValidate: twice(`${prefix}beforeValidate`, (a) => a.data),
  me: [
    ({ args }: any) => {
      const c = ctx(args.req)
      log(c, 'me')
      return c.meHook ? { exp: 1, user: { id: 'from-me-hook' } } : undefined
    },
  ],
  refresh: [
    ({ args }: any) => {
      const c = ctx(args.req)
      log(c, 'refresh')
      return c.refreshHook
        ? { exp: 2, refreshedToken: 'from-refresh-hook', user: args.req.user }
        : undefined
    },
  ],
})

const users: CollectionConfig = {
  slug: 'users',
  access: {
    unlock: steeredAccess('unlock'),
  },
  auth: {
    forgotPassword: {
      generateEmailHTML: async ({ token }: any) => {
        await ticks(1)
        return `<p>reset ${String(token).length}</p>`
      },
      generateEmailSubject: ({ user }: any) => `reset for ${user?.email}`,
    },
    lockTime: 600 * 1000,
    maxLoginAttempts: 3,
    useSessions: true,
  },
  fields: [
    { name: 'name', type: 'text' },
    { name: 'secret', type: 'text', access: { read: ({ req }) => !ctx(req).hideSecret } },
  ],
  hooks: authHooks('users.'),
}

const verified: CollectionConfig = {
  slug: 'verified',
  auth: { verify: true, useSessions: false },
  fields: [{ name: 'name', type: 'text' }],
  hooks: authHooks('verified.'),
}

const usernames: CollectionConfig = {
  slug: 'usernames',
  auth: { loginWithUsername: { allowEmailLogin: true, requireEmail: false } },
  fields: [],
}

export default buildConfigWithDefaults({
  config: {
    collections: [users, verified, usernames],
    globals: [hooked, plain],
    localization: { defaultLocale: 'en', fallback: true, locales: ['en', 'es'] },
  },
  suite: 'core-ops-global-synthetic',
})
