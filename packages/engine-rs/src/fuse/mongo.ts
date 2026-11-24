/**
 * The MongoDB target of the fused read lanes (FUSE_CONTRACT.md section 8): registered by the
 * driver lane (`installDriverLane`) for each adapter with a Rust driver client. A fused call's
 * `payload.db.find` / `findOne` / `count` becomes the commands the driver lane would send for it
 * (MONGO_DRIVER_CONTRACT.md "Read methods"): upstream's query planning (`buildSortParam`,
 * `buildProjectionFromSelect`, `sanitizeQueryValue`, `parseParams` / `buildSearchParam` without
 * their sub-query branches) and the casting mongoose would apply, reproduced here for the schema
 * types and values where it is the identity or a fixed conversion (anything else runs the exact
 * lane). The commands, the transform and the fused core then run in one native call on the
 * driver runtime (crates/payload-fuse-mongo).
 *
 * Only the driver lane imports this module (it loads db-mongodb's sources).
 */
import type { FusedTarget, FusedTargetLookup } from './targets.js'

import { buildSortParam } from '../../../db-mongodb/src/queries/buildSortParam.js'
import { sanitizeQueryValue } from '../../../db-mongodb/src/queries/sanitizeQueryValue.js'
import { buildProjectionFromSelect } from '../../../db-mongodb/src/utilities/buildProjectionFromSelect.js'
import { getCollection } from '../../../db-mongodb/src/utilities/getEntity.js'
import { getLocalizedPaths } from '../../../payload/src/database/getLocalizedPaths.js'
import { validOperatorSet } from '../../../payload/src/types/constants.js'
import { deepMergeWithCombinedArrays } from '../../../payload/src/utilities/deepMerge.js'
import { escapeRegExp } from '../../../payload/src/utilities/escapeRegExp.js'
import { loadCoreRuntimeAddon } from '../addon.js'
import {
  customCountOptions,
  type DriverLane,
  Fallback,
  hasNear,
  isPristineModel,
  localeCollation,
  mongooseBlocksLane,
  planFor,
} from '../mongo-driver/lane.js'
import { verifyMode } from '../mongo-driver/verify.js'
import { isTracing, runTraced, type TraceEvent } from '../shadow-mongo/trace.js'
import { registerFusedTarget } from './targets.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- mirrors untyped upstream code */
type Any = any

type FuseAddon = {
  fuseRunMongo?: (
    client: number,
    transformPlan: number,
    requestJson: string,
    reads: Uint8Array,
  ) => Promise<string>
}

/** What a request carries to the native call besides its JSON (`reads`: for the shadow check). */
type MongoPayload = { bytes: Uint8Array; client: number; plan: number; reads: Any }

/** A part of the call the lane does not reproduce: the call runs on the exact lane. */
class Unsupported extends Error {}

const unsupported = (reason: string): never => {
  throw new Unsupported(reason)
}

/**
 * Registers the fused target of `adapter` (after the driver lane installed `methods` on it): a
 * call is fused while the adapter's read methods are still those, its lane is up and mongoose has
 * no setting the driver lane would refuse.
 */
export const registerFusedMongoTarget = ({
  adapter,
  getLane,
}: {
  adapter: Any
  getLane: (adapter: object) => DriverLane | undefined
}) => {
  const fuseRunMongo = (loadCoreRuntimeAddon() as FuseAddon).fuseRunMongo
  if (typeof fuseRunMongo !== 'function') {
    return
  }
  const methods = { count: adapter.count, find: adapter.find, findOne: adapter.findOne }
  const lookup: FusedTargetLookup = (current: Any) => {
    if (
      current.find !== methods.find ||
      current.findOne !== methods.findOne ||
      current.count !== methods.count
    ) {
      return 'mongo:adapter-methods'
    }
    const lane = getLane(current)
    if (!lane) {
      return 'mongo:no-client'
    }
    if (isTracing()) {
      return 'mongo:trace'
    }
    if (verifyMode() !== 'off') {
      return 'mongo:verify'
    }
    const blocked = mongooseBlocksLane(lane, lane.mongoose)
    if (blocked) {
      return `mongo:${blocked}`
    }
    if (lane.paginate.options !== undefined) {
      return 'mongo:paginate-options'
    }
    const target: FusedTarget = {
      backend: 'mongodb',
      encode: (method, args) => encode(lane, method, args),
      relatedBackend: (slug, args) => relatedBackend(lane, slug, args),
      run: (requestJson, payload) => {
        const { bytes, client, plan } = payload as MongoPayload
        return fuseRunMongo(client, plan, requestJson, bytes)
      },
      shadowExact: (payload, exact, report) =>
        shadowExact(lane, (payload as MongoPayload).reads, exact, report),
    }
    return target
  }
  registerFusedTarget(adapter, lookup)
}

