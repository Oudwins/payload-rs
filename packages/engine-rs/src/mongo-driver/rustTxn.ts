/**
 * Rust-owned write transactions (RUST_PERF_PLAN.md D4): PROTOTYPE, behind
 * `PAYLOAD_MONGO_RUST_TXN=true`, off by default (D4 is not approved). Measures what owning the
 * transaction on the Rust driver client gains, so the owner can decide.
 *
 * A write operation (`create`, `update`, `updateByID`, `delete`, `deleteByID`) that runs no
 * collection / root hooks and no access functions starts its transaction on the Rust client
 * instead of mongoose: `req.transactionID` is set before the operation starts (so upstream's
 * `initTransaction` finds it and the operation does not commit itself), and
 * `payload.db.sessions[id]` holds a `RustSession` stand-in. Then
 *
 * - every driver lane read whose `req` carries it runs on the Rust client inside the transaction
 *   (lane.ts: `txn` in the lane arguments),
 * - every mongoose call that gets the stand-in as its `session` (the live write methods, and any
 *   mongoose read the lane hands to the mongoose lane) reaches the patched mongoose `Collection`
 *   methods below, which send the Node driver's command for that call through the Rust client in
 *   the transaction: mongoose still casts, validates and builds documents, only the I/O moves,
 * - after the operation resolves, payload's `commitTransaction(req)` commits it on the Rust client
 *   (the adapter's `commitTransaction` / `rollbackTransaction` know the stand-in).
 *
 * Not proven by this prototype (needed before it could be a default): field-level hooks,
 * validators and function default values are not classified as Payload's own or user code
 * (Payload adds its own: createdBy / updatedBy, array row ids, the default validators); user code
 * reaching the Node driver below mongoose with the stand-in session fails; a collection method
 * without a mapping here throws inside the transaction instead of falling back.
 */
import { randomUUID } from 'node:crypto'

import { commitTransaction } from '../../../payload/src/utilities/commitTransaction.js'
import { killTransaction } from '../../../payload/src/utilities/killTransaction.js'
import {
  isAdapterTransactionEnabled,
  registerTransactionLane,
} from '../ops-write/transactionLanes.js'
import { type DriverLane } from './lane.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- mongoose / driver objects are untyped here */
type Any = any

export const isRustTransactionEnabled = isAdapterTransactionEnabled

/** The `payload.db.sessions` entry of a Rust-owned transaction. */
export class RustSession {
  hasEnded = false
  /** mongoose's trackTransaction plugin reads it (no mongoose transaction state). */
  transaction = null

  constructor(
    readonly lane: DriverLane,
    readonly txn: number,
  ) {}

  /** Commits or aborts it on the Rust client (an abort's error is ignored, like upstream's). */
  async end(shouldCommit: boolean) {
    this.hasEnded = true
    const error = await this.lane.binding.txnEnd(this.txn, shouldCommit)
    if (error && shouldCommit) {
      throw serverError(this.lane, JSON.parse(error))
    }
  }

  inTransaction() {
    return !this.hasEnded
  }
}

/** Operations, transactions owned per operation. */
export const rustTransactionStats = { owned: {} as Record<string, number> }

const ownedOperations = new Set(['create', 'delete', 'deleteByID', 'update', 'updateByID'])

const hasHooks = (hooks: Any) =>
  hooks != null &&
  Object.values(hooks).some((list) => (Array.isArray(list) ? list.length > 0 : list != null))

/** Whether the operation runs no collection / root hook and no access function (see the header). */
const isOwnable = (operation: string, args: Any) => {
  const config = args?.collection?.config
  const req = args.req
  return (
    ownedOperations.has(operation) &&
    req.transactionID == null &&
    !args.disableTransaction &&
    args.overrideAccess === true &&
    config != null &&
    !config.upload &&
    !config.auth &&
    !config.versions?.drafts?.schedulePublish &&
    !hasHooks(config.hooks) &&
    !hasHooks(req.payload?.config?.hooks)
  )
}

