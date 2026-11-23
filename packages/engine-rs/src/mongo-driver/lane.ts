/**
 * The read methods of the driver lane (MONGO_DRIVER_CONTRACT.md "Read methods"): each is
 * upstream's db-mongodb method (packages/db-mongodb/src/<method>.ts) statement by statement, with
 * upstream's own query planning (`buildQuery`, `buildSortParam`, `buildProjectionFromSelect`,
 * `buildJoinAggregation`, ...) and mongoose's own casting (the very `Query` mongoose-paginate-v2 /
 * the method would build, cast with `_castConditions` and read with `_optionsForExec`), and with
 * the I/O step (`Model.paginate` / `Model.findOne` / `Model.countDocuments` /
 * `Model.estimatedDocumentCount`) plus the read `transform` served by the Rust driver: the
 * transformed documents come back as JSON text and are materialized with one `JSON.parse`.
 *
 * A call stays on the mongoose lane (the live engine's method, `fallback`) when:
 *
 * - it runs inside a transaction (`req.transactionID`: sessions belong to mongoose),
 * - the model is not pristine (a spied / replaced `paginate`, `find`, `findOne`, `countDocuments`,
 *   `estimatedDocumentCount` or `aggregate`, query middleware, patched collection methods),
 * - mongoose would apply something the lane does not reproduce (debug mode, global `maxTimeMS` /
 *   `allowDiskUse`, a `transactionAsyncLocalStorage` session, options beyond the known keys, a cast
 *   error: mongoose throws it),
 * - the entity's transform plan is ineligible, or the method needs joins (aggregation pipelines,
 *   `resolveJoins`) or a `$near` sort the lane does not run yet,
 * - the driver bails on a document (a value `JSON.parse` cannot carry, malformed data) or fails
 *   (server error, network): the read is re-run on the mongoose lane, which produces upstream's
 *   result or error (reads are idempotent).
 */
import { buildQuery } from '../../../db-mongodb/src/queries/buildQuery.js'
import { buildSortParam } from '../../../db-mongodb/src/queries/buildSortParam.js'
import { buildJoinAggregation } from '../../../db-mongodb/src/utilities/buildJoinAggregation.js'
import { buildProjectionFromSelect } from '../../../db-mongodb/src/utilities/buildProjectionFromSelect.js'
import { getCollection, getGlobal } from '../../../db-mongodb/src/utilities/getEntity.js'
import { getSession } from '../../../db-mongodb/src/utilities/getSession.js'
import { combineQueries } from '../../../payload/src/database/combineQueries.js'
import { flattenWhereToOperators } from '../../../payload/src/database/flattenWhereToOperators.js'
import { flattenAllFields } from '../../../payload/src/utilities/flattenAllFields.js'
import { buildVersionCollectionFields } from '../../../payload/src/versions/buildCollectionFields.js'
import { buildVersionGlobalFields } from '../../../payload/src/versions/buildGlobalFields.js'
import { isTracing, traceDriverOperation } from '../shadow-mongo/trace.js'
import { type DriverBinding } from './binding.js'
import { buildTransformPlan } from './plan.js'
import { verifyMode, verifyResult } from './verify.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- mirrors untyped upstream code */
type Any = any

/** Lane state of one adapter (created by `connect`, MONGO_DRIVER_CONTRACT.md "Clients"). */
export type DriverLane = {
  binding: DriverBinding
  BSON: Any
  clientID: number
  mongoose: Any
  paginate: Any
  /** `entity key -> plan id | null`, per kind. */
  plans: Map<string, WeakMap<object, null | number>>
  /** The replica set the client's topology names (`null`: none, transactions off). */
  replicaSet: null | string
  /** The adapter for the lane's own calls of upstream helpers (lazy.ts `createAdapterView`). */
  view: Any
}

export type LaneMethod =
  | 'count'
  | 'countGlobalVersions'
  | 'countVersions'
  | 'find'
  | 'findGlobal'
  | 'findGlobalVersions'
  | 'findOne'
  | 'findVersions'
  | 'queryDrafts'

export const laneMethods: readonly LaneMethod[] = [
  'count',
  'countGlobalVersions',
  'countVersions',
  'find',
  'findGlobal',
  'findGlobalVersions',
  'findOne',
  'findVersions',
  'queryDrafts',
]

/** Per method: calls served by the driver, and calls handed to the mongoose lane per reason. */
export const laneStats = {
  fallback: {} as Record<string, Record<string, number>>,
  served: {} as Record<string, number>,
}

const fallbackTo = (method: string, reason: string) => {
  const reasons = (laneStats.fallback[method] ??= {})
  reasons[reason] = (reasons[reason] ?? 0) + 1
}

/** A call that must run on the mongoose lane. */
class Fallback extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

