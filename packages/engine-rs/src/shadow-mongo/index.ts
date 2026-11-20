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
 * Generated values are replayed (replay.ts): inside the reference half of a pair clock readings,
 * `crypto.randomUUID()` results and bson `ObjectId.getInc()` counters are recorded and the
 * candidate half reads them back in order; a candidate that reads more or fewer values than the
 * reference is a divergence (`$generated`). A new `ObjectId` is
 * `time(Date.now()) + PROCESS_UNIQUE + inc`, so both sides generate identical ids.
 *
 * The arguments are compared too: the reference's arguments as the reference left them vs the
 * candidate's copy as the candidate left them (`$args`), so in-place mutations upstream makes
 * (`data.createdAt`, ObjectId conversion in `where`, ...) must be made by the candidate as well.
 *
 * Two scheduling modes (`mode`, PAYLOAD_RS_MONGO_SHADOW_MODE):
 * - `serial` (default): pairs run one at a time (see `exclusive`).
 * - `concurrent`: pairs are not serialised; calls the caller makes concurrently run concurrently
 *   on both sides. Only causality is kept: the candidate half of a pair starts after its own
 *   reference half settled (replay) and after the candidate halves of every pair whose reference
 *   half had settled before this pair's reference half started (see `orderCandidate`).
 *
 * Results alone don't prove the storage layout, so both databases are dumped (every collection
 * sorted by `_id`, its indexes sorted by name, its options) and diffed whenever a test that
 * wrote finishes (detected at the first database activity of the next test) and on `destroy`.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'

import type { Difference } from '../shadow/compare.js'
import type { ReportOption, ShadowContext, ShadowRecord } from '../shadow/report.js'
import type { TraceEvent, TraceLog } from './trace.js'

import { registerFlushOnFileEnd } from '../mongo-adapter/flushOnFileEnd.js'
import { errorShape, toReportValue } from '../shadow/compare.js'
import { createReporter, truncateForReport } from '../shadow/report.js'
import { toComparable } from './comparable.js'
import { compareMongoValues } from './compare.js'
import { createReplayTapes, installObjectIdReplay, installReplay } from './replay.js'
import { installDriverTrace, runTraced } from './trace.js'

