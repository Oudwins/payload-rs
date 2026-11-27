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
import { types } from 'node:util'

import type { Template } from './idTemplate.js'
import type { FusedTarget, FusedTargetLookup } from './targets.js'

import { buildSortParam } from '../../../db-mongodb/src/queries/buildSortParam.js'
import { sanitizeQueryValue } from '../../../db-mongodb/src/queries/sanitizeQueryValue.js'
import { buildProjectionFromSelect } from '../../../db-mongodb/src/utilities/buildProjectionFromSelect.js'
import { getCollection } from '../../../db-mongodb/src/utilities/getEntity.js'
import { getLocalizedPaths } from '../../../payload/src/database/getLocalizedPaths.js'
import { fieldShouldBeLocalized } from '../../../payload/src/fields/config/types.js'
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
import { installDriverTrace, isTracing, runTraced, type TraceEvent } from '../shadow-mongo/trace.js'
import { sentinelHex, toTemplate, withID } from './idTemplate.js'
import { isInertTree } from './inert.js'
import { recordDiff } from './stats.js'
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
      encode: (method, args, isWriteRead) => encode(lane, method, args, isWriteRead),
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
  isWriteRead: boolean,
): { db: string; payload: MongoPayload } | string => {
  const reused =
    (method === 'findOne' ? encodeByID(lane, args, isWriteRead) : undefined) ??
    encodeRepeated(lane, method, args, isWriteRead)
  if (reused && !isShadow) {
    return reused.encoded
  }
  const encoded = encodeReads(lane, method, args, isWriteRead)
  if (reused) {
    if (
      typeof encoded === 'string' ||
      Buffer.compare(reused.encoded.payload.bytes, encoded.payload.bytes) !== 0
    ) {
      recordDiff({ collection: args.collection, op: `${method}:${reused.kind}` })
    }
  } else if (typeof encoded !== 'string') {
    rememberEncoding(lane, method, args, isWriteRead, encoded.payload.bytes)
  }
  return encoded
}

/**
 * Shadow mode (`PAYLOAD_RS_FUSE=shadow`): every call is encoded, and a reused encoding (by-id
 * template, repeated arguments) is compared with it.
 */
const isShadow = process.env.PAYLOAD_RS_FUSE === 'shadow'

/**
 * Encodings of calls whose arguments were seen before (`encodingKey`), per model: the encoding is
 * a function of the arguments, the model and the lane's settings, which the key and the per-call
 * `entity` check cover. At most `maxRepeatedEncodings` per model (then started over).
 */
const repeatedEncodings = new WeakMap<object, Map<string, Uint8Array>>()
const maxRepeatedEncodings = 128

const repeatedKey = (lane: DriverLane, method: string, args: Any, isWriteRead: boolean) => {
  const argsKey = encodingKey(args, 16)
  if (argsKey === undefined) {
    return undefined
  }
  let entityOf: ReturnType<typeof entity>
  try {
    entityOf = entity(lane, args.collection)
  } catch {
    return undefined
  }
  return {
    key: `${method}|${isWriteRead}|${adapterSettingsKey(lane)}|${argsKey}`,
    Model: entityOf.Model,
    plan: entityOf.plan,
  }
}

const encodeRepeated = (lane: DriverLane, method: string, args: Any, isWriteRead: boolean) => {
  const found = repeatedKey(lane, method, args, isWriteRead)
  const bytes = found && repeatedEncodings.get(found.Model)?.get(found.key)
  if (!found || !bytes) {
    return undefined
  }
  return {
    encoded: {
      db: emptyDb,
      payload: { bytes, client: lane.clientID, plan: found.plan, reads: undefined },
    },
    kind: 'repeated',
  }
}

const rememberEncoding = (
  lane: DriverLane,
  method: string,
  args: Any,
  isWriteRead: boolean,
  bytes: Uint8Array,
) => {
  if (method === 'findOne' && idEquals(args.where)) {
    // by-id reads have their template
    return
  }
  const found = repeatedKey(lane, method, args, isWriteRead)
  if (!found) {
    return
  }
  let encodings = repeatedEncodings.get(found.Model)
  if (!encodings || encodings.size >= maxRepeatedEncodings) {
    encodings = new Map()
    repeatedEncodings.set(found.Model, encodings)
  }
  encodings.set(found.key, bytes)
}

/**
 * The adapter settings the encoding reads that users may change at runtime (e.g. a test setting
 * `payload.db.collation`): part of every reused encoding's key.
 */
