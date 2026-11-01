/**
 * Synthetic corpus for the differential replay of crates/payload-core-query: calls the real TS
 * query/select utilities with edge-case inputs. Only meaningful under the recorder:
 *
 *   test/__rs/core-query/record.sh __rs/core-query/synthetic
 */
import type { Payload } from 'payload'

import { createPayloadRequest } from 'payload'
import { expect } from 'vitest'

import { sanitizeSortQuery } from '../../../packages/payload/src/collections/operations/utilities/sanitizeSortQuery.js'
import { combineQueries } from '../../../packages/payload/src/database/combineQueries.js'
import { getLocalizedPaths } from '../../../packages/payload/src/database/getLocalizedPaths.js'
import { validateQueryPaths } from '../../../packages/payload/src/database/queryValidation/validateQueryPaths.js'
import { validateSortQuery } from '../../../packages/payload/src/database/queryValidation/validateSortQuery.js'
import { sanitizeJoinQuery } from '../../../packages/payload/src/database/sanitizeJoinQuery.js'
import { sanitizeWhereQuery } from '../../../packages/payload/src/database/sanitizeWhereQuery.js'
import { appendNonTrashedFilter } from '../../../packages/payload/src/utilities/appendNonTrashedFilter.js'
import { getFieldByPath } from '../../../packages/payload/src/utilities/getFieldByPath.js'
import { getSelectMode } from '../../../packages/payload/src/utilities/getSelectMode.js'
import { sanitizeSelect } from '../../../packages/payload/src/utilities/sanitizeSelect.js'
import { stripUnselectedFields } from '../../../packages/payload/src/utilities/stripUnselectedFields.js'
import { buildVersionCollectionFields } from '../../../packages/payload/src/versions/buildCollectionFields.js'
import { buildVersionGlobalFields } from '../../../packages/payload/src/versions/buildGlobalFields.js'
import {
  appendGlobalVersionToQueryKey,
  appendVersionToQueryKey,
} from '../../../packages/payload/src/versions/drafts/appendVersionToQueryKey.js'
import { getQueryDraftsSelect } from '../../../packages/payload/src/versions/drafts/getQueryDraftsSelect.js'
import { getQueryDraftsSort } from '../../../packages/payload/src/versions/drafts/getQueryDraftsSort.js'
import { test } from '../../__helpers/int/vitest.js'

const settle = async (fn: () => unknown) => {
  try {
    await fn()
  } catch {
    // errors are part of the recording
  }
}

const wheres = (): any[] => [
  { title: { equals: 'a' } },
  { title: { equals: 'a' }, secret: { equals: 'x' } },
  { internal: { equals: 'x' } },
  { title: { foo: 1 } },
  { title: 'abc' },
  { title: [1, 2] },
  { title: null },
  { AND: [{ title: { equals: 'a' } }, { 'author.name': { like: 'b' } }] },
  { Or: [{ title: { exists: true } }], and: [{ computed: { equals: 1 } }] },
  { 'author.name': { equals: 'x' } },
  { 'author.bio': { equals: 'x' } },
  { 'author.team.title': { equals: 'x' } },
  { 'authors.name': { equals: 'x' } },
  { authors: { contains: { name: { equals: 'x' } } } },
  { authors: { equals: { name: { equals: 'x' } } } },
  { authors: { like: { name: 'x' } } },
  { title: { like: [{ a: 1 }] } },
  { 'author.id': { equals: 1 } },
  { author__name: { equals: 'x' } },
  { _id: { equals: 1 } },
  { id: { in: [1, 2] } },
  { authorName: { equals: 'x' } },
  { 'group.teamTitle': { equals: 'x' } },
  { computed: { equals: 1 } },
  { 'localizedTitle.es': { equals: 'x' } },
  { localizedTitle: { equals: 'x' } },
  { 'group.localizedInner': { exists: true } },
  { 'meta.a.b': { equals: 1 } },
  { 'meta.a-b': { equals: 1 } },
  { 'layout.blockType': { equals: 'cq-block' } },
  { 'layout.text': { equals: 'x' } },
  { 'layout.nope': { equals: 'x' } },
  { 'items.label': { equals: 'x' } },
  { 'any.value': { equals: 1 } },
  { 'any.relationTo': { equals: 'cq-teams' } },
  { 'any.name': { equals: 1 } },
  { relationTo: { equals: 'x' } },
  { 'author.posts.title': { equals: 'x' } },
  { 'nope.deep': { equals: 1 } },
  { '': { equals: 1 } },
  { 1: { equals: 1 }, title: { equals: 2 }, 0: { exists: true } },
  { hash: { equals: 'x' } },
  { 'author.team': { equals: 1 }, and: { title: 1 } },
]