const queryModelMethods = [
  'aggregate',
  'countDocuments',
  'estimatedDocumentCount',
  'find',
  'findOne',
] as const
const collectionMethods = [
  'aggregate',
  'countDocuments',
  'estimatedDocumentCount',
  'find',
  'findOne',
]
const queryOps = ['countDocuments', 'estimatedDocumentCount', 'find', 'findOne']

const pristineModels = new WeakMap<object, { hooks: unknown; middleware: unknown }>()

const isEmptyKareem = (kareem: Any, names: readonly string[]) =>
  kareem == null ||
  names.every(
    (name) => !(kareem._pres?.get(name)?.length > 0) && !(kareem._posts?.get(name)?.length > 0),
  )

/**
 * Whether `Model` behaves like the model upstream's code would call: mongoose's own statics (no
 * own property shadows them: `vi.spyOn(Model, 'findOne')` defines one), mongoose-paginate-v2's
 * `paginate`, no query / aggregate middleware, no patched collection methods.
 */
const isPristineModel = (lane: DriverLane, Model: Any): boolean => {
  if (!Model || typeof Model !== 'function') {
    return false
  }
  const MongooseModel = lane.mongoose.Model
  for (const name of queryModelMethods) {
    if (Object.hasOwn(Model, name) || Model[name] !== MongooseModel[name]) {
      return false
    }
  }
  if (Object.hasOwn(Model, 'paginate') && Model.paginate !== lane.paginate) {
    return false
  }
  const collection = Model.collection
  if (!collection || collectionMethods.some((name) => Object.hasOwn(collection, name))) {
    return false
  }
  const middleware = Model.Query?.prototype?._queryMiddleware
  const hooks = Model.hooks
  const known = pristineModels.get(Model)
  if (known && known.hooks === hooks && known.middleware === middleware) {
    return true
  }
  if (!isEmptyKareem(middleware, queryOps) || !isEmptyKareem(hooks, ['aggregate', ...queryOps])) {
    return false
  }
  pristineModels.set(Model, { hooks, middleware })
  return true
}

/** mongoose settings the lane does not reproduce (checked per call: they can change at runtime). */
const mongooseBlocksLane = (lane: DriverLane, Model: Any): string | undefined => {
  const base = Model.base ?? lane.mongoose
  if (base.get?.('debug')) {
    return 'mongoose debug'
  }
  const dbOptions = Model.db?.options ?? {}
  const baseOptions = base.options ?? {}
  if (dbOptions.maxTimeMS != null || baseOptions.maxTimeMS != null) {
    return 'global maxTimeMS'
  }
  if (dbOptions.allowDiskUse != null || baseOptions.allowDiskUse != null) {
    return 'global allowDiskUse'
  }
  if (base.transactionAsyncLocalStorage?.getStore?.()?.session != null) {
    return 'transactionAsyncLocalStorage session'
  }
  return undefined
}

const findOptionKeys = new Set([
  'collation',
  'hint',
  'limit',
  'projection',
  'session',
  'skip',
  'sort',
])
const countOptionKeys = new Set(['collation', 'hint', 'session'])

/**
 * The filter and driver options mongoose would send for the query `mq` (what `_find` /
 * `_findOne` / `_countDocuments` / `_estimatedDocumentCount` pass to the collection).
 */
const castQuery = (mq: Any, allowed: Set<string>, isEstimated = false) => {
  if (!isEstimated) {
    mq._applyTranslateAliases()
    mq._castConditions()
  }
  if (mq.error() != null) {
    // mongoose throws the cast error; the mongoose lane reproduces it
    throw new Fallback('cast error')
  }
  const options = mq._optionsForExec()
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new Fallback(`query option ${key}`)
    }
  }
  if (options.session != null) {
    throw new Fallback('session')
  }
  return { filter: isEstimated ? undefined : mq._conditions, options }
}

const findSpec = ({ filter, options }: { filter: Any; options: Any }) => {
  const spec: Record<string, unknown> = { filter }
  for (const key of ['collation', 'hint', 'limit', 'projection', 'skip', 'sort']) {
    if (options[key] !== undefined) {
      spec[key] = options[key]
    }
  }
  return spec
}

const countSpec = ({ filter, options }: { filter: Any; options: Any }) => {
  const spec: Record<string, unknown> = { filter }
  if (options.hint !== undefined) {
    spec.hint = options.hint
  }
  if (options.collation !== undefined) {
    spec.collation = options.collation
  }
  return spec
}

/** The plan id of `fields` for `key` (an immutable config object), built once. */
const planFor = (
  lane: DriverLane,
  kind: string,
  key: object,
  config: Any,
  fields: () => Any[],
): number => {
  let plans = lane.plans.get(kind)
  if (!plans) {
    plans = new WeakMap()
    lane.plans.set(kind, plans)
  }
  let id = plans.get(key)
  if (id === undefined) {
    const raw = fields()
    const { plan } = buildTransformPlan({
      config,
      fields: raw,
      flattened: flattenAllFields({ cache: true, fields: raw }),
    })
    id = plan ? lane.binding.registerPlan(JSON.stringify(plan)) : null
    plans.set(key, id)
  }
  if (id === null) {
    throw new Fallback('ineligible transform plan')
  }
  return id
}