const emptyDb = '{"objects":[],"root":null}'

/**
 * The reads of `payload.db[method](args)` as the driver lane would send them, or why the call
 * cannot be fused.
 */
const encode = (
  lane: DriverLane,
  method: 'count' | 'find' | 'findOne',
  args: Any,
): { db: string; payload: MongoPayload } | string => {
  try {
    mongooseTypes = lane.mongoose.Types
    const reads =
      method === 'find'
        ? findReads(lane, args)
        : method === 'findOne'
          ? findOneReads(lane, args)
          : countReads(lane, args)
    const { plan, ...rest } = reads
    if (lane.view.allowAdditionalKeys) {
      rest.allowAdditionalKeys = true
    }
    return {
      db: emptyDb,
      payload: {
        bytes: lane.BSON.serialize(rest, { ignoreUndefined: false }),
        client: lane.clientID,
        plan,
        reads: rest,
      },
    }
  } catch (error) {
    if (error instanceof Unsupported) {
      return `mongo:${error.message}`
    }
    if (error instanceof Fallback) {
      return `mongo:${error.reason}`
    }
    return 'mongo:error'
  }
}

/** The model of `collectionSlug` if the driver lane would serve it, and its transform plan. */
const entity = (lane: DriverLane, collectionSlug: string) => {
  const adapter = lane.view
  const { collectionConfig, Model } = getCollection({ adapter, collectionSlug })
  if (!isPristineModel(lane, Model)) {
    unsupported('model')
  }
  const plan = planFor(
    lane,
    'collection',
    collectionConfig,
    adapter.payload.config,
    () => collectionConfig.fields,
  )
  if (
    Object.keys(collectionConfig.joins ?? {}).length ||
    collectionConfig.polymorphicJoins?.length
  ) {
    // `buildJoinAggregation` would add stages
    unsupported('joins')
  }
  return { adapter, collectionConfig, Model, plan }
}

/**
 * A nested find of relationship population on collection `slug` (`payload.db.find` with
 * `pagination: false`, `limit: 0`, `where: { and: [{ id: { in: ids } }] }`): the reads the driver
 * lane would send, but the filter (built natively from the ids: `{ $and: [{ _id: { $in } }] }`).
 */
const relatedBackend = (
  lane: DriverLane,
  slug: string,
  { locale, select, sort: sortArg }: { locale: Any; select: Any; sort: Any },
): { backend: unknown } | string => {
  try {
    mongooseTypes = lane.mongoose.Types
    const { adapter, collectionConfig, Model, plan } = entity(lane, slug)
    if (adapter.payload.collections[slug]?.customIDType) {
      return 'mongo:populate:custom-id'
    }
    if (adapter.collation) {
      return 'mongo:populate:collation'
    }
    const sortAggregation: Any[] = []
    const sort = buildSortParam({
      adapter,
      config: adapter.payload.config,
      fields: collectionConfig.flattenedFields,
      locale,
      sort: sortArg || collectionConfig.defaultSort,
      sortAggregation,
      timestamps: collectionConfig.timestamps || false,
    })
    if (sortAggregation.length > 0) {
      return 'mongo:sort:aggregation'
    }
    const projection = select
      ? buildProjectionFromSelect({
          adapter,
          fields: collectionConfig.flattenedFields,
          select,
        })
      : undefined
    return {
      backend: {
        collection: Model.collection.collectionName,
        plan,
        projection: projectionForExec(Model, 'find', projection) ?? null,
        sort: castSort(sort),
      },
    }
  } catch (error) {
    if (error instanceof Unsupported) {
      return `mongo:${error.message}`
    }
    if (error instanceof Fallback) {
      return `mongo:${error.reason}`
    }
    return 'mongo:error'
  }
}

