import { types } from 'node:util'

/**
 * Fused read lanes (packages/engine-rs/FUSE_CONTRACT.md): `find`, `findByID` and `count` of a
 * collection whose read path holds no user JS run as one native call (crates/payload-fuse) and
 * are materialized with one `JSON.parse`. Called by the read operation drop-ins of
 * `../ops/index.ts`: each entry returns the operation's promise, or `undefined` when the call
 * must run on the exact lane (a guard failed, or the native lane bailed).
 *
 * `PAYLOAD_RS_FUSE`: unset / `on` (default), `off`, `shadow` (every fused call is compared with
 * the exact lane, whose result is returned).
 */
import type { CollectionPlan } from './plan.js'
import type { FusedTarget } from './targets.js'

import { sanitizeSortQuery } from '../../../payload/src/collections/operations/utilities/sanitizeSortQuery.js'
import { combineQueries } from '../../../payload/src/database/combineQueries.js'
import { appendNonTrashedFilter } from '../../../payload/src/utilities/appendNonTrashedFilter.js'
import { getSelectMode } from '../../../payload/src/utilities/getSelectMode.js'
import { hasDraftsEnabled } from '../../../payload/src/utilities/getVersionsConfig.js'
import { encodeSnapshot, snapshotRequest } from '../compile/index.js'
import { getNativeEngine } from '../native.js'
import { createFunctionRegistry, serializeForEngine } from '../serialize.js'
import { compiledAccess, laneFieldAccess } from './access.js'
import { hasDataProperties, isInertTree, isPlainDataObject, isPlainObject } from './inert.js'
import { fusedJoinQuery, hasJoins, noteAccessWhereBail } from './joins.js'
import { getCollectionPlan } from './plan.js'
import {
  comparePopulated,
  materializePopulated,
  populatedResult,
  type PopulationContext,
  populationRequest,
  settleCanonical,
} from './populate.js'
import { canonical, firstDifference } from './shadow.js'
import { count, recordDiff, stats } from './stats.js'
import { getFusedTarget } from './targets.js'
import { isAcceptedWhere } from './where.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- operation args keep upstream's generics */
type Any = any

export { canonicalResult } from './populate.js'
export { getFusedCallCount, stats as fuseStats } from './stats.js'
export { registerFusedTarget } from './targets.js'

type FuseMode = 'off' | 'on' | 'shadow'

const mode: FuseMode =
  process.env.PAYLOAD_RS_FUSE === 'off'
    ? 'off'
    : process.env.PAYLOAD_RS_FUSE === 'shadow'
      ? 'shadow'
      : 'on'

type Exact = () => Promise<Any>
type Op = 'count' | 'find' | 'findByID'

/**
 * A call the fused lane serves: its request (FUSE_CONTRACT.md section 4), its backend and what
 * the backend's `run` takes besides the request.
 */
type Fused = {
  op: Op
  payload: unknown
  /** set when the operation populates relationships */
  population?: PopulationContext
  /** upstream's changes to the caller's `joins` (`sanitizeJoinQuery`), applied after success */
  replayJoins?: (joins: unknown) => void
  request: string
  target: FusedTarget
}

type NativeFuse = { fuseRegisterPlan: (json: string) => number }

/** Keys of the operation args each drop-in destructures (all must be data properties). */
const argKeys: Record<Op, readonly string[]> = {
  count: ['collection', 'disableErrors', 'overrideAccess', 'req', 'trash', 'where'],
  find: [
    'collection',
    'currentDepth',
    'depth',
    'disableErrors',
    'draft',
    'includeLockStatus',
    'joins',
    'limit',
    'overrideAccess',
    'page',
    'pagination',
    'populate',
    'req',
    'select',
    'showHiddenFields',
    'sort',
    'trash',
    'where',
  ],
  findByID: [
    'collection',
    'currentDepth',
    'data',
    'depth',
    'disableErrors',
    'draft',
    'flattenLocales',
    'id',
    'includeLockStatus',
    'joins',
    'overrideAccess',
    'populate',
    'req',
    'select',
    'showHiddenFields',
    'trash',
  ],
}

/** `req` properties the lanes read. */
const reqKeys = ['fallbackLocale', 'locale', 'payload', 'payloadAPI', 'transactionID'] as const

/**
 * A `PayloadRequest` built from a web `Request` (`createPayloadRequestFromWebRequest`): a real
 * `Request` (not a subclass, not a proxy) whose Payload properties the lanes and the HTTP handlers
 * read are own data properties (RUST_HTTP_LANES.md 3.2). Reading them runs no code.
 */
const isPayloadWebRequest = (req: unknown): boolean =>
  typeof Request === 'function' &&
  req instanceof Request &&
  Object.getPrototypeOf(req) === Request.prototype &&
  !types.isProxy(req) &&
  hasOwnDataProperties(req, [
    'locale',
    'fallbackLocale',
    'payload',
    'payloadAPI',
    'transactionID',
    'user',
    'query',
  ])

