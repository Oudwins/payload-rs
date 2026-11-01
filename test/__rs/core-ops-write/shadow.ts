/**
 * Dispatch and differential harness for the collection write operations.
 *
 * `vitest.config.ts` redirects every import of the upstream operation modules
 * (`packages/payload/src/collections/operations/{create,update,updateByID,delete,deleteByID,
 * duplicate,restoreVersion,validate}.ts`) to `wrap/*.ts`, which export `dispatch(name, ts, rs)`.
 * `PAYLOAD_OPS` selects what payload runs:
 *
 * - `ts`: the upstream TS operation (reference run of the same config),
 * - `rs`: the Rust operation (`packages/engine-rs/src/ops-write`),
 * - `shadow`: every top-level write operation call (serialized through one queue) runs
 *   1. a TS branch and a Rust branch, each on a fresh clone of the caller's args, each isolated:
 *      the SQLite connection is wrapped in `SAVEPOINT` / `ROLLBACK TO` (the test adapter runs
 *      without transactions, so every statement goes through the client connection) and the
 *      upload directories (plus `req.file.tempFilePath`) are restored from a copy-on-write
 *      snapshot afterwards,
 *   2. then the real TS operation on the caller's args (its outcome is returned to the test),
 *   and compares the two branches' event logs. A log records, in order: every collection hook,
 *   collection access, field hook and field access call, nested operation and `payload.db.*` call
 *   with a snapshot of its args at call time, the sync return or async settlement of each, the
 *   microtask gap since the previous event, the operation outcome (result or error), `req.context`
 *   and the args object afterwards. Snapshots keep key order, own `undefined`, class names and
 *   object identity; values that differ by construction between runs are canonicalized per
 *   branch by first appearance (24+ hex ids, tokens, salts, hashes, UUIDs) or as `recent`
 *   (ISO timestamps and Dates within a day of now).
 *   Nested operations inside a branch run the branch's implementation (AsyncLocalStorage).
 *   A diff is re-checked by a second TS branch: if TS differs from itself the case is counted as
 *   `unstable` instead of a diff. A Rust branch that ran no Rust operation, or a TS branch that
 *   ran one, is a failure (`sameEngine`).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'

import { getDataLoader } from '../../../packages/payload/src/collections/dataloader.js'

type Any = any
type Fn = (...args: Any[]) => Any

type Branch = {
  args: Any
  ids: Map<object, number>
  kind: 'real' | 'rs' | 'ts'
  log: string[]
  next: number
  req: Any
  roles: Map<object, string>
  ticker?: { count: number }
  tokens: Map<string, number>
}

type OpStats = {
  calls: number
  compared: number
  diffs: number
  equal: number
  events: number
  rejections: number
  rsCalls: number
  sameEngine: number
  skipped: number
  unstable: number
}

type DiffRecord = {
  at: number
  op: string
  rs: string[]
  test?: string
  ts: string[]
  ts2?: string[]
}

const mode = process.env.PAYLOAD_OPS ?? 'ts'
const als = new AsyncLocalStorage<Branch>()
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realDateNow = Date.now
const BRANCH_TIMEOUT_MS = Number(process.env.RS_OPS_BRANCH_TIMEOUT_MS ?? 30000)
const MAX_DIFFS_RECORDED = 40
const SAVEPOINT = 'rs_ops_write_shadow'
const FILE_BACKUP_DIR = process.env.RS_OPS_WRITE_FILES ?? `/tmp/rs-ops-write-files-${process.pid}`

// Loaded lazily: the engine module imports payload's create.ts, which this config redirects to
// wrap/create.ts, which imports this module (a static import would be a cycle).
let rustCallsOf: (() => number) | undefined
const getCoreOpsWriteCalls = (): number => rustCallsOf?.() ?? 0
export const loadRustCalls = async (): Promise<void> => {
  if (!rustCallsOf) {
    const loaded = await import('../../../packages/engine-rs/src/ops-write/index.js')
    rustCallsOf = loaded.getCoreOpsWriteCalls
    const mutant = Number(process.env.RS_OPS_WRITE_MUTANT ?? 0)
    if (mutant) {
      const { createOpsWriteHost } =
        await import('../../../packages/engine-rs/src/ops-write/host.js')
      const { mutantHost } = await import('./mutants.js')
      loaded.getCoreOpsWrite().init(mutantHost(mutant, createOpsWriteHost()))
    }
  }
}

const stats: Record<string, OpStats> = {}
const diffs: DiffRecord[] = []
let currentTest: string | undefined
let queue: Promise<unknown> = Promise.resolve()

const statsFor = (op: string): OpStats =>
  (stats[op] ??= {
    calls: 0,
    compared: 0,
    diffs: 0,
    equal: 0,
    events: 0,
    rejections: 0,
    rsCalls: 0,
    sameEngine: 0,
    skipped: 0,
    unstable: 0,
  })

export const getStats = (): {
  diffs: DiffRecord[]
  mode: string
  stats: Record<string, OpStats>
} => ({
  diffs,
  mode,
  stats,
})

export const setCurrentTest = (name: string | undefined): void => {
  currentTest = name
}

/** Writes this file's report (`RS_OPS_OUT/<file>.<pid>.<n>.json`). */
export const flushReport = (testFile: string): void => {
  fs.rmSync(FILE_BACKUP_DIR, { force: true, recursive: true })
  const out = process.env.RS_OPS_OUT
  if (!out) {
    return
  }
  fs.mkdirSync(out, { recursive: true })
  const name = `${path.basename(path.dirname(testFile))}-${path.basename(testFile)}.${process.pid}.${realDateNow()}.json`
  fs.writeFileSync(
    path.join(out, name),
    JSON.stringify(
      { diffs, file: testFile, mode, rustCalls: getCoreOpsWriteCalls(), stats },
      null,
      1,
    ),
  )
}