export { toComparable } from './comparable.js'
export { compareAsMultiset, compareMongoValues } from './compare.js'
export { createReplayTapes, installObjectIdReplay, installReplay } from './replay.js'
export { installDriverTrace, runTraced, traceRead, withClockTrace } from './trace.js'
export type { TraceEvent, TraceLog } from './trace.js'
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
  args: "Arguments are compared after the pair: the reference's (as the reference left them) vs the candidate's copy (as the candidate left them), without `req` (the candidate's `req` is a view of the caller's, see `transactions`). Same comparison as results. Also compared: the arguments right after the method returned its promise (`$firstAwait`: mutations made before upstream's first await) and at every driver operation (`$events[i].state`).",
  beginTransaction:
    'beginTransaction() ids are random (uuid v4). Only null vs non-null is compared; the candidate id (and its ClientSession) is mapped for every later call carrying req.transactionID or that session.',
  bsonValues:
    'Values are compared after toComparable (comparable.ts): ObjectId as {$oid}, RegExp as {$regex: {source, flags}}, Decimal128 as {$decimal}, Binary as {$binary: {base64, subType}}, other bson values as {$bson, value}, mongoose documents as {$mongooseDocument: toObject()}, Map as {$map}, other class instances as {$class, value}. Only real bson instances (bson version symbol) are typed; user objects carrying a marker key are wrapped as {$obj}, so typed values never equal user data. Key order, undefined, Dates and Buffers are kept.',
  compare:
    'Strict deep comparison (compare.ts): undefined vs missing, key order, array order, class names, Error constructor/name/message/data/status (stack and cause ignored), NaN === NaN, -0 === 0. No string is rewritten (no SQL table-alias rule).',
  databaseName:
    "In candidate strings (results, errors, database dumps) the candidate's database name is replaced by the reference's (MongoDB error messages name the namespace `<db>.<collection>`).",
  databaseState:
    'Databases are compared as every non-system collection (sorted by name) with its type, options, indexes (listIndexes without `ns`, sorted by name) and documents (find sorted by _id), read through the native driver of each adapter connection, after awaiting every model init (background index builds). No document reordering beyond the _id sort is applied. Index `partialFilterExpression.globalType` is replaced by a placeholder: the globals discriminators race to create same-named indexes and the winner varies between runs.',
  errors:
    "Thrown values: primitives as they are; errors by constructor / name / message / data / status plus prototype id, own enumerable properties and `cause` (stack ignored: it names the shadow harness frames, which differ between the halves). A MongoDB server error's `errorResponse.$clusterTime` / `operationTime` (the server's logical clock at that operation, never equal for two operations) are left out (TS vs TS 2026-11-16: test/versions `should keep latest true with parallel writes`, write conflicts one increment apart).",
  events:
    'Per pair half (AsyncLocalStorage), in order: every MongoDB driver `Collection` operation (method, collection, arguments, argument-state fingerprint) and every replayed clock / uuid / ObjectId counter reading (trace.ts). The sequences must be identical (`$events`): call order, readings relative to I/O, mutation timing relative to I/O.',
  generatedValues:
    "Clock readings (Date.now(), argument-less new Date(), Date()), crypto.randomUUID() results and bson ObjectId.getInc() counters of the reference half of a pair (or mirrored raw write) are replayed in order to the candidate half (replay.ts), so 'now' stamps, uuids and client-generated ObjectIds are identical. The candidate must read exactly as many values per channel as the reference recorded: extra or missing readings are a divergence at `$generated.<clock|incs|uuids>`. Readings made by the MongoDB driver itself (the reading frame is in node_modules/mongodb/lib/: connection pool monitoring events) are neither taped nor counted: their number depends on pool state, not on the adapter. Under vi.useFakeTimers() the faked clock is used and clock readings are not counted.",
  identity:
    "Every object / function reachable from a call's arguments (outside `req`) is labelled by its path before the call, on each side (the candidate's copy mirrors the caller's objects and aliasing); results, thrown values, argument snapshots and driver-operation arguments spell such a value `{ $arg: <path>, value }`: returning, keeping or passing on the caller's very object differs from an equal copy. Non-plain objects carry a per-process prototype id (`$proto`), except hydrated mongoose documents (their prototype is each side's own Model). ClientSessions are `{ $opaque: 'session:<n>' }`, one n per reference / candidate session pair of a transaction.",
  lifecycleClock:
    'Lifecycle methods (init, connect, destroy, dropDatabase, migrateFresh) do not replay the clock (their halves read it in different orders: one-time initialisation on the first run) and their readings are not counted; ObjectId counters are still replayed. Their results are compared like data-method results. ObjectIds they generate (ObjectId or its 24-hex string) may differ only in their 4 time bytes, each inside the window of its side of the same lifecycle pair at second resolution (TS vs TS 2026-11-16: test/cli `migrate:fresh` in a child process wrote payload-migrations ids 1 s apart). The only timestamp tolerance: a differing Date (or the `toISOString()` spelling of one, as db-mongodb read transforms return the stamps a lifecycle pair wrote) is accepted when the reference value lies inside the reference execution window and the candidate value inside the candidate window of the same lifecycle pair (±1 ms; wall clock or faked clock; windows of child processes sharing `crossProcessFile` count). Dates stamped by data methods and mirrored writes must be identical.',
  nondeterministicOrder:
    "Concurrent mode only (NONDETERMINISTIC_ORDER): a read result that differs from the reference is accepted iff it strictly equals upstream TS's result on the candidate's own database (the reference's upstream method called with this = the candidate adapter, pristine copy of the arguments, run right after the candidate half). Storage order of concurrently inserted documents decides ties under the sort upstream too: the order of tied documents and, at a page boundary, which of them make the page.",
  objectIds:
    'Ids generated by the MongoDB server (an upsert that inserts: upstream passes no _id) cannot be replayed: when both results of an upsert carry an id from the same mongod process (not this client), the candidate document is moved to the reference _id (same session) and the candidate outcome is compared with that id replaced (stats `serverIDsAligned`). The server orders the fields it takes from the query differently between two identical upserts, so for such a just-inserted document the top-level key order of the stored candidate document and of the candidate result is aligned to the one of the reference (only when both have exactly the same keys).',
  upstreamRaces:
    'Concurrent mode only (UPSTREAM_RACES): in the listed tests upstream races with itself (concurrent read-modify-write of one document, concurrent transactions conflicting, workers competing for a job, concurrent creates of one unique id), so TS vs TS diverges too (each entry was observed in TS-vs-TS concurrent runs). Divergences recorded while such a test runs, and the database diff when it ends, are reported as `unshadowed` `upstreamRace:<test>` instead of divergences, and the candidate database is then reset to a copy of the reference database (stats `racesResynced`), so later tests compare from equal state again. Serial mode has no such exception.',
} as const

/**
 * Concurrent mode: where the outcome of a read depends on the database's storage order, which
 * concurrent inserts make nondeterministic upstream too (documents tying under the requested
 * sort, e.g. upstream's non-unique fallback sort `-createdAt`, come back in the order the server
 * stored them, and at a page boundary the storage order decides which tied documents make the
 * page). A read result that differs from the reference is accepted when it is strictly equal to
 * what upstream TS returns on the candidate's own database right after the candidate half (the
 * "oracle": the reference's upstream method called with `this` = the candidate adapter, with a
 * pristine copy of the arguments): the candidate then did exactly what upstream does on its
 * data, and the data itself is compared by the database diffs. Stats `orderAccepted`.
 */
