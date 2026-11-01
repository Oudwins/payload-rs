/**
 * Differential ("shadow") database adapter.
 *
 * `createShadowAdapter({ reference, candidate })` returns a regular Payload
 * `DatabaseAdapterObj` (the value of `buildConfig({ db })`). Every adapter
 * method Payload (or a test) calls is executed on the reference adapter and
 * then on the candidate adapter, the two results (or thrown errors) are
 * deep-compared and any divergence is appended to a JSONL report. The
 * reference result is always what the caller receives, so the upstream suite
 * behaves exactly as with the reference adapter alone.
 *
 * `payload.db` is a Proxy over the reference adapter instance: every property
 * that is not a shadowed method (`drizzle`, `tables`, `name`, `sessions`, ...)
 * is read from and written to the reference.
 *
 * Raw SQL issued outside of a shadowed method (e.g. `payload.db.execute`,
 * `payload.db.drizzle.insert(...)`, test snapshot restore helpers) is
 * mirrored to the candidate at the libsql client level so both databases stay
 * in the same state (see `mirrorRaw`).
 *
 * Results alone don't prove the storage layout, so the database contents
 * (sqlite_master + every table's rows) of both sides are diffed whenever a
 * test that wrote finishes (detected at the first database activity of the
 * next test) and on `destroy` (see `dumpDatabase`).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'

import type { CompareOptions, Difference } from './compare.js'
import type { ReportOption, ShadowRecord } from './report.js'

import { createClockTapes, installClockReplay } from './clock.js'
import { compareValues, errorShape, NORMALISATIONS } from './compare.js'
import { createReporter, truncateForReport } from './report.js'

export { createClockTapes, installClockReplay } from './clock.js'
export { compareValues, NORMALISATIONS, toReportValue } from './compare.js'
export type { CompareOptions, Difference } from './compare.js'
export { reportFileName } from './report.js'
export type { ReportOption, ShadowContext, ShadowRecord } from './report.js'

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
export const LIFECYCLE_METHODS = ['init', 'connect', 'destroy', 'dropDatabase'] as const

export const TRANSACTION_METHODS = [
  'beginTransaction',
  'commitTransaction',
  'rollbackTransaction',
] as const

/** libsql `Client` methods that write and are mirrored when called outside a shadowed method. */
const MIRRORED_CLIENT_METHODS = ['execute', 'batch', 'migrate', 'executeMultiple'] as const
type ClientMethod = (typeof MIRRORED_CLIENT_METHODS)[number]

/**
 * Structural shape of payload's `DatabaseAdapterObj` (the value of
 * `buildConfig({ db })`), so this module needs no runtime or type dependency
 * on `payload`.
 */
export type AdapterObj = {
  allowIDOnCreate?: boolean
  defaultIDType: 'number' | 'text'
  init: (args: { payload: any }) => any
  name?: string
}

type AnyAdapter = Record<string, any>
type AnyFn = (...args: any[]) => any

/** Database contents as compared by the shadow (see NORMALISATIONS.databaseState). */
export type DatabaseDump = {
  /** sqlite_master rows (type, name, tbl_name, sql) keyed by `<type> <name>`, ordered by type, name. */
  schema: Record<string, Record<string, unknown>>
  /** Rows of every table in rowid order, keyed by table name. */
  tables: Record<string, Record<string, unknown>[]>
}

export type ShadowState = {
  calls: number
  /** Number of reference vs candidate database diffs performed. */
  dbChecks: number
  /**
   * Diffs both databases now (waits for in-flight shadowed calls first) and
   * records a `dbState` divergence when they differ.
   */
  diffDatabases: (reason?: string) => Promise<Difference[]>
  divergences: number
  /** Raw client statements mirrored to the candidate. */
  rawMirrored: number
  /** Divergence records of this adapter instance (also written to the report). */
  records: ShadowRecord[]
  /** Calls that only reached the reference, keyed by method name. */
  unshadowed: Record<string, number>
}