/** What `isolateObjectProperty` (payload) recorded for each proxy it created. */
const isolatedObjects = ((globalThis as Record<symbol, unknown>)[
  Symbol.for('payload.isolateObjectProperty')
] ??= new WeakMap()) as WeakMap<object, { delegate: object; keys: PropertyKey[]; target: object }>

/**
 * How a `req` can be read without running unknown code: a plain object, a web `Request` carrying
 * Payload's properties, or Payload's own `isolateObjectProperty` proxy of such a request (its
 * handler reads the isolated keys from a plain delegate and the rest from the target).
 */
const acceptedRequest = (req: unknown, depth: number): 'isolated' | 'plain' | 'web' | undefined => {
  if (isPlainObject(req)) {
    return 'plain'
  }
  if (isPayloadWebRequest(req)) {
    return 'web'
  }
  const isolated = typeof req === 'object' && req !== null ? isolatedObjects.get(req) : undefined
  if (!isolated || depth > 4 || !isPlainDataObject(isolated.delegate)) {
    return undefined
  }
  const inner = acceptedRequest(isolated.target, depth + 1)
  if (inner === undefined) {
    return undefined
  }
  const forwarded = reqKeys.filter((key) => !isolated.keys.includes(key))
  if (inner !== 'isolated' && !hasDataProperties(isolated.target, forwarded)) {
    return undefined
  }
  return 'isolated'
}

/** Each key is absent or an own data property (no accessor anywhere on the prototype chain). */
const hasOwnDataProperties = (object: object, keys: readonly string[]): boolean => {
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (descriptor ? !('value' in descriptor) : key in object) {
      return false
    }
  }
  return true
}

const guard = (reason: string): undefined => {
  count(stats.guards, reason)
  return undefined
}

type Prepared = {
  /** The collection read access result (`undefined` with `overrideAccess`). */
  accessResult: unknown
  config: Any
  overrideAccess: boolean
  payload: Any
  plan: { eligible: true } & CollectionPlan
  planID: number
  req: Any
  target: FusedTarget
}

/**
 * `isOperationResult`: the read of a write operation's result (its own `afterRead`), whose
 * collection read access the operation does not check; field read access and population follow
 * `args.overrideAccess` as in any read.
 */
const prepare = (op: Op, args: Any, isOperationResult = false): Prepared | undefined => {
  if (!isPlainObject(args)) {
    return guard('args:object')
  }
  if (!hasDataProperties(args, argKeys[op])) {
    return guard('args:accessor')
  }
  const collection: Any = args.collection
  const req: Any = args.req
  if (typeof collection !== 'object' || collection === null) {
    return guard('args:collection')
  }
  const requestKind = acceptedRequest(req, 0)
  if (requestKind === undefined) {
    return guard('req:object')
  }
  if (requestKind !== 'isolated' && !hasDataProperties(req, reqKeys)) {
    return guard('req')
  }
  if (req.transactionID) {
    return guard('transaction')
  }
  const payload: Any = req.payload
  if (typeof payload !== 'object' || payload === null) {
    return guard('payload')
  }
  const plan = getCollectionPlan(collection, payload)
  if (!plan.eligible) {
    count(stats.ineligible, plan.reason)
    return undefined
  }
  const overrideAccess = Boolean(args.overrideAccess)
  let accessResult: unknown
  if (isOperationResult) {
    accessResult = true
  } else if (!overrideAccess) {
    const evaluated = compiledAccess(
      plan.access,
      op === 'findByID' ? args.id : undefined,
      config(collection),
      req,
    )
    if (evaluated.reason !== undefined) {
      return guard(evaluated.reason)
    }
    accessResult = evaluated.value
  }
  const target = getFusedTarget(payload.db)
  if (typeof target === 'string') {
    return guard(target)
  }
  if (plan.id === undefined) {
    plan.id = (getNativeEngine() as unknown as NativeFuse).fuseRegisterPlan(plan.json)
  }
  return {
    accessResult,
    config: collection.config,
    overrideAccess,
    payload,
    plan,
    planID: plan.id,
    req,
    target,
  }
}

const config = (collection: Any): Any => collection.config

/**
 * The `field.access.read` functions of a find / findByID (afterRead's `overrideAccess ? true :
 * await field.access.read({ id, blockData, collection, data, doc, req, siblingData,
 * skipCompilation })`, falsy: the field is removed and gets no default) as `FnId`s, one per
 * function of `plan.fieldAccess`, or the guard reason; `undefined` with `overrideAccess` or
 * without such functions. The core evaluates them where upstream calls them, after every other
 * guard passed (`laneFieldAccess`: guard sampling as for collection access).
 */