export const NONDETERMINISTIC_ORDER = {
  methods: [
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
  ],
  reason:
    'Storage order of documents inserted concurrently (ties under the sort: top-level docs, join docs, distinct values).',
} as const

/**
 * Concurrent mode: upstream int tests whose outcome races with itself (NORMALISATIONS.upstreamRaces),
 * keyed by vitest's full test name. Each entry was observed diverging in a TS-vs-TS concurrent
 * shadow run (`--shadow --candidate ts --shadow-mode concurrent`, 2026-11-11).
 */
export const UPSTREAM_RACES: Readonly<Record<string, string>> = {
  'Auth > REST - admin user > logged in > Account Locking > ensure that login session expires if max login attempts is reached within narrow time-frame':
    '5 concurrent failed logins increment `loginAttempts` / set `lockUntil` on one user (read-modify-write races)',
  'Auth > REST - admin user > logged in > Account Locking > should lock the user after too many parallel attempts':
    '100 concurrent failed logins increment `loginAttempts` / set `lockUntil` on one user (read-modify-write races)',
  'LLM instructions > should initialize one instruction document per collection and global without duplicates':
    'concurrent initializations create the same unique id: which create wins (the other throws ValidationError) is the race',
  'LLM instructions > should keep initialized instructions when a caller rolls back its transaction':
    'concurrent initializations create the same unique id (one rolled back): which create wins is the race',
  'LLM instructions > should preserve concurrent request properties while isolating sync context':
    'concurrent initializations create the same unique id: which create wins is the race',
  'Queues - Payload > can reliably run workflows with parallel tasks':
    'parallel tasks push their log entries in completion order (`updateJobs` $push races)',
  'Queues - Payload > can reliably run workflows with parallel tasks that complete immediately':
    'parallel tasks push their log entries in completion order (`updateJobs` $push races)',
  'Queues - Payload > concurrency controls > should block new pending jobs when a job with same key is already running':
    'concurrent job runs compete for the same concurrency key',
  'Queues - Payload > concurrency controls > should verify exclusive concurrency prevents race conditions':
    'concurrent job runs compete for the same concurrency key',
  'Queues - Payload > should run a job only once when multiple workers poll the same queue':
    'concurrent workers compete for one job (which worker claims it)',
  'Queues - Payload > should run a job only once when multiple workers run the same job by ID':
    'concurrent workers compete for one job (which worker claims it)',
  'Queues - Payload > worker recovery > should let only one replacement worker recover a job after its original worker stops responding':
    'concurrent replacement workers compete for one stale job (which worker claims it)',
  'Versions > Collections - Local > Race conditions > should keep latest true with parallel writes':
    'concurrent transactions on one document: MongoDB write conflicts abort a server-dependent subset',
}

export type ShadowMode = 'concurrent' | 'serial'

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
  /** Scheduling mode of this instance. */
  mode: ShadowMode
  /** Concurrent mode: read results accepted by the storage-order oracle (NONDETERMINISTIC_ORDER). */
  orderAccepted: number
  /** Concurrent mode: candidate halves that started after waiting for an earlier candidate half. */
  orderedCandidates: number
  /** Concurrent mode: pairs whose candidate half overlapped another candidate half. */
  overlappingCandidates: number
  /** Pairs that ran longer than `pairReleaseMs` and let the next pair start concurrently. */
  pairsReleased: number
  /** Concurrent mode: candidate databases reset to the reference's after an UPSTREAM_RACES test. */
  racesResynced: number
  /** Raw collection writes mirrored to the candidate. */
  rawMirrored: number
  records: ShadowRecord[]
  /** Upserted documents whose server-generated `_id` was aligned (see NORMALISATIONS.objectIds). */
  serverIDsAligned: number
  /** Trace events (driver operations, generated-value readings) of reference halves compared. */
  tracedEvents: number
  /** Calls that only reached the reference, keyed by method name. */
  unshadowed: Record<string, number>
}