const adapterSettingsKey = (lane: DriverLane) => {
  const adapter = lane.view
  return JSON.stringify([
    adapter.collation ?? null,
    Boolean(adapter.useJoinAggregations),
    Boolean(adapter.allowAdditionalKeys),
  ])
}

/**
 * A key that tells apart every two argument trees `encodeReads` could encode differently: the
 * type and value of every scalar (`-0` and non-finite numbers: no key), the key order of objects,
 * absent and `undefined` properties apart. `undefined` for anything else (dates, class
 * instances, accessors, proxies, deeper than `depth`).
 */
const encodingKey = (value: unknown, depth: number): string | undefined => {
  switch (typeof value) {
    case 'boolean':
      return value ? 't' : 'f'
    case 'number':
      return Number.isFinite(value) && !Object.is(value, -0) ? `d${value}` : undefined
    case 'object':
      break
    case 'string':
      return JSON.stringify(value)
    case 'undefined':
      return 'u'
    default:
      return undefined
  }
  if (value === null) {
    return 'n'
  }
  if (depth === 0 || types.isProxy(value)) {
    return undefined
  }
  const prototype = Object.getPrototypeOf(value)
  const isArray = Array.isArray(value)
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype) {
    return undefined
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (Array.isArray(value) && keys.length !== value.length + 1) {
    return undefined
  }
  let out = isArray ? '[' : '{'
  for (const key of keys) {
    if (typeof key === 'symbol') {
      return undefined
    }
    if (isArray && key === 'length') {
      continue
    }
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      return undefined
    }
    const item = encodingKey(descriptor.value, depth - 1)
    if (item === undefined) {
      return undefined
    }
    out += isArray ? `${item},` : `${JSON.stringify(key)}:${item},`
  }
  return `${out}${isArray ? ']' : '}'}`
}

/** The `where` of a by-id read (`combineQueries({ id: { equals } }, true)`, or the bare clause). */
const idEquals = (where: Any) => {
  const clause =
    isPlainObjectWithKey(where, 'and') && Array.isArray(where.and) && where.and.length === 1
      ? where.and[0]
      : where
  const id = isPlainObjectWithKey(clause, 'id') ? clause.id : undefined
  const value = isPlainObjectWithKey(id, 'equals') ? id.equals : undefined
  return typeof value === 'string' && objectIDHex.test(value)
    ? { hex: value, isAnd: clause !== where }
    : undefined
}

/** A plain object whose only own enumerable key is `key` (no key: an empty one). */
const isPlainObjectWithKey = (value: unknown, key?: string): value is Record<string, Any> => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false
  }
  const keys = Object.keys(value)
  return key === undefined ? keys.length === 0 : keys.length === 1 && keys[0] === key
}

const objectIDHex = /^[0-9a-f]{24}$/

/** By-id `findOne` templates per model, keyed by the other arguments the encoding reads. */
const byIDTemplates = new WeakMap<object, Map<string, null | Template>>()

/**
 * `encodeReads` of a `findOne` whose `where` is one `id` equal to a 24-hex id, without select or
 * joins: the encoding of the same call with the sentinel id (built once per model and the other
 * arguments it reads), given this call's id (./idTemplate.ts). The model and plan checks run per
 * call. `undefined`: encode the call.
 */
const encodeByID = (lane: DriverLane, args: Any, isWriteRead: boolean) => {
  const { collection: collectionSlug, draftsEnabled, joins, locale, select, where } = args
  const byID = idEquals(where)
  if (
    !byID ||
    (select !== undefined && select !== null) ||
    !(joins === undefined || joins === false || isPlainObjectWithKey(joins))
  ) {
    return undefined
  }
  let entityOf: ReturnType<typeof entity>
  try {
    entityOf = entity(lane, collectionSlug)
  } catch {
    return undefined
  }
  const { Model, plan } = entityOf
  let templates = byIDTemplates.get(Model)
  if (!templates) {
    templates = new Map()
    byIDTemplates.set(Model, templates)
  }
  const key = JSON.stringify([
    byID.isAnd,
    draftsEnabled,
    joins,
    locale,
    isWriteRead,
    adapterSettingsKey(lane),
  ])
  let template = templates.get(key)
  if (template === undefined) {
    const sentinelWhere = { id: { equals: sentinelHex } }
    const built = encodeReads(
      lane,
      'findOne',
      { ...args, where: byID.isAnd ? { and: [sentinelWhere] } : sentinelWhere },
      isWriteRead,
    )
    const candidate =
      typeof built === 'string' ? null : toTemplate(Buffer.from(built.payload.bytes))
    template = candidate && candidate.raw.length + candidate.hex.length > 0 ? candidate : null
    templates.set(key, template)
  }
  if (!template) {
    return undefined
  }
  return {
    encoded: {
      db: emptyDb,
      payload: { bytes: withID(template, byID.hex), client: lane.clientID, plan, reads: undefined },
    },
    kind: 'byIDTemplate',
  }
}

