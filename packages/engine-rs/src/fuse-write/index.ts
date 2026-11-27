/**
 * Fused writes (packages/engine-rs/FUSED_WRITES.md): an eligible collection `create`,
 * `updateByID`, `deleteByID`, `update` (many) or `delete` (many) runs fully in Rust, its statements in a transaction the Rust driver
 * owns (D4), the result's `afterRead` / population through the fused read core, then the commit,
 * with no JS between the statements. Called by the write operation drop-ins of `../ops-write`:
 * `fuseWrite` returns the operation's promise, or `undefined` when the call runs on the exact lane
 * (a guard failed or the collection is ineligible; nothing observable ran).
 *
 * `PAYLOAD_RS_FUSE_WRITES`: `on` (unset: the default), `off`,
 * `shadow` (write lane-shadow, section 9: the fused lane runs in its transaction and reads the
 * touched collections before aborting, then the exact lane runs with the fused lane's clock and
 * ObjectId readings replayed and its result is returned; results, raw BSON state, the caller's
 * `data` and `req.context` are compared).
 */
import { randomUUID } from 'node:crypto'

import type { FusedRead } from '../fuse/index.js'
import type { RecordedReadings } from '../shadow-mongo/replay.js'
import type { FusedWriteTarget, WriteResult } from './targets.js'

import { sanitizeSortQuery } from '../../../payload/src/collections/operations/utilities/sanitizeSortQuery.js'
import { combineQueries } from '../../../payload/src/database/combineQueries.js'
import { sanitizeWhereQuery } from '../../../payload/src/database/sanitizeWhereQuery.js'
import { appendNonTrashedFilter } from '../../../payload/src/utilities/appendNonTrashedFilter.js'
import {
  canonicalRead,
  canonicalResult,
  evaluateCompiledAccess,
  fusedFindByIDRequest,
  fusedPageRequest,
  fusedResultValue,
  isAcceptedRequest,
  materializeFusedResult,
  settleFusedBytes,
} from '../fuse/index.js'
import { hasDataProperties, isInertTree, isPlainObject } from '../fuse/inert.js'
import { getCollectionPlan } from '../fuse/plan.js'
import { comparePopulated } from '../fuse/populate.js'
import { canonical, firstDifference } from '../fuse/shadow.js'
import { isAcceptedWhere } from '../fuse/where.js'
import {
  createReplayTapes,
  installBsonObjectIdReplay,
  installObjectIdReplay,
  installReplay,
} from '../shadow-mongo/replay.js'
import { getWritePlan } from './plan.js'
import { count, recordDiff, stats } from './stats.js'
import { getFusedWriteTarget } from './targets.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- operation args keep upstream's generics */
type Any = any

export { stats as fuseWriteStats } from './stats.js'
export { registerFusedWriteTarget } from './targets.js'

type Mode = 'off' | 'on' | 'shadow'

const mode: Mode =
  process.env.PAYLOAD_RS_FUSE_WRITES === 'off'
    ? 'off'
    : process.env.PAYLOAD_RS_FUSE_WRITES === 'shadow'
      ? 'shadow'
      : 'on'

type Exact = () => Promise<Any>

/** Keys of the `create` operation args (all must be data properties). */
const createArgKeys = [
  'autosave',
  'collection',
  'data',
  'depth',
  'disableTransaction',
  'disableVerificationEmail',
  'draft',
  'duplicateFromID',
  'overrideAccess',
  'overwriteExistingFiles',
  'populate',
  'publishAllLocales',
  'req',
  'select',
  'selectedLocales',
  'showHiddenFields',
]

const guard = (reason: string) => {
  count(stats.guards, reason)
  return undefined
}

/** Keys of the `updateByID` operation args (all must be data properties). */
const updateArgKeys = [
  'autosave',
  'collection',
  'data',
  'depth',
  'disableTransaction',
  'draft',
  'id',
  'overrideAccess',
  'overrideLock',
  'overwriteExistingFiles',
  'populate',
  'publishAllLocales',
  'req',
  'select',
  'showHiddenFields',
  'trash',
  'unpublishAllLocales',
]

/** Keys of the `deleteByID` operation args (all must be data properties). */
const deleteArgKeys = [
  'collection',
  'depth',
  'disableTransaction',
  'id',
  'overrideAccess',
  'overrideLock',
  'populate',
  'req',
  'select',
  'showHiddenFields',
  'trash',
]

/** The ids of collections without a custom ID type, as `ObjectId#toHexString` writes them. */
const objectIDHex = /^[0-9a-f]{24}$/

/**
 * The fused lane of operation `name`, or `undefined` (run the exact lane). `asBytes` (create and
 * updateByID, `fuseWriteBytes`): the promise resolves with `{ bytes }` when the fused lane served
 * the call, else with `{ doc }`, `exact`'s result.
 */
export const fuseWrite = (name: string, args: Any, exact: Exact, asBytes = false) => {
  if (mode === 'off') {
    return undefined
  }
  if (name === 'updateByID' || name === 'deleteByID') {
    return fuseByID(name, args, exact, asBytes)
  }
  if (name === 'update' || name === 'delete') {
    return fuseBulk(name, args, exact)
  }
  if (name !== 'create') {
    return undefined
  }
  if (!isPlainObject(args)) {
    return guard('args')
  }
  let checked: ReturnType<typeof checkCreate>
  try {
    checked = checkCreate(args)
  } catch {
    return guard('error')
  }
  if (!checked) {
    return undefined
  }
  return mode === 'shadow'
    ? shadowCreate(checked, args, exact, asBytes)
    : runCreate(checked, args, asBytes ? exactAsDoc(exact) : exact, asBytes)
}

/**
 * A REST create / updateByID of upstream's default handlers (the write byte lanes,
 * RUST_HTTP_LANES.md section 6): `{ bytes }`, the UTF-8 bytes of `JSON.stringify(result)`, when the
 * fused lane served the call, else `{ doc }`, the result of `exact` (the exact lane). Served calls
 * leave `req.context` and `req` as the materialized lane does, except for what only `req` holds
 * and no code reads after the operation (the callers' guarantee): the request dataloader is not
 * primed with the result's populated documents, and the creates' `data` (`req.data`) does not
 * get upstream's in-place `beforeValidate` changes.
 */
export const fuseWriteBytes = (name: 'create' | 'updateByID', args: Any, exact: Exact) =>
  fuseWrite(name, args, exact, true) ?? exactAsDoc(exact)()

const exactAsDoc = (exact: Exact) => () => exact().then((doc) => ({ doc }))

/** A native result that is a bail (`!<reason>`; a result as bytes never is). */
const isBail = (text: string | Uint8Array | undefined): text is `!${string}` =>
  typeof text === 'string' && text.charCodeAt(0) === 33 /* ! */

/**
 * The lane-shadow's check of a byte-lane result (`bytes`, canonical, crates/payload-fuse
 * `write_result`) against the exact lane's `result`, which the response body must hold as
 * `JSON.stringify` writes it, and against the `req` state the exact lane's nested finds left.
 */
