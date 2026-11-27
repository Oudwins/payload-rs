/**
 * Relationship population of the fused lanes (FUSE_CONTRACT.md section 9), the TS side: the
 * request part the native core needs for the nested finds, and the observable state a populated
 * result leaves behind upstream, reproduced from the native result: the shared documents (one
 * object per dataloader key), the request dataloader's cache entries (primed in load order with
 * those objects) and the `req` mutations of the nested `payload.find` calls
 * (`batchAndLoadDocs`' `req.transactionID = ...` and `createPayloadRequest`).
 */
import type { CollectionPlan } from './plan.js'
import type { FusedTarget } from './targets.js'

import { createDataloaderCacheKey } from '../../../payload/src/collections/dataloader.js'
import { sanitizeSortQuery } from '../../../payload/src/collections/operations/utilities/sanitizeSortQuery.js'
import { sanitizeWhereQuery } from '../../../payload/src/database/sanitizeWhereQuery.js'
import { createPayloadRequest } from '../../../payload/src/utilities/createPayloadRequest.js'
import { getSelectMode } from '../../../payload/src/utilities/getSelectMode.js'
import { hasDraftsEnabled } from '../../../payload/src/utilities/getVersionsConfig.js'
import { sanitizeFallbackLocale } from '../../../payload/src/utilities/sanitizeFallbackLocale.js'
import { getNativeEngine } from '../native.js'
import { laneFieldAccess, laneFunctionID } from './access.js'
import { isInertTree, isPlainObject } from './inert.js'
import { fusedJoinQuery, hasJoins, type JoinAccess, predictedAccessWhere } from './joins.js'
import { getCollectionPlan } from './plan.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- operation args keep upstream's generics */
type Any = any

/** What materializing a populated result needs from the call. */
export type PopulationContext = {
  args: Any
  /** the `draft` the operation passes to `afterRead` */
  draft: unknown
  /**
   * The transaction the loads ran in when it is not `req.transactionID` (the fused writes:
   * upstream populates a write's result inside the operation's transaction, src/fuse-write).
   */
  loadTransactionID?: unknown
  /** the `overrideAccess` the operation's own `afterRead` gets (its loads' keys) */
  ownOverrideAccess: Any
  payload: Any
  /**
   * A relationship of the read collection itself reaches a collection the nested finds do not
   * serve (its load bails natively): the fused writes guard on it before writing (their bail
   * would come after the statements).
   */
  reachesUnserved: boolean
  req: Any
  /** `populate?.[slug] ?? defaultPopulate` per related collection (the keys' `select`) */
  selects: Record<string, unknown>
  /** the operation's `currentDepth` */
  topCurrentDepth: number
  /** The collections of `reachesUnserved`: the read collection's relationships to them bail. */
  unserved: string[]
}

/** The dataloaders payload's `getDataLoader` created (packages/payload collections/dataloader.ts). */
const dataLoaders = ((globalThis as Record<symbol, unknown>)[Symbol.for('payload.dataLoaders')] ??=
  new WeakSet()) as WeakSet<object>

/** Payload's own request dataloader, unused so far (no cache entry, no pending batch). */
const isFreshDataLoader = (loader: Any) =>
  typeof loader === 'object' &&
  loader !== null &&
  dataLoaders.has(loader) &&
  !Object.hasOwn(loader, 'prime') &&
  loader._cacheMap instanceof Map &&
  loader._cacheMap.size === 0 &&
  (loader._batch == null || loader._batch.hasDispatched === true)

type NativeFuse = { fuseRegisterPlan: (json: string) => number }

const isSelect = (value: unknown, depth = 16): boolean => {
  if (!isPlainObject(value) || depth === 0) {
    return false
  }
  for (const key in value) {
    const item = value[key]
    if (typeof item !== 'boolean' && !isSelect(item, depth - 1)) {
      return false
    }
  }
  return isInertTree(value, false)
}

/**
 * The `"pop"` part of a request whose operation would populate (`depth && currentDepth <=
 * depth`), or the reason it cannot be fused. Nested finds run with the operation's `req`, so
 * only calls whose request state they can reproduce qualify: `overrideAccess: true`,
 * `req.i18n` set (`createPayloadRequest` runs synchronously), no transaction, a
 * fresh payload dataloader; with localization one locale and a fallback the nested finds keep.
 * Without `overrideAccess` the related collections' read access and field read access go to the
 * request as `FnId`s (`laneFunctionID`; `fieldAccessIDs`: the operation's compiled functions).
 */