const compiledFieldAccess = (
  { overrideAccess, plan }: Pick<Prepared, 'overrideAccess' | 'plan'>,
  fieldAccessIDs: Map<unknown, number>,
) => {
  if (overrideAccess || plan.fieldAccess.length === 0) {
    return undefined
  }
  return laneFieldAccess(plan.fieldAccess, fieldAccessIDs)
}

/** `afterRead`'s `depth` (`parseInt(String(depth))`, `defaultDepth`, capped at `maxDepth`). */
const afterReadDepth = (incomingDepth: unknown, config: Any): number => {
  let depth =
    incomingDepth || incomingDepth === 0 ? parseInt(String(incomingDepth), 10) : config.defaultDepth
  if (depth > config.maxDepth) {
    depth = config.maxDepth
  }
  return depth
}

const isOptionalBoolean = (value: unknown) => value === undefined || typeof value === 'boolean'
const isOptionalNumber = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value))

const isSort = (sort: unknown) =>
  sort === undefined ||
  sort === null ||
  sort === '' ||
  typeof sort === 'string' ||
  (Array.isArray(sort) &&
    Object.getPrototypeOf(sort) === Array.prototype &&
    sort.every((item) => typeof item === 'string'))

/** A select tree: plain objects whose values are booleans or such trees. */
const isSelectTree = (select: unknown, depth = 16): boolean => {
  if (!isPlainObject(select) || depth === 0) {
    return false
  }
  for (const key in select) {
    const value = select[key]
    if (typeof value !== 'boolean' && !isSelectTree(value, depth - 1)) {
      return false
    }
  }
  return isInertTree(select, false)
}

/**
 * The `afterRead` part of a request: everything after `"db":<tree>`. With compiled functions to
 * evaluate natively (field read access, population's access: `fieldAccessIDs`) `accessReq` is
 * `req` as they see it (`encodeSnapshot`).
 */
const readRequest = ({
  currentDepth,
  depth,
  fieldAccess,
  fieldAccessIDs,
  flattenLocales,
  payload,
  plan,
  req,
  select,
  showHiddenFields,
}: {
  currentDepth: number
  depth: number
  fieldAccess: number[] | undefined
  fieldAccessIDs: Map<unknown, number>
  flattenLocales: boolean
  payload: Any
  plan: { eligible: true } & CollectionPlan
  req: Any
  select: unknown
  showHiddenFields: boolean
}): string =>
  JSON.stringify({
    accessReq: fieldAccessIDs.size > 0 ? encodeSnapshot(snapshotRequest(req)) : undefined,
    auth: plan.auth,
    currentDepth,
    depth,
    fallbackLocale: req.fallbackLocale,
    fieldAccess,
    flattenLocales,
    locale: req.locale,
    localization: Boolean(payload.config.localization),
    select: select ?? null,
    selectMode: select ? getSelectMode(select as never) : null,
    showHiddenFields,
  }).slice(1)

/** `serializeForEngine` of the `payload.db.*` args; `undefined` if they hold functions. */
const serializeDbArgs = (args: unknown): string | undefined => {
  const registry = createFunctionRegistry()
  const json = serializeForEngine(args, registry)
  return registry.functions.length === 0 ? json : undefined
}

/**
 * The `db` part of a request for `payload.db[method](args)` on `target`, or a guard reason.
 * `isWriteRead`: a fused write's read (its stored documents, inside its transaction).
 */
const encodeDb = (
  target: FusedTarget,
  method: 'count' | 'find' | 'findOne',
  args: Record<string, unknown>,
  isWriteRead = false,
): { db: string; payload: unknown } | string => {
  if (target.encode) {
    return target.encode(method, args, isWriteRead)
  }
  const db = serializeDbArgs(args)
  return db === undefined ? 'db:functions' : { db, payload: undefined }
}

const isRequestValue = (value: unknown) =>
  value === undefined ||
  value === null ||
  typeof value === 'string' ||
  value === false ||
  (Array.isArray(value) && value.every((item) => typeof item === 'string'))

