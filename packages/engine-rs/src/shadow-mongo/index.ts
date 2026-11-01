/**
 * Differential ("shadow") database adapter for `@payloadcms/db-mongodb`.
 *
 * `createMongoShadowAdapter({ reference, candidate })` returns a regular Payload
 * `DatabaseAdapterObj`. Every adapter method Payload (or a test) calls runs on the reference
 * adapter and then on the candidate adapter (each on its own database); results or thrown
 * errors are deep-compared (typed bson values, key order, see comparable.ts) and divergences are
 * appended to a JSONL report. The caller always receives the reference outcome, so the suite
 * behaves exactly as with the reference alone.
 *
 * `payload.db` is a Proxy over the reference instance: `collections`, `versions`, `globals`,
 * `connection`, `sessions`, ... are the reference's.
 *
 * Writes that bypass the adapter methods (test fixtures resetting and restoring snapshots via
 * `Model.db.collections[name].deleteMany/insertMany`, `payload.db.collections[slug].insertMany`,
 * `payload.db.connection.collection(name).insertOne`, ...) are mirrored to the candidate at the
 * mongoose `Collection` level (see `patchReferenceConnection`), so both databases stay in the
 * same state.
 *
 * Generated values are replayed so a TS candidate is deterministic: inside the reference half of
 * a pair `Date` readings (../shadow/clock.ts) and bson `ObjectId.getInc()` results are recorded
 * and the candidate half reads them back in order. A new `ObjectId` is
 * `time(Date.now()) + PROCESS_UNIQUE + inc`, so both sides generate identical ids.
 *
 * Results alone don't prove the storage layout, so both databases are dumped (every collection
 * sorted by `_id`, its indexes sorted by name, its options) and diffed whenever a test that
 * wrote finishes (detected at the first database activity of the next test) and on `destroy`.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'

import type { CompareOptions, Difference } from '../shadow/compare.js'
import type { ReportOption, ShadowContext, ShadowRecord } from '../shadow/report.js'

import { createClockTapes, installClockReplay } from '../shadow/clock.js'
import {
  NORMALISATIONS as BASE_NORMALISATIONS,
  compareValues,
  errorShape,
} from '../shadow/compare.js'
import { createReporter, truncateForReport } from '../shadow/report.js'
import { toComparable } from './comparable.js'

export { toComparable } from './comparable.js'
export type { ReportOption, ShadowContext, ShadowRecord }

/** Adapter methods whose results are compared. */
export const COMPARED_METHODS = [
  'batchProcessing',
  'copy',
  'count',
  'countGlobalVersions',
  'countVersions',
  'create',
  'createGlobal',
  'createGlobalVersion',
  'createVersion',
  'deleteMany',
  'deleteOne',
  'deleteVersions',
  'find',
  'findDistinct',
  'findGlobal',
  'findGlobalVersions',
  'findOne',
  'findVersions',
  'queryDrafts',
  'updateGlobal',
  'updateGlobalVersion',
  'updateJobs',
  'updateMany',
  'updateOne',
  'updateVersion',
  'upsert',
] as const

/** Lifecycle methods: run on both adapters, only thrown/not-thrown is compared. */
export const LIFECYCLE_METHODS = [
  'init',
  'connect',
  'destroy',
  'dropDatabase',
  'migrateFresh',
] as const

/** Compared methods that never write (calls to the others mark the databases for a state diff). */
const READ_METHODS = new Set<string>([
  'count',
  'countGlobalVersions',
  'countVersions',
  'find',
  'findDistinct',
  'findGlobal',
  'findGlobalVersions',
  'findOne',
  'findVersions',
  'queryDrafts',
])

/** mongoose `Collection` (driver collection wrapper) methods that write; mirrored outside pairs. */
export const MIRRORED_COLLECTION_METHODS = [
  'bulkWrite',
  'createIndex',
  'createIndexes',
  'deleteMany',
  'deleteOne',
  'drop',
  'dropIndex',
  'dropIndexes',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'insertMany',
  'insertOne',
  'rename',
  'replaceOne',
  'updateMany',
  'updateOne',
] as const

export const NORMALISATIONS = {
  ...BASE_NORMALISATIONS,
  beginTransaction:
    'beginTransaction() ids are random (uuid v4). Only null vs non-null is compared; the candidate id (and its ClientSession) is mapped for every later call carrying req.transactionID or that session.',
  bsonValues:
    'Values are compared after toComparable (comparable.ts): ObjectId as {$oid}, RegExp as {$regex: {source, flags}}, Decimal128 as {$decimal}, Binary as {$binary: {base64, subType}}, other bson values as {$bson, value}, mongoose documents as {$mongooseDocument: toObject()}, Map as {$map}, other class instances with their constructor name. Key order, undefined, Dates and Buffers are kept.',
  databaseName:
    "In candidate strings (results, errors, database dumps) the candidate's database name is replaced by the reference's (MongoDB error messages name the namespace `<db>.<collection>`).",
  databaseState:
    'Databases are compared as every non-system collection (sorted by name) with its type, options, indexes (listIndexes without `ns`, sorted by name) and documents (find sorted by _id), read through the native driver of each adapter connection, after awaiting every model init (background index builds). No document reordering beyond the _id sort is applied. Index `partialFilterExpression.globalType` is replaced by a placeholder: the globals discriminators race to create same-named indexes and the winner varies between runs.',
  lifecycleClock:
    'Lifecycle methods (init, connect, destroy, dropDatabase, migrateFresh) do not replay the clock (their halves read it in different orders); their timestamps fall under the `timestamps` rule. ObjectId counters are still replayed.',
  objectIds:
    'bson ObjectId.getInc() results of the reference half of a pair (or mirrored raw write) are replayed in order to the candidate half; with the clock replay, ObjectIds generated by mongoose/the driver are identical on both sides. Ids generated by the MongoDB server (an upsert that inserts: upstream passes no _id) cannot be replayed: when both results of an upsert carry an id from the same mongod process (not this client), the candidate document is moved to the reference _id (same session) and the candidate outcome is compared with that id replaced (stats `serverIDsAligned`). The server orders the fields it takes from the query differently between two identical upserts, so for such a just-inserted document the top-level key order of the stored candidate document and of the candidate result is aligned to the one of the reference (only when both have exactly the same keys).',
  tableAliases: 'Not applicable to MongoDB (kept from the SQLite harness; matches nothing).',
} as const