/**
 * The operation function payload imports. `getTs`/`getRs` are read lazily (import cycles).
 * `ts`/`rs` modes return a plain forwarding function (no extra ticks).
 */
export const dispatch = (name: string, getTs: () => Fn, getRs: () => Fn): Fn => {
  if (mode === 'rs') {
    return (args: Any) => {
      statsFor(name).calls++
      return getRs()(args)
    }
  }
  if (mode !== 'shadow') {
    return (args: Any) => {
      statsFor(name).calls++
      return getTs()(args)
    }
  }
  return (args: Any) => {
    const branch = als.getStore()
    if (branch) {
      if (branch.kind === 'real') {
        return getTs()(args)
      }
      return recordCall(branch, `op:${name}`, undefined, [args], (...a) =>
        (branch.kind === 'ts' ? getTs() : getRs())(...a),
      )
    }
    const run = queue.then(() => shadowTop(name, getTs(), getRs(), args))
    queue = run.catch(() => undefined)
    return run
  }
}

// ------------------------------------------------------------------------------------------
// shadow

const shadowTop = async (name: string, ts: Fn, rs: Fn, args: Any): Promise<Any> => {
  const s = statsFor(name)
  s.calls++
  await loadRustCalls()
  const payload = args?.req?.payload
  if (payload) {
    instrument(payload)
  }

  if (payload && canIsolate(payload, args)) {
    const pristine = cloneArgs(args)
    try {
      const tsLog = await runIsolated(payload, 'ts', ts, cloneArgs(pristine), s)
      const rsLog = await runIsolated(payload, 'rs', rs, cloneArgs(pristine), s)
      s.compared++
      s.events += tsLog.length
      if (tsLog.some((e) => e.includes('"ev":"outcome","ok":false'))) {
        s.rejections++
      }
      if (process.env.RS_OPS_DUMP && s.compared <= Number(process.env.RS_OPS_DUMP)) {
        fs.appendFileSync(
          '/tmp/rs-ops-write-dump.txt',
          `== ${name} ${currentTest}\nTS\n${tsLog.map(clip).join('\n')}\nRS\n${rsLog.map(clip).join('\n')}\n`,
        )
      }
      const at = firstDiff(tsLog, rsLog)
      if (at === -1) {
        s.equal++
      } else {
        const ts2Log = await runIsolated(payload, 'ts', ts, cloneArgs(pristine), s)
        const tsUnstable = firstDiff(tsLog, ts2Log) !== -1
        if (tsUnstable) {
          s.unstable++
        } else {
          s.diffs++
        }
        if (diffs.length < MAX_DIFFS_RECORDED) {
          diffs.push({
            at,
            op: name,
            rs: rsLog.slice(Math.max(0, at - 2), at + 3).map(clip),
            test: currentTest,
            ts: tsLog.slice(Math.max(0, at - 2), at + 3).map(clip),
            ...(tsUnstable ? { ts2: ts2Log.slice(at, at + 2).map(clip) } : {}),
          })
        }
      }
    } catch (error) {
      s.diffs++
      if (diffs.length < MAX_DIFFS_RECORDED) {
        diffs.push({
          at: -1,
          op: name,
          rs: [String((error as Error)?.stack ?? error)],
          test: currentTest,
          ts: [],
        })
      }
    }
  } else {
    s.skipped++
  }

  return als.run(newBranch('real', args), () => ts(args))
}