/** `isText`: the text lane's call (`fusedOperationText`), which does not populate. */
const buildFindRequest = (args: Any, isText = false): Fused | undefined => {
  const prepared = prepare('find', args)
  if (!prepared) {
    return undefined
  }
  const { accessResult, config, overrideAccess, payload, plan, planID, req, target } = prepared
  const {
    currentDepth: incomingCurrentDepth,
    depth: incomingDepth,
    draft,
    includeLockStatus,
    joins,
    limit,
    page,
    pagination = true,
    select,
    showHiddenFields,
    sort: incomingSort,
    trash = false,
    where,
  } = args
  if (includeLockStatus) {
    return guard('includeLockStatus')
  }
  if (draft && hasDraftsEnabled(config)) {
    return guard('draft')
  }
  if (
    !isOptionalBoolean(showHiddenFields) ||
    !isOptionalNumber(limit) ||
    !isOptionalNumber(page) ||
    !isOptionalBoolean(pagination) ||
    !isOptionalBoolean(draft) ||
    !isOptionalBoolean(trash) ||
    !isRequestValue(req.locale) ||
    !isRequestValue(req.fallbackLocale)
  ) {
    return guard('args:values')
  }
  if (select !== undefined && select !== null && !isSelectTree(select)) {
    return guard('select')
  }
  if (joins !== undefined && joins !== false && joins !== null && !isInertTree(joins, false)) {
    return guard('joins')
  }
  const rawSort = incomingSort || config.defaultSort
  if (!isSort(rawSort)) {
    return guard('sort')
  }
  // without overrideAccess `validateSortQuery` / `validateQueryPaths` check field permissions
  // (more access calls): only queries they do not check
  if (!overrideAccess && rawSort) {
    return guard('access:sort')
  }
  if (
    !isAcceptedWhere({ fields: config.flattenedFields, idOnly: !overrideAccess, payload, where })
  ) {
    return guard('where')
  }
  const depth = afterReadDepth(incomingDepth, payload.config)
  const currentDepth = incomingCurrentDepth || 1
  if (!Number.isFinite(depth) || typeof currentDepth !== 'number') {
    return guard('depth')
  }
  const isPopulated = Boolean(depth && currentDepth <= depth && plan.hasRelations)
  if (isPopulated && isText) {
    // the dataloader / request state of a populated result needs its objects
    return guard('populate:text')
  }
  const fieldAccessIDs = new Map<unknown, number>()
  const population = isPopulated
    ? populationRequest({
        args,
        currentDepth,
        depth,
        draft,
        fieldAccessIDs,
        payload,
        plan,
        req,
        target,
      })
    : undefined
  if (typeof population === 'string') {
    return guard(population)
  }

  const joinQuery = operationJoins({ args, config, overrideAccess, payload, req })
  if (typeof joinQuery === 'string') {
    return guard(joinQuery)
  }

  const usePagination = pagination && limit !== 0
  const fullWhere = appendNonTrashedFilter({
    enableTrash: config.trash,
    trash,
    where: combineQueries(where, accessResult as never),
  })
  const sort = sanitizeSortQuery({ fields: config.flattenedFields, sort: rawSort })
  const db = encodeDb(target, 'find', {
    collection: config.slug,
    draftsEnabled: draft,
    joins: joinQuery.joins,
    limit: limit ?? (usePagination ? 10 : 0),
    locale: req.locale,
    page: page || 1,
    pagination,
    req: { fallbackLocale: req.fallbackLocale, locale: req.locale, payloadAPI: req.payloadAPI },
    select,
    sort,
    where: fullWhere,
  })
  if (typeof db === 'string') {
    return guard(db)
  }
  const fieldAccess = compiledFieldAccess(prepared, fieldAccessIDs)
  if (typeof fieldAccess === 'string') {
    return guard(fieldAccess)
  }
  const request = `{"op":"find","plan":${planID},"db":${db.db},${readRequest({
    currentDepth,
    depth,
    fieldAccess,
    fieldAccessIDs,
    flattenLocales: true,
    payload,
    plan,
    req,
    select,
    showHiddenFields: Boolean(showHiddenFields),
  }).slice(0, -1)}${population ? `,"pop":${population.json}` : ''}}`
  return {
    op: 'find',
    payload: db.payload,
    population: population?.context,
    replayJoins: joinQuery.replay,
    request,
    target,
  }
}

/**
 * The `joins` of the operation's `payload.db` call (`sanitizeJoinQuery`, then `false` for
 * GraphQL) and the replay of its changes to `args.joins`, or the guard reason. A write
 * operation's own result read passes no joins query (its collection has none: the fused writes'
 * plan).
 */
const operationJoins = ({
  args,
  config,
  overrideAccess,
  payload,
  req,
}: {
  args: Any
  config: Any
  overrideAccess: boolean
  payload: Any
  req: Any
}) => {
  const { joins } = args
  if (!hasJoins(config)) {
    return {
      joins: req.payloadAPI === 'GraphQL' ? false : joins === false ? false : joins || {},
      replay: undefined,
    }
  }
  const joinQuery = fusedJoinQuery({
    collectionConfig: config,
    joins,
    overrideAccess,
    payload,
    predict: false,
    req,
  })
  if (typeof joinQuery === 'string') {
    return joinQuery
  }
  return {
    joins: req.payloadAPI === 'GraphQL' ? false : joinQuery.joins,
    replay: isPlainObject(joins) ? joinQuery.replay : undefined,
  }
}