/** Structural shape of payload's `DatabaseAdapterObj`. */
export type AdapterObj = {
  allowIDOnCreate?: boolean
  defaultIDType: 'number' | 'text'
  init: (args: { payload: any }) => any
  name?: string
}

type AnyAdapter = Record<string, any>
type AnyFn = (...args: any[]) => any

export type MongoDatabaseDump = {
  collections: Record<
    string,
    {
      documents: unknown[]
      indexes: unknown[]
      options: unknown
      type: unknown
    }
  >
}

export type MongoShadowState = {
  calls: number
  dbChecks: number
  /** Diffs both databases now (waits for in-flight pairs) and records a `dbState` divergence. */
  diffDatabases: (reason?: string) => Promise<Difference[]>
  divergences: number
  /** Pairs that ran longer than `pairReleaseMs` and let the next pair start concurrently. */
  pairsReleased: number
  /** Raw collection writes mirrored to the candidate. */
  rawMirrored: number
  records: ShadowRecord[]
  /** Upserted documents whose server-generated `_id` was aligned (see NORMALISATIONS.objectIds). */
  serverIDsAligned: number
  /** Calls that only reached the reference, keyed by method name. */
  unshadowed: Record<string, number>
}

export type MongoShadowAdapterArgs = {
  candidate: AdapterObj
  compare?: Omit<CompareOptions, 'isNowPair'>
  /** File shared with child processes running a shadow adapter on the same databases (windows). */
  crossProcessFile?: string
  /** Reads one side's database for the state diff. Default `dumpMongooseDatabase`; false skips. */
  dumpDatabase?: ((args: { adapter: AnyAdapter }) => Promise<MongoDatabaseDump | undefined>) | false
  onDivergence?: 'record' | 'throw'
  /**
   * A pair still running after this many ms lets the next pair start (see `exclusive`).
   * Default PAYLOAD_RS_MONGO_SHADOW_RELEASE_MS or 1000.
   */
  pairReleaseMs?: number
  reference: AdapterObj
  report?: ReportOption
}

export const MONGO_SHADOW_STATE = Symbol.for('payload.rs.mongoShadowState')

export const getMongoShadowState = (db: unknown): MongoShadowState | undefined =>
  db && typeof db === 'object' ? (db as any)[MONGO_SHADOW_STATE] : undefined

export class MongoShadowDivergenceError extends Error {
  constructor(record: ShadowRecord) {
    super(`Shadow divergence in ${String(record.method)}: ${JSON.stringify(record.differences)}`)
    this.name = 'MongoShadowDivergenceError'
  }
}

// ---- ObjectId counter replay ------------------------------------------------------------

type IncTape = { cursor: number; incs: number[]; isRecording: boolean }
const incTapeContext = new AsyncLocalStorage<IncTape>()
const patchedObjectIdOwners = new WeakSet<object>()

/**
 * Wraps the static `getInc` of the bson `ObjectId` class (idempotent per class copy): inside a
 * recording tape the counters are recorded, inside a replaying tape they are read back.
 */
export const installObjectIdReplay = (objectIdClass: unknown) => {
  let owner = objectIdClass as null | Record<string, unknown>
  while (owner && !Object.prototype.hasOwnProperty.call(owner, 'getInc')) {
    owner = Object.getPrototypeOf(owner)
  }
  if (!owner || typeof owner.getInc !== 'function' || patchedObjectIdOwners.has(owner)) {
    return
  }
  patchedObjectIdOwners.add(owner)
  const baseGetInc = owner.getInc as AnyFn
  owner.getInc = function getInc(this: unknown) {
    const tape = incTapeContext.getStore()
    if (tape && !tape.isRecording && tape.cursor < tape.incs.length) {
      return tape.incs[tape.cursor++]
    }
    const inc = baseGetInc.call(this)
    if (tape?.isRecording) {
      tape.incs.push(inc)
    }
    return inc
  }
}

/** Runners for the two halves of one pair: clock readings and ObjectId counters replayed. */
export const createReplayTapes = ({
  isClockReplayed = true,
}: { isClockReplayed?: boolean } = {}) => {
  const clock = createClockTapes()
  const incs: number[] = []
  const reference: IncTape = { cursor: 0, incs, isRecording: true }
  const candidate: IncTape = { cursor: 0, incs, isRecording: false }
  const withClock =
    (side: 'candidate' | 'reference') =>
    <T>(fn: () => T) =>
      isClockReplayed ? clock[side](fn) : fn()
  return {
    candidate: <T>(fn: () => T) => withClock('candidate')(() => incTapeContext.run(candidate, fn)),
    reference: <T>(fn: () => T) => withClock('reference')(() => incTapeContext.run(reference, fn)),
  }
}

// ---- database dump ---------------------------------------------------------------------------

const byName = (a: { name?: unknown }, b: { name?: unknown }) =>
  String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0

/**
 * The globals model is one collection with a discriminator per global, and every discriminator
 * declares its indexes (e.g. `_status_1`) with `partialFilterExpression: { globalType }`. Index
 * names collide across globals, so whichever discriminator's `createIndex` reaches the server
 * first wins and the others fail; which one that is varies between two runs of the same adapter.
 * The `globalType` of such an index is therefore not compared.
 */
export const withoutRacedGlobalType = (index: Record<string, unknown>) => {
  const filter = index.partialFilterExpression as Record<string, unknown> | undefined
  if (!filter || typeof filter !== 'object' || !('globalType' in filter)) {
    return index
  }
  return { ...index, partialFilterExpression: { ...filter, globalType: '<raced globalType>' } }
}

