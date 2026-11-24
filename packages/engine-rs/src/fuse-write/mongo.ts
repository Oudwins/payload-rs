/**
 * The MongoDB target of the fused writes (FUSED_WRITES.md): registered by the driver lane
 * (`installDriverLane`) for each adapter with a Rust driver client. Per call its lookup requires
 * the adapter's write and read methods to still be those the lane saw, a driver client on a
 * replica set, no tracing / lane verify mode and no mongoose setting the lane refuses.
 *
 * Preparing a write (beforeValidate, the default validators, beforeChange, db-mongodb's write
 * transform and mongoose's casting) is WP-I's pure Rust `prepare_create` (crates/payload-fuse-write,
 * section 12; a stub that bails until it lands): the JS side only captures the clock readings and
 * ObjectIds upstream would generate, in upstream's order (`captureCreateCtx`).
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
          : Promise.resolve(prepareCreateRust(lane, args, data)),
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
 * The clock readings and ObjectIds of an upstream `create` without hooks, in its order (the Rust
 * prepare's `WriteCtx`): `createdAt` (db-mongodb `create`, unless given), `updatedAt` (the write
 * transform, unless given), the document's `_id` (mongoose, a clock reading and a counter
 * increment), `now` of `saveVersion`, the version's `_id`. Row ids of arrays / blocks
 * (`baseIDField`, during beforeValidate, before all of these) come with the typical shape's
 * field kinds.
 */
const captureCreateCtx = (lane: DriverLane, data: Any, hasVersions: boolean) => {
  const { ObjectId } = lane.mongoose.Types
  const clock: string[] = []
  const ids: Any[] = []
  if (!data.createdAt) {
    clock.push(new Date().toISOString())
  }
  if (data.updatedAt === undefined) {
    clock.push(new Date().toISOString())
  }
  ids.push(new ObjectId())
  if (hasVersions) {
    clock.push(new Date().toISOString())
    ids.push(new ObjectId())
  }
  return { clock, ids }
}

const prepareCreateRust = (lane: DriverLane, args: Any, data: Any) => {
  const resolved = entity(lane, args.collection.config.slug)
  if (typeof resolved === 'string') {
    return `mongo:${resolved}`
  }
  const { Model, VersionModel } = resolved
  if (data.createdAt !== undefined || data.updatedAt !== undefined) {
    // whether upstream reads the clock depends on beforeChange's output
    return 'ctx:timestamps'
  }
  const { clock, ids } = captureCreateCtx(lane, data, Boolean(VersionModel))
  const op = lane.BSON.serialize({
    c: Model.collection.collectionName,
    op: 'create',
    ...(VersionModel ? { vc: VersionModel.collection.collectionName } : {}),
    p: {
      clock,
      data: JSON.stringify(data),
      ids,
      locale: args.req.locale ?? undefined,
      plan: 0,
      user: args.req.user ? JSON.stringify(args.req.user) : undefined,
    },
  })
  return {
    id: ids[0].toHexString(),
    data,
    op,
    state: documentState(lane, Model, VersionModel, ids[0]),
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