const clip = (s: string): string => (s.length > 4000 ? `${s.slice(0, 4000)}...(${s.length})` : s)

const firstDiff = (a: string[], b: string[]): number => {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return i
    }
  }
  return -1
}

const newBranch = (kind: Branch['kind'], args: Any): Branch => {
  const roles = new Map<object, string>()
  const req = args?.req
  const branch: Branch = {
    args,
    ids: new Map(),
    kind,
    log: [],
    next: 0,
    req,
    roles,
    tokens: new Map(),
  }
  if (args && typeof args === 'object') {
    roles.set(args, '$args')
  }
  if (req && typeof req === 'object') {
    roles.set(req, '$req')
    for (const key of ['context', 'payloadDataLoader', 'i18n', 'headers', 'query', 'routeParams']) {
      const v = req[key]
      if (v && (typeof v === 'object' || typeof v === 'function') && !roles.has(v)) {
        roles.set(v, `$req.${key}`)
      }
    }
  }
  return branch
}

// ------------------------------------------------------------------------------------------
// isolation

/**
 * A branch can be rolled back when the adapter runs without transactions (every statement on
 * the client connection, which a savepoint then covers) and the caller is not inside a real
 * transaction of its own.
 */
const canIsolate = (payload: Any, args: Any): boolean => {
  const db = payload.db
  if (!db?.client || typeof db.client.execute !== 'function' || db.transactionOptions) {
    return false
  }
  const tid = args?.req?.transactionID
  return !(typeof tid === 'string' || typeof tid === 'number')
}

const uploadDirs = (payload: Any): string[] => {
  const dirs = new Set<string>()
  for (const collection of Object.values<Any>(payload.collections ?? {})) {
    const dir = collection.config?.upload?.staticDir
    if (typeof dir === 'string' && dir) {
      dirs.add(path.resolve(dir))
    }
  }
  return [...dirs]
}

type FileSnapshot = {
  backups: Map<string, { backup: string; mtimeMs: number; size: number }>
  dirs: string[]
}

let backupCounter = 0

const walk = (dir: string, out: string[]): void => {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
}

const snapshotFiles = (payload: Any, args: Any): FileSnapshot => {
  const dirs = uploadDirs(payload)
  const files: string[] = []
  for (const dir of dirs) {
    walk(dir, files)
  }
  const temp = args?.req?.file?.tempFilePath
  if (typeof temp === 'string' && fs.existsSync(temp)) {
    files.push(temp)
  }
  const backups = new Map<string, { backup: string; mtimeMs: number; size: number }>()
  const target = path.join(FILE_BACKUP_DIR, String(backupCounter++))
  fs.mkdirSync(target, { recursive: true })
  files.forEach((file, i) => {
    const stat = fs.statSync(file)
    const backup = path.join(target, String(i))
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_FICLONE)
    backups.set(file, { backup, mtimeMs: stat.mtimeMs, size: stat.size })
  })
  return { backups, dirs }
}