/**
 * The lane arguments as js-bson bytes, serialized like the Node driver serializes commands
 * (`ignoreUndefined: false`: an `undefined` value is sent as `null`, e.g. `{ $eq: undefined }`).
 */
const serializeArgs = (lane: DriverLane, args: Record<string, unknown>) =>
  lane.BSON.serialize(args, { ignoreUndefined: false })

/**
 * The Node driver `Collection` calls of a count (shadow / parity traces, `traceDriverOperation`):
 * `estimatedDocumentCount(options)`, or `countDocuments(filter, options)` and the `aggregate` it
 * runs (driver collection.js `countDocuments`).
 */
const traceCount = (collection: string, cast: Any) => {
  if (cast.filter === undefined) {
    traceDriverOperation(collection, 'estimatedDocumentCount', [cast.options])
    return
  }
  traceDriverOperation(collection, 'countDocuments', [cast.filter, cast.options])
  const pipeline: Any[] = [{ $match: cast.filter }]
  if (typeof cast.options.skip === 'number') {
    pipeline.push({ $skip: cast.options.skip })
  }
  if (typeof cast.options.limit === 'number') {
    pipeline.push({ $limit: cast.options.limit })
  }
  pipeline.push({ $group: { _id: 1, n: { $sum: 1 } } })
  traceDriverOperation(collection, 'aggregate', [pipeline, cast.options])
}

const outcome = (text: string) => {
  if (text.charCodeAt(0) === 33 /* ! */) {
    throw new Fallback(text.slice(1))
  }
  return JSON.parse(text)
}

const hasNear = (where: Any) => {
  if (!where) {
    return false
  }
  const constraints = flattenWhereToOperators(where)
  return constraints.some((prop: Any) => Object.keys(prop).some((key) => key === 'near'))
}

const localeCollation = (adapter: Any, locale: Any) => {
  const localizationConfig = adapter.payload.config.localization
  const defaultLocale =
    (typeof localizationConfig === 'object' && localizationConfig?.defaultLocale) || 'en'

  return {
    locale: locale && locale !== 'all' && locale !== '*' ? locale : defaultLocale,
    ...adapter.collation,
  }
}

/**
 * mongoose-paginate-v2's `paginate(query, options)` (src/index.js) for the options db-mongodb
 * builds: the count and find queries it would create (cast by mongoose), run by the driver
 * (count first, both in flight), `leanWithId`, transform, and its result object.
 */
