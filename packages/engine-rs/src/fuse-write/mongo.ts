/**
 * The MongoDB target of the fused writes (FUSED_WRITES.md): registered by the driver lane
 * (`installDriverLane`) for each adapter with a Rust driver client. Per call its lookup requires
 * the adapter's write and read methods to still be those the lane saw, a driver client on a
 * replica set, no tracing / lane verify mode and no mongoose setting the lane refuses.
 *
 * Preparing a write (beforeValidate, the default validators, beforeChange, db-mongodb's write
 * transform and mongoose's casting) is WP-I's pure Rust `prepare_create` (crates/payload-fuse-write
 * `prepare`, section 12, with WP-I's plan of writePlan.ts, registered once), run by the operation
 * drivers inside the fused write, off the JS thread: the JS side captures the clock readings and
 * ObjectIds upstream would generate, in upstream's order (`captureCreateReadings`), with the
 * classes upstream generates them with.
 *
 * TEMPORARY (`PAYLOAD_RS_FUSE_WRITES_PREPARE=ts`, never a default): `prepareCreateTS` runs
 * upstream's own steps in JS instead (the field traversals, db-mongodb `create` / `createVersion`
 * up to their I/O, mongoose's document casting), so the statements, the Rust-owned transaction,
 * the result read and the write lane-shadow can be proven before the Rust prepare exists. Its
 * clock readings and ObjectIds are upstream's by construction (the same code reads them in the
 * same order).
 *
 * Only the driver lane imports this module (it loads db-mongodb's sources).
 */
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'

import type { DriverLane } from '../mongo-driver/lane.js'
import type { FusedWriteTarget } from './targets.js'

import { buildQuery } from '../../../db-mongodb/src/queries/buildQuery.js'
import { buildSortParam } from '../../../db-mongodb/src/queries/buildSortParam.js'
import { buildProjectionFromSelect } from '../../../db-mongodb/src/utilities/buildProjectionFromSelect.js'
import { getCollection } from '../../../db-mongodb/src/utilities/getEntity.js'
import { transform } from '../../../db-mongodb/src/utilities/transform.js'
import { sanitizeSortQuery } from '../../../payload/src/collections/operations/utilities/sanitizeSortQuery.js'
import { combineQueries } from '../../../payload/src/database/combineQueries.js'
import { beforeChange } from '../../../payload/src/fields/hooks/beforeChange/index.js'
import { beforeValidate } from '../../../payload/src/fields/hooks/beforeValidate/index.js'
import { lockedDocumentsCollectionSlug } from '../../../payload/src/locked-documents/config.js'
import { preferencesCollectionSlug } from '../../../payload/src/preferences/config.js'
import { appendNonTrashedFilter } from '../../../payload/src/utilities/appendNonTrashedFilter.js'
import { deepCopyObjectSimple } from '../../../payload/src/utilities/deepCopyObject.js'
import {
  getVersionsMax,
  hasDraftsEnabled,
} from '../../../payload/src/utilities/getVersionsConfig.js'
import { sanitizeInternalFields } from '../../../payload/src/utilities/sanitizeInternalFields.js'
import { buildAllLocalesPublicationHookDoc } from '../../../payload/src/versions/allLocalesPublicationStatus.js'
import { buildVersionCollectionFields } from '../../../payload/src/versions/buildCollectionFields.js'
import { appendVersionToQueryKey } from '../../../payload/src/versions/drafts/appendVersionToQueryKey.js'
import { loadCoreRuntimeAddon } from '../addon.js'
import { getFnIr } from '../compile/native.js'
import { encodeSnapshot, snapshotRequest } from '../compile/snapshot.js'
import { evaluateRequestOnlyAccess } from '../fuse/access.js'
import {
  castQuery,
  findOptionKeys,
  findSpec,
  isPristineModel,
  mongooseBlocksLane,
} from '../mongo-driver/lane.js'
import { verifyMode } from '../mongo-driver/verify.js'
import { isTracing } from '../shadow-mongo/trace.js'
import { registerFusedWriteTarget } from './targets.js'
import { buildWritePlan, type WritePlanResult } from './writePlan.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- mirrors untyped upstream code */
type Any = any

type FuseWriteAddon = {
  fuseWriteMongoFind?: (
    client: number,
    txn: number,
    plan: number,
    requestJson: string,
    reads: Uint8Array,
  ) => Promise<string[]>
  fuseWriteMongoOp?: (
    client: number,
    txn: number,
    op: Uint8Array,
    plan?: number,
    requestJson?: string,
    reads?: Uint8Array,
    state?: Uint8Array,
  ) => Promise<string[]>
  fuseWriteMongoState?: (client: number, state: Uint8Array) => Promise<string>
  fuseWritePrepare?: (planJson: string, requestJson: string, stored?: Uint8Array) => string
  fuseWriteRegisterPlan?: (planJson: string) => number
}

/** What `run` needs of the result read (fuse/mongo.ts `MongoPayload`). */
type ReadPayload = { bytes: Uint8Array; client: number; plan: number }

/** The adapter methods a fused write replaces or relies on (their identity is checked per call). */
const watchedMethods = [
  'beginTransaction',
  'commitTransaction',
  'count',
  'create',
  'createVersion',
  'deleteMany',
  'deleteOne',
  'deleteVersions',
  'find',
  'findOne',
  'findVersions',
  'rollbackTransaction',
  'updateMany',
  'updateOne',
  'updateVersion',
] as const

const isTSPrepare = process.env.PAYLOAD_RS_FUSE_WRITES_PREPARE === 'ts'

/** mongoose's `internalToObjectOptions` (the options `$__handleSave` serializes a new doc with). */
let saveToObjectOptions: Any