/** Every non-system collection of the adapter's database (native driver, no session). */
export const dumpMongooseDatabase = async ({
  adapter,
}: {
  adapter: AnyAdapter
}): Promise<MongoDatabaseDump | undefined> => {
  const db = adapter.connection?.db
  // 1 = connected; a closed connection (after `destroy`, e.g. `reload` with
  // disableDBConnect) never runs model inits and cannot be read
  if (!db || typeof db.listCollections !== 'function' || adapter.connection.readyState !== 1) {
    return undefined
  }
  // mongoose builds indexes per model in the background (`autoIndex`); upstream's `connect` does
  // not await them for the globals model, so the dump would race them
  await Promise.all(
    Object.values((adapter.connection.models ?? {}) as Record<string, any>).map((model) =>
      Promise.resolve(model.init?.()).catch(() => undefined),
    ),
  )
  const infos = (
    (await db.listCollections().toArray()) as { name: string; options?: unknown; type?: unknown }[]
  )
    .filter((info) => !info.name.startsWith('system.'))
    .sort(byName)
  const collections: MongoDatabaseDump['collections'] = {}
  for (const info of infos) {
    const collection = db.collection(info.name)
    const indexes =
      info.type === 'view'
        ? []
        : ((await collection.indexes()) as Record<string, unknown>[])
            .map(({ ns: _ns, ...index }) => withoutRacedGlobalType(index))
            .sort(byName)
    collections[info.name] = {
      type: info.type,
      documents: await collection.find({}, { sort: { _id: 1 } }).toArray(),
      indexes,
      options: info.options,
    }
  }
  return { collections }
}

// ---- adapter ------------------------------------------------------------------------------------

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const describeReq = (req: any) =>
  req && typeof req === 'object'
    ? {
        $req: {
          fallbackLocale: req.fallbackLocale,
          locale: req.locale,
          transactionID: req.transactionID instanceof Promise ? '[Promise]' : req.transactionID,
        },
      }
    : req

const describeArgs = (args: unknown[]) =>
  args.map((arg) =>
    isPlainObject(arg)
      ? Object.fromEntries(
          Object.entries(arg).map(([k, v]) => [k, k === 'req' ? describeReq(v) : toComparable(v)]),
        )
      : toComparable(arg),
  )

// Captured at module load: vi.useFakeTimers() replaces the globals, not these functions.
const realNow = Date.now
const realSetImmediate = setImmediate
const realSetTimeout = setTimeout
const realClearTimeout = clearTimeout

/** See `exclusive`. */
const DEFAULT_PAIR_RELEASE_MS = Number(process.env.PAYLOAD_RS_MONGO_SHADOW_RELEASE_MS) || 1_000

type Instant = { clock: number; real: number }
type TimeWindow = { end: Instant; start: Instant }
type CallWindows = { candidate: TimeWindow; reference: TimeWindow }

const instant = (): Instant => ({ clock: Date.now(), real: realNow() })

const NOW_SLACK_MS = 1

const isInWindow = (time: number, precisionMs: number, { end, start }: TimeWindow) => {
  const last = time + precisionMs - 1
  return (
    (last >= start.clock - NOW_SLACK_MS && time <= end.clock + NOW_SLACK_MS) ||
    (last >= start.real - NOW_SLACK_MS && time <= end.real + NOW_SLACK_MS)
  )
}

type WindowStore = { all: () => CallWindows[]; push: (windows: CallWindows) => void }

/**
 * Execution windows of all pairs (timestamp rule). With `file`, windows are also appended to
 * and read from a file shared with the test's child processes (the `cli` fixture runs
 * `migrate:fresh` in a child whose stamps the test process compares later).
 */
const createWindowStore = (file: string | undefined): WindowStore => {
  const local: CallWindows[] = []
  const imported: CallWindows[] = []
  let readBytes = 0
  const readOthers = () => {
    if (!file || !fs.existsSync(file)) {
      return
    }
    const content = fs.readFileSync(file)
    const end = content.lastIndexOf(0x0a) + 1
    if (end <= readBytes) {
      return
    }
    for (const line of content.subarray(readBytes, end).toString('utf8').split('\n')) {
      if (!line) continue
      const event = JSON.parse(line) as { pid: number; windows: CallWindows }
      if (event.pid !== process.pid) {
        imported.push(event.windows)
      }
    }
    readBytes = end
  }
  return {
    all: () => {
      readOthers()
      return imported.length ? [...imported, ...local] : local
    },
    push: (windows) => {
      local.push(windows)
      if (file) {
        fs.appendFileSync(file, `${JSON.stringify({ pid: process.pid, windows })}\n`)
      }
    },
  }
}

export function createMongoShadowAdapter(args: MongoShadowAdapterArgs): AdapterObj {
  installClockReplay()
  const { candidate: candidateObj, reference: referenceObj } = args
  const reporter = createReporter(args.report)
  /** Shared by every instance (several payload instances may use the same databases). */
  const nowWindows = createWindowStore(args.crossProcessFile)

  return {
    name: referenceObj.name,
    allowIDOnCreate: referenceObj.allowIDOnCreate,
    defaultIDType: referenceObj.defaultIDType,
    init: ({ payload }) => {
      const ref = referenceObj.init({ payload }) as AnyAdapter
      const cand = candidateObj.init({ payload }) as AnyAdapter
      return createShadowInstance({ args, cand, nowWindows, ref, reporter })
    },
  }
}

type InstanceArgs = {
  args: MongoShadowAdapterArgs
  cand: AnyAdapter
  nowWindows: WindowStore
  ref: AnyAdapter
  reporter: ReturnType<typeof createReporter>
}

type Outcome = { error?: unknown; threw: boolean; value?: unknown }

const settle = async (fn: () => unknown): Promise<Outcome> => {
  try {
    return { threw: false, value: await fn() }
  } catch (error) {
    return { error, threw: true }
  }
}