/**
 * Upstream quirk: a path callback of `validateSearchParam` may push a nested `validateQueryPaths`
 * promise after `Promise.all(promises)` started, so its rejection is unhandled. Those are part of
 * the reference behaviour, not test failures: they are counted here instead of failing the run.
 */
const absorbUnhandledRejections = () => {
  const saved = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  let count = 0
  const onUnhandled = () => {
    count++
  }
  process.on('unhandledRejection', onUnhandled)
  return async () => {
    await new Promise((resolve) => setImmediate(resolve))
    process.off('unhandledRejection', onUnhandled)
    for (const listener of saved) {
      process.on('unhandledRejection', listener as (...args: any[]) => void)
    }
    return count
  }
}

test.suite('core-query synthetic corpus', { config: './config.ts' }, () => {
  test('records the corpus', async ({ payload }: { payload: Payload }) => {
    const restoreUnhandled = absorbUnhandledRejections()
    const posts = payload.collections['cq-posts']!.config
    const authors = payload.collections['cq-authors']!.config
    const members = payload.collections['cq-members']!.config
    const settings = payload.globals.config.find((g) => g.slug === 'cq-settings')!
    const user = { id: 1, collection: 'cq-members', role: 'editor' }
    const reqs = [
      await createPayloadRequest({ locale: 'en', payload, user: user as any }),
      await createPayloadRequest({
        locale: 'es',
        payload,
        user: { ...user, role: 'admin' } as any,
      }),
      await createPayloadRequest({ locale: 'all', payload }),
    ]
    const versionFields = buildVersionCollectionFields(payload.config, posts, true)
    const globalVersionFields = buildVersionGlobalFields(payload.config, settings, true)

    for (const req of reqs) {
      for (const overrideAccess of [false, true]) {
        for (const where of wheres()) {
          await settle(() =>
            validateQueryPaths({ collectionConfig: posts, overrideAccess, req, where }),
          )
          await settle(() =>
            validateQueryPaths({
              collectionConfig: posts,
              overrideAccess,
              polymorphicJoin: true,
              req,
              where,
            }),
          )
          await settle(() =>
            validateQueryPaths({
              collectionConfig: posts,
              overrideAccess,
              req,
              versionFields,
              where: appendVersionToQueryKey(where),
            }),
          )
          await settle(() =>
            validateQueryPaths({
              globalConfig: settings,
              overrideAccess,
              req,
              versionFields: globalVersionFields,
              where: appendGlobalVersionToQueryKey(where),
            }),
          )
          await settle(() =>
            validateQueryPaths({ globalConfig: settings, overrideAccess, req, where }),
          )
          await settle(() =>
            validateQueryPaths({ collectionConfig: members, overrideAccess, req, where }),
          )
          await settle(() =>
            validateQueryPaths({ collectionConfig: authors, overrideAccess, req, where }),
          )
          await settle(() =>
            sanitizeWhereQuery({
              fields: posts.flattenedFields,
              payload,
              where: structuredClone(where),
            }),
          )
        }
        // concurrent validations sharing one request
        await settle(() =>
          Promise.all(
            wheres()
              .slice(8, 16)
              .map((where) =>
                validateQueryPaths({ collectionConfig: posts, overrideAccess, req, where }),
              ),
          ),
        )
        for (const sort of [
          'title',
          '-author.name',
          ['title', '-secret'],
          'internal',
          'author.bio',
          'author__name',
          '-id',
          '_id',
          'nope',
          'authorName',
          ['group.teamTitle', 'localizedTitle'],
          5,
          [undefined],
          '',
        ] as any[]) {
          await settle(() =>
            validateSortQuery({ collectionConfig: posts, overrideAccess, req, sort }),
          )
          await settle(() =>
            validateSortQuery({ globalConfig: settings, overrideAccess, req, sort }),
          )
          await settle(() =>
            validateSortQuery({
              collectionConfig: posts,
              overrideAccess,
              req,
              sort,
              versionFields,
            }),
          )
          await settle(() => sanitizeSortQuery({ fields: posts.flattenedFields, sort }))
          await settle(() => getQueryDraftsSort({ collectionConfig: posts, sort }))
          await settle(() => getQueryDraftsSort({ collectionConfig: authors, sort }))
        }
        for (const joins of [
          undefined,
          false,
          {},
          { posts: false },
          { posts: { where: { title: { equals: 'x' } }, sort: '-title' } },
          { posts: { where: { secret: { equals: 'x' } } } },
          { posts: { sort: 'internal' } },
          { posts: true },
        ] as any[]) {
          await settle(() =>
            sanitizeJoinQuery({
              collectionConfig: authors,
              joins: structuredClone(joins),
              overrideAccess,
              req,
            }),
          )
        }
      }
      for (const path of [
        'title',
        'localizedTitle',
        'localizedTitle.es',
        'author.name',
        'author.en.name',
        'authors.team.title',
        'any',
        'any.value',
        'any.other',
        'layout.text',
        'layout.blockType',
        'meta.x.y',
        'meta.x-y',
        'secret',
        'relationTo',
        'globalType',
        'id',
        'author.id',
        'group.localizedInner',
        'author.posts.title',
        'nope',
      ]) {
        for (const overrideAccess of [false, true]) {
          await settle(() =>
            getLocalizedPaths({
              collectionSlug: posts.slug,
              fields: posts.flattenedFields,
              globalSlug: overrideAccess ? 'cq-settings' : undefined,
              incomingPath: path,
              locale: req.locale!,
              overrideAccess,
              parentIsLocalized: overrideAccess ? undefined : false,
              payload,
              showHiddenFields: !overrideAccess,
            }),
          )
        }
        await settle(() => getFieldByPath({ fields: posts.flattenedFields, path }))
        await settle(() =>
          getFieldByPath({
            config: payload.config,
            fields: posts.flattenedFields,
            includeRelationships: true,
            path,
          }),
        )
      }
    }

    for (const select of [
      undefined,
      {},
      { title: true },
      { authorName: true },
      { group: { teamTitle: true } },
      { group: true },
      { title: false },
      { group: { inner: false } },
      { author: true, authorName: true },
      { group: null },
    ] as any[]) {
      await settle(() =>
        sanitizeSelect({ fields: posts.flattenedFields, select: structuredClone(select) }),
      )
      await settle(() =>
        sanitizeSelect({
          fields: versionFields as any,
          select: structuredClone(select),
          versions: true,
        }),
      )
      await settle(() => getQueryDraftsSelect({ select }))
      await settle(() => select && getSelectMode(select))
      for (const field of posts.fields) {
        for (const selectMode of ['include', 'exclude'] as const) {
          await settle(() =>
            stripUnselectedFields({
              field,
              select: select ?? {},
              selectMode,
              siblingDoc: { group: { inner: 'x' }, title: 'a', authorName: 'b' },
            }),
          )
        }
      }
    }

    for (const where of [
      undefined,
      {},
      { and: [{ a: 1 }] },
      { and: 'xy' },
      { title: 1 },
      null,
    ] as any[]) {
      for (const enableTrash of [false, true]) {
        await settle(() => appendNonTrashedFilter({ enableTrash, trash: false, where }))
        await settle(() =>
          appendNonTrashedFilter({
            deletedAtPath: 'version.deletedAt',
            enableTrash,
            trash: true,
            where,
          }),
        )
      }
      await settle(() => combineQueries(where, { x: { equals: 1 } }))
      await settle(() => combineQueries(where, true))
      await settle(() => appendVersionToQueryKey(where))
      await settle(() => appendGlobalVersionToQueryKey(where))
    }
    await settle(() => appendVersionToQueryKey({ OR: [{ id: 1 }], 2: 'x', id: 3 } as any))

    const unhandled = await restoreUnhandled()
    console.log(
      `[core-query synthetic] ${unhandled} unhandled rejections from floating validations`,
    )
    expect(unhandled).toBeGreaterThan(0)
  })
})