const compareBytes = (bytes: Uint8Array<ArrayBuffer>, result: Any, req: Any) => {
  const { depths, result: resultBytes } = canonicalResult(bytes)
  const fusedJSON = new TextDecoder().decode(resultBytes)
  const exactJSON = JSON.stringify(result)
  if (fusedJSON !== exactJSON) {
    return { kind: 'bytes', ...firstDifference(exactJSON, fusedJSON) }
  }
  const depth = depths.at(-1)
  if (depth !== undefined && req.query?.depth !== depth) {
    return { exact: req.query?.depth, fused: depth, kind: 'req-state' }
  }
  return undefined
}

type Checked = { payload: Any; target: FusedWriteTarget }

/** A create past its guards; `documentID` / `read`: the document's ObjectId and its result read. */
type CheckedCreate = { documentID?: Any; read: FusedRead } & Checked

/**
 * A by-id write past its guards; `accessWhere`: the update / delete access result when it is a
 * where constraint (upstream combines it into the stored-document read); `read`: the result read
 * the guards built (`resultRead`).
 */
type CheckedByID = { accessWhere?: unknown; read: FusedRead } & Checked

const checkCreate = (args: Any) => {
  if (!hasDataProperties(args, createArgKeys)) {
    return guard('args')
  }
  const { collection, data, req } = args
  if (typeof collection !== 'object' || collection === null || !isAcceptedRequest(req)) {
    return guard('args:req')
  }
  if (req.transactionID) {
    return guard('transaction')
  }
  if (args.disableTransaction) {
    return guard('disableTransaction')
  }
  if (req.file !== undefined) {
    return guard('file')
  }
  // `draft` (with drafts `isSavingDraft`) is the prepare's; `autosave` runs updateLatestVersion
  if (
    args.autosave ||
    args.duplicateFromID !== undefined ||
    args.publishAllLocales !== undefined ||
    args.selectedLocales !== undefined
  ) {
    return guard('args:options')
  }
  if (isTSPrepare && isLocalizedPublish(args)) {
    return guard('drafts:localizedPublish')
  }
  if (args.select !== undefined && args.select !== null) {
    return guard('select')
  }
  if (!isPlainObject(data) || !isInertTree(data, false)) {
    return guard('data')
  }
  if ('id' in data || '_id' in data) {
    return guard('data:id')
  }
  const payload = req.payload
  const plan = getWritePlan(collection, payload)
  if (!plan.eligible) {
    count(stats.ineligible, plan.reason)
    return undefined
  }
  const readPlan = getCollectionPlan(collection, payload)
  if (!readPlan.eligible) {
    count(stats.ineligible, `read:${readPlan.reason}`)
    return undefined
  }
  if (!args.overrideAccess) {
    const evaluated = evaluateCompiledAccess(plan.access.create, {
      id: undefined,
      collectionConfig: collection.config,
      data,
      req,
    })
    if (evaluated.reason !== undefined) {
      return guard(evaluated.reason)
    }
  }
  const target = getFusedWriteTarget(payload.db)
  if (typeof target === 'string') {
    return guard(target)
  }
  // a data value the result read would populate from an unserved collection, known from an
  // earlier read of the same shape: before building this call's read
  const shape = readShape(args)
  const knownUnserved = shape === undefined ? undefined : unservedByShape.get(readPlan)?.get(shape)
  if (knownUnserved) {
    if (referencesCollections(collection.config.fields, data, knownUnserved)) {
      return guard('populate:unserved')
    }
    if (knownUnserved.length > 0 && isBackingOff(populateBackoff, collection)) {
      return guard('backoff:populate:related')
    }
  }
  // the result read's guards (population's access without `overrideAccess`, ...) depend on the
  // call, not on the document: checked before the prepare. Outside the shadow (whose tapes record
  // the document's ObjectId inside the fused run) and the TS prepare, the document's id is taken
  // here, in the synchronous run that reaches the prepare's other readings (the ObjectId is
  // upstream's next one: no other ObjectId is generated in between), so this read is the result
  // read
  const documentID =
    mode === 'shadow' || isTSPrepare ? undefined : new (target.objectIdClass as Any)()
  const read = resultRead(args, documentID ? documentID.toHexString() : placeholderID)
  if (!read) {
    return guard('read')
  }
  if (shape !== undefined && read.population) {
    rememberUnserved(readPlan, shape, read.population.unserved)
  }
  if (read.population?.reachesUnserved) {
    if (referencesCollections(collection.config.fields, data, read.population.unserved)) {
      // the result read would load an unserved collection (a bail after the statements)
      return guard('populate:unserved')
    }
    if (!knownUnserved && isBackingOff(populateBackoff, collection)) {
      return guard('backoff:populate:related')
    }
  }
  return { documentID, payload, read, target }
}

/**
 * The collections a result read of one shape leaves unserved (`populationRequest`'s `unserved`),
 * per read plan of the written collection and shape (`readShape`): a create whose data references
 * one is guarded before its read is built. A stale entry only sends calls to the exact lane.
 */
const unservedByShape = new WeakMap<object, Map<string, string[]>>()

/** The arguments `populationRequest`'s unserved collections depend on (`undefined`: not cached). */
const readShape = (args: Any) => {
  const { req } = args
  if (
    args.populate !== undefined ||
    typeof req.locale === 'object' ||
    typeof req.fallbackLocale === 'object'
  ) {
    return undefined
  }
  return JSON.stringify([
    args.depth ?? null,
    Boolean(args.draft),
    Boolean(args.overrideAccess),
    req.payloadAPI ?? null,
    req.locale ?? null,
    req.fallbackLocale ?? null,
  ])
}

const rememberUnserved = (readPlan: object, shape: string, unserved: string[]) => {
  let byShape = unservedByShape.get(readPlan)
  if (!byShape) {
    byShape = new Map()
    unservedByShape.set(readPlan, byShape)
  }
  if (!byShape.has(shape)) {
    byShape.set(shape, unserved)
  }
}

/** A relationship value beforeValidate keeps (its `''` / `'none'` / `'null'` become `null`). */
const isRelationshipValue = (value: unknown) =>
  value !== undefined && value !== null && value !== '' && value !== 'none' && value !== 'null'

/**
 * Whether `data` holds a relationship / upload value of one of `slugs` (in `fields`' traversal:
 * groups, rows, collapsibles, tabs, array and block rows): a create whose result read populates
 * it loads that collection.
 */
const referencesCollections = (fields: Any[], data: Any, slugs: string[]): boolean => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return false
  }
  for (const field of fields) {
    if (field.type === 'relationship' || field.type === 'upload') {
      const values = Array.isArray(data[field.name]) ? data[field.name] : [data[field.name]]
      for (const value of values) {
        if (!isRelationshipValue(value)) {
          continue
        }
        const isPolymorphic = typeof field.relationTo !== 'string'
        if (
          isPolymorphic
            ? typeof value !== 'object' || slugs.includes(value.relationTo)
            : slugs.includes(field.relationTo)
        ) {
          return true
        }
      }
      continue
    }
    if (field.type === 'array' || field.type === 'blocks') {
      const rows = data[field.name]
      for (const row of Array.isArray(rows) ? rows : []) {
        const rowFields =
          field.type === 'array'
            ? field.fields
            : field.blocks?.find((block: Any) => block.slug === row?.blockType)?.fields
        if (Array.isArray(rowFields) && referencesCollections(rowFields, row, slugs)) {
          return true
        }
      }
      continue
    }
    if (field.type === 'tabs') {
      for (const tab of field.tabs) {
        if (referencesCollections(tab.fields, 'name' in tab ? data[tab.name] : data, slugs)) {
          return true
        }
      }
      continue
    }
    if (Array.isArray(field.fields)) {
      if (referencesCollections(field.fields, 'name' in field ? data[field.name] : data, slugs)) {
        return true
      }
    }
  }
  return false
}