export const populationRequest = ({
  args,
  currentDepth,
  depth,
  draft,
  fieldAccessIDs,
  ownOverrideAccess = args.overrideAccess,
  payload,
  plan,
  req,
  target,
}: {
  args: Any
  currentDepth: number
  depth: number
  draft: unknown
  fieldAccessIDs: Map<unknown, number>
  /** findByID's `overrideAccess = false` default (find and the writes pass theirs as given) */
  ownOverrideAccess?: Any
  payload: Any
  plan: { eligible: true } & CollectionPlan
  req: Any
  target: FusedTarget
}): { context: PopulationContext; json: string } | string => {
  const overrideAccess = Boolean(args.overrideAccess)
  const localization = payload.config.localization
  if (localization && !keepsLocales(req, localization)) {
    return 'populate:localization'
  }
  if (!req.i18n || req.transactionID != null) {
    return 'populate:req'
  }
  if (!isFreshDataLoader(req.payloadDataLoader)) {
    return 'populate:dataloader'
  }
  const populate = args.populate
  if (
    populate !== undefined &&
    (!isPlainObject(populate) || !Object.values(populate).every((value) => isSelect(value)))
  ) {
    return 'populate:arg'
  }
  const related: Record<string, Record<string, unknown>> = {}
  const selects: Record<string, unknown> = {}
  const seen = new Set<string>()
  /** Without `overrideAccess`: the collections whose nested finds run access functions. */
  const accessChecks: {
    joinAccess: JoinAccess[]
    plan: { eligible: true } & CollectionPlan
    slug: string
  }[] = []
  const unserved: string[] = []
  // the collections the levels currentDepth..depth can load
  let frontier: ({ eligible: true } & CollectionPlan)[] = [plan]
  for (let level = currentDepth; level <= depth && frontier.length > 0; level++) {
    const next: ({ eligible: true } & CollectionPlan)[] = []
    for (const from of frontier) {
      for (const slug of from.relations) {
        if (seen.has(slug)) {
          continue
        }
        seen.add(slug)
        const entry = relatedEntry({ slug, draft, overrideAccess, payload, populate, req, target })
        if (typeof entry === 'string') {
          // decided by the request: guarded here rather than bailing after the root read
          return `populate:${entry}`
        }
        if (entry) {
          related[slug] = entry.json
          selects[slug] = entry.select
          next.push(entry.plan)
          if (!overrideAccess) {
            accessChecks.push({ slug, joinAccess: entry.joinAccess, plan: entry.plan })
          }
        } else if (level === currentDepth) {
          unserved.push(slug)
        }
      }
    }
    frontier = next
  }
  // after the cheap checks above: the compiled read access and field read access the nested
  // finds run (evaluated natively where they run: `true` reads, `false` reads nothing)
  if (accessChecks.length > 0 && !keepsAccessRequest(req)) {
    return 'populate:access:req'
  }
  for (const { slug, joinAccess, plan: relatedPlan } of accessChecks) {
    const access = laneFunctionID(relatedPlan.access, fieldAccessIDs)
    if (typeof access === 'string') {
      return `populate:access:${access}`
    }
    const fieldAccess = laneFieldAccess(relatedPlan.fieldAccess, fieldAccessIDs)
    if (typeof fieldAccess === 'string') {
      return `populate:${fieldAccess}`
    }
    related[slug]!.access = access
    if (fieldAccess.length > 0) {
      related[slug]!.fieldAccess = fieldAccess
    }
    if (joinAccess.length > 0) {
      const checks = []
      for (const { slug: joinedSlug, fn, result } of joinAccess) {
        const id = laneFunctionID(fn, fieldAccessIDs)
        if (typeof id === 'string') {
          return `populate:joins:access:${id}`
        }
        checks.push({ id, slug: joinedSlug, result })
      }
      related[slug]!.joinAccess = checks
    }
  }
  const json = JSON.stringify({
    draft: Boolean(draft),
    joins: req.payloadAPI === 'GraphQL' ? false : {},
    locale: req.locale,
    related,
    req: { fallbackLocale: req.fallbackLocale, locale: req.locale, payloadAPI: req.payloadAPI },
  })
  return {
    context: {
      args,
      draft,
      ownOverrideAccess,
      payload,
      reachesUnserved: unserved.length > 0,
      req,
      selects,
      topCurrentDepth: currentDepth,
      unserved,
    },
    json,
  }
}