const restoreFiles = (snapshot: FileSnapshot): void => {
  const now: string[] = []
  for (const dir of snapshot.dirs) {
    walk(dir, now)
  }
  for (const file of now) {
    if (!snapshot.backups.has(file)) {
      fs.rmSync(file, { force: true })
    }
  }
  for (const [file, { backup, mtimeMs, size }] of snapshot.backups) {
    let unchanged = false
    try {
      const stat = fs.statSync(file)
      unchanged = stat.size === size && stat.mtimeMs === mtimeMs
    } catch {
      unchanged = false
    }
    if (!unchanged) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.copyFileSync(backup, file, fs.constants.COPYFILE_FICLONE)
      fs.utimesSync(file, new Date(), new Date(mtimeMs))
    }
  }
  const first = snapshot.backups.values().next().value
  if (first) {
    fs.rmSync(path.dirname(first.backup), { force: true, recursive: true })
  }
}

const runIsolated = async (
  payload: Any,
  kind: 'rs' | 'ts',
  impl: Fn,
  args: Any,
  s: OpStats,
): Promise<string[]> => {
  const files = snapshotFiles(payload, args)
  const client = payload.db.client
  await client.execute(`SAVEPOINT ${SAVEPOINT}`)
  const before = getCoreOpsWriteCalls()
  try {
    return await runBranch(kind, impl, args)
  } finally {
    const ran = getCoreOpsWriteCalls() - before
    if (kind === 'rs') {
      s.rsCalls += ran
      if (ran === 0) {
        s.sameEngine++
      }
    } else if (ran !== 0) {
      s.sameEngine++
    }
    await client.execute(`ROLLBACK TO ${SAVEPOINT}`)
    await client.execute(`RELEASE ${SAVEPOINT}`)
    restoreFiles(files)
  }
}

const runBranch = async (kind: 'rs' | 'ts', impl: Fn, args: Any): Promise<string[]> => {
  const branch = newBranch(kind, args)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = realSetTimeout(() => resolve('timeout'), BRANCH_TIMEOUT_MS)
  })
  const run = als.run(branch, () => {
    try {
      return Promise.resolve(impl(args)).then(
        (value) => ({ ok: true, value }),
        (error) => ({ error, ok: false }),
      )
    } catch (error) {
      return Promise.resolve({ error, ok: false, sync: true })
    }
  })
  const outcome: Any = await Promise.race([run, timeout])
  realClearTimeout(timer)
  if (outcome === 'timeout') {
    push(branch, { ev: 'outcome', timeout: true })
    return branch.log
  }
  if (outcome.ok) {
    push(branch, { ev: 'outcome', ok: true, value: snap(branch, outcome.value) })
  } else {
    push(branch, {
      error: snapError(branch, outcome.error),
      ev: 'outcome',
      ok: false,
      sync: !!outcome.sync,
    })
  }
  push(branch, { ev: 'context', value: snap(branch, branch.req?.context) })
  push(branch, { ev: 'req', value: snapReqState(branch, branch.req) })
  push(branch, { ev: 'args', value: snapShallowArgs(branch, args) })
  return branch.log
}

/** The request state an operation may change (beyond `context`), read after the operation. */
const REQ_STATE_KEYS = [
  'locale',
  'fallbackLocale',
  'operation',
  'transactionID',
  'file',
  'payloadUploadSizes',
  'user',
  'payloadAPI',
  'query',
]

const snapReqState = (branch: Branch, req: Any): unknown => {
  if (!req || typeof req !== 'object') {
    return snap(branch, req)
  }
  const out: Record<string, unknown> = {}
  for (const key of REQ_STATE_KEYS) {
    const v = req[key]
    out[key] =
      key === 'transactionID'
        ? v instanceof Promise
          ? { $promise: 1 }
          : typeof v
        : snap(branch, v)
  }
  out.ownKeys = Object.keys(req).filter((k) => !['payloadDataLoader'].includes(k))
  return out
}

/** Microtasks a ticker counts after each event before it stops (then gaps read `far`). */
const TICKER_BUDGET = 1024