export type ShadowAdapterArgs = {
  /** Adapter under test. */
  candidate: AdapterObj
  /** Options for the deep comparison (`isNowPair` is supplied by the shadow). */
  compare?: Omit<CompareOptions, 'isNowPair'>
  /**
   * Coordination file shared with other processes that run a shadow adapter
   * on the same database files (e.g. a test's child process). Each process
   * appends its call windows (timestamp rule, see NORMALISATIONS) and the
   * start/end of its shadowed pairs, and reads the others': stamps made by
   * another process are accepted under the same rule, and a pair (or database
   * diff) waits until no other process has a pair in flight (max
   * `CROSS_PROCESS_WAIT_MS`), so it never sees one side of another process's
   * write without the other.
   */
  crossProcessFile?: string
  /**
   * Reads one side's database for the state diff. Default: `dumpClientDatabase`
   * on the adapter's libsql-compatible `client`. Return undefined (or set
   * `false`) to skip the diff; skipped diffs are counted as unshadowed `dbState`.
   */
  dumpDatabase?:
    | ((args: {
        adapter: AnyAdapter
        side: 'candidate' | 'reference'
      }) => Promise<DatabaseDump | undefined>)
    | false
  /**
   * Mirrors a raw libsql client call that happened on the reference outside of
   * a shadowed method. Default: call the same method on `candidate.client`
   * when the candidate has a libsql-compatible client, otherwise record it as
   * unshadowed.
   */
  mirrorRaw?: (args: {
    args: unknown[]
    candidate: AnyAdapter
    method: (typeof MIRRORED_CLIENT_METHODS)[number]
  }) => Promise<boolean>
  /** `'throw'` additionally throws after recording (default `'record'`). */
  onDivergence?: 'record' | 'throw'
  /** Adapter whose results are returned (upstream TS adapter). */
  reference: AdapterObj
  /** Where divergences go. Default: `.rs-baseline/divergences/no-test-file.jsonl`. */
  report?: ReportOption
  /**
   * Run every shadowed call (reference + candidate pair) exclusively, so
   * concurrent operations hit both databases in exactly the same order.
   * Default false: serialising changes how the reference interleaves
   * concurrent writes (bulk update/delete run per-document operations in
   * parallel), i.e. it alters the reference behaviour under test. Without it
   * each candidate call starts right after its reference call settles.
   */
  serialize?: boolean
}

export const SHADOW_STATE = Symbol.for('payload.rs.shadowState')

/** Returns the shadow bookkeeping for a `payload.db` created by `createShadowAdapter`. */
export const getShadowState = (db: unknown): ShadowState | undefined =>
  db && typeof db === 'object' ? (db as any)[SHADOW_STATE] : undefined

export class ShadowDivergenceError extends Error {
  constructor(record: ShadowRecord) {
    super(`Shadow divergence in ${String(record.method)}: ${JSON.stringify(record.differences)}`)
    this.name = 'ShadowDivergenceError'
  }
}

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

/** Argument summary for the report (req replaced by locale/transaction info). */
const describeArgs = (args: unknown[]) =>
  args.map((arg) =>
    isPlainObject(arg)
      ? Object.fromEntries(
          Object.entries(arg).map(([k, v]) => [k, k === 'req' ? describeReq(v) : v]),
        )
      : arg,
  )

const sqlOf = (stmt: unknown): string =>
  typeof stmt === 'string'
    ? stmt
    : stmt && typeof stmt === 'object'
      ? String((stmt as any).sql)
      : ''

const isReadOnlySQL = (sql: string) => /^\s*select\b/i.test(sql)

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

// Captured at module load: vi.useFakeTimers() replaces the globals, not these functions.
const realNow = Date.now
const realSetImmediate = setImmediate
const realSetTimeout = setTimeout

/** Time on the (possibly faked) `Date` clock and on the real wall clock. */
type Instant = { clock: number; real: number }
type TimeWindow = { end: Instant; start: Instant }
/** Execution windows of one shadowed call / mirrored raw statement on each side. */
type CallWindows = { candidate: TimeWindow; reference: TimeWindow }

const instant = (): Instant => ({ clock: Date.now(), real: realNow() })

/** SQLite's `'now'` and V8's Date.now() both floor the same clock to ms; 1 ms of slack. */
const NOW_SLACK_MS = 1