/** db-mongodb `find` up to `Model.paginate`, then mongoose-paginate-v2 up to its queries. */
const findReads = (lane: DriverLane, args: Any): { plan: number } & Record<string, unknown> => {
  const {
    collection: collectionSlug,
    joins = {},
    limit = 0,
    locale,
    page,
    pagination,
    projection,
    select,
    sort: sortArg,
    where = {},
  } = args
  const { adapter, collectionConfig, Model, plan } = entity(lane, collectionSlug)
  if (!adapter.useJoinAggregations && joins && Object.keys(joins).length > 0) {
    unsupported('resolveJoins')
  }
  if (projection !== undefined) {
    unsupported('projection')
  }
  if (hasNear(where)) {
    unsupported('near')
  }
  const sortAggregation: Any[] = []
  const sort = buildSortParam({
    adapter,
    config: adapter.payload.config,
    fields: collectionConfig.flattenedFields,
    locale,
    sort: sortArg || collectionConfig.defaultSort,
    sortAggregation,
    timestamps: collectionConfig.timestamps || false,
  })
  if (sortAggregation.length > 0) {
    unsupported('sort:aggregation')
  }
  const query = buildFilter({
    adapter,
    collectionSlug,
    fields: collectionConfig.flattenedFields,
    locale,
    where,
  })
  const useEstimatedCount = !query || Object.keys(query).length === 0
  const paginationOptions: Any = {
    lean: true,
    leanWithId: true,
    options: { session: undefined },
    page,
    pagination,
    projection,
    sort,
    useEstimatedCount,
  }
  if (select) {
    paginationOptions.projection = buildProjectionFromSelect({
      adapter,
      fields: collectionConfig.flattenedFields,
      select,
    })
  }
  if (adapter.collation) {
    paginationOptions.collation = localeCollation(adapter, locale)
  }
  const customCount = customCountOptions(
    adapter,
    query,
    useEstimatedCount,
    paginationOptions.collation,
  )
  if (customCount) {
    paginationOptions.customCount = customCount
  }
  if (limit >= 0) {
    paginationOptions.limit = limit
    paginationOptions.options.limit = limit
    if (limit === 0) {
      paginationOptions.pagination = false
    }
  }
  return { ...paginateReads(Model, query, paginationOptions), plan }
}

/** mongoose-paginate-v2 `paginate(query, options)` (src/index.js) up to its two queries. */
const paginateReads = (Model: Any, incomingQuery: Any, paginationOptions: Any) => {
  const options = {
    collation: {},
    lean: false,
    leanWithId: true,
    limit: 10,
    options: {} as Any,
    pagination: true,
    projection: {},
    select: '',
    useCustomCountFn: false,
    useEstimatedCount: false,
    ...paginationOptions,
  }
  const query = incomingQuery || {}
  const { collation, lean, leanWithId, pagination, projection, select, sort, useEstimatedCount } =
    options
  if (!lean || !leanWithId) {
    unsupported('paginate:lean')
  }
  if (select !== '') {
    unsupported('paginate:select')
  }
  let limit = 10
  if (pagination && !isNaN(Number(options.limit))) {
    limit = parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 0
  }
  const findOptions = options.options
  const queryOptions =
    Object.keys(collation).length > 0 ? { ...findOptions, collation } : findOptions
  const { limit: _limit, skip: _skip, ...countOptions } = queryOptions || {}
  let page = parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1
  const skip = (page - 1) * limit
  if (!pagination) {
    page = 1
  }

  let count: unknown = null
  if (pagination) {
    if (useEstimatedCount === true) {
      count = 'estimated'
    } else if (paginationOptions.customCount) {
      count = countSpec(Model, query, paginationOptions.customCount)
    } else if (!query || Object.keys(query).length === 0) {
      count = 'estimated'
    } else {
      count = countSpec(Model, query, countOptions)
    }
  }

  let find: unknown = null
  if (limit) {
    // `Model.find(query, projection, queryOptions).select(select).sort(sort).lean(lean)`, then
    // `.skip(skip).limit(limit)` when paginating: the options mongoose executes with
    const spec: Record<string, unknown> = { filter: castFilter(Model.schema, query) }
    const queryLimit = pagination ? limit : queryOptions.limit
    const querySkip = pagination ? skip : queryOptions.skip
    if (queryOptions.collation !== undefined) {
      spec.collation = queryOptions.collation
    }
    if (queryLimit !== undefined) {
      spec.limit = queryLimit
    }
    const execProjection = projectionForExec(Model, 'find', projection)
    if (execProjection !== undefined) {
      spec.projection = execProjection
    }
    if (querySkip !== undefined) {
      spec.skip = querySkip
    }
    if (sort !== undefined) {
      spec.sort = castSort(sort)
    }
    find = spec
  }
  const reads: Record<string, unknown> = {
    collection: Model.collection.collectionName,
    find,
    meta: { limit, page, pagination: Boolean(pagination) },
    op: 'find',
  }
  if (count !== null) {
    reads.count = count
  }
  return reads
}

