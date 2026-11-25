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
import { getNativeEngine } from '../native.js'
import { createFunctionRegistry, serializeForEngine } from '../serialize.js'
import { compiledAccess, evaluateRequestOnlyAccess } from './access.js'
import { hasDataProperties, isInertTree, isPlainDataObject, isPlainObject } from './inert.js'
import { getCollectionPlan } from './plan.js'
import {
  comparePopulated,
  materializePopulated,
  populatedResult,
  type PopulationContext,
  populationRequest,
} from './populate.js'
import { canonical, firstDifference } from './shadow.js'
import { count, recordDiff, stats } from './stats.js'
import { getFusedTarget } from './targets.js'
import { isAcceptedWhere } from './where.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- operation args keep upstream's generics */
type Any = any

export { getFusedCallCount, stats as fuseStats } from './stats.js'
export { registerFusedTarget } from './targets.js'
export type { FusedTarget, FusedTargetLookup } from './targets.js'

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
 * The `field.access.read` results of a find / findByID (afterRead's `overrideAccess ? true :
 * await field.access.read({ id, blockData, collection, data, doc, req, siblingData,
 * skipCompilation })`, falsy: the field is removed and gets no default), one per function of
 * `plan.fieldAccess`, or the guard reason; `undefined` with `overrideAccess` or without such
 * functions. Only compiled functions that read nothing but `req` (`argKeys`): their result is the
 * same for every document and field of the call, so each is evaluated once, after every other
 * guard passed (`evaluateOnLane`: guard sampling as for collection access).
 */
const compiledFieldAccess = ({
  overrideAccess,
  plan,
  req,
}: Pick<Prepared, 'overrideAccess' | 'plan' | 'req'>): boolean[] | string | undefined => {
  if (overrideAccess || plan.fieldAccess.length === 0) {
    return undefined
  }
  const results: boolean[] = []
  for (const fn of plan.fieldAccess) {
    const result = evaluateRequestOnlyAccess(fn, req)
    if (typeof result === 'string') {
      return result
    }
    results.push(result)
  }
  return results
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

/** The `afterRead` part of a request: everything after `"db":<tree>`. */
const readRequest = ({
  currentDepth,
  depth,
  fieldAccess,
  flattenLocales,
  payload,
  plan,
  req,
  select,
  showHiddenFields,
}: {
  currentDepth: number
  depth: number
  fieldAccess: boolean[] | undefined
  flattenLocales: boolean
  payload: Any
  plan: { eligible: true } & CollectionPlan
  req: Any
  select: unknown
  showHiddenFields: boolean
}): string =>
  JSON.stringify({
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

/** The `db` part of a request for `payload.db[method](args)` on `target`, or a guard reason. */
const encodeDb = (
  target: FusedTarget,
  method: 'count' | 'find' | 'findOne',
  args: Record<string, unknown>,
): { db: string; payload: unknown } | string => {
  if (target.encode) {
    return target.encode(method, args)
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

const buildFindRequest = (args: Any): Fused | undefined => {
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
  const population =
    depth && currentDepth <= depth && plan.hasRelations
      ? populationRequest({ args, currentDepth, depth, draft, payload, plan, req, target })
      : undefined
  if (typeof population === 'string') {
    return guard(population)
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
    joins: req.payloadAPI === 'GraphQL' ? false : joins === false ? false : joins || {},
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
  const fieldAccess = compiledFieldAccess(prepared)
  if (typeof fieldAccess === 'string') {
    return guard(fieldAccess)
  }
  const request = `{"op":"find","plan":${planID},"db":${db.db},${readRequest({
    currentDepth,
    depth,
    fieldAccess,
    flattenLocales: true,
    payload,
    plan,
    req,
    select,
    showHiddenFields: Boolean(showHiddenFields),
  }).slice(0, -1)}${population ? `,"pop":${population.json}` : ''}}`
  return { op: 'find', payload: db.payload, population: population?.context, request, target }
}

export const fuseFind = (args: Any, exact: Exact): Promise<Any> | undefined => {
  if (mode === 'off') {
    return undefined
  }
  const fused = buildFindRequest(args)
  return fused && runFused(fused, args, exact)
}

const buildFindByIDRequest = (args: Any, isOperationResult = false): Fused | undefined => {
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
  if (replaceWithVersion && hasDraftsEnabled(config)) {
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
  const population =
    depth && currentDepth <= depth && plan.hasRelations
      ? populationRequest({
          args,
          currentDepth,
          depth,
          draft: replaceWithVersion,
          payload,
          plan,
          req,
          target,
        })
      : undefined
  if (typeof population === 'string') {
    return guard(population)
  }
  const fullWhere = appendNonTrashedFilter({
    enableTrash: config.trash,
    trash,
    where: combineQueries({ id: { equals: id } }, overrideAccess ? true : (accessResult as never)),
  })
  const db = encodeDb(target, 'findOne', {
    collection: config.slug,
    draftsEnabled: replaceWithVersion,
    joins: req.payloadAPI === 'GraphQL' ? false : joins === false ? false : joins || {},
    locale: req.locale,
    req: { fallbackLocale: undefined, locale: undefined, payloadAPI: undefined },
    select,
    where: fullWhere,
  })
  if (typeof db === 'string') {
    return guard(db)
  }
  const fieldAccess = compiledFieldAccess(prepared)
  if (typeof fieldAccess === 'string') {
    return guard(fieldAccess)
  }
  const request = `{"op":"findByID","plan":${planID},"db":${db.db},${readRequest({
    currentDepth,
    depth,
    fieldAccess,
    flattenLocales: flattenLocales === undefined ? true : flattenLocales,
    payload,
    plan,
    req,
    select,
    showHiddenFields: Boolean(showHiddenFields),
  }).slice(0, -1)}${population ? `,"pop":${population.json}` : ''}}`
  return { op: 'findByID', payload: db.payload, population: population?.context, request, target }
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
  const text = runNative(fused)
  if (typeof text !== 'string') {
    // an asynchronous backend: a bail continues on the exact lane
    return text.then((resolved) => settle(fused, resolved) ?? exact())
  }
  return settle(fused, text)
}

const settle = ({ op, population }: Fused, text: string): Promise<Any> | undefined => {
  if (text.charCodeAt(0) === 33 /* ! */) {
    count(stats.bails, text.slice(1))
    return undefined
  }
  count(stats.hits, op)
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
  const { op, request } = fused
  const before = argsSnapshot(args)
  const text = await runNative(fused)
  const isBail = text.charCodeAt(0) === 33
  if (isBail) {
    count(stats.bails, text.slice(1))
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
    if (after !== before) {
      recordDiff({ kind: 'mutation', op, request, ...firstDifference(after, before) })
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
export const fusedFindByIDRequest = (args: Any) => buildFindByIDRequest(args, true)
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

/**
 * The fused writes' bulk update / delete (src/fuse-write): a `find` request whose reads are
 * `payload.db.find(dbArgs)` (the operation's document read) and whose `afterRead` is the one the
 * operation runs on each result document (`depth`, `populate`, `showHiddenFields`, `draft`, the
 * request's locales; no select, no field access: the fused writes guard both), run on the result
 * documents together (crates/payload-fuse-mongo `run_documents`). `args` holds the operation's
 * `collection`, `depth`, `populate`, `req`, `showHiddenFields`; population needs
 * `overrideAccess: true` (as the write's own result read). A string: the guard reason.
 */
export const fusedPageRequest = (
  args: Any,
  { db: dbArgs, draft }: { db: Record<string, unknown>; draft: unknown },
): Fused | string => {
  const prepared = prepare('find', args)
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
  const population =
    depth && 1 <= depth && plan.hasRelations
      ? populationRequest({ args, currentDepth: 1, depth, draft, payload, plan, req, target })
      : undefined
  if (typeof population === 'string') {
    return population
  }
  const db = encodeDb(target, 'find', dbArgs)
  if (typeof db === 'string') {
    return db
  }
  const request = `{"op":"find","plan":${planID},"db":${db.db},${readRequest({
    currentDepth: 1,
    depth,
    fieldAccess: undefined,
    flattenLocales: true,
    payload,
    plan,
    req,
    select: undefined,
    showHiddenFields: Boolean(args.showHiddenFields),
  }).slice(0, -1)}${population ? `,"pop":${population.json}` : ''}}`
  return { op: 'find', payload: db.payload, population: population?.context, request, target }
}

const requestBuilders: Record<Op, (args: Any) => Fused | undefined> = {
  count: buildCountRequest,
  find: buildFindRequest,
  findByID: buildFindByIDRequest,
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
}): Promise<string | undefined> | string | undefined => {
  if (mode === 'off' || operation === 'findGlobal') {
    return undefined
  }
  let fused: Fused | undefined
  try {
    fused = requestBuilders[operation](operationArgs)
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
  const finish = (text: string): string | undefined => {
    if (text.charCodeAt(0) === 33 /* ! */) {
      count(stats.bails, text.slice(1))
      return undefined
    }
    count(stats.hits, `${operation}:text`)
    if (mode === 'shadow') {
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
    return text
  }
  const text = runNative({ ...fused, request })
  return typeof text === 'string' ? finish(text) : text.then(finish)
}
