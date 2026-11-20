/**
 * The reviewers' probes (.rs-baseline/review-mongo-query-sol.md, engine item 5 of
 * review-mongo-joins-engine-glue-sol.md) and adversarial live inputs, each run through upstream's
 * TS and the Rust port by harness.ts (traced clones: reads/writes, model calls, ticks, results with
 * identity/classes, errors incl. identity, input mutations), plus the module-internal exports
 * (parseParams, buildSearchParam, buildAndOrConditions, sanitizeQueryValue,
 * getLocalizedSortProperty) and an extreme-nesting crash check.
 *
 * Each probe also asserts the upstream behaviour it is about, so a probe that stops exercising its
 * branch fails instead of passing vacuously.
 */
import type { Payload } from 'payload'

import { expect } from 'vitest'

import { buildAndOrConditions as buildAndOrConditionsTS } from '../../../packages/db-mongodb/src/queries/buildAndOrConditions.js'
import { buildQuery as buildQueryTS } from '../../../packages/db-mongodb/src/queries/buildQuery.js'
import { buildSearchParam as buildSearchParamTS } from '../../../packages/db-mongodb/src/queries/buildSearchParams.js'
import { buildSortParam as buildSortParamTS } from '../../../packages/db-mongodb/src/queries/buildSortParam.js'
import { getLocalizedSortProperty as getLocalizedSortPropertyTS } from '../../../packages/db-mongodb/src/queries/getLocalizedSortProperty.js'
import { parseParams as parseParamsTS } from '../../../packages/db-mongodb/src/queries/parseParams.js'
import { sanitizeQueryValue as sanitizeQueryValueTS } from '../../../packages/db-mongodb/src/queries/sanitizeQueryValue.js'
import { buildProjectionFromSelect as buildProjectionFromSelectTS } from '../../../packages/db-mongodb/src/utilities/buildProjectionFromSelect.js'
import { test } from '../../__helpers/int/vitest.js'
import { assertDistinctEngines } from '../dispatch/engineGuard.js'
import { numIDsSlug, postsSlug, tagsSlug } from './config.js'
import {
  buildAndOrConditions as buildAndOrConditionsRS,
  buildProjectionFromSelect as buildProjectionFromSelectRS,
  buildQuery as buildQueryRS,
  buildSearchParam as buildSearchParamRS,
  buildSortParam as buildSortParamRS,
  getBuildQueryPlugin as getBuildQueryPluginRS,
  getLocalizedSortProperty as getLocalizedSortPropertyRS,
  getMongoLiveQuery,
  parseParams as parseParamsRS,
  sanitizeQueryValue as sanitizeQueryValueRS,
} from './glue.js'
import {
  type CaseRun,
  compareCase,
  type Comparison,
  opaqueObjects,
  rustBuildQueryStatics,
  spyModels,
  summarize,
} from './harness.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- adversarial live inputs */
type Any = any

assertDistinctEngines('buildQuery', buildQueryTS, buildQueryRS)
assertDistinctEngines('parseParams', parseParamsTS, parseParamsRS)
assertDistinctEngines('buildSearchParam', buildSearchParamTS, buildSearchParamRS)
assertDistinctEngines('buildAndOrConditions', buildAndOrConditionsTS, buildAndOrConditionsRS)
assertDistinctEngines('sanitizeQueryValue', sanitizeQueryValueTS, sanitizeQueryValueRS)
assertDistinctEngines('buildSortParam', buildSortParamTS, buildSortParamRS)
assertDistinctEngines(
  'getLocalizedSortProperty',
  getLocalizedSortPropertyTS,
  getLocalizedSortPropertyRS,
)
assertDistinctEngines(
  'buildProjectionFromSelect',
  buildProjectionFromSelectTS,
  buildProjectionFromSelectRS,
)

/** A value class whose instances are not nested wheres (prototype !== Object.prototype). */
class IDLike {
  id: string
  constructor(hex: string) {
    this.id = hex
  }
  toHexString() {
    return this.id
  }
}

/** A thrown marker (error identity across the call). */
const marker = { thrownBy: 'getter' }