export const fuseFind = (args: Any, exact: Exact): Promise<Any> | undefined => {
  if (mode === 'off') {
    return undefined
  }
  const fused = buildFindRequest(args)
  return fused && runFused(fused, args, exact)
}

/**
 * `storedAccess`: a fused write's update / delete access result (a where constraint) combined into
 * the `findOne` (the write's stored-document read, `getLatestCollectionVersion` / deleteByID's
 * `findOne` of `combineQueries({ id: { equals } }, accessResults)`); the result's `afterRead` runs
 * on the written document and does not read with it.
 */
const buildFindByIDRequest = (
  args: Any,
  isOperationResult = false,
  isText = false,
  storedAccess?: unknown,
): Fused | undefined => {
  const prepared = prepare('findByID', args, isOperationResult)
  if (!prepared) {
    return undefined
  }
  const { accessResult, config, overrideAccess, payload, plan, planID, req, target } = prepared
  const {
    id,
    currentDepth: incomingCurrentDepth,
    data,
    depth: incomingDepth,
    draft: replaceWithVersion = false,
    flattenLocales,
    includeLockStatus,
    joins,
    select,
    showHiddenFields,
    trash = false,
  } = args
  if (data !== undefined) {
    return guard('data')
  }
  if (includeLockStatus) {
    return guard('includeLockStatus')
  }
  // a write operation's own `afterRead` runs on the document it wrote: `draft` only reaches the
  // population (and the stored-document read of the fused writes never passes it)
  if (replaceWithVersion && hasDraftsEnabled(config) && !isOperationResult) {
    return guard('draft')
  }
  const isValidID =
    (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id))
  if (!isValidID) {
    return guard('id')
  }
  if (
    !isOptionalBoolean(showHiddenFields) ||
    !isOptionalBoolean(flattenLocales) ||
    !isOptionalBoolean(replaceWithVersion) ||
    !isOptionalBoolean(trash) ||
    !isRequestValue(req.locale) ||
    !isRequestValue(req.fallbackLocale)
  ) {
    return guard('args:values')
  }
  if (select !== undefined && select !== null && !isSelectTree(select)) {
    return guard('select')
  }
  if (joins !== undefined && joins !== false && joins !== null && !isInertTree(joins, false)) {
    return guard('joins')
  }
  const depth = afterReadDepth(incomingDepth, payload.config)
  const currentDepth = incomingCurrentDepth || 1
  if (!Number.isFinite(depth) || typeof currentDepth !== 'number') {
    return guard('depth')
  }
  const isPopulated = Boolean(depth && currentDepth <= depth && plan.hasRelations)
  if (isPopulated && isText) {
    return guard('populate:text')
  }
  const fieldAccessIDs = new Map<unknown, number>()
  const population = isPopulated
    ? populationRequest({
        args,
        currentDepth,
        depth,
        draft: replaceWithVersion,
        fieldAccessIDs,
        // findByID destructures `overrideAccess = false`
        ownOverrideAccess:
          isOperationResult || args.overrideAccess !== undefined ? args.overrideAccess : false,
        payload,
        plan,
        req,
        target,
      })
    : undefined
  if (typeof population === 'string') {
    return guard(population)
  }
  const joinQuery = operationJoins({ args, config, overrideAccess, payload, req })
  if (typeof joinQuery === 'string') {
    return guard(joinQuery)
  }
  const fullWhere = appendNonTrashedFilter({
    enableTrash: config.trash,
    trash,
    where: combineQueries(
      { id: { equals: id } },
      (storedAccess ?? (overrideAccess ? true : accessResult)) as never,
    ),
  })
  const db = encodeDb(
    target,
    'findOne',
    {
      collection: config.slug,
      draftsEnabled: replaceWithVersion,
      joins: joinQuery.joins,
      locale: req.locale,
      req: { fallbackLocale: undefined, locale: undefined, payloadAPI: undefined },
      select,
      where: fullWhere,
    },
    isOperationResult,
  )
  if (typeof db === 'string') {
    return guard(db)
  }
  const fieldAccess = compiledFieldAccess(prepared, fieldAccessIDs)
  if (typeof fieldAccess === 'string') {
    return guard(fieldAccess)
  }
  const request = `{"op":"findByID","plan":${planID},"db":${db.db},${readRequest({
    currentDepth,
    depth,
    fieldAccess,
    fieldAccessIDs,
    flattenLocales: flattenLocales === undefined ? true : flattenLocales,
    payload,
    plan,
    req,
    select,
    showHiddenFields: Boolean(showHiddenFields),
  }).slice(0, -1)}${population ? `,"pop":${population.json}` : ''}}`
  return {
    op: 'findByID',
    payload: db.payload,
    population: population?.context,
    replayJoins: joinQuery.replay,
    request,
    target,
  }
}