/** Logs `event` with `gap`: microtasks run since the previous event of the branch. */
const push = (branch: Branch, event: Record<string, unknown>): void => {
  const ticker = branch.ticker
  event.gap = !ticker ? 'start' : ticker.count < TICKER_BUDGET ? ticker.count : 'far'
  branch.log.push(JSON.stringify(event))
  const next = { count: 0 }
  branch.ticker = next
  const step = () => {
    if (branch.ticker !== next || next.count >= TICKER_BUDGET) {
      return
    }
    next.count++
    void Promise.resolve().then(step)
  }
  void Promise.resolve().then(step)
}

/** Calls `fn` (a wrapped hook / access / db method / nested op), logging the call and outcome. */
const recordCall = (branch: Branch, what: string, self: Any, args: Any[], fn: Fn): Any => {
  const id = branch.log.length
  push(branch, {
    args: args.map((a) => snap(branch, a)),
    ev: 'call',
    this: self === undefined ? undefined : snap(branch, self),
    what,
  })
  let result: Any
  try {
    result = fn.apply(self, args)
  } catch (error) {
    push(branch, { error: snapError(branch, error), ev: 'throw', id })
    throw error
  }
  if (result && typeof result.then === 'function') {
    push(branch, { ev: 'pending', id })
    result.then(
      (value: Any) => push(branch, { ev: 'resolve', id, value: snap(branch, value) }),
      (error: Any) => push(branch, { error: snapError(branch, error), ev: 'reject', id }),
    )
  } else {
    push(branch, { ev: 'return', id, value: snap(branch, result) })
  }
  return result
}

// ------------------------------------------------------------------------------------------
// cloning

const cloneData = (v: Any, seen: Map<object, Any>): Any => {
  if (v === null || typeof v !== 'object') {
    return v
  }
  if (seen.has(v)) {
    return seen.get(v)
  }
  if (v instanceof Date) {
    return new Date(v.getTime())
  }
  if (Array.isArray(v)) {
    const out: Any[] = []
    seen.set(v, out)
    for (let i = 0; i < v.length; i++) {
      if (i in v) {
        out[i] = cloneData(v[i], seen)
      }
    }
    out.length = v.length
    return out
  }
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) {
    return v
  }
  const out = Object.create(proto)
  seen.set(v, out)
  for (const key of Reflect.ownKeys(v)) {
    const desc = Object.getOwnPropertyDescriptor(v, key)!
    if ('value' in desc) {
      desc.value = cloneData(desc.value, seen)
    }
    Object.defineProperty(out, key, desc)
  }
  return out
}

const cloneReq = (req: Any): Any => {
  if (!req || typeof req !== 'object') {
    return req
  }
  const proto = Object.getPrototypeOf(req)
  let out: Any
  if (proto === Object.prototype || proto === null) {
    out = Object.create(proto)
    Object.defineProperties(out, Object.getOwnPropertyDescriptors(req))
  } else {
    // REST requests are web `Request` objects (private fields): a copy-on-write view.
    out = copyOnWrite(req)
  }
  for (const key of ['context', 'query', 'routeParams']) {
    if (key in req) {
      out[key] = cloneData(req[key], new Map())
    }
  }
  if (req.file && typeof req.file === 'object') {
    out.file = { ...req.file }
  }
  // Hooks consume query params (`req.searchParams.delete`).
  if (req.searchParams instanceof URLSearchParams) {
    out.searchParams = new URLSearchParams(req.searchParams)
  }
  if (req.payload) {
    out.payloadDataLoader = getDataLoader(out)
  }
  return out
}