export type MongoShadowAdapterArgs = {
  candidate: AdapterObj
  compare?: { maxDifferences?: number }
  /** File shared with child processes running a shadow adapter on the same databases (windows). */
  crossProcessFile?: string
  /** Reads one side's database for the state diff. Default `dumpMongooseDatabase`; false skips. */
  dumpDatabase?: ((args: { adapter: AnyAdapter }) => Promise<MongoDatabaseDump | undefined>) | false
  /** Scheduling mode (see the module comment). Default PAYLOAD_RS_MONGO_SHADOW_MODE or `serial`. */
  mode?: ShadowMode
  onDivergence?: 'record' | 'throw'
  /**
   * A pair still running after this many ms lets the next pair start (see `exclusive`).
   * Default PAYLOAD_RS_MONGO_SHADOW_RELEASE_MS or 1000.
   */
  pairReleaseMs?: number
  reference: AdapterObj
  report?: ReportOption
  /** Concurrent mode: tests whose divergences are upstream races. Default UPSTREAM_RACES. */
  upstreamRaces?: Readonly<Record<string, string>>
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

const isInWindow = (time: number, { end, start }: TimeWindow) =>
  (time >= start.clock - NOW_SLACK_MS && time <= end.clock + NOW_SLACK_MS) ||
  (time >= start.real - NOW_SLACK_MS && time <= end.real + NOW_SLACK_MS)

type WindowStore = { all: () => CallWindows[]; push: (windows: CallWindows) => void }

/**
 * Execution windows of all lifecycle pairs (timestamp rule). With `file`, windows are also appended to
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
      if (!line) {
        continue
      }
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

/** Shadow adapters created in this process (stats record `instance`). */
let shadowInstances = 0

export function createMongoShadowAdapter(args: MongoShadowAdapterArgs): AdapterObj {
  installReplay()
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

/** Ordering hooks of one pair (concurrent mode, see `createGate`). */
type CandidateGate = {
  candidateDone: () => void
  candidateStarts: () => Promise<void>
  referenceSettled: () => void
  referenceStarts: () => void
}

const SERIAL_GATE: CandidateGate = {
  candidateDone: () => {},
  candidateStarts: () => Promise.resolve(),
  referenceSettled: () => {},
  referenceStarts: () => {},
}

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
  const mode: ShadowMode =
    args.mode ??
    (process.env.PAYLOAD_RS_MONGO_SHADOW_MODE === 'concurrent' ? 'concurrent' : 'serial')
  const upstreamRaces = args.upstreamRaces ?? UPSTREAM_RACES
  const state: MongoShadowState = {
    calls: 0,
    dbChecks: 0,
    diffDatabases: (reason = 'manual') => diffDatabases({ reason }),
    divergences: 0,
    mode,
    orderAccepted: 0,
    orderedCandidates: 0,
    overlappingCandidates: 0,
    pairsReleased: 0,
    racesResynced: 0,
    rawMirrored: 0,
    records: [],
    serverIDsAligned: 0,
    tracedEvents: 0,
    unshadowed: {},
  }
  let proxy: AnyAdapter

  // ---- comparison -------------------------------------------------------------------------
  const nowPairCache = new Map<string, boolean>()
  /** Timestamp rule (NORMALISATIONS.lifecycleClock): windows of lifecycle pairs only. */
  const isNowPair = (reference: number, candidate: number) => {
    const key = `${reference}|${candidate}`
    if (nowPairCache.get(key)) {
      return true
    }
    const all = nowWindows.all()
    for (let i = all.length - 1; i >= 0; i--) {
      const windows = all[i]!
      if (isInWindow(reference, windows.reference) && isInWindow(candidate, windows.candidate)) {
        nowPairCache.set(key, true)
        return true
      }
    }
    return false
  }
  /** The timestamp rule at ObjectId resolution (seconds: the time bytes of a generated id). */
  const isNowSecondPair = (reference: number, candidate: number) => {
    const inSeconds = (time: number, { end, start }: TimeWindow) =>
      (time >= Math.floor(start.clock / 1000) && time <= Math.floor(end.clock / 1000)) ||
      (time >= Math.floor(start.real / 1000) && time <= Math.floor(end.real / 1000))
    return nowWindows
      .all()
      .some(
        (windows) =>
          inSeconds(reference, windows.reference) && inSeconds(candidate, windows.candidate),
      )
  }
  const compareOptions = { ...args.compare, isNowPair, isNowSecondPair }

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
  /** ClientSession -> pair number (both sessions of one transaction share it). */
  const sessionIDs = new WeakMap<object, number>()
  const sessionLabel = (value: object) =>
    value.constructor?.name === 'ClientSession'
      ? `session:${sessionIDs.get(value) ?? 'unmapped'}`
      : undefined

  /**
   * `toComparable` of one side's value (NORMALISATIONS.identity; candidate strings get the
   * reference database name).
   */
  const comparableOf = (
    side: 'candidate' | 'reference',
    value: unknown,
    identities?: Map<unknown, string>,
  ) => {
    const names = side === 'candidate' ? databaseNames() : undefined
    return toComparable(value, {
      identities,
      opaque: sessionLabel,
      prototypes: true,
      replaceString: names
        ? (text) => text.split(names.candidateName).join(names.referenceName)
        : undefined,
    })
  }
  const compareSides = (
    reference: unknown,
    candidate: unknown,
    identities?: { candidate: Map<unknown, string>; reference: Map<unknown, string> },
  ) =>
    compareMongoValues(
      comparableOf('reference', reference, identities?.reference),
      comparableOf('candidate', candidate, identities?.candidate),
      compareOptions,
    )

  /**
   * Labels (paths) of the objects and functions reachable from a call's arguments before the
   * call (NORMALISATIONS.identity): plain objects and arrays are walked, `req`, adapters and
   * sessions are not labelled.
   */
  const labelArgs = (callArgs: unknown[]) => {
    const labels = new Map<unknown, string>()
    const visit = (value: unknown, path: string) => {
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
        return
      }
      if (
        labels.has(value) ||
        value === proxy ||
        value === ref ||
        value === cand ||
        (typeof value === 'object' && sessionLabel(value) !== undefined)
      ) {
        return
      }
      labels.set(value, path)
      if (!Array.isArray(value) && !isPlainObject(value)) {
        return
      }
      for (const key of Object.keys(value)) {
        if (key !== 'req') {
          visit((value as Record<string, unknown>)[key], `${path}.${key}`)
        }
      }
    }
    callArgs.forEach((arg, index) => visit(arg, String(index)))
    return labels
  }

  /**
   * Comparable snapshot of a call's arguments as they are now (NORMALISATIONS.args): `req`
   * left out.
   */
  const snapshotArgs = (
    side: 'candidate' | 'reference',
    callArgs: unknown[],
    identities?: Map<unknown, string>,
  ) =>
    comparableOf(
      side,
      callArgs.map((arg) =>
        isPlainObject(arg) && 'req' in arg
          ? Object.fromEntries(Object.entries(arg).filter(([key]) => key !== 'req'))
          : arg,
      ),
      identities,
    )
  const prefixPath = (prefix: string, difference: Difference): Difference => ({
    ...difference,
    path:
      difference.path.startsWith('[') || !difference.path
        ? `${prefix}${difference.path}`
        : `${prefix}.${difference.path}`,
  })
  const diffArgs = (
    referenceArgs: unknown,
    candidateArgs: unknown,
    prefix = '$args',
  ): Difference[] =>
    compareMongoValues(referenceArgs, candidateArgs, compareOptions).map((difference) =>
      prefixPath(prefix, difference),
    )

  /** Event trace of one pair half (NORMALISATIONS.events). */
  const createTraceLog = (
    side: 'candidate' | 'reference',
    callArgs: unknown[],
    identities: Map<unknown, string>,
  ): TraceLog => ({
    describe: (args) => comparableOf(side, args, identities),
    events: [] as TraceEvent[],
    fingerprint: () => JSON.stringify(toReportValue(snapshotArgs(side, callArgs, identities))),
  })

  /**
   * Thrown value as compared (NORMALISATIONS.errors): primitives as they are, errors by their
   * shape, prototype, own enumerable properties and `cause`.
   */
  const thrownTree = (error: unknown) => {
    if (!(error instanceof Error)) {
      return { thrown: error }
    }
    const own: Record<string, unknown> = {}
    for (const key of Object.keys(error)) {
      if (key !== 'stack' && key !== 'message') {
        own[key] = (error as unknown as Record<string, unknown>)[key]
      }
    }
    // NORMALISATIONS.errors: the server's cluster time of the failed operation
    if (isPlainObject(own.errorResponse)) {
      const {
        $clusterTime: _clusterTime,
        operationTime: _operationTime,
        ...response
      } = own.errorResponse
      own.errorResponse = response
    }
    return {
      cause: Object.prototype.hasOwnProperty.call(error, 'cause')
        ? { value: (error as { cause?: unknown }).cause }
        : 'absent',
      error,
      own,
    }
  }

  /** Divergences for generated values the candidate did not read 1:1 (NORMALISATIONS.generatedValues). */
  const diffGenerated = (tapes: ReturnType<typeof createReplayTapes>): Difference[] =>
    Object.entries(tapes.unmatched()).map(([channel, reads]) => ({
      candidate: { extra: reads.extra, replayed: reads.replayed },
      kind: 'value',
      path: `$generated.${channel}`,
      reference: { recorded: reads.recorded },
    }))

  const diffOutcomes = (
    refOut: Outcome,
    candOut: Outcome,
    isValueCompared: boolean,
    identities?: { candidate: Map<unknown, string>; reference: Map<unknown, string> },
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
      return compareSides(thrownTree(refOut.error), thrownTree(candOut.error), identities)
    }
    return isValueCompared ? compareSides(refOut.value, candOut.value, identities) : []
  }

  /**
   * Concurrent mode, read methods (NONDETERMINISTIC_ORDER): whether the candidate's result,
   * differing from the reference's, equals upstream's on the candidate database.
   */
  const isAcceptedByOracle = async ({
    candOut,
    method,
    oracleArgs,
    refOut,
  }: {
    candOut: Outcome
    method: string
    oracleArgs: undefined | unknown[]
    refOut: Outcome
  }): Promise<{ differences?: Difference[]; isAccepted: boolean }> => {
    if (!oracleArgs || refOut.threw || candOut.threw) {
      return { isAccepted: false }
    }
    // the reference's own upstream function (captured before any test spy) with `this` = the
    // candidate adapter: upstream's code on the candidate's models and database, unaffected by
    // whatever the candidate replaced
    const oracle = originals.get(method)
    if (typeof oracle !== 'function') {
      return { isAccepted: false }
    }
    const oracleOut = await settle(() =>
      inShadowedCall.run('candidate', () => oracle.apply(cand, oracleArgs)),
    )
    const differences = oracleOut.threw
      ? diffOutcomes(oracleOut, candOut, true)
      : compareMongoValues(
          comparableOf('candidate', oracleOut.value),
          comparableOf('candidate', candOut.value),
          compareOptions,
        )
    if (!differences.length) {
      state.orderAccepted++
    }
    return { differences, isAccepted: differences.length === 0 }
  }

  // ---- reporting --------------------------------------------------------------------------
  /**
   * Concurrent mode: the UPSTREAM_RACES test a divergence belongs to (the running test; for the
   * database diff at a test boundary, the test that just finished).
   */
  const raceOf = (rec: ShadowRecord) => {
    if (mode !== 'concurrent') {
      return undefined
    }
    const testName =
      rec.method === 'dbState' && typeof rec.finishedTest === 'string'
        ? rec.finishedTest
        : reporter.context().testName
    return testName && upstreamRaces[testName] ? testName : undefined
  }

  const record = (rec: ShadowRecord) => {
    const race = rec.type === 'divergence' ? raceOf(rec) : undefined
    if (race) {
      const key = `upstreamRace:${race}`
      state.unshadowed[key] = (state.unshadowed[key] ?? 0) + 1
      try {
        reporter.write({ ...rec, type: 'unshadowed', upstreamRace: upstreamRaces[race] })
      } catch {
        // reporting must never break the caller
      }
      return
    }
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
    // same prototype as the caller's (graphql-js passes null-prototype `where` objects)
    const out = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>
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
    if (serialized && mode === 'concurrent' && finishedTest && upstreamRaces[finishedTest]) {
      // the race decided a different state on each side: compare later tests from equal state
      await resyncCandidateDatabase()
      lastDatabaseDifferences = ''
    }
    return differences
  }

  /** Concurrent mode (UPSTREAM_RACES): the candidate database becomes a copy of the reference's. */
  async function resyncCandidateDatabase() {
    const referenceDb = ref.connection?.db
    const candidateDb = cand.connection?.db
    if (!referenceDb || !candidateDb) {
      return
    }
    await inShadowedCall.run('candidate', async () => {
      const collectionNames = async (db: AnyAdapter) =>
        (
          (await db.listCollections({ type: 'collection' }, { nameOnly: true }).toArray()) as {
            name: string
          }[]
        )
          .map(({ name }) => name)
          .filter((name) => !name.startsWith('system.'))
      const referenceNames = await collectionNames(referenceDb)
      for (const name of await collectionNames(candidateDb)) {
        if (!referenceNames.includes(name)) {
          await candidateDb.collection(name).deleteMany({})
        }
      }
      for (const name of referenceNames) {
        const documents = await referenceDb.collection(name).find({}).toArray()
        const target = candidateDb.collection(name)
        await target.deleteMany({})
        if (documents.length) {
          await target.insertMany(documents)
        }
      }
    })
    state.racesResynced++
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
    oracleArgs,
    refFn,
  }: {
    callArgs: unknown[]
    candArgs: unknown[]
    isValueCompared: boolean
    method: string
    oracleArgs?: unknown[]
    refFn: AnyFn
  }) => {
    const seq = ++state.calls
    if (!READ_METHODS.has(method)) {
      isDirty = true
    }
    inFlight++
    const gate = createGate()
    const run = () =>
      runPairNow({ callArgs, candArgs, gate, isValueCompared, method, oracleArgs, refFn, seq })
    return (mode === 'serial' ? exclusive(run) : run()).finally(() => {
      inFlight--
    })
  }

  const runPairNow = async ({
    callArgs,
    candArgs,
    gate,
    isValueCompared,
    method,
    oracleArgs,
    refFn,
    seq,
  }: {
    callArgs: unknown[]
    candArgs: unknown[]
    gate: CandidateGate
    isValueCompared: boolean
    method: string
    oracleArgs?: unknown[]
    refFn: AnyFn
    seq: number
  }): Promise<Outcome> => {
    // Lifecycle methods (migrateFresh runs migrations through the Local API on each side) read
    // the clock in an order that differs between the halves (one-time initialisation on the
    // first run), so a replayed tape would hand the candidate the wrong readings; their stamps
    // fall under the timestamp rule instead.
    const tapes = createReplayTapes({ isClockReplayed: isValueCompared })
    // labels before either half runs (the candidate's copy was made before the reference ran)
    const identities = isValueCompared
      ? { candidate: labelArgs(candArgs), reference: labelArgs(callArgs) }
      : undefined
    const refLog = identities
      ? createTraceLog('reference', callArgs, identities.reference)
      : undefined
    const candLog = identities
      ? createTraceLog('candidate', candArgs, identities.candidate)
      : undefined
    let refFirstAwait: unknown
    let candFirstAwait: unknown
    gate.referenceStarts()
    const refStart = instant()
    let refEnd = refStart
    const refRun = settle(() =>
      tapes.reference(() =>
        inShadowedCall.run('reference', () => {
          if (!refLog) {
            return refFn.apply(ref, callArgs)
          }
          return runTraced(refLog, () => {
            try {
              return refFn.apply(ref, callArgs)
            } finally {
              refFirstAwait = snapshotArgs('reference', callArgs, identities!.reference)
            }
          })
        }),
      ),
    ).then((out) => {
      refEnd = instant()
      gate.referenceSettled()
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
      const out = await refRun
      gate.candidateDone()
      return out
    }
    const refOut = await refRun
    // the caller's objects as the reference left them (the caller sees them when the pair ends)
    const refArgs = isValueCompared
      ? snapshotArgs('reference', callArgs, identities!.reference)
      : undefined
    let candOut: Outcome
    let candArgsAfter: unknown
    const candStart = instant()
    try {
      await gate.candidateStarts()
      candOut = await settle(() =>
        tapes.candidate(() =>
          inShadowedCall.run('candidate', () => {
            if (!candLog) {
              return candFn.apply(cand, candArgs)
            }
            return runTraced(candLog, () => {
              try {
                return candFn.apply(cand, candArgs)
              } finally {
                candFirstAwait = snapshotArgs('candidate', candArgs, identities!.candidate)
              }
            })
          }),
        ),
      )
      candArgsAfter = isValueCompared
        ? snapshotArgs('candidate', candArgs, identities!.candidate)
        : undefined
    } finally {
      gate.candidateDone()
    }
    if (!isValueCompared) {
      // timestamp rule: only lifecycle pairs, whose clock is not replayed
      nowWindows.push({
        candidate: { end: instant(), start: candStart },
        reference: { end: refEnd, start: refStart },
      })
    }
    const alignedOut = await alignServerGeneratedID({ callArgs, candArgs, candOut, method, refOut })
    // lifecycle results are compared too (no tolerance beyond the timestamp rule)
    let differences = diffOutcomes(refOut, alignedOut, true, identities)
    if (differences.length && oracleArgs) {
      const oracle = await isAcceptedByOracle({ candOut: alignedOut, method, oracleArgs, refOut })
      differences = oracle.isAccepted
        ? []
        : [
            ...differences,
            // what upstream TS returns on the candidate database (when consulted)
            ...(oracle.differences ?? []).map((difference) => ({
              ...difference,
              path: `$oracle.${difference.path}`,
            })),
          ]
    }
    if (isValueCompared) {
      state.tracedEvents += refLog!.events.length
      differences.push(
        ...diffArgs(refArgs, candArgsAfter),
        ...diffArgs(refFirstAwait, candFirstAwait, '$firstAwait'),
        ...compareMongoValues(refLog!.events, candLog!.events, compareOptions).map((difference) =>
          prefixPath('$events', difference),
        ),
        ...diffGenerated(tapes),
      )
    }
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
   * Concurrent mode (`mode: 'concurrent'`): the candidate half of a pair waits for the candidate
   * halves of every pair whose reference half had settled when this pair's reference half
   * started (what the caller could have observed before making this call), never for pairs
   * that overlapped it. So concurrent calls stay concurrent on both sides and causally ordered
   * calls stay ordered. A wait longer than `pairReleaseMs * 60` gives up (stats `pairsReleased`).
   * In serial mode every method is a no-op (`exclusive` serialises whole pairs).
   */
  type CandidateTrack = { done: Promise<void>; resolve: () => void }
  const settledReferencesPendingCandidates = new Set<CandidateTrack>()
  let runningCandidates = 0
  const createGate = (): CandidateGate => {
    if (mode === 'serial') {
      return SERIAL_GATE
    }
    let predecessors: CandidateTrack[] = []
    let resolveDone: () => void = () => {}
    const track: CandidateTrack = {
      done: new Promise<void>((resolve) => {
        resolveDone = resolve
      }),
      resolve: () => resolveDone(),
    }
    let isRunning = false
    let isDone = false
    return {
      candidateDone: () => {
        if (isDone) {
          return
        }
        isDone = true
        if (isRunning) {
          runningCandidates--
        }
        settledReferencesPendingCandidates.delete(track)
        track.resolve()
      },
      candidateStarts: async () => {
        const waiting = predecessors.filter((t) => settledReferencesPendingCandidates.has(t))
        if (waiting.length) {
          state.orderedCandidates++
          let timer: ReturnType<typeof setTimeout> | undefined
          await Promise.race([
            Promise.all(waiting.map((t) => t.done)),
            new Promise<void>((resolve) => {
              timer = realSetTimeout(() => {
                state.pairsReleased++
                resolve()
              }, pairReleaseMs * 60)
            }),
          ])
          realClearTimeout(timer)
        }
        if (runningCandidates > 0) {
          state.overlappingCandidates++
        }
        runningCandidates++
        isRunning = true
      },
      referenceSettled: () => {
        if (!isDone) {
          settledReferencesPendingCandidates.add(track)
        }
      },
      referenceStarts: () => {
        predecessors = [...settledReferencesPendingCandidates]
      },
    }
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
    if (mode === 'concurrent') {
      return fn()
    }
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
      const oracleArgs =
        mode === 'concurrent' &&
        (NONDETERMINISTIC_ORDER.methods as readonly string[]).includes(method)
          ? callArgs.map((arg) => cloneForCandidate(arg))
          : undefined
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
          oracleArgs,
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
        installDriverTrace((ref.mongoose ?? ref.connection?.base)?.mongo?.Collection)
        installDriverTrace((cand.mongoose ?? cand.connection?.base)?.mongo?.Collection)
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
          const sessionID = sessionMap.size
          sessionIDs.set(refSession as object, sessionID)
          sessionIDs.set(candSession as object, sessionID)
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
        // exclusive (serial) / causally ordered (concurrent) like every pair: a read between
        // the reference and the candidate commit would see the transaction's writes on one side
        // only
        const gate = createGate()
        const refOut = await exclusive(async () => {
          gate.referenceStarts()
          const out = await settle(() =>
            inShadowedCall.run('reference', () => original.call(ref, id)),
          )
          gate.referenceSettled()
          try {
            if (candID !== undefined && typeof cand[method] === 'function') {
              await gate.candidateStarts()
              const candOut = await settle(() =>
                inShadowedCall.run('candidate', () => cand[method].call(cand, candID)),
              )
              const differences = diffOutcomes(out, candOut, false)
              if (differences.length) {
                reportDivergence(method, [refID], seq, differences)
              }
            }
          } finally {
            gate.candidateDone()
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
      const refOut = await exclusive(() => mirrorWriteNow(mirrorArgs, createGate()))
      return unwrap(refOut)
    } finally {
      inFlight--
    }
  }

  /**
   * Raw writes are mirrored, not under test (the same driver on both sides): generated values are
   * replayed but not accounted, results are not compared (only thrown / not thrown).
   */
  async function mirrorWriteNow(
    { callArgs, candidateCollection, collection, method, original }: MirrorArgs,
    gate: CandidateGate,
  ): Promise<Outcome> {
    const tapes = createReplayTapes()
    gate.referenceStarts()
    const refOut = await settle(() =>
      tapes.reference(() =>
        inShadowedCall.run('reference', () => original.apply(collection, callArgs)),
      ),
    )
    gate.referenceSettled()
    // cloned after the reference ran: the driver assigns `_id` to inserted documents in place
    const candArgs = callArgs.map((arg) => cloneForCandidate(arg))
    const candCollection = candidateCollection()
    if (!candCollection || typeof candCollection[method] !== 'function') {
      gate.candidateDone()
      markUnshadowed(`collection.${method}`)
    } else {
      let candOut: Outcome
      try {
        await gate.candidateStarts()
        candOut = await settle(() =>
          tapes.candidate(() =>
            inShadowedCall.run('candidate', () => candCollection[method](...candArgs)),
          ),
        )
      } finally {
        gate.candidateDone()
      }
      state.rawMirrored++
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
  let isStatsWritten = false
  // stats records are cumulative: readers keep the last one per instance
  const instance = `${process.pid}:${++shadowInstances}`
  const writeStats = () => {
    isStatsWritten = true
    record({
      type: 'stats',
      calls: state.calls,
      dbChecks: state.dbChecks,
      divergences: state.divergences,
      instance,
      mode: state.mode,
      orderAccepted: state.orderAccepted,
      orderedCandidates: state.orderedCandidates,
      overlappingCandidates: state.overlappingCandidates,
      pairsReleased: state.pairsReleased,
      racesResynced: state.racesResynced,
      rawMirrored: state.rawMirrored,
      serverIDsAligned: state.serverIDsAligned,
      tracedEvents: state.tracedEvents,
      unshadowed: state.unshadowed,
    })
  }
  // a Payload the test never destroys: its totals are written when the test file ends
  registerFlushOnFileEnd(() => {
    if (!isStatsWritten) {
      writeStats()
    }
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