export const registerFusedMongoWriteTarget = ({
  adapter,
  getLane,
}: {
  adapter: Any
  getLane: (adapter: object) => DriverLane | undefined
}) => {
  const addon = loadCoreRuntimeAddon() as FuseWriteAddon
  const { fuseWriteMongoFind, fuseWriteMongoOp, fuseWriteMongoState } = addon
  if (
    typeof fuseWriteMongoOp !== 'function' ||
    typeof fuseWriteMongoState !== 'function' ||
    typeof fuseWriteMongoFind !== 'function'
  ) {
    return
  }
  const methods = watchedMethods.map((name) => adapter[name])
  registerFusedWriteTarget(adapter, (current: Any) => {
    for (let i = 0; i < watchedMethods.length; i++) {
      if (current[watchedMethods[i]!] !== methods[i]) {
        return 'mongo:adapter-methods'
      }
    }
    const lane = getLane(current)
    if (!lane) {
      return 'mongo:no-client'
    }
    if (!lane.replicaSet) {
      return 'mongo:no-replica-set'
    }
    if (current.transactionOptions === false) {
      // upstream's writes run without a transaction (db-mongodb's no-op `beginTransaction`)
      return 'mongo:no-transactions'
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
    const target: FusedWriteTarget = {
      backend: 'mongodb',
      contextWrites: (text) =>
        JSON.parse(text).map(([key, value]: Any) => [key, decodeTree(value)]),
      objectIdClass: lane.mongoose.Types.ObjectId,
      prepareByID: (name, args, unserved, accessWhere) =>
        prepareByID(lane, name, args, unserved, accessWhere),
      prepareCreate: (args, data, context, documentID) =>
        isTSPrepare
          ? prepareCreateTS(lane, args, data, context)
          : Promise.resolve(prepareCreateRust(lane, args, data, context, documentID)),
      readState: (state) => fuseWriteMongoState(lane.clientID, state),
      rowIdClass: rowIdClass(),
      run: ({ op, read, state }) => {
        const { bytes, client, plan } = read.payload as ReadPayload
        return fuseWriteMongoOp(
          client,
          lane.binding.txnBegin(client),
          op,
          plan,
          read.request,
          bytes,
          state,
        )
      },
      runBulk: async ({ name, args, isShadow, read }) => {
        const { bytes, client, plan } = read.payload as ReadPayload
        const txn = lane.binding.txnBegin(client)
        const found = await fuseWriteMongoFind(client, txn, plan, read.request, bytes)
        if (found.length !== 2) {
          // the native side aborted the transaction
          return (found[0] ?? '!bulk:find').slice(1)
        }
        let prepared: Awaited<ReturnType<typeof prepareBulk>>
        try {
          prepared = await prepareBulk(lane, name, args, JSON.parse(found[0]!), found[1]!)
        } catch {
          prepared = 'mongo:bulk:threw'
        }
        if (typeof prepared === 'string') {
          await lane.binding.txnEnd(txn, false)
          return prepared
        }
        const result = await fuseWriteMongoOp(
          client,
          txn,
          prepared.op,
          plan,
          read.request,
          bytes,
          isShadow ? prepared.state : undefined,
        )
        return { result, state: prepared.state }
      },
    }
    return target
  })
}

let rowIdClassValue: unknown

/** The `bson-objectid` class payload's `baseIDField` generates row ids with (one module instance). */
const rowIdClass = () => {
  if (rowIdClassValue === undefined) {
    const loaded = createRequire(new URL('../../../payload/package.json', import.meta.url))(
      'bson-objectid',
    )
    rowIdClassValue = loaded && 'default' in loaded ? loaded.default : loaded
  }
  return rowIdClassValue
}

/** The model of `slug` (and of its versions) if the lane may write it. */
const entity = (lane: DriverLane, slug: string) => {
  const { collectionConfig, Model } = getCollection({ adapter: lane.view, collectionSlug: slug })
  if (!isPristineModel(lane, Model) || mongooseBlocksLane(lane, Model)) {
    return 'model'
  }
  const VersionModel = collectionConfig.versions
    ? getCollection({ adapter: lane.view, collectionSlug: slug, versions: true }).Model
    : undefined
  if (VersionModel && !isPristineModel(lane, VersionModel)) {
    return 'model:versions'
  }
  return { collectionConfig, Model, VersionModel }
}

/** The write lane-shadow's reads of a document's state: the document and its versions. */
const documentState = (lane: DriverLane, Model: Any, VersionModel: Any, id: Any) =>
  lane.BSON.serialize({
    r: [
      { c: Model.collection.collectionName, f: { _id: id } },
      ...(VersionModel
        ? [{ c: VersionModel.collection.collectionName, f: { parent: id }, s: { _id: 1 } }]
        : []),
    ],
  })

/**
 * The clock readings and ObjectIds of an upstream `create` without hooks, in its order (the
 * readings `fuseWritePrepare` replays, FUSED_WRITES.md 12.3): one `bson-objectid` row id per array
 * row without an id (`baseIDField`'s default, beforeValidate, in traversal order), `createdAt`
 * (db-mongodb `create`), `updatedAt` (the write transform), the document's `_id` (mongoose's bson
 * `ObjectId`), with versions `saveVersion`'s `now` and the version's `_id`. `undefined`: the data
 * holds something whose readings this does not count (blocks, rows with a falsy id).
 */
const captureCreateReadings = (
  lane: DriverLane,
  fields: Any[],
  data: Any,
  hasVersions: boolean,
  takenDocumentID?: Any,
) => {
  const rows = countMissingRowIds(fields, data, true)
  if (rows === undefined) {
    return undefined
  }
  const RowId: Any = rowIdClass()
  const { ObjectId } = lane.mongoose.Types
  const ids: [string, string][] = []
  for (let i = 0; i < rows; i++) {
    ids.push(['row', new RowId().toHexString()])
  }
  const clock = [Date.now(), Date.now()]
  const documentID = takenDocumentID ?? new ObjectId()
  ids.push(['document', documentID.toHexString()])
  if (hasVersions) {
    clock.push(Date.now())
    ids.push(['version', new ObjectId().toHexString()])
  }
  return { clock, documentID, ids }
}

/**
 * Array rows without an `id` in `data` (row ids beforeValidate generates), in traversal order.
 * `isCreate`: beforeValidate's fallback of a field missing from `data` is its `defaultValue` (a
 * create's `doc` is empty), so the rows of array / blocks defaults count, and a missing named
 * group or tab is the `{}` placeholder beforeValidate gives it (whose fields' defaults count). An
 * update's fallbacks come from the stored document, which is read in the transaction: a row id
 * they take that is not counted here bails the prepare.
 */
const countMissingRowIds = (fields: Any[], data: Any, isCreate = false): number | undefined => {
  if (typeof data !== 'object' || data === null) {
    return 0
  }
  let count = 0
  for (const field of fields) {
    let nested: number | undefined = 0
    if (field.type === 'array' || field.type === 'blocks') {
      const rows =
        isCreate && data[field.name] === undefined ? field.defaultValue : data[field.name]
      for (const row of Array.isArray(rows) ? rows : []) {
        if (typeof row === 'object' && row !== null && 'id' in row && !row.id) {
          return undefined
        }
        // a block row's fields: the field's own block of its `blockType` (global blocks bail)
        const rowFields =
          field.type === 'array'
            ? field.fields
            : field.blocks?.find((block: Any) => block.slug === row?.blockType)?.fields
        if (!Array.isArray(rowFields)) {
          return undefined
        }
        nested = countMissingRowIds(rowFields, row, isCreate)
        if (nested === undefined) {
          return undefined
        }
        count += nested + (row?.id === undefined ? 1 : 0)
      }
      continue
    }
    if (field.type === 'tabs') {
      for (const tab of field.tabs) {
        nested = countMissingRowIds(
          tab.fields,
          'name' in tab ? placeholder(data[tab.name], isCreate) : data,
          isCreate,
        )
        if (nested === undefined) {
          return undefined
        }
        count += nested
      }
      continue
    }
    if (Array.isArray(field.fields)) {
      nested = countMissingRowIds(
        field.fields,
        'name' in field ? placeholder(data[field.name], isCreate) : data,
        isCreate,
      )
      if (nested === undefined) {
        return undefined
      }
      count += nested
    }
  }
  return count
}

/** A named group's / tab's data in beforeValidate: a non-object becomes `{}`. */
const placeholder = (value: unknown, isCreate: boolean) =>
  isCreate && typeof value !== 'object' ? {} : value

/**
 * A value in the boundary's tree encoding `fuseWritePrepare` decodes (`decode_value_bson`):
 * `undefined`, `-0` and non-finite numbers marked, single-`$`-key objects wrapped. Data and context
 * are inert (the dispatch's guards), anything else throws (the call then bails).
 */
const encodeTree = (value: unknown): unknown => {
  if (value === undefined) {
    return { $undefined: true }
  }
  if (typeof value === 'number') {
    if (Object.is(value, -0)) {
      return { $num: '-0' }
    }
    return Number.isFinite(value) ? value : { $num: String(value) }
  }
  if (Array.isArray(value)) {
    return value.map(encodeTree)
  }
  if (typeof value === 'object' && value !== null) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('encode')
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = encodeTree(item)
    }
    const keys = Object.keys(out)
    return keys.length === 1 && keys[0]!.startsWith('$') ? { $obj: out } : out
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error('encode')
  }
  return value
}

