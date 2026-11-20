/**
 * Adversarial live probes of .rs-baseline/review-mongo-live-query-sol.md (phase J), each run
 * through upstream's TS and the Rust port by harness.ts on the same live inputs, plus negative
 * controls of the harness gaps the review lists (each must be reported as a difference).
 *
 * Every probe also asserts the upstream outcome it is about (no vacuous pass). Probes that patch
 * globals / prototypes install the patch only while one side runs and restore it afterwards.
 * KNOWN_GAPS lists probes whose difference is documented and owned elsewhere; the test fails if
 * the set of differing probes is not exactly that list (so a fixed gap must be removed from it).
 */
import type { Payload } from 'payload'

import { expect } from 'vitest'

import { buildAndOrConditions as buildAndOrConditionsTS } from '../../../packages/db-mongodb/src/queries/buildAndOrConditions.js'
import { buildQuery as buildQueryTS } from '../../../packages/db-mongodb/src/queries/buildQuery.js'
import { buildSearchParam as buildSearchParamTS } from '../../../packages/db-mongodb/src/queries/buildSearchParams.js'
import { buildSortParam as buildSortParamTS } from '../../../packages/db-mongodb/src/queries/buildSortParam.js'
import { getBuildQueryPlugin as getBuildQueryPluginTS } from '../../../packages/db-mongodb/src/queries/getBuildQueryPlugin.js'
import { getLocalizedSortProperty as getLocalizedSortPropertyTS } from '../../../packages/db-mongodb/src/queries/getLocalizedSortProperty.js'
import { operatorMap } from '../../../packages/db-mongodb/src/queries/operatorMap.js'
import { parseParams as parseParamsTS } from '../../../packages/db-mongodb/src/queries/parseParams.js'
import { sanitizeQueryValue as sanitizeQueryValueTS } from '../../../packages/db-mongodb/src/queries/sanitizeQueryValue.js'
import { test } from '../../__helpers/int/vitest.js'
import { assertDistinctEngines } from '../dispatch/engineGuard.js'
import { postsSlug, tagsSlug } from './config.js'
import {
  buildAndOrConditions as buildAndOrConditionsRS,
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
  canonical,
  type CaseRun,
  cloneLive,
  compareCase,
  type Comparison,
  opaqueObjects,
  type Recorder,
  rustBuildQueryStatics,
  spyModels,
  summarize,
} from './harness.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- adversarial live inputs */
type Any = any

assertDistinctEngines('buildQuery', buildQueryTS, buildQueryRS)
assertDistinctEngines('buildAndOrConditions', buildAndOrConditionsTS, buildAndOrConditionsRS)
assertDistinctEngines('getBuildQueryPlugin', getBuildQueryPluginTS, getBuildQueryPluginRS)

/** Probes whose difference is documented and owned elsewhere (see the final report). */
const KNOWN_GAPS: Record<string, string> = {
  // db-mongodb's buildSearchParams.ts does not export its module constant `subQueryOptions`, so
  // the Rust host cannot share it with TS adapters (request to the db-mongodb owner in the log).
  'item 14: mixed TS / Rust hops share subQueryOptions':
    'needs `export` of subQueryOptions upstream',
}

/** A thrown marker (error identity across the call). */
const marker = { thrownBy: 'adversarial' }

/** `fn` with `patch()` installed while it runs (sync throw stays sync; restored on settle). */
const patched =
  (patch: () => () => void, fn: (inputs: Any[], rec: Recorder) => unknown) =>
  (inputs: Any[], rec: Recorder): unknown => {
    const undo = patch()
    let r: Any
    try {
      r = fn(inputs, rec)
    } catch (e) {
      undo()
      throw e
    }
    if (r && typeof r.then === 'function') {
      return r.then(
        (v: unknown) => {
          undo()
          return v
        },
        (e: unknown) => {
          undo()
          throw e
        },
      )
    }
    undo()
    return r
  }

/** Replaces `obj[key]` (own data property) and returns the restorer. */
const replace = (obj: Any, key: PropertyKey, value: unknown) => () => {
  const had = Object.prototype.hasOwnProperty.call(obj, key)
  const previous = Object.getOwnPropertyDescriptor(obj, key)
  Object.defineProperty(obj, key, {
    configurable: true,
    enumerable: previous?.enumerable ?? false,
    value,
    writable: true,
  })
  return () => {
    if (had) {
      Object.defineProperty(obj, key, previous!)
    } else {
      delete obj[key]
    }
  }
}

