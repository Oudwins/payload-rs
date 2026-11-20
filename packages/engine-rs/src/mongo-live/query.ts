/**
 * Host of the live Mongo query port (crates/payload-mongo-live-query, `mongoLiveQueryBinding()` of
 * the engine addon; owner livequery, moved here from test/__rs/mongo-live-query/glue.ts so the
 * production loader can install it). `getMongoLive()` initializes the binding with this host right
 * after the shared live helpers, so the ports payload-node registers in
 * `payload_mongo_live::deps` (`buildQuery`, `buildSortParam`, `buildProjectionFromSelect`) can run.
 *
 * Every helper is a function the TS calls at that point (payload's `getLocalizedPaths`,
 * `getFieldByPath`, `deepMergeWithCombinedArrays`, `escapeRegExp`, ...) or a TS expression copied
 * verbatim where the language defines the semantics (parameter destructuring with its defaults and
 * V8 messages, `for...of`, array destructuring, spreads, template-literal ToString). Control flow,
 * callbacks, awaits and mongoose model calls are Rust.
 */
import * as upstreamBuildSearchParams from '../../../db-mongodb/src/queries/buildSearchParams.js'
import { operatorMap } from '../../../db-mongodb/src/queries/operatorMap.js'
import { getLocalizedPaths } from '../../../payload/src/database/getLocalizedPaths.js'
import { isNestedRelationshipQuery } from '../../../payload/src/database/isNestedRelationshipQuery.js'
import { APIError } from '../../../payload/src/errors/APIError.js'
import {
  fieldAffectsData,
  fieldIsPresentationalOnly,
  fieldShouldBeLocalized,
} from '../../../payload/src/fields/config/types.js'
import {
  hasManyRelationshipOperatorSet,
  validOperatorSet,
} from '../../../payload/src/types/constants.js'
import { createArrayFromCommaDelineated } from '../../../payload/src/utilities/createArrayFromCommaDelineated.js'
import { deepCopyObjectSimple } from '../../../payload/src/utilities/deepCopyObject.js'
import { deepMergeWithCombinedArrays } from '../../../payload/src/utilities/deepMerge.js'
import { escapeRegExp } from '../../../payload/src/utilities/escapeRegExp.js'
import { getFieldByPath } from '../../../payload/src/utilities/getFieldByPath.js'
import { getSelectMode } from '../../../payload/src/utilities/getSelectMode.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- the helpers mirror untyped TS expressions */
type Any = any

export type MongoLiveQueryBinding = {
  apiVersion?: number
  buildAndOrConditions: (args: Any) => Promise<Any>
  buildProjectionFromSelect: (args: Any) => Any
  buildQuery: (args: Any) => Promise<Any>
  buildSearchParam: (args: Any) => Promise<Any>
  buildSortParam: (args: Any) => Any
  getBuildQueryPlugin: (args?: Any) => (schema: Any) => void
  getLocalizedSortProperty: (args: Any) => string
  init: (host: Record<string, unknown>) => void
  parseParams: (args: Any) => Promise<Any>
  sanitizeQueryValue: (args: Any) => Any
}

/** crates/payload-mongo-live-query/src/binding.rs `API_VERSION` */
const MONGO_LIVE_QUERY_API_VERSION = 2

const DONE = Symbol('done')

/**
 * `const subQueryOptions = { lean: true }`, the module constant of db-mongodb's buildSearchParams.ts
 * that every relationship hop passes to `SubModel.find`: upstream's own object when that module
 * exports it (shared with TS adapters in the same process), else one object of this module.
 */
const subQueryOptions = ((upstreamBuildSearchParams as Record<string, unknown>).subQueryOptions as
  | { lean: boolean }
  | undefined) ?? { lean: true }

/** Engine-internal (captured): the key a computed property name converts to. */
const ownKeys = Reflect.ownKeys

/**
 * db-mongodb's `getBuildQueryPlugin` (queries/getBuildQueryPlugin.ts) verbatim, with the Rust
 * `parseParams`: the plugin and the `Model.buildQuery` static are the real JS functions upstream
 * creates (a plain `function buildQueryPlugin(schema)`, an `async function schemaBuildQuery`).
 */
const createGetBuildQueryPlugin = (parseParams: (args: Any) => Promise<Any>) => {
  const getBuildQueryPlugin = ({ collectionSlug, versionsFields }: Any = {}) => {
    return function buildQueryPlugin(schema: any) {
      const modifiedSchema = schema
      async function schemaBuildQuery({
        globalSlug,
        locale,
        payload,
        where,
      }: Any): Promise<Record<string, unknown>> {
        let fields: Any = null

        if (versionsFields) {
          fields = versionsFields
        } else {
          if (globalSlug) {
            const globalConfig = payload.globals.config.find(({ slug }: Any) => slug === globalSlug)

            if (!globalConfig) {
              throw new APIError(`Global with the slug ${globalSlug} was not found`)
            }

            fields = globalConfig.flattenedFields
          }
          if (collectionSlug) {
            const collectionConfig = payload.collections[collectionSlug]?.config

            if (!collectionConfig) {
              throw new APIError(`Collection with the slug ${globalSlug} was not found`)
            }

            fields = collectionConfig.flattenedFields
          }
        }

        if (fields === null) {
          throw new APIError('Fields are not initialized.')
        }

        const result = await parseParams({
          collectionSlug,
          fields,
          globalSlug,
          locale,
          parentIsLocalized: false,
          payload,
          where,
        })

        return result
      }
      modifiedSchema.statics.buildQuery = schemaBuildQuery
    }
  }
  return getBuildQueryPlugin
}