/** `Model.countDocuments(query, options)`: the cast filter and the options the driver gets. */
const countSpec = (Model: Any, query: Any, options: Any) => {
  for (const key of Object.keys(options)) {
    if (key !== 'collation' && key !== 'hint' && key !== 'session') {
      unsupported(`count option ${key}`)
    }
  }
  const spec: Record<string, unknown> = { filter: castFilter(Model.schema, query) }
  if (options.hint !== undefined) {
    spec.hint = options.hint
  }
  if (options.collation !== undefined) {
    spec.collation = options.collation
  }
  return spec
}

/** db-mongodb `findOne`, then `Model.findOne(query, {}, { lean, session, projection })`. */
const findOneReads = (lane: DriverLane, args: Any): { plan: number } & Record<string, unknown> => {
  const { collection: collectionSlug, joins, locale, select, where = {} } = args
  const { adapter, collectionConfig, Model, plan } = entity(lane, collectionSlug)
  if (!adapter.useJoinAggregations && joins && Object.keys(joins).length > 0) {
    unsupported('resolveJoins')
  }
  const query = buildFilter({
    adapter,
    collectionSlug,
    fields: collectionConfig.flattenedFields,
    locale,
    where,
  })
  const projection = buildProjectionFromSelect({
    adapter,
    fields: collectionConfig.flattenedFields,
    select,
  })
  const find: Record<string, unknown> = { filter: castFilter(Model.schema, query) }
  const execProjection = projectionForExec(Model, 'findOne', projection)
  if (execProjection !== undefined) {
    find.projection = execProjection
  }
  return { collection: Model.collection.collectionName, find, op: 'findOne', plan }
}

/** db-mongodb `count` (the driver lane's `laneCount`). */
const countReads = (lane: DriverLane, args: Any): { plan: number } & Record<string, unknown> => {
  const { collection: collectionSlug, locale, where = {} } = args
  const { adapter, collectionConfig, Model, plan } = entity(lane, collectionSlug)
  if (hasNear(where)) {
    unsupported('near')
  }
  const query = buildFilter({
    adapter,
    collectionSlug,
    fields: collectionConfig.flattenedFields,
    locale,
    where,
  })
  const useEstimatedCount = !query || Object.keys(query).length === 0
  let count: unknown
  if (useEstimatedCount) {
    count = 'estimated'
  } else {
    const options: Any = { session: undefined }
    if (adapter.collation) {
      options.collation = localeCollation(adapter, locale)
    }
    count = countSpec(Model, query, options)
  }
  return { collection: Model.collection.collectionName, count, op: 'count', plan }
}

// ---------------------------------------------------------------------------------------------
// `buildQuery` (db-mongodb queries/parseParams.ts, buildAndOrConditions.ts, buildSearchParams.ts)

const buildFilter = ({
  adapter,
  collectionSlug,
  fields,
  locale,
  where,
}: {
  adapter: Any
  collectionSlug: string
  fields: Any[]
  locale: Any
  where: Any
}) =>
  parseParams({
    collectionSlug,
    fields,
    locale,
    parentIsLocalized: false,
    payload: adapter.payload,
    where,
  })

type ParseArgs = {
  collectionSlug: string
  fields: Any[]
  locale: Any
  parentIsLocalized: boolean
  payload: Any
  where: Any
}

