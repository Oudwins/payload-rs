/**
 * Fused writes (packages/engine-rs/FUSED_WRITES.md): an eligible collection `create` (then
 * `updateByID` / `deleteByID`) runs fully in Rust, its statements in a transaction the Rust driver
 * owns (D4), the result's `afterRead` / population through the fused read core, then the commit,
 * with no JS between the statements. Called by the write operation drop-ins of `../ops-write`:
 * `fuseWrite` returns the operation's promise, or `undefined` when the call runs on the exact lane
 * (a guard failed or the collection is ineligible; nothing observable ran).
 *
 * `PAYLOAD_RS_FUSE_WRITES`: `off` (default until the Rust prepare lands and the bars hold), `on`,
 * `shadow` (write lane-shadow, section 9: the fused lane runs in its transaction and reads the
 * touched collections before aborting, then the exact lane runs with the fused lane's clock and
 * ObjectId readings replayed and its result is returned; results, raw BSON state, the caller's
 * `data` and `req.context` are compared).
 */
import { randomUUID } from 'node:crypto'

import type { FusedRead } from '../fuse/index.js'
import type { FusedWriteTarget } from './targets.js'

import {
  evaluateCompiledAccess,
  fusedFindByIDRequest,
  fusedResultValue,
  isAcceptedRequest,
  materializeFusedResult,
} from '../fuse/index.js'
import { hasDataProperties, isInertTree, isPlainObject } from '../fuse/inert.js'
import { getCollectionPlan } from '../fuse/plan.js'
import { comparePopulated } from '../fuse/populate.js'
import { canonical, firstDifference } from '../fuse/shadow.js'
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
  process.env.PAYLOAD_RS_FUSE_WRITES === 'on'
    ? 'on'
    : process.env.PAYLOAD_RS_FUSE_WRITES === 'shadow'
      ? 'shadow'
      : 'off'

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

/** The fused lane of operation `name`, or `undefined` (run the exact lane). */
export const fuseWrite = (name: string, args: Any, exact: Exact) => {
  if (mode === 'off' || name !== 'create') {
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
  return mode === 'shadow' ? shadowCreate(checked, args, exact) : runCreate(checked, args, exact)
}

type Checked = { payload: Any; target: FusedWriteTarget }

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
  if (
    args.draft ||
    args.autosave ||
    args.duplicateFromID !== undefined ||
    args.publishAllLocales !== undefined ||
    args.selectedLocales !== undefined
  ) {
    return guard('args:options')
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
    if (plan.hasFieldAccess || readPlan.hasFieldAccess) {
      return guard('access:fields')
    }
    if (readPlan.hasRelations) {
      // population's nested finds would check read access (the fused reads need overrideAccess)
      return guard('access:populate')
    }
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
  return { payload, target }
}

/** The fused `findByID` request of the created document (create's `afterRead`). */
const resultRead = (args: Any, id: string) =>
  fusedFindByIDRequest({
    id,
    collection: args.collection,
    depth: args.depth,
    draft: args.draft,
    // the collection's read access is not checked by create (field access: guarded above)
    overrideAccess: true,
    populate: args.populate,
    req: args.req,
    showHiddenFields: args.showHiddenFields,
  })

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
}

/** What preparing and running a fused create produced (a string: bailed before any statement). */
const fusedCreate = async (
  { target }: Checked,
  args: Any,
  copies: { context: Any; data: Any },
  isShadow: boolean,
) => {
  const prepared = await target.prepareCreate(args, copies.data, copies.context)
  if (typeof prepared === 'string') {
    return { bail: prepared }
  }
  const read = resultRead(args, prepared.id)
  if (!read) {
    return { bail: 'read' }
  }
  const result = await target.run({
    op: prepared.op,
    read,
    state: isShadow ? prepared.state : undefined,
  })
  return { data: prepared.data, read, result, state: prepared.state }
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

const runCreate = async (checked: Checked, args: Any, exact: Exact) => {
  const copies = copyMutable(args)
  if (!copies) {
    count(stats.guards, 'context')
    return exact()
  }
  let outcome: Awaited<ReturnType<typeof fusedCreate>>
  try {
    outcome = await fusedCreate(checked, args, copies, false)
  } catch {
    // a prepare step threw (e.g. a ValidationError): the exact lane throws upstream's error
    count(stats.bails, 'prepare:threw')
    return exact()
  }
  if (outcome.bail !== undefined) {
    count(stats.bails, outcome.bail)
    return exact()
  }
  const text = outcome.result[0]!
  if (text.charCodeAt(0) === 33 /* ! */) {
    if (text.charCodeAt(1) === 33) {
      // the commit failed after the statements were sent: its outcome is unknown, like upstream's
      count(stats.bails, 'commit')
      throw new Error(safeMessage(text.slice(2)))
    }
    count(stats.bails, text.slice(1))
    return exact()
  }
  count(stats.hits, 'create')
  replayInto(args.data, outcome.data)
  if (isPlainObject(args.req.context)) {
    replayInto(args.req.context, copies.context)
  }
  const result = materializeFusedResult(withLoadTransaction(outcome.read, randomUUID()), text)
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

const shadowCreate = async (checked: Checked, args: Any, exact: Exact) => {
  const copies = copyMutable(args)
  if (!copies) {
    count(stats.guards, 'context')
    return exact()
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
    outcome = await tapes.reference(() => fusedCreate(checked, args, copies, true))
  } catch (error) {
    fusedError = error
  }
  const slug = args.collection.config.slug
  const report = (difference: Record<string, unknown>) =>
    recordDiff({ ...difference, collection: slug, op: 'create' })
  if (outcome?.bail !== undefined) {
    count(stats.bails, outcome.bail)
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
      count(stats.sameError, 'create')
    } else {
      report({ exact: errorSummary(error), fused: errorSummary(fusedError), kind: 'error' })
    }
    throw error
  }
  if (fusedError !== undefined || !outcome || text === undefined) {
    report({ fused: errorSummary(fusedError), kind: 'fused-threw' })
    return result
  }
  count(stats.hits, 'create')
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
  const exactState = await checked.target.readState(outcome.state)
  const fusedState = outcome.result[1]!
  if (exactState !== fusedState) {
    report({ kind: 'state', ...firstDifference(exactState, fusedState) })
  }
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
  return result
}