/**
 * Bails the drivers can only take after the statements ran (the transaction is aborted and the
 * exact lane reruns the call), which tend to repeat for a collection: a result read reaching a
 * collection the fused reads do not serve (`populate:related`, only for reads whose population
 * can reach one: `reachesUnserved`; e.g. the perf suite's `authors` with a join field, whenever
 * a document holds a value of the relationship). After one, the run lanes back off for that kind
 * of call per collection: the next 1, 2, 4, ... up to 64 such calls
 * run the exact lane directly (`backoff:<reason>`); such a call the lane runs through resets it.
 * A performance decision only: both lanes give upstream's result. The shadow lanes do not back
 * off.
 */
type Backoff = WeakMap<object, { next: number; skip: number }>

const populateBackoff: Backoff = new WeakMap()

const isBackingOff = (backoff: Backoff, collection: Any) => {
  const state = backoff.get(collection)
  if (!state || state.skip === 0) {
    return false
  }
  state.skip--
  return true
}

const backOff = (backoff: Backoff, collection: Any) => {
  const state = backoff.get(collection) ?? { next: 1, skip: 0 }
  state.skip = state.next
  state.next = Math.min(state.next * 2, 64)
  backoff.set(collection, state)
}

/** Records a run lane's native result (`text`) of an operation that reads `read`. */
const noteRun = (collection: Any, read: FusedRead, text: string | Uint8Array) => {
  const isDone = !isBail(text)
  if (read.population?.reachesUnserved) {
    if (text === '!populate:related') {
      backOff(populateBackoff, collection)
    } else if (isDone) {
      populateBackoff.delete(collection)
    }
  }
}

/** A well-formed ObjectId for the create's result read checked before the document id exists. */
const placeholderID = '000000000000000000000000'

/** The fused `findByID` request of the created document (create's `afterRead`). */
const resultRead = (args: Any, id: string, storedAccess?: unknown) =>
  fusedFindByIDRequest(
    {
      id,
      collection: args.collection,
      depth: args.depth,
      draft: args.draft,
      // the operation's own afterRead: field read access and population's nested finds follow
      // `overrideAccess` (the collection's read access is not checked, `fusedFindByIDRequest`)
      overrideAccess: args.overrideAccess,
      populate: args.populate,
      req: args.req,
      showHiddenFields: args.showHiddenFields,
    },
    storedAccess,
  )

/** The temporary TS prepare (`PAYLOAD_RS_FUSE_WRITES_PREPARE=ts`, creates only, never a default). */
const isTSPrepare = process.env.PAYLOAD_RS_FUSE_WRITES_PREPARE === 'ts'

/**
 * Whether a create / update of a collection with drafts on a localized config publishes all
 * locales (`config.localization && hasDraftsEnabled && publishAllLocales`, `publishAllLocales`
 * without the argument: `!draft && !(localizeStatus && locale !== 'all')`): upstream then runs
 * `validateLocalWithLocaleKeyedData`, which the Rust prepare models (section 12.4) and the TS
 * prepare does not (guarded).
 */
const isLocalizedPublish = (args: Any) => {
  const drafts = args.collection.config.versions?.drafts
  return Boolean(
    drafts &&
    args.req.payload.config.localization &&
    !args.draft &&
    !(drafts.localizeStatus && args.req.locale !== 'all'),
  )
}

/** Applies the state of `source` to `target` in place (upstream's in-place `beforeValidate`). */
const replayInto = (target: Any, source: Any) => {
  if (Array.isArray(target)) {
    target.length = source.length
  } else {
    for (const key of Object.keys(target)) {
      if (!(key in source)) {
        delete target[key]
      }
    }
  }
  for (const key of Object.keys(source)) {
    const from = source[key]
    const into = target[key]
    if (
      (isPlainObject(from) && isPlainObject(into)) ||
      (Array.isArray(from) && Array.isArray(into))
    ) {
      replayInto(into, from)
    } else if (into !== from || !(key in target)) {
      target[key] = from
    }
  }
  if (!Array.isArray(target)) {
    // upstream deletes and re-adds keys in place (field access, `delete siblingData[name]` then
    // the fallback value): the key order must be the source's too
    const order = Object.keys(source)
    const current = Object.keys(target)
    if (order.some((key, index) => current[index] !== key)) {
      for (const key of order) {
        const value = target[key]
        delete target[key]
        target[key] = value
      }
    }
  }
}

/** What preparing and running a fused create produced (a string: bailed before any statement). */
const fusedCreate = async (
  { documentID, read: checkedRead, target }: CheckedCreate,
  args: Any,
  copies: { context: Any; data: Any },
  isShadow: boolean,
  asBytes: boolean,
) => {
  const prepared = await target.prepareCreate(args, copies.data, copies.context, documentID)
  if (typeof prepared === 'string') {
    return { bail: prepared }
  }
  const read = documentID ? checkedRead : resultRead(args, prepared.id)
  if (!read) {
    return { bail: 'read' }
  }
  const input = { op: prepared.op, read, state: isShadow ? prepared.state() : undefined }
  const result: WriteResult = asBytes
    ? await target.runBytes({ ...input, read: canonicalRead(read) })
    : await target.run(input)
  // the REST write byte lanes' `data` is `req.data`, which no code reads after the operation
  // (`fuseWriteBytes`): its `beforeValidate` mutations are not replayed outside the shadow
  const data = isBail(result[0]) ? undefined : prepared.settle(result, asBytes && !isShadow)
  return { data, read, result, state: prepared.state }
}

/**
 * Copies of what upstream's create mutates in place (`args.data` in beforeValidate, `req.context`
 * in Payload's own field hooks): the fused lane works on them, so a bail leaves the arguments
 * untouched, and a success replays their final state. `undefined`: not copyable (e.g. functions in
 * the context).
 */
const copyMutable = (args: Any) => {
  try {
    return { context: structuredClone(args.req.context), data: structuredClone(args.data) }
  } catch {
    return undefined
  }
}

/**
 * What the fused create works on: with the Rust prepare `args.data` and `req.context` themselves
 * when the context is a plain object (the prepare only reads them, as one JSON text, and the
 * context writes of Payload's own hooks are assigned after a successful write, `settle`), else
 * `copyMutable`'s copies.
 */
const createInputs = (args: Any) =>
  !isTSPrepare && isPlainObject(args.req.context)
    ? { context: args.req.context, data: args.data }
    : copyMutable(args)