const parseParams = ({ where, ...rest }: ParseArgs): Record<string, unknown> => {
  let result: Any = {}
  if (typeof where === 'object') {
    if (where === null) {
      unsupported('where:null')
    }
    for (const relationOrPath of Object.keys(where)) {
      const condition = where[relationOrPath]
      let conditionOperator: '$and' | '$or' | null = null
      if (relationOrPath.toLowerCase() === 'and') {
        conditionOperator = '$and'
      } else if (relationOrPath.toLowerCase() === 'or') {
        conditionOperator = '$or'
      }
      if (Array.isArray(condition)) {
        const builtConditions: Record<string, unknown>[] = []
        for (const item of condition) {
          if (typeof item === 'object') {
            const built = parseParams({ ...rest, where: item })
            if (Object.keys(built).length > 0) {
              builtConditions.push(built)
            }
          }
        }
        if (builtConditions.length > 0 && conditionOperator !== null) {
          result[conditionOperator] = builtConditions
        }
      } else {
        const pathOperators = where[relationOrPath]
        if (typeof pathOperators === 'object') {
          if (pathOperators === null) {
            unsupported('where:null')
          }
          const validOperators = Object.keys(pathOperators).filter((operator) =>
            validOperatorSet.has(operator as never),
          )
          for (const operator of validOperators) {
            const searchParam = buildSearchParam({
              ...rest,
              incomingPath: relationOrPath,
              operator,
              val: pathOperators[operator],
            })
            if (searchParam?.value && searchParam?.path) {
              if (validOperators.length > 1) {
                if (!result.$and) {
                  result.$and = []
                }
                result.$and.push({ [searchParam.path]: searchParam.value })
              } else if (result[searchParam.path]) {
                if (!result.$and) {
                  result.$and = []
                }
                result.$and.push({ [searchParam.path]: result[searchParam.path] })
                result.$and.push({ [searchParam.path]: searchParam.value })
                delete result[searchParam.path]
              } else {
                result[searchParam.path] = searchParam.value
              }
            } else if (typeof searchParam?.value === 'object') {
              result = deepMergeWithCombinedArrays(result, searchParam.value ?? {}, {
                clone: false,
              })
            }
          }
        }
      }
    }
  }
  return result
}

const operatorMap: Record<string, string> = {
  all: '$all',
  equals: '$eq',
  exists: '$exists',
  greater_than: '$gt',
  greater_than_equal: '$gte',
  in: '$in',
  intersects: '$geoIntersects',
  less_than: '$lt',
  less_than_equal: '$lte',
  near: '$near',
  not_equals: '$ne',
  not_in: '$nin',
  within: '$geoWithin',
}

/** Values the port hands to upstream's sanitizer: scalars, dates, arrays of them. */
const isPlainValue = (value: unknown, depth = 0): boolean =>
  value === undefined ||
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean' ||
  value instanceof Date ||
  (depth === 0 &&
    Array.isArray(value) &&
    Object.getPrototypeOf(value) === Array.prototype &&
    value.every((item) => isPlainValue(item, 1)))

const objectIDPattern = /^[0-9a-f]{24}$/i

