/**
 * Drives every global and auth operation through a matrix of request contexts on the adversarial
 * config (./config.ts). The evidence is the cross-process trace comparison of ../run.sh (every
 * call below is a traced case, compared event for event between the TS reference and the Rust
 * run); the assertions here only check that the matrix actually ran (each operation reached,
 * both outcomes seen).
 */
import type { Payload } from 'payload'

import assert from 'node:assert/strict'
import { createPayloadRequest } from 'payload'

import { accessOperation } from '../../../../packages/payload/src/auth/operations/access.js'
import { initOperation } from '../../../../packages/payload/src/auth/operations/init.js'
import { logoutOperation } from '../../../../packages/payload/src/auth/operations/logout.js'
import { meOperation } from '../../../../packages/payload/src/auth/operations/me.js'
import { refreshOperation } from '../../../../packages/payload/src/auth/operations/refresh.js'
import { registerFirstUserOperation } from '../../../../packages/payload/src/auth/operations/registerFirstUser.js'
import { docAccessOperation } from '../../../../packages/payload/src/globals/operations/docAccess.js'
import { test } from '../../../__helpers/int/vitest.js'

type Any = any

const outcomes: Record<string, { error: number; ok: number }> = {}

const run = async (name: string, fn: () => Promise<unknown>): Promise<Any> => {
  const o = (outcomes[name] ??= { error: 0, ok: 0 })
  try {
    const result = await fn()
    o.ok++
    return result
  } catch (error) {
    o.error++
    return error
  }
}

const globalContexts: Record<string, unknown>[] = [
  {},
  { readDeny: true },
  { readWhere: true },
  { readAsync: true },
  { readThrow: true },
  { updateDeny: true },
  { updateWhere: true },
  { updateAsync: true },
  { readVersionsDeny: true },
  { readVersionsWhere: true },
  { validateDeny: true },
  { validateWhere: true },
  { throwIn: 'beforeOperation0' },
  { throwIn: 'beforeOperation1' },
  { throwIn: 'beforeRead1' },
  { throwIn: 'afterRead0' },
  { throwIn: 'beforeValidate1' },
  { throwIn: 'beforeChange0' },
  { throwIn: 'afterChange1' },
  { throwIn: 'afterRead1Async', tickMode: 3 },
  { replace: 'beforeOperation0' },
  { replace: 'beforeRead1' },
  { replace: 'afterRead0' },
  { replace: 'beforeValidate0' },
  { replace: 'beforeChange1' },
  { replace: 'afterChange0' },
  { tickMode: 0 },
  { tickMode: 1 },
  { tickMode: 2 },
  { tickMode: 3 },
]

const seedUser = async (payload: Payload, collection: string, email: string, extra = {}) =>
  payload.create({
    collection: collection as Any,
    data: { email, password: 'correct-horse', ...extra } as Any,
    overrideAccess: true,
  })