const runCreate = async (checked: CheckedCreate, args: Any, exact: Exact, asBytes: boolean) => {
  const copies = createInputs(args)
  if (!copies) {
    count(stats.guards, 'context')
    return exact()
  }
  let outcome: Awaited<ReturnType<typeof fusedCreate>>
  try {
    outcome = await fusedCreate(checked, args, copies, false, asBytes)
  } catch {
    // a prepare step threw (e.g. a ValidationError): the exact lane throws upstream's error
    count(stats.bails, 'prepare:threw')
    return exact()
  }
  if (outcome.bail !== undefined) {
    count(stats.bails, outcome.bail)
    return exact()
  }
  const text = outcome.result[0]
  noteRun(args.collection, outcome.read, text)
  if (isBail(text)) {
    if (text.charCodeAt(1) === 33) {
      // the commit failed after the statements were sent: its outcome is unknown, like upstream's
      count(stats.bails, 'commit')
      throw new Error(safeMessage(text.slice(2)))
    }
    count(stats.bails, text.slice(1))
    return exact()
  }
  count(stats.hits, 'create')
  if (typeof text !== 'string') {
    count(stats.bytes, 'create')
  }
  if (outcome.data !== args.data) {
    replayInto(args.data, outcome.data)
  }
  if (isPlainObject(args.req.context) && copies.context !== args.req.context) {
    replayInto(args.req.context, copies.context)
  }
  const result =
    typeof text === 'string'
      ? materializeFusedResult(withLoadTransaction(outcome.read, randomUUID()), text)
      : { bytes: settleFusedBytes(outcome.read, text) }
  // upstream's `commitTransaction` deletes the id `initTransaction` set (after the nested finds)
  delete args.req.transactionID
  return result
}

/**
 * Upstream populates a write's result inside the operation's transaction: the dataloader keys it
 * leaves carry that transaction's id (db-mongodb `beginTransaction`: a v4 uuid), which no later
 * call on the request matches.
 */
const withLoadTransaction = (read: FusedRead, loadTransactionID: unknown) => ({
  ...read,
  population: read.population && { ...read.population, loadTransactionID },
})

const safeMessage = (json: string) => {
  try {
    return String(JSON.parse(json).message)
  } catch {
    return json
  }
}

const errorSummary = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

/** The transaction id the exact lane's population keys carry (the first element of each key). */
const exactLoadTransaction = (req: Any) => {
  const keys = req.payloadDataLoader?._cacheMap?.keys?.()
  const first = keys?.next?.().value
  try {
    return typeof first === 'string' ? JSON.parse(first)[0] : undefined
  } catch {
    return undefined
  }
}

const shadowCreate = async (checked: CheckedCreate, args: Any, exact: Exact, asBytes: boolean) => {
  const exactResult = asBytes ? exactAsDoc(exact) : exact
  const copies = copyMutable(args)
  if (!copies) {
    count(stats.guards, 'context')
    return exactResult()
  }
  installReplay()
  installObjectIdReplay(checked.target.objectIdClass)
  installBsonObjectIdReplay(checked.target.rowIdClass)
  const tapes = createReplayTapes()
  const dataBefore = structuredClone(args.data)
  const contextBefore = structuredClone(args.req.context)
  let outcome: Awaited<ReturnType<typeof fusedCreate>> | undefined
  let fusedError: unknown
  try {
    outcome = await tapes.reference(() => fusedCreate(checked, args, copies, true, asBytes))
  } catch (error) {
    fusedError = error
  }
  const slug = args.collection.config.slug
  const report = (difference: Record<string, unknown>) =>
    recordDiff({ ...difference, collection: slug, op: 'create' })
  if (outcome?.bail !== undefined) {
    count(stats.bails, outcome.bail)
    return exactResult()
  }
  const text = outcome?.result[0]
  if (isBail(text)) {
    count(stats.bails, text.slice(1))
    return exactResult()
  }
  let result: Any
  try {
    result = await tapes.candidate(exact)
  } catch (error) {
    if (fusedError === undefined) {
      report({ kind: 'exact-threw', message: errorSummary(error) })
    } else if (errorSummary(fusedError) === errorSummary(error)) {
      count(stats.sameError, 'create')
    } else {
      report({ exact: errorSummary(error), fused: errorSummary(fusedError), kind: 'error' })
    }
    throw error
  }
  if (fusedError !== undefined || !outcome || text === undefined) {
    report({ fused: errorSummary(fusedError), kind: 'fused-threw' })
    return asBytes ? { doc: result } : result
  }
  count(stats.hits, 'create')
  if (typeof text !== 'string') {
    count(stats.bytes, 'create')
  }
  const unmatched = Object.fromEntries(
    // the exact lane's transaction id (db-mongodb `beginTransaction`: `uuid()`) has no fused
    // counterpart (D4: the Rust driver owns the session)
    Object.entries(tapes.unmatched()).filter(
      ([channel, reads]) => channel !== 'uuids' || reads.recorded > 0,
    ),
  )
  if (Object.keys(unmatched).length > 0) {
    report({ kind: 'readings', unmatched })
  }
  const exactState = await checked.target.readState(outcome.state())
  const fusedState = outcome.result[1]!
  if (exactState !== fusedState) {
    report({ kind: 'state', ...firstDifference(exactState, fusedState) })
  }
  if (typeof text !== 'string') {
    const difference = compareBytes(text, result, args.req)
    if (difference) {
      report(difference)
    }
  } else {
    const exactText = canonical(result)
    const fusedText = canonical(fusedResultValue(text))
    if (exactText !== fusedText) {
      report({ kind: 'result', ...firstDifference(exactText, fusedText) })
    }
    if (text.charCodeAt(0) === 35 /* # */) {
      const read = withLoadTransaction(outcome.read, exactLoadTransaction(args.req))
      const difference = await comparePopulated(text, read.population!, result)
      if (difference) {
        report({ ...difference })
      }
    }
  }
  // the fused lane's copies replayed onto the state before the call must equal what the exact
  // lane left in the arguments
  for (const [kind, before, copy, after] of [
    ['data', dataBefore, outcome.data, args.data],
    ['context', contextBefore, copies.context, args.req.context],
  ]) {
    replayInto(before, copy)
    const exactAfter = canonical(after)
    if (canonical(before) !== exactAfter) {
      report({ kind, ...firstDifference(exactAfter, canonical(before)) })
    }
  }
  return asBytes ? { doc: result } : result
}

type ByIDName = 'deleteByID' | 'updateByID'

const fuseByID = (name: ByIDName, args: Any, exact: Exact, asBytes: boolean) => {
  // read before `isPlainObject` narrows `args` to unknown values
  const collection = args?.collection
  if (!isPlainObject(args)) {
    return guard('args')
  }
  let checked: ReturnType<typeof checkByID>
  try {
    checked = checkByID(name, args)
  } catch {
    return guard('error')
  }
  if (!checked) {
    return undefined
  }
  return mode === 'shadow'
    ? serializedPerDocument(`${collection.config.slug}:${String(args.id)}`, () =>
        shadowByID(checked, name, args, exact, asBytes),
      )
    : runByID(checked, name, args, asBytes ? exactAsDoc(exact) : exact, asBytes)
}

/**
 * The write lane-shadow of one by-id call compares the fused run, the exact run and a state read
 * made one after the other, which holds only while no other call writes the same document in
 * between: concurrent shadowed writes of one document (e.g. test/versions' parallel draft saves)
 * run one at a time, in call order. Shadow mode only; upstream's own write conflicts between
 * concurrent transactions are an interleaving outcome, not a lane difference.
 */