const copyOnWrite = (original: Any): Any => {
  const own: Record<PropertyKey, Any> = Object.create(null)
  const deleted = new Set<PropertyKey>()
  const hasOwnOverride = (key: PropertyKey) => Object.prototype.hasOwnProperty.call(own, key)
  return new Proxy(original, {
    defineProperty: (_target, key, desc) => {
      own[key] = desc.value
      deleted.delete(key)
      return true
    },
    deleteProperty: (_target, key) => {
      delete own[key]
      deleted.add(key)
      return true
    },
    get: (target, key) => {
      if (hasOwnOverride(key)) {
        return own[key]
      }
      if (deleted.has(key)) {
        return undefined
      }
      return Reflect.get(target, key, target)
    },
    getOwnPropertyDescriptor: (target, key) => {
      if (hasOwnOverride(key)) {
        return { configurable: true, enumerable: true, value: own[key], writable: true }
      }
      if (deleted.has(key)) {
        return undefined
      }
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
    has: (target, key) => hasOwnOverride(key) || (!deleted.has(key) && Reflect.has(target, key)),
    ownKeys: (target) => {
      const keys = Reflect.ownKeys(target).filter((k) => !deleted.has(k))
      for (const key of Reflect.ownKeys(own)) {
        if (!keys.includes(key)) {
          keys.push(key)
        }
      }
      return keys
    },
    set: (_target, key, value) => {
      own[key] = value
      deleted.delete(key)
      return true
    },
  })
}

/** A fresh copy of operation args: data values deep, `collection` shared, `req` cloned. */
const cloneArgs = (args: Any): Any => {
  if (!args || typeof args !== 'object') {
    return args
  }
  const out: Any = {}
  const seen = new Map<object, Any>()
  for (const key of Object.keys(args)) {
    const v = args[key]
    if (key === 'collection') {
      out[key] = v
    } else if (key === 'req') {
      out[key] = cloneReq(v)
    } else {
      out[key] = cloneData(v, seen)
    }
  }
  return out
}

// ------------------------------------------------------------------------------------------
// snapshots

const staticRoles = new WeakMap<object, string>()

const HEX_TOKEN = /^[0-9a-f]{24,}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

const EMBEDDED_TOKEN =
  /[0-9a-f]{24,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

const tokenOf = (branch: Branch, v: string): number => {
  let n = branch.tokens.get(v)
  if (n === undefined) {
    n = branch.tokens.size
    branch.tokens.set(v, n)
  }
  return n
}

/**
 * Values that differ between runs by construction: ids/tokens/salts/hashes (24+ hex chars, also
 * inside strings such as `pbkdf2-sha256-v1:<hex>`) and UUIDs become per-branch tokens numbered by
 * first appearance; ISO timestamps within a day of now become `recent`.
 */
const canonicalString = (branch: Branch, v: string): unknown => {
  if (HEX_TOKEN.test(v) || UUID.test(v)) {
    return { $token: tokenOf(branch, v) }
  }
  if (ISO_DATE.test(v)) {
    const t = Date.parse(v)
    if (Math.abs(t - realDateNow()) < 864e5) {
      return { $iso: 'recent' }
    }
  }
  if (v.length >= 24 && EMBEDDED_TOKEN.test(v)) {
    EMBEDDED_TOKEN.lastIndex = 0
    return { $s: v.replace(EMBEDDED_TOKEN, (m) => `<t${tokenOf(branch, m)}>`) }
  }
  EMBEDDED_TOKEN.lastIndex = 0
  return v
}

const snapError = (branch: Branch, error: Any): unknown => {
  if (!(error instanceof Error)) {
    return { thrown: snap(branch, error) }
  }
  const e: Any = error
  return {
    class: e.constructor?.name,
    data: snap(branch, e.data),
    isPublic: e.isPublic,
    message: canonicalMessage(branch, e.message),
    name: e.name,
    status: e.status,
  }
}

const canonicalMessage = (branch: Branch, message: Any): unknown =>
  typeof message === 'string' ? canonicalString(branch, message) : message

const snapShallowArgs = (branch: Branch, args: Any): unknown => {
  if (!args || typeof args !== 'object') {
    return snap(branch, args)
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(args)) {
    out[key] =
      key === 'req' || key === 'collection'
        ? snap(branch, args[key])
        : snap(branch, args[key], 0, new Set(), true)
  }
  return out
}

const snap = (
  branch: Branch,
  v: Any,
  depth = 0,
  stack = new Set<object>(),
  fresh = false,
): unknown => {
  if (v === undefined) {
    return { $u: 1 }
  }
  if (v === null || typeof v === 'boolean') {
    return v
  }
  if (typeof v === 'string') {
    return canonicalString(branch, v)
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) && !Object.is(v, -0)
      ? v
      : { $num: Object.is(v, -0) ? '-0' : String(v) }
  }
  if (typeof v === 'bigint') {
    return { $big: String(v) }
  }
  if (typeof v === 'symbol') {
    return { $sym: String(v) }
  }
  const role = branch.roles.get(v) ?? staticRoles.get(v)
  if (role) {
    return { $role: role }
  }
  if (typeof v === 'function') {
    return { $fn: v.name }
  }
  if (v instanceof Date) {
    const t = v.getTime()
    if (Number.isNaN(t)) {
      return { $date: 'invalid' }
    }
    return Math.abs(t - realDateNow()) < 864e5 ? { $date: 'recent' } : { $date: v.toISOString() }
  }
  if (v instanceof Promise) {
    return { $promise: 1 }
  }
  if (ArrayBuffer.isView(v)) {
    return { $bytes: (v as ArrayBufferView).byteLength }
  }
  let id = branch.ids.get(v)
  if (id === undefined) {
    id = branch.next++
    branch.ids.set(v, id)
  }
  if (stack.has(v) || depth > 24) {
    return { $ref: id }
  }
  stack.add(v)
  try {
    if (Array.isArray(v)) {
      const items: unknown[] = []
      for (let i = 0; i < v.length; i++) {
        items.push(i in v ? snap(branch, v[i], depth + 1, stack) : { $hole: 1 })
      }
      return { $a: items, $id: fresh ? undefined : id }
    }
    const out: Record<string, unknown> = { $id: fresh ? undefined : id }
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) {
      out.$class = proto?.constructor?.name ?? '?'
    }
    if (v instanceof Error) {
      out.$error = v.name
      out.$message = canonicalMessage(branch, v.message)
    }
    if (v instanceof Map) {
      out.$entries = [...v.entries()].map(([k, x]) => [
        snap(branch, k, depth + 1, stack),
        snap(branch, x, depth + 1, stack),
      ])
    } else if (v instanceof Set) {
      out.$values = [...v.values()].map((x) => snap(branch, x, depth + 1, stack))
    }
    for (const key of Object.keys(v)) {
      let x: Any
      try {
        x = v[key]
      } catch (error) {
        x = { $getterThrew: String(error) }
      }
      out[key] = snap(branch, x, depth + 1, stack)
    }
    return out
  } finally {
    stack.delete(v)
  }
}