/** The inverse of `encodeTree` (the prepare's `callerData` and `contextWrites`). */
const decodeTree = (value: Any): Any => {
  if (Array.isArray(value)) {
    return value.map(decodeTree)
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  if (value.$undefined === true) {
    return undefined
  }
  if (typeof value.$num === 'string') {
    return Number(value.$num)
  }
  const source = value.$obj ?? value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    out[key] = decodeTree(source[key])
  }
  return out
}

/**
 * Whether a prepare of `plan` would bail on a compiled user function still in guard sampling's
 * first calls (or de-optimised): skipped before its encoding, readings and native call (an update
 * before its transaction). `isValidated`: the call runs the validators.
 */
const isInWarmup = (
  plan: { warmup: { hooks: number[]; validators: number[] } },
  isValidated: boolean,
) => {
  const { hooks, validators } = plan.warmup
  if (hooks.length === 0 && (!isValidated || validators.length === 0)) {
    return false
  }
  const fnIr = getFnIr()
  return (
    hooks.some((id) => fnIr.fnIrLaneInWarmup(id)) ||
    (isValidated && validators.some((id) => fnIr.fnIrLaneInWarmup(id)))
  )
}

const writePlans = new WeakMap<object, WritePlanResult>()

/** WP-I's write plan of `collection` (writePlan.ts), rebuilt when a property it assumed changed. */
const writePlanOf = (collection: Any, payload: Any) => {
  let plan = writePlans.get(collection)
  if (!plan || plan.volatile.some(([object, key, expected]) => object[key] !== expected)) {
    plan = buildWritePlan({ collection, payload })
    writePlans.set(collection, plan)
  }
  return plan
}

/**
 * The prepare request's `fieldAccess` without `overrideAccess`: per entry of the write plan's
 * `fieldAccess` (writePlan.ts), `field.access[operation]`'s result for the call (`null`: no
 * function for the operation), from compiled functions that read only `req`
 * (`evaluateRequestOnlyAccess`); a string: the reason the call runs on the exact lane.
 */
const fieldAccessRequest = (
  plan: { fieldAccess: Record<'create' | 'update', unknown>[] },
  operation: 'create' | 'update',
  args: Any,
): (boolean | null)[] | string | undefined => {
  if (args.overrideAccess || plan.fieldAccess.length === 0) {
    return undefined
  }
  const results: (boolean | null)[] = []
  for (const access of plan.fieldAccess) {
    const fn = access[operation]
    if (!fn) {
      results.push(null)
      continue
    }
    const result = evaluateRequestOnlyAccess(fn, args.req)
    if (typeof result === 'string') {
      return result
    }
    results.push(result)
  }
  return results
}

/**
 * `req` as the plan's compiled user functions read it (`snapshotRequest`, compile/snapshot.ts),
 * only when one of them reads it.
 */
const requestSnapshot = (plan: { readsReq: boolean }, req: Any) =>
  plan.readsReq ? encodeSnapshot(snapshotRequest(req)) : undefined

const prepareCreateRust = (
  lane: DriverLane,
  args: Any,
  data: Any,
  context: Any,
  documentID?: unknown,
) => {
  const resolved = entity(lane, args.collection.config.slug)
  if (typeof resolved === 'string') {
    return `mongo:${resolved}`
  }
  const { collectionConfig, Model, VersionModel } = resolved
  if (data.createdAt !== undefined || data.updatedAt !== undefined) {
    // whether upstream reads the clock for them depends on beforeChange's output
    return 'ctx:timestamps'
  }
  const plan = writePlanOf(args.collection, args.req.payload)
  if (plan.json === undefined) {
    return `plan:${plan.reason}`
  }
  if (slugDuplicateKey in context) {
    // a duplicate's mark for generateSlug (consumed and deleted by the hook)
    return 'context:slugDuplicate'
  }
  // a draft save validates only with `drafts.validate`
  const drafts = collectionConfig.versions?.drafts
  if (isInWarmup(plan, !(args.draft && drafts && !drafts.validate))) {
    return 'fn:warmup'
  }
  const fieldAccess = fieldAccessRequest(plan, 'create', args)
  if (typeof fieldAccess === 'string') {
    return fieldAccess
  }
  const planID = writePlanID(plan, plan.json)
  if (planID === undefined) {
    return 'prepare:addon'
  }
  const { req } = args
  let request: string
  try {
    request = JSON.stringify({
      context: encodeTree(context),
      data: encodeTree(data),
      draft: Boolean(args.draft),
      fallbackLanguage: req.i18n?.fallbackLanguage,
      fieldAccess,
      language: req.i18n?.language ?? 'en',
      // `req.locale` exactly when the config is localized (the prepare bails otherwise)
      locale:
        req.payload.config.localization && typeof req.locale === 'string' ? req.locale : undefined,
      op: 'create',
      overrideAccess: Boolean(args.overrideAccess),
      req: requestSnapshot(plan, req),
      user: req.user ? [req.user.collection, encodeTree(req.user.id)] : undefined,
    }).slice(0, -1)
  } catch {
    return 'prepare:encode'
  }
  const readings = captureCreateReadings(
    lane,
    collectionConfig.fields,
    data,
    Boolean(VersionModel),
    documentID,
  )
  if (!readings) {
    return 'ctx:rows'
  }
  // WP-I's prepare runs in the driver, inside the fused write (crates/payload-fuse-write `ops`):
  // its bails, a validation failure (no translations: the exact lane throws upstream's error) and
  // unused readings abort the transaction before any statement
  const op: Record<string, unknown> = {
    c: Model.collection.collectionName,
    op: 'create',
    p: `${request},"clock":${JSON.stringify(readings.clock)},"ids":${JSON.stringify(readings.ids)}}`,
    ...(VersionModel ? { vc: VersionModel.collection.collectionName } : {}),
    wp: planID,
  }
  const prepared = (templates: Record<string, unknown> | string | undefined) => {
    // the all-locales publish validation's unique-value lookups (the prepare decides whether it
    // makes any) run in the driver before the insert, with these templates or bailing with `ub`
    if (typeof templates === 'object') {
      op.ut = templates
    } else if (typeof templates === 'string') {
      op.ub = `mongo:${templates}`
    }
    return {
      id: readings.documentID.toHexString(),
      op: lane.BSON.serialize(op),
      settle: (result: string[]) => {
        for (const [key, value] of JSON.parse(result[2] || '[]')) {
          context[key] = decodeTree(value)
        }
        return result[3] ? decodeTree(JSON.parse(result[3])) : data
      },
      state: documentState(lane, Model, VersionModel, readings.documentID),
    }
  }
  if (resolvedUniqueTemplates.has(Model)) {
    return prepared(resolvedUniqueTemplates.get(Model))
  }
  return uniqueLookupTemplates(lane, collectionConfig, Model).then((templates) => {
    resolvedUniqueTemplates.set(Model, templates)
    return prepared(templates)
  })
}