/**
 * Whether the nested finds' `createPayloadRequest` leaves the `req` properties access functions
 * may read as they are, besides `req.query.depth` (set by the core, crates/payload-fuse
 * `nested_request`) and the locales (`keepsLocales`): `req.user` set and with its `collection`
 * (else `null` / a copy with `collection`), `req.headers` set (else a new `Headers`).
 */
const keepsAccessRequest = (req: Any) =>
  req.user !== undefined &&
  (!req.user || (typeof req.user === 'object' && Boolean(req.user.collection))) &&
  Boolean(req.headers)

/**
 * Whether the nested finds' `createPayloadRequest({ fallbackLocale, locale })` (the key's values:
 * `req`'s, through JSON) leaves `req.locale` / `req.fallbackLocale` as they are: one locale (not
 * `all`), and a fallback that sanitizes to itself.
 */
const keepsLocales = (req: Any, localization: Any) => {
  if (typeof req.locale !== 'string' || req.locale === 'all' || req.locale === '*') {
    return false
  }
  const [fallbackLocale] = JSON.parse(JSON.stringify([req.fallbackLocale]))
  const sanitized = sanitizeFallbackLocale({ fallbackLocale, locale: req.locale, localization })
  return JSON.stringify([sanitized]) === JSON.stringify([req.fallbackLocale])
}

/**
 * A related collection nested finds may read (`undefined`: a load of it bails natively). Without
 * `overrideAccess` the nested finds run `executeAccess` with the collection's read access, which
 * must be compiled (evaluated natively: `true` reads, `false` returns no documents) and the
 * afterRead of the loaded documents runs their compiled field read access (both checked by the
 * caller); without a default sort (sort path validation checks field permissions), `'access'`
 * otherwise. A read access returning a where constraint for this `req` (predicted here) is
 * combined into the backend's nested reads (`accessResult`; the core checks the result where each
 * nested find runs). A collection with joins: the nested finds' `sanitizeJoinQuery` of `joins:
 * undefined` (the joined collections' read access predicted here, `joinAccess`, and evaluated
 * natively where each nested find runs); a string: the guard reason.
 */
const relatedEntry = ({
  slug,
  draft,
  overrideAccess,
  payload,
  populate,
  req,
  target,
}: {
  draft: unknown
  overrideAccess: boolean
  payload: Any
  populate: Any
  req: Any
  slug: string
  target: FusedTarget
}) => {
  const collection = Object.hasOwn(payload.collections, slug)
    ? payload.collections[slug]
    : undefined
  if (!collection) {
    return undefined
  }
  const plan = getCollectionPlan(collection, payload)
  if (!plan.eligible) {
    return undefined
  }
  const config = collection.config
  if (draft && hasDraftsEnabled(config)) {
    return undefined
  }
  if (!overrideAccess && config.defaultSort !== undefined) {
    return 'access'
  }
  const select = populate?.[slug] ?? config.defaultPopulate
  if (select !== undefined && !isSelect(select)) {
    return undefined
  }
  const findSelect = config.trash && select ? { ...select, deletedAt: true } : select
  const defaultSort = config.defaultSort
  if (
    defaultSort !== undefined &&
    typeof defaultSort !== 'string' &&
    !(Array.isArray(defaultSort) && defaultSort.every((item) => typeof item === 'string'))
  ) {
    return undefined
  }
  const sort = sanitizeSortQuery({ fields: config.flattenedFields, sort: defaultSort })
  let joins: unknown = req.payloadAPI === 'GraphQL' ? false : {}
  let joinAccess: JoinAccess[] = []
  if (hasJoins(config)) {
    const joinQuery = fusedJoinQuery({
      collectionConfig: config,
      joins: undefined,
      overrideAccess,
      payload,
      predict: true,
      req,
    })
    if (typeof joinQuery === 'string') {
      return joinQuery
    }
    joinAccess = joinQuery.access
    if (req.payloadAPI !== 'GraphQL') {
      joins = joinQuery.joins
    }
  }
  let backend: unknown = null
  let accessResult: unknown = undefined
  if (target.relatedBackend) {
    // the nested find's `combineQueries(where, accessResult)`, then `sanitizeWhereQuery`
    const accessWhere = overrideAccess ? undefined : predictedAccessWhere(config, req)
    const sanitizedAccessWhere = accessWhere && structuredClone(accessWhere)
    if (sanitizedAccessWhere) {
      sanitizeWhereQuery({ fields: config.flattenedFields, payload, where: sanitizedAccessWhere })
    }
    const result = target.relatedBackend(slug, {
      accessWhere: sanitizedAccessWhere,
      draft,
      joins,
      locale: req.locale,
      select: findSelect,
      sort,
    })
    if (typeof result === 'string') {
      return undefined
    }
    backend = result.backend
    accessResult = accessWhere
  }
  if (plan.id === undefined) {
    plan.id = (getNativeEngine() as unknown as NativeFuse).fuseRegisterPlan(plan.json)
  }
  return {
    config,
    joinAccess,
    json: {
      accessResult,
      auth: Boolean(config.auth),
      backend,
      numberID: (collection.customIDType || payload.db.defaultIDType) === 'number',
      plan: plan.id,
      select: findSelect ?? null,
      selectMode: findSelect ? getSelectMode(findSelect) : null,
      sort: sort ?? null,
      trash: Boolean(config.trash),
    },
    plan,
    select,
  }
}

