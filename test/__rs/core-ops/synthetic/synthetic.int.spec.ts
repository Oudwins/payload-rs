/**
 * Drives every ported read operation through a matrix of request contexts on the adversarial
 * config (./config.ts). Under `PAYLOAD_OPS=shadow` (test/__rs/core-ops/vitest.config.ts) every
 * call is compared TS vs Rust by ../shadow.ts, and the last test asserts that cases were compared
 * and none differed. Under `ts` / `rs` it only runs the calls (outcome parity via run.sh).
 */
import type { Payload } from 'payload'

import { createPayloadRequest } from 'payload'
import { expect } from 'vitest'

import { docAccessOperation } from '../../../../packages/payload/src/collections/operations/docAccess.js'
import { test } from '../../../__helpers/int/vitest.js'
import { getStats } from '../shadow.js'

const contexts: Record<string, unknown>[] = [
  {},
  { readDeny: true },
  { readWhere: true },
  { readNull: true },
  { readAsync: true },
  { readThrow: true },
  { replaceArgs: { limit: 1 } },
  { replaceArgs: { where: { num: { equals: 2 } } } },
  { throwIn: 'beforeOperation' },
  { throwIn: 'beforeRead' },
  { throwIn: 'afterRead' },
  { throwIn: 'afterReadSync' },
  { throwIn: 'afterOperation' },
  { beforeReadFalsy: true },
  { replaceResult: true },
  { afterReadTicks: 3, beforeReadTicks: 0, fieldTicks: 4 },
  { denyField: true },
  { targetsDeny: true },
  { targetsWhere: true },
  { readVersionsDeny: true },
  { readVersionsWhere: true },
  { mediaDeny: true },
  { mediaVersionsWhere: true },
]

const seed = async (payload: Payload) => {
  const user = await payload.create({
    collection: 'users',
    overrideAccess: true,
    data: { name: 'u', email: 'ops@example.com', password: 'test' },
  })
  const targets = []
  for (let i = 0; i < 3; i++) {
    targets.push(
      await payload.create({
        collection: 'targets',
        overrideAccess: true,
        data: { num: i, title: `target ${i}` },
      }),
    )
  }
  const posts = []
  for (let i = 0; i < 4; i++) {
    posts.push(
      await payload.create({
        collection: 'posts',
        overrideAccess: true,
        data: {
          _status: 'published',
          group: { a: `g${i}` },
          guarded: `guard ${i}`,
          hooked: `hook ${i}`,
          num: i,
          rel: targets[i % 3]!.id,
          relMany: [targets[0]!.id, targets[(i + 1) % 3]!.id],
          rows: [{ x: `r${i}a` }, { x: `r${i}b` }],
          secret: `secret ${i}`,
          title: `post ${3 - i}`,
        } as any,
      }),
    )
  }
  // a newer draft on top of a published post
  await payload.update({
    collection: 'posts',
    overrideAccess: true,
    id: posts[1]!.id,
    data: { title: 'post draft', _status: 'draft' } as any,
    draft: true,
  })
  const media = await payload.create({
    collection: 'media',
    overrideAccess: true,
    data: { alt: 'a' },
    file: { name: 'ops.txt', data: Buffer.from('hello'), mimetype: 'text/plain', size: 5 },
  })
  await payload.update({
    collection: 'media',
    overrideAccess: true,
    id: media.id,
    data: { alt: 'b' },
  })
  await payload.create({
    collection: 'payload-locked-documents',
    overrideAccess: true,
    data: {
      document: { relationTo: 'posts', value: posts[2]!.id },
      globalSlug: undefined,
      user: { relationTo: 'users', value: user.id },
    } as any,
  })
  return { media, posts, targets, user }
}

/** Runs `fn` for every context and access mode; failures are expected and swallowed. */
const matrix = async (
  user: unknown,
  fn: (options: {
    context: Record<string, unknown>
    overrideAccess: boolean
    user: any
  }) => Promise<unknown>,
) => {
  let calls = 0
  for (const overrideAccess of [false, true]) {
    for (const context of contexts) {
      calls++
      await fn({ context: structuredClone(context), overrideAccess, user }).catch(() => undefined)
    }
  }
  return calls
}

