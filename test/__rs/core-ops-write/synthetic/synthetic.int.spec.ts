/**
 * Drives every ported write operation (create, update, updateByID, delete, deleteByID, duplicate,
 * restoreVersion, validate) through a matrix of request contexts on the adversarial config
 * (./config.ts). Under `PAYLOAD_OPS=shadow` (test/__rs/core-ops-write/vitest.config.ts) every
 * top-level call is compared TS vs Rust by ../shadow.ts, and the last test asserts that cases
 * were compared, none differed and every Rust branch ran Rust. Under `ts` / `rs` every call's
 * outcome (result or error, with ids, tokens and timestamps normalized) is recorded and written to
 * `RS_OPS_OUT/synthetic.outcomes`; summarize.mjs fails when the `rs` outcomes differ from the
 * `ts` ones or none were recorded.
 */
import type { Payload } from 'payload'

import { createPayloadRequest } from 'payload'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { validateOperation } from '../../../../packages/payload/src/collections/operations/validate.js'
import { test } from '../../../__helpers/int/vitest.js'
import { getStats } from '../shadow.js'

type Any = any

const outcomes: string[] = []

const normalize = (value: unknown): string => {
  const tokens = new Map<string, number>()
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === 'string') {
      if (/^[0-9a-f]{24,}$/.test(v) || /^[0-9a-f-]{36}$/.test(v)) {
        if (!tokens.has(v)) {
          tokens.set(v, tokens.size)
        }
        return `<token ${tokens.get(v)}>`
      }
      if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
        return '<date>'
      }
      if (v.startsWith('pbkdf2')) {
        return '<hash>'
      }
    }
    if (v === undefined) {
      return '<undefined>'
    }
    return v
  })
}

const rec = async (label: string, run: () => Promise<unknown>): Promise<Any> => {
  try {
    const result = await run()
    outcomes.push(`${label} ok ${normalize(result)}`)
    return result
  } catch (error) {
    const e = error as Any
    outcomes.push(
      `${label} err ${e?.constructor?.name}:${e?.name}:${e?.status}:${e?.message}:${normalize(e?.data)}`,
    )
    return undefined
  }
}

/** `context` per call (fresh object), steering the hooks and access functions of the config. */
const contexts: Record<string, unknown>[] = [
  {},
  { throwIn: 'beforeOperation' },
  { throwIn: 'beforeValidate' },
  { throwIn: 'beforeValidateSync' },
  { throwIn: 'beforeChange' },
  { throwIn: 'afterChange' },
  { throwIn: 'afterChangeSync' },
  { throwIn: 'afterRead' },
  { throwIn: 'afterOperation' },
  { throwIn: 'beforeDelete' },
  { throwIn: 'afterDelete' },
  { throwIn: 'field:title.beforeChange' },
  { throwIn: 'field:title.afterChange' },
  { falsyIn: 'beforeValidate' },
  { falsyIn: 'afterRead' },
  { replace: 'beforeChange', thenableIn: 'beforeChange' },
  { replace: 'afterRead', syncIn: 'afterRead' },
  { replace: 'beforeOperation' },
  { replace: 'afterOperation' },
  { replace: 'afterChange' },
  { replace: 'afterDelete' },
  { createDeny: true, deleteDeny: true, updateDeny: true },
  { createWhere: true, deleteWhere: true, updateWhere: true },
  { createAsync: true, deleteAsync: true, updateAsync: true },
  { createThrow: true, deleteThrow: true, updateThrow: true },
  { denyField: true },
  { afterChangeTicks: 5, beforeValidateTicks: 0, fieldTicks: 3 },
]

const seed = async (payload: Payload, collection: string, extra: Record<string, unknown> = {}) => {
  const docs = []
  for (let i = 0; i < 3; i++) {
    docs.push(
      await payload.create({
        collection: collection as Any,
        context: { seeding: true },
        data: { num: i + 1, title: `seed ${i}`, ...extra } as Any,
        overrideAccess: true,
      }),
    )
  }
  return docs
}