type Envelope = {
  /** dataloader entries: `[slug, docID, depth, currentDepth, path | null]` */
  k: [string, number | string, number, number, (number | string)[] | null][]
  /** nested finds: their populate depth */
  n: number[]
  /** `[path, source path]`: the same object at `path` */
  p: [(number | string)[], (number | string)[]][]
  r: Any
  x: Any[]
}

const at = (root: Any, path: (number | string)[]) => {
  let value = root
  for (const segment of path) {
    value = value[segment]
  }
  return value
}

const parseEnvelope = (text: string): Envelope => {
  const envelope: Envelope = JSON.parse(text.slice(1))
  for (const [path, from] of envelope.p) {
    const parent = at(envelope, path.slice(0, -1))
    parent[path[path.length - 1]!] = at(envelope, from)
  }
  return envelope
}

/** `createDataloaderCacheKey(...)` of a load: the operation's own loads use its arguments, the
 * nested finds' loads the arguments `batchAndLoadDocs` passes them. */
const cacheKey = (
  context: PopulationContext,
  [slug, docID, depth, currentDepth]: Envelope['k'][number],
) => {
  const { args, draft, req } = context
  const isOwn = currentDepth === context.topCurrentDepth + 1
  return createDataloaderCacheKey({
    collectionSlug: slug,
    currentDepth,
    depth,
    docID,
    draft: draft as boolean,
    fallbackLocale: req.fallbackLocale,
    locale: req.locale,
    overrideAccess: isOwn ? context.ownOverrideAccess : Boolean(args.overrideAccess),
    populate: args.populate,
    select: context.selects[slug] as never,
    showHiddenFields: isOwn ? args.showHiddenFields : Boolean(args.showHiddenFields),
    transactionID: context.loadTransactionID ?? req.transactionID,
  })
}

/**
 * The result of a populated fused call (`#` + envelope), with upstream's observable state: the
 * dataloader primed with every loaded key (in load order, each with the object the result holds),
 * and the `req` mutations of the nested finds.
 */
export const materializePopulated = (text: string, context: PopulationContext) => {
  const envelope = parseEnvelope(text)
  const loader = context.req.payloadDataLoader
  for (const entry of envelope.k) {
    const path = entry[4]
    loader.prime(cacheKey(context, entry), path === null ? null : at(envelope, path))
  }
  replayNestedFinds(envelope.n, context)
  return envelope.r
}

/** The `req` mutations of the nested finds that ran with `depth`s (in start order). */
const replayNestedFinds = (depths: number[], { payload, req }: PopulationContext) => {
  for (const depth of depths) {
    req.transactionID = null
    void createPayloadRequest({
      depth,
      fallbackLocale: req.fallbackLocale,
      locale: req.locale,
      payload,
      req,
    }).catch(() => {})
  }
}