const lanePaginate = async (
  lane: DriverLane,
  Model: Any,
  query: Any,
  paginationOptions: Any,
  plan: number,
  adapter: Any,
) => {
  if (lane.paginate.options !== undefined) {
    throw new Fallback('global paginate options')
  }
  const options = {
    collation: {},
    lean: false,
    leanWithId: true,
    limit: 10,
    options: {},
    pagination: true,
    projection: {},
    select: '',
    useCustomCountFn: false,
    useEstimatedCount: false,
    ...paginationOptions,
  }
  query = query || {}
  const { collation, lean, leanWithId, pagination, projection, select, sort, useEstimatedCount } =
    options
  if (!lean || !leanWithId) {
    throw new Fallback('paginate without lean')
  }

  let limit = 10
  if (pagination && !isNaN(Number(options.limit))) {
    limit = parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 0
  }
  const findOptions = options.options
  const queryOptions =
    Object.keys(collation).length > 0 ? { ...findOptions, collation } : findOptions
  const { limit: _l, skip: _s, ...countOptions } = queryOptions || {}

  let offset: number | undefined
  let page: Any
  let skip: number
  if (Object.hasOwn(options, 'offset')) {
    offset = parseInt(options.offset, 10)
    skip = offset
  } else if (Object.hasOwn(options, 'page')) {
    page = parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1
    skip = (page - 1) * limit
  } else {
    offset = 0
    page = 1
    skip = offset
  }
  if (!pagination) {
    page = 1
  }

  let count: Any = null
  let countCast: Any = null
  if (pagination) {
    if (useEstimatedCount === true) {
      countCast = castQuery(Model.estimatedDocumentCount(), countOptionKeys, true)
      count = 'estimated'
    } else if (paginationOptions.customCount) {
      countCast = castQuery(
        Model.countDocuments(query, paginationOptions.customCount),
        countOptionKeys,
      )
      count = countSpec(countCast)
    } else if (!query || Object.keys(query).length === 0) {
      countCast = castQuery(Model.estimatedDocumentCount(), countOptionKeys, true)
      count = 'estimated'
    } else {
      countCast = castQuery(Model.countDocuments(query, countOptions), countOptionKeys)
      count = countSpec(countCast)
    }
  }

  let find: Any = null
  let findCast: Any = null
  if (limit) {
    const mQuery = Model.find(query, projection, queryOptions)
    mQuery.select(select)
    mQuery.sort(sort)
    mQuery.lean(lean)
    if (pagination) {
      mQuery.skip(skip)
      mQuery.limit(limit)
    }
    findCast = castQuery(mQuery, findOptionKeys)
    find = findSpec(findCast)
  }

  const args: Record<string, unknown> = {
    collection: Model.collection.collectionName,
    find,
  }
  if (count !== null) {
    args.count = count
  }
  if (adapter.allowAdditionalKeys) {
    args.allowAdditionalKeys = true
  }
  const trace = isTracing()
  const [rawCount, docs] = outcome(
    await lane.binding.paginate(lane.clientID, plan, serializeArgs(lane, args)),
  )
  if (trace) {
    if (countCast) {
      traceCount(args.collection as string, countCast)
    }
    if (findCast) {
      traceDriverOperation(args.collection, 'find', [findCast.filter, findCast.options])
    }
  }

  const total = pagination !== true ? docs.length : rawCount
  const meta: Record<string, unknown> = { totalDocs: total }
  if (typeof offset !== 'undefined') {
    meta.offset = offset
    page = Math.ceil((offset + 1) / limit)
  }
  const pages = limit > 0 ? Math.ceil(total / limit) || 1 : null
  meta.limit = total
  meta.totalPages = 1
  meta.page = page
  meta.pagingCounter = (page - 1) * limit + 1
  meta.hasPrevPage = false
  meta.hasNextPage = false
  meta.prevPage = null
  meta.nextPage = null
  if (pagination) {
    meta.limit = limit
    meta.totalPages = pages
    if (page > 1) {
      meta.hasPrevPage = true
      meta.prevPage = page - 1
    } else if (page == 1 && typeof offset !== 'undefined' && offset !== 0) {
      meta.hasPrevPage = true
      meta.prevPage = 1
    }
    if (page < (pages as number)) {
      meta.hasNextPage = true
      meta.nextPage = page + 1
    }
  }
  delete meta['false']
  if (limit == 0) {
    meta.limit = 0
    meta.totalPages = 1
    meta.page = 1
    meta.pagingCounter = 1
    meta.prevPage = null
    meta.nextPage = null
    meta.hasPrevPage = false
    meta.hasNextPage = false
  }
  return { docs, ...meta }
}

/**
 * db-mongodb's `aggregatePaginate` (utilities/aggregatePaginate.ts): the pipeline it builds and the
 * count it starts, run by the driver (`Model.aggregate` first, both in flight), plus transform and
 * its result object. Aggregation pipelines are not cast by mongoose.
 */
const laneAggregatePaginate = async ({
  adapter,
  collation,
  joinAggregation,
  lane,
  limit,
  Model,
  page,
  pagination,
  plan,
  projection,
  query,
  sort,
  sortAggregation,
  useEstimatedCount,
}: {
  adapter: Any
  collation?: Any
  joinAggregation?: Any[]
  lane: DriverLane
  limit?: number
  Model: Any
  page?: number
  pagination?: boolean
  plan: number
  projection?: Any
  query: Any
  sort?: Any
  sortAggregation?: Any[]
  useEstimatedCount?: boolean
}) => {
  const aggregation: Any[] = [{ $match: query }]
  if (sortAggregation && sortAggregation.length > 0) {
    for (const stage of sortAggregation) {
      aggregation.push(stage)
    }
  }
  if (sort) {
    const $sort: Record<string, -1 | 1> = {}
    Object.entries(sort).forEach(([key, value]) => {
      $sort[key] = value === 'desc' ? -1 : 1
    })
    aggregation.push({ $sort })
  }
  if (page) {
    aggregation.push({ $skip: (page - 1) * (limit ?? 0) })
  }
  if (limit) {
    aggregation.push({ $limit: limit })
  }
  if (joinAggregation) {
    for (const stage of joinAggregation) {
      aggregation.push(stage)
    }
  }
  if (projection) {
    aggregation.push({ $project: projection })
  }

  let count: Any = null
  let countCast: Any = null
  if (pagination !== false && limit) {
    if (useEstimatedCount) {
      // upstream passes the query as the options of `estimatedDocumentCount`
      countCast = castQuery(Model.estimatedDocumentCount(query), countOptionKeys, true)
      count = 'estimated'
    } else {
      const hint =
        adapter.disableIndexHints !== true && Object.keys(query).length === 0
          ? { _id: 1 }
          : undefined
      countCast = castQuery(
        Model.countDocuments(query, { collation, session: undefined, ...(hint ? { hint } : {}) }),
        countOptionKeys,
      )
      count = countSpec(countCast)
    }
  }

  if (Model.schema?.discriminatorMapping || Model.discriminators) {
    // mongoose's `prepareDiscriminatorPipeline` would add a stage
    throw new Fallback('aggregate on a discriminator model')
  }
  const args: Record<string, unknown> = {
    collection: Model.collection.collectionName,
    pipeline: aggregation,
  }
  if (collation !== undefined) {
    args.collation = collation
  }
  if (count !== null) {
    args.count = count
  }
  if (adapter.allowAdditionalKeys) {
    args.allowAdditionalKeys = true
  }
  const trace = isTracing()
  const [countResult, docs] = outcome(
    await lane.binding.aggregate(lane.clientID, plan, serializeArgs(lane, args)),
  )
  if (trace) {
    traceDriverOperation(args.collection, 'aggregate', [
      aggregation,
      { collation, session: undefined },
    ])
    if (countCast) {
      traceCount(args.collection as string, countCast)
    }
  }

  const total = countResult === null ? docs.length : countResult
  const totalPages =
    pagination !== false && typeof limit === 'number' && limit !== 0 ? Math.ceil(total / limit) : 1
  const hasPrevPage = typeof page === 'number' && pagination !== false && page > 1
  const hasNextPage = typeof page === 'number' && pagination !== false && totalPages > page
  const pagingCounter =
    typeof page === 'number' && pagination !== false && typeof limit === 'number'
      ? (page - 1) * limit + 1
      : 1

  return {
    docs,
    hasNextPage,
    hasPrevPage,
    limit: limit ?? 0,
    nextPage: hasNextPage ? (page as number) + 1 : null,
    page,
    pagingCounter,
    prevPage: hasPrevPage ? (page as number) - 1 : null,
    totalDocs: total,
    totalPages,
  }
}