const encodeReads = (
  lane: DriverLane,
  method: 'count' | 'find' | 'findOne',
  args: Any,
  isWriteRead: boolean,
): { db: string; payload: MongoPayload } | string => {
  try {
    mongooseTypes = lane.mongoose.Types
    const reads =
      method === 'find'
        ? findReads(lane, args)
        : method === 'findOne'
          ? findOneReads(lane, args)
          : countReads(lane, args)
    const { plan, subqueries, ...rest } = reads
    if (subqueries) {
      if (isWriteRead) {
        // the fused writes read their stored documents inside their transaction, without sub-queries
        return 'mongo:where:relationship-path:write'
      }
      rest.subqueries = subqueries
    }
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
  if (collectionConfig.polymorphicJoins?.length) {
    unsupported('joins:polymorphic')
  }
  return { adapter, collectionConfig, Model, plan }
}

/**
 * db-mongodb `buildJoinAggregation` (utilities/buildJoinAggregation.ts) of a collection's joins
 * (no polymorphic joins: `entity`) for the main collection's documents (no `versions`): one
 * collection per join, a joined collection read without drafts, one locale. `joins`: the
 * sanitized `JoinQuery` db-mongodb gets (src/fuse/joins.ts), whose `where` becomes the join's
 * `$match` through `JoinModel.buildQuery` (`buildFilter` on the joined collection: no relationship
 * sub-queries). Aggregation pipelines are not cast by mongoose: the stages are sent as built.
 */
const joinStages = (
  lane: DriverLane,
  adapter: Any,
  collectionConfig: Any,
  {
    draftsEnabled,
    joins,
    locale,
    projection,
  }: { draftsEnabled: unknown; joins: Any; locale: Any; projection: Any },
) => {
  const joinConfig = collectionConfig.joins ?? {}
  if (joins === false || Object.keys(joinConfig).length === 0) {
    return []
  }
  if (!adapter.useJoinAggregations) {
    // db-mongodb resolves them with follow-up finds (`resolveJoins`)
    unsupported('resolveJoins')
  }
  const localization = adapter.payload.config.localization
  const stages: Any[] = []
  for (const slug of Object.keys(joinConfig)) {
    for (const join of joinConfig[slug]) {
      if (projection && !projection[join.joinPath]) {
        continue
      }
      if (joins?.[join.joinPath] === false) {
        continue
      }
      const joinedConfig = adapter.payload.collections[join.field.collection]?.config
      if (typeof join.field.collection !== 'string' || !joinedConfig) {
        unsupported('joins:collection')
      }
      if (draftsEnabled && joinedConfig.versions?.drafts) {
        unsupported('joins:drafts')
      }
      if (localization && locale === 'all') {
        unsupported('joins:allLocales')
      }
      const {
        count,
        limit = join.field.defaultLimit ?? 10,
        page,
        sort: sortJoin = join.field.defaultSort || joinedConfig.defaultSort,
        where = {},
      } = joins?.[join.joinPath] || {}
      if (
        !(count === undefined || typeof count === 'boolean') ||
        !(typeof limit === 'number' && Number.isFinite(limit)) ||
        !(page === undefined || (typeof page === 'number' && Number.isFinite(page)))
      ) {
        unsupported('joins:values')
      }
      const sort = buildSortParam({
        adapter,
        config: adapter.payload.config,
        fields: joinedConfig.flattenedFields,
        locale,
        sort: sortJoin,
        timestamps: true,
      })
      const sortProperty = Object.keys(sort)[0]!
      const { Model: JoinModel } = getCollection({ adapter, collectionSlug: joinedConfig.slug })
      // `JoinModel.buildQuery({ locale, payload, where })`
      const { query: $match, subqueries } = buildFilter({
        adapter,
        collectionSlug: joinedConfig.slug,
        fields: joinedConfig.flattenedFields,
        lane,
        locale,
        where,
      })
      if (subqueries.length > 0) {
        unsupported('joins:where:relationship-path')
      }
      const pipeline: Any[] = [
        { $match },
        { $sort: { [sortProperty]: sort[sortProperty] === 'asc' ? 1 : -1 } },
      ]
      if (page) {
        pipeline.push({ $skip: (page - 1) * limit })
      }
      if (limit > 0) {
        pipeline.push({ $limit: limit + 1 })
      }
      const polymorphicSuffix = Array.isArray(join.targetField.relationTo) ? '.value' : ''
      const localeSuffix =
        fieldShouldBeLocalized({ field: join.field, parentIsLocalized: join.parentIsLocalized }) &&
        localization &&
        locale
          ? `.${locale}`
          : ''
      const as = `${join.joinPath}${localeSuffix}`
      const foreignField = join.getForeignPath
        ? `${join.getForeignPath({ locale })}${polymorphicSuffix}`
        : `${join.field.on}${polymorphicSuffix}`
      stages.push(
        {
          $lookup: {
            as: `${as}.docs`,
            foreignField,
            from: JoinModel.collection.name,
            localField: '_id',
            pipeline,
          },
        },
        {
          $addFields: {
            [`${as}.docs`]: { $map: { as: 'doc', in: '$$doc._id', input: `$${as}.docs` } },
            [`${as}.hasNextPage`]: { $gt: [{ $size: `$${as}.docs` }, limit || Number.MAX_VALUE] },
          },
        },
      )
      if (count) {
        stages.push(
          {
            $lookup: {
              as: `${as}.totalDocs`,
              foreignField,
              from: JoinModel.collection.name,
              localField: '_id',
              pipeline: [{ $match }, { $count: 'result' }],
            },
          },
          {
            $addFields: {
              [`${as}.totalDocs`]: { $ifNull: [{ $first: `$${as}.totalDocs.result` }, 0] },
            },
          },
        )
      }
      if (limit > 0) {
        stages.push({ $addFields: { [`${as}.docs`]: { $slice: [`$${as}.docs`, limit] } } })
      }
    }
  }
  return stages
}

/**
 * A nested find of relationship population on collection `slug` (`payload.db.find` with
 * `pagination: false`, `limit: 0`, `where: { and: [{ id: { in: ids } }] }`): the reads the driver
 * lane would send, but the filter (built natively from the ids: `{ $and: [{ _id: { $in } }] }`).
 */
const relatedBackend = (
  lane: DriverLane,
  slug: string,
  args: {
    accessWhere: unknown
    draft: unknown
    joins: unknown
    locale: Any
    select: Any
    sort: Any
  },
): { backend: unknown } | string => {
  try {
    mongooseTypes = lane.mongoose.Types
    const resolved = entity(lane, slug)
    // the same inputs give the same reads: cached per model (a JSON key of JSON-like inputs)
    const { accessWhere, draft, joins, locale, select, sort } = args
    const isCacheable = [accessWhere, joins, select, sort].every(
      (value) => value === undefined || typeof value !== 'object' || isInertTree(value, false),
    )
    const key = isCacheable
      ? JSON.stringify([resolved.plan, accessWhere, Boolean(draft), joins, locale, select, sort])
      : undefined
    let cache = relatedBackends.get(resolved.Model)
    const cached = key === undefined ? undefined : cache?.get(key)
    if (cached !== undefined) {
      return cached
    }
    const result = buildRelatedBackend(lane, slug, resolved, args)
    if (key !== undefined) {
      if (!cache || cache.size >= 256) {
        cache = new Map()
        relatedBackends.set(resolved.Model, cache)
      }
      cache.set(key, result)
    }
    return result
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

const relatedBackends = new WeakMap<object, Map<string, { backend: unknown } | string>>()

const buildRelatedBackend = (
  lane: DriverLane,
  slug: string,
  { adapter, collectionConfig, Model, plan }: ReturnType<typeof entity>,
  {
    accessWhere,
    draft,
    joins,
    locale,
    select,
    sort: sortArg,
  }: {
    accessWhere: unknown
    draft: unknown
    joins: unknown
    locale: Any
    select: Any
    sort: Any
  },
): { backend: unknown } | string => {
  try {
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
    // `buildQuery` of `{ and: [{ id: { in } }, accessWhere] }` holds the constraint's own query
    // second in its `$and` (built natively with the ids): uncast for an aggregation, cast by
    // mongoose for `Model.find`
    let accessQuery: Any
    if (accessWhere !== undefined) {
      const { query, subqueries } = buildFilter({
        adapter,
        collectionSlug: slug,
        fields: collectionConfig.flattenedFields,
        lane,
        locale,
        where: accessWhere,
      })
      if (subqueries.length > 0 || Object.keys(query).length === 0) {
        unsupported('populate:access:where')
      }
      accessQuery = query
    }
    const hexOf = (value: unknown) => Buffer.from(lane.BSON.serialize(value)).toString('hex')
    if (joins !== false && Object.keys(collectionConfig.joins ?? {}).length > 0) {
      // `joins`: the nested find's sanitized join query (src/fuse/populate.ts)
      const stages = joinStages(lane, adapter, collectionConfig, {
        draftsEnabled: draft,
        joins,
        locale,
        projection,
      })
      if (stages.length > 0) {
        // `aggregatePaginate` (`pagination: false`, `limit: 0`, `page: 1`): `$match` (built
        // natively), the sort, `$skip: 0`, the join stages, the projection
        const $sort: Record<string, -1 | 1> = {}
        for (const [key, value] of Object.entries(sort)) {
          $sort[key] = value === 'desc' ? -1 : 1
        }
        const after: Any[] = [{ $sort }, { $skip: 0 }, ...stages]
        if (projection) {
          after.push({ $project: projection })
        }
        return {
          backend: {
            accessMatch: accessQuery && hexOf({ query: accessQuery }),
            collection: Model.collection.collectionName,
            pipeline: hexOf({ stages: after }),
            plan,
          },
        }
      }
    }
    return {
      backend: {
        accessFilter: accessQuery && hexOf({ query: castFilter(Model.schema, accessQuery) }),
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
  const { query, subqueries } = buildFilter({
    adapter,
    collectionSlug,
    fields: collectionConfig.flattenedFields,
    lane,
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
  const stages = joinStages(lane, adapter, collectionConfig, {
    draftsEnabled: args.draftsEnabled,
    joins,
    locale,
    projection: paginationOptions.projection,
  })
  if (stages.length > 0) {
    if (subqueries.length > 0) {
      unsupported('joins:subqueries')
    }
    return { ...aggregatePaginateReads(Model, query, stages, paginationOptions), plan }
  }
  return {
    ...paginateReads(Model, query, paginationOptions),
    plan,
    subqueries: subqueryReads(Model.schema, query, subqueries),
  }
}

/**
 * db-mongodb `aggregatePaginate` (utilities/aggregatePaginate.ts) of `find` with join stages, up
 * to its aggregation and count: the uncast query as `$match` (aggregation pipelines are not cast),
 * the count as mongoose casts it; `meta`: the inputs of its result meta.
 */
const aggregatePaginateReads = (Model: Any, query: Any, stages: Any[], paginationOptions: Any) => {
  const { collation, limit, page, pagination, projection, sort, useEstimatedCount } =
    paginationOptions
  if (collation !== undefined) {
    // `Model.aggregate(pipeline, { collation })`
    unsupported('joins:collation')
  }
  if (typeof page !== 'number' || typeof limit !== 'number') {
    unsupported('joins:page')
  }
  const pipeline: Any[] = [{ $match: query }]
  if (sort) {
    const $sort: Record<string, -1 | 1> = {}
    for (const [key, value] of Object.entries(sort)) {
      $sort[key] = value === 'desc' ? -1 : 1
    }
    pipeline.push({ $sort })
  }
  if (page) {
    pipeline.push({ $skip: (page - 1) * limit })
  }
  if (limit) {
    pipeline.push({ $limit: limit })
  }
  pipeline.push(...stages)
  if (projection) {
    pipeline.push({ $project: projection })
  }
  const reads: Record<string, unknown> = {
    collection: Model.collection.collectionName,
    meta: { limit, page, pagination: pagination !== false },
    op: 'find',
    pipeline,
  }
  if (pagination !== false && limit) {
    // `Model.estimatedDocumentCount(query)` (an empty query) or `Model.countDocuments(query, {
    // collation, session })` (the `_id` hint only applies to an empty query)
    reads.count = useEstimatedCount ? 'estimated' : countSpec(Model, query, {})
  }
  return reads
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
  const { query, subqueries } = buildFilter({
    adapter,
    collectionSlug,
    fields: collectionConfig.flattenedFields,
    lane,
    locale,
    where,
  })
  const projection = buildProjectionFromSelect({
    adapter,
    fields: collectionConfig.flattenedFields,
    select,
  })
  const stages = joinStages(lane, adapter, collectionConfig, {
    draftsEnabled: args.draftsEnabled,
    joins,
    locale,
    projection,
  })
  if (stages.length > 0) {
    if (subqueries.length > 0) {
      unsupported('joins:subqueries')
    }
    // `aggregatePaginate({ limit: 1, pagination: false, projection, query, joinAggregation })`
    // (the uncast query: aggregation pipelines are not cast)
    const pipeline: Any[] = [{ $match: query }, { $limit: 1 }, ...stages]
    if (projection) {
      pipeline.push({ $project: projection })
    }
    return {
      collection: Model.collection.collectionName,
      op: 'findOne',
      pipeline,
      plan,
    }
  }
  const find: Record<string, unknown> = { filter: castFilter(Model.schema, query) }
  const execProjection = projectionForExec(Model, 'findOne', projection)
  if (execProjection !== undefined) {
    find.projection = execProjection
  }
  return {
    collection: Model.collection.collectionName,
    find,
    op: 'findOne',
    plan,
    subqueries: subqueryReads(Model.schema, query, subqueries),
  }
}

/** db-mongodb `count` (the driver lane's `laneCount`). */
const countReads = (lane: DriverLane, args: Any): { plan: number } & Record<string, unknown> => {
  const { collection: collectionSlug, locale, where = {} } = args
  const { adapter, collectionConfig, Model, plan } = entity(lane, collectionSlug)
  if (hasNear(where)) {
    unsupported('near')
  }
  const { query, subqueries } = buildFilter({
    adapter,
    collectionSlug,
    fields: collectionConfig.flattenedFields,
    lane,
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
  return {
    collection: Model.collection.collectionName,
    count,
    op: 'count',
    plan,
    subqueries: subqueryReads(Model.schema, query, subqueries),
  }
}

// ---------------------------------------------------------------------------------------------
// `buildQuery` (db-mongodb queries/parseParams.ts, buildAndOrConditions.ts, buildSearchParams.ts)

/**
 * `buildQuery`: the query and the relationship sub-queries its `buildSearchParam`s run, in their
 * order (each one's ids fill the query's `$in` array `ids`).
 */
const buildFilter = ({
  adapter,
  collectionSlug,
  fields,
  lane,
  locale,
  where,
}: {
  adapter: Any
  collectionSlug: string
  fields: Any[]
  lane: DriverLane
  locale: Any
  where: Any
}) => {
  const subqueries: SubQuery[] = []
  const query = parseParams({
    collectionSlug,
    fields,
    lane,
    locale,
    parentIsLocalized: false,
    payload: adapter.payload,
    subqueries,
    where,
  })
  return { query, subqueries }
}

/**
 * The sub-query of a relationship path (`buildSearchParam`'s `paths.length > 1` branch, one hop):
 * `SubModel.find(subQuery).lean().select({ _id: true })` as mongoose sends it, and the `$in` array
 * of the parent query its ids fill.
 */
type SubQuery = { collection: string; filter: Any; ids: unknown[]; projection: unknown }

type ParseArgs = {
  collectionSlug: string
  fields: Any[]
  lane: DriverLane
  locale: Any
  parentIsLocalized: boolean
  payload: Any
  subqueries: SubQuery[]
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
  lane,
  locale,
  operator,
  parentIsLocalized,
  payload,
  subqueries,
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
  if (paths.length > 2) {
    // more than one relationship hop: sub-queries that depend on each other
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
  if (rawQuery && paths.length === 1) {
    return { value: rawQuery }
  }
  if (!formattedOperator) {
    return undefined
  }
  if (paths.length > 1) {
    return relationshipSearchParam({
      formattedOperator,
      lane,
      locale,
      parentField: field,
      path,
      payload,
      related: paths[1],
      subqueries,
      val,
    })
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

/**
 * `buildSearchParam`'s sub-query of a one-hop relationship path (`i === 0` with
 * `pathsToQuery.length === 1`): `SubModel.buildQuery` of `{ [subPath]: { [formattedOperator]: val } }`,
 * then `SubModel.find(subQuery).lean().select({ _id: true })`, whose ids make
 * `{ path, value: { $in } }`. The find runs natively before the call's reads (the `$in` array stays
 * empty here). Related collections with ObjectId ids only: `$in` holds the documents' `_id`s.
 */
const relationshipSearchParam = ({
  formattedOperator,
  lane,
  locale,
  parentField,
  path,
  payload,
  related: { collectionSlug, path: subPath },
  subqueries,
  val,
}: {
  formattedOperator: string
  lane: DriverLane
  locale: Any
  parentField: Any
  path: string
  payload: Any
  related: Any
  subqueries: SubQuery[]
  val: unknown
}) => {
  if (!parentField) {
    return undefined
  }
  if (!collectionSlug) {
    // upstream's APIError
    return unsupported('where:relationship-path')
  }
  if (payload.collections[collectionSlug]?.customIDType) {
    unsupported('where:relationship-path:custom-id')
  }
  const { collectionConfig, Model: SubModel } = getCollection({
    adapter: lane.view,
    collectionSlug,
  })
  if (!isPristineModel(lane, SubModel)) {
    unsupported('model')
  }
  const nested: SubQuery[] = []
  // `SubModel.buildQuery` (getBuildQueryPlugin): `parseParams` on the related collection
  const subQuery = parseParams({
    collectionSlug,
    fields: collectionConfig.flattenedFields,
    lane,
    locale,
    parentIsLocalized: false,
    payload,
    subqueries: nested,
    where: { [subPath]: { [formattedOperator]: val } },
  })
  if (nested.length > 0) {
    unsupported('where:relationship-path')
  }
  const ids: unknown[] = []
  subqueries.push({
    collection: SubModel.collection.collectionName,
    filter: castFilter(SubModel.schema, subQuery),
    ids,
    projection: projectionForExec(SubModel, 'find', { _id: true }),
  })
  return { path, value: { $in: ids } }
}

/**
 * The sub-queries of `query` for the native call, each with the path of its `$in` array in the
 * cast filter (`castFilter` keeps the query's structure), where its ids go. The array must occur
 * exactly once, as the `$in` of a path whose cast keeps ObjectIds as they are.
 */
const subqueryReads = (schema: Any, query: Any, subqueries: SubQuery[]) => {
  if (subqueries.length === 0) {
    return undefined
  }
  const found = new Map<unknown, string[][]>(subqueries.map(({ ids }) => [ids, []]))
  const visit = (value: Any, path: string[]) => {
    if (Array.isArray(value)) {
      const paths = found.get(value)
      if (paths) {
        paths.push(path)
        return
      }
      value.forEach((item, index) => visit(item, [...path, String(index)]))
    } else if (isPOJO(value)) {
      for (const key of Object.keys(value)) {
        visit(value[key], [...path, key])
      }
    }
  }
  visit(query, [])
  return subqueries.map(({ collection, filter, ids, projection }) => {
    const [slot, ...more] = found.get(ids)!
    if (!slot || more.length > 0 || slot.length < 2 || slot.at(-1) !== '$in') {
      return unsupported('where:relationship-path:slot')
    }
    const key = slot.at(-2)!
    const probe = new mongooseTypes.ObjectId()
    if (castFilter(schema, { [key]: { $in: [probe] } })[key].$in[0] !== probe) {
      unsupported('where:relationship-path:cast')
    }
    const read: Record<string, unknown> = { collection, filter, path: slot }
    if (projection !== undefined) {
      read.projection = projection
    }
    return read
  })
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
  (schematype.$isMongooseArray && schematype.embeddedSchemaType?.instance === 'String')

/** `schematype.castForQuery(null, value)` for a value that is not `null`. */
const castValue = (schematype: Any, value: Any): Any => {
  if (schematype.$isMongooseArray && !schematype.schema) {
    // a primitive array (`SchemaArray._castForQuery`): its embedded schema type's cast
    if (!schematype.embeddedSchemaType || schematype.embeddedSchemaType.discriminators) {
      unsupported('cast:array')
    }
    return castValue(schematype.embeddedSchemaType, value)
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
      if (typeof value === 'string' || typeof value === 'number') {
        // the schema type's (pure) `cast` (`castDate`, or a custom one); a failure is mongoose's
        // CastError, thrown on the exact lane
        try {
          return schematype.cast(value)
        } catch {
          unsupported('cast:Date')
        }
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
 * serializes them). Untraced exact runs (nothing reported) are not compared. The relationship
 * sub-queries of `buildQuery` run on mongoose: the Node driver's `Collection` calls are traced too.
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
  installDriverTrace(lane.mongoose.mongo?.Collection)
  const events: TraceEvent[] = []
  const result = await runTraced({ describe: (args) => args, events }, exact)
  const operations = events.filter(
    (event) => 'op' in event && (event.op !== 'aggregate' || reads.pipeline),
  )
  if (operations.length === 0) {
    return result
  }
  const expected = expectedOperations(reads)
  const serialize = (value: unknown) =>
    Buffer.from(lane.BSON.serialize({ value }, { ignoreUndefined: false })).toString('hex')
  // the operation's own reads come first (population's nested finds follow)
  const actualSpecs = operations.slice(0, expected.length).map((event) => {
    const { args, collection, op } = event as { args: Any[]; collection: unknown; op: string }
    return { collection, op, spec: operationSpec(op, args) }
  })
  const actual = actualSpecs.map(({ spec, ...rest }) => ({ ...rest, spec: serialize(spec) }))
  const wanted = expected.map(({ collection, hasSubqueryIDs, op, spec }, index) => ({
    collection,
    op,
    spec: serialize(
      hasSubqueryIDs ? withSubqueryIDs(reads.subqueries, spec, actualSpecs[index]?.spec) : spec,
    ),
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

/**
 * The driver calls the fused reads stand for, in the driver lane's trace order: the relationship
 * sub-queries (mongoose's `find`s inside `buildQuery`), then the count and the find, whose filters
 * hold the sub-queries' ids (`hasSubqueryIDs`).
 */
const expectedOperations = (reads: Any) => {
  const out: {
    collection: unknown
    hasSubqueryIDs: boolean
    op: string
    spec: Record<string, unknown>
  }[] = []
  for (const { collection, filter, projection } of reads.subqueries ?? []) {
    const spec: Record<string, unknown> = { filter }
    if (projection !== undefined) {
      spec.projection = projection
    }
    out.push({ collection, hasSubqueryIDs: false, op: 'find', spec })
  }
  const main = { collection: reads.collection, hasSubqueryIDs: Boolean(reads.subqueries) }
  if (reads.pipeline) {
    // `Model.aggregate(pipeline, { collation, session })`, traced as `[pipeline, options]`; for a
    // `find` (`aggregatePaginate`) before its count
    out.push({ ...main, op: 'aggregate', spec: { filter: reads.pipeline } })
  }
  const count = reads.count
  if (count === 'estimated') {
    out.push({ ...main, op: 'estimatedDocumentCount', spec: {} })
  } else if (count) {
    const spec: Record<string, unknown> = { filter: count.filter }
    if (count.collation !== undefined) {
      spec.collation = count.collation
    }
    if (count.hint !== undefined) {
      spec.hint = count.hint
    }
    out.push({ ...main, op: 'countDocuments', spec })
  }
  if (reads.find) {
    const { filter, ...options } = reads.find
    const spec: Record<string, unknown> = { filter }
    for (const key of ['collation', 'hint', 'limit', 'projection', 'skip', 'sort']) {
      if (options[key] !== undefined) {
        spec[key] = options[key]
      }
    }
    out.push({ ...main, op: reads.op === 'findOne' ? 'findOne' : 'find', spec })
    if (reads.op === 'findOne') {
      // the driver's `findOne` is a `find` with `limit: 1` / `singleBatch` (both traced)
      out.push({ ...main, op: 'find', spec })
    }
  }
  return out
}

/**
 * `spec` with the exact lane's ids (`actual`, the traced call's spec) at the sub-queries' `$in`
 * paths of its filter: the ids are what the same sub-query returned to the exact lane (the
 * results are compared on their own); they must be an array of ObjectIds.
 */
const withSubqueryIDs = (subqueries: Any[], spec: Record<string, unknown>, actual: Any) => {
  let filter = spec.filter
  for (const { path } of subqueries) {
    let ids = actual?.filter
    for (const key of path) {
      ids = ids?.[key]
    }
    if (
      !Array.isArray(ids) ||
      !ids.every((id) => id instanceof mongooseTypes.ObjectId || id?._bsontype === 'ObjectId')
    ) {
      return spec
    }
    filter = setAt(filter, path, ids)
  }
  return { ...spec, filter }
}

/** A copy of `value` with `item` at `path` (copies along the path only). */
const setAt = (value: Any, path: string[], item: unknown): Any => {
  if (path.length === 0) {
    return item
  }
  const [key, ...rest] = path as [string, ...string[]]
  const copy = Array.isArray(value) ? [...value] : { ...value }
  copy[key] = setAt(value?.[key], rest, item)
  return copy
}