/** `uniqueLookupTemplates`' settled value per model (a create reads it without waiting). */
const resolvedUniqueTemplates = new WeakMap<object, Record<string, unknown> | string | undefined>()

/** generateSlug's duplicate mark in `req.context` (fields/baseFields/slug/duplicateContext.ts). */
const slugDuplicateKey = '_slugDuplicateFallbackFields'

const writePlanIDs = new WeakMap<object, number>()

/** The native id of WP-I's write plan `plan` (registered once). */
const writePlanID = (plan: WritePlanResult, json: string) => {
  let id = writePlanIDs.get(plan)
  if (id === undefined) {
    const { fuseWriteRegisterPlan } = loadCoreRuntimeAddon() as FuseWriteAddon
    if (typeof fuseWriteRegisterPlan !== 'function') {
      return undefined
    }
    id = fuseWriteRegisterPlan(json)
    writePlanIDs.set(plan, id)
  }
  return id
}

/**
 * The id the statement templates are built with (a valid ObjectId: the casting takes the branches
 * of any ObjectId id); a call's id replaces it byte for byte, as 12 ObjectId bytes and as 24 hex
 * characters (inside strings too, e.g. the preferences key).
 */
const sentinelHex = randomBytes(12).toString('hex')
const sentinelBytes = Buffer.from(sentinelHex, 'hex')
const sentinelText = Buffer.from(sentinelHex, 'latin1')
/** The `updatedAt` of the max-versions delete's template (`md`), replaced per call by Rust. */
const sentinelDate = new Date(Date.UTC(2000, 0, 1) + randomBytes(4).readUInt32BE() * 1000)

type Template = { bytes: Buffer; hex: number[]; raw: number[] }

const positionsOf = (bytes: Buffer, needle: Buffer) => {
  const positions: number[] = []
  for (let at = bytes.indexOf(needle); at !== -1; at = bytes.indexOf(needle, at + 1)) {
    positions.push(at)
  }
  return positions
}

const toTemplate = (bytes: Buffer): Template => ({
  bytes,
  hex: positionsOf(bytes, sentinelText),
  raw: positionsOf(bytes, sentinelBytes),
})

/** `template` with the id `hex` (24 lowercase hex characters) in the sentinel's places. */
const withID = ({ bytes, hex: hexAt, raw }: Template, hex: string) => {
  const out = Buffer.from(bytes)
  const idBytes = Buffer.from(hex, 'hex')
  for (const at of raw) {
    idBytes.copy(out, at)
  }
  for (const at of hexAt) {
    out.write(hex, at, 'latin1')
  }
  return out
}

/** mongoose's cast of `query` on `Model` (what `find` / `deleteMany` / `findOneAndUpdate` send). */
const castFilter = (Model: Any, query: Any) => castQuery(Model.find(query), findOptionKeys).filter

const byIDTemplates = new WeakMap<object, Promise<string | Template>>()

/**
 * The cast filters of a collection's updateByID / deleteByID statements for the sentinel id, as
 * db-mongodb builds them (`buildQuery`) and mongoose casts them, once per collection model:
 * `q` the `{ id: { equals } }` of `updateOne` / `deleteOne`, `lf` the locks of
 * `checkDocumentLockStatus`, `mf` `enforceMaxVersions`' find (db-mongodb `findVersions` with
 * `limit: 1, page: max + 1, pagination: false, sort: '-updatedAt'`, as the driver lane sends it),
 * `vq` `deleteCollectionVersions`' filter, `pf` `deleteUserPreferences`' filter (non-auth), with
 * drafts `lv` `getLatestCollectionVersion`'s find of the latest version (db-mongodb
 * `findVersions` with `limit: 1, pagination: false, sort: '-updatedAt'`).
 */
const byIDTemplate = (lane: DriverLane, slug: string, Model: Any) => {
  let template = byIDTemplates.get(Model)
  if (!template) {
    template = buildByIDTemplate(lane, slug).catch(() => 'template')
    byIDTemplates.set(Model, template)
  }
  return template
}

const buildByIDTemplate = async (lane: DriverLane, slug: string): Promise<string | Template> => {
  const adapter = lane.view
  const config = adapter.payload.config
  const { collectionConfig, Model } = getCollection({ adapter, collectionSlug: slug })
  const parts: Record<string, unknown> = {
    q: castFilter(
      Model,
      await buildQuery({
        adapter,
        collectionSlug: slug,
        fields: collectionConfig.flattenedFields,
        where: { id: { equals: sentinelHex } },
      }),
    ),
  }
  const locks = adapter.payload.collections[lockedDocumentsCollectionSlug]
  if (locks) {
    const LockModel = getCollection({
      adapter,
      collectionSlug: lockedDocumentsCollectionSlug,
    }).Model
    parts.lf = castFilter(
      LockModel,
      await buildQuery({
        adapter,
        collectionSlug: lockedDocumentsCollectionSlug,
        fields: locks.config.flattenedFields,
        where: {
          and: [
            { 'document.relationTo': { equals: slug } },
            { 'document.value': { equals: sentinelHex } },
          ],
        },
      }),
    )
  }
  if (collectionConfig.versions) {
    const VersionModel: Any = getCollection({ adapter, collectionSlug: slug, versions: true }).Model
    const fields = buildVersionCollectionFields(config, collectionConfig, true)
    const parent = await buildQuery({ adapter, fields, where: { parent: { equals: sentinelHex } } })
    parts.vq = castFilter(VersionModel, parent)
    const max = getVersionsMax(collectionConfig)
    const isDrafts = hasDraftsEnabled(collectionConfig)
    if ((max > 0 || isDrafts) && (adapter.collation || lane.paginate.options !== undefined)) {
      return 'template:max-versions'
    }
    if (max > 0) {
      parts.mf = versionsFindSpec(lane, fields, VersionModel, parent, max)
      // the `deleteVersions` of `enforceMaxVersions` when the find returns a version: its
      // `updatedAt` (read-transformed, an ISO string) replaces the sentinel date `ms` in the cast
      parts.md = castFilter(
        VersionModel,
        await buildQuery({
          adapter,
          fields,
          where: {
            parent: { equals: sentinelHex },
            updatedAt: { less_than_equal: sentinelDate.toISOString() },
          },
        }),
      )
      parts.ms = sentinelDate
    }
    if (isDrafts) {
      parts.lv = await latestVersionFind(lane, collectionConfig, VersionModel, true, undefined)
    }
  }
  const preferences = adapter.payload.collections[preferencesCollectionSlug]
  if (preferences) {
    const PreferencesModel = getCollection({
      adapter,
      collectionSlug: preferencesCollectionSlug,
    }).Model
    parts.pf = castFilter(
      PreferencesModel,
      await buildQuery({
        adapter,
        collectionSlug: preferencesCollectionSlug,
        fields: preferences.config.flattenedFields,
        where: { key: { in: [`collection-${slug}-${sentinelHex}`] } },
      }),
    )
  }
  const template = toTemplate(Buffer.from(lane.BSON.serialize(parts)))
  return template.raw.length + template.hex.length === 0 ? 'template:id' : template
}