const buildSearchParam = ({
  collectionSlug,
  fields,
  incomingPath,
  locale,
  operator,
  parentIsLocalized,
  payload,
  val,
}: { incomingPath: string; operator: string; val: unknown } & Omit<ParseArgs, 'where'>):
  | { path?: string; value?: Any }
  | undefined => {
  if (!isPlainValue(val)) {
    // nested relationship queries (sub-queries) and objects the sanitizer inspects
    unsupported('where:value')
  }
  if (['all', 'intersects', 'near', 'not_like', 'within'].includes(operator)) {
    unsupported(`where:${operator}`)
  }
  let sanitizedPath = incomingPath.replace(/__/g, '.')
  if (sanitizedPath === 'id') {
    sanitizedPath = '_id'
  }
  let paths: Any[] = []
  let hasCustomID = false
  if (sanitizedPath === '_id') {
    const customIDFieldType = collectionSlug
      ? payload.collections[collectionSlug]?.customIDType
      : undefined
    let idFieldType = 'text'
    if (customIDFieldType) {
      idFieldType = customIDFieldType
      hasCustomID = true
    }
    paths.push({
      collectionSlug,
      complete: true,
      field: { name: 'id', type: idFieldType },
      parentIsLocalized: parentIsLocalized ?? false,
      path: '_id',
    })
  } else {
    paths = getLocalizedPaths({
      collectionSlug,
      fields,
      incomingPath: sanitizedPath,
      locale,
      parentIsLocalized,
      payload,
    })
  }
  if (!paths[0]) {
    return undefined
  }
  if (paths.length > 1) {
    // a relationship / join hop: sub-queries
    unsupported('where:relationship-path')
  }
  const [{ field, path }] = paths
  if (field.type === 'join') {
    unsupported('where:join')
  }
  if (!path) {
    return undefined
  }
  const sanitizedQueryValue = sanitizeQueryValue({
    field,
    hasCustomID,
    locale,
    operator: operator as never,
    parentIsLocalized,
    path,
    payload,
    val,
  })
  if (!sanitizedQueryValue) {
    return undefined
  }
  const { operator: formattedOperator, rawQuery, val: formattedValue } = sanitizedQueryValue as Any
  if (rawQuery) {
    return { value: rawQuery }
  }
  if (!formattedOperator) {
    return undefined
  }
  if (!validOperatorSet.has(formattedOperator)) {
    return undefined
  }
  const operatorKey = operatorMap[formattedOperator]
  if (field.type === 'relationship' || field.type === 'upload') {
    let hasNumberIDRelation
    let multiIDCondition = '$or'
    if (operatorKey === '$ne') {
      multiIDCondition = '$and'
    }
    const result: Any = {
      value: {
        [multiIDCondition]: [{ [path]: { [operatorKey!]: formattedValue } }],
      },
    }
    if (typeof formattedValue === 'string') {
      if (isValidObjectID(formattedValue)) {
        result.value[multiIDCondition]?.push({
          [path]: { [operatorKey!]: objectID(formattedValue) },
        })
      } else {
        ;(Array.isArray(field.relationTo) ? field.relationTo : [field.relationTo]).forEach(
          (relationTo: string) => {
            if (payload.collections[relationTo]?.customIDType === 'number') {
              hasNumberIDRelation = true
            }
          },
        )
        if (hasNumberIDRelation) {
          result.value[multiIDCondition]?.push({
            [path]: { [operatorKey!]: parseFloat(formattedValue) },
          })
        }
      }
    }
    const length = result.value[multiIDCondition]?.length
    if (typeof length === 'number' && length > 1) {
      return result
    }
  }
  if (formattedOperator === 'like' && typeof formattedValue === 'string') {
    const words = formattedValue.split(' ')
    return {
      value: {
        $and: words.map((word) => ({
          [path]: { $options: 'i', $regex: escapeRegExp(word) },
        })),
      },
    }
  }
  if (!operatorKey) {
    return { path, value: formattedValue }
  }
  return { path, value: { [operatorKey]: formattedValue } }
}

/** mongoose's `Types` (db-mongodb's copy, whose `ObjectId` `sanitizeQueryValue` builds ids with). */
let mongooseTypes: Any

const isValidObjectID = (value: string) => mongooseTypes.ObjectId.isValid(value)
const objectID = (value: string) => new mongooseTypes.ObjectId(value)

// ---------------------------------------------------------------------------------------------
// mongoose's casting (lib/cast.js and the schema types' `castForQuery`), for the identity cases

/**
 * `cast(schema, filter)` as `Query.prototype._castConditions` runs it, returning a new filter:
 * values whose casting is the identity (a string on a String path, a finite number on a Number
 * path, an ObjectId on an ObjectId path, a valid Date on a Date path, a boolean on a Boolean
 * path, `null` / `undefined`, anything on a Mixed path) are kept, 24-digit hex strings on ObjectId
 * paths become ObjectIds; every other case runs the exact lane.
 */
const castFilter = (schema: Any, filter: Any): Any => {
  const out: Any = {}
  for (const path of Object.keys(filter)) {
    const val = filter[path]
    if (path === '$or' || path === '$and' || path === '$nor') {
      if (!Array.isArray(val) || val.length === 0) {
        unsupported('cast:logical')
      }
      out[path] = val.map((item: Any) => {
        if (item === null || typeof item !== 'object' || Object.keys(item).length === 0) {
          unsupported('cast:logical')
        }
        return castFilter(schema, item)
      })
      continue
    }
    if (path.startsWith('$')) {
      unsupported(`cast:${path}`)
    }
    out[path] = castPath(schema, path, val)
  }
  return out
}

const castPath = (schema: Any, path: string, val: Any): Any => {
  let schematype = schema.path(path)
  if (!schematype) {
    const split = path.split('.')
    let j = split.length
    while (j--) {
      const prefix = schema.path(split.slice(0, j).join('.'))
      if (prefix?.schema?.discriminators != null) {
        unsupported('cast:discriminator')
      }
    }
    j = split.length
    while (j--) {
      schematype = schema.path(split.slice(0, j).join('.'))
      if (schematype) {
        break
      }
    }
    if (schematype) {
      if (schematype.schema) {
        return castPath(schematype.schema, split.slice(j).join('.'), val)
      }
      return val
    }
    if (schema.nested[path]) {
      return val
    }
    if (
      schema.options.strictQuery !== false ||
      schema._userProvidedOptions?.strictQuery !== undefined
    ) {
      unsupported('cast:strictQuery')
    }
    return val
  }
  if (val == null) {
    return val
  }
  if (isPOJO(val)) {
    const keys = Object.keys(val)
    if (!keys.some((key) => key.startsWith('$'))) {
      unsupported('cast:object')
    }
    const out: Any = {}
    for (const key of keys) {
      out[key] = castOperator(schematype, key, val[key])
    }
    return out
  }
  if (Array.isArray(val)) {
    unsupported('cast:array')
  }
  return castValue(schematype, val)
}