/**
 * The `paginationOptions` count part of find / findVersions / findGlobalVersions:
 * `useCustomCountFn` becomes `customCount` (the options of its `Model.countDocuments` call).
 */
const customCountOptions = (
  adapter: Any,
  query: Any,
  useEstimatedCount: boolean,
  collation: Any,
) => {
  if (!useEstimatedCount && Object.keys(query).length === 0 && adapter.disableIndexHints !== true) {
    return { collation, hint: { _id: 1 }, session: undefined }
  }
  if (!useEstimatedCount && adapter.collation) {
    return { collation, session: undefined }
  }
  return undefined
}

const find = async function find(this: Any, lane: DriverLane, args: Any) {
  const {
    collection: collectionSlug,
    draftsEnabled,
    joins = {},
    limit = 0,
    locale,
    page,
    pagination,
    projection,
    req,
    select,
    sort: sortArg,
    where = {},
  } = args
  const { collectionConfig, Model } = getCollection({ adapter: this, collectionSlug })
  if (!isPristineModel(lane, Model)) {
    throw new Fallback('model not pristine')
  }
  if (!this.useJoinAggregations && joins && Object.keys(joins).length > 0) {
    throw new Fallback('resolveJoins')
  }
  const plan = planFor(
    lane,
    'collection',
    collectionConfig,
    this.payload.config,
    () => collectionConfig.fields,
  )

  const hasNearConstraint = hasNear(where)
  const sortAggregation: Any[] = []
  let sort
  if (!hasNearConstraint) {
    sort = buildSortParam({
      adapter: this,
      config: this.payload.config,
      fields: collectionConfig.flattenedFields,
      locale,
      sort: sortArg || collectionConfig.defaultSort,
      sortAggregation,
      timestamps: collectionConfig.timestamps || false,
    })
  }
  const query = await buildQuery({
    adapter: this,
    collectionSlug,
    fields: collectionConfig.flattenedFields,
    locale,
    where,
  })
  await getSession(this, req)

  const useEstimatedCount = hasNearConstraint || !query || Object.keys(query).length === 0
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
      adapter: this,
      fields: collectionConfig.flattenedFields,
      select,
    })
  }
  if (this.collation) {
    paginationOptions.collation = localeCollation(this, locale)
  }
  const customCount = customCountOptions(
    this,
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

  const aggregate = await buildJoinAggregation({
    adapter: this,
    collection: collectionSlug,
    collectionConfig,
    draftsEnabled,
    joins,
    locale,
    projection: paginationOptions.projection,
    query,
  })
  if (aggregate.length > 0 || sortAggregation.length > 0) {
    return laneAggregatePaginate({
      adapter: this,
      collation: paginationOptions.collation,
      joinAggregation: aggregate,
      lane,
      limit: paginationOptions.limit,
      Model,
      page: paginationOptions.page,
      pagination: paginationOptions.pagination,
      plan,
      projection: paginationOptions.projection,
      query,
      sort: paginationOptions.sort,
      sortAggregation,
      useEstimatedCount: paginationOptions.useEstimatedCount,
    })
  }
  return lanePaginate(lane, Model, query, paginationOptions, plan, this)
}