export const fuseFindByID = (args: Any, exact: Exact): Promise<Any> | undefined => {
  if (mode === 'off') {
    return undefined
  }
  const fused = buildFindByIDRequest(args)
  return fused && runFused(fused, args, exact)
}

const buildCountRequest = (args: Any): Fused | undefined => {
  const prepared = prepare('count', args)
  if (!prepared) {
    return undefined
  }
  const { accessResult, config, overrideAccess, payload, plan, planID, req, target } = prepared
  const { trash = false, where } = args
  if (!isOptionalBoolean(trash) || !isRequestValue(req.locale)) {
    return guard('args:values')
  }
  if (
    !isAcceptedWhere({ fields: config.flattenedFields, idOnly: !overrideAccess, payload, where })
  ) {
    return guard('where')
  }
  const fullWhere = appendNonTrashedFilter({
    enableTrash: config.trash,
    trash,
    where: combineQueries(where, accessResult as never),
  })
  const db = encodeDb(target, 'count', {
    collection: config.slug,
    locale: req.locale || undefined,
    req: { fallbackLocale: req.fallbackLocale, locale: req.locale, payloadAPI: req.payloadAPI },
    where: fullWhere,
  })
  if (typeof db === 'string') {
    return guard(db)
  }
  void plan
  const request = `{"op":"count","plan":${planID},"db":${db.db}}`
  return { op: 'count', payload: db.payload, request, target }
}

export const fuseCount = (args: Any, exact: Exact): Promise<Any> | undefined => {
  if (mode === 'off') {
    return undefined
  }
  const fused = buildCountRequest(args)
  return fused && runFused(fused, args, exact)
}

const runNative = ({
  payload,
  request,
  target,
}: {
  payload: unknown
  request: string
  target: FusedTarget
}): Promise<string> | string => {
  try {
    return target.run(request, payload)
  } catch {
    return '!native:error'
  }
}

const runFused = (fused: Fused, args: Any, exact: Exact): Promise<Any> | undefined => {
  if (mode === 'shadow') {
    return shadow(fused, args, exact)
  }
  const backoffKey = populateBackoffKey(fused, args)
  if (backoffKey && isBackingOff(args.collection, backoffKey)) {
    return guard('backoff:populate:related')
  }
  const text = runNative(fused)
  if (typeof text !== 'string') {
    // an asynchronous backend: a bail continues on the exact lane
    return text.then((resolved) => {
      if (backoffKey) {
        notePopulated(args.collection, backoffKey, resolved)
      }
      return settle(fused, resolved, args) ?? exact()
    })
  }
  if (backoffKey) {
    notePopulated(args.collection, backoffKey, text)
  }
  return settle(fused, text, args)
}

/**
 * `populate:related` is a bail the native lane can only take after its reads ran (a loaded
 * relationship points to a collection the nested finds do not serve, e.g. one with a join
 * field), and it repeats for the same kind of call whenever the documents hold such values. After
 * one, the calls of that kind (collection, operation, depth, the related collections the request
 * serves) back off: the next 1, 2, 4, ... up to 64 run the exact lane directly
 * (`backoff:populate:related`); a call the lane serves resets it. A performance decision only:
 * both lanes give upstream's result. Shadow mode does not back off. The fused writes keep their
 * own per-collection backoff (src/fuse-write).
 */
type Backoff = { next: number; skip: number }

const populateBackoff = new WeakMap<object, Map<string, Backoff>>()

const populateBackoffKey = ({ op, population }: Fused, args: Any) =>
  population &&
  `${op}:${String(args.depth)}:${population.topCurrentDepth}:${Object.keys(population.selects).join(',')}`

const isBackingOff = (collection: object, key: string) => {
  const state = populateBackoff.get(collection)?.get(key)
  if (!state || state.skip === 0) {
    return false
  }
  state.skip--
  return true
}

const notePopulated = (collection: object, key: string, text: string) => {
  const states = populateBackoff.get(collection)
  if (text === '!populate:related') {
    const state = states?.get(key) ?? { next: 1, skip: 0 }
    state.skip = state.next
    state.next = Math.min(state.next * 2, 64)
    if (states) {
      states.set(key, state)
    } else {
      populateBackoff.set(collection, new Map([[key, state]]))
    }
  } else if (text.charCodeAt(0) !== 33 /* ! */) {
    states?.delete(key)
  }
}

const settle = (
  { op, population, replayJoins }: Fused,
  text: string,
  args: Any,
): Promise<Any> | undefined => {
  if (text.charCodeAt(0) === 33 /* ! */) {
    count(stats.bails, text.slice(1))
    noteAccessWhereBail(population?.payload, text)
    return undefined
  }
  count(stats.hits, op)
  replayJoins?.(args.joins)
  if (text.charCodeAt(0) === 35 /* # */) {
    count(stats.populated, op)
    return Promise.resolve(materializePopulated(text, population!))
  }
  return Promise.resolve(JSON.parse(text))
}