const hookedLike = ['hooked', 'trashable', 'restricted']

const seedUsername = (payload: Payload) =>
  payload.create({
    collection: 'usernames' as Any,
    context: { seeding: true },
    data: { password: 'correct-horse-battery', username: 'existing-user' } as Any,
    overrideAccess: true,
  })

test.suite('Rust write operations synthetic', { config: './config.ts' }, () => {
  test('should create under every context', async ({ payload }) => {
    for (const collection of hookedLike) {
      for (const [i, context] of contexts.entries()) {
        await rec(`create ${collection} ${i}`, () =>
          payload.create({
            collection: collection as Any,
            context: { ...context },
            data: {
              group: { inner: 'g' },
              num: i,
              rows: [{ label: 'a' }, { label: 'b' }],
              secret: 's',
              title: `t${i}`,
            } as Any,
            overrideAccess: false,
          }),
        )
      }
      await rec(`create ${collection} invalid`, () =>
        payload.create({
          collection: collection as Any,
          data: { title: 'invalid' } as Any,
          overrideAccess: true,
        }),
      )
      await rec(`create ${collection} select`, () =>
        payload.create({
          collection: collection as Any,
          data: { num: 7, title: 'sel' } as Any,
          select: { title: true },
        }),
      )
    }
  })

  test('should updateByID under every context', async ({ payload }) => {
    for (const collection of hookedLike) {
      const docs = await seed(payload, collection)
      for (const [i, context] of contexts.entries()) {
        await rec(`updateByID ${collection} ${i}`, () =>
          payload.update({
            id: docs[i % 3].id,
            collection: collection as Any,
            context: { ...context },
            data: { num: i, rows: [{ label: 'u' }], title: `u${i}` } as Any,
            overrideAccess: false,
          }),
        )
      }
      await rec(`updateByID ${collection} missing`, () =>
        payload.update({ id: 99999, collection: collection as Any, data: { title: 'x' } as Any }),
      )
      await rec(`updateByID ${collection} invalid`, () =>
        payload.update({
          id: docs[0].id,
          collection: collection as Any,
          data: { title: 'invalid' } as Any,
        }),
      )
    }
  })

  test('should bulk update under every context', async ({ payload }) => {
    for (const collection of ['hooked', 'trashable']) {
      await seed(payload, collection)
      for (const [i, context] of contexts.entries()) {
        await rec(`update ${collection} ${i}`, () =>
          payload.update({
            collection: collection as Any,
            context: { ...context },
            data: { title: `bulk${i}` } as Any,
            overrideAccess: false,
            where: { num: { exists: true } },
          }),
        )
      }
      await rec(`update ${collection} per-doc failure`, () =>
        payload.update({
          collection: collection as Any,
          context: { throwForHook: 'beforeChange', throwForNum: 102 },
          data: { title: 'partial' } as Any,
          where: { num: { exists: true } },
        }),
      )
      await rec(`update ${collection} no where`, () =>
        payload.update({
          collection: collection as Any,
          data: { title: 'x' } as Any,
          where: undefined as Any,
        }),
      )
      await rec(`update ${collection} sort limit`, () =>
        payload.update({
          collection: collection as Any,
          data: { title: 'sorted' } as Any,
          limit: 2,
          sort: '-num',
          where: { num: { exists: true } },
        }),
      )
    }
    await rec('update restricted bulk disabled', () =>
      payload.update({
        collection: 'restricted' as Any,
        data: { title: 'x' } as Any,
        overrideAccess: false,
        where: { num: { exists: true } },
      }),
    )
  })

  test('should delete under every context', async ({ payload }) => {
    for (const collection of hookedLike) {
      for (const [i, context] of contexts.entries()) {
        const docs = await seed(payload, collection)
        await rec(`deleteByID ${collection} ${i}`, () =>
          payload.delete({
            id: docs[0].id,
            collection: collection as Any,
            context: { ...context },
            overrideAccess: false,
          }),
        )
        await rec(`delete ${collection} ${i}`, () =>
          payload.delete({
            collection: collection as Any,
            context: { ...context },
            overrideAccess: false,
            where: { num: { exists: true } },
          }),
        )
      }
      await rec(`deleteByID ${collection} missing`, () =>
        payload.delete({ id: 99999, collection: collection as Any }),
      )
      await seed(payload, collection)
      await rec(`delete ${collection} per-doc failure`, () =>
        payload.delete({
          collection: collection as Any,
          context: { throwForHook: 'afterDelete', throwForNum: 102 },
          where: { num: { exists: true } },
        }),
      )
    }
    await seed(payload, 'no-bulk-delete')
    await rec('delete no-bulk-delete', () =>
      payload.delete({
        collection: 'no-bulk-delete' as Any,
        overrideAccess: false,
        where: { title: { exists: true } },
      }),
    )
  })

  test('should duplicate', async ({ payload }) => {
    for (const collection of ['hooked', 'restricted', 'drafts']) {
      const [doc] = await seed(
        payload,
        collection,
        collection === 'drafts' ? { required: 'r' } : {},
      )
      for (const [i, context] of contexts.slice(0, 12).entries()) {
        await rec(`duplicate ${collection} ${i}`, () =>
          payload.duplicate({
            id: doc.id,
            collection: collection as Any,
            context: { ...context },
            overrideAccess: false,
          }),
        )
      }
      await rec(`duplicate ${collection} data`, () =>
        payload.duplicate({ id: doc.id, collection: collection as Any, data: { num: 50 } as Any }),
      )
    }
  })

  test('should save drafts, autosave, publish and restore versions', async ({ payload }) => {
    const doc = await rec('drafts create draft', () =>
      payload.create({ collection: 'drafts' as Any, data: { title: 'd1' } as Any, draft: true }),
    )
    await rec('drafts create published invalid', () =>
      payload.create({ collection: 'drafts' as Any, data: { title: 'd2' } as Any }),
    )
    if (!doc) {
      return
    }
    for (const [i, variant] of [
      { draft: true },
      { autosave: true, draft: true },
      { autosave: true, draft: true },
      { data: { required: 'now' } },
      { draft: true, locale: 'es' },
      { locale: 'all', data: { title: { en: 'all-en', es: 'all-es' }, required: 'x' } },
      { publishAllLocales: true, data: { required: 'y' } },
      { draft: true, context: { throwIn: 'beforeChange' } },
      { draft: true, context: { updateDeny: true }, overrideAccess: false },
    ].entries()) {
      const { context, data, ...rest } = variant as Any
      await rec(`drafts updateByID ${i}`, () =>
        payload.update({
          id: doc.id,
          collection: 'drafts' as Any,
          context: { ...(context ?? {}) },
          data: { num: i, title: `v${i}`, ...(data ?? {}) } as Any,
          ...rest,
        }),
      )
    }
    const versions = await payload.findVersions({ collection: 'drafts' as Any, sort: 'createdAt' })
    for (const [i, version] of versions.docs.entries()) {
      for (const variant of [{}, { draft: true }, { context: { throwIn: 'afterChange' } }]) {
        const { context, ...rest } = variant as Any
        await rec(`restoreVersion ${i} ${normalize(variant)}`, () =>
          payload.restoreVersion({
            id: version.id,
            collection: 'drafts' as Any,
            context: { ...(context ?? {}) },
            ...rest,
          }),
        )
      }
    }
    await rec('restoreVersion missing', () =>
      payload.restoreVersion({ id: 99999 as Any, collection: 'drafts' as Any }),
    )
    await rec('drafts bulk draft update', () =>
      payload.update({
        collection: 'drafts' as Any,
        data: { title: 'bulk draft' } as Any,
        draft: true,
        where: { id: { exists: true } },
      }),
    )
  })

  test('should trash and restore from trash', async ({ payload }) => {
    const docs = await seed(payload, 'trashable')
    await rec('trash updateByID', () =>
      payload.update({
        id: docs[0].id,
        collection: 'trashable' as Any,
        data: { deletedAt: new Date().toISOString() } as Any,
      }),
    )
    await rec('trash updateByID denied', () =>
      payload.update({
        id: docs[1].id,
        collection: 'trashable' as Any,
        context: { deleteDeny: true },
        data: { deletedAt: new Date().toISOString() } as Any,
        overrideAccess: false,
      }),
    )
    await rec('trash bulk', () =>
      payload.update({
        collection: 'trashable' as Any,
        data: { deletedAt: new Date().toISOString() } as Any,
        where: { num: { greater_than: 1 } },
      }),
    )
    await rec('trash untrash without trash flag', () =>
      payload.update({
        id: docs[0].id,
        collection: 'trashable' as Any,
        data: { deletedAt: null } as Any,
      }),
    )
    await rec('trash untrash', () =>
      payload.update({
        id: docs[0].id,
        collection: 'trashable' as Any,
        data: { deletedAt: null } as Any,
        trash: true,
      }),
    )
    await rec('trash deleteByID trashed', () =>
      payload.delete({ id: docs[1].id, collection: 'trashable' as Any, trash: true }),
    )
    await rec('trash delete all', () =>
      payload.delete({
        collection: 'trashable' as Any,
        trash: true,
        where: { id: { exists: true } },
      }),
    )
  })

  test('should create and update auth documents', async ({ payload }) => {
    const user = await rec('accounts create', () =>
      payload.create({
        collection: 'accounts' as Any,
        data: { email: 'a@example.com', name: 'a', num: 1, password: 'pw' } as Any,
      }),
    )
    await rec('accounts create no email', () =>
      payload.create({ collection: 'accounts' as Any, data: { name: 'b', password: 'pw' } as Any }),
    )
    await rec('accounts create duplicate email', () =>
      payload.create({
        collection: 'accounts' as Any,
        data: { email: 'a@example.com', name: 'c', password: 'pw' } as Any,
      }),
    )
    if (user) {
      await rec('accounts password update', () =>
        payload.update({
          id: user.id,
          collection: 'accounts' as Any,
          data: { password: 'new' } as Any,
        }),
      )
      await rec('accounts name update', () =>
        payload.update({
          id: user.id,
          collection: 'accounts' as Any,
          data: { name: 'renamed' } as Any,
        }),
      )
      await rec('accounts bulk update', () =>
        payload.update({
          collection: 'accounts' as Any,
          data: { num: 5 } as Any,
          where: { email: { exists: true } },
        }),
      )
      await rec('accounts deleteByID', () =>
        payload.delete({ id: user.id, collection: 'accounts' as Any }),
      )
    }
  })

  test('should validate', async ({ payload }) => {
    const docs = await seed(payload, 'hooked')
    for (const [i, variant] of [
      { data: { title: 'ok' } },
      { data: { title: 'invalid' } },
      { context: { validateDeny: true }, data: { title: 'ok' }, overrideAccess: false },
      { context: { validateWhere: true }, data: { title: 'ok' }, overrideAccess: false },
      { data: { title: 'ok' }, id: docs[0].id },
      {
        context: { validateWhere: true },
        data: { title: 'ok' },
        id: docs[0].id,
        overrideAccess: false,
      },
      { data: { title: 'ok' }, id: 99999 },
      { data: { title: 'ok' }, locale: 'all' },
    ].entries()) {
      const { context, ...rest } = variant as Any
      await rec(`validate hooked ${i}`, () =>
        payload.validate({ collection: 'hooked' as Any, context: { ...(context ?? {}) }, ...rest }),
      )
    }
    // runValidationLifecycle's hook loops, traversals and callbacks under every context, for a
    // new document and an existing one; the operation itself (not the Local API) for the
    // `onValidationData` / `skipMutationHooks` / `validationOperation` arguments.
    for (const [i, context] of contexts.entries()) {
      for (const id of [undefined, docs[1].id]) {
        await rec(`validate hooked context ${i} ${id === undefined ? 'new' : 'existing'}`, () =>
          payload.validate({
            id,
            collection: 'hooked' as Any,
            context: { ...context },
            data: { title: `v${i}` },
            overrideAccess: false,
          } as Any),
        )
      }
      for (const variant of [
        { skipMutationHooks: true },
        { validationOperation: 'create' },
        { id: docs[1].id, validationOperation: 'update' },
        // a field beforeChange hook changing the value: `processedData` (onDataProcessed) differs
        // from the data the lifecycle passed in
        { fieldReplace: true, id: docs[1].id, validationOperation: 'update' },
      ]) {
        const { fieldReplace, ...operationArgs } = variant as Any
        const req = await createPayloadRequest({
          context: { ...context, ...(fieldReplace ? { fieldReplace: 'title.beforeChange' } : {}) },
          payload,
        })
        await rec(`validateOperation hooked context ${i} ${JSON.stringify(variant)}`, () =>
          validateOperation({
            collection: payload.collections['hooked' as Any],
            data: { title: `o${i}` },
            onValidationData: (data: Any) => {
              outcomes.push(`onValidationData ${i} ${normalize(data)}`)
            },
            req,
            ...operationArgs,
          } as Any),
        )
      }
    }
    // the auth `beforeValidation` (ensureUsernameOrEmail) and unique-constraint `validateData`
    for (const id of [undefined, (await seedUsername(payload)).id]) {
      await rec(
        `validate usernames without username ${id === undefined ? 'new' : 'existing'}`,
        () =>
          payload.validate({
            id,
            collection: 'usernames' as Any,
            data: { name: 'n', username: '' } as Any,
          } as Any),
      )
    }
    await rec('validate accounts new without email', () =>
      payload.validate({
        collection: 'accounts' as Any,
        data: { password: 'correct-horse-battery' } as Any,
      }),
    )
    await rec('validate accounts new', () =>
      payload.validate({
        collection: 'accounts' as Any,
        data: { email: 'v@example.com', password: 'correct-horse-battery' } as Any,
      }),
    )
    const account = await payload.create({
      collection: 'accounts' as Any,
      data: { email: 'taken@example.com', password: 'correct-horse-battery' } as Any,
    })
    await rec('validate accounts duplicate email', () =>
      payload.validate({
        collection: 'accounts' as Any,
        data: { email: 'taken@example.com', password: 'correct-horse-battery' } as Any,
      }),
    )
    await rec('validate accounts existing', () =>
      payload.validate({
        id: account.id,
        collection: 'accounts' as Any,
        data: { email: '' } as Any,
      }),
    )
    const draft = await payload.create({
      collection: 'drafts' as Any,
      data: { title: 'vd' } as Any,
      draft: true,
    })
    await rec('validate drafts draft', () =>
      payload.validate({ id: draft.id, collection: 'drafts' as Any, data: {} as Any, draft: true }),
    )
    await rec('validate drafts published', () =>
      payload.validate({ id: draft.id, collection: 'drafts' as Any, data: {} as Any }),
    )
  })

  test('should report the comparison', () => {
    const out = process.env.RS_OPS_OUT
    const { mode, stats } = getStats()
    if (out && mode !== 'shadow') {
      fs.mkdirSync(out, { recursive: true })
      fs.writeFileSync(path.join(out, 'synthetic.outcomes'), JSON.stringify(outcomes))
    }
    if (mode === 'shadow') {
      const total = Object.values(stats).reduce(
        (acc, s) => ({
          compared: acc.compared + s.compared,
          diffs: acc.diffs + s.diffs,
          sameEngine: acc.sameEngine + s.sameEngine,
        }),
        { compared: 0, diffs: 0, sameEngine: 0 },
      )
      assert.ok(total.compared > 0, 'no case compared')
      assert.equal(total.diffs, 0, 'shadow diffs')
      assert.equal(total.sameEngine, 0, 'branches ran the wrong engine')
    } else {
      assert.ok(outcomes.length > 0, 'no outcome recorded')
    }
  })
})