const findOne = async function findOne(this: Any, lane: DriverLane, args: Any) {
  const { collection: collectionSlug, draftsEnabled, joins, locale, req, select, where = {} } = args
  const { collectionConfig, Model } = getCollection({ adapter: this, collectionSlug })
  if (!isPristineModel(lane, Model)) {
    throw new Fallback('model not pristine')
  }
  if (!this.useJoinAggregations && joins && Object.keys(joins).length > 0) {
    throw new Fallback('resolveJoins')
  }
  const plan = planFor(
    lane,
    'collection',
    collectionConfig,
    this.payload.config,
    () => collectionConfig.fields,
  )

  const query = await buildQuery({
    adapter: this,
    collectionSlug,
    fields: collectionConfig.flattenedFields,
    locale,
    where,
  })
  const projection = buildProjectionFromSelect({
    adapter: this,
    fields: collectionConfig.flattenedFields,
    select,
  })
  const aggregate = await buildJoinAggregation({
    adapter: this,
    collection: collectionSlug,
    collectionConfig,
    draftsEnabled,
    joins,
    locale,
    projection,
    query,
  })
  await getSession(this, req)
  if (aggregate.length > 0) {
    const { docs } = await laneAggregatePaginate({
      adapter: this,
      joinAggregation: aggregate,
      lane,
      limit: 1,
      Model,
      pagination: false,
      plan,
      projection,
      query,
    })
    return docs[0] ?? null
  }
  const options: Any = { lean: true, session: undefined }
  options.projection = projection
  const cast = castQuery(Model.findOne(query, {}, options), findOptionKeys)
  return laneFindOne(lane, Model, cast, plan, this)
}

const laneFindOne = async (lane: DriverLane, Model: Any, cast: Any, plan: number, adapter: Any) => {
  const args: Record<string, unknown> = {
    collection: Model.collection.collectionName,
    find: findSpec(cast),
  }
  if (adapter.allowAdditionalKeys) {
    args.allowAdditionalKeys = true
  }
  const trace = isTracing()
  const result = outcome(await lane.binding.findOne(lane.clientID, plan, serializeArgs(lane, args)))
  if (trace) {
    traceDriverOperation(args.collection, 'findOne', [cast.filter, cast.options])
    traceDriverOperation(args.collection, 'find', [
      cast.filter,
      { ...cast.options, singleBatch: true },
    ])
  }
  return result
}

/** count / countVersions / countGlobalVersions after `buildQuery`. */
const laneCount = async ({
  adapter,
  hasNearConstraint,
  lane,
  locale,
  Model,
  query,
  req,
}: {
  adapter: Any
  hasNearConstraint: boolean
  lane: DriverLane
  locale: Any
  Model: Any
  query: Any
  req: Any
}) => {
  const useEstimatedCount = hasNearConstraint || !query || Object.keys(query).length === 0
  const options: Any = { session: await getSession(adapter, req) }
  if (adapter.collation) {
    options.collation = localeCollation(adapter, locale)
  }
  if (!useEstimatedCount && Object.keys(query).length === 0 && adapter.disableIndexHints !== true) {
    options.hint = { _id: 1 }
  }
  let count: Any
  let countCast: Any
  if (useEstimatedCount) {
    countCast = castQuery(
      Model.estimatedDocumentCount({ session: options.session }),
      countOptionKeys,
      true,
    )
    count = 'estimated'
  } else {
    countCast = castQuery(Model.countDocuments(query, options), countOptionKeys)
    count = countSpec(countCast)
  }
  const args = { collection: Model.collection.collectionName, count }
  if (isTracing()) {
    traceCount(args.collection, countCast)
  }
  const totalDocs = outcome(await lane.binding.count(lane.clientID, serializeArgs(lane, args)))
  return { totalDocs }
}

const count = async function count(this: Any, lane: DriverLane, args: Any) {
  const { collection: collectionSlug, locale, req, where = {} } = args
  const { collectionConfig, Model } = getCollection({ adapter: this, collectionSlug })
  if (!isPristineModel(lane, Model)) {
    throw new Fallback('model not pristine')
  }
  const hasNearConstraint = hasNear(where)
  const query = await buildQuery({
    adapter: this,
    collectionSlug,
    fields: collectionConfig.flattenedFields,
    locale,
    where,
  })
  return laneCount({ adapter: this, hasNearConstraint, lane, locale, Model, query, req })
}

const countVersions = async function countVersions(this: Any, lane: DriverLane, args: Any) {
  const { collection: collectionSlug, locale, req, where = {} } = args
  const { collectionConfig, Model } = getCollection({
    adapter: this,
    collectionSlug,
    versions: true,
  })
  if (!isPristineModel(lane, Model)) {
    throw new Fallback('model not pristine')
  }
  const hasNearConstraint = hasNear(where)
  const query = await buildQuery({
    adapter: this,
    fields: buildVersionCollectionFields(this.payload.config, collectionConfig, true),
    locale,
    where,
  })
  return laneCount({ adapter: this, hasNearConstraint, lane, locale, Model, query, req })
}