/** The result of a fused text without its side effects (shadow mode). */
const parseResult = (text: string) =>
  text.charCodeAt(0) === 35 /* # */ ? populatedResult(text) : JSON.parse(text)

/** The caller-provided parts of the args (what the exact lane could mutate). */
const argsSnapshot = (args: Any) =>
  canonical([args.where, args.sort, args.select, args.joins, args.populate, args.id])

const shadow = async (fused: Fused, args: Any, exact: Exact): Promise<Any> => {
  const { op, replayJoins, request } = fused
  const before = argsSnapshot(args)
  // the caller's `joins` with the changes the fused lane replays (compared with the exact lane's)
  const replayed = replayJoins && structuredClone(args.joins)
  const text = await runNative(fused)
  const isBail = text.charCodeAt(0) === 33
  if (isBail) {
    count(stats.bails, text.slice(1))
    noteAccessWhereBail(fused.population?.payload, text)
  } else {
    count(stats.hits, op)
  }
  let result: Any
  try {
    const { payload, target } = fused
    result = await (target.shadowExact && !isBail
      ? target.shadowExact(payload, exact, (difference) =>
          recordDiff({ ...difference, op, request }),
        )
      : exact())
  } catch (error) {
    if (!isBail) {
      recordDiff({ kind: 'exact-threw', message: String((error as Error)?.message), op, request })
    }
    throw error
  }
  if (!isBail) {
    const exactText = canonical(result)
    const fusedText = canonical(parseResult(text))
    if (text.charCodeAt(0) === 35 /* # */) {
      count(stats.populated, op)
      const difference = await comparePopulated(text, fused.population!, result)
      if (difference) {
        recordDiff({ ...difference, op, request })
      }
    }
    if (exactText !== fusedText) {
      // a concurrent write between the two reads: compare with a fused read made now
      const again = await runNative(fused)
      if (again.charCodeAt(0) === 33 || canonical(parseResult(again)) !== exactText) {
        recordDiff({ kind: 'result', op, request, ...firstDifference(exactText, fusedText) })
      } else {
        count(stats.bails, 'shadow:unstable')
      }
    }
    const after = argsSnapshot(args)
    replayJoins?.(replayed)
    const expected = replayJoins ? argsSnapshot({ ...args, joins: replayed }) : before
    if (after !== expected) {
      recordDiff({ kind: 'mutation', op, request, ...firstDifference(after, expected) })
    }
  }
  return result
}

/**
 * The fused writes (src/fuse-write): the `findByID` request a write's result is read with (its
 * `afterRead` and population on the document the write stored, crates/payload-fuse-mongo
 * `run_document`), the accepted request kinds, compiled access, and the result's
 * materialization (with population's dataloader priming) or plain value (shadow mode).
 */
export const fusedFindByIDRequest = (args: Any, storedAccess?: unknown) =>
  buildFindByIDRequest(args, true, false, storedAccess)
export const isAcceptedRequest = (req: unknown) => {
  const kind = acceptedRequest(req, 0)
  return kind !== undefined && (kind === 'isolated' || hasDataProperties(req as object, reqKeys))
}
export const evaluateCompiledAccess = (
  access: unknown,
  {
    id,
    collectionConfig,
    data,
    req,
  }: { collectionConfig: Any; data: unknown; id: unknown; req: Any },
) => compiledAccess(access, id, collectionConfig, req, data)
export const materializeFusedResult = (
  { population }: { population?: PopulationContext },
  text: string,
) =>
  text.charCodeAt(0) === 35 /* # */ ? materializePopulated(text, population!) : JSON.parse(text)
export { parseResult as fusedResultValue }
export type { Fused as FusedRead }
export type { FusedTarget, FusedTargetLookup } from './targets.js'

/** `read` asking for canonical text (the byte lanes, RUST_HTTP_LANES.md sections 3.1 and 6). */
export const canonicalRead = (read: Fused): Fused => ({
  ...read,
  request: `${read.request.slice(0, -1)},"canonical":true}`,
})

/** The response bytes of a canonical `read`'s result, its nested finds' `req` mutations replayed. */
export const settleFusedBytes = (
  { population }: { population?: PopulationContext },
  bytes: Uint8Array<ArrayBuffer>,
) => settleCanonical(bytes, population)

/**
 * The fused writes' bulk update / delete (src/fuse-write): a `find` request whose reads are
 * `payload.db.find(dbArgs)` (the operation's document read) and whose `afterRead` is the one the
 * operation runs on each result document (`depth`, `populate`, `showHiddenFields`, `draft`, the
 * request's locales; no select: the fused writes guard it), run on the result documents together
 * (crates/payload-fuse-mongo `run_documents`). `args` holds the operation's `collection`, `depth`,
 * `overrideAccess`, `populate`, `req`, `showHiddenFields`; field read access and population follow
 * `overrideAccess` as in the by-id writes' result reads (the operation checks no collection read
 * access). A string: the guard reason.
 */