/** Per model and query kind: the projection mongoose executes with, per requested projection. */
const execProjections = new WeakMap<object, Map<string, { projection: unknown }>>()

/**
 * The projection mongoose executes a `find` / `findOne` with when it was given `projection`:
 * `_optionsForExec()` applies the schema-level projections (`helpers.applyPaths`: embedded
 * discriminator keys, `select: false` paths) and casts the fields. It depends on the projection
 * and the model's schema only, so mongoose computes it once per projection (a query that is never
 * executed); the options it would add besides (read concern / preference) make the call unfused.
 */
const projectionForExec = (Model: Any, kind: 'find' | 'findOne', projection: unknown) => {
  const key = `${kind}:${projection === undefined ? '' : JSON.stringify(projection)}`
  let byKey = execProjections.get(Model)
  if (!byKey) {
    byKey = new Map()
    execProjections.set(Model, byKey)
  }
  let known = byKey.get(key)
  if (!known) {
    const copy = projection === undefined ? undefined : { ...(projection as object) }
    const query =
      kind === 'find'
        ? Model.find({}, copy, {})
        : Model.findOne({}, {}, { lean: true, projection: copy, session: undefined })
    const options = query._optionsForExec()
    for (const optionKey of Object.keys(options)) {
      if (optionKey !== 'projection' && optionKey !== 'session') {
        unsupported(`query option ${optionKey}`)
      }
    }
    known = { projection: options.projection }
    if (byKey.size < 256) {
      byKey.set(key, known)
    }
  }
  return known.projection
}

const isPOJO = (value: unknown) =>
  typeof value === 'object' &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

const castOperator = (schematype: Any, operator: string, value: Any): Any => {
  switch (operator) {
    case '$eq':
    case '$gt':
    case '$gte':
    case '$lt':
    case '$lte':
    case '$ne':
      return value == null ? value : castValue(schematype, value)
    case '$exists':
      if (typeof value !== 'boolean') {
        unsupported('cast:$exists')
      }
      return value
    case '$in':
    case '$nin':
      if (!Array.isArray(value)) {
        unsupported(`cast:${operator}`)
      }
      return value.map((item: Any) => (item == null ? item : castValue(schematype, item)))
    case '$options':
    case '$regex':
      if (typeof value !== 'string' || !isStringType(schematype)) {
        unsupported(`cast:${operator}`)
      }
      return value
    default:
      return unsupported(`cast:${operator}`)
  }
}

const isStringType = (schematype: Any): boolean =>
  schematype.instance === 'String' ||
  schematype.instance === 'Mixed' ||
  (schematype.$isMongooseArray && schematype.caster?.instance === 'String')

/** `schematype.castForQuery(null, value)` for a value that is not `null`. */
const castValue = (schematype: Any, value: Any): Any => {
  if (schematype.$isMongooseArray && !schematype.schema) {
    // a primitive array: its caster's cast
    return castValue(schematype.caster, value)
  }
  // `applySetters` runs the setters first; `resetId` (mongoose's `_id` setter) returns query values
  // as they are
  if (schematype.setters?.some((setter: Any) => setter.name !== 'resetId')) {
    unsupported('cast:setters')
  }
  switch (schematype.instance) {
    case 'Boolean':
      if (typeof value === 'boolean') {
        return value
      }
      break
    case 'Date':
      if (value instanceof Date && !Number.isNaN(value.valueOf())) {
        return value
      }
      break
    case 'Mixed':
      return value
    case 'Number':
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value
      }
      break
    case 'ObjectId':
      if (value instanceof mongooseTypes.ObjectId) {
        return value
      }
      if (typeof value === 'string' && objectIDPattern.test(value)) {
        return objectID(value)
      }
      break
    case 'String':
      if (typeof value === 'string') {
        return value
      }
      break
  }
  return unsupported(`cast:${schematype.instance}`)
}