/**
 * getLatestCollectionVersion's find of the parent's latest version (drafts): updateByID's where
 * (`access`: its access result; no trash) with the version keys, combined with the parent and
 * `latest: true`, db-mongodb `findVersions` (`limit: 1`, `pagination: false`, `-updatedAt`) as the
 * driver lane sends it, for the sentinel id. `locale`: `findVersions`' (`req.locale`).
 */
const latestVersionFind = async (
  lane: DriverLane,
  collectionConfig: Any,
  VersionModel: Any,
  access: unknown,
  locale: string | undefined,
) => {
  const adapter = lane.view
  const config = adapter.payload.config
  const fields = buildVersionCollectionFields(config, collectionConfig, true)
  const where = appendNonTrashedFilter({
    enableTrash: collectionConfig.trash,
    trash: false,
    where: combineQueries({ id: { equals: sentinelHex } }, access as never),
  })
  const latest = await buildQuery({
    adapter,
    fields,
    locale,
    where: combineQueries(appendVersionToQueryKey(where), {
      and: [{ parent: { equals: sentinelHex } }, { latest: { equals: true } }],
    }),
  })
  return versionsFindSpec(lane, fields, VersionModel, latest, undefined)
}

/** The driver lane's `laneFindVersions` / `lanePaginate` with `pagination: false`, `limit: 1`, `-updatedAt`. */
const versionsFindSpec = (
  lane: DriverLane,
  fields: Any,
  VersionModel: Any,
  filter: Any,
  skip: number | undefined,
) =>
  laneFindSpec(lane, fields, VersionModel, filter, {
    limit: 1,
    skip,
    sort: '-updatedAt',
    timestamps: true,
  })

/** The driver lane's find with `pagination: false` (`lanePaginate`): `Model.find(filter)` as cast. */
const laneFindSpec = (
  lane: DriverLane,
  fields: Any,
  Model: Any,
  filter: Any,
  {
    limit,
    locale,
    skip,
    sort,
    timestamps,
  }: { limit: number; locale?: string; skip?: number; sort: unknown; timestamps: boolean },
) => {
  const adapter = lane.view
  const sortParam = buildSortParam({
    adapter,
    config: adapter.payload.config,
    fields,
    locale,
    sort: sort as never,
    timestamps,
  })
  const projection = buildProjectionFromSelect({ adapter, fields, select: undefined })
  const query = Model.find(filter, projection, { limit, session: undefined, skip })
  query.select('')
  query.sort(sortParam)
  query.lean(true)
  return findSpec(castQuery(query, findOptionKeys))
}

/**
 * The finds of `fieldValueExists` (the all-locales publish validation's unique lookups,
 * crates/payload-fuse-write `unique`), per unique field the prepare can look up and locale:
 * `payload.find({ where: { [path]: { equals } }, locale, limit: 2, pagination: false })` as
 * db-mongodb builds it (`buildQuery`, the find operation's default sort) and mongoose casts it,
 * with a sentinel value per kind of path (a string, a number, an ObjectId and its hex). Paths
 * under arrays, blocks or localized groups / tabs get none (the prepare bails there).
 * `undefined`: the collection publishes no locales together or has no unique field.
 */
const uniqueLookupTemplates = (lane: DriverLane, collectionConfig: Any, Model: Any) => {
  let templates = uniqueTemplates.get(Model)
  if (!templates) {
    templates = buildUniqueLookupTemplates(lane, collectionConfig, Model).catch(
      () => 'template:unique',
    )
    uniqueTemplates.set(Model, templates)
  }
  return templates
}

const uniqueTemplates = new WeakMap<object, Promise<Record<string, unknown> | string | undefined>>()

const uniqueSentinels = {
  num: randomBytes(4).readUInt32BE() + 0.5,
  oid: randomBytes(12).toString('hex'),
  str: `\u0000unique:${randomBytes(12).toString('hex')}`,
}

const buildUniqueLookupTemplates = async (
  lane: DriverLane,
  collectionConfig: Any,
  Model: Any,
): Promise<Record<string, unknown> | string | undefined> => {
  const adapter = lane.view
  const config = adapter.payload.config
  if (!config.localization || !hasDraftsEnabled(collectionConfig)) {
    return undefined
  }
  const paths: [string, 'num' | 'oid' | 'str'][] = []
  collectUniquePaths(adapter.payload, collectionConfig.fields, '', paths)
  if (paths.length === 0) {
    return undefined
  }
  if (adapter.collation) {
    return 'template:unique:collation'
  }
  const sentinel = { num: uniqueSentinels.num, oid: uniqueSentinels.oid, str: uniqueSentinels.str }
  const templates: Record<string, unknown>[] = []
  for (const locale of config.localization.localeCodes) {
    for (const [path, kind] of paths) {
      const query = await buildQuery({
        adapter,
        collectionSlug: collectionConfig.slug,
        fields: collectionConfig.flattenedFields,
        locale,
        where: { [path]: { equals: sentinel[kind] } },
      })
      templates.push({
        f: laneFindSpec(lane, collectionConfig.flattenedFields, Model, query, {
          limit: 2,
          locale,
          sort: sanitizeSortQuery({
            fields: collectionConfig.flattenedFields,
            sort: collectionConfig.defaultSort,
          }),
          timestamps: Boolean(collectionConfig.timestamps),
        }),
        k: kind,
        l: locale,
        p: path,
      })
    }
  }
  return {
    c: Model.collection.collectionName,
    s: {
      num: sentinel.num,
      oid: new lane.mongoose.Types.ObjectId(sentinel.oid),
      str: sentinel.str,
    },
    t: templates,
  }
}

/** The unique fields `validateUniqueConstraints` reaches outside rows and localized containers. */
const collectUniquePaths = (
  payload: Any,
  fields: Any[],
  prefix: string,
  out: [string, 'num' | 'oid' | 'str'][],
) => {
  for (const field of fields) {
    if (field.type === 'tabs') {
      for (const tab of field.tabs) {
        if ('name' in tab && tab.name) {
          if (!tab.localized) {
            collectUniquePaths(payload, tab.fields, `${prefix}${tab.name}.`, out)
          }
        } else {
          collectUniquePaths(payload, tab.fields, prefix, out)
        }
      }
      continue
    }
    if (field.type === 'array' || field.type === 'blocks') {
      continue
    }
    if (Array.isArray(field.fields)) {
      if (!('name' in field) || !field.name) {
        collectUniquePaths(payload, field.fields, prefix, out)
      } else if (!field.localized) {
        collectUniquePaths(payload, field.fields, `${prefix}${field.name}.`, out)
      }
      continue
    }
    if (!field.unique || !field.name || field.hasMany) {
      continue
    }
    const kind = uniqueKind(payload, field)
    if (kind) {
      out.push([`${prefix}${field.name}`, kind])
    }
  }
}

