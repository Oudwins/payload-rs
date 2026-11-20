/**
 * JS helpers of the live-object MongoDB engine (crates/payload-mongo-live `host`, looked up by name;
 * MONGO_ENGINE_CONTRACT.md "Live helpers"). Each helper is one TS expression, destructuring pattern
 * or closure of the upstream db-mongodb code, evaluated at the point where upstream evaluates it:
 *
 * - destructuring patterns of the data methods (same defaults, getter order and V8 errors),
 * - object literals / spreads / closures handed to mongoose (`useCustomCountFn`, count options,
 *   `.then` callbacks of `findDistinct`),
 * - JS built-ins whose semantics the engine must not re-implement (`instanceof`, `new Date()`,
 *   `Promise.resolve`, `JSON.parse(JSON.stringify(...))`, operators on non-numbers),
 * - upstream utilities that are called rather than ported (`flattenWhereToOperators`,
 *   `buildVersionCollectionFields`, `getFieldByPath`, error classes),
 * - `upstream`: db-mongodb's own `buildQuery` / `buildSortParam` / `buildProjectionFromSelect` /
 *   `transform` / `buildJoinAggregation` / `resolveJoins` for the entries no live crate has
 *   registered a port for yet (crates/payload-mongo-live `deps`).
 *
 * Control flow, awaits and model calls are Rust. Payload / db-mongodb internals are imported by
 * relative path (engine-rs has no dependency on them; the workspace resolves both packages to these
 * same source files, so module instances and classes are shared).
 */
import { createRequire } from 'node:module'

import { buildQuery } from '../../../db-mongodb/src/queries/buildQuery.js'
import { buildSortParam } from '../../../db-mongodb/src/queries/buildSortParam.js'
import { buildJoinAggregation } from '../../../db-mongodb/src/utilities/buildJoinAggregation.js'
import { buildProjectionFromSelect } from '../../../db-mongodb/src/utilities/buildProjectionFromSelect.js'
import { resolveJoins } from '../../../db-mongodb/src/utilities/resolveJoins.js'
import { transform } from '../../../db-mongodb/src/utilities/transform.js'
import { flattenWhereToOperators } from '../../../payload/src/database/flattenWhereToOperators.js'
import { APIError } from '../../../payload/src/errors/APIError.js'
import { ValidationError } from '../../../payload/src/errors/ValidationError.js'
import { getFieldByPath } from '../../../payload/src/utilities/getFieldByPath.js'
import { buildVersionCollectionFields } from '../../../payload/src/versions/buildCollectionFields.js'
import { buildVersionGlobalFields } from '../../../payload/src/versions/buildGlobalFields.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- the helpers mirror untyped TS expressions */
type Any = any

/** The `mongoose` module `@payloadcms/db-mongodb` imports (resolved from its package location). */
export const resolveDbMongodbMongoose = (): Any =>
  createRequire(new URL('../../../db-mongodb/package.json', import.meta.url))('mongoose')

/** db-mongodb functions owned by other live crates, called while their port is not registered. */
const upstreamFunctions: Record<string, (args: Any) => unknown> = {
  buildJoinAggregation,
  buildProjectionFromSelect,
  buildQuery,
  buildSortParam,
  resolveJoins,
  transform,
}

/** `sanitizeGroupID` of findDistinct.ts (module-private there). */
const sanitizeGroupID = (id: any) => {
  if (id && typeof id === 'object' && '_field' in id) {
    return id._field
  }

  return id
}

export const createMongoLiveHost = ({ mongoose }: { mongoose?: Any } = {}): Record<
  string,
  unknown