/**
 * A canonical fused result (crates/payload-fuse `write_result`, the byte lanes) as UTF-8 bytes:
 * the text itself, or for a populated call (`#{"n":[depth...],"r":result}`) the result's bytes and
 * the depths of the nested finds that ran (in start order). No side effects.
 */
export const canonicalResult = (bytes: Uint8Array<ArrayBuffer>) => {
  if (bytes[0] !== 35 /* # */) {
    return { depths: [], result: bytes }
  }
  // `#{"n":[`: the depths are numbers, so the first `]` closes them; `,"r":` follows
  const close = bytes.indexOf(93 /* ] */, 7)
  const depths: number[] = JSON.parse(new TextDecoder().decode(bytes.subarray(6, close + 1)))
  return { depths, result: bytes.subarray(close + 6, bytes.length - 1) }
}

/**
 * `canonicalResult`'s result after the nested finds' `req` mutations are replayed (`context`: the
 * request's population, set whenever the call can populate). The dataloader entries are not
 * primed: the byte lanes serve only calls whose `req` no code reads afterwards
 * (RUST_HTTP_LANES.md section 6).
 */
export const settleCanonical = (bytes: Uint8Array<ArrayBuffer>, context?: PopulationContext) => {
  const { depths, result } = canonicalResult(bytes)
  if (context) {
    replayNestedFinds(depths, context)
  }
  return result
}

/** The result of a populated fused call without its side effects (lane-shadow mode). */
export const populatedResult = (text: string) => parseEnvelope(text).r

/**
 * Lane-shadow check of a populated call, after the exact lane ran with the same `req`: the
 * dataloader keys (same keys, same order), the objects cached for them (the same object at the
 * same result path, or none for the fused `null`s / outside the result for the fused detached
 * documents) and the `req` state the nested finds leave.
 */
export const comparePopulated = async (
  text: string,
  context: PopulationContext,
  exactResult: Any,
): Promise<Record<string, unknown> | undefined> => {
  const envelope = parseEnvelope(text)
  const { req } = context
  const expectedKeys = envelope.k.map((entry) => cacheKey(context, entry))
  const cache: Map<string, Promise<unknown>> = req.payloadDataLoader._cacheMap
  const actualKeys = [...cache.keys()]
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    return {
      exact: JSON.stringify(actualKeys),
      fused: JSON.stringify(expectedKeys),
      kind: 'dataloader-keys',
    }
  }
  const paths = new Map<object, string>()
  const walk = (value: Any, path: (number | string)[]) => {
    if (typeof value !== 'object' || value === null) {
      return
    }
    if (paths.has(value)) {
      return
    }
    paths.set(value, JSON.stringify(['r', ...path]))
    for (const key of Object.keys(value)) {
      walk(value[key], [...path, Array.isArray(value) ? Number(key) : key])
    }
  }
  walk(exactResult, [])
  for (const [i, entry] of envelope.k.entries()) {
    const cached = await cache.get(expectedKeys[i]!)
    const path = entry[4]
    const expected = path === null ? 'null' : path[0] === 'x' ? 'detached' : JSON.stringify(path)
    const actual =
      cached === null
        ? 'null'
        : typeof cached === 'object'
          ? (paths.get(cached) ?? 'detached')
          : 'other'
    if (actual !== expected) {
      return { exact: actual, fused: expected, key: expectedKeys[i], kind: 'dataloader-value' }
    }
  }
  if (envelope.n.length > 0) {
    const depth = envelope.n[envelope.n.length - 1]
    // a fused write's commit deletes `req.transactionID` after the nested finds (`loadTransactionID`)
    const transactionID = context.loadTransactionID === undefined ? null : undefined
    if (req.transactionID !== transactionID || req.query?.depth !== depth) {
      return {
        exact: JSON.stringify({
          depth: req.query?.depth,
          transactionID: req.transactionID ?? 'undefined',
        }),
        fused: JSON.stringify({
          depth,
          transactionID: transactionID === undefined ? 'undefined' : null,
        }),
        kind: 'req',
      }
    }
  }
  return undefined
}