function createShadowInstance({ args, cand, nowWindows, ref, reporter }: InstanceArgs): AnyAdapter {
  /** Set while the reference (or candidate) half of a pair executes. */
  const inShadowedCall = new AsyncLocalStorage<'candidate' | 'reference'>()
  const txMap = new Map<unknown, unknown>()
  /** Reference ClientSession -> candidate ClientSession of the same transaction. */
  const sessionMap = new Map<unknown, unknown>()
  const pairReleaseMs = args.pairReleaseMs ?? DEFAULT_PAIR_RELEASE_MS
  const state: MongoShadowState = {
    calls: 0,
    dbChecks: 0,
    diffDatabases: (reason = 'manual') => diffDatabases({ reason }),
    divergences: 0,
    pairsReleased: 0,
    rawMirrored: 0,
    records: [],
    serverIDsAligned: 0,
    unshadowed: {},
  }
  let proxy: AnyAdapter

  // ---- comparison -------------------------------------------------------------------------
  const nowPairCache = new Map<string, boolean>()
  const isNowPair = (reference: number, candidate: number, precisionMs: number) => {
    const key = `${reference}|${candidate}|${precisionMs}`
    if (nowPairCache.get(key)) {
      return true
    }
    const all = nowWindows.all()
    for (let i = all.length - 1; i >= 0; i--) {
      const windows = all[i]!
      if (
        isInWindow(reference, precisionMs, windows.reference) &&
        isInWindow(candidate, precisionMs, windows.candidate)
      ) {
        nowPairCache.set(key, true)
        return true
      }
    }
    return false
  }
  const compareOptions: CompareOptions = { ...args.compare, isNowPair }

  const databaseNames = () => {
    const referenceName = ref.connection?.name
    const candidateName = cand.connection?.name
    return typeof referenceName === 'string' &&
      typeof candidateName === 'string' &&
      candidateName &&
      referenceName !== candidateName
      ? { candidateName, referenceName }
      : undefined
  }
  const compareSides = (reference: unknown, candidate: unknown) => {
    const names = databaseNames()
    return compareValues(
      toComparable(reference),
      toComparable(
        candidate,
        names
          ? { replaceString: (value) => value.split(names.candidateName).join(names.referenceName) }
          : {},
      ),
      compareOptions,
    )
  }

  const diffOutcomes = (
    refOut: Outcome,
    candOut: Outcome,
    isValueCompared: boolean,
  ): Difference[] => {
    if (refOut.threw !== candOut.threw) {
      return [
        {
          candidate: candOut.threw
            ? errorShape(candOut.error)
            : truncateForReport(toComparable(candOut.value)),
          kind: 'type',
          path: '$threw',
          reference: refOut.threw
            ? errorShape(refOut.error)
            : truncateForReport(toComparable(refOut.value)),
        },
      ]
    }
    if (refOut.threw) {
      return compareSides(errorShape(refOut.error), errorShape(candOut.error))
    }
    return isValueCompared ? compareSides(refOut.value, candOut.value) : []
  }

  // ---- reporting --------------------------------------------------------------------------
  const record = (rec: ShadowRecord) => {
    if (rec.type === 'divergence') {
      state.divergences++
      state.records.push(rec)
    }
    try {
      reporter.write(rec)
    } catch (err) {
      // reporting must never break the run under test
      // eslint-disable-next-line no-console
      console.error('[shadow-mongo] failed to write report', err)
    }
    if (rec.type === 'divergence' && args.onDivergence === 'throw') {
      throw new MongoShadowDivergenceError(rec)
    }
  }

  const markUnshadowed = (method: string) => {
    const isFirst = !state.unshadowed[method]
    state.unshadowed[method] = (state.unshadowed[method] ?? 0) + 1
    if (isFirst) {
      record({ type: 'unshadowed', method })
    }
  }

  const reportDivergence = (
    method: string,
    callArgs: unknown[],
    seq: number,
    differences: Difference[],
  ) => {
    const first = callArgs[0] as Record<string, unknown> | undefined
    record({
      type: 'divergence',
      args: truncateForReport(describeArgs(callArgs)),
      collection: isPlainObject(first) ? first.collection : undefined,
      differences,
      global: isPlainObject(first) ? (first.global ?? first.slug) : undefined,
      method,
      seq,
    })
  }

  // ---- argument mapping ---------------------------------------------------------------------
  const mapTransactionID = (id: unknown): unknown => {
    if (id instanceof Promise) {
      return id.then(mapTransactionID)
    }
    return txMap.has(id) ? txMap.get(id) : id
  }

  /** Candidate view of `req`: the same object except `transactionID` mapped to the candidate's. */
  const mapReq = (req: unknown) => {
    if (!req || typeof req !== 'object' || (req as any).transactionID == null) {
      return req
    }
    const overlay: Record<PropertyKey, unknown> = {}
    return new Proxy(req as object, {
      get(target, prop, receiver) {
        if (prop in overlay) {
          return overlay[prop]
        }
        if (prop === 'transactionID') {
          return mapTransactionID((target as any).transactionID)
        }
        return Reflect.get(target, prop, receiver)
      },
      set(_target, prop, value) {
        overlay[prop] = value
        return true
      },
    })
  }

  /**
   * Deep clone of plain data for the candidate (the adapter transforms its input in place).
   * `req` is mapped, the shadow/reference instance becomes the candidate, reference sessions
   * become candidate sessions, bson values / Dates / Buffers are copied, other class instances
   * are passed by reference.
   */
  const cloneForCandidate = (
    value: unknown,
    key?: string,
    seen = new Map<object, unknown>(),
  ): unknown => {
    if (key === 'req') {
      return mapReq(value)
    }
    if (value === proxy || value === ref) {
      return cand
    }
    if (value === null || typeof value !== 'object') {
      return value
    }
    if (sessionMap.has(value)) {
      return sessionMap.get(value)
    }
    if (seen.has(value)) {
      return seen.get(value)
    }
    if (value instanceof Date) {
      return new Date(value.getTime())
    }
    if (Buffer.isBuffer(value)) {
      return Buffer.from(value)
    }
    if (Array.isArray(value)) {
      const out: unknown[] = []
      seen.set(value, out)
      for (const item of value) {
        out.push(cloneForCandidate(item, undefined, seen))
      }
      return out
    }
    if (!isPlainObject(value)) {
      const bsonType = (value as { _bsontype?: unknown })._bsontype
      if (bsonType === 'ObjectId' && typeof (value as any).toHexString === 'function') {
        return new (value.constructor as new (hex: string) => unknown)((value as any).toHexString())
      }
      return value
    }
    const out: Record<string, unknown> = {}
    seen.set(value, out)
    for (const k of Object.keys(value)) {
      out[k] = cloneForCandidate(value[k], k, seen)
    }
    return out
  }

  // ---- database state diff -------------------------------------------------------------------
  let inFlight = 0
  let isDirty = false
  let lastTestName: string | undefined
  let pendingDatabaseDiff: Promise<unknown> | undefined
  let lastDatabaseDifferences = ''

  const dumpDatabase =
    args.dumpDatabase === false ? undefined : (args.dumpDatabase ?? dumpMongooseDatabase)

  const waitForQuiescence = async () => {
    const deadline = realNow() + 5_000
    while (inFlight > 0 && realNow() < deadline) {
      await new Promise((resolve) => realSetImmediate(resolve))
    }
  }

  async function diffDatabases({
    finishedTest,
    reason,
  }: {
    finishedTest?: string
    reason: string
  }): Promise<Difference[]> {
    await waitForQuiescence()
    isDirty = false
    if (!dumpDatabase) {
      markUnshadowed('dbState')
      return []
    }
    let differences: Difference[]
    try {
      const referenceDump = await inShadowedCall.run('reference', () =>
        dumpDatabase({ adapter: ref }),
      )
      const candidateDump = await inShadowedCall.run('candidate', () =>
        dumpDatabase({ adapter: cand }),
      )
      if (referenceDump === undefined && candidateDump === undefined) {
        markUnshadowed('dbState')
        return []
      }
      differences = compareSides(referenceDump, candidateDump)
    } catch (error) {
      differences = [
        { candidate: errorShape(error), kind: 'type', path: '$threw', reference: 'ok' },
      ]
    }
    state.dbChecks++
    const serialized = differences.length ? JSON.stringify(differences) : ''
    // a divergent state usually persists across tests: report each distinct state once
    if (serialized && serialized !== lastDatabaseDifferences) {
      record({
        type: 'divergence',
        differences,
        finishedTest,
        method: 'dbState',
        reason,
        seq: ++state.calls,
      })
    }
    lastDatabaseDifferences = serialized
    return differences
  }

  /**
   * Called on entry of every pair / mirrored write: when the running test changed and
   * something was written, the previous test's final state is diffed first.
   */
  const atTestBoundary = () => {
    const { testName } = reporter.context()
    if (testName !== lastTestName) {
      const finishedTest = lastTestName
      lastTestName = testName
      if (isDirty && !pendingDatabaseDiff) {
        pendingDatabaseDiff = diffDatabases({ finishedTest, reason: 'testEnd' }).finally(() => {
          pendingDatabaseDiff = undefined
        })
      }
    }
    return pendingDatabaseDiff
  }

  // ---- method wrappers ------------------------------------------------------------------------
  const originals = new Map<string, AnyFn>()
  const wrappers = new Map<string, AnyFn>()

  const runPair = async ({
    callArgs,
    candArgs,
    isValueCompared,
    method,
    refFn,
  }: {
    callArgs: unknown[]
    candArgs: unknown[]
    isValueCompared: boolean
    method: string
    refFn: AnyFn
  }) => {
    const seq = ++state.calls
    if (!READ_METHODS.has(method)) {
      isDirty = true
    }
    inFlight++
    return exclusive(() =>
      runPairNow({ callArgs, candArgs, isValueCompared, method, refFn, seq }),
    ).finally(() => {
      inFlight--
    })
  }

  const runPairNow = async ({
    callArgs,
    candArgs,
    isValueCompared,
    method,
    refFn,
    seq,
  }: {
    callArgs: unknown[]
    candArgs: unknown[]
    isValueCompared: boolean
    method: string
    refFn: AnyFn
    seq: number
  }): Promise<Outcome> => {
    // Lifecycle methods (migrateFresh runs migrations through the Local API on each side) read
    // the clock in an order that differs between the halves (one-time initialisation on the
    // first run), so a replayed tape would hand the candidate the wrong readings; their stamps
    // fall under the timestamp rule instead.
    const tapes = createReplayTapes({ isClockReplayed: isValueCompared })
    const refStart = instant()
    let refEnd = refStart
    const refRun = settle(() =>
      tapes.reference(() => inShadowedCall.run('reference', () => refFn.apply(ref, callArgs))),
    ).then((out) => {
      refEnd = instant()
      return out
    })
    const candFn = cand[method]
    if (typeof candFn !== 'function') {
      reportDivergence(method, callArgs, seq, [
        {
          candidate: { $missingMethod: method },
          kind: 'type',
          path: '$method',
          reference: method,
        },
      ])
      return await refRun
    }
    const refOut = await refRun
    const candStart = instant()
    const candOut = await settle(() =>
      tapes.candidate(() => inShadowedCall.run('candidate', () => candFn.apply(cand, candArgs))),
    )
    nowWindows.push({
      candidate: { end: instant(), start: candStart },
      reference: { end: refEnd, start: refStart },
    })
    const differences = diffOutcomes(
      refOut,
      await alignServerGeneratedID({ callArgs, candArgs, candOut, method, refOut }),
      isValueCompared,
    )
    if (differences.length) {
      reportDivergence(method, callArgs, seq, differences)
    }
    return refOut
  }

  // ---- server-generated ids (upserts) ---------------------------------------------------------
  const hexOf = (value: unknown): string | undefined => {
    if (typeof value === 'string' && /^[0-9a-f]{24}$/.test(value)) {
      return value
    }
    if (value && typeof value === 'object' && (value as any)._bsontype === 'ObjectId') {
      return (value as any).toHexString()
    }
    return undefined
  }
  const clientProcessUnique = () => {
    let owner = (ref.connection?.base?.Types?.ObjectId ?? null) as null | Record<string, unknown>
    while (owner && !Object.prototype.hasOwnProperty.call(owner, 'getInc')) {
      owner = Object.getPrototypeOf(owner)
    }
    const unique = owner?.PROCESS_UNIQUE
    return unique instanceof Uint8Array ? Buffer.from(unique).toString('hex') : undefined
  }
  /** Bytes 4..8 of an ObjectId: the generating process (a mongod for server-generated ids). */
  const processOf = (hex: string) => hex.slice(8, 18)

  const replaceID = (
    value: unknown,
    from: string,
    to: string,
    seen = new Map<object, unknown>(),
  ): unknown => {
    if (value === from) {
      return to
    }
    if (value === null || typeof value !== 'object' || value instanceof Date) {
      return value
    }
    if (hexOf(value) === from) {
      return new (value.constructor as new (hex: string) => unknown)(to)
    }
    if (seen.has(value)) {
      return seen.get(value)
    }
    if (Array.isArray(value)) {
      const out: unknown[] = []
      seen.set(value, out)
      for (const item of value) {
        out.push(replaceID(item, from, to, seen))
      }
      return out
    }
    if (!isPlainObject(value)) {
      return value
    }
    const out: Record<string, unknown> = {}
    seen.set(value, out)
    for (const key of Object.keys(value)) {
      out[key] = replaceID(value[key], from, to, seen)
    }
    return out
  }

  /**
   * An upsert that inserts lets the MongoDB server generate the `_id` (upstream passes none), so
   * both sides get different ids no replay can align. When both results carry such an id
   * (generated by the same mongod process, not by this client), the candidate document is moved
   * to the reference's `_id` (same session) and the candidate outcome is compared with the id
   * replaced; anything else about the document is still compared.
   */
  async function alignServerGeneratedID({
    callArgs,
    candArgs,
    candOut,
    method,
    refOut,
  }: {
    callArgs: unknown[]
    candArgs: unknown[]
    candOut: Outcome
    method: string
    refOut: Outcome
  }): Promise<Outcome> {
    const first = callArgs[0] as Record<string, any> | undefined
    const isUpsert =
      method === 'upsert' ||
      (isPlainObject(first) && (first.options as { upsert?: unknown } | undefined)?.upsert === true)
    if (!isUpsert || refOut.threw || candOut.threw || !isPlainObject(first)) {
      return candOut
    }
    const refID = hexOf((refOut.value as any)?.id ?? (refOut.value as any)?._id)
    const candID = hexOf((candOut.value as any)?.id ?? (candOut.value as any)?._id)
    if (!refID || !candID || refID === candID) {
      return candOut
    }
    const clientUnique = clientProcessUnique()
    if (
      processOf(refID) !== processOf(candID) ||
      (clientUnique !== undefined && processOf(refID) === clientUnique)
    ) {
      return candOut
    }
    const Model = cand.collections?.[first.collection as string]
    const collection = Model?.collection
    if (!collection) {
      return candOut
    }
    const candReq = (candArgs[0] as Record<string, any> | undefined)?.req
    const candTransactionID = candReq ? await candReq.transactionID : undefined
    const session = candTransactionID ? cand.sessions?.[candTransactionID] : undefined
    const ObjectId = (cand.connection?.base?.Types?.ObjectId ??
      ref.connection?.base?.Types?.ObjectId) as (new (hex: string) => unknown) | undefined
    if (!ObjectId) {
      return candOut
    }
    const refReq = first.req as Record<string, any> | undefined
    const refTransactionID = refReq ? await refReq.transactionID : undefined
    const refSession = refTransactionID ? ref.sessions?.[refTransactionID] : undefined
    const refDoc = await inShadowedCall.run('reference', () =>
      ref.collections?.[first.collection as string]?.collection?.findOne(
        { _id: new ObjectId(refID) },
        refSession ? { session: refSession } : {},
      ),
    )
    const moved = await inShadowedCall.run('candidate', async () => {
      const options = session ? { session } : {}
      const doc = await collection.findOne({ _id: new ObjectId(candID) }, options)
      if (!doc) {
        return false
      }
      await collection.deleteOne({ _id: new ObjectId(candID) }, options)
      await collection.insertOne(
        { ...(followKeyOrder(doc, refDoc) as Record<string, unknown>), _id: new ObjectId(refID) },
        options,
      )
      return true
    })
    if (!moved) {
      return candOut
    }
    state.serverIDsAligned++
    return {
      threw: false,
      value: followKeyOrder(replaceID(candOut.value, candID, refID), refOut.value),
    }
  }

  /**
   * `value` with its top-level keys in the order of `model` when both have exactly the same keys
   * (otherwise unchanged). The server builds an upserted document from the query's equality
   * fields in an order that is not stable between two identical upserts (observed: `key` and
   * `user` of a `payload-preferences` upsert swap between runs), so only the order of a document
   * the server just inserted is aligned.
   */
  const followKeyOrder = (value: unknown, model: unknown) => {
    if (!isPlainObject(value) || !isPlainObject(model)) {
      return value
    }
    const keys = Object.keys(model)
    const own = Object.keys(value)
    if (keys.length !== own.length || !keys.every((key) => key in value)) {
      return value
    }
    return Object.fromEntries(keys.map((key) => [key, value[key]]))
  }

  /**
   * Pairs (reference half, then candidate half) run one at a time, so concurrent operations
   * reach both databases in the same order: generated values can be replayed and sort ties
   * (equal `createdAt`) resolve by the same insertion order on both sides. With concurrent
   * pairs the reference's apply order is not observable (response order differs from apply
   * order across pooled connections). A pair still running after `pairReleaseMs` lets the next
   * one start: on the reference a call may legitimately wait for a later one (a write outside a
   * transaction blocks until the transaction holding the document commits), so strict
   * serialisation could deadlock. Calls made from inside a pair are forwarded to the running
   * side, never queued.
   */
  let pairTail: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = pairTail.then(() => {
      const timer = realSetTimeout(() => {
        state.pairsReleased++
        release()
      }, pairReleaseMs)
      const result = fn()
      void result.then(
        () => {
          realClearTimeout(timer)
          release()
        },
        () => {
          realClearTimeout(timer)
          release()
        },
      )
      return result
    })
    pairTail = released
    return run
  }

  const unwrap = (out: Outcome) => {
    if (out.threw) {
      throw out.error
    }
    return out.value
  }

  for (const method of COMPARED_METHODS) {
    const original = ref[method]
    if (typeof original !== 'function') {
      continue
    }
    originals.set(method, original)
    wrappers.set(method, async function shadowed(...callArgs: unknown[]) {
      // clone before the reference runs: the adapter transforms its input in place
      const candArgs = callArgs.map((arg) => cloneForCandidate(arg))
      const pending = atTestBoundary()
      if (pending) {
        await pending
      }
      return unwrap(
        await runPair({
          callArgs,
          candArgs,
          isValueCompared: true,
          method,
          refFn: original,
        }),
      )
    })
  }

  for (const method of LIFECYCLE_METHODS) {
    const original = ref[method]
    if (typeof original !== 'function') {
      continue
    }
    originals.set(method, original)
    wrappers.set(method, async function shadowedLifecycle(...callArgs: unknown[]) {
      const candArgs = callArgs.map((arg) => cloneForCandidate(arg))
      if (method === 'destroy') {
        // final state of the file's last test
        const pending =
          pendingDatabaseDiff ??
          (isDirty ? diffDatabases({ finishedTest: lastTestName, reason: 'destroy' }) : undefined)
        if (pending) {
          await pending
        }
      } else {
        const pending = atTestBoundary()
        if (pending) {
          await pending
        }
      }
      const out = await runPair({
        callArgs,
        candArgs,
        isValueCompared: false,
        method,
        refFn: original,
      })
      if (method === 'init' || method === 'connect') {
        patchReferenceConnection()
        installObjectIdReplay(
          ref.mongoose?.Types?.ObjectId ?? ref.connection?.base?.Types?.ObjectId,
        )
        installObjectIdReplay(
          cand.mongoose?.Types?.ObjectId ?? cand.connection?.base?.Types?.ObjectId,
        )
      }
      return unwrap(out)
    })
  }

  if (typeof ref.beginTransaction === 'function') {
    const original = ref.beginTransaction
    originals.set('beginTransaction', original)
    wrappers.set('beginTransaction', async function shadowedBegin(...callArgs: unknown[]) {
      const candArgs = callArgs.map((arg) => cloneForCandidate(arg))
      const pending = atTestBoundary()
      if (pending) {
        await pending
      }
      const seq = ++state.calls
      inFlight++
      let refOut: Outcome
      let candOut: Outcome
      try {
        refOut = await settle(() =>
          inShadowedCall.run('reference', () => original.apply(ref, callArgs)),
        )
        candOut =
          typeof cand.beginTransaction === 'function'
            ? await settle(() =>
                inShadowedCall.run('candidate', () => cand.beginTransaction(...candArgs)),
              )
            : { threw: false, value: null }
      } finally {
        inFlight--
      }
      const nullness = (o: Outcome) =>
        o.threw ? o : { threw: false, value: o.value == null ? null : '<transaction id>' }
      const differences = diffOutcomes(nullness(refOut), nullness(candOut), true)
      if (differences.length) {
        reportDivergence('beginTransaction', callArgs, seq, differences)
      }
      if (!refOut.threw && refOut.value != null && !candOut.threw) {
        txMap.set(refOut.value, candOut.value)
        const refSession = ref.sessions?.[refOut.value as string]
        const candSession = cand.sessions?.[candOut.value as string]
        if (refSession && candSession) {
          sessionMap.set(refSession, candSession)
        }
      }
      return unwrap(refOut)
    })
  }

  for (const method of ['commitTransaction', 'rollbackTransaction'] as const) {
    const original = ref[method]
    if (typeof original !== 'function') {
      continue
    }
    originals.set(method, original)
    wrappers.set(method, async function shadowedEnd(id: unknown) {
      const pending = atTestBoundary()
      if (pending) {
        await pending
      }
      const refID = await id
      const candID = txMap.has(refID) ? txMap.get(refID) : refID == null ? refID : undefined
      txMap.delete(refID)
      const seq = ++state.calls
      isDirty = true
      inFlight++
      try {
        // exclusive like every pair: a read between the reference and the candidate commit
        // would see the transaction's writes on one side only
        const refOut = await exclusive(async () => {
          const out = await settle(() =>
            inShadowedCall.run('reference', () => original.call(ref, id)),
          )
          if (candID !== undefined && typeof cand[method] === 'function') {
            const candOut = await settle(() =>
              inShadowedCall.run('candidate', () => cand[method].call(cand, candID)),
            )
            const differences = diffOutcomes(out, candOut, false)
            if (differences.length) {
              reportDivergence(method, [refID], seq, differences)
            }
          }
          return out
        })
        return unwrap(refOut)
      } finally {
        inFlight--
      }
    })
  }

  // ---- raw collection write mirroring ---------------------------------------------------------
  const patchedCollections = new WeakSet<object>()
  const patchedConnections = new WeakSet<object>()

  function patchReferenceConnection() {
    const connection = ref.connection
    if (!connection || typeof connection !== 'object') {
      return
    }
    for (const collection of Object.values(connection.collections ?? {})) {
      patchReferenceCollection(collection)
    }
    patchNativeDb(connection.db)
    if (patchedConnections.has(connection) || typeof connection.collection !== 'function') {
      return
    }
    patchedConnections.add(connection)
    const originalCollection = connection.collection
    connection.collection = function shadowedConnectionCollection(...callArgs: unknown[]) {
      const collection = originalCollection.apply(this, callArgs)
      patchReferenceCollection(collection)
      return collection
    }
  }

  /**
   * Driver collections from `payload.db.connection.db.collection(name)` (below mongoose): mirrored
   * to the candidate's driver collection of the same name. mongoose's own collections keep the
   * driver collections they took before this patch, and their calls run inside a pair or a
   * mirrored write anyway.
   */
  function patchNativeDb(db: unknown) {
    if (!db || typeof db !== 'object' || patchedConnections.has(db)) {
      return
    }
    const target = db as AnyAdapter
    if (typeof target.collection !== 'function') {
      return
    }
    patchedConnections.add(db)
    const originalCollection = target.collection
    target.collection = function shadowedDbCollection(...callArgs: unknown[]) {
      const collection = originalCollection.apply(this, callArgs)
      patchReferenceCollection(collection, () =>
        cand.connection?.db?.collection?.(collection.collectionName),
      )
      return collection
    }
  }

  function patchReferenceCollection(
    collection: unknown,
    candidateCollection: () => AnyAdapter | undefined = () =>
      typeof cand.connection?.collection === 'function'
        ? cand.connection.collection((collection as AnyAdapter).name)
        : undefined,
  ) {
    if (!collection || typeof collection !== 'object' || patchedCollections.has(collection)) {
      return
    }
    patchedCollections.add(collection)
    const target = collection as AnyAdapter
    for (const method of MIRRORED_COLLECTION_METHODS) {
      const original = target[method]
      if (typeof original !== 'function') {
        continue
      }
      target[method] = function mirroredCollectionWrite(this: unknown, ...callArgs: unknown[]) {
        if (inShadowedCall.getStore()) {
          return original.apply(this, callArgs)
        }
        return mirrorWrite({ callArgs, candidateCollection, collection: target, method, original })
      }
    }
  }

  type MirrorArgs = {
    callArgs: unknown[]
    candidateCollection: () => AnyAdapter | undefined
    collection: AnyAdapter
    method: string
    original: AnyFn
  }

  async function mirrorWrite(mirrorArgs: MirrorArgs) {
    const pending = atTestBoundary()
    if (pending) {
      await pending
    }
    isDirty = true
    inFlight++
    try {
      const refOut = await exclusive(() => mirrorWriteNow(mirrorArgs))
      return unwrap(refOut)
    } finally {
      inFlight--
    }
  }

  async function mirrorWriteNow({
    callArgs,
    candidateCollection,
    collection,
    method,
    original,
  }: MirrorArgs): Promise<Outcome> {
    const tapes = createReplayTapes()
    const refStart = instant()
    const refOut = await settle(() =>
      tapes.reference(() =>
        inShadowedCall.run('reference', () => original.apply(collection, callArgs)),
      ),
    )
    const refEnd = instant()
    // cloned after the reference ran: the driver assigns `_id` to inserted documents in place
    const candArgs = callArgs.map((arg) => cloneForCandidate(arg))
    const candCollection = candidateCollection()
    if (!candCollection || typeof candCollection[method] !== 'function') {
      markUnshadowed(`collection.${method}`)
    } else {
      const candStart = instant()
      const candOut = await settle(() =>
        tapes.candidate(() =>
          inShadowedCall.run('candidate', () => candCollection[method](...candArgs)),
        ),
      )
      state.rawMirrored++
      nowWindows.push({
        candidate: { end: instant(), start: candStart },
        reference: { end: refEnd, start: refStart },
      })
      if (refOut.threw !== candOut.threw) {
        record({
          type: 'divergence',
          collection: collection.name ?? collection.collectionName,
          differences: diffOutcomes(refOut, candOut, false),
          method: `raw:collection.${method}`,
          seq: ++state.calls,
        })
      }
    }
    return refOut
  }

  // ---- proxy ------------------------------------------------------------------------------------
  const bound = new Map<PropertyKey, { bound: AnyFn; fn: AnyFn }>()
  /** Values of both instances before a test first assigned the property through payload.db. */
  const replacedOwnValues = new Map<string, { candidate: unknown; reference: unknown }>()

  proxy = new Proxy(ref, {
    get(target, prop) {
      if (prop === MONGO_SHADOW_STATE) {
        return state
      }
      const current = Reflect.get(target, prop)
      if (typeof prop === 'string' && wrappers.has(prop)) {
        // A test replaced/spied the method on payload.db: honour it (spies created from
        // payload.db.x wrap our wrapper, so the call still reaches both).
        return current === originals.get(prop) ? wrappers.get(prop) : current
      }
      // mongoose Models (`payload.db.globals`) are functions too: returned as they are
      if (
        typeof current === 'function' &&
        typeof prop === 'string' &&
        prop !== 'constructor' &&
        !('modelName' in current)
      ) {
        const cached = bound.get(prop)
        if (cached && cached.fn === current) {
          return cached.bound
        }
        const fn = current as AnyFn
        const wrapper = function unshadowed(this: unknown, ...callArgs: unknown[]) {
          if (!inShadowedCall.getStore()) {
            markUnshadowed(prop)
          }
          return fn.apply(target, callArgs)
        }
        bound.set(prop, { bound: wrapper, fn })
        return wrapper
      }
      return current
    },
    // vi.spyOn reads the descriptor: expose the wrapper so spies wrap the shadowed call
    getOwnPropertyDescriptor(target, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, prop)
      if (
        descriptor &&
        'value' in descriptor &&
        typeof prop === 'string' &&
        wrappers.has(prop) &&
        descriptor.value === originals.get(prop)
      ) {
        return { ...descriptor, value: wrappers.get(prop) }
      }
      return descriptor
    },
    // Configuration writes are applied to both adapters; function values (monkey patches,
    // spies) only replace the reference method.
    // A test restoring a replaced reference object (`db.connection = originalConnection` after
    // installing a fake) restores the candidate's own object, never the reference's.
    set(target, prop, value) {
      if (typeof prop === 'string' && typeof value !== 'function') {
        if (!replacedOwnValues.has(prop)) {
          replacedOwnValues.set(prop, {
            candidate: cand[prop],
            reference: Reflect.get(target, prop),
          })
        }
        const own = replacedOwnValues.get(prop)!
        cand[prop] =
          value !== null && typeof value === 'object' && value === own.reference
            ? own.candidate
            : value
      }
      return Reflect.set(target, prop, value)
    },
  })

  record({
    type: 'session',
    candidate: cand.packageName ?? cand.name,
    normalisations: NORMALISATIONS,
    reference: ref.packageName ?? ref.name,
  })

  const destroyWrapper = wrappers.get('destroy')
  const writeStats = () =>
    record({
      type: 'stats',
      calls: state.calls,
      dbChecks: state.dbChecks,
      divergences: state.divergences,
      pairsReleased: state.pairsReleased,
      rawMirrored: state.rawMirrored,
      serverIDsAligned: state.serverIDsAligned,
      unshadowed: state.unshadowed,
    })
  if (destroyWrapper) {
    wrappers.set('destroy', async function shadowedDestroy(...callArgs: unknown[]) {
      try {
        return await destroyWrapper(...callArgs)
      } finally {
        writeStats()
      }
    })
  } else {
    process.once('beforeExit', writeStats)
  }

  // A wrapper reached from inside a pair means the adapter called itself through payload.db
  // (e.g. upsert -> this.updateOne after vi.spyOn put a spy on the reference instance): only
  // forward to the side that is executing instead of starting a second pair.
  for (const [method, wrapper] of wrappers) {
    const original = originals.get(method)!
    wrappers.set(method, function shadowedEntry(...callArgs: unknown[]) {
      const side = inShadowedCall.getStore()
      if (side === 'reference') {
        return original.apply(ref, callArgs)
      }
      if (side === 'candidate') {
        return cand[method](...callArgs)
      }
      return wrapper(...callArgs)
    })
  }

  return proxy
}