// ------------------------------------------------------------------------------------------
// instrumentation

const instrumented = new WeakSet<object>()
const wrappedFns = new WeakSet<Fn>()

const wrap = (what: string, fn: Fn): Fn => {
  if (typeof fn !== 'function' || wrappedFns.has(fn)) {
    return fn
  }
  const wrapped = function (this: Any, ...args: Any[]) {
    const branch = als.getStore()
    if (!branch || branch.kind === 'real') {
      return fn.apply(this, args)
    }
    return recordCall(branch, what, this, args, fn)
  }
  for (const key of Reflect.ownKeys(fn)) {
    if (key !== 'length' && key !== 'name' && key !== 'prototype') {
      try {
        Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(fn, key)!)
      } catch {
        // non-configurable
      }
    }
  }
  wrappedFns.add(wrapped)
  return wrapped
}

const wrapHookArray = (what: string, hooks: Any): void => {
  if (!Array.isArray(hooks)) {
    return
  }
  for (let i = 0; i < hooks.length; i++) {
    hooks[i] = wrap(`${what}[${i}]`, hooks[i])
  }
}

const FIELD_HOOKS = [
  'beforeValidate',
  'beforeChange',
  'afterChange',
  'afterRead',
  'beforeDuplicate',
]
const FIELD_ACCESS = ['create', 'read', 'update']