export const fusedPageRequest = (
  args: Any,
  { db: dbArgs, draft }: { db: Record<string, unknown>; draft: unknown },
): Fused | string => {
  const prepared = prepare('find', args, true)
  if (!prepared) {
    return 'page:prepare'
  }
  const { payload, plan, planID, req, target } = prepared
  if (!isRequestValue(req.locale) || !isRequestValue(req.fallbackLocale)) {
    return 'page:args:values'
  }
  const depth = afterReadDepth(args.depth, payload.config)
  if (!Number.isFinite(depth)) {
    return 'page:depth'
  }
  const fieldAccessIDs = new Map<unknown, number>()
  const population =
    depth && 1 <= depth && plan.hasRelations
      ? populationRequest({
          args,
          currentDepth: 1,
          depth,
          draft,
          fieldAccessIDs,
          payload,
          plan,
          req,
          target,
        })
      : undefined
  if (typeof population === 'string') {
    return population
  }
  const db = encodeDb(target, 'find', dbArgs, true)
  if (typeof db === 'string') {
    return db
  }
  const fieldAccess = compiledFieldAccess(prepared, fieldAccessIDs)
  if (typeof fieldAccess === 'string') {
    return fieldAccess
  }
  const request = `{"op":"find","plan":${planID},"db":${db.db},${readRequest({
    currentDepth: 1,
    depth,
    fieldAccess,
    fieldAccessIDs,
    flattenLocales: true,
    payload,
    plan,
    req,
    select: undefined,
    showHiddenFields: Boolean(args.showHiddenFields),
  }).slice(0, -1)}${population ? `,"pop":${population.json}` : ''}}`
  return { op: 'find', payload: db.payload, population: population?.context, request, target }
}

const textRequestBuilders: Record<Op, (args: Any) => Fused | undefined> = {
  count: buildCountRequest,
  find: (args) => buildFindRequest(args, true),
  findByID: (args) => buildFindByIDRequest(args, false, true),
}

/**
 * The final JSON text of the operation's result when the fused lane serves the call, else
 * `undefined` (RUST_HTTP_LANES.md 3.2): the same guards and core as the materialized lane, with
 * the text canonical (`text === JSON.stringify(JSON.parse(text))`, section 3.1) so a response can
 * send it as its body. `undefined` has run nothing observable; the caller then runs the exact
 * operation. In shadow mode the text is checked against `JSON.stringify(JSON.parse(text))` and
 * `undefined` is returned (the exact operation serves the call; the materialized lane's shadow
 * compares the core's results with the exact lane).
 */
export const fusedOperationText = ({
  operation,
  operationArgs,
}: {
  operation: 'count' | 'find' | 'findByID' | 'findGlobal'
  operationArgs: Any
}): Promise<string | Uint8Array<ArrayBuffer> | undefined> | string | undefined => {
  if (mode === 'off' || operation === 'findGlobal') {
    return undefined
  }
  let fused: Fused | undefined
  try {
    fused = textRequestBuilders[operation](operationArgs)
  } catch {
    return guard('error')
  }
  if (!fused) {
    return undefined
  }
  if (fused.population) {
    // the dataloader / request state of a populated result needs its objects
    return guard('populate:text')
  }
  const request = `${fused.request.slice(0, -1)},"canonical":true}`
  const { replayJoins } = fused
  const finish = <T extends string | Uint8Array<ArrayBuffer>>(result: T) => {
    if (typeof result === 'string' && result.charCodeAt(0) === 33 /* ! */) {
      count(stats.bails, result.slice(1))
      return undefined
    }
    count(stats.hits, `${operation}:text`)
    if (mode === 'shadow') {
      const text = typeof result === 'string' ? result : new TextDecoder().decode(result)
      if (JSON.stringify(JSON.parse(text)) !== text) {
        recordDiff({
          kind: 'text',
          op: operation,
          request,
          ...firstDifference(JSON.stringify(JSON.parse(text)), text),
        })
      }
      return undefined
    }
    replayJoins?.(operationArgs.joins)
    return result
  }
  // the asynchronous backends give the text as the response body's bytes (`runBytes`)
  const { runBytes } = fused.target
  if (!runBytes) {
    const text = runNative({ ...fused, request })
    return typeof text === 'string' ? finish(text) : text.then(finish)
  }
  let pending: Promise<string | Uint8Array<ArrayBuffer>>
  try {
    pending = runBytes(request, fused.payload)
  } catch {
    return finish('!native:error')
  }
  return pending.then(finish)
}