> => {
  const resolvedMongoose = mongoose ?? resolveDbMongodbMongoose()
  return {
    BSON: resolvedMongoose.mongo.BSON,
    Types: resolvedMongoose.Types,

    // ------------------------------------------------------------ generic JS semantics
    binop: (op: string, a: Any, b: Any) => {
      switch (op) {
        case '*':
          return a * b
        case '+':
          return a + b
        case '/':
          return a / b
        case '>':
          return a > b
        case '>=':
          return a >= b
        case '-':
          return a - b
        default:
          throw new Error(`mongo live host: unknown operator ${op}`)
      }
    },
    /** `Math.ceil(a / b)` */
    ceilDiv: (a: Any, b: Any) => Math.ceil(a / b),
    dateNow: () => Date.now(),
    hasIn: (o: Any, k: string) => k in o,
    isArray: Array.isArray,
    isDate: (v: unknown) => v instanceof Date,
    isPromise: (v: unknown) => v instanceof Promise,
    newDate: () => new Date(),
    newDateOf: (v: Any) => new Date(v),
    notAConstructor: (expr: string) => new TypeError(`${expr} is not a constructor`),
    notAFunction: (expr: string) => new TypeError(`${expr} is not a function`),
    nowISO: () => new Date().toISOString(),
    objectKeys: (o: Any) => Object.keys(o),
    objectKeysLength: (o: Any) => Object.keys(o).length,
    /** `${prefix}${value}${suffix}` */
    template: (prefix: string, value: Any, suffix: string) => `${prefix}${value}${suffix}`,
    templateString: (v: Any) => `${v}`,

    // ------------------------------------------------------------ errors
    entityNotFound: (what: string, slug: Any) =>
      new APIError(`ERROR: Failed to retrieve ${what} with the slug "${slug}". Does not exist.`),
    newError: (kind: string, ...args: Any[]) => {
      switch (kind) {
        case 'APIError':
          return new (APIError as Any)(...args)
        case 'BSONError':
          return new resolvedMongoose.mongo.BSON.BSONError(...args)
        case 'Error':
          return new Error(...args)
        case 'RangeError':
          return new RangeError(...args)
        case 'TypeError':
          return new TypeError(...args)
        case 'ValidationError':
          return new (ValidationError as Any)(...args)
        default:
          return new Error(`mongo live host: unknown error class ${kind}`)
      }
    },

    // ------------------------------------------------------------ getEntity.ts
    findGlobalConfig: (adapter: Any, globalSlug: Any) =>
      adapter.payload.config.globals.find((each: Any) => each.slug === globalSlug),

    // ------------------------------------------------------------ payload utilities
    buildVersionCollectionFields: (...args: Any[]) =>
      (buildVersionCollectionFields as Any)(...args),
    buildVersionGlobalFields: (...args: Any[]) => (buildVersionGlobalFields as Any)(...args),
    getFieldByPath: (config: Any, fields: Any, path: Any) =>
      getFieldByPath({ config, fields, includeRelationships: true, path }),
    /** `flattenWhereToOperators(where).some((prop) => Object.keys(prop).some((key) => key === 'near'))` */
    hasNearConstraint: (where: Any) => {
      const constraints = flattenWhereToOperators(where)
      return constraints.some((prop) => Object.keys(prop).some((key) => key === 'near'))
    },

    // ------------------------------------------------------------ data method arguments
    aggregatePaginateArgs: ({
      adapter,
      collation,
      joinAggregation,
      limit,
      Model,
      page,
      pagination,
      projection,
      query,
      session,
      sort,
      sortAggregation,
      useEstimatedCount,
    }: Any) => [
      adapter,
      collation,
      joinAggregation,
      limit,
      Model,
      page,
      pagination,
      projection,
      query,
      session,
      sort,
      sortAggregation,
      useEstimatedCount,
    ],
    countArgs: ({ collection, locale, req, where = {} }: Any) => [collection, locale, req, where],
    countGlobalVersionsArgs: ({ global, locale, req, where = {} }: Any) => [
      global,
      locale,
      req,
      where,
    ],
    findArgs: ({
      collection,
      draftsEnabled,
      joins = {},
      limit = 0,
      locale,
      page,
      pagination,
      projection,
      req,
      select,
      sort,
      where = {},
    }: Any) => [
      collection,
      draftsEnabled,
      joins,
      limit,
      locale,
      page,
      pagination,
      projection,
      req,
      select,
      sort,
      where,
    ],
    findGlobalArgs: ({ slug, locale, req, select, where = {} }: Any) => [
      slug,
      locale,
      req,
      select,
      where,
    ],
    findGlobalVersionsArgs: ({
      global,
      limit = 0,
      locale,
      page,
      pagination,
      req,
      select,
      sort,
      where = {},
    }: Any) => [global, limit, locale, page, pagination, req, select, sort, where],
    findOneArgs: ({ collection, draftsEnabled, joins, locale, req, select, where = {} }: Any) => [
      collection,
      draftsEnabled,
      joins,
      locale,
      req,
      select,
      where,
    ],
    findVersionsArgs: ({
      collection,
      limit = 0,
      locale,
      page,
      pagination,
      req = {},
      select,
      sort,
      where = {},
    }: Any) => [collection, limit, locale, page, pagination, req, select, sort, where],
    queryDraftsArgs: ({
      collection,
      joins,
      limit,
      locale,
      page,
      pagination,
      req,
      select,
      sort,
      where = {},
    }: Any) => [collection, joins, limit, locale, page, pagination, req, select, sort, where],
    /** `const { where = {} } = args` (findDistinct) */
    whereOf: (args: Any) => {
      const { where = {} } = args
      return where
    },

    // ------------------------------------------------------------ pagination / counting
    /** `{ locale: ..., ...this.collation }` of the `if (this.collation)` blocks. */
    collationOf: (adapter: Any, locale: Any) => {
      const localizationConfig = adapter.payload.config.localization
      const defaultLocale =
        (typeof localizationConfig === 'object' && localizationConfig?.defaultLocale) || 'en'
      return {
        locale: locale && locale !== 'all' && locale !== '*' ? locale : defaultLocale,
        ...adapter.collation,
      }
    },
    /** `paginationOptions.useCustomCountFn = () => Promise.resolve(Model.countDocuments(...))` */
    customCountFn: (
      Model: Any,
      query: Any,
      paginationOptions: Any,
      session: Any,
      withHint: boolean,
    ) =>
      withHint
        ? () => {
            return Promise.resolve(
              Model.countDocuments(query, {
                collation: paginationOptions.collation,
                hint: { _id: 1 },
                session,
              }),
            )
          }
        : () => {
            return Promise.resolve(
              Model.countDocuments(query, {
                collation: paginationOptions.collation,
                session,
              }),
            )
          },
    /** aggregatePaginate: `{ collation, session, ...(hint ? { hint } : {}) }` */
    countOptions: (collation: Any, session: Any, useHint: boolean) => {
      const hint = useHint ? { _id: 1 } : undefined
      return {
        collation,
        session,
        ...(hint ? { hint } : {}),
      }
    },
    /** `const [docs, countResult] = <array>` */
    destructurePair: (pair: Any) => {
      const [first, second] = pair
      return [first, second]
    },
    /** `for (const stage of source) target.push(stage)` */
    pushEach: (target: Any[], source: Any) => {
      for (const stage of source) {
        target.push(stage)
      }
    },
    /** aggregatePaginate's `$sort` stage. */
    pushSortStage: (aggregation: Any[], sort: Any) => {
      const $sort: Record<string, -1 | 1> = {}

      Object.entries(sort).forEach(([key, value]) => {
        $sort[key] = value === 'desc' ? -1 : 1
      })

      aggregation.push({ $sort })
    },
    resolvedNull: () => Promise.resolve(null),

    // ------------------------------------------------------------ findDistinct
    /** `Model.aggregate(countPipeline, { session }).then((res) => res[0]?.count ?? 0)` */
    aggregateCount: (Model: Any, countPipeline: Any, session: Any) =>
      Model.aggregate(countPipeline, {
        session,
      }).then((res: Any) => res[0]?.count ?? 0),
    /** `getValues` of findDistinct (the async arrow itself: its ticks are upstream's). */
    // eslint-disable-next-line @typescript-eslint/require-await -- upstream's async arrow, kept as is
    distinctGetValues: async (Model: Any, pipeline: Any, session: Any, args: Any) => {
      return Model.aggregate(pipeline, { session }).then((res: Any) =>
        res.map((each: Any) => ({
          [args.field]: JSON.parse(JSON.stringify(sanitizeGroupID(each._id))),
        })),
      )
    },
    /** `currentFields.find((e) => e.name === segment)` */
    findByName: (fields: Any, segment: Any) => fields.find((e: Any) => e.name === segment),
    /** the two `relationLookup.push(...)` of findDistinct's relationship loop */
    pushRelationLookup: (
      relationLookup: Any[],
      fieldPath: string,
      foreignModel: Any,
      relatedAccessQuery: Any,
    ) => {
      relationLookup.push({
        $lookup: {
          as: fieldPath,
          from: foreignModel.collection.name,
          ...(relatedAccessQuery
            ? {
                let: { relatedIDs: `$${fieldPath}` },
                pipeline: [
                  {
                    $match: {
                      $and: [
                        {
                          $expr: {
                            $cond: {
                              else: { $eq: ['$_id', '$$relatedIDs'] },
                              if: { $isArray: '$$relatedIDs' },
                              then: { $in: ['$_id', '$$relatedIDs'] },
                            },
                          },
                        },
                        relatedAccessQuery,
                      ],
                    },
                  },
                ],
              }
            : {
                foreignField: '_id',
                localField: fieldPath,
              }),
        },
      })
      relationLookup.push({ $unwind: `$${fieldPath}` })
    },
    /** `fieldPathResult.localizedPath.replace('<locale>', args.locale)` */
    replaceLocale: (localizedPath: Any, locale: Any) => localizedPath.replace('<locale>', locale),
    /** the `if (sortProperty.startsWith('_')) { ... }` block of findDistinct */
    stripRelationPrefix: (sortProperty: Any, lastFieldPath: Any) => {
      if (sortProperty.startsWith('_')) {
        const sortWithoutRelationPrefix = sortProperty.replace(/^_+/, '')
        if (sortWithoutRelationPrefix.startsWith(lastFieldPath)) {
          sortProperty = sortWithoutRelationPrefix
        }
      }
      return sortProperty
    },
    /** `${tempPath}.${field.name}` */
    templateDot: (a: Any, b: Any) => `${a}.${b}`,
    /** `sortAggregation.filter(...)` of findDistinct's relationship loop */
    withoutLookup: (sortAggregation: Any[], fieldPath: Any) =>
      sortAggregation.filter((each) => {
        if ('$lookup' in each && each.$lookup.as.replace(/^_+/, '') === fieldPath) {
          return false
        }

        return true
      }),

    // ------------------------------------------------------------ not yet ported entries
    upstream: (name: string, args: Any) => upstreamFunctions[name]!(args),
  }
}