const documentQueues = new Map<string, Promise<unknown>>()

const serializedPerDocument = <T>(key: string, run: () => Promise<T>): Promise<T> => {
  const previous = documentQueues.get(key) ?? Promise.resolve()
  const current = previous.then(run, run)
  const settled = current.then(
    () => undefined,
    () => undefined,
  )
  documentQueues.set(key, settled)
  void settled.then(() => {
    if (documentQueues.get(key) === settled) {
      documentQueues.delete(key)
    }
  })
  return current
}

/**
 * The guards of a fused `updateByID` / `deleteByID` (FUSED_WRITES.md section 13): besides the
 * create's, an ObjectId id, no `trash` (trashed documents and restores), and without
 * `overrideAccess` a compiled update / delete access that grants (`true`, or a where constraint,
 * which the stored-document read combines with the id as upstream's does).
 */
const checkByID = (name: ByIDName, args: Any) => {
  const isUpdate = name === 'updateByID'
  if (!hasDataProperties(args, isUpdate ? updateArgKeys : deleteArgKeys)) {
    return guard('args')
  }
  const { id, collection, data, req } = args
  if (typeof collection !== 'object' || collection === null || !isAcceptedRequest(req)) {
    return guard('args:req')
  }
  if (req.transactionID) {
    return guard('transaction')
  }
  if (args.disableTransaction) {
    return guard('disableTransaction')
  }
  if (typeof id !== 'string' || !objectIDHex.test(id)) {
    return guard('id')
  }
  if (args.select !== undefined && args.select !== null) {
    return guard('select')
  }
  if (args.trash) {
    return guard('trash')
  }
  if (!isPlainObject(req.context)) {
    return guard('context')
  }
  if (isUpdate) {
    if (req.file !== undefined) {
      return guard('file')
    }
    if (args.autosave || args.publishAllLocales !== undefined || args.unpublishAllLocales) {
      return guard('args:options')
    }
    if (!isPlainObject(data) || !isInertTree(data, false)) {
      return guard('data')
    }
    if ('id' in data || '_id' in data) {
      return guard('data:id')
    }
    if (collection.config.trash && 'deletedAt' in data) {
      return guard('trash')
    }
  }
  const payload = req.payload
  const plan = getWritePlan(collection, payload)
  if (!plan.eligible) {
    count(stats.ineligible, plan.reason)
    return undefined
  }
  if (!isUpdate && plan.hasScheduledPublish) {
    // deleteByID's deleteScheduledPublishJobs (the jobs collection)
    return guard('drafts:schedulePublish')
  }
  const readPlan = getCollectionPlan(collection, payload)
  if (!readPlan.eligible) {
    count(stats.ineligible, `read:${readPlan.reason}`)
    return undefined
  }
  let accessWhere: unknown
  if (!args.overrideAccess) {
    const evaluated = evaluateCompiledAccess(isUpdate ? plan.access.update : plan.access.delete, {
      id,
      collectionConfig: collection.config,
      data: isUpdate ? data : undefined,
      req,
    })
    if (evaluated.reason !== undefined) {
      return guard(evaluated.reason)
    }
    if (evaluated.value !== true) {
      accessWhere = evaluated.value
    }
  }
  const target = getFusedWriteTarget(payload.db)
  if (typeof target === 'string') {
    return guard(target)
  }
  // what an earlier result read of this shape left unserved: decided before building this one
  const shape = readShape(args)
  const knownUnserved = shape === undefined ? undefined : unservedByShape.get(readPlan)?.get(shape)
  if (knownUnserved) {
    if (isUpdate && referencesCollections(collection.config.fields, data, knownUnserved)) {
      return guard('populate:unserved')
    }
    if (knownUnserved.length > 0 && isBackingOff(populateBackoff, collection)) {
      return guard('backoff:populate:related')
    }
  }
  const read = resultRead(args, id, accessWhere)
  if (!read) {
    return guard('read')
  }
  if (shape !== undefined && read.population) {
    rememberUnserved(readPlan, shape, read.population.unserved)
  }
  if (
    !knownUnserved &&
    read.population?.reachesUnserved &&
    isBackingOff(populateBackoff, collection)
  ) {
    return guard('backoff:populate:related')
  }
  return { accessWhere, payload, read, target }
}

/** What preparing and running a fused updateByID / deleteByID produced (a string: a bail). */
const fusedByID = async (
  { accessWhere, read: checkedRead, target }: CheckedByID,
  name: ByIDName,
  args: Any,
  isShadow: boolean,
  asBytes: boolean,
) => {
  // the result read's `findOne` is also the stored-document read (with the access constraint);
  // outside the shadow nothing ran since the guards built it on the same arguments (the shadow
  // runs one document's calls one after the other, later)
  const fused = isShadow ? resultRead(args, args.id, accessWhere) : checkedRead
  if (!fused) {
    return { bail: 'read' }
  }
  const unserved = fused.population?.unserved
  if (name === 'updateByID' && unserved?.length) {
    if (referencesCollections(args.collection.config.fields, args.data, unserved)) {
      return { bail: 'populate:unserved' }
    }
  }
  const prepared = await target.prepareByID(name, args, unserved, accessWhere)
  if (typeof prepared === 'string') {
    return { bail: prepared }
  }
  // deleteByID's afterRead passes `draft: undefined` (its dataloader keys hold `null`)
  const read =
    name === 'deleteByID' && fused.population
      ? { ...fused, population: { ...fused.population, draft: undefined } }
      : fused
  const input = { op: prepared.op, read, state: isShadow ? prepared.state() : undefined }
  const result: WriteResult = asBytes
    ? await target.runBytes({ ...input, read: canonicalRead(read) })
    : await target.run(input)
  return { read, result, state: prepared.state }
}

const runByID = async (
  checked: CheckedByID,
  name: ByIDName,
  args: Any,
  exact: Exact,
  asBytes: boolean,
) => {
  let outcome: Awaited<ReturnType<typeof fusedByID>>
  try {
    outcome = await fusedByID(checked, name, args, false, asBytes)
  } catch {
    count(stats.bails, 'prepare:threw')
    return exact()
  }
  if (outcome.bail !== undefined) {
    count(stats.bails, outcome.bail)
    return exact()
  }
  const [text, , contextWrites] = outcome.result
  noteRun(args.collection, outcome.read, text)
  if (isBail(text)) {
    if (text.charCodeAt(1) === 33) {
      count(stats.bails, 'commit')
      throw new Error(safeMessage(text.slice(2)))
    }
    count(stats.bails, text.slice(1))
    return exact()
  }
  count(stats.hits, name)
  if (typeof text !== 'string') {
    count(stats.bytes, name)
  }
  if (contextWrites) {
    for (const [key, value] of checked.target.contextWrites(contextWrites)) {
      args.req.context[key] = value
    }
  }
  const result =
    typeof text === 'string'
      ? materializeFusedResult(withLoadTransaction(outcome.read, randomUUID()), text)
      : { bytes: settleFusedBytes(outcome.read, text) }
  // upstream's `commitTransaction` deletes the id `initTransaction` set (after the nested finds)
  delete args.req.transactionID
  return result
}