const uniqueKind = (payload: Any, field: Any) => {
  switch (field.type) {
    case 'code':
    case 'email':
    case 'radio':
    case 'select':
    case 'slug':
    case 'text':
    case 'textarea':
      return 'str'
    case 'number':
      return 'num'
    case 'relationship':
    case 'upload':
      return typeof field.relationTo === 'string' &&
        payload.collections[field.relationTo] &&
        !payload.collections[field.relationTo].customIDType
        ? 'oid'
        : undefined
    default:
      return undefined
  }
}

/**
 * Per versions model, the `latestVersionFind` templates of where-constraint access results seen
 * (keyed by the where and locale; a bounded cache: an access result that varies per user only
 * rebuilds). A string: the call runs on the exact lane.
 */
const latestAccessTemplates = new WeakMap<object, Map<string, Promise<string | Template>>>()

const latestAccessTemplate = (
  lane: DriverLane,
  collectionConfig: Any,
  VersionModel: Any,
  access: unknown,
  locale: string | undefined,
) => {
  let byKey = latestAccessTemplates.get(VersionModel)
  if (!byKey) {
    byKey = new Map()
    latestAccessTemplates.set(VersionModel, byKey)
  }
  const key = `${typedKey(locale)}|${typedKey(access)}`
  let template = byKey.get(key)
  if (!template) {
    if (byKey.size >= 64) {
      byKey.clear()
    }
    template = (async () => {
      const lv = await latestVersionFind(lane, collectionConfig, VersionModel, access, locale)
      const built = toTemplate(Buffer.from(lane.BSON.serialize({ lv })))
      return built.raw.length + built.hex.length === 0 ? 'template:id' : built
    })().catch(() => 'template:access')
    byKey.set(key, template)
  }
  return template
}