const countGlobalVersions = async function countGlobalVersions(
  this: Any,
  lane: DriverLane,
  args: Any,
) {
  const { global: globalSlug, locale, req, where = {} } = args
  const { globalConfig, Model } = getGlobal({ adapter: this, globalSlug, versions: true })
  if (!isPristineModel(lane, Model)) {
    throw new Fallback('model not pristine')
  }
  const hasNearConstraint = hasNear(where)
  const query = await buildQuery({
    adapter: this,
    fields: buildVersionGlobalFields(this.payload.config, globalConfig, true),
    locale,
    where,
  })
  return laneCount({ adapter: this, hasNearConstraint, lane, locale, Model, query, req })
}

/** findVersions / findGlobalVersions after the entity lookup. */
const laneFindVersions = async ({
  adapter,
  args,
  fields,
  lane,
  Model,
  plan,
}: {
  adapter: Any
  args: Any
  fields: Any[]
  lane: DriverLane
  Model: Any
  plan: number
}) => {
  const { limit = 0, locale, page, pagination, req, select, sort: sortArg, where = {} } = args
  const hasNearConstraint = hasNear(where)
  let sort
  if (!hasNearConstraint) {
    sort = buildSortParam({
      adapter,
      config: adapter.payload.config,
      fields,
      locale,
      sort: sortArg || '-updatedAt',
      timestamps: true,
    })
  }
  const query = await buildQuery({ adapter, fields, locale, where })
  await getSession(adapter, req)
  const skip = typeof page === 'number' && page > 1 ? (page - 1) * (limit || 0) : undefined
  const options: Any = { limit, session: undefined, skip }
  const useEstimatedCount = hasNearConstraint || !query || Object.keys(query).length === 0
  const paginationOptions: Any = {
    lean: true,
    leanWithId: true,
    limit,
    options,
    page,
    pagination,
    projection: buildProjectionFromSelect({ adapter, fields, select }),
    sort,
    useEstimatedCount,
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
  return lanePaginate(lane, Model, query, paginationOptions, plan, adapter)
}

const findVersions = async function findVersions(this: Any, lane: DriverLane, args: Any) {
  const { collectionConfig, Model } = getCollection({
    adapter: this,
    collectionSlug: args.collection,
    versions: true,
  })
  if (!isPristineModel(lane, Model)) {
    throw new Fallback('model not pristine')
  }
  const config = this.payload.config
  const plan = planFor(lane, 'versions', collectionConfig, config, () =>
    buildVersionCollectionFields(config, collectionConfig),
  )
  return laneFindVersions({
    adapter: this,
    args,
    fields: buildVersionCollectionFields(config, collectionConfig, true),
    lane,
    Model,
    plan,
  })
}

const findGlobalVersions = async function findGlobalVersions(
  this: Any,
  lane: DriverLane,
  args: Any,
) {
  const { globalConfig, Model } = getGlobal({
    adapter: this,
    globalSlug: args.global,
    versions: true,
  })
  if (!isPristineModel(lane, Model)) {
    throw new Fallback('model not pristine')
  }
  const config = this.payload.config
  const plan = planFor(lane, 'globalVersions', globalConfig, config, () =>
    buildVersionGlobalFields(config, globalConfig),
  )
  return laneFindVersions({
    adapter: this,
    args,
    fields: buildVersionGlobalFields(config, globalConfig, true),
    lane,
    Model,
    plan,
  })
}

const findGlobal = async function findGlobal(this: Any, lane: DriverLane, args: Any) {
  const { slug: globalSlug, locale, req, select, where = {} } = args
  const { globalConfig, Model } = getGlobal({ adapter: this, globalSlug })
  if (!isPristineModel(lane, Model)) {
    throw new Fallback('model not pristine')
  }
  const plan = planFor(lane, 'global', globalConfig, this.payload.config, () => globalConfig.fields)
  const fields = globalConfig.flattenedFields
  const query = await buildQuery({
    adapter: this,
    fields,
    globalSlug,
    locale,
    where: combineQueries({ globalType: { equals: globalSlug } }, where),
  })
  const options: Any = {
    lean: true,
    select: buildProjectionFromSelect({ adapter: this, fields, select }),
    session: await getSession(this, req),
  }
  const cast = castQuery(Model.findOne(query, {}, options), findOptionKeys)
  return laneFindOne(lane, Model, cast, plan, this)
}

const queryDrafts = async function queryDrafts(this: Any, lane: DriverLane, args: Any) {
  const {
    collection: collectionSlug,
    joins,
    limit,
    locale,
    page,
    pagination,
    req,
    select,
    sort: sortArg,
    where = {},
  } = args
  const { collectionConfig, Model } = getCollection({
    adapter: this,
    collectionSlug,
    versions: true,
  })
  if (!isPristineModel(lane, Model)) {
    throw new Fallback('model not pristine')
  }
  if (!this.useJoinAggregations && joins && Object.keys(joins).length > 0) {
    throw new Fallback('resolveJoins')
  }
  const config = this.payload.config
  const plan = planFor(lane, 'versions', collectionConfig, config, () =>
    buildVersionCollectionFields(config, collectionConfig),
  )

  let hasNearConstraint
  let sort
  if (where) {
    hasNearConstraint = hasNear(where)
  }
  const fields = buildVersionCollectionFields(config, collectionConfig, true)
  const sortAggregation: Any[] = []
  if (!hasNearConstraint) {
    sort = buildSortParam({
      adapter: this,
      config,
      fields,
      locale,
      sort: sortArg || collectionConfig.defaultSort,
      sortAggregation,
      timestamps: true,
      versions: true,
    })
  }
  const combinedWhere = combineQueries({ latest: { equals: true } }, where)
  const versionQuery = await buildQuery({ adapter: this, fields, locale, where: combinedWhere })
  const projection = buildProjectionFromSelect({ adapter: this, fields, select })
  await getSession(this, req)
  const options: Any = { session: undefined }
  const useEstimatedCount =
    hasNearConstraint || !versionQuery || Object.keys(versionQuery).length === 0
  const paginationOptions: Any = {
    lean: true,
    leanWithId: true,
    options,
    page,
    pagination,
    projection,
    sort,
    useEstimatedCount,
  }
  if (this.collation) {
    paginationOptions.collation = localeCollation(this, locale)
  }
  if (
    !useEstimatedCount &&
    Object.keys(versionQuery).length === 0 &&
    this.disableIndexHints !== true
  ) {
    paginationOptions.customCount = {
      collation: paginationOptions.collation,
      hint: { _id: 1 },
      session: undefined,
    }
  }
  if (limit && limit > 0) {
    paginationOptions.limit = limit
    paginationOptions.options.limit = limit
  }

  let result
  const aggregate = await buildJoinAggregation({
    adapter: this,
    collection: collectionSlug,
    collectionConfig,
    joins,
    locale,
    projection,
    query: versionQuery,
    versions: true,
  })
  if (aggregate.length > 0 || sortAggregation.length > 0) {
    result = await laneAggregatePaginate({
      adapter: this,
      collation: paginationOptions.collation,
      joinAggregation: aggregate,
      lane,
      limit: paginationOptions.limit,
      Model,
      page: paginationOptions.page,
      pagination: paginationOptions.pagination,
      plan,
      projection: paginationOptions.projection,
      query: versionQuery,
      sort: paginationOptions.sort,
      sortAggregation,
      useEstimatedCount: paginationOptions.useEstimatedCount,
    })
  } else {
    result = await lanePaginate(lane, Model, versionQuery, paginationOptions, plan, this)
  }
  for (let i = 0; i < result.docs.length; i++) {
    const id = result.docs[i].parent
    result.docs[i] = result.docs[i].version ?? {}
    result.docs[i].id = id
  }
  return result
}

const implementations: Record<
  LaneMethod,
  (this: Any, lane: DriverLane, args: Any) => Promise<Any>
> = {
  count,
  countGlobalVersions,
  countVersions,
  find,
  findGlobal,
  findGlobalVersions,
  findOne,
  findVersions,
  queryDrafts,
}

/**
 * The adapter method `method` on the driver lane: `lane(adapter)` gives the adapter's lane (or
 * `undefined`), `fallback` is the method of the mongoose lane (called with the same `this` and
 * arguments whenever the call cannot be served by the driver).
 */
export const createLaneMethod = ({
  fallback,
  lane: laneOf,
  method,
}: {
  fallback: (this: Any, args: Any) => Promise<Any>
  lane: (adapter: Any) => DriverLane | undefined
  method: LaneMethod
}) => {
  const implementation = implementations[method]
  return async function (this: Any, args: Any) {
    const lane = laneOf(this)
    if (!lane) {
      fallbackTo(method, 'no driver client')
      return fallback.call(this, args)
    }
    if (args?.req?.transactionID) {
      fallbackTo(method, 'transaction')
      return fallback.call(this, args)
    }
    const blocked = mongooseBlocksLane(lane, lane.mongoose)
    if (blocked) {
      fallbackTo(method, blocked)
      return fallback.call(this, args)
    }
    try {
      const result = await implementation.call(lane.view, lane, args)
      laneStats.served[method] = (laneStats.served[method] ?? 0) + 1
      if (verifyMode() !== 'off') {
        await verifyResult({
          lane: result,
          method,
          reference: await fallback.call(this, args),
          rerun: () => implementation.call(lane.view, lane, args),
        })
      }
      return result
    } catch (error) {
      if (error instanceof Fallback) {
        fallbackTo(method, error.reason.startsWith('driver:') ? 'driver error' : error.reason)
        return fallback.call(this, args)
      }
      throw error
    }
  }
}