const shadowByID = async (
  checked: CheckedByID,
  name: ByIDName,
  args: Any,
  exact: Exact,
  asBytes: boolean,
) => {
  const exactResult = asBytes ? exactAsDoc(exact) : exact
  installReplay()
  installObjectIdReplay(checked.target.objectIdClass)
  installBsonObjectIdReplay(checked.target.rowIdClass)
  const tapes = createReplayTapes()
  const dataBefore = args.data === undefined ? undefined : structuredClone(args.data)
  let contextBefore: Any
  try {
    contextBefore = structuredClone(args.req.context)
  } catch {
    count(stats.guards, 'context')
    return exactResult()
  }
  let outcome: Awaited<ReturnType<typeof fusedByID>> | undefined
  let fusedError: unknown
  try {
    outcome = await tapes.reference(() => fusedByID(checked, name, args, true, asBytes))
  } catch (error) {
    fusedError = error
  }
  const slug = args.collection.config.slug
  const report = (difference: Record<string, unknown>) =>
    recordDiff({ ...difference, collection: slug, op: name })
  if (outcome?.bail !== undefined) {
    count(stats.bails, outcome.bail)
    return exactResult()
  }
  const text = outcome?.result[0]
  if (isBail(text)) {
    count(stats.bails, text.slice(1))
    return exactResult()
  }
  let result: Any
  try {
    result = await tapes.candidate(exact)
  } catch (error) {
    if (fusedError === undefined) {
      report({ kind: 'exact-threw', message: errorSummary(error) })
    } else if (errorSummary(fusedError) === errorSummary(error)) {
      count(stats.sameError, name)
    } else {
      report({ exact: errorSummary(error), fused: errorSummary(fusedError), kind: 'error' })
    }
    throw error
  }
  if (fusedError !== undefined || !outcome || text === undefined) {
    report({ fused: errorSummary(fusedError), kind: 'fused-threw' })
    return asBytes ? { doc: result } : result
  }
  count(stats.hits, name)
  if (typeof text !== 'string') {
    count(stats.bytes, name)
  }
  const unmatched = Object.fromEntries(
    Object.entries(tapes.unmatched()).filter(
      ([channel, reads]) => channel !== 'uuids' || reads.recorded > 0,
    ),
  )
  if (Object.keys(unmatched).length > 0) {
    report({ kind: 'readings', unmatched })
  }
  const exactState = await checked.target.readState(outcome.state())
  const fusedState = outcome.result[1] ?? ''
  if (exactState !== fusedState) {
    report({ kind: 'state', ...firstDifference(exactState, fusedState) })
  }
  if (typeof text !== 'string') {
    const difference = compareBytes(text, result, args.req)
    if (difference) {
      report(difference)
    }
  } else {
    const exactText = canonical(result)
    const fusedText = canonical(fusedResultValue(text))
    if (exactText !== fusedText) {
      report({ kind: 'result', ...firstDifference(exactText, fusedText) })
    }
    const loaded = withLoadTransaction(outcome.read, exactLoadTransaction(args.req))
    if (text.charCodeAt(0) === 35 /* # */ && loaded.population) {
      const difference = await comparePopulated(text, loaded.population, result)
      if (difference) {
        report({ ...difference })
      }
    }
  }
  // updateByID works on a deep copy of `data`: the exact lane leaves the caller's untouched
  if (canonical(dataBefore) !== canonical(args.data)) {
    report({ kind: 'data', ...firstDifference(canonical(args.data), canonical(dataBefore)) })
  }
  // the fused lane's context writes replayed onto the context before the call must equal what
  // the exact lane left
  const contextWrites = outcome.result[2]
  if (contextWrites) {
    for (const [key, value] of checked.target.contextWrites(contextWrites)) {
      contextBefore[key] = value
    }
  }
  const contextAfter = canonical(args.req.context)
  if (canonical(contextBefore) !== contextAfter) {
    report({ kind: 'context', ...firstDifference(contextAfter, canonical(contextBefore)) })
  }
  return asBytes ? { doc: result } : result
}

type BulkName = 'delete' | 'update'

/** Keys of the `update` operation args (all must be data properties). */
const updateManyArgKeys = [
  'autosave',
  'collection',
  'data',
  'depth',
  'disableTransaction',
  'disableVerificationEmail',
  'draft',
  'limit',
  'overrideAccess',
  'overrideLock',
  'overwriteExistingFiles',
  'populate',
  'publishAllLocales',
  'req',
  'select',
  'showHiddenFields',
  'sort',
  'trash',
  'unpublishAllLocales',
  'where',
]

/** Keys of the `delete` operation args (all must be data properties). */
const deleteManyArgKeys = [
  'collection',
  'depth',
  'disableTransaction',
  'overrideAccess',
  'overrideLock',
  'populate',
  'req',
  'select',
  'showHiddenFields',
  'trash',
  'where',
]

const bulkHit = (name: BulkName) => (name === 'update' ? 'updateMany' : 'deleteMany')

const fuseBulk = (name: BulkName, args: Any, exact: Exact) => {
  if (!isPlainObject(args)) {
    return guard('args')
  }
  let checked: ReturnType<typeof checkBulk>
  try {
    checked = checkBulk(name, args)
  } catch {
    return guard('error')
  }
  if (!checked) {
    return undefined
  }
  return mode === 'shadow'
    ? shadowBulk(checked, name, args, exact)
    : runBulk(checked, name, args, exact)
}

/**
 * The guards of a fused update-many / delete-many (FUSED_WRITES.md section 13): the by-id ones,
 * plus a `where` the fused reads accept, no `bulkOperationsSingleTransaction` (a transaction per
 * document), no `select`; update: no row ids in `data` (`copyDataWithFreshRowIDs` keeps a row id
 * only when the document has it) and no relationship to the collection itself when the results
 * populate (upstream's concurrent documents would read each other in an order that depends on
 * the interleaving). Then the fused read of the operation's documents and results
 * (`fusedPageRequest`).
 */