test.suite('core-ops-global synthetic', { config: './config.ts' }, () => {
  test('should run every global operation through the context matrix', async ({ payload }) => {
    const user = await seedUser(payload, 'users', 'global-user@example.com')
    const base = { overrideAccess: false, slug: 'hooked' as Any, user }

    await run('seed', () =>
      payload.updateGlobal({ slug: 'hooked' as Any, data: { title: 'allowed', count: 1 } as Any }),
    )
    await run('seed', () =>
      payload.updateGlobal({
        slug: 'hooked' as Any,
        data: { title: 'allowed', label: 'uno' } as Any,
        draft: true,
        locale: 'es',
      }),
    )

    for (const context of globalContexts) {
      await run('findGlobal', () => payload.findGlobal({ ...base, context }))
      await run('findGlobal', () =>
        payload.findGlobal({ ...base, context, depth: 0, draft: true, locale: 'all' as Any }),
      )
      await run('findGlobal', () =>
        payload.findGlobal({ ...base, context, select: { title: true } as Any }),
      )
      await run('updateGlobal', () =>
        payload.updateGlobal({ ...base, context, data: { count: 2, title: 'allowed' } as Any }),
      )
      await run('updateGlobal', () =>
        payload.updateGlobal({
          ...base,
          context,
          data: { label: 'dos', title: 'allowed' } as Any,
          draft: true,
          locale: 'es',
          select: { label: true } as Any,
        }),
      )
      await run('updateGlobal', () =>
        payload.updateGlobal({ ...base, context, data: { required: 'bad' } as Any }),
      )
      const versions: Any = await run('findGlobalVersions', () =>
        payload.findGlobalVersions({
          ...base,
          context,
          limit: 3,
          sort: '-updatedAt',
          where: { 'version.title': { equals: 'allowed' } } as Any,
        }),
      )
      await run('countGlobalVersions', () => payload.countGlobalVersions({ ...base, context }))
      const versionID = versions?.docs?.[0]?.id
      await run('findGlobalVersionByID', () =>
        payload.findGlobalVersionByID({ ...base, id: versionID ?? 'missing', context }),
      )
      await run('findGlobalVersionByID', () =>
        payload.findGlobalVersionByID({ ...base, id: '', context, disableErrors: true }),
      )
      if (versionID) {
        await run('restoreGlobalVersion', () =>
          payload.restoreGlobalVersion({ ...base, id: versionID, context }),
        )
        await run('restoreGlobalVersion', () =>
          payload.restoreGlobalVersion({ ...base, id: versionID, context, draft: true }),
        )
      }
      await run('validateGlobal', () =>
        payload.validateGlobal({ ...base, context, data: { title: 'candidate' } as Any }),
      )
      await run('validateGlobal', () =>
        payload.validateGlobal({ ...base, context, data: { required: 'bad' } as Any, draft: true }),
      )
      const req = await createPayloadRequest({ context, payload, user })
      await run('docAccess', () =>
        docAccessOperation({ globalConfig: payload.globals.config.find((g) => g.slug === 'hooked')!, req }),
      )
    }

    // A global without hooks or versions, with lock status and a hidden field.
    await run('updateGlobal', () =>
      payload.updateGlobal({ slug: 'plain' as Any, data: { hidden: 'h', title: 'p' } as Any }),
    )
    await run('findGlobal', () =>
      payload.findGlobal({ slug: 'plain' as Any, includeLockStatus: true, user } as Any),
    )
    await run('findGlobal', () =>
      payload.findGlobal({ slug: 'plain' as Any, showHiddenFields: true }),
    )
    await run('findGlobalVersions', () => payload.findGlobalVersions({ slug: 'plain' as Any }))
    await run('countGlobalVersions', () => payload.countGlobalVersions({ slug: 'plain' as Any }))

    for (const name of ['findGlobal', 'updateGlobal', 'findGlobalVersions', 'validateGlobal']) {
      assert.ok((outcomes[name]?.ok ?? 0) > 0, `${name}: no call succeeded`)
      assert.ok((outcomes[name]?.error ?? 0) > 0, `${name}: no call failed`)
    }
  })

  test('should run every auth operation through the context matrix', async ({ payload }) => {
    const authContexts: Record<string, unknown>[] = [
      {},
      { tickMode: 0 },
      { tickMode: 1 },
      { tickMode: 2 },
      { tickMode: 3 },
      { throwIn: 'users.beforeOperation1' },
      { throwIn: 'users.beforeLogin0' },
      { throwIn: 'users.afterLogin1' },
      { throwIn: 'users.afterRead0' },
      { throwIn: 'users.afterOperation0' },
      { throwIn: 'users.afterMe1' },
      { throwIn: 'users.afterRefresh0' },
      { throwIn: 'users.afterLogout0' },
      { throwIn: 'users.afterForgotPassword1' },
      { throwIn: 'users.beforeValidate0' },
      { replace: 'users.beforeOperation0' },
      { replace: 'users.beforeLogin1' },
      { replace: 'users.afterLogin0' },
      { replace: 'users.afterOperation1' },
      { replace: 'users.afterMe0' },
      { replace: 'users.afterRefresh1' },
      { hideSecret: true },
      { meHook: true },
      { refreshHook: true },
      { unlockDeny: true },
      { unlockWhere: true },
    ]
    const users = payload.collections.users

    for (const [i, context] of authContexts.entries()) {
      const email = `user${i}@example.com`
      await seedUser(payload, 'users', email, { name: `n${i}`, secret: 's' })

      // wrong passwords (login attempts, lock), invalid input, then the right one
      await run('login', () =>
        payload.login({ collection: 'users', context, data: { email, password: 'wrong' } }),
      )
      await run('login', () =>
        payload.login({ collection: 'users', context, data: { email: '', password: 'x' } as Any }),
      )
      await run('login', () =>
        payload.login({ collection: 'users', context, data: { email, password: '  ' } }),
      )
      const login: Any = await run('login', () =>
        payload.login({
          collection: 'users',
          context,
          data: { email: email.toUpperCase(), password: 'correct-horse' },
          depth: 0,
        }),
      )

      if (login?.user) {
        const req = await createPayloadRequest({
          context,
          payload,
          urlSuffix: '/api/users/refresh-token',
          user: login.user,
        })
        const sid = JSON.parse(Buffer.from(login.token.split('.')[1], 'base64url').toString()).sid
        req.user = { ...login.user, _sid: sid, collection: 'users' }
        await run('me', () => meOperation({ collection: users, currentToken: login.token, req }))
        await run('me', () =>
          meOperation({ collection: payload.collections.verified, currentToken: login.token, req }),
        )
        await run('refresh', () => refreshOperation({ collection: users, req }))
        const reqNoSession = await createPayloadRequest({
          context,
          payload,
          urlSuffix: '/api/users/refresh-token',
          user: login.user,
        })
        reqNoSession.user = { ...login.user, collection: 'users' }
        await run('refresh', () => refreshOperation({ collection: users, req: reqNoSession }))
        await run('access', () => accessOperation({ req }))
        await run('auth', () =>
          payload.auth({ headers: new Headers({ Authorization: `JWT ${login.token}` }) }),
        )
        await run('logout', () => logoutOperation({ collection: users, req }))
        await run('logout', () => logoutOperation({ allSessions: true, collection: users, req }))
        await run('logout', () => logoutOperation({ collection: payload.collections.verified, req }))
      }

      const reqInit = await createPayloadRequest({ context, payload })
      await run('init', () => initOperation({ collection: 'users', req: reqInit }))
      await run('init', () => initOperation({ collection: 'verified', req: reqInit }))

      await run('forgotPassword', () =>
        payload.forgotPassword({ collection: 'users', context, data: { email }, disableEmail: true }),
      )
      const token: Any = await run('forgotPassword', () =>
        payload.forgotPassword({ collection: 'users', context, data: { email } }),
      )
      await run('forgotPassword', () =>
        payload.forgotPassword({ collection: 'users', context, data: { email: 'nobody@x.com' } }),
      )
      await run('forgotPassword', () =>
        payload.forgotPassword({ collection: 'users', context, data: {} as Any }),
      )
      await run('resetPassword', () =>
        payload.resetPassword({
          collection: 'users',
          context,
          data: { password: 'correct-horse', token: typeof token === 'string' ? token : 'none' },
          overrideAccess: true,
        }),
      )
      await run('resetPassword', () =>
        payload.resetPassword({
          collection: 'users',
          context,
          data: { password: 'x', token: 'invalid' },
          overrideAccess: true,
        }),
      )
      await run('unlock', () =>
        payload.unlock({ collection: 'users', context, data: { email }, overrideAccess: false, user: login?.user } as Any),
      )
      await run('unlock', () =>
        payload.unlock({ collection: 'users', context, data: { email: 'nobody@x.com' }, overrideAccess: true }),
      )
    }

    // verify / registerFirstUser on the `verified` collection, username login
    const reqFirst = await createPayloadRequest({ payload })
    await run('registerFirstUser', () =>
      registerFirstUserOperation({
        collection: payload.collections.verified,
        data: { email: 'first@example.com', password: 'correct-horse' } as Any,
        req: reqFirst,
      }),
    )
    const reqSecond = await createPayloadRequest({ payload })
    await run('registerFirstUser', () =>
      registerFirstUserOperation({
        collection: payload.collections.verified,
        data: { email: 'second@example.com', password: 'correct-horse' } as Any,
        req: reqSecond,
      }),
    )
    await seedUser(payload, 'verified', 'unverified@example.com')
    await run('login', () =>
      payload.login({
        collection: 'verified' as Any,
        data: { email: 'unverified@example.com', password: 'correct-horse' },
      }),
    )
    const pending: Any = await payload.find({
      collection: 'verified' as Any,
      overrideAccess: true,
      showHiddenFields: true,
      where: { email: { equals: 'unverified@example.com' } },
    })
    const verificationToken = pending.docs[0]?._verificationToken
    await run('verifyEmail', () =>
      payload.verifyEmail({ collection: 'verified' as Any, token: verificationToken }),
    )
    await run('verifyEmail', () =>
      payload.verifyEmail({ collection: 'verified' as Any, token: 'invalid' }),
    )
    await seedUser(payload, 'usernames', 'u@example.com', { username: 'someone' })
    await run('login', () =>
      payload.login({
        collection: 'usernames' as Any,
        data: { password: 'correct-horse', username: 'SOMEONE' } as Any,
      }),
    )
    await run('login', () =>
      payload.login({
        collection: 'usernames' as Any,
        data: { email: 'u@example.com', password: 'correct-horse' } as Any,
      }),
    )
    await run('login', () =>
      payload.login({ collection: 'usernames' as Any, data: { password: 'x' } as Any }),
    )
    await run('forgotPassword', () =>
      payload.forgotPassword({ collection: 'usernames' as Any, data: { username: 'someone' } as Any }),
    )

    for (const name of ['login', 'forgotPassword', 'resetPassword', 'unlock', 'logout', 'me', 'refresh']) {
      assert.ok((outcomes[name]?.ok ?? 0) > 0, `${name}: no call succeeded`)
      assert.ok((outcomes[name]?.error ?? 0) > 0, `${name}: no call failed`)
    }
    assert.ok((outcomes.verifyEmail?.ok ?? 0) > 0, 'verifyEmail: no call succeeded')
    assert.ok((outcomes.registerFirstUser?.ok ?? 0) > 0, 'registerFirstUser: no call succeeded')
  })
})