/** mongoose's `Query.prototype.sort(object)`: `asc` / `desc` to `1` / `-1`. */
const castSort = (sort: Any) => {
  if (!isPOJO(sort)) {
    unsupported('sort')
  }
  const out: Record<string, number> = {}
  for (const key of Object.keys(sort)) {
    const direction = sort[key]
    if (direction === 'asc' || direction === 1) {
      out[key] = 1
    } else if (direction === 'desc' || direction === -1) {
      out[key] = -1
    } else {
      unsupported('sort')
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Shadow mode: the fused reads against the driver operations of the exact lane

/**
 * Runs the exact lane with its driver operations traced (the driver lane reports the Node driver
 * calls its commands stand for) and compares them with `reads`: the same operations in the same
 * order, with the same filter, sort, projection, skip, limit, hint and collation (as js-bson
 * serializes them). Untraced exact runs (nothing reported) are not compared.
 */
const shadowExact = async <T>(
  lane: DriverLane,
  reads: Any,
  exact: () => Promise<T>,
  report: (difference: Record<string, unknown>) => void,
): Promise<T> => {
  if (isTracing()) {
    return exact()
  }
  const events: TraceEvent[] = []
  const result = await runTraced({ describe: (args) => args, events }, exact)
  const operations = events.filter((event) => 'op' in event && event.op !== 'aggregate')
  if (operations.length === 0) {
    return result
  }
  const expected = expectedOperations(reads)
  const serialize = (value: unknown) =>
    Buffer.from(lane.BSON.serialize({ value }, { ignoreUndefined: false })).toString('hex')
  // the operation's own reads come first (population's nested finds follow)
  const actual = operations.slice(0, expected.length).map((event) => {
    const { args, collection, op } = event as { args: Any[]; collection: unknown; op: string }
    return { collection, op, spec: serialize(operationSpec(op, args)) }
  })
  const wanted = expected.map(({ op, spec }) => ({
    collection: reads.collection,
    op,
    spec: serialize(spec),
  }))
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    report({
      exact: JSON.stringify(operations.map((event) => describeEvent(lane, event))),
      fused: JSON.stringify(
        expected.map(({ op, spec }) => ({ op, spec: lane.BSON.EJSON.stringify(spec) })),
      ),
      kind: 'mongo-commands',
    })
  }
  return result
}

const describeEvent = (lane: DriverLane, event: TraceEvent) => {
  const { args, op } = event as { args: Any[]; op: string }
  return { op, spec: lane.BSON.EJSON.stringify(operationSpec(op, args)) }
}

/** The compared parts of a traced driver call (`Collection` method arguments). */
const operationSpec = (op: string, args: Any[]) => {
  const [filter, options = {}] = op === 'estimatedDocumentCount' ? [undefined, args[0]] : args
  const spec: Record<string, unknown> = {}
  if (filter !== undefined) {
    spec.filter = filter
  }
  for (const key of ['collation', 'hint', 'limit', 'projection', 'skip', 'sort']) {
    if (options?.[key] !== undefined) {
      spec[key] = options[key]
    }
  }
  return spec
}

/** The driver calls the fused reads stand for, in the driver lane's trace order. */
const expectedOperations = (reads: Any) => {
  const out: { op: string; spec: Record<string, unknown> }[] = []
  const count = reads.count
  if (count === 'estimated') {
    out.push({ op: 'estimatedDocumentCount', spec: {} })
  } else if (count) {
    const spec: Record<string, unknown> = { filter: count.filter }
    if (count.collation !== undefined) {
      spec.collation = count.collation
    }
    if (count.hint !== undefined) {
      spec.hint = count.hint
    }
    out.push({ op: 'countDocuments', spec })
  }
  if (reads.find) {
    const { filter, ...options } = reads.find
    const spec: Record<string, unknown> = { filter }
    for (const key of ['collation', 'hint', 'limit', 'projection', 'skip', 'sort']) {
      if (options[key] !== undefined) {
        spec[key] = options[key]
      }
    }
    out.push({ op: reads.op === 'findOne' ? 'findOne' : 'find', spec })
    if (reads.op === 'findOne') {
      // the driver's `findOne` is a `find` with `limit: 1` / `singleBatch` (both traced)
      out.push({ op: 'find', spec })
    }
  }
  return out
}