test.suite(
  'rs mongo live query adversarial',
  { config: './config.ts', resetBetweenTests: false },
  () => {
    test('review items agree between TS and Rust; harness controls detect', async ({ payload }) => {
      getMongoLiveQuery()
      const adapter = payload.db as Any
      const mongoose = adapter.connection.base
      const { Decimal128 } = mongoose.mongo
      const Types = mongoose.Types
      const ObjectId = Types.ObjectId
      const classes = { Date, Decimal128, ObjectId }
      opaqueObjects.set(payload, 'payload')
      opaqueObjects.set(adapter, 'adapter')
      opaqueObjects.set(payload.config, 'config')

      const tags: Any[] = []
      for (const name of ['a', 'b']) {
        tags.push(
          await payload.create({ collection: tagsSlug, data: { name }, overrideAccess: true }),
        )
      }
      const posts: Any[] = []
      for (let i = 0; i < 2; i++) {
        posts.push(
          await payload.create({
            collection: postsSlug,
            data: {
              localizedTags: [tags[i].id],
              tag: tags[i].id,
              tags: [tags[0].id],
              title: `post ${i}`,
            },
            overrideAccess: true,
          }),
        )
      }
      await payload.update({
        collection: tagsSlug,
        data: { post: posts[0].id },
        id: tags[0].id,
        overrideAccess: true,
      })
      const hex = tags[0].id as string
      const fields = payload.collections[postsSlug].config.flattenedFields
      const textField = fields.find((f: Any) => f.name === 'title')

      const comparison: Comparison = { compared: 0, diffs: [] }
      const rustStatics = rustBuildQueryStatics(payload, getBuildQueryPluginRS)
      const tsSpies = (rec: Any) => spyModels(payload, rec, classes)
      const rsSpies = (rec: Any) => spyModels(payload, rec, classes, rustStatics)

      const probe = async (
        id: string,
        inputs: (() => unknown[]) | unknown[],
        ts: (inputs: Any[], rec: Recorder) => unknown,
        rs: (inputs: Any[], rec: Recorder) => unknown,
        opts: { engineOptional?: boolean; tsEntersEngine?: boolean } = {},
      ) => {
        const run = await compareCase({
          classes,
          comparison,
          id,
          inputs,
          rs,
          rsSpies,
          thrownMarkers: [marker],
          ts,
          tsSpies,
          ...opts,
        })
        return run.ts
      }
      const queryArgs = (rec: Recorder, where: unknown, locale?: unknown) =>
        rec.wrap({ adapter, collectionSlug: postsSlug, fields, locale, where })
      /** `buildQuery` of `where`, with `patch` installed while it runs; `log` (filled by the patch) is
       * returned with the result. */
      const query = (id: string, where: unknown, patch?: () => () => void, log?: unknown[]) => {
        const withLog =
          (fn: (i: Any[], rec: Recorder) => Promise<unknown>) => async (i: Any[], rec: Recorder) =>
            log ? [await fn(i, rec), [...log]] : fn(i, rec)
        const ts = withLog(([w], rec) => buildQueryTS(queryArgs(rec, w) as Any))
        const rs = withLog(([w], rec) => buildQueryRS(queryArgs(rec, w)))
        return probe(id, [where], patch ? patched(patch, ts) : ts, patch ? patched(patch, rs) : rs)
      }
      const sync = (
        id: string,
        inputs: (() => unknown[]) | unknown[],
        ts: (inputs: Any[], rec: Recorder) => unknown,
        rs: (inputs: Any[], rec: Recorder) => unknown,
        patch?: () => () => void,
      ) => probe(id, inputs, patch ? patched(patch, ts) : ts, patch ? patched(patch, rs) : rs)
      const events = (r: CaseRun) => r.events as Any[]
      let r: CaseRun

      // ---- item 1: async exports reject on argument-destructuring errors (never throw sync)
      for (const [name, ts, rs] of [
        ['buildAndOrConditions', buildAndOrConditionsTS, buildAndOrConditionsRS],
        ['parseParams', parseParamsTS, parseParamsRS],
        ['buildSearchParam', buildSearchParamTS, buildSearchParamRS],
        ['buildQuery', buildQueryTS, buildQueryRS],
      ] as const) {
        r = await probe(
          `item 1: ${name}(undefined) rejects`,
          [],
          () => (ts as Any)(undefined),
          () => (rs as Any)(undefined),
        )
        expect(events(r).some((e) => e?.ev === 'syncThrow')).toBe(false)
        expect((r.error as Any)?.ctor).toBe('TypeError')
      }
      r = await probe(
        'item 1: buildAndOrConditions where getter throws',
        [],
        () =>
          buildAndOrConditionsTS({
            get where() {
              throw marker
            },
          } as Any),
        () =>
          buildAndOrConditionsRS({
            get where() {
              throw marker
            },
          }),
      )
      expect(events(r).some((e) => e?.ev === 'returnedPromise')).toBe(true)
      expect(r.error).toEqual({ thrownMarker: 0 })
      r = await probe(
        'item 1: buildAndOrConditions non-iterable where',
        [],
        () => buildAndOrConditionsTS({ fields, payload, where: {} } as Any),
        () => buildAndOrConditionsRS({ fields, payload, where: {} }),
      )
      expect((r.error as Any)?.message).toBe('where is not iterable')
      // the synchronous exports throw synchronously on both sides
      r = await probe(
        'item 1: sanitizeQueryValue(undefined) throws',
        [],
        () => sanitizeQueryValueTS(undefined as Any),
        () => sanitizeQueryValueRS(undefined),
      )
      expect(events(r).some((e) => e?.ev === 'syncThrow')).toBe(true)

      // ---- item 3: the plugin, the static and the callbacks are upstream-shaped JS functions
      r = await probe(
        'item 3: plugin and static reflection',
        [],
        () => {
          const schema = { statics: {} as Any }
          const plugin = getBuildQueryPluginTS({ collectionSlug: postsSlug })
          plugin(schema)
          return { plugin, static: schema.statics.buildQuery }
        },
        () => {
          const schema = { statics: {} as Any }
          const plugin = getBuildQueryPluginRS({ collectionSlug: postsSlug })
          plugin(schema)
          return { plugin, static: schema.statics.buildQuery }
        },
      )
      expect(JSON.stringify(r.result)).toContain('"kind":"AsyncFunction"')
      r = await probe(
        'item 3: new schema.statics.buildQuery throws',
        [],
        () => {
          const schema = { statics: {} as Any }
          getBuildQueryPluginTS({ collectionSlug: postsSlug })(schema)
          return new schema.statics.buildQuery({ payload, where: {} })
        },
        () => {
          const schema = { statics: {} as Any }
          getBuildQueryPluginRS({ collectionSlug: postsSlug })(schema)
          return new schema.statics.buildQuery({ payload, where: {} })
        },
      )
      expect((r.error as Any)?.message).toBe('schema.statics.buildQuery is not a constructor')
      const sortArgs = (rec: Recorder, sort: unknown, extra: Any = {}) =>
        rec.wrap({
          adapter: { disableFallbackSort: true },
          config: payload.config,
          fields,
          sort,
          timestamps: false,
          ...extra,
        })
      const callbackSort = () => {
        const seen: unknown[] = []
        const sort: Any = ['title']
        sort.some = function (cb: Any) {
          seen.push(cb)
          return Array.prototype.some.call(this, cb)
        }
        sort.reduce = function (cb: Any, init: unknown) {
          seen.push(cb)
          return Array.prototype.reduce.call(this, cb, init)
        }
        return [sort, seen]
      }
      r = await sync(
        'item 3: callbacks handed to overridden some / reduce',
        callbackSort,
        ([s, seen], rec) => [buildSortParamTS(sortArgs(rec, s) as Any), seen],
        ([s, seen], rec) => [buildSortParamRS(sortArgs(rec, s)), seen],
      )
      expect(JSON.stringify(r.inputsAfter)).toContain('"length":2')

      // ---- item 2: callbacks stay callable after the call, re-entrantly
      const retainedSort = () => {
        const saved: Any[] = []
        const sort: Any = ['title']
        sort.some = function (cb: Any) {
          saved.push(cb)
          return false
        }
        return [sort, saved]
      }
      r = await sync(
        'item 2: some callback called after buildSortParam returned',
        retainedSort,
        ([s, saved], rec) => {
          buildSortParamTS(sortArgs(rec, s) as Any)
          return [saved[0]('title'), saved[0]('-createdAt')]
        },
        ([s, saved], rec) => {
          buildSortParamRS(sortArgs(rec, s))
          return [saved[0]('title'), saved[0]('-createdAt')]
        },
      )
      expect(r.error).toBeUndefined()
      const reentrantSort = () => {
        const log: string[] = []
        let saved: Any
        let depth = 0
        const item = {
          split() {
            log.push(`split ${depth}`)
            if (depth++ === 0) {
              log.push(`inner ${String(saved(item))}`)
            }
            return ['title']
          },
        }
        const sort: Any = [item]
        sort.some = function (cb: Any) {
          saved = cb
          return cb(item)
        }
        sort.reduce = (_cb: Any, init: unknown) => init
        return [sort, log]
      }
      r = await sync(
        'item 2: some callback re-entered from inside itself',
        reentrantSort,
        ([s], rec) => buildSortParamTS(sortArgs(rec, s) as Any),
        ([s], rec) => buildSortParamRS(sortArgs(rec, s)),
      )
      expect(JSON.stringify(r.inputsAfter)).toContain('inner')

      // ---- item 12: awaiting a promise performs only the reads a native await performs
      const relatedModel = adapter.collections[tagsSlug]
      const speciesCase = () => {
        const log: string[] = []
        return [log]
      }
      const withSpeciesOverride = (log: string[]) => {
        const had = Object.prototype.hasOwnProperty.call(relatedModel, 'buildQuery')
        const previous = relatedModel.buildQuery
        relatedModel.buildQuery = function () {
          const p = Promise.resolve({ name: { $eq: 'a' } })
          let reads = 0
          Object.defineProperty(p, 'constructor', {
            configurable: true,
            get() {
              reads++
              log.push(`constructor ${reads}`)
              if (reads > 1) {
                throw marker
              }
              return Promise
            },
          })
          return p
        }
        return () => {
          if (had) {
            relatedModel.buildQuery = previous
          } else {
            delete relatedModel.buildQuery
          }
        }
      }
      r = await probe(
        'item 12: awaited buildQuery promise constructor reads',
        speciesCase,
        ([log], rec) => {
          const undo = withSpeciesOverride(log)
          return buildQueryTS(
            queryArgs(rec, { tags: { contains: { name: { equals: 'a' } } } }) as Any,
          ).finally(undo)
        },
        ([log], rec) => {
          const undo = withSpeciesOverride(log)
          return buildQueryRS(
            queryArgs(rec, { tags: { contains: { name: { equals: 'a' } } } }),
          ).finally(undo)
        },
      )
      expect(r.error).toBeUndefined()
      expect(JSON.stringify(r.inputsAfter)).toContain('constructor 1')

      // ---- item 4: appends call the current push (own, frozen, array-like accumulators, patched prototype)
      const reducerVal = (accumulator: () => Any) => () => {
        const acc = accumulator()
        const val: Any = [hex]
        val.reduce = (cb: Any) => cb(acc, hex)
        return [val, acc]
      }
      const sanitizeArgs = (rec: Recorder, val: unknown, extra: Any = {}) =>
        rec.wrap({
          field: textField,
          hasCustomID: false,
          operator: 'in',
          parentIsLocalized: false,
          path: '_id',
          payload,
          val,
          ...extra,
        })
      const ownPush = () => {
        const a: Any = []
        a.push = function (v: unknown) {
          ;(a.log ??= []).push(typeof v)
          return Array.prototype.push.call(this, v)
        }
        return a
      }
      for (const [name, make] of [
        ['own push', ownPush],
        ['frozen accumulator', () => Object.freeze([])],
        [
          'array-like accumulator',
          () => ({
            log: [] as unknown[],
            push(v: unknown) {
              this.log.push(typeof v)
            },
          }),
        ],
      ] as const) {
        r = await sync(
          `item 4: sanitize reduce ${name}`,
          reducerVal(make as () => Any),
          ([v], rec) => sanitizeQueryValueTS(sanitizeArgs(rec, v) as Any),
          ([v], rec) => sanitizeQueryValueRS(sanitizeArgs(rec, v)),
        )
      }
      expect((r.error as Any)?.ctor).toBeUndefined()
      const pushLog: unknown[] = []
      const recordPush = () => {
        pushLog.length = 0
        const original = Array.prototype.push
        return replace(Array.prototype, 'push', function (this: unknown[], ...items: unknown[]) {
          original.call(pushLog, items.map((i) => typeof i).join(','))
          return original.apply(this, items)
        })()
      }
      r = await sync(
        'item 4: patched Array.prototype.push (sanitize in + sort lookups)',
        [],
        (_i, rec) => [
          sanitizeQueryValueTS(
            sanitizeArgs(rec, [hex, 'bad'], {
              field: { type: 'number' },
              hasCustomID: true,
            }) as Any,
          ),
          buildSortParamTS(sortArgs(rec, ['tag.name'], { adapter, sortAggregation: [] }) as Any),
          [...pushLog],
        ],
        (_i, rec) => [
          sanitizeQueryValueRS(
            sanitizeArgs(rec, [hex, 'bad'], { field: { type: 'number' }, hasCustomID: true }),
          ),
          buildSortParamRS(sortArgs(rec, ['tag.name'], { adapter, sortAggregation: [] })),
          [...pushLog],
        ],
        recordPush,
      )
      expect(((r.result as Any).$array?.[2]?.$array ?? []).length).toBeGreaterThan(0)

      // ---- item 5: the String methods the TS calls are called
      const stringLog: unknown[] = []
      const recordString = (method: string, receivers: string[]) => () => {
        stringLog.length = 0
        const original = (String.prototype as Any)[method]
        return replace(String.prototype, method, function (this: string, ...args: unknown[]) {
          if (receivers.includes(String(this))) {
            stringLog.push(`${method}:${String(this)}`)
          }
          return original.apply(this, args)
        })()
      }
      const withLog =
        (fn: (i: Any[], rec: Recorder) => unknown) => async (i: Any[], rec: Recorder) => [
          await fn(i, rec),
          [...stringLog],
        ]
      for (const [id, where, method, receivers] of [
        ['AND toLowerCase', { AND: [] }, 'toLowerCase', ['AND']],
        ['checkbox toLowerCase', { checkbox: { equals: 'TRUE' } }, 'toLowerCase', ['TRUE']],
        ['like split', { title: { like: 'a b' } }, 'split', ['a b']],
        ['path replace', { title: { equals: 'x' } }, 'replace', ['title']],
        [
          'localized hasMany split per locale',
          { 'localizedTags.es': { contains: { name: { equals: 'a' } } } },
          'split',
          ['localizedTags.es'],
        ],
      ] as const) {
        r = await probe(
          `item 5: ${id}`,
          [where],
          patched(
            recordString(method, receivers as unknown as string[]),
            withLog(([w], rec) => buildQueryTS(queryArgs(rec, w) as Any)),
          ),
          patched(
            recordString(method, receivers as unknown as string[]),
            withLog(([w], rec) => buildQueryRS(queryArgs(rec, w))),
          ),
        )
        expect(JSON.stringify(r.result)).toContain(`${method}:`)
      }
      r = await sync(
        'item 5: String.prototype.indexOf throws in the sort reduce',
        [['title']],
        ([s], rec) => buildSortParamTS(sortArgs(rec, s) as Any),
        ([s], rec) => buildSortParamRS(sortArgs(rec, s)),
        () => {
          const original = String.prototype.indexOf
          return replace(String.prototype, 'indexOf', function (this: string, ...args: Any[]) {
            if (String(this) === 'title') {
              throw marker
            }
            return original.apply(this, args as [string])
          })()
        },
      )
      expect(r.error).toEqual({ thrownMarker: 0 })

      // ---- item 6: global built-ins are read at call time
      const numberIDArgs = (rec: Recorder, val: unknown) =>
        rec.wrap({
          field: { type: 'number' },
          hasCustomID: true,
          operator: 'in',
          parentIsLocalized: false,
          path: '_id',
          payload,
          val,
        })
      r = await sync(
        'item 6: replaced parseFloat',
        [['5']],
        ([v], rec) => sanitizeQueryValueTS(numberIDArgs(rec, v) as Any),
        ([v], rec) => sanitizeQueryValueRS(numberIDArgs(rec, v)),
        replace(globalThis, 'parseFloat', () => 42),
      )
      expect(JSON.stringify(r.result)).toContain('42')
      r = await sync(
        'item 6: replaced Number.isNaN',
        [['bad']],
        ([v], rec) => sanitizeQueryValueTS(numberIDArgs(rec, v) as Any),
        ([v], rec) => sanitizeQueryValueRS(numberIDArgs(rec, v)),
        replace(Number, 'isNaN', () => false),
      )
      expect(JSON.stringify(r.result)).toContain('NaN')
      const keysLog: unknown[] = []
      r = await query(
        'item 6: replaced Object.keys / Array.isArray',
        { or: [{ title: { equals: 'a' } }] },
        () => {
          keysLog.length = 0
          const keys = Object.keys
          const isArray = Array.isArray
          const undoKeys = replace(Object, 'keys', (o: Any) => {
            keysLog.push('keys')
            return keys(o)
          })()
          const undoIsArray = replace(Array, 'isArray', (v: unknown) => {
            keysLog.push('isArray')
            return isArray(v)
          })()
          return () => {
            undoIsArray()
            undoKeys()
          }
        },
        keysLog,
      )
      expect(JSON.stringify(r.result)).toContain('isArray')

      // ---- item 7: callees are evaluated before their arguments
      const isValidBefore = () => {
        const original = Types.ObjectId.isValid
        const value = {
          id: hex,
          toHexString: () => hex,
          toString() {
            Types.ObjectId.isValid = () => false
            return hex
          },
        }
        return [value, original]
      }
      const restoreIsValid = (original: Any) => {
        Types.ObjectId.isValid = original
      }
      r = await probe(
        'item 7: Types.ObjectId.isValid read before inVal.toString()',
        isValidBefore,
        ([v, original], rec) =>
          buildQueryTS(queryArgs(rec, { tag: { in: [v] } }) as Any).finally(() =>
            restoreIsValid(original),
          ),
        ([v, original], rec) =>
          buildQueryRS(queryArgs(rec, { tag: { in: [v] } })).finally(() =>
            restoreIsValid(original),
          ),
      )
      expect(JSON.stringify(r.result)).toContain('"$class":"ObjectId"')
      class FakeObjectId {
        v: unknown
        constructor(v: unknown) {
          this.v = v
        }
      }
      const ctorBefore = () => {
        const original = Types.ObjectId
        let reads = 0
        const item = {
          relationTo: tagsSlug,
          get value() {
            reads++
            if (reads === 2) {
              Types.ObjectId = FakeObjectId
            }
            return hex
          },
        }
        return [item, original]
      }
      r = await probe(
        'item 7: Types.ObjectId read before item.value',
        ctorBefore,
        ([item, original], rec) =>
          buildQueryTS(queryArgs(rec, { polyMany: { equals: [item] } }) as Any).finally(() => {
            Types.ObjectId = original
          }),
        ([item, original], rec) =>
          buildQueryRS(queryArgs(rec, { polyMany: { equals: [item] } })).finally(() => {
            Types.ObjectId = original
          }),
      )
      expect(JSON.stringify(r.result)).toContain('"$class":"ObjectId"')
      const tagModel = adapter.collections[tagsSlug]
      r = await sync(
        'item 7: sortAggregation.push = 0 checked after its argument',
        () => {
          const agg: Any = []
          agg.push = 0
          return [agg]
        },
        ([agg], rec) =>
          buildSortParamTS(sortArgs(rec, ['tag.name'], { adapter, sortAggregation: agg }) as Any),
        ([agg], rec) =>
          buildSortParamRS(sortArgs(rec, ['tag.name'], { adapter, sortAggregation: agg })),
        () => {
          const previous = Object.getOwnPropertyDescriptor(tagModel, 'collection')
          Object.defineProperty(tagModel, 'collection', {
            configurable: true,
            get() {
              throw marker
            },
          })
          return () => {
            if (previous) {
              Object.defineProperty(tagModel, 'collection', previous)
            } else {
              delete tagModel.collection
            }
          }
        },
      )
      expect(r.error).toEqual({ thrownMarker: 0 })

      // ---- item 8: the sanitized value is destructured from the returned object
      r = await query(
        'item 8: inherited Object.prototype.rawQuery',
        { title: { equals: 'a' } },
        () => {
          Object.defineProperty(Object.prototype, 'rawQuery', {
            configurable: true,
            value: { injected: { $eq: 1 } },
            writable: true,
          })
          return () => {
            delete (Object.prototype as Any).rawQuery
          }
        },
      )
      expect(JSON.stringify(r.result)).toContain('injected')
      r = await query(
        'item 8: inherited rawQuery getter throws',
        { title: { equals: 'a' } },
        () => {
          Object.defineProperty(Object.prototype, 'rawQuery', {
            configurable: true,
            get() {
              throw marker
            },
          })
          return () => {
            delete (Object.prototype as Any).rawQuery
          }
        },
      )
      expect(r.error).toEqual({ thrownMarker: 0 })

      // ---- item 9: direct exports accept the path values upstream accepts, with its errors
      const searchArgs = (rec: Recorder, incomingPath: unknown) =>
        rec.wrap({
          collectionSlug: postsSlug,
          fields,
          incomingPath,
          operator: 'equals',
          parentIsLocalized: false,
          payload,
          val: 'a',
        })
      for (const [id, make] of [
        ['boxed string', () => new String('title')],
        ['custom replace', () => ({ replace: () => 'title' })],
        ['null', () => null],
        ['undefined', () => undefined],
      ] as const) {
        r = await probe(
          `item 9: buildSearchParam incomingPath ${id}`,
          () => [make()],
          ([p], rec) => buildSearchParamTS(searchArgs(rec, p) as Any),
          ([p], rec) => buildSearchParamRS(searchArgs(rec, p)),
        )
        if (id === 'null') {
          expect((r.error as Any)?.message).toContain("reading 'replace'")
        }
      }
      for (const [id, path, operator] of [
        ['number path equals', 7, 'equals'],
        ['boxed path exists', new String('title'), 'exists'],
        ['boxed path contains', new String('title'), 'contains'],
      ] as const) {
        r = await sync(
          `item 9: sanitizeQueryValue ${id}`,
          [path],
          ([p], rec) =>
            sanitizeQueryValueTS(
              rec.wrap({
                field: textField,
                hasCustomID: false,
                operator,
                parentIsLocalized: false,
                path: p,
                payload,
                val: 'a',
              }) as Any,
            ),
          ([p], rec) =>
            sanitizeQueryValueRS(
              rec.wrap({
                field: textField,
                hasCustomID: false,
                operator,
                parentIsLocalized: false,
                path: p,
                payload,
                val: 'a',
              }),
            ),
        )
        expect(r.error).toBeUndefined()
      }
      const customItem = () => [[{ indexOf: () => -1, split: () => [1] }]]
      r = await sync(
        'item 9: sort item with custom indexOf / split',
        customItem,
        ([s], rec) =>
          buildSortParamTS(
            rec.wrap({
              adapter: { disableFallbackSort: true },
              config: { localization: false },
              fields: [],
              sort: s,
              sortAggregation: [],
              timestamps: false,
            }) as Any,
          ),
        ([s], rec) =>
          buildSortParamRS(
            rec.wrap({
              adapter: { disableFallbackSort: true },
              config: { localization: false },
              fields: [],
              sort: s,
              sortAggregation: [],
              timestamps: false,
            }),
          ),
      )

      // ---- item 10: localized block sort spreads before reading / filtering the block fields
      const blockSort = (throwing: boolean) => () => {
        const log: string[] = []
        const accumulator = {
          [Symbol.iterator]() {
            log.push('spread')
            if (throwing) {
              throw marker
            }
            return [][Symbol.iterator]()
          },
        }
        const block = {
          get flattenedFields() {
            log.push('fields')
            return [{ name: 'title', type: 'text' }]
          },
        }
        const blocks: Any = [block]
        blocks.reduce = (cb: Any) => cb(accumulator, block)
        return [[{ name: 'layout', type: 'blocks', blocks }], log]
      }
      for (const throwing of [false, true]) {
        r = await sync(
          `item 10: block sort spread / filter order${throwing ? ' (iterator throws)' : ''}`,
          blockSort(throwing),
          ([f, log], rec) => [
            (() => {
              try {
                return getLocalizedSortPropertyTS(
                  rec.wrap({
                    config: payload.config,
                    fields: f,
                    locale: 'en',
                    parentIsLocalized: false,
                    segments: ['layout', 'title'],
                  }) as Any,
                )
              } catch (e) {
                return e === marker ? 'marker' : e
              }
            })(),
            log,
          ],
          ([f, log], rec) => [
            (() => {
              try {
                return getLocalizedSortPropertyRS(
                  rec.wrap({
                    config: payload.config,
                    fields: f,
                    locale: 'en',
                    parentIsLocalized: false,
                    segments: ['layout', 'title'],
                  }),
                )
              } catch (e) {
                return e === marker ? 'marker' : e
              }
            })(),
            log,
          ],
        )
        expect(JSON.stringify(r.inputsAfter)).toContain(
          throwing ? '["spread"]' : '["spread","fields"]',
        )
      }

      // ---- item 11: the exported operator map is read live
      r = await query(
        'item 11: operatorMap.equals mutated',
        { title: { equals: 'a' } },
        replace(operatorMap, 'equals', '$ne'),
      )
      expect(JSON.stringify(r.result)).toContain('$ne')
      const mapLog: unknown[] = []
      r = await query(
        'item 11: operatorMap getter',
        { title: { equals: 'a' } },
        () => {
          mapLog.length = 0
          const previous = Object.getOwnPropertyDescriptor(operatorMap, 'equals')!
          Object.defineProperty(operatorMap, 'equals', {
            configurable: true,
            get() {
              mapLog.push('read')
              return '$eq'
            },
          })
          return () => Object.defineProperty(operatorMap, 'equals', previous)
        },
        mapLog,
      )
      expect(JSON.stringify(r.result)).toContain('read')

      // ---- item 14: relationship hops share one options object across TS and Rust adapters
      const hopWhere = { 'tag.post.title': { equals: 'post 0' } }
      r = await probe(
        'item 14: mixed TS / Rust hops share subQueryOptions',
        [hopWhere],
        async ([w], rec) => [
          await buildQueryTS(queryArgs(rec, w) as Any),
          await buildQueryTS(queryArgs(rec, w) as Any),
        ],
        async ([w], rec) => [
          await buildQueryTS(queryArgs(rec, w) as Any),
          await buildQueryRS(queryArgs(rec, w)),
        ],
        { tsEntersEngine: false },
      )
      expect(
        events(r).filter((e) => e?.ev === 'call' && e.method === 'find').length,
      ).toBeGreaterThan(2)
      r = await query('item 14: Rust hops reuse one options object', {
        'tag.post.title': { equals: 'post 0' },
        or: [{ 'tag.post.title': { equals: 'post 1' } }],
      })
      expect(r.error).toBeUndefined()

      // ---- results
      for (const d of comparison.diffs) {
        console.log(`[rs live query] DIFF ${d.id}: ${d.kind}`)
        console.log(`  ts: ${summarize(d.ts as CaseRun, d.kind)}`)
        console.log(`  rs: ${summarize(d.rs as CaseRun, d.kind)}`)
      }
      console.log(
        `[rs live query] adversarial: ${comparison.compared} compared, ${comparison.diffs.length} differ`,
      )
      expect(comparison.compared).toBeGreaterThan(35)
      expect(comparison.diffs.map((d) => d.id).sort()).toEqual(Object.keys(KNOWN_GAPS).sort())

      // ---- negative controls of the harness gaps: each must be reported as a difference
      const controls: Comparison = { compared: 0, diffs: [] }
      const control = (
        id: string,
        inputs: (() => unknown[]) | unknown[],
        ts: (i: Any[], rec: Recorder) => unknown,
        rs: (i: Any[], rec: Recorder) => unknown,
      ) =>
        compareCase({
          classes,
          comparison: controls,
          engineOptional: true,
          id,
          inputs,
          rs,
          rsSpies: () => () => {},
          ts,
          tsSpies: () => () => {},
        })
      const input = { a: 1 }
      await control(
        'function metadata',
        [],
        () => function f(_x: unknown) {},
        () => (_x: unknown) => {},
      )
      await control(
        'function length',
        [],
        () => (_a: unknown, _b: unknown) => {},
        () => (_a: unknown) => {},
      )
      class E1 extends Error {}
      const E2 = { E1: class extends Error {} }.E1
      await control(
        'same-named error classes',
        [],
        () => {
          throw new E1('x')
        },
        () => {
          throw new E2('x')
        },
      )
      await control(
        'thrown primitive typeof',
        [],
        () => {
          throw 7
        },
        () => {
          throw '7'
        },
      )
      await control(
        'error own properties',
        [],
        () => {
          throw Object.assign(new Error('x'), { code: 1 })
        },
        () => {
          throw Object.assign(new Error('x'), { code: 2 })
        },
      )
      await control(
        'array extra property value',
        [],
        () => Object.assign([1], { x: 1 }),
        () => Object.assign([1], { x: 2 }),
      )
      await control(
        'array symbol property',
        [],
        () => [1],
        () => Object.assign([1], { [Symbol.for('s')]: 1 }),
      )
      await control(
        'array length writability',
        [],
        () => [1],
        () => Object.defineProperty([1], 'length', { writable: false }),
      )
      await control(
        'descriptor flags',
        [],
        () => ({ a: 1 }),
        () => Object.defineProperty({}, 'a', { enumerable: true, value: 1 }),
      )
      await control(
        'own __proto__ key',
        [],
        () => JSON.parse('{"__proto__": 1}'),
        () => JSON.parse('{"__proto__": 2}'),
      )
      await control(
        'prototype identity',
        [],
        () => new (class A {})(),
        () => new { A: class {} }.A(),
      )
      await control(
        'input class instance identity',
        () => [new ObjectId(hex)],
        ([o]) => [o],
        ([o]) => [new ObjectId(o.toHexString())],
      )
      await control(
        'cross-event identity',
        [],
        (_i, rec) => {
          const o = { lean: true }
          rec.events.push(canonical(o, rec, classes), canonical(o, rec, classes))
        },
        (_i, rec) => {
          rec.events.push(
            canonical({ lean: true }, rec, classes),
            canonical({ lean: true }, rec, classes),
          )
        },
      )
      const ticker =
        (extra: number) =>
        async ([o]: Any[]) => {
          for (let i = 0; i < 6; i++) {
            for (let j = 0; j < 150; j++) {
              await null
            }
            void o.a
          }
          for (let j = 0; j < extra; j++) {
            await null
          }
          return o.a
        }
      await control('tick beyond 400 microtasks', [input], ticker(0), ticker(1))
      expect(controls.diffs.map((d) => d.id).sort()).toEqual(
        [
          'array extra property value',
          'array length writability',
          'array symbol property',
          'cross-event identity',
          'descriptor flags',
          'error own properties',
          'function length',
          'function metadata',
          'input class instance identity',
          'own __proto__ key',
          'prototype identity',
          'same-named error classes',
          'thrown primitive typeof',
          'tick beyond 400 microtasks',
        ].sort(),
      )
      // cloning keeps classes with internal slots
      const cloned = cloneLive([
        new Map([[1, { a: 1 }]]),
        new Set([2]),
        /a/g,
        new Uint8Array([1, 2]),
      ]) as Any[]
      expect(cloned[0] instanceof Map && cloned[0].get(1).a === 1).toBe(true)
      expect(cloned[1] instanceof Set && cloned[1].has(2)).toBe(true)
      expect(cloned[2] instanceof RegExp && cloned[2].flags === 'g').toBe(true)
      expect(cloned[3] instanceof Uint8Array && cloned[3][1] === 2).toBe(true)
    })
  },
)

void (null as unknown as Payload)