/**
 * Registers the Rust transactions of `adapter` (installDriverLane, flag on): the operation hook,
 * the adapter's commit / rollback for the stand-in, and the mongoose `Collection` patches.
 */
export const installRustTransactions = (
  adapter: Any,
  laneOf: (adapter: Any) => DriverLane | undefined,
) => {
  const upstreamCommit = adapter.commitTransaction
  adapter.commitTransaction = async function commitTransaction(this: Any, incomingID: Any = '') {
    const transactionID = incomingID instanceof Promise ? await incomingID : incomingID
    const sessions = laneOf(this)?.view.sessions
    const session = sessions?.[transactionID]
    if (!(session instanceof RustSession)) {
      return upstreamCommit.call(this, transactionID)
    }
    delete sessions[transactionID]
    await session.end(true)
  }
  const upstreamRollback = adapter.rollbackTransaction
  adapter.rollbackTransaction = async function rollbackTransaction(
    this: Any,
    incomingID: Any = '',
  ) {
    const transactionID = incomingID instanceof Promise ? await incomingID : incomingID
    const sessions = laneOf(this)?.view.sessions
    const session = sessions?.[transactionID]
    if (!(session instanceof RustSession)) {
      return upstreamRollback.call(this, transactionID)
    }
    delete sessions[transactionID]
    await session.end(false)
  }
  registerTransactionLane(adapter, (operation, args, run) => {
    const lane = laneOf(adapter)
    if (!lane?.replicaSet || adapter.transactionOptions === false || !isOwnable(operation, args)) {
      return undefined
    }
    patchCollections(lane)
    const { req } = args
    const id = randomUUID()
    lane.view.sessions[id] = new RustSession(lane, lane.binding.txnBegin(lane.clientID))
    req.transactionID = id
    rustTransactionStats.owned[operation] = (rustTransactionStats.owned[operation] ?? 0) + 1
    return run().then(
      async (result) => {
        try {
          await commitTransaction(req)
        } catch (error) {
          await killTransaction(req)
          throw error
        }
        return result
      },
      async (error) => {
        // the operation's own catch has called killTransaction (rollback) already
        if (req.transactionID === id) {
          await killTransaction(req)
        }
        throw error
      },
    )
  })
}

const serverError = (lane: DriverLane, description: Any) => {
  const { MongoServerError } = lane.mongoose.mongo
  return new MongoServerError({ ...description, errmsg: description.errmsg ?? description.message })
}

/**
 * Runs the command `{ [name]: target, ...fields }` (the command name is its first key) in the
 * transaction of `session`: the reply, write errors thrown like the driver throws them.
 */
const runInTransaction = async (
  session: RustSession,
  database: null | string,
  name: string,
  target: unknown,
  fields: Record<string, unknown>,
) => {
  const { lane } = session
  let bytes: Uint8Array
  try {
    bytes = await lane.binding.txnCommand(
      session.txn,
      database,
      lane.BSON.serialize({ [name]: target, ...fields }, { ignoreUndefined: false }),
    )
  } catch (error) {
    throw serverError(lane, JSON.parse((error as Error).message))
  }
  const reply = lane.BSON.deserialize(bytes)
  if (reply.writeErrors?.length) {
    throw serverError(lane, reply.writeErrors[0])
  }
  return reply
}

/** Option keys the driver does not send for these calls, or that only concern mongoose. */
const ignoredOptions = new Set(['checkKeys', 'session', 'strict', 'timestamps'])

const options = (given: Any, mapped: Record<string, string>) => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(given ?? {})) {
    if (value === undefined || ignoredOptions.has(key)) {
      continue
    }
    const name = mapped[key]
    if (!name) {
      throw new Error(`Rust transaction prototype: unsupported driver option ${key}`)
    }
    out[name] = value
  }
  return out
}