test.suite(
  'rs mongo live query probes',
  { config: './config.ts', resetBetweenTests: false },
  () => {
    test('reviewers probes and adversarial inputs agree between TS and Rust', async ({
      payload,
    }) => {
      getMongoLiveQuery()
      const adapter = payload.db as Any
      const mongoose = adapter.connection.base
      const { Decimal128 } = mongoose.mongo
      const ObjectId = mongoose.Types.ObjectId
      const classes = { Date, Decimal128, IDLike, ObjectId }
      opaqueObjects.set(payload, 'payload')
      opaqueObjects.set(adapter, 'adapter')
      opaqueObjects.set(payload.config, 'config')

      // seed
      const tags: Any[] = []
      for (const name of ['a', 'b', 'c']) {
        tags.push(
          await payload.create({ collection: tagsSlug, overrideAccess: true, data: { name, num: name.charCodeAt(0) } }),
        )
      }
      const numIDs: Any[] = []
      for (const id of [5, 6]) {
        numIDs.push(await payload.create({ collection: numIDsSlug, overrideAccess: true, data: { id, title: `n${id}` } }))
      }
      const posts: Any[] = []
      for (let i = 0; i < 3; i++) {
        posts.push(
          await payload.create({
            collection: postsSlug,
          overrideAccess: true,
            data: {
              group: { nums: [i, 10], tags: ['x'], words: ['hello', 'w'] },
              numRel: 5,
              poly: { relationTo: tagsSlug, value: tags[i].id },
              polyMany: [
                { relationTo: tagsSlug, value: tags[i].id },
                { relationTo: numIDsSlug, value: 6 },
              ],
              selectMany: ['a'],
              tag: tags[i].id,
              tags: [tags[0].id, tags[i].id],
              title: `post ${i}`,
            },
          }),
        )
      }
      await payload.update({ collection: tagsSlug, overrideAccess: true, id: tags[0].id, data: { post: posts[1].id } })
      const hex = tags[0].id as string
      const hex1 = tags[1].id as string

      const comparison: Comparison = { compared: 0, diffs: [] }
      const rustStatics = rustBuildQueryStatics(payload, getBuildQueryPluginRS)
      const tsSpies = (rec: any) => spyModels(payload, rec, classes)
      const rsSpies = (rec: any) => spyModels(payload, rec, classes, rustStatics)
      const runs: Record<string, { rs: CaseRun; ts: CaseRun }> = {}

      const probe = async (
        id: string,
        inputs: unknown[],
        ts: (inputs: any[], rec: any) => unknown,
        rs: (inputs: any[], rec: any) => unknown,
        engineOptional = false,
      ) => {
        runs[id] = await compareCase({
          classes,
          comparison,
          engineOptional,
          id,
          inputs,
          rs,
          rsSpies,
          thrownMarkers: [marker],
          ts,
          tsSpies,
        })
        return runs[id].ts
      }

      const queryArgs = (rec: any, where: unknown, locale?: unknown, slug: string = postsSlug) =>
        rec.wrap({
          adapter,
          collectionSlug: slug,
          fields: payload.collections[slug as 'lq-posts'].config.flattenedFields,
          locale,
          where,
        })
      const query = (id: string, where: unknown, locale?: unknown) =>
        probe(
          id,
          [where, locale],
          ([w, l], rec) => buildQueryTS(queryArgs(rec, w, l)),
          ([w, l], rec) => buildQueryRS(queryArgs(rec, w, l)),
        )

      // --- review item 1: class instances are values, not nested wheres (prototype check)
      let r = await query('idlike equals hasMany', { tags: { equals: new IDLike(hex) } })
      expect(JSON.stringify(r.result)).toContain('"$eq"')
      r = await query('idlike not_equals hasMany', { tags: { not_equals: new IDLike(hex) } })
      r = await query('idlike contains hasMany', { tags: { contains: new IDLike(hex) } })
      r = await query('null-proto nested where', {
        tags: { equals: Object.assign(Object.create(null), { name: { equals: 'a' } }) },
      })
      expect(r.events.some((e: Any) => e?.ev === 'call' && e.method === 'buildQuery')).toBe(true)
      r = await query('plain nested where equals', { tags: { equals: { name: { equals: 'b' } } } })
      r = await query('nested where empty equals', { tags: { equals: {} } })
      r = await query('nested where not_equals', {
        tags: { not_equals: { name: { in: ['a', 'b'] } } },
      })
      r = await query('nested where contains', {
        tags: { contains: { num: { greater_than: 97 } } },
      })
      r = await query('nested where localized hasMany', {
        'localizedTags.es': { contains: { name: { equals: 'a' } } },
      })
      r = await query('nested where like throws', { title: { like: { name: { equals: 'a' } } } })
      expect((r.error as Any)?.apiError).toBe(true)
      r = await query('nested where in array like throws', { title: { contains: ['x', { a: 1 }] } })
      r = await query('join contains', { tagJoin: { contains: { name: { equals: 'a' } } } })
      expect(r.events.some((e: Any) => e?.ev === 'call' && e.method === 'distinct')).toBe(true)
      r = await query('join path hop', { 'tagJoin.name': { equals: 'a' } })
      r = await query('relationship hop', { 'tag.name': { equals: 'a' } })
      r = await query('two relationship hops', { 'tag.post.title': { like: 'post' } })
      r = await query('custom number id hop', { 'numRel.title': { equals: 'n5' } })

      r = await query('relationship then join hops', { 'tag.post.tagJoin.name': { equals: 'a' } })
      r = await query('join then relationship hops', { 'tagJoin.post.title': { like: 'post' } })
      r = await query('hasMany hop', { 'tags.name': { in: ['a', 'b'] } })
      r = await query('polymorphic value hop', { 'poly.value': { equals: hex } })

      // a user override of Model.find that does not return a mongoose Query
      const tagModel = adapter.collections[tagsSlug]
      const hadFind = Object.prototype.hasOwnProperty.call(tagModel, 'find')
      const previousFind = tagModel.find
      tagModel.find = function () {
        return Promise.resolve([{ _id: 'x' }])
      }
      try {
        r = await query('find override without lean', { 'tag.name': { equals: 'a' } })
        expect((r.error as Any)?.ctor).toBe('TypeError')
      } finally {
        if (hadFind) {
          tagModel.find = previousFind
        } else {
          delete tagModel.find
        }
      }
      // a user override of Model.buildQuery (called live by the sub-queries)
      const hadBuildQuery = Object.prototype.hasOwnProperty.call(tagModel, 'buildQuery')
      const previousBuildQuery = tagModel.buildQuery
      tagModel.buildQuery = function (this: Any, args: Any) {
        args.where = { name: { equals: 'b' } }
        return previousBuildQuery.call(this, args)
      }
      try {
        r = await query('buildQuery override', { 'tag.name': { equals: 'a' } })
      } finally {
        if (hadBuildQuery) {
          tagModel.buildQuery = previousBuildQuery
        } else {
          delete tagModel.buildQuery
        }
      }

      // --- review item 2: in-place mutation of a shared value is visible to later conditions
      const shared = { relationTo: tagsSlug, value: hex }
      r = await query('shared polymorphic value', {
        or: [
          { poly: { equals: shared } },
          { poly: { not_equals: shared } },
          { poly: { equals: shared } },
        ],
      })
      expect(JSON.stringify(r.inputsRaw)).toContain('"$class":"ObjectId"')
      const sharedIDs = [hex, hex1]
      r = await query('shared all array on polymorphic value', {
        and: [{ 'polyMany.value': { all: sharedIDs } }, { 'polyMany.value': { all: sharedIDs } }],
      })
      r = await query('frozen polymorphic value', {
        poly: { equals: Object.freeze({ relationTo: tagsSlug, value: hex }) },
      })
      expect((r.error as Any)?.ctor).toBe('TypeError')

      // --- review item 3: no `_bsontype` forgery: real instance checks (and upstream's duck typing)
      r = await query('forged objectid on id', {
        id: { equals: { _bsontype: 'ObjectId', id: 'x', toHexString: () => hex } },
      })
      r = await query('forged objectid in', {
        tag: { in: [{ _bsontype: 'ObjectId', toHexString: () => hex }, hex1] },
      })
      r = await query('forged objectid relationship equals', {
        tag: { equals: { _bsontype: 'ObjectId' } },
      })
      r = await query('real objectid relationship equals', { tag: { equals: new ObjectId(hex) } })
      r = await query('forged decimal', {
        number: { equals: { _bsontype: 'Decimal128', bytes: [] } },
      })

      // --- review item 4: Decimal128 / bson deep merge exactly as deepMergeWithCombinedArrays
      r = await query('decimal128 deep merge', {
        'group.tags': { contains: [Decimal128.fromString('1.5')] },
        group__tags: { contains: [Decimal128.fromString('2.5')] },
      })
      expect(r.error).toBeUndefined()
      r = await query('objectid deep merge', {
        'group.tags': { contains: [new ObjectId(hex)] },
        group__tags: { contains: [new ObjectId(hex1)] },
      })
      r = await query('hasMany text merge', {
        'group.words': { contains: ['a', 'b'] },
        group__words: { contains: ['c'] },
      })
      r = await query('exists merge', { title: { exists: true }, 'group.rel': { exists: false } })
      r = await query('like merge with existing $and', {
        and: [{ title: { equals: 'x' } }],
        title: { like: 'a b' },
        localizedTitle: { not_like: 'c d' },
      })

      // --- prototype-named and special keys
      r = await query('constructor path', { constructor: { equals: 'x' } })
      r = await query('toString path', { toString: { exists: true } })
      r = await query(
        'own __proto__ path',
        JSON.parse('{"__proto__": {"equals": "x"}, "title": {"equals": "y"}}'),
      )
      r = await query('own __proto__ operator', {
        title: JSON.parse('{"__proto__": "x", "equals": "y"}'),
      })
      r = await query('numeric keys', { 0: { equals: 'x' }, 1: [{ title: { equals: 'a' } }] })
      r = await query('same path twice via dunder', {
        'group.words': { equals: 'a' },
        group__words: { equals: 'b' },
      })
      r = await query('getter throwing marker', {
        title: {
          get equals() {
            throw marker
          },
        },
      })
      expect(r.error).toEqual({ thrownMarker: 0 })
      r = await query('symbol value', { title: { equals: Symbol('s') } })
      r = await query('symbol in like', { title: { like: Symbol('s') } })
      r = await query('bigint value', { number: { equals: 10n } })
      r = await query('id like undefined', { id: { like: undefined } })
      expect((r.error as Any)?.ctor).toBe('TypeError')
      r = await query('id like 24', { id: { like: hex } })
      r = await query('custom number ids', {
        or: [
          { numRel: { equals: '5' } },
          { numRel: { in: ['5', 'x', 6] } },
          { polyMany: { in: ['5', hex] } },
          { polyMany: { equals: '5' } },
          { polyMany: { not_equals: hex } },
          {
            polyMany: {
              equals: [
                { relationTo: numIDsSlug, value: '5' },
                { relationTo: tagsSlug, value: hex },
                hex1,
              ],
            },
          },
          { tags: { equals: [hex, 'nope'] } },
          { 'polyMany.relationTo': { equals: tagsSlug } },
          { 'polyMany.value': { all: [hex, 'nope'] } },
        ],
      })
      r = await query('poly with null in array', { polyMany: { equals: [null] } })
      r = await query('near variants', {
        or: [
          { point: { near: '10,20,1000,5' } },
          { point: { near: [10, 20, null, 5] } },
          { point: { near: [10] } },
          { point: { within: { type: 'Polygon', coordinates: [] } } },
          { point: { intersects: 'x' } },
        ],
      })
      r = await query('date and checkbox', {
        and: [
          { date: { greater_than: '2020-01-01' } },
          { date: { less_than: 'bogus' } },
          { checkbox: { equals: 'TRUE' } },
          { number: { exists: 'false' } },
          { number: { in: '1,2,x' } },
          { selectMany: { contains: ['a', 'b'] } },
          { 'group.nums': { contains: 1 } },
          { id: { in: `${hex},${hex1}` } },
          { id: { not_in: [hex, 'bad', 5] } },
        ],
      })
      r = await query(
        'blocks and arrays',
        {
          and: [
            { 'layout.heading': { equals: 'h' } },
            { 'layout.target': { equals: hex } },
            { 'layout.blockType': { in: ['hero'] } },
            { 'items.label': { exists: true } },
            { 'items.ref.name': { equals: 'a' } },
          ],
        },
        'es',
      )
      r = await query(
        'locale all',
        { localizedTitle: { equals: 'x' }, 'items.label': { like: 'a' } },
        'all',
      )

      // --- concurrency: two builds sharing the same where object, composed with Promise.all
      const concurrentWhere = {
        or: [
          { poly: { equals: { relationTo: tagsSlug, value: hex } } },
          { 'tag.name': { equals: 'a' } },
        ],
      }
      await probe(
        'concurrent builds share where',
        [concurrentWhere],
        ([w], rec) =>
          Promise.all([buildQueryTS(queryArgs(rec, w)), buildQueryTS(queryArgs(rec, w))]),
        ([w], rec) =>
          Promise.all([buildQueryRS(queryArgs(rec, w)), buildQueryRS(queryArgs(rec, w))]),
      )

      // --- nesting (moderate: compared exactly)
      let nested: Any = { title: { equals: 'deep' } }
      for (let i = 0; i < 150; i++) {
        nested = { and: [nested, { [`f${i % 3}`]: { exists: true } }] }
      }
      r = await query('nested 150 levels', nested)

      // --- engine item 5: buildSortParam mutates the caller's sort array (fallback push) and
      // sortAggregation in place; default sort arrays reused across calls see the earlier push
      const sortArgs = (
        rec: any,
        sort: unknown,
        sortAggregation: unknown,
        locale?: unknown,
        timestamps = true,
      ) =>
        rec.wrap({
          adapter,
          config: payload.config,
          fields: payload.collections[postsSlug].config.flattenedFields,
          locale,
          sort,
          sortAggregation,
          timestamps,
        })
      const sortProbe = (
        id: string,
        sort: unknown,
        withAggregation: boolean,
        locale?: unknown,
        twice = false,
      ) =>
        probe(
          id,
          [sort, [], locale],
          ([s, agg, l], rec) => {
            const first = buildSortParamTS(sortArgs(rec, s, withAggregation ? agg : undefined, l))
            return twice
              ? [first, buildSortParamTS(sortArgs(rec, s, withAggregation ? agg : undefined, l))]
              : first
          },
          ([s, agg, l], rec) => {
            const first = buildSortParamRS(sortArgs(rec, s, withAggregation ? agg : undefined, l))
            return twice
              ? [first, buildSortParamRS(sortArgs(rec, s, withAggregation ? agg : undefined, l))]
              : first
          },
        )
      r = await sortProbe('sort array fallback push', ['title'], false)
      expect(JSON.stringify(r.inputsRaw)).toContain('-createdAt')
      r = await sortProbe('default sort array reused', ['title'], false, undefined, true)
      r = await sortProbe('sort with id has no fallback', ['-createdAt', 'title'], false)
      r = await sortProbe(
        'relationship sort lookups',
        ['tag.name', '-tag.post.title', 'numRel.title', 'tag.id'],
        true,
        'es',
      )
      expect(JSON.stringify(r.inputsRaw)).toContain('$lookup')
      r = await sortProbe(
        'localized sorts',
        ['localizedTitle', 'items.label', 'items.es.label', 'layout.heading'],
        false,
        'es',
      )
      r = await sortProbe('frozen sort array', Object.freeze(['title']), false)
      expect((r.error as Any)?.ctor).toBe('TypeError')
      r = await sortProbe('non-string sort items', [5], false)
      r = await sortProbe('object sort', { title: 1 }, false)

      // --- projections (copy of select; caller's select untouched)
      const projection = (id: string, select: unknown) =>
        probe(
          id,
          [select],
          ([s], rec) =>
            buildProjectionFromSelectTS(
              rec.wrap({
                adapter,
                fields: payload.collections[postsSlug].config.flattenedFields,
                select: s,
              }),
            ),
          ([s], rec) =>
            buildProjectionFromSelectRS(
              rec.wrap({
                adapter,
                fields: payload.collections[postsSlug].config.flattenedFields,
                select: s,
              }),
            ),
        )
      await projection('projection include nested', {
        group: { words: true },
        items: { label: true },
        layout: { cta: { link: true } },
        tag: true,
      })
      await projection('projection exclude', {
        group: false,
        layout: { hero: false },
        items: { ref: false },
      })
      await projection('projection blocks true', { layout: { hero: true } })
      await projection('projection numeric select', { items: 1 })
      await projection('projection with getter', {
        get title() {
          throw marker
        },
      })

      // --- module-internal exports
      const fields = payload.collections[postsSlug].config.flattenedFields
      const internal = (
        id: string,
        inputs: unknown[],
        ts: (args: Any) => unknown,
        rs: (args: Any) => unknown,
        args: (inputs: any[]) => Any,
      ) =>
        probe(
          id,
          inputs,
          (i, rec) => ts(rec.wrap(args(i))),
          (i, rec) => rs(rec.wrap(args(i))),
        )
      await internal(
        'parseParams export',
        [{ title: { equals: 'a' }, or: [{ tags: { in: [hex] } }] }],
        parseParamsTS,
        parseParamsRS,
        ([w]) => ({
          collectionSlug: postsSlug,
          fields,
          locale: 'en',
          parentIsLocalized: false,
          payload,
          where: w,
        }),
      )
      await internal(
        'buildAndOrConditions export',
        [[{ title: { equals: 'a' } }, null, {}, 'x']],
        buildAndOrConditionsTS,
        buildAndOrConditionsRS,
        ([w]) => ({
          collectionSlug: postsSlug,
          fields,
          parentIsLocalized: false,
          payload,
          where: w,
        }),
      )
      await internal(
        'buildSearchParam export',
        [{ relationTo: tagsSlug, value: hex }],
        buildSearchParamTS,
        buildSearchParamRS,
        ([v]) => ({
          collectionSlug: postsSlug,
          fields,
          incomingPath: 'poly',
          operator: 'equals',
          parentIsLocalized: false,
          payload,
          val: v,
        }),
      )
      await internal(
        'sanitizeQueryValue export',
        [[hex, 'bad']],
        sanitizeQueryValueTS,
        sanitizeQueryValueRS,
        ([v]) => ({
          field: fields.find((f: Any) => f.name === 'tags'),
          hasCustomID: false,
          operator: 'in',
          parentIsLocalized: false,
          path: 'tags',
          payload,
          val: v,
        }),
      )
      await internal(
        'getLocalizedSortProperty export',
        [['items', 'es', 'label']],
        getLocalizedSortPropertyTS,
        getLocalizedSortPropertyRS,
        ([segments]) => ({
          config: payload.config,
          fields,
          locale: 'en',
          parentIsLocalized: false,
          segments,
        }),
      )
      await internal('buildQuery args getter throws', [], buildQueryTS, buildQueryRS, () => ({
        get adapter() {
          throw marker
        },
      }))

      // --- Model.buildQuery statics: collections, versions, globals (+ missing global slug)
      // `Model.buildQuery` is upstream's JS `schemaBuildQuery` awaiting the Rust `parseParams`:
      // its config errors are thrown before Rust is entered (the outcome kind is asserted instead)
      const staticCase = (id: string, model: Any, args: unknown[], engineOptional = false) =>
        probe(
          id,
          args,
          ([w, l, g], rec) =>
            model.buildQuery(rec.wrap({ globalSlug: g, locale: l, payload, where: w })),
          ([w, l, g], rec) =>
            model.buildQuery(rec.wrap({ globalSlug: g, locale: l, payload, where: w })),
          engineOptional,
        )
      await staticCase('static collection', adapter.collections[postsSlug], [
        { 'tag.name': { equals: 'a' } },
        'en',
      ])
      await staticCase('static versions', adapter.versions[postsSlug], [
        { 'version.title': { equals: 'a' } },
        'en',
      ])
      await staticCase('static global', adapter.globals, [
        { title: { equals: 'a' } },
        'en',
        'lq-settings',
      ])
      r = await staticCase(
        'static global missing',
        adapter.globals,
        [{ title: { equals: 'a' } }, 'en', 'nope'],
        true,
      )
      expect((r.error as Any)?.message).toBe('Global with the slug nope was not found')
      r = await staticCase(
        'static global no slug',
        adapter.globals,
        [{ title: { equals: 'a' } }, 'en', undefined],
        true,
      )
      expect((r.error as Any)?.message).toBe('Fields are not initialized.')
      await staticCase('static global versions', adapter.versions['lq-settings'], [
        { 'version.title': { equals: 'a' } },
        'en',
      ])
      r = await probe(
        'static args undefined',
        [],
        (_i, _rec) => adapter.collections[postsSlug].buildQuery(),
        () => adapter.collections[postsSlug].buildQuery(),
        true,
      )
      expect((r.error as Any)?.ctor).toBe('TypeError')

      // --- extreme nesting: no crash, both reject with V8's RangeError (depth limit differs: gap)
      let deep: Any = { title: { equals: 'x' } }
      for (let i = 0; i < 100_000; i++) {
        deep = { and: [deep] }
      }
      const outcome = async (fn: () => Promise<unknown>) => {
        try {
          await fn()
          return 'ok'
        } catch (e) {
          return (e as Error)?.constructor?.name
        }
      }
      // Nesting depth (review item 13): the deepest `and` nesting each side accepts (binary search),
      // and the outcomes at fixed depths. Rust's nested calls are stackless with an emulated TS frame
      // per level, so its limit tracks the TS one (both depend on the JIT tier and the call site's
      // stack, so they are compared within a band, not to the level). Outside a +-25% band around
      // the TS limit both must agree; inside it, the depth reached is reported.
      const nestedWhere = (depth: number) => {
        let w: Any = { title: { equals: 'x' } }
        for (let i = 0; i < depth; i++) {
          w = { and: [w] }
        }
        return w
      }
      const maxDepth = async (fn: (w: Any) => Promise<unknown>) => {
        let lo = 0
        let hi = 64
        while ((await outcome(() => fn(nestedWhere(hi)))) === 'ok') {
          lo = hi
          hi *= 2
        }
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2)
          if ((await outcome(() => fn(nestedWhere(mid)))) === 'ok') {
            lo = mid
          } else {
            hi = mid
          }
        }
        return lo
      }
      const viaTS = (w: Any) => buildQueryTS({ adapter, collectionSlug: postsSlug, fields, where: w } as Any)
      const viaRS = (w: Any) => buildQueryRS({ adapter, collectionSlug: postsSlug, fields, where: w })
      // TS's own limit moves while V8 optimizes its frames: measured cold and after warm-up
      const tsCold = await maxDepth(viaTS)
      const rsLimit = await maxDepth(viaRS)
      for (let i = 0; i < 300; i++) {
        await outcome(() => viaTS(nestedWhere(1000)))
      }
      const tsWarm = await maxDepth(viaTS)
      const [tsMin, tsMax] = [Math.min(tsCold, tsWarm), Math.max(tsCold, tsWarm)]
      console.log(`[rs live query] max and-nesting: ts ${tsCold} (cold) / ${tsWarm} (warm), rs ${rsLimit}`)
      for (const depth of [100, 200, 400, 800, 1600, 3200, 6400]) {
        const t = await outcome(() => viaTS(nestedWhere(depth)))
        const rr = await outcome(() => viaRS(nestedWhere(depth)))
        console.log(`[rs live query] nesting ${depth}: ts ${t}, rs ${rr}`)
        if (depth < tsMin * 0.75 || depth > tsMax * 1.25) {
          expect([depth, rr]).toEqual([depth, t])
        }
      }
      expect(rsLimit).toBeGreaterThanOrEqual(tsMin * 0.75)
      expect(rsLimit).toBeLessThanOrEqual(tsMax * 1.25)
    for (const d of comparison.diffs) {
        console.log(`[rs live query] DIFF ${d.id}: ${d.kind}`)
        console.log(`  ts: ${summarize(d.ts as CaseRun, d.kind)}`)
        console.log(`  rs: ${summarize(d.rs as CaseRun, d.kind)}`)
      }
      console.log(
        `[rs live query] probes: ${comparison.compared} compared, ${comparison.diffs.length} differ`,
      )
      expect(comparison.compared).toBeGreaterThan(60)
      expect(comparison.diffs.map((d) => d.id)).toEqual([])

      const tsOutcome = await outcome(() =>
        buildQueryTS({ adapter, collectionSlug: postsSlug, fields, where: deep } as Any),
      )
      const rsOutcome = await outcome(() =>
        buildQueryRS({ adapter, collectionSlug: postsSlug, fields, where: deep }),
      )
      console.log(`[rs live query] 100k nesting: ts ${tsOutcome}, rs ${rsOutcome}`)
      expect(rsOutcome).toBe(tsOutcome)
    })
  },
)

void (null as unknown as Payload)