const checkBulk = (name: BulkName, args: Any) => {
  const isUpdate = name === 'update'
  if (!hasDataProperties(args, isUpdate ? updateManyArgKeys : deleteManyArgKeys)) {
    return guard('args')
  }
  const { collection, data, req, where } = args
  if (typeof collection !== 'object' || collection === null || !isAcceptedRequest(req)) {
    return guard('args:req')
  }
  if (req.transactionID) {
    return guard('transaction')
  }
  if (args.disableTransaction) {
    return guard('disableTransaction')
  }
  if (req.operation === 'validate') {
    return guard('validate')
  }
  const payload = req.payload
  if (payload.db.bulkOperationsSingleTransaction) {
    return guard('bulkSingleTransaction')
  }
  if (args.select !== undefined && args.select !== null) {
    return guard('select')
  }
  if (args.trash) {
    return guard('trash')
  }
  if (!isPlainObject(req.context) || '_payloadManagedDeletedUploads' in req.context) {
    return guard('context')
  }
  const config = collection.config
  if (
    !isPlainObject(where) ||
    !isAcceptedWhere({
      fields: config.flattenedFields,
      idOnly: !args.overrideAccess,
      payload,
      where,
    })
  ) {
    return guard('where')
  }
  if (isUpdate) {
    if (req.file !== undefined) {
      return guard('file')
    }
    if (
      args.draft ||
      args.autosave ||
      args.publishAllLocales !== undefined ||
      args.unpublishAllLocales
    ) {
      return guard('args:options')
    }
    if (!isPlainObject(data) || !isInertTree(data, false)) {
      return guard('data')
    }
    if ('id' in data || '_id' in data) {
      return guard('data:id')
    }
    if (config.trash && 'deletedAt' in data) {
      return guard('trash')
    }
    if (config.disableBulkEdit && !args.overrideAccess) {
      return guard('disableBulkEdit')
    }
    if (hasRowIDs(config.fields, data)) {
      return guard('data:rowIDs')
    }
    if (
      args.limit !== undefined &&
      args.limit !== null &&
      !(typeof args.limit === 'number' && Number.isFinite(args.limit))
    ) {
      return guard('limit')
    }
    const sort = args.sort || config.defaultSort
    if (!isBulkSort(sort) || (!args.overrideAccess && sort)) {
      return guard('sort')
    }
  }
  const plan = getWritePlan(collection, payload)
  if (!plan.eligible) {
    count(stats.ineligible, plan.reason)
    return undefined
  }
  if (!isUpdate && plan.hasScheduledPublish) {
    // delete.ts's deleteScheduledPublishJobs (the jobs collection)
    return guard('drafts:schedulePublish')
  }
  const readPlan = getCollectionPlan(collection, payload)
  if (!readPlan.eligible) {
    count(stats.ineligible, `read:${readPlan.reason}`)
    return undefined
  }
  if (!isUpdate && config.disableBulkDelete && !args.overrideAccess) {
    // delete.ts throws its APIError before anything else
    return guard('disableBulkDelete')
  }
  let accessResult: unknown = true
  if (!args.overrideAccess) {
    // field write access is evaluated per call in each document's prepare (`fieldAccessRequest`),
    // the results' field read access and population access in the result read (as the by-id
    // writes' result reads)
    const evaluated = evaluateCompiledAccess(isUpdate ? plan.access.update : plan.access.delete, {
      id: undefined,
      collectionConfig: config,
      data: isUpdate ? data : undefined,
      req,
    })
    if (evaluated.reason !== undefined) {
      return guard(evaluated.reason)
    }
    accessResult = evaluated.value
    if (accessResult !== true && sanitizeRewrites(config, payload, accessResult)) {
      // upstream's `sanitizeWhereQuery` of the combined where would rewrite (and mutate) it
      return guard('access:where:sanitize')
    }
  }
  if (isUpdate && readPlan.hasRelations && readPlan.relations.includes(config.slug)) {
    return guard('populate:self')
  }
  const target = getFusedWriteTarget(payload.db)
  if (typeof target === 'string') {
    return guard(target)
  }
  // update.ts / delete.ts `payload.db.find` of `combineQueries(where, accessResult)`
  const fullWhere = appendNonTrashedFilter({
    enableTrash: config.trash,
    trash: false,
    where: combineQueries(args.where, accessResult as never),
  })
  const db: Record<string, unknown> = isUpdate
    ? {
        collection: config.slug,
        // update.ts destructures `limit = 0` (a `null` stays)
        limit: args.limit === undefined ? 0 : args.limit,
        locale: req.locale,
        pagination: false,
        req,
        sort: sanitizeSortQuery({
          fields: config.flattenedFields,
          sort: args.sort || config.defaultSort,
        }),
        where: fullWhere,
      }
    : { collection: config.slug, locale: req.locale, req, select: undefined, where: fullWhere }
  const read = fusedPageRequest(
    {
      collection,
      depth: args.depth,
      overrideAccess: args.overrideAccess,
      populate: args.populate,
      req,
      showHiddenFields: args.showHiddenFields,
    },
    // update's `afterRead` passes `draft: false`, delete's `draft: undefined`
    { db, draft: isUpdate ? false : undefined },
  )
  if (typeof read === 'string') {
    return guard(read)
  }
  if (read.population?.reachesUnserved && isBackingOff(populateBackoff, collection)) {
    return guard('backoff:populate:related')
  }
  return { payload, read, target }
}

/** Whether `sanitizeWhereQuery` would change `where` (virtual paths: upstream rewrites in place). */
const sanitizeRewrites = (config: Any, payload: Any, where: unknown) => {
  const copy = structuredClone(where)
  sanitizeWhereQuery({ fields: config.flattenedFields, payload, where: copy as never })
  return canonical(copy) !== canonical(where)
}

const isBulkSort = (sort: unknown) =>
  sort === undefined ||
  sort === null ||
  typeof sort === 'string' ||
  (Array.isArray(sort) &&
    Object.getPrototypeOf(sort) === Array.prototype &&
    sort.every((item) => typeof item === 'string'))

/** Whether `data` holds an array or block row with an `id` (in `fields`' traversal). */
const hasRowIDs = (fields: Any[], data: Any): boolean => {
  if (typeof data !== 'object' || data === null) {
    return false
  }
  for (const field of fields) {
    if (field.type === 'array' || field.type === 'blocks') {
      const rows = data[field.name]
      if (rows !== undefined && rows !== null && !Array.isArray(rows)) {
        // localized rows (`{ [locale]: rows }`) or an invalid value: not modelled here
        return true
      }
      for (const row of rows ?? []) {
        if (typeof row !== 'object' || row === null || 'id' in row) {
          return true
        }
        const rowFields =
          field.type === 'array'
            ? field.fields
            : field.blocks?.find((block: Any) => block.slug === row.blockType)?.fields
        if (!Array.isArray(rowFields) || hasRowIDs(rowFields, row)) {
          return true
        }
      }
      continue
    }
    if (field.type === 'tabs') {
      for (const tab of field.tabs) {
        if (hasRowIDs(tab.fields, 'name' in tab ? data[tab.name] : data)) {
          return true
        }
      }
      continue
    }
    if (Array.isArray(field.fields)) {
      if (hasRowIDs(field.fields, 'name' in field ? data[field.name] : data)) {
        return true
      }
    }
  }
  return false
}

type CheckedBulk = { payload: Any; read: FusedRead; target: FusedWriteTarget }

const runBulk = async (checked: CheckedBulk, name: BulkName, args: Any, exact: Exact) => {
  let outcome: Awaited<ReturnType<FusedWriteTarget['runBulk']>>
  try {
    outcome = await checked.target.runBulk({ name, args, isShadow: false, read: checked.read })
  } catch {
    count(stats.bails, 'prepare:threw')
    return exact()
  }
  if (typeof outcome === 'string') {
    count(stats.bails, outcome)
    return exact()
  }
  const [text = '!result', , contextWrites] = outcome.result
  noteRun(args.collection, checked.read, text)
  if (text.charCodeAt(0) === 33 /* ! */) {
    if (text.charCodeAt(1) === 33) {
      count(stats.bails, 'commit')
      throw new Error(safeMessage(text.slice(2)))
    }
    count(stats.bails, text.slice(1))
    return exact()
  }
  count(stats.hits, bulkHit(name))
  if (contextWrites) {
    for (const [key, value] of checked.target.contextWrites(contextWrites)) {
      args.req.context[key] = value
    }
  }
  const page = materializeFusedResult(withLoadTransaction(checked.read, randomUUID()), text)
  // upstream's `commitTransaction` deletes the id `initTransaction` set (after the nested finds)
  delete args.req.transactionID
  return { docs: page.docs, errors: [] }
}