const updateStatementOptions = {
  arrayFilters: 'arrayFilters',
  collation: 'collation',
  hint: 'hint',
  upsert: 'upsert',
}
const deleteStatementOptions = { collation: 'collation', hint: 'hint' }
const findOptions = {
  batchSize: 'batchSize',
  collation: 'collation',
  hint: 'hint',
  limit: 'limit',
  projection: 'projection',
  skip: 'skip',
  sort: 'sort',
}
const findAndModifyOptions = {
  arrayFilters: 'arrayFilters',
  collation: 'collation',
  hint: 'hint',
  includeResultMetadata: 'includeResultMetadata',
  projection: 'fields',
  returnDocument: 'returnDocument',
  returnOriginal: 'returnOriginal',
  sort: 'sort',
  upsert: 'upsert',
}

/** The cursor's documents: the first batch plus `getMore` until the server closes it. */
const drain = async (session: RustSession, database: null | string, reply: Any) => {
  const docs = [...reply.cursor.firstBatch]
  let { id } = reply.cursor
  const collection = reply.cursor.ns.slice(reply.cursor.ns.indexOf('.') + 1)
  while (id && !(typeof id === 'number' ? id === 0 : id.isZero?.())) {
    const more = await runInTransaction(session, database, 'getMore', id, { collection })
    docs.push(...more.cursor.nextBatch)
    id = more.cursor.id
  }
  return docs
}

const findAndModify = async (
  collection: Any,
  session: RustSession,
  query: Any,
  given: Any,
  statement: Record<string, unknown>,
) => {
  const { includeResultMetadata, returnDocument, returnOriginal, ...rest } = options(
    given,
    findAndModifyOptions,
  )
  // the driver: `returnDocument` wins, the legacy `returnOriginal: false` means 'after'
  const isAfter = returnDocument ? returnDocument === 'after' : returnOriginal === false
  const reply = await runInTransaction(
    session,
    collection.conn?.name ?? null,
    'findAndModify',
    collection.collectionName,
    {
      query,
      ...statement,
      ...(isAfter ? { new: true } : {}),
      ...rest,
    },
  )
  return includeResultMetadata ? reply : (reply.value ?? null)
}