/** A key telling apart every inert value (`undefined`, `-0` and Dates included). */
const typedKey = (value: unknown): string => {
  if (value === undefined) {
    return 'u'
  }
  if (value instanceof Date) {
    return `d${value.getTime()}`
  }
  if (Array.isArray(value)) {
    return `[${value.map(typedKey).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}:${typedKey(item)}`)
      .join(',')}}`
  }
  return Object.is(value, -0) ? '-0' : JSON.stringify(value)
}

/** The collection of `slug`'s model if the lane may write it (`undefined`: none). */
const pristineModel = (lane: DriverLane, slug: string) => {
  if (!lane.view.payload.collections[slug]) {
    return undefined
  }
  const { Model } = getCollection({ adapter: lane.view, collectionSlug: slug })
  return isPristineModel(lane, Model) && !mongooseBlocksLane(lane, Model) ? Model : 'model'
}

/**
 * The clock readings and ObjectIds of an upstream `updateByID` without hooks, in its order
 * (FUSED_WRITES.md 12.3): one `bson-objectid` row id per array / block row without an id
 * (beforeValidate), `dataToUpdate.updatedAt`, mongoose's `now` of the `findOneAndUpdate` (its
 * `_setTimestampsOnUpdate` pre hook on schemas with timestamps: the value is unused, upstream
 * passes `timestamps: false`, but the reading is taken), with versions `saveVersion`'s `now` and
 * the version's `_id`. A draft save (`isSavingDraft`) sends no `updateOne`: neither of the first
 * two. `clock` holds the readings the prepare uses.
 */
const captureUpdateReadings = (
  lane: DriverLane,
  fields: Any[],
  data: Any,
  {
    hasTimestamps,
    hasVersions,
    isSavingDraft,
  }: { hasTimestamps: boolean; hasVersions: boolean; isSavingDraft: boolean },
) => {
  const rows = countMissingRowIds(fields, data)
  if (rows === undefined) {
    return undefined
  }
  const RowId: Any = rowIdClass()
  const ids: [string, string][] = []
  for (let i = 0; i < rows; i++) {
    ids.push(['row', new RowId().toHexString()])
  }
  const clock: number[] = []
  if (!isSavingDraft) {
    clock.push(Date.now())
    if (hasTimestamps) {
      Date.now()
    }
  }
  if (hasVersions) {
    clock.push(Date.now())
    ids.push(['version', new lane.mongoose.Types.ObjectId().toHexString()])
  }
  return { clock, ids }
}

/**
 * An `updateByID` / `deleteByID` request (crates/payload-fuse-write `by_id`): the cast filters
 * with the call's id, the lock check, the versions and preferences collections, and for updates
 * WP-I's plan with the prepare request (its readings taken here, in upstream's order).
 */
const prepareByID = async (
  lane: DriverLane,
  name: 'deleteByID' | 'updateByID',
  args: Any,
  unserved?: string[],
  accessWhere?: unknown,
) => {
  const slug = args.collection.config.slug
  const resolved = entity(lane, slug)
  if (typeof resolved === 'string') {
    return `mongo:${resolved}`
  }
  const { collectionConfig, Model, VersionModel } = resolved
  const { id, req } = args
  const locks = pristineModel(lane, lockedDocumentsCollectionSlug)
  const preferences = pristineModel(lane, preferencesCollectionSlug)
  if (locks === 'model' || preferences === 'model') {
    return 'mongo:model:internal'
  }
  const template = await byIDTemplate(lane, slug, Model)
  if (typeof template === 'string') {
    return `mongo:${template}`
  }
  // checkDocumentLockStatus: locking needs the collection and `lockDocuments !== false`
  const lockModel = collectionConfig.lockDocuments !== false ? locks : undefined
  const request: Record<string, unknown> = {
    c: Model.collection.collectionName,
    op: name,
    t: withID(template, id),
  }
  if (lockModel) {
    request.lc = lockModel.collection.collectionName
    request.lfind = args.overrideLock === false
  }
  if (VersionModel) {
    request.vc = VersionModel.collection.collectionName
    if (accessWhere !== undefined && name === 'updateByID' && hasDraftsEnabled(collectionConfig)) {
      const latest = await latestAccessTemplate(
        lane,
        collectionConfig,
        VersionModel,
        accessWhere,
        typeof req.locale === 'string' ? req.locale : undefined,
      )
      if (typeof latest === 'string') {
        return `mongo:${latest}`
      }
      request.tl = withID(latest, id)
    }
  }
  if (unserved?.length) {
    request.up = unservedPaths(collectionConfig.fields, unserved)
  }
  if (name === 'deleteByID' && preferences) {
    request.pc = preferences.collection.collectionName
  }
  if (name === 'updateByID') {
    // the all-locales publish validation's unique-value lookups (the prepare decides which)
    const unique = await uniqueLookupTemplates(lane, collectionConfig, Model)
    if (typeof unique === 'string') {
      return `mongo:${unique}`
    }
    if (unique) {
      request.ut = unique
      request.uid = id
    }
    const plan = writePlanOf(args.collection, req.payload)
    if (plan.json === undefined) {
      return `plan:${plan.reason}`
    }
    if (slugDuplicateKey in req.context) {
      return 'context:slugDuplicate'
    }
    // utilities/update.ts `isSavingDraft` (no `publishAllLocales`: guarded); a draft save
    // validates only with `drafts.validate`
    const isSavingDraft = Boolean(
      args.draft && hasDraftsEnabled(collectionConfig) && args.data._status !== 'published',
    )
    const drafts = collectionConfig.versions?.drafts
    if (isInWarmup(plan, !(isSavingDraft && drafts && !drafts.validate))) {
      return 'fn:warmup'
    }
    const fieldAccess = fieldAccessRequest(plan, 'update', args)
    if (typeof fieldAccess === 'string') {
      return fieldAccess
    }
    const planID = writePlanID(plan, plan.json)
    if (planID === undefined) {
      return 'prepare:addon'
    }
    const timestamps = Model.schema.options.timestamps
    if (typeof timestamps === 'object' && timestamps !== null && 'currentTime' in timestamps) {
      return 'mongo:currentTime'
    }
    const readings = captureUpdateReadings(lane, collectionConfig.fields, args.data, {
      hasTimestamps: Boolean(timestamps),
      hasVersions: Boolean(VersionModel),
      isSavingDraft,
    })
    if (!readings) {
      return 'ctx:rows'
    }
    try {
      request.p = JSON.stringify({
        id,
        clock: readings.clock,
        context: encodeTree(req.context),
        data: encodeTree(args.data),
        draft: Boolean(args.draft),
        fallbackLanguage: req.i18n?.fallbackLanguage,
        fieldAccess,
        ids: readings.ids,
        language: req.i18n?.language ?? 'en',
        locale:
          req.payload.config.localization && typeof req.locale === 'string'
            ? req.locale
            : undefined,
        op: 'update',
        overrideAccess: Boolean(args.overrideAccess),
        req: requestSnapshot(plan, req),
        user: req.user ? [req.user.collection, encodeTree(req.user.id)] : undefined,
      })
    } catch {
      return 'prepare:encode'
    }
    request.wp = planID
  }
  const objectID = new lane.mongoose.Types.ObjectId(id)
  const reads = [
    { c: Model.collection.collectionName, f: { _id: objectID } },
    ...(VersionModel
      ? [{ c: VersionModel.collection.collectionName, f: { parent: objectID }, s: { _id: 1 } }]
      : []),
    ...(lockModel
      ? [
          {
            c: lockModel.collection.collectionName,
            f: { 'document.relationTo': slug, 'document.value': { $in: [objectID, id] } },
            s: { _id: 1 },
          },
        ]
      : []),
    ...(name === 'deleteByID' && preferences
      ? [
          {
            c: preferences.collection.collectionName,
            f: { key: `collection-${slug}-${id}` },
            s: { _id: 1 },
          },
        ]
      : []),
  ]
  return { op: lane.BSON.serialize(request), reads, state: lane.BSON.serialize({ r: reads }) }
}

const unservedPathCache = new WeakMap<object, Map<string, string[][]>>()

/**
 * The stored-document paths of the relationship / upload fields that can reference one of
 * `slugs` (array and block rows are path segments matched in every element; named groups and
 * tabs nest, unnamed containers do not): the by-id drivers bail before any statement when the
 * stored document holds a value at one (the result read would load an unserved collection).
 */
const unservedPaths = (fields: Any[], slugs: string[]) => {
  const key = slugs.join('\u0000')
  let byKey = unservedPathCache.get(fields)
  if (!byKey) {
    byKey = new Map()
    unservedPathCache.set(fields, byKey)
  }
  let paths = byKey.get(key)
  if (!paths) {
    paths = []
    collectUnservedPaths(fields, slugs, [], paths)
    byKey.set(key, paths)
  }
  return paths
}

const collectUnservedPaths = (
  fields: Any[],
  slugs: string[],
  prefix: string[],
  out: string[][],
) => {
  for (const field of fields) {
    if (field.type === 'relationship' || field.type === 'upload') {
      const relationTo = Array.isArray(field.relationTo) ? field.relationTo : [field.relationTo]
      if (relationTo.some((slug: string) => slugs.includes(slug))) {
        out.push([...prefix, field.name])
      }
    } else if (field.type === 'blocks') {
      for (const block of field.blocks ?? []) {
        if (typeof block === 'object' && block !== null) {
          collectUnservedPaths(block.fields ?? [], slugs, [...prefix, field.name], out)
        }
      }
    } else if (field.type === 'tabs') {
      for (const tab of field.tabs) {
        collectUnservedPaths(tab.fields, slugs, 'name' in tab ? [...prefix, tab.name] : prefix, out)
      }
    } else if (Array.isArray(field.fields)) {
      collectUnservedPaths(
        field.fields,
        slugs,
        'name' in field ? [...prefix, field.name] : prefix,
        out,
      )
    }
  }
}

/**
 * A bulk update / delete request for the documents `ids` the operation's find returned (`docsHex`:
 * their BSON, crates/payload-fuse-write `bulk`) and the shadow's state reads (per document, as
 * the by-id ones). update-many: one updateByID request per document (`prepareByID`: the cast
 * filters with its id, the prepare request with its readings, taken document by document in the
 * find's order). delete-many: delete.ts's cast filters for all ids (`id in`, the locks'
 * `document.value in`, the versions' `parent in`, the preferences' `key in`).
 */
const prepareBulk = async (
  lane: DriverLane,
  name: 'delete' | 'update',
  args: Any,
  ids: string[],
  docsHex: string,
) => {
  const docs = Buffer.from(docsHex, 'hex')
  if (name === 'update') {
    const entries: Uint8Array[] = []
    const reads: unknown[] = []
    for (const id of ids) {
      const prepared = await prepareByID(lane, 'updateByID', { ...args, id })
      if (typeof prepared === 'string') {
        return prepared
      }
      entries.push(prepared.op)
      reads.push(...prepared.reads)
    }
    return {
      op: lane.BSON.serialize({ e: entries, op: 'updateMany', s: docs }),
      state: lane.BSON.serialize({ r: reads }),
    }
  }
  const slug = args.collection.config.slug
  const resolved = entity(lane, slug)
  if (typeof resolved === 'string') {
    return `mongo:${resolved}`
  }
  const { collectionConfig, Model, VersionModel } = resolved
  const locks = pristineModel(lane, lockedDocumentsCollectionSlug)
  const preferences = pristineModel(lane, preferencesCollectionSlug)
  if (locks === 'model' || preferences === 'model') {
    return 'mongo:model:internal'
  }
  const adapter = lane.view
  const config = adapter.payload.config
  const cast = async (Target: Any, collectionSlug: string | undefined, fields: Any, where: Any) =>
    castFilter(Target, await buildQuery({ adapter, collectionSlug, fields, where }))
  const request: Record<string, unknown> = {
    c: Model.collection.collectionName,
    op: 'deleteMany',
    q: await cast(Model, slug, collectionConfig.flattenedFields, { id: { in: ids } }),
    s: docs,
  }
  const keys = ids.map((id) => `collection-${slug}-${id}`)
  const objectIDs = ids.map((id) => new lane.mongoose.Types.ObjectId(id))
  // `isLockingAvailable` of delete.ts
  const LockModel = collectionConfig.lockDocuments !== false ? locks : undefined
  if (LockModel && ids.length > 0) {
    request.lc = LockModel.collection.collectionName
    request.lf = await cast(
      LockModel,
      lockedDocumentsCollectionSlug,
      adapter.payload.collections[lockedDocumentsCollectionSlug].config.flattenedFields,
      {
        and: [{ 'document.relationTo': { equals: slug } }, { 'document.value': { in: ids } }],
      },
    )
    request.lfind = args.overrideLock === false
    if (request.lfind) {
      // getLockedDocumentIds reads the clock after its find (unused: any lock found bails)
      Date.now()
    }
  }
  if (VersionModel) {
    request.vc = VersionModel.collection.collectionName
    request.vq = await cast(
      VersionModel,
      undefined,
      buildVersionCollectionFields(config, collectionConfig, true),
      { parent: { in: ids } },
    )
  }
  if (preferences) {
    request.pc = preferences.collection.collectionName
    request.pf = await cast(
      preferences,
      preferencesCollectionSlug,
      adapter.payload.collections[preferencesCollectionSlug].config.flattenedFields,
      { key: { in: keys } },
    )
  }
  const state = lane.BSON.serialize({
    r: [
      { c: Model.collection.collectionName, f: { _id: { $in: objectIDs } }, s: { _id: 1 } },
      ...(VersionModel
        ? [
            {
              c: VersionModel.collection.collectionName,
              f: { parent: { $in: objectIDs } },
              s: { _id: 1 },
            },
          ]
        : []),
      ...(LockModel
        ? [
            {
              c: LockModel.collection.collectionName,
              f: {
                'document.relationTo': slug,
                'document.value': { $in: [...objectIDs, ...ids] },
              },
              s: { _id: 1 },
            },
          ]
        : []),
      ...(preferences
        ? [{ c: preferences.collection.collectionName, f: { key: { $in: keys } }, s: { _id: 1 } }]
        : []),
    ],
  })
  return { op: lane.BSON.serialize(request), state }
}

/**
 * TEMPORARY TS prepare (module comment): upstream's create.ts from `beforeValidate` to
 * `payload.db.create` and `saveVersion`, without their I/O. `data` is the copy of the caller's
 * data the operation runs on (upstream's `beforeValidate` mutates the caller's object in place;
 * the dispatch replays that).
 */
const prepareCreateTS = async (lane: DriverLane, args: Any, data: Any, context: Any) => {
  const resolved = entity(lane, args.collection.config.slug)
  if (typeof resolved === 'string') {
    return `mongo:${resolved}`
  }
  const { collectionConfig, Model, VersionModel } = resolved
  const { overrideAccess, req } = args
  const duplicatedFromDoc = {}
  const publicationFieldPolicyDoc = buildAllLocalesPublicationHookDoc({
    doc: duplicatedFromDoc,
    docWithLocales: {},
    status: undefined,
  })
  const validated = await beforeValidate({
    collection: collectionConfig,
    context,
    data,
    doc: duplicatedFromDoc,
    docForHooks: publicationFieldPolicyDoc,
    global: null,
    onFieldAccess: () => {},
    operation: 'create',
    overrideAccess,
    req,
  })
  const publicationHookDoc = buildAllLocalesPublicationHookDoc({
    doc: duplicatedFromDoc,
    docWithLocales: {},
    status: undefined,
  })
  const dataWithLocales: Any = await beforeChange({
    collection: collectionConfig,
    context,
    data: validated,
    doc: publicationHookDoc,
    docWithLocales: { _status: {} },
    global: null,
    onDataProcessed: () => {},
    operation: 'create',
    overrideAccess,
    req,
    skipValidation: false,
  })

  // db-mongodb `create` up to `Model.create([data], { session })`
  if (!dataWithLocales.createdAt) {
    dataWithLocales.createdAt = new Date().toISOString()
  }
  const adapter = lane.view
  transform({ adapter, data: dataWithLocales, fields: collectionConfig.fields, operation: 'write' })
  const inserted = await newDocument(lane, Model, dataWithLocales)
  if (typeof inserted === 'string') {
    return inserted
  }
  const id = inserted.doc._id
  let version: Any
  if (VersionModel) {
    // saveVersion + db-mongodb `createVersion` (`returning: false`)
    const resultWithLocales = inserted.doc.toObject()
    transform({
      adapter,
      data: resultWithLocales,
      fields: collectionConfig.fields,
      operation: 'read',
    })
    const now = new Date().toISOString()
    const versionData = deepCopyObjectSimple(sanitizeInternalFields(resultWithLocales))
    if (versionData._id) {
      delete versionData._id
    }
    const versionDoc: Any = {
      autosave: false,
      createdAt: now,
      latest: true,
      parent: resultWithLocales.id,
      publishedLocale: undefined,
      snapshot: undefined,
      updatedAt: now,
      version: versionData,
    }
    if (!versionDoc.createdAt) {
      versionDoc.createdAt = new Date().toISOString()
    }
    transform({
      adapter,
      data: versionDoc,
      fields: buildVersionCollectionFields(adapter.payload.config, collectionConfig),
      operation: 'write',
    })
    const versionInserted = await newDocument(lane, VersionModel, versionDoc)
    if (typeof versionInserted === 'string') {
      return `${versionInserted}:version`
    }
    version = { c: VersionModel.collection.collectionName, doc: versionInserted.obj }
  }
  const op = lane.BSON.serialize(
    {
      c: Model.collection.collectionName,
      doc: inserted.obj,
      op: 'create',
      ...(version ? { v: version } : {}),
    },
    { ignoreUndefined: false },
  )
  return {
    id: id.toHexString(),
    op,
    settle: () => data,
    state: documentState(lane, Model, VersionModel, id),
  }
}

/**
 * mongoose's `new Model(data)`, `$validate()` and the object `$__handleSave` inserts for it (the
 * Node driver then serializes it into the `insert` command), or a bail reason.
 */
const newDocument = async (lane: DriverLane, Model: Any, data: Any) => {
  if (!saveToObjectOptions) {
    // model.js `saveToObjectOptions`, from the mongoose db-mongodb resolves
    const requireFromDbMongodb = createRequire(
      new URL('../../../db-mongodb/package.json', import.meta.url),
    )
    saveToObjectOptions = {
      ...requireFromDbMongodb('mongoose/lib/options.js').internalToObjectOptions,
      bson: true,
    }
  }
  const doc = new Model(data)
  try {
    await doc.$validate()
  } catch {
    // mongoose's ValidationError: the exact lane reproduces it
    return 'prepare:mongoose-validate'
  }
  const obj = doc.$__hasOnlyPrimitiveValues()
    ? doc.$__toObjectShallow()
    : doc.toObject(saveToObjectOptions)
  if (obj?._id === undefined) {
    return 'prepare:no-id'
  }
  doc.$__version(true, obj)
  return { doc, obj }
}