/**
 * `value` with every value a reading of the tapes generated replaced by its kind: clock readings
 * (ISO strings, extended JSON dates), ObjectIds made of a clock reading's second and a taped
 * counter, `bson-objectid` row ids. Upstream processes a bulk update's documents concurrently,
 * so which document receives which reading follows the interleaving (owner decision D1); the
 * write lane-shadow then compares the documents' effects up to that assignment.
 */
const withoutReadings = (value: unknown, recorded: RecordedReadings): unknown => {
  const clock = new Set(recorded.clock)
  const iso = new Set(recorded.clock.map((ms) => new Date(ms).toISOString()))
  const seconds = new Set(recorded.clock.map((ms) => Math.floor(ms / 1000)))
  const incs = new Set(recorded.incs.map((inc) => inc % 0xffffff))
  // `bson-objectid`'s `generate` returns the 12 bytes as a binary string
  const rows = new Set(
    recorded.objectIds.map((id) =>
      id.length === 12 ? Buffer.from(id, 'latin1').toString('hex') : id,
    ),
  )
  const hex = (text: string) => {
    if (rows.has(text)) {
      return '<row>'
    }
    if (
      /^[0-9a-f]{24}$/.test(text) &&
      seconds.has(parseInt(text.slice(0, 8), 16)) &&
      incs.has(parseInt(text.slice(18), 16))
    ) {
      return '<oid>'
    }
    return undefined
  }
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') {
      return iso.has(item) ? '<clock>' : (hex(item) ?? item)
    }
    if (Array.isArray(item)) {
      return item.map(walk)
    }
    if (typeof item !== 'object' || item === null) {
      return item
    }
    const record = item as Record<string, Any>
    const keys = Object.keys(record)
    if (keys.length === 1 && keys[0] === '$date' && typeof record.$date?.$numberLong === 'string') {
      return clock.has(Number(record.$date.$numberLong)) ? '<clock>' : item
    }
    if (keys.length === 1 && keys[0] === '$oid' && typeof record.$oid === 'string') {
      return hex(record.$oid) ?? item
    }
    return Object.fromEntries(keys.map((key) => [key, walk(record[key])]))
  }
  return walk(value)
}

/** The state's groups with each group's documents in a canonical order. */
const sortedGroups = (state: unknown) =>
  Array.isArray(state)
    ? state.map((group) =>
        Array.isArray(group) ? group.map((doc) => canonical(doc)).sort() : group,
      )
    : state

const shadowBulk = async (checked: CheckedBulk, name: BulkName, args: Any, exact: Exact) => {
  installReplay()
  installObjectIdReplay(checked.target.objectIdClass)
  installBsonObjectIdReplay(checked.target.rowIdClass)
  const tapes = createReplayTapes()
  let dataBefore: Any
  let contextBefore: Any
  try {
    dataBefore = args.data === undefined ? undefined : structuredClone(args.data)
    contextBefore = structuredClone(args.req.context)
  } catch {
    count(stats.guards, 'context')
    return exact()
  }
  const op = bulkHit(name)
  const report = (difference: Record<string, unknown>) =>
    recordDiff({ ...difference, collection: args.collection.config.slug, op })
  let outcome: Awaited<ReturnType<FusedWriteTarget['runBulk']>> | undefined
  let fusedError: unknown
  try {
    outcome = await tapes.reference(() =>
      checked.target.runBulk({ name, args, isShadow: true, read: checked.read }),
    )
  } catch (error) {
    fusedError = error
  }
  if (typeof outcome === 'string') {
    count(stats.bails, outcome)
    return exact()
  }
  const text = outcome?.result[0]
  if (text !== undefined && text.charCodeAt(0) === 33) {
    count(stats.bails, text.slice(1))
    return exact()
  }
  let result: Any
  try {
    result = await tapes.candidate(exact)
  } catch (error) {
    if (fusedError === undefined) {
      report({ kind: 'exact-threw', message: errorSummary(error) })
    } else if (errorSummary(fusedError) === errorSummary(error)) {
      count(stats.sameError, op)
    } else {
      report({ exact: errorSummary(error), fused: errorSummary(fusedError), kind: 'error' })
    }
    throw error
  }
  if (fusedError !== undefined || !outcome || text === undefined) {
    report({ fused: errorSummary(fusedError), kind: 'fused-threw' })
    return result
  }
  count(stats.hits, op)
  const unmatched = Object.fromEntries(
    Object.entries(tapes.unmatched()).filter(
      ([channel, reads]) => channel !== 'uuids' || reads.recorded > 0,
    ),
  )
  if (Object.keys(unmatched).length > 0) {
    report({ kind: 'readings', unmatched })
  }
  const recorded = tapes.recorded()
  const compare = (kind: string, exactValue: unknown, fusedValue: unknown, isGrouped: boolean) => {
    if (canonical(exactValue) === canonical(fusedValue)) {
      return
    }
    const normalize = (value: unknown) => {
      const normalized = withoutReadings(value, recorded)
      return canonical(isGrouped ? sortedGroups(normalized) : normalized)
    }
    const exactNormalized = normalize(exactValue)
    const fusedNormalized = normalize(fusedValue)
    if (exactNormalized === fusedNormalized) {
      // the same effects, the readings assigned to the documents in another order (D1)
      count(stats.hits, `${op}:interleaved`)
      return
    }
    report({ kind, ...firstDifference(exactNormalized, fusedNormalized) })
  }
  const exactState = await checked.target.readState(outcome.state)
  const fusedState = outcome.result[1] ?? ''
  try {
    compare('state', JSON.parse(exactState), JSON.parse(fusedState), true)
  } catch {
    report({ kind: 'state', ...firstDifference(exactState, fusedState) })
  }
  const page = fusedResultValue(text)
  compare('result', result, { docs: page.docs, errors: [] }, false)
  if (text.charCodeAt(0) === 35 /* # */ && checked.read.population) {
    const loaded = withLoadTransaction(checked.read, exactLoadTransaction(args.req))
    const difference = await comparePopulated(text, loaded.population!, {
      ...page,
      docs: result.docs,
    })
    if (difference) {
      report({ ...difference })
    }
  }
  const contextWrites = outcome.result[2]
  if (contextWrites) {
    for (const [key, value] of checked.target.contextWrites(contextWrites)) {
      contextBefore[key] = value
    }
  }
  // both operations work on copies of `data`; delete adds and removes its upload marker
  if (canonical(dataBefore) !== canonical(args.data)) {
    report({ kind: 'data', ...firstDifference(canonical(args.data), canonical(dataBefore)) })
  }
  if (canonical(contextBefore) !== canonical(args.req.context)) {
    report({
      kind: 'context',
      ...firstDifference(canonical(args.req.context), canonical(contextBefore)),
    })
  }
  return result
}