/** The Node driver commands of the mongoose `Collection` calls, in the Rust transaction. */
const collectionCalls: Record<string, (this: Any, session: RustSession, ...args: Any[]) => Any> = {
  aggregate(session, pipeline, given) {
    const database = this.conn?.name ?? null
    const { batchSize: _batchSize, ...rest } = options(given, {
      allowDiskUse: 'allowDiskUse',
      batchSize: 'batchSize',
      collation: 'collation',
      hint: 'hint',
    })
    const result = runInTransaction(session, database, 'aggregate', this.collectionName, {
      cursor: {},
      pipeline,
      ...rest,
    }).then((reply) => drain(session, database, reply))
    return { toArray: () => result }
  },
  async countDocuments(session, filter, given) {
    const { limit, skip, ...rest } = options(given, {
      collation: 'collation',
      hint: 'hint',
      limit: 'limit',
      skip: 'skip',
    })
    const pipeline: Any[] = [{ $match: filter }]
    if (typeof skip === 'number') {
      pipeline.push({ $skip: skip })
    }
    if (typeof limit === 'number') {
      pipeline.push({ $limit: limit })
    }
    pipeline.push({ $group: { _id: 1, n: { $sum: 1 } } })
    const database = this.conn?.name ?? null
    const reply = await runInTransaction(session, database, 'aggregate', this.collectionName, {
      cursor: {},
      pipeline,
      ...rest,
    })
    const [result] = await drain(session, database, reply)
    return result?.n ?? 0
  },
  async deleteMany(session, filter, given) {
    const reply = await runInTransaction(
      session,
      this.conn?.name ?? null,
      'delete',
      this.collectionName,
      {
        deletes: [{ limit: 0, q: filter, ...options(given, deleteStatementOptions) }],
        ordered: true,
      },
    )
    return { acknowledged: true, deletedCount: reply.n }
  },
  async deleteOne(session, filter, given) {
    const reply = await runInTransaction(
      session,
      this.conn?.name ?? null,
      'delete',
      this.collectionName,
      {
        deletes: [{ limit: 1, q: filter, ...options(given, deleteStatementOptions) }],
        ordered: true,
      },
    )
    return { acknowledged: true, deletedCount: reply.n }
  },
  find(session, filter, given) {
    const database = this.conn?.name ?? null
    const result = runInTransaction(session, database, 'find', this.collectionName, {
      filter,
      ...options(given, findOptions),
    }).then((reply) => drain(session, database, reply))
    return { toArray: () => result }
  },
  async findOne(session, filter, given) {
    const reply = await runInTransaction(
      session,
      this.conn?.name ?? null,
      'find',
      this.collectionName,
      {
        filter,
        ...options(given, findOptions),
        limit: 1,
        singleBatch: true,
      },
    )
    return reply.cursor.firstBatch[0] ?? null
  },
  findOneAndDelete(session, filter, given) {
    return findAndModify(this, session, filter, given, { remove: true })
  },
  findOneAndUpdate(session, filter, update, given) {
    return findAndModify(this, session, filter, given, { update })
  },
  async insertOne(session, doc, given) {
    if (doc._id == null) {
      doc._id = new session.lane.mongoose.Types.ObjectId()
    }
    await runInTransaction(session, this.conn?.name ?? null, 'insert', this.collectionName, {
      documents: [doc],
      ordered: true,
      ...options(given, { bypassDocumentValidation: 'bypassDocumentValidation' }),
    })
    return { acknowledged: true, insertedId: doc._id }
  },
  updateMany(session, filter, update, given) {
    return runUpdate(this, session, filter, update, given, true)
  },
  updateOne(session, filter, update, given) {
    return runUpdate(this, session, filter, update, given, false)
  },
}

const runUpdate = async (
  collection: Any,
  session: RustSession,
  filter: Any,
  update: Any,
  given: Any,
  multi: boolean,
) => {
  const statement = options(given, updateStatementOptions)
  const reply = await runInTransaction(
    session,
    collection.conn?.name ?? null,
    'update',
    collection.collectionName,
    {
      ordered: true,
      updates: [{ multi, q: filter, u: update, upsert: Boolean(statement.upsert), ...statement }],
    },
  )
  const upserted = reply.upserted ?? []
  return {
    acknowledged: true,
    matchedCount: reply.n - upserted.length,
    modifiedCount: reply.nModified,
    upsertedCount: upserted.length,
    upsertedId: upserted[0]?._id ?? null,
  }
}

/** Collection methods that would bypass the Rust transaction: they throw with the stand-in. */
const unmappedCollectionCalls = [
  'bulkWrite',
  'distinct',
  'estimatedDocumentCount',
  'findOneAndReplace',
  'insertMany',
  'replaceOne',
]

const patched = new WeakSet<object>()

/** Routes calls carrying a `RustSession` (last argument's `session`) into its transaction. */
const patchCollections = (lane: DriverLane) => {
  const prototype = lane.mongoose.Collection.prototype
  if (patched.has(prototype)) {
    return
  }
  patched.add(prototype)
  for (const [name, call] of Object.entries(collectionCalls)) {
    const upstream = prototype[name]
    prototype[name] = function (this: Any, ...args: Any[]) {
      const session = args.at(-1)?.session
      return session instanceof RustSession
        ? call.call(this, session, ...args)
        : upstream.apply(this, args)
    }
  }
  for (const name of unmappedCollectionCalls) {
    const upstream = prototype[name]
    prototype[name] = function (this: Any, ...args: Any[]) {
      if (args.at(-1)?.session instanceof RustSession) {
        throw new Error(`Rust transaction prototype: Collection.${name} is not mapped`)
      }
      return upstream.apply(this, args)
    }
  }
}