const walkFields = (prefix: string, fields: Any, seen: WeakSet<object>): void => {
  if (!Array.isArray(fields) || seen.has(fields)) {
    return
  }
  seen.add(fields)
  fields.forEach((field: Any, index: number) => {
    if (!field || typeof field !== 'object') {
      return
    }
    const name = `${prefix}.${field.name ?? `_${index}`}`
    if (!staticRoles.has(field)) {
      staticRoles.set(field, `field:${name}`)
    }
    for (const hook of FIELD_HOOKS) {
      if (field.hooks?.[hook]) {
        wrapHookArray(`field:${name}.${hook}`, field.hooks[hook])
      }
    }
    if (field.access) {
      for (const key of FIELD_ACCESS) {
        if (typeof field.access[key] === 'function') {
          field.access[key] = wrap(`field:${name}.access.${key}`, field.access[key])
        }
      }
    }
    if (typeof field.validate === 'function') {
      field.validate = wrap(`field:${name}.validate`, field.validate)
    }
    walkFields(name, field.fields, seen)
    walkFields(name, field.flattenedFields, seen)
    if (Array.isArray(field.tabs)) {
      field.tabs.forEach((tab: Any, i: number) => {
        if (tab && typeof tab === 'object' && !staticRoles.has(tab)) {
          staticRoles.set(tab, `tab:${name}.${tab.name ?? i}`)
        }
        walkFields(`${name}.${tab?.name ?? i}`, tab?.fields, seen)
        walkFields(`${name}.${tab?.name ?? i}`, tab?.flattenedFields, seen)
      })
    }
    if (Array.isArray(field.blocks)) {
      for (const block of field.blocks) {
        if (block && typeof block === 'object') {
          if (!staticRoles.has(block)) {
            staticRoles.set(block, `block:${block.slug}`)
          }
          walkFields(`${name}.${block.slug}`, block.fields, seen)
          walkFields(`${name}.${block.slug}`, block.flattenedFields, seen)
        }
      }
    }
  })
  staticRoles.set(fields, `fields:${prefix}`)
}

const COLLECTION_HOOKS = [
  'beforeOperation',
  'beforeValidate',
  'beforeChange',
  'afterChange',
  'beforeRead',
  'afterRead',
  'beforeDelete',
  'afterDelete',
  'afterOperation',
]
const COLLECTION_ACCESS = ['create', 'read', 'readVersions', 'update', 'delete', 'validate']

const DB_METHODS = [
  'count',
  'countVersions',
  'create',
  'createVersion',
  'deleteMany',
  'deleteOne',
  'deleteVersions',
  'find',
  'findDistinct',
  'findOne',
  'findVersions',
  'queryDrafts',
  'updateMany',
  'updateOne',
  'updateVersion',
  'upsert',
  'beginTransaction',
  'commitTransaction',
  'rollbackTransaction',
]

const instrument = (payload: Any): void => {
  if (instrumented.has(payload)) {
    return
  }
  instrumented.add(payload)
  staticRoles.set(payload, '$payload')
  staticRoles.set(payload.config, '$config')
  staticRoles.set(payload.db, '$db')
  if (payload.logger) {
    staticRoles.set(payload.logger, '$logger')
  }
  if (payload.email) {
    staticRoles.set(payload.email, '$email')
  }
  const seen = new WeakSet<object>()
  for (const [slug, collection] of Object.entries<Any>(payload.collections ?? {})) {
    staticRoles.set(collection, `collection:${slug}`)
    const config = collection.config
    staticRoles.set(config, `config:${slug}`)
    for (const hook of COLLECTION_HOOKS) {
      wrapHookArray(`${slug}.hooks.${hook}`, config.hooks?.[hook])
    }
    for (const key of COLLECTION_ACCESS) {
      if (config.access && typeof config.access[key] === 'function') {
        config.access[key] = wrap(`${slug}.access.${key}`, config.access[key])
      }
    }
    walkFields(slug, config.fields, seen)
    walkFields(slug, config.flattenedFields, seen)
  }
  for (const global of payload.config.globals ?? []) {
    staticRoles.set(global, `global:${global.slug}`)
  }
  for (const block of payload.config.blocks ?? []) {
    if (block && typeof block === 'object') {
      staticRoles.set(block, `block:${block.slug}`)
      walkFields(`block:${block.slug}`, block.fields, seen)
      walkFields(`block:${block.slug}`, block.flattenedFields, seen)
    }
  }
  for (const method of DB_METHODS) {
    if (typeof payload.db[method] === 'function') {
      payload.db[method] = wrap(`db.${method}`, payload.db[method])
    }
  }
}