/** A value `time` of resolution `precisionMs` stands for `[time, time + precisionMs)`. */
const isInWindow = (time: number, precisionMs: number, { end, start }: TimeWindow) => {
  const last = time + precisionMs - 1
  return (
    (last >= start.clock - NOW_SLACK_MS && time <= end.clock + NOW_SLACK_MS) ||
    (last >= start.real - NOW_SLACK_MS && time <= end.real + NOW_SLACK_MS)
  )
}

/** Max time a pair waits for other processes' in-flight pairs (see `crossProcessFile`). */
const CROSS_PROCESS_WAIT_MS = 2_000

type CrossProcessEvent =
  | { end: number; pid: number }
  | { pid: number; start: number }
  | { pid: number; windows: CallWindows }

type NowWindows = {
  /** Records the start of a shadowed pair; returns its end callback. */
  pairStarted: () => () => void
  push: (windows: CallWindows) => void
  /** Newest first; includes windows of other processes sharing `crossProcessFile`. */
  some: (predicate: (windows: CallWindows) => boolean) => boolean
  /**
   * Resolves once no other process sharing `crossProcessFile` has a pair in
   * flight; undefined when none is (callers don't yield then).
   */
  waitForOtherProcesses: () => Promise<void> | undefined
}

/** Pair ids are unique per process (several shadow adapters may share one file). */
let crossProcessPairs = 0

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const createNowWindows = (file: string | undefined): NowWindows => {
  const local: CallWindows[] = []
  const imported: CallWindows[] = []
  /** `<pid>:<pair>` of other processes' pairs that started and did not end yet. */
  const othersInFlight = new Set<string>()
  let readBytes = 0
  const append = (event: CrossProcessEvent) => {
    if (file) {
      fs.appendFileSync(file, `${JSON.stringify(event)}\n`)
    }
  }
  const readOthers = () => {
    if (!file) {
      return
    }
    let content: Buffer
    try {
      const fd = fs.openSync(file, 'r')
      try {
        const size = fs.fstatSync(fd).size
        if (size <= readBytes) {
          return
        }
        content = Buffer.alloc(size - readBytes)
        fs.readSync(fd, content, 0, content.length, readBytes)
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return
    }
    // only complete lines; a partially appended line is read next time
    const end = content.lastIndexOf(0x0a) + 1
    readBytes += end
    for (const line of content.subarray(0, end).toString('utf8').split('\n')) {
      if (!line) {
        continue
      }
      const event = JSON.parse(line) as CrossProcessEvent
      if (event.pid === process.pid) {
        continue
      }
      if ('windows' in event) {
        imported.push(event.windows)
      } else if ('start' in event) {
        othersInFlight.add(`${event.pid}:${event.start}`)
      } else {
        othersInFlight.delete(`${event.pid}:${event.end}`)
      }
    }
  }
  const someIn = (list: CallWindows[], predicate: (windows: CallWindows) => boolean) => {
    for (let i = list.length - 1; i >= 0; i--) {
      if (predicate(list[i]!)) {
        return true
      }
    }
    return false
  }
  return {
    pairStarted() {
      if (!file) {
        return () => {}
      }
      const pair = ++crossProcessPairs
      append({ pid: process.pid, start: pair })
      return () => append({ end: pair, pid: process.pid })
    },
    push(windows) {
      local.push(windows)
      append({ pid: process.pid, windows })
    },
    some(predicate) {
      if (someIn(local, predicate)) {
        return true
      }
      readOthers()
      return someIn(imported, predicate)
    },
    waitForOtherProcesses() {
      readOthers()
      if (!othersInFlight.size) {
        return undefined
      }
      return (async () => {
        const deadline = realNow() + CROSS_PROCESS_WAIT_MS
        while (othersInFlight.size && realNow() < deadline) {
          for (const key of othersInFlight) {
            // a killed process never ends its pair
            if (!isProcessAlive(Number(key.split(':')[0]))) {
              othersInFlight.delete(key)
            }
          }
          await new Promise((resolve) => realSetTimeout(resolve, 1))
          readOthers()
        }
      })()
    },
  }
}

const SQL_IDENTIFIER_QUOTE = /"/g

/**
 * Reads sqlite_master and every table's rows through a libsql-compatible
 * client (`execute(sql) -> { columns, rows }`). Returns undefined when the
 * adapter has no such client.
 */
export const dumpClientDatabase = async (client: unknown): Promise<DatabaseDump | undefined> => {
  if (!client || typeof (client as AnyAdapter).execute !== 'function') {
    return undefined
  }
  const execute = (sql: string) => (client as AnyAdapter).execute(sql)
  const toObjects = (result: { columns: string[]; rows: ArrayLike<unknown>[] }) =>
    result.rows.map((row) =>
      Object.fromEntries(result.columns.map((column, index) => [column, row[index]])),
    )
  const schema = toObjects(
    await execute('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name'),
  )
  const tables: DatabaseDump['tables'] = {}
  for (const entry of schema) {
    if (entry.type !== 'table') {
      continue
    }
    const quoted = `"${String(entry.name).replace(SQL_IDENTIFIER_QUOTE, '""')}"`
    tables[String(entry.name)] = toObjects(await execute(`SELECT * FROM ${quoted} ORDER BY rowid`))
  }
  return {
    schema: Object.fromEntries(schema.map((entry) => [`${entry.type} ${entry.name}`, entry])),
    tables,
  }
}

export function createShadowAdapter(args: ShadowAdapterArgs): AdapterObj {
  installClockReplay()
  const { candidate: candidateObj, reference: referenceObj } = args
  const serialize = args.serialize ?? false
  const reporter = createReporter(args.report)
  /**
   * Shared by every instance of this adapter: several payload instances can use
   * the same database files (e.g. `getPayload` with another config), so values
   * one instance stamped show up in another instance's database diff.
   */
  const nowWindows = createNowWindows(args.crossProcessFile)
  const mirrorRaw =
    args.mirrorRaw ??
    (async ({ args: callArgs, candidate, method }) => {
      const client = candidate.client
      if (!client || typeof client[method] !== 'function') {
        return false
      }
      await client[method](...callArgs)
      return true
    })

  return {
    name: referenceObj.name,
    allowIDOnCreate: referenceObj.allowIDOnCreate,
    defaultIDType: referenceObj.defaultIDType,
    init: ({ payload }) => {
      const ref = referenceObj.init({ payload }) as AnyAdapter
      const cand = candidateObj.init({ payload }) as AnyAdapter
      return createShadowInstance({
        args,
        cand,
        mirrorRaw,
        nowWindows,
        ref,
        reporter,
        serialize,
      })
    },
  }
}

type InstanceArgs = {
  args: ShadowAdapterArgs
  cand: AnyAdapter
  mirrorRaw: NonNullable<ShadowAdapterArgs['mirrorRaw']>
  /** Execution windows of every shadowed call / mirrored raw statement of all instances. */
  nowWindows: NowWindows
  ref: AnyAdapter
  reporter: ReturnType<typeof createReporter>
  serialize: boolean
}

function createShadowInstance({
  args,
  cand,
  mirrorRaw,
  nowWindows,
  ref,
  reporter,
  serialize,
}: InstanceArgs): AnyAdapter {
  /** Set while the reference (or candidate) executes a shadowed method; raw client calls are then not mirrored. */
  const inShadowedCall = new AsyncLocalStorage<'candidate' | 'reference'>()
  const txMap = new Map<unknown, unknown>()
  const state: ShadowState = {
    calls: 0,
    dbChecks: 0,
    diffDatabases: (reason = 'manual') => diffDatabases({ reason }),
    divergences: 0,
    rawMirrored: 0,
    records: [],
    unshadowed: {},
  }
  let proxy: AnyAdapter

  // ---- 'now' timestamps -------------------------------------------------------
  const nowPairCache = new Map<string, boolean>()
  /** True when both values were stamped during the same shadowed call (see NORMALISATIONS.timestamps). */
  const isNowPair = (reference: number, candidate: number, precisionMs: number) => {
    const key = `${reference}|${candidate}|${precisionMs}`
    const cached = nowPairCache.get(key)
    if (cached !== undefined) {
      return cached
    }
    const isPair = nowWindows.some(
      (windows) =>
        isInWindow(reference, precisionMs, windows.reference) &&
        isInWindow(candidate, precisionMs, windows.candidate),
    )
    // windows only grow, so only a positive answer is final
    if (isPair) {
      nowPairCache.set(key, true)
    }
    return isPair
  }
  const compareOptions: CompareOptions = { ...args.compare, isNowPair }

  // ---- serialisation ------------------------------------------------------
  let tail: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    if (!serialize) {
      return fn()
    }
    const run = tail.then(fn, fn)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // ---- reporting ----------------------------------------------------------
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
      console.error('[shadow] failed to write report', err)
    }
    if (rec.type === 'divergence' && args.onDivergence === 'throw') {
      throw new ShadowDivergenceError(rec)
    }
  }

  const markUnshadowed = (method: string) => {
    const first = !state.unshadowed[method]
    state.unshadowed[method] = (state.unshadowed[method] ?? 0) + 1
    if (first) {
      record({ type: 'unshadowed', method })
    }
  }

  // ---- argument mapping ---------------------------------------------------
  const mapTransactionID = (id: unknown): unknown => {
    if (id instanceof Promise) {
      return id.then(mapTransactionID)
    }
    return txMap.has(id) ? txMap.get(id) : id
  }

  /** Candidate view of `req`: same object except `transactionID` mapped to the candidate session. */
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
   * Deep clone of plain data for the candidate (adapters mutate their input,
   * e.g. drizzle createGlobal sets `data.createdAt`). `req` is mapped, the
   * shadow/reference adapter instance is swapped for the candidate, class
   * instances are passed by reference.
   */
  const cloneForCandidate = (value: unknown, key?: string, seen = new Map<object, unknown>()) => {
    if (key === 'req') {
      return mapReq(value)
    }
    if (value === proxy || value === ref) {
      return cand
    }
    if (value === null || typeof value !== 'object') {
      return value
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
      return value
    }
    const out: Record<string, unknown> = {}
    seen.set(value, out)
    for (const k of Object.keys(value)) {
      out[k] = cloneForCandidate(value[k], k, seen)
    }
    return out
  }

  type Outcome = { error?: unknown; threw: boolean; value?: unknown }

  const settle = async (fn: () => unknown): Promise<Outcome> => {
    try {
      return { threw: false, value: await fn() }
    } catch (error) {
      return { error, threw: true }
    }
  }

  const diffOutcomes = (refOut: Outcome, candOut: Outcome, valueCompare: boolean): Difference[] => {
    if (refOut.threw !== candOut.threw) {
      return [
        {
          candidate: candOut.threw ? errorShape(candOut.error) : truncateForReport(candOut.value),
          kind: 'type',
          path: '$threw',
          reference: refOut.threw ? errorShape(refOut.error) : truncateForReport(refOut.value),
        },
      ]
    }
    if (refOut.threw) {
      return compareValues(errorShape(refOut.error), errorShape(candOut.error), compareOptions)
    }
    return valueCompare ? compareValues(refOut.value, candOut.value, compareOptions) : []
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

  // ---- database state diff ---------------------------------------------------
  /** Shadowed pairs / mirrored raw statements currently executing. */
  let inFlight = 0
  /** Something may have written since the last database diff. */
  let isDirty = false
  let lastTestName: string | undefined
  let pendingDatabaseDiff: Promise<unknown> | undefined
  let lastDatabaseDifferences = ''

  const dumpDatabase =
    args.dumpDatabase === false
      ? undefined
      : (args.dumpDatabase ??
        (({ adapter }) => dumpClientDatabase(unpatchedClient(adapter.client))))

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
    await nowWindows.waitForOtherProcesses()
    isDirty = false
    if (!dumpDatabase) {
      markUnshadowed('dbState')
      return []
    }
    let differences: Difference[]
    try {
      const referenceDump = await inShadowedCall.run('reference', () =>
        dumpDatabase({ adapter: ref, side: 'reference' }),
      )
      const candidateDump = await inShadowedCall.run('candidate', () =>
        dumpDatabase({ adapter: cand, side: 'candidate' }),
      )
      if (referenceDump === undefined && candidateDump === undefined) {
        markUnshadowed('dbState')
        return []
      }
      differences = compareValues(referenceDump, candidateDump, compareOptions)
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
   * Called on entry of every shadowed call / mirrored write. When the running
   * test changed since the last database activity and something was written,
   * the previous test's final state is diffed before this call proceeds.
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

  // ---- method wrappers ----------------------------------------------------
  const originals = new Map<string, AnyFn>()
  const wrappers = new Map<string, AnyFn>()

  /**
   * Runs one call on both sides. `isConcurrent` starts the candidate right
   * after the reference started (before it settles), so concurrent calls
   * overlap on the candidate exactly as they overlap on the reference and
   * both databases see the same statement interleaving (e.g. bulk update runs
   * its per-document writes in parallel). Lifecycle methods run sequentially.
   */
  const runPair = async ({
    callArgs,
    candArgs,
    isConcurrent,
    isValueCompared,
    method,
    refFn,
  }: {
    callArgs: unknown[]
    candArgs: unknown[]
    isConcurrent: boolean
    isValueCompared: boolean
    method: string
    refFn: AnyFn
  }) => {
    const waiting = nowWindows.waitForOtherProcesses()
    if (waiting) {
      await waiting
    }
    const seq = ++state.calls
    if (!READ_METHODS.has(method)) {
      isDirty = true
    }
    inFlight++
    const pairEnded = nowWindows.pairStarted()
    try {
      const clock = createClockTapes()
      const refStart = instant()
      let refEnd = refStart
      const refRun = settle(() =>
        clock.reference(() => inShadowedCall.run('reference', () => refFn.apply(ref, callArgs))),
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
      if (!isConcurrent) {
        await refRun
      }
      const candStart = instant()
      const candRun = settle(() =>
        clock.candidate(() => inShadowedCall.run('candidate', () => candFn.apply(cand, candArgs))),
      )
      const [refOut, candOut] = await Promise.all([refRun, candRun])
      nowWindows.push({
        candidate: { end: instant(), start: candStart },
        reference: { end: refEnd, start: refStart },
      })
      const differences = diffOutcomes(refOut, candOut, isValueCompared)
      if (differences.length) {
        reportDivergence(method, callArgs, seq, differences)
      }
      return refOut
    } finally {
      pairEnded()
      inFlight--
    }
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
    wrappers.set(method, function shadowed(...callArgs: unknown[]) {
      // clone before the reference runs: reference adapters mutate their input
      const candArgs = callArgs.map((arg) => cloneForCandidate(arg))
      return exclusive(async () => {
        const pending = atTestBoundary()
        if (pending) {
          await pending
        }
        return unwrap(
          await runPair({
            callArgs,
            candArgs,
            isConcurrent: true,
            isValueCompared: true,
            method,
            refFn: original,
          }),
        )
      })
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
      }
      const out = await runPair({
        callArgs,
        candArgs,
        isConcurrent: false,
        isValueCompared: false,
        method,
        refFn: original,
      })
      if (method === 'connect') {
        patchClients()
      }
      return unwrap(out)
    })
  }

  // beginTransaction: ids are random -> compare null vs non-null, remember mapping
  if (typeof ref.beginTransaction === 'function') {
    const original = ref.beginTransaction
    originals.set('beginTransaction', original)
    wrappers.set('beginTransaction', function shadowedBegin(...callArgs: unknown[]) {
      const candArgs = callArgs.map((arg) => cloneForCandidate(arg))
      return exclusive(async () => {
        const pending = atTestBoundary()
        if (pending) {
          await pending
        }
        const seq = ++state.calls
        inFlight++
        let refOut: Outcome
        let candOut: Outcome
        try {
          // started together, like compared methods (see runPair isConcurrent)
          ;[refOut, candOut] = await Promise.all([
            settle(() => inShadowedCall.run('reference', () => original.apply(ref, callArgs))),
            typeof cand.beginTransaction === 'function'
              ? settle(() =>
                  inShadowedCall.run('candidate', () => cand.beginTransaction(...candArgs)),
                )
              : { threw: false, value: null },
          ])
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
        }
        return unwrap(refOut)
      })
    })
  }

  for (const method of ['commitTransaction', 'rollbackTransaction'] as const) {
    const original = ref[method]
    if (typeof original !== 'function') {
      continue
    }
    originals.set(method, original)
    wrappers.set(method, function shadowedEnd(id: unknown) {
      return exclusive(async () => {
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
          const refRun = settle(() => inShadowedCall.run('reference', () => original.call(ref, id)))
          if (candID !== undefined && typeof cand[method] === 'function') {
            const [refOut, candOut] = await Promise.all([
              refRun,
              settle(() => inShadowedCall.run('candidate', () => cand[method].call(cand, candID))),
            ])
            const differences = diffOutcomes(refOut, candOut, false)
            if (differences.length) {
              reportDivergence(method, [refID], seq, differences)
            }
            return unwrap(refOut)
          }
          return unwrap(await refRun)
        } finally {
          inFlight--
        }
      })
    })
  }

  // ---- raw SQL mirroring ----------------------------------------------------
  /** Client methods as they were before the shadow (or a test) patched them, per client. */
  const clientOriginals = new WeakMap<object, Partial<Record<ClientMethod, AnyFn>>>()
  /** The shadow's own wrappers installed on the reference client. */
  const referenceClientWrappers: Partial<Record<ClientMethod, AnyFn>> = {}
  /** Set while a raw reference statement is replayed on the candidate. */
  const isMirroringRaw = new AsyncLocalStorage<boolean>()

  /** `client` with its original `execute`, bypassing the shadow's and tests' patches (database dumps). */
  const unpatchedClient = (client: unknown) => {
    const original =
      client && typeof client === 'object' ? clientOriginals.get(client)?.execute : undefined
    return original
      ? { execute: (...callArgs: unknown[]) => original.apply(client, callArgs) }
      : client
  }

  const patchClients = () => {
    patchReferenceClient()
    patchCandidateClient()
  }

  const patchedClients = new WeakSet<object>()
  function patchReferenceClient() {
    const client = ref.client
    if (!client || typeof client !== 'object' || patchedClients.has(client)) {
      return
    }
    patchedClients.add(client)
    const originalMethods: Partial<Record<ClientMethod, AnyFn>> = {}
    clientOriginals.set(client, originalMethods)
    for (const method of MIRRORED_CLIENT_METHODS) {
      const original = client[method]
      if (typeof original !== 'function') {
        continue
      }
      originalMethods[method] = original
      client[method] = referenceClientWrappers[method] = function mirroredClientCall(
        ...callArgs: unknown[]
      ) {
        const side = inShadowedCall.getStore()
        if (side === 'candidate') {
          // a test override of this method running for the candidate (see
          // patchCandidateClient) called the reference method it saved
          const candidateClient = cand.client
          const candidateOriginal =
            candidateClient && clientOriginals.get(candidateClient)?.[method]
          if (candidateOriginal) {
            return candidateOriginal.apply(candidateClient, callArgs)
          }
        }
        if (side) {
          return original.apply(client, callArgs)
        }
        const statements =
          method === 'batch' || method === 'migrate'
            ? ((callArgs[0] as unknown[]) ?? []).map(sqlOf)
            : [sqlOf(callArgs[0])]
        if (statements.every(isReadOnlySQL)) {
          return original.apply(client, callArgs)
        }
        return exclusive(async () => {
          const pending = atTestBoundary()
          if (pending) {
            await pending
          }
          isDirty = true
          inFlight++
          try {
            return await mirrorInFlight({ callArgs, client, method, original, statements })
          } finally {
            inFlight--
          }
        })
      }
    }
    if (typeof client.transaction === 'function') {
      const original = client.transaction
      client.transaction = function unshadowedTransaction(...callArgs: unknown[]) {
        if (!inShadowedCall.getStore()) {
          markUnshadowed('client.transaction')
        }
        return original.apply(client, callArgs)
      }
    }
  }

  /**
   * Tests inject faults by replacing a method on the reference client
   * (`payload.db.drizzle.$client.execute = ...`, calling the saved original).
   * While the candidate half of a shadowed call runs, its client calls go
   * through that replacement too, and the replacement's call to the saved
   * reference method lands on the candidate's original (see
   * `mirroredClientCall`). Mirrored raw statements bypass it: the reference
   * already ran it once for them.
   */
  function patchCandidateClient() {
    const client = cand.client
    const referenceClient = ref.client
    if (!client || typeof client !== 'object' || patchedClients.has(client)) {
      return
    }
    patchedClients.add(client)
    const originalMethods: Partial<Record<ClientMethod, AnyFn>> = {}
    clientOriginals.set(client, originalMethods)
    for (const method of MIRRORED_CLIENT_METHODS) {
      const original = client[method]
      if (typeof original !== 'function') {
        continue
      }
      originalMethods[method] = original
      client[method] = function candidateClientCall(...callArgs: unknown[]) {
        const override = referenceClient?.[method]
        if (
          typeof override === 'function' &&
          referenceClientWrappers[method] &&
          override !== referenceClientWrappers[method] &&
          inShadowedCall.getStore() === 'candidate' &&
          !isMirroringRaw.getStore()
        ) {
          return override.apply(referenceClient, callArgs)
        }
        return original.apply(client, callArgs)
      }
    }
  }

  async function mirrorInFlight({
    callArgs,
    client,
    method,
    original,
    statements,
  }: {
    callArgs: unknown[]
    client: AnyAdapter
    method: (typeof MIRRORED_CLIENT_METHODS)[number]
    original: AnyFn
    statements: string[]
  }) {
    const waiting = nowWindows.waitForOtherProcesses()
    if (waiting) {
      await waiting
    }
    const pairEnded = nowWindows.pairStarted()
    try {
      return await mirrorPair({ callArgs, client, method, original, statements })
    } finally {
      pairEnded()
    }
  }

  async function mirrorPair({
    callArgs,
    client,
    method,
    original,
    statements,
  }: Parameters<typeof mirrorInFlight>[0]) {
    const refStart = instant()
    const result = await original.apply(client, callArgs)
    const refEnd = instant()
    try {
      const candStart = instant()
      const mirrored = await isMirroringRaw.run(true, () =>
        inShadowedCall.run('candidate', () =>
          mirrorRaw({ args: callArgs, candidate: cand, method }),
        ),
      )
      nowWindows.push({
        candidate: { end: instant(), start: candStart },
        reference: { end: refEnd, start: refStart },
      })
      if (mirrored) {
        state.rawMirrored++
      } else {
        markUnshadowed(`client.${method}`)
      }
    } catch (error) {
      record({
        type: 'divergence',
        differences: [
          {
            candidate: errorShape(error),
            kind: 'type',
            path: '$threw',
            reference: 'ok',
          },
        ],
        method: `raw:client.${method}`,
        seq: ++state.calls,
        sql: statements.join(';\n').slice(0, 2_000),
      })
    }
    return result
  }

  // ---- proxy ----------------------------------------------------------------
  const bound = new Map<PropertyKey, { bound: AnyFn; fn: AnyFn }>()

  proxy = new Proxy(ref, {
    get(target, prop) {
      if (prop === SHADOW_STATE) {
        return state
      }
      const current = Reflect.get(target, prop)
      if (typeof prop === 'string' && wrappers.has(prop)) {
        // A test replaced/spied the method on payload.db: honour it (spies created
        // from payload.db.x wrap our wrapper, so the call still reaches both).
        return current === originals.get(prop) ? wrappers.get(prop) : current
      }
      if (typeof current === 'function' && typeof prop === 'string' && prop !== 'constructor') {
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
    // Configuration writes (payload.db.allowIDOnCreate = true, blocksAsJSON,
    // beforeSchemaInit, migrationDir, payload, ...) are applied to both adapters.
    // Function values (method monkey patches / spies) only replace the reference method.
    set(target, prop, value) {
      if (typeof prop === 'string' && typeof value !== 'function') {
        cand[prop] = value
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
      rawMirrored: state.rawMirrored,
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

  // A wrapper reached from inside a shadowed call means the adapter called
  // itself through payload.db (e.g. drizzle `upsert` -> `this.updateOne` after
  // vi.spyOn(payload.db, 'updateOne') put the spy on the reference instance).
  // The outer pair already runs on both sides, so only forward to the side
  // that is executing instead of starting a second pair.
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