export const createMongoLiveQueryHost = (): Record<string, unknown> => ({
  DONE,
  // `for (const x of v)` stepped from Rust
  closeReturn: (g: Generator) => {
    g.return(undefined)
  },
  closeThrow: (g: Generator, e: unknown) => {
    try {
      g.throw(e)
    } catch {
      // the loop body's error is the one that propagates
    }
  },
  *forOf(v: Any) {
    for (const x of v) {
      yield x
    }
  },
  // the upstream `for...of` statements (iterable expression, head pattern, V8 messages)
  *forOfBlocks(field: Any) {
    for (const _block of field.blocks) {
      yield _block
    }
  },
  *forOfHopEntries(pathsToQuery: Any) {
    for (const [i, { collectionSlug, path: subPath }] of pathsToQuery.entries()) {
      yield [i, collectionSlug, subPath]
    }
  },
  *forOfKeys(where: Any) {
    for (const relationOrPath of Object.keys(where)) {
      yield relationOrPath
    }
  },
  *forOfSegments(joinPath: Any) {
    for (const segment of joinPath.split('.')) {
      yield segment
    }
  },
  *forOfValidOperators(validOperators: Any) {
    for (const operator of validOperators) {
      yield operator
    }
  },
  *forOfWhere(where: Any) {
    for (const condition of where) {
      yield condition
    }
  },
  inOp: (k: string, o: Any) => k in o,
  newDate: (v: Any) => new Date(v),
  // `Number.isNaN(Date.parse(formattedValue))` / `Number.isNaN(Number(v))` (callee first)
  isNaNDateParse: (v: Any) => Number.isNaN(Date.parse(v)),
  isNaNNumber: (v: Any) => Number.isNaN(Number(v)),
  replace: (s: Any, pattern: string, replacement: Any) => s.replace(pattern, replacement),
  toPropertyKey: (k: Any) => ownKeys({ [k]: 0 })[0],
  // buildSearchParams.ts
  firstFieldPath: (paths: Any) => {
    const [{ field, path }] = paths
    return [field, path]
  },
  hopPaths: (paths: Any) => [paths.slice(1).reverse(), paths.slice(0, -1).reverse()],
  operatorMap,
  replaceDunder: (incomingPath: Any) => incomingPath.replace(/__/g, '.'),
  replaceLocaleOrDefault: (path: Any, locale: Any, payload: Any) =>
    path.replace('<locale>', locale || payload.config.localization.defaultLocale),
  // parseParams.ts, after `const searchParam = await buildSearchParam(...)` (returns `result`)
  searchParamBuilt: (result: Any, searchParam: Any, validOperators: Any) => {
    if (searchParam?.value && searchParam?.path) {
      if (validOperators.length > 1) {
        if (!result.$and) {
          result.$and = []
        }
        result.$and.push({
          [searchParam.path]: searchParam.value,
        })
      } else {
        if (result[searchParam.path]) {
          if (!result.$and) {
            result.$and = []
          }

          result.$and.push({ [searchParam.path]: result[searchParam.path] })
          result.$and.push({
            [searchParam.path]: searchParam.value,
          })
          delete result[searchParam.path]
        } else {
          result[searchParam.path] = searchParam.value
        }
      }
    } else if (typeof searchParam?.value === 'object') {
      result = deepMergeWithCombinedArrays(result, searchParam.value ?? {}, {
        // dont clone Types.ObjectIDs
        clone: false,
      })
    }
    return result
  },
  // sanitizeQueryValue.ts
  buildExistsQuery: (formattedValue: unknown, path: Any, treatEmptyString = true) => {
    if (formattedValue) {
      return {
        rawQuery: {
          $and: [
            { [path]: { $exists: true } },
            { [path]: { $ne: null } },
            ...(treatEmptyString ? [{ [path]: { $ne: '' } }] : []), // Treat empty string as null / undefined
          ],
        },
      }
    } else {
      return {
        rawQuery: {
          $or: [
            { [path]: { $exists: false } },
            { [path]: { $eq: null } },
            ...(treatEmptyString ? [{ [path]: { $eq: '' } }] : []), // Treat empty string as null / undefined
          ],
        },
      }
    }
  },
  // getLocalizedSortProperty.ts, the blocks reduce (spread, then the filter, then its spread)
  createGetBuildQueryPlugin,
  spreadFiltered: (flattenedBlockFields: Any, block: Any, filter: Any) => [
    ...flattenedBlockFields,
    ...block.flattenedFields.filter(filter),
  ],
  step: (g: Generator) => {
    const r = g.next()
    return r.done ? DONE : r.value
  },
  stringOf: (v: unknown) => String(v),
  template: (v: unknown) => `${v as string}`,
  // `;[lng, lat, maxDistance, minDistance] = formattedValue` (sanitizeQueryValue.ts)
  createArrayFromCommaDelineated: (s: Any) => createArrayFromCommaDelineated(s),
  deepCopyObjectSimple: (v: Any) => deepCopyObjectSimple(v),
  destructure4: (formattedValue: Any) => {
    // eslint-disable-next-line prefer-const -- upstream's statement (assignment pattern), verbatim
    let lat, lng, maxDistance, minDistance
    ;[lng, lat, maxDistance, minDistance] = formattedValue
    return [lng, lat, maxDistance, minDistance]
  },
  escapeRegExp: (s: Any) => escapeRegExp(s),
  fieldAffectsData: (field: Any) => fieldAffectsData(field),
  fieldIsPresentationalOnly: (field: Any) => fieldIsPresentationalOnly(field),
  fieldShouldBeLocalized: (field: Any, parentIsLocalized: Any) =>
    fieldShouldBeLocalized({ field, parentIsLocalized }),
  getFieldByPath: (fields: Any, path: Any) => getFieldByPath({ fields, path }),
  getLocalizedPaths: (
    collectionSlug: Any,
    fields: Any,
    globalSlug: Any,
    incomingPath: Any,
    locale: Any,
    parentIsLocalized: Any,
    payload: Any,
  ) =>
    getLocalizedPaths({
      collectionSlug,
      fields,
      globalSlug,
      incomingPath,
      locale,
      parentIsLocalized,
      payload,
    }),
  getSelectMode: (v: Any) => getSelectMode(v),
  isHasManyRelationshipOperator: (operator: Any) => hasManyRelationshipOperatorSet.has(operator),
  isNestedRelationshipQuery: (v: unknown) => isNestedRelationshipQuery(v),
  isValidOperator: (operator: Any) => validOperatorSet.has(operator),
  spread: (a: Any) => [...a],
  subQueryOptions,
  // parameter destructuring of the upstream functions (same patterns, defaults and V8 messages)
  buildProjectionFromSelectArgs: ({ adapter, fields, select }: Any) => [adapter, fields, select],
  buildQueryArgs: ({ adapter, collectionSlug, fields, globalSlug, locale, where }: Any) => [
    adapter,
    collectionSlug,
    fields,
    globalSlug,
    locale,
    where,
  ],
  buildSearchParamArgs: ({
    collectionSlug,
    fields,
    globalSlug,
    incomingPath,
    locale,
    operator,
    parentIsLocalized,
    payload,
    val,
  }: Any) => [
    collectionSlug,
    fields,
    globalSlug,
    incomingPath,
    locale,
    operator,
    parentIsLocalized,
    payload,
    val,
  ],
  buildSortParamArgs: ({
    adapter,
    config,
    fields,
    locale,
    parentIsLocalized = false,
    sort,
    sortAggregation,
    timestamps,
    versions,
  }: Any) => [
    adapter,
    config,
    fields,
    locale,
    parentIsLocalized,
    sort,
    sortAggregation,
    timestamps,
    versions,
  ],
  getLocalizedSortPropertyArgs: ({
    config,
    fields,
    locale,
    parentIsLocalized,
    result,
    segments,
  }: Any) => [config, fields, locale, parentIsLocalized, result, segments],
  parseParamsArgs: ({
    collectionSlug,
    fields,
    globalSlug,
    locale,
    parentIsLocalized,
    payload,
    where,
  }: Any) => [collectionSlug, fields, globalSlug, locale, parentIsLocalized, payload, where],
  sanitizeQueryValueArgs: ({
    field,
    hasCustomID,
    locale,
    operator,
    parentIsLocalized,
    path,
    payload,
    val,
  }: Any) => [field, hasCustomID, locale, operator, parentIsLocalized, path, payload, val],
})

let queryBinding: MongoLiveQueryBinding | undefined

/**
 * Initializes `mongoLiveQueryBinding()` of `addon` with its host (once). Called by `getMongoLive()`;
 * `null` when the addon has no live query port (the reads then call upstream's TS query builders).
 */
export const initMongoLiveQuery = ({
  addon,
  addonPath,
}: {
  addon: { mongoLiveQueryBinding?: () => MongoLiveQueryBinding }
  addonPath: string
}): MongoLiveQueryBinding | null => {
  if (queryBinding) {
    return queryBinding
  }
  if (typeof addon.mongoLiveQueryBinding !== 'function') {
    return null
  }
  const created = addon.mongoLiveQueryBinding()
  if (created.apiVersion !== MONGO_LIVE_QUERY_API_VERSION) {
    throw new Error(
      `The engine addon at ${addonPath} has mongo live query API version ${created.apiVersion}, expected ${MONGO_LIVE_QUERY_API_VERSION}; rebuild it`,
    )
  }
  created.init(createMongoLiveQueryHost())
  queryBinding = created
  return created
}

/** The initialized live query binding (after `getMongoLive()`), `undefined` before. */
export const getMongoLiveQueryBinding = (): MongoLiveQueryBinding | undefined => queryBinding