test.suite('core ops differential (synthetic)', { config: './config.ts' }, () => {
  test('should run find variants', async ({ payload }) => {
    const { user } = await seed(payload)
    const variants: Record<string, unknown>[] = [
      {},
      { where: { num: { greater_than_equal: 1 } }, sort: '-num' },
      { sort: ['title', '-relTitle'] },
      { sort: 'relTitle' },
      { select: { title: true, group: { a: true } } },
      { select: { secret: false, rows: false } },
      { depth: 0, limit: 2, page: 2 },
      { depth: 2, limit: 0 },
      { pagination: false },
      { draft: true },
      { draft: true, select: { title: true } },
      { includeLockStatus: true },
      { showHiddenFields: true },
      { trash: true },
      { joins: false },
    ]
    for (const variant of variants) {
      await matrix(user, (o) => payload.find({ collection: 'posts', ...o, ...variant } as any))
    }
    await Promise.all(
      contexts
        .slice(0, 6)
        .map((context) =>
          payload
            .find({ collection: 'posts', context, depth: 1, overrideAccess: false, user } as any)
            .catch(() => undefined),
        ),
    )
    await matrix(user, (o) => payload.find({ collection: 'media', ...o } as any))
    await matrix(user, (o) => payload.find({ collection: 'users', ...o } as any))
    expect(true).toBe(true)
  })

  test('should run findByID variants', async ({ payload }) => {
    const { media, posts, user } = await seed(payload)
    const variants: Record<string, unknown>[] = [
      { id: posts[0]!.id },
      { id: posts[1]!.id, draft: true },
      { id: posts[1]!.id, draft: true, select: { title: true } },
      { id: posts[2]!.id, includeLockStatus: true },
      { id: posts[3]!.id, depth: 2, select: { rel: true, relMany: true } },
      { id: 999999 },
      { id: 999999, disableErrors: true },
      { id: '' },
      { id: Number.NaN },
      { id: posts[0]!.id, data: { id: posts[0]!.id, title: 'given' } },
      { id: posts[0]!.id, flattenLocales: false },
    ]
    for (const variant of variants) {
      await matrix(user, (o) => payload.findByID({ collection: 'posts', ...o, ...variant } as any))
    }
    await matrix(user, (o) => payload.findByID({ collection: 'media', id: media.id, ...o } as any))
    await matrix(user, (o) => payload.findByID({ collection: 'users', id: user.id, ...o } as any))
    expect(true).toBe(true)
  })

  test('should run count, countVersions and findDistinct variants', async ({ payload }) => {
    const { user } = await seed(payload)
    await matrix(user, (o) => payload.count({ collection: 'posts', ...o } as any))
    await matrix(user, (o) =>
      payload.count({ collection: 'posts', where: { num: { less_than: 3 } }, ...o } as any),
    )
    await matrix(user, (o) => payload.countVersions({ collection: 'posts', ...o } as any))
    for (const variant of [
      { field: 'title' },
      { field: 'title', sort: '-title', limit: 2, page: 1 },
      { field: 'rel', depth: 1 },
      { field: 'relMany', depth: 1 },
      { field: 'rel.title' },
      { field: 'relTitle' },
      { field: 'secret' },
      { field: 'secret', showHiddenFields: true },
      { field: 'guarded' },
      { field: 'nope' },
      { field: 'group.a', where: { num: { greater_than: 0 } } },
    ]) {
      await matrix(user, (o) =>
        payload.findDistinct({ collection: 'posts', ...o, ...variant } as any),
      )
    }
    expect(true).toBe(true)
  })

  test('should run findVersions, findVersionByID and docAccess variants', async ({ payload }) => {
    const { media, posts, user } = await seed(payload)
    for (const variant of [
      {},
      { where: { parent: { equals: posts[1]!.id } }, sort: '-updatedAt' },
      { select: { version: { title: true } } },
      { limit: 1, page: 2 },
      { pagination: false, depth: 1 },
    ]) {
      await matrix(user, (o) =>
        payload.findVersions({ collection: 'posts', ...o, ...variant } as any),
      )
    }
    await matrix(user, (o) => payload.findVersions({ collection: 'media', ...o } as any))
    const { docs: versions } = await payload.findVersions({
      collection: 'posts',
      limit: 3,
      overrideAccess: true,
    })
    const { docs: mediaVersions } = await payload.findVersions({
      collection: 'media',
      limit: 1,
      overrideAccess: true,
    })
    for (const version of versions) {
      await matrix(user, (o) =>
        payload.findVersionByID({ collection: 'posts', id: version.id, ...o } as any),
      )
    }
    await matrix(user, (o) =>
      payload.findVersionByID({
        collection: 'posts',
        id: versions[0]!.id,
        select: { version: { title: true } },
        ...o,
      } as any),
    )
    await matrix(user, (o) =>
      payload.findVersionByID({
        collection: 'posts',
        id: 'nope',
        disableErrors: true,
        ...o,
      } as any),
    )
    await matrix(user, (o) =>
      payload.findVersionByID({ collection: 'media', id: mediaVersions[0]!.id, ...o } as any),
    )
    for (const id of [posts[0]!.id, undefined]) {
      for (const context of contexts) {
        await docAccessOperation({
          id,
          collection: payload.collections.posts,
          req: await createPayloadRequest({
            context: structuredClone(context),
            payload,
            user: user as any,
          }),
        } as any).catch(() => undefined)
      }
    }
    await docAccessOperation({
      id: media.id,
      collection: payload.collections.media,
      req: await createPayloadRequest({ payload, user: user as any }),
    } as any).catch(() => undefined)
    expect(true).toBe(true)
  })

  test('should have compared operations without diffs (shadow mode)', () => {
    const { diffs, mode, stats } = getStats()
    if (mode !== 'shadow') {
      return
    }
    const compared = Object.values(stats).reduce((n, s) => n + s.compared, 0)
    const diffCount = Object.values(stats).reduce((n, s) => n + s.diffs, 0)
    expect(compared).toBeGreaterThan(0)
    expect(diffs.slice(0, 3)).toEqual([])
    expect(diffCount).toBe(0)
  })
})
