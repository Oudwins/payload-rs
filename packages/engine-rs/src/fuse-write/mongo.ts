/**
 * The MongoDB target of the fused writes (FUSED_WRITES.md): registered by the driver lane
 * (`installDriverLane`) for each adapter with a Rust driver client. Per call its lookup requires
 * the adapter's write and read methods to still be those the lane saw, a driver client on a
 * replica set, no tracing / lane verify mode and no mongoose setting the lane refuses.
 *
 * Preparing a write (beforeValidate, the default validators, beforeChange, db-mongodb's write
 * transform and mongoose's casting) is WP-I's pure Rust `prepare_create` (crates/payload-fuse-write
 * `prepare`, section 12, through `fuseWritePrepare` with WP-I's plan of writePlan.ts): the JS side
 * captures the clock readings and ObjectIds upstream would generate, in upstream's order
 * (`captureCreateReadings`), with the classes upstream generates them with.
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
import { createRequire } from 'node:module'

import type { DriverLane } from '../mongo-driver/lane.js'
import type { FusedWriteTarget } from './targets.js'

import { getCollection } from '../../../db-mongodb/src/utilities/getEntity.js'
import { transform } from '../../../db-mongodb/src/utilities/transform.js'
import { beforeChange } from '../../../payload/src/fields/hooks/beforeChange/index.js'
import { beforeValidate } from '../../../payload/src/fields/hooks/beforeValidate/index.js'
import { deepCopyObjectSimple } from '../../../payload/src/utilities/deepCopyObject.js'
import { sanitizeInternalFields } from '../../../payload/src/utilities/sanitizeInternalFields.js'
import { buildAllLocalesPublicationHookDoc } from '../../../payload/src/versions/allLocalesPublicationStatus.js'
import { buildVersionCollectionFields } from '../../../payload/src/versions/buildCollectionFields.js'
import { loadCoreRuntimeAddon } from '../addon.js'
import { isPristineModel, mongooseBlocksLane } from '../mongo-driver/lane.js'
import { verifyMode } from '../mongo-driver/verify.js'
import { isTracing } from '../shadow-mongo/trace.js'
import { registerFusedWriteTarget } from './targets.js'
import { buildWritePlan, type WritePlanResult } from './writePlan.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- mirrors untyped upstream code */
type Any = any

type FuseWriteAddon = {
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
  const { fuseWriteMongoOp, fuseWriteMongoState } = addon
  if (typeof fuseWriteMongoOp !== 'function' || typeof fuseWriteMongoState !== 'function') {
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
      objectIdClass: lane.mongoose.Types.ObjectId,
      prepareCreate: (args, data, context) =>
        isTSPrepare
          ? prepareCreateTS(lane, args, data, context)
          : Promise.resolve(prepareCreateRust(lane, args, data, context)),
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
) => {
  const rows = countMissingRowIds(fields, data)
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
  const documentID = new ObjectId()
  ids.push(['document', documentID.toHexString()])
  if (hasVersions) {
    clock.push(Date.now())
    ids.push(['version', new ObjectId().toHexString()])
  }
  return { clock, documentID, ids }
}

/** Array rows without an `id` in `data` (row ids beforeValidate generates), in traversal order. */
const countMissingRowIds = (fields: Any[], data: Any): number | undefined => {
  if (typeof data !== 'object' || data === null) {
    return 0
  }
  let count = 0
  for (const field of fields) {
    let nested: number | undefined = 0
    if (field.type === 'array' || field.type === 'blocks') {
      const rows = data[field.name]
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
        nested = countMissingRowIds(rowFields, row)
        if (nested === undefined) {
          return undefined
        }
        count += nested + (row?.id === undefined ? 1 : 0)
      }
      continue
    }
    if (field.type === 'tabs') {
      for (const tab of field.tabs) {
        nested = countMissingRowIds(tab.fields, 'name' in tab ? data[tab.name] : data)
        if (nested === undefined) {
          return undefined
        }
        count += nested
      }
      continue
    }
    if (Array.isArray(field.fields)) {
      nested = countMissingRowIds(field.fields, 'name' in field ? data[field.name] : data)
      if (nested === undefined) {
        return undefined
      }
      count += nested
    }
  }
  return count
}

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

const prepareCreateRust = (lane: DriverLane, args: Any, data: Any, context: Any) => {
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
  const { fuseWritePrepare } = loadCoreRuntimeAddon() as FuseWriteAddon
  if (typeof fuseWritePrepare !== 'function') {
    return 'prepare:addon'
  }
  const { req } = args
  let request: string
  try {
    request = JSON.stringify({
      context: encodeTree(context),
      data: encodeTree(data),
      fallbackLanguage: req.i18n?.fallbackLanguage,
      language: req.i18n?.language ?? 'en',
      // `req.locale` exactly when the config is localized (the prepare bails otherwise)
      locale:
        req.payload.config.localization && typeof req.locale === 'string' ? req.locale : undefined,
      op: 'create',
      overrideAccess: Boolean(args.overrideAccess),
      user: req.user ? [req.user.collection, encodeTree(req.user.id)] : undefined,
    }).slice(0, -1)
  } catch {
    return 'prepare:encode'
  }
  const readings = captureCreateReadings(lane, collectionConfig.fields, data, Boolean(VersionModel))
  if (!readings) {
    return 'ctx:rows'
  }
  // no translations: a validation failure bails, the exact lane throws upstream's error
  const out = JSON.parse(
    fuseWritePrepare(
      plan.json,
      `${request},"clock":${JSON.stringify(readings.clock)},"ids":${JSON.stringify(readings.ids)}}`,
    ),
  )
  if (out.bail !== undefined) {
    return `prepare:${out.bail}`
  }
  if (out.invalid || !out.doc) {
    return 'prepare:invalid'
  }
  if (out.clockLeft || out.idsLeft) {
    return 'prepare:readings-left'
  }
  for (const [key, value] of out.contextWrites) {
    context[key] = decodeTree(value)
  }
  const hex = (text: string) => Buffer.from(text, 'hex')
  const op = lane.BSON.serialize({
    c: Model.collection.collectionName,
    dob: hex(out.doc),
    op: 'create',
    ...(VersionModel && out.version
      ? {
          v: {
            c: VersionModel.collection.collectionName,
            dob: hex(out.version.doc),
            ff: hex(out.version.flipFilter),
            fu: hex(out.version.flipUpdate),
          },
        }
      : {}),
  })
  return {
    id: readings.documentID.toHexString(),
    data: out.callerData === undefined ? data : decodeTree(out.callerData),
    op,
    state: documentState(lane, Model, VersionModel, readings.documentID),
  }
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
    data,
    op,
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
