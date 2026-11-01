import { renameSync, writeFileSync } from 'node:fs'

/**
 * `withRustEngine(adapterObj)` (ENGINE_CONTRACT.md): the sqlite adapter with its raw schema and
 * every data method served by the Rust `SqliteEngine`. Everything else (drizzle tables, push,
 * migrations, transactions, `execute`, `payload.db.drizzle`) stays the upstream TS code, running
 * over the Rust-backed libsql client so drizzle and the engine share connections and ordering.
 */
import type { NativeSqliteEngine } from '../native.js'
import type { FunctionRegistry } from '../serialize.js'
import type { DrizzleQueryErrorClass } from './errors.js'
import type { LoopbackEngine } from './loopback.js'

import { getNativeEngine } from '../native.js'
import { createEngineError } from '../schema.js'
import { createFunctionRegistry, deserializeFromEngine, serializeForEngine } from '../serialize.js'
import { getSqliteConnId, Sqlite3Client, Sqlite3Transaction } from '../sqlite/client.js'
import { rebuildError } from './errors.js'
import { createLoopbackEngine } from './loopback.js'
import {
  buildEngineInput,
  decodeRawSchema,
  describeLiveSchema,
  initWithEngineSchema,
} from './schema.js'

type AnyObject = Record<PropertyKey, any>

/** Adapter methods served by `SqliteEngine.call` (method name = adapter property). */
export const engineMethods = [
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

type UpstreamMethod = (this: unknown, args: unknown) => Promise<unknown>

type EngineState = {
  attachedClientId?: number
  engine: LoopbackEngine | NativeSqliteEngine
  /**
   * Errors thrown by JS functions the engine called during `call`, per registry function id in
   * throw order; the engine fails the call with `HostError` `JS function <id> threw`, and the
   * caller gets the function's own error (first one of that id). Cleared whenever no engine call
   * is in flight (`inFlight`), so an error no call claimed cannot reach a later call.
   */
  hostErrors: [id: number, error: unknown][]
  /** Engine calls started and not finished yet (`callEngine`). */
  inFlight: number
  /**
   * The drizzle instance whose schema `setLiveSchema` was given (`connect` after a re-init builds
   * a new one).
   */
  liveSchemaDrizzle?: unknown
  /** A drizzle instance whose live schema the engine cannot take (`setLiveSchema` failed for it). */
  liveSchemaFailure?: { drizzle: unknown; reason: string }
  registry: FunctionRegistry
}

/** Per adapter object, fixed by `withRustEngine`'s `init` (survives re-init). */
type Glue = {
  DrizzleQueryErrorClass?: DrizzleQueryErrorClass
  /** `internalAdapterProperties` values right after the upstream adapter was built. */
  internals: Record<string, unknown>
  operatorEntries: [string, unknown][]
  /** The upstream TS data methods (run instead of the engine, see `findUpstreamReason`). */
  upstream: Record<string, UpstreamMethod>
  /** The engine-backed methods installed on the adapter. */
  wrappers: Record<string, unknown>
}

type AdapterObj = { init: (args: { payload: any }) => AnyObject }

/** Options of `withRustEngine`. */
export type WithRustEngineOptions = {
  /**
   * drizzle-orm's `DrizzleQueryError` from the drizzle-orm copy the adapter's drizzle session runs
   * on (`@payloadcms/db-sqlite` passes its own), so engine query errors are instances of the class
   * upstream throws. Without it a shape-identical copy is thrown.
   */
  DrizzleQueryError?: DrizzleQueryErrorClass
}

const states = new WeakMap<object, EngineState>()
const glues = new WeakMap<object, Glue>()

/**
 * Adapter properties the upstream data methods use through `this` / `adapter` at call time
 * (`count` → `countDistinct`, `deleteOne` / `upsertRow` → `deleteWhere`, `upsertRow` → `insert`,
 * `createVersion` → `execute`, where building → `operators`, `createJSONQuery`,
 * `convertPathToJSONTraversal`). The engine has its own implementation of them, so a replacement
 * (`vi.spyOn(payload.db, 'countDistinct')`, `payload.db.deleteWhere = ...`) only has upstream's
 * effect when the call runs the upstream method: `callEngine` then does exactly that.
 */
const internalAdapterProperties = [
  'convertPathToJSONTraversal',
  'countDistinct',
  'createJSONQuery',
  'deleteWhere',
  'execute',
  'insert',
  'operators',
] as const

const transparentClientMethods = new WeakMap<object, () => boolean>()

/**
 * Declares `wrapper` (installed as `execute` on a Rust sqlite client or transaction) as forwarding
 * every call unchanged to the original method while `isTransparent()` returns true, so engine
 * calls keep running in Rust. Any other replacement of `execute` makes the adapter run the
 * upstream TS data methods, whose statements go through it (ENGINE_STATUS.md #1).
 */
export const registerTransparentClientMethod = (
  wrapper: (...args: never[]) => unknown,
  isTransparent: () => boolean = () => true,
) => {
  transparentClientMethods.set(wrapper, isTransparent)
}

/** Whether `adapter` was created through `withRustEngine` (db-sqlite `connect` picks the client). */
export const isRustEngineAdapter = (adapter: unknown): boolean =>
  typeof adapter === 'object' && adapter !== null && rustAdapters.has(adapter)

const rustAdapters = new WeakSet<object>()

const isLoopback = () => process.env.PAYLOAD_RS_ENGINE_LOOPBACK === 'true'

const stats: {
  calls: Record<string, number>
  engines: Record<'loopback' | 'native', number>
  /** Calls that ran the upstream TS method instead of the engine, per method and per reason. */
  upstream: Record<string, number>
  upstreamReasons: Record<string, number>
} = {
  calls: {},
  engines: { loopback: 0, native: 0 },
  upstream: {},
  upstreamReasons: {},
}

/**
 * Engines created and `SqliteEngine.call`s made in this process, per method. With
 * `PAYLOAD_RS_ENGINE_STATS_FILE` set, also written to that file (JSON, throttled), so
 * a run can prove the engine really served the data methods.
 */
export const getRustEngineStats = () => stats

let lastStatsWrite = 0

// Written synchronously (throttled, plus once more at exit): timers could be faked by the suite.
const recordStats = (update: () => void) => {
  update()
  const file = process.env.PAYLOAD_RS_ENGINE_STATS_FILE
  if (!file) {
    return
  }
  if (lastStatsWrite === 0) {
    process.once('exit', () => writeStatsFile(file))
  }
  const now = performance.now()
  if (now - lastStatsWrite > 250) {
    lastStatsWrite = now
    writeStatsFile(file)
  }
}

/** Atomic (rename), so a reader or a child process sharing the file never sees partial JSON. */
const writeStatsFile = (file: string) => {
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(stats))
  renameSync(temporary, file)
}

/**
 * Wraps the object returned by `@payloadcms/db-sqlite`'s `sqliteAdapter(args)`. Its `init` builds
 * the upstream adapter and swaps `init` (raw schema) and the data methods for the Rust engine.
 */
export const withRustEngine = <TAdapterObj extends AdapterObj>(
  adapterObj: TAdapterObj,
  options: WithRustEngineOptions = {},
): TAdapterObj => ({
  ...adapterObj,
  init: (args: { payload: any }) => {
    const adapter = adapterObj.init(args)
    if (rustAdapters.has(adapter)) {
      return adapter
    }
    rustAdapters.add(adapter)

    const internals: Record<string, unknown> = {}
    for (const key of internalAdapterProperties) {
      internals[key] = adapter[key]
    }
    const upstream: Record<string, UpstreamMethod> = {}
    const wrappers: Record<string, unknown> = {}
    for (const method of engineMethods) {
      upstream[method] = adapter[method]
      adapter[method] = wrappers[method] = function (this: AnyObject, methodArgs: AnyObject) {
        return callEngine({ adapter: this, args: methodArgs, method })
      }
    }
    glues.set(adapter, {
      DrizzleQueryErrorClass: options.DrizzleQueryError,
      internals,
      operatorEntries: Object.entries(adapter.operators ?? {}),
      upstream,
      wrappers,
    })

    adapter.init = async function (this: AnyObject) {
      await initWithEngineSchema({
        adapter: this,
        buildSchema: () => {
          const { root, ...state } = createEngineState({ adapter: this, upstream })
          states.set(this, state)
          return decodeRawSchema({ json: state.engine.rawSchema(), registry: state.registry, root })
        },
      })
    }

    return adapter
  },
})

const createEngineState = ({
  adapter,
  upstream,
}: {
  adapter: AnyObject
  upstream: Record<string, (this: unknown, args: unknown) => Promise<unknown>>
}): { root: AnyObject } & EngineState => {
  const registry = createFunctionRegistry()
  // errors of the synchronous `create`: all belong to it
  const createErrors: unknown[] = []
  const hostErrors: EngineState['hostErrors'] = []
  let isCreated = false
  const { graphJson, optionsJson, root } = buildEngineInput({ adapter: adapter as never, registry })

  // ENGINE_CONTRACT.md: a callback that throws answers `{"$hostError":true}`; the engine then
  // fails the operation and TS rethrows the callback's own error. After `create`, the engine only
  // calls JS from a statement of `call` (custom column `fromDriver`).
  const callFunction = (id: number, argJSON: string): string => {
    try {
      const fn = registry.functions[id]!
      return serializeForEngine(fn(JSON.parse(argJSON)), registry)
    } catch (error) {
      if (isCreated) {
        hostErrors.push([id, error])
      } else {
        createErrors.push(error)
      }
      return '{"$hostError":true}'
    }
  }

  let engine: EngineState['engine']
  try {
    recordStats(() => stats.engines[isLoopback() ? 'loopback' : 'native']++)
    if (isLoopback()) {
      engine = createLoopbackEngine({
        adapter,
        callFunction,
        graphJson,
        methods: upstream,
        optionsJson,
        registry,
      })
    } else {
      const SqliteEngine = getNativeEngine().SqliteEngine
      if (!SqliteEngine) {
        throw new Error(
          'The payload-engine addon has no SqliteEngine (rebuild crates/payload-node, or set PAYLOAD_RS_ENGINE_LOOPBACK=true to run the TS loopback engine)',
        )
      }
      engine = SqliteEngine.create(graphJson, optionsJson, callFunction)
    }
  } catch (error) {
    throw toInitError({ error, hostErrors: createErrors })
  }
  isCreated = true

  return { engine, hostErrors, inFlight: 0, registry, root }
}

const toInitError = ({ error, hostErrors }: { error: unknown; hostErrors: unknown[] }): unknown => {
  if (hostErrors.length) {
    return hostErrors.shift()
  }
  const parsed = parseEngineError(error)
  return parsed ? createEngineError(parsed as never) : error
}

const parseEngineError = (error: unknown): ({ name: string } & AnyObject) | undefined => {
  if (!(error instanceof Error)) {
    return undefined
  }
  try {
    const parsed = JSON.parse(error.message)
    return typeof parsed === 'object' && parsed !== null && typeof parsed.name === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

const callEngine = async ({
  adapter,
  args,
  method,
}: {
  adapter: AnyObject
  args: AnyObject
  method: string
}): Promise<unknown> => {
  const state = states.get(adapter) ?? states.get(Object.getPrototypeOf(adapter))
  const glue = glues.get(adapter) ?? glues.get(Object.getPrototypeOf(adapter))
  if (!state || !glue) {
    throw new Error(`payload.db.${method}: the Rust engine is not initialized (call init first)`)
  }
  const adapterReason = findUpstreamReason({ adapter, glue, method })
  if (adapterReason) {
    return callUpstream({ adapter, args, glue, method, reason: adapterReason })
  }
  const req = args?.req
  const transactionID = req?.transactionID
  if (transactionID && !isThenable(transactionID)) {
    // the session is known without awaiting: decide before upstream's synchronous mutations
    const txReason = findConnectionReason(adapter.sessions[transactionID]?.db || adapter.drizzle)
    if (txReason) {
      return callUpstream({ adapter, args, glue, method, reason: txReason })
    }
  }
  // before upstream's synchronous mutations, so a call that cannot use the engine runs the upstream
  // method on unmutated arguments
  const liveSchemaReason = sendLiveSchema({ adapter, state })
  if (liveSchemaReason) {
    return callUpstream({ adapter, args, glue, method, reason: liveSchemaReason })
  }
  mutateArgsBeforeTransaction({ adapter, args, method })
  const db = await getTransactionDB({ adapter, req })
  // a pending `transactionID` (or a session that changed meanwhile), or a `connect` that built a
  // new drizzle instance meanwhile: the upstream method repeats the mutations above, idempotent
  // except `createGlobal`'s `data.createdAt` stamp
  const lateReason =
    (transactionID ? findConnectionReason(db) : undefined) ?? sendLiveSchema({ adapter, state })
  if (lateReason) {
    return callUpstream({ adapter, args, glue, method, reason: lateReason })
  }
  mutateDataAfterTransaction({ adapter, args, method })
  const connId = getSqliteConnId(db.session.tx ?? db.session.client)

  const clientId = getSqliteConnId(db.session.client)
  if (state.attachedClientId !== clientId) {
    state.engine.attachClient(clientId)
    state.attachedClientId = clientId
  }
  if ('registerConnection' in state.engine) {
    state.engine.registerConnection(connId, db)
  }

  // upstream `deleteOne` marks a write whenever a document matched, also with `returning: false`
  // (which only skips `transform`): ask for the document to know, return upstream's `null`
  const isDeleteWithoutResult = method === 'deleteOne' && args?.returning === false
  const argsJson = serializeForEngine(
    reduceArgs(isDeleteWithoutResult ? { ...args, returning: true } : args),
    state.registry,
  )
  recordStats(() => (stats.calls[method] = (stats.calls[method] ?? 0) + 1))
  let resultJson: string
  state.inFlight++
  try {
    resultJson = await state.engine.call(method, argsJson, connId, callContextJson(adapter))
  } catch (error) {
    const parsed = parseEngineError(error)
    if (!parsed) {
      throw error
    }
    if (isMarkedWriteError({ args, error: parsed, method })) {
      markWrite(adapter)
    }
    const hostError = takeHostError({ error: parsed, state })
    if (hostError.isFound) {
      throw hostError.error
    }
    throw rebuildError({
      decode: (value) => deserializeFromEngine(value, state.registry),
      DrizzleQueryErrorClass: glue.DrizzleQueryErrorClass,
      error: parsed as never,
      req,
    })
  } finally {
    if (--state.inFlight === 0) {
      state.hostErrors.length = 0
    }
  }
  const { mutations, result: resultTree } = JSON.parse(resultJson) as {
    mutations: [string[], unknown][]
    result: unknown
  }
  for (const [path, value] of mutations) {
    resolvePath(args, path.slice(0, -1))[path.at(-1)!] = deserializeFromEngine(
      value,
      state.registry,
    )
  }
  if (isDeleteWithoutResult) {
    // whether a document was deleted is all that is needed: no decoding (the tree of `null` is
    // `null`)
    if (resultTree !== null) {
      markWrite(adapter)
    }
    return null
  }
  const result = deserializeFromEngine(resultTree, state.registry)
  if (isMarkedWrite({ args, method, result })) {
    markWrite(adapter)
  }
  return result
}

/** `setLiveSchema`'s message while calls hold the engine (crates/payload-node/src/engine.rs). */
const callsInProgress = /engine calls are in progress/

/**
 * Gives the engine the live schema of `adapter.drizzle` when it has not seen that drizzle instance
 * yet (first call, `connect` after a re-init or hot reload). Never fails the caller's operation:
 * returns why the call must run the upstream TS method instead when the engine cannot take it.
 * - `setLiveSchema` while other engine calls hold the engine (an engine that needs exclusive
 *   access for it): this call runs upstream, a later call sends the schema again.
 * - a schema that cannot be described or that the engine rejects: every call on that drizzle
 *   instance runs upstream.
 * Calls already running keep the schema they started with.
 */
const sendLiveSchema = ({ adapter, state }: { adapter: AnyObject; state: EngineState }) => {
  const drizzle = adapter.drizzle
  if (state.liveSchemaDrizzle === drizzle) {
    return undefined
  }
  const failure = state.liveSchemaFailure
  if (failure && failure.drizzle === drizzle) {
    return failure.reason
  }
  let description: string
  try {
    description = describeLiveSchema({
      db: drizzle,
      rawTables: adapter.rawTables,
      registry: state.registry,
    })
  } catch {
    const reason = 'live schema: not describable'
    state.liveSchemaFailure = { drizzle, reason }
    return reason
  }
  try {
    state.engine.setLiveSchema(description)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (callsInProgress.test(message)) {
      return 'live schema: engine calls in progress'
    }
    const reason = 'live schema: rejected by the engine'
    state.liveSchemaFailure = { drizzle, reason }
    return reason
  }
  state.liveSchemaDrizzle = drizzle
  state.liveSchemaFailure = undefined
  return undefined
}

const isThenable = (value: unknown) =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function'

const resolvePath = (root: unknown, path: string[]): any =>
  path.reduce<any>((value, key) => value[key], root)

/** The error a JS function threw when the engine reports `JS function <id> threw`. */
const takeHostError = ({
  error,
  state,
}: {
  error: { name: string } & AnyObject
  state: EngineState
}): { error?: unknown; isFound: boolean } => {
  const id =
    error.name === 'HostError' ? /^JS function (\d+) threw$/.exec(error.message)?.[1] : undefined
  const index = id === undefined ? -1 : state.hostErrors.findIndex(([fnId]) => fnId === Number(id))
  if (index === -1) {
    return { isFound: false }
  }
  const [found] = state.hostErrors.splice(index, 1)
  return { error: found?.[1], isFound: true }
}

/** Runs the upstream TS method (statements through drizzle and the JS client, like upstream). */
const callUpstream = ({
  adapter,
  args,
  glue,
  method,
  reason,
}: {
  adapter: AnyObject
  args: AnyObject
  glue: Glue
  method: string
  reason: string
}) => {
  recordStats(() => {
    stats.upstream[method] = (stats.upstream[method] ?? 0) + 1
    stats.upstreamReasons[reason] = (stats.upstreamReasons[reason] ?? 0) + 1
  })
  return glue.upstream[method]!.call(adapter, args)
}

/**
 * Why a call must run the upstream TS method instead of the engine: something upstream reaches
 * at call time through JS (and the engine cannot) was replaced.
 */
const findUpstreamReason = ({
  adapter,
  glue,
  method,
}: {
  adapter: AnyObject
  glue: Glue
  method: string
}): string | undefined => {
  for (const key of internalAdapterProperties) {
    if (adapter[key] !== glue.internals[key]) {
      return `adapter.${key}`
    }
  }
  const operators = adapter.operators ?? {}
  if (
    Object.keys(operators).length !== glue.operatorEntries.length ||
    glue.operatorEntries.some(([key, value]) => operators[key] !== value)
  ) {
    return 'adapter.operators'
  }
  // read at call time by `buildOperatorConstraint`; the engine has none (sqlite's default `[]`)
  const { operatorHandlers } = adapter
  if (
    operatorHandlers !== undefined &&
    operatorHandlers !== null &&
    !(Array.isArray(operatorHandlers) && operatorHandlers.length === 0)
  ) {
    return 'adapter.operatorHandlers'
  }
  // upstream `upsert` is `this.updateOne(...)`
  if (method === 'upsert' && adapter.updateOne !== glue.wrappers.updateOne) {
    return 'adapter.updateOne'
  }
  return findConnectionReason(adapter.drizzle)
}

/**
 * The drizzle instance's statements must go through JS when its session logs queries (drizzle
 * `logger`), when it is not on a Rust sqlite client / transaction, or when that client's
 * `execute` was replaced (`payload.db.drizzle.$client.execute = ...`).
 */
const findConnectionReason = (db: AnyObject | undefined): string | undefined => {
  const session = db?.session
  if (!session) {
    return 'adapter.drizzle'
  }
  if (!isNoopLogger(session.logger)) {
    return 'drizzle logger'
  }
  const target = session.tx ?? session.client
  if (!hasSqliteConnId(target)) {
    return 'drizzle client'
  }
  return isReplacedClientMethod(target.execute, session.tx ? transactionExecute : clientExecute)
    ? 'client.execute'
    : undefined
}

// identity comparison only
// oxlint-disable-next-line typescript/unbound-method
const clientExecute: unknown = Sqlite3Client.prototype.execute
// oxlint-disable-next-line typescript/unbound-method
const transactionExecute: unknown = Sqlite3Transaction.prototype.execute

const drizzleEntityKind = Symbol.for('drizzle:entityKind')

/** drizzle's `is(logger, NoopLogger)` without importing a drizzle-orm copy. */
const isNoopLogger = (logger: unknown) =>
  typeof logger === 'object' &&
  logger !== null &&
  (logger.constructor as unknown as Record<symbol, unknown>)?.[drizzleEntityKind] === 'NoopLogger'

const hasSqliteConnId = (target: unknown) => {
  try {
    getSqliteConnId(target as never)
    return true
  } catch {
    return false
  }
}

const isReplacedClientMethod = (method: unknown, original: unknown) => {
  if (method === original) {
    return false
  }
  if (typeof method !== 'function') {
    return true
  }
  const isTransparent = transparentClientMethods.get(method)
  return isTransparent ? !isTransparent() : true
}

/** Upstream `markWrite` (`lastWriteTimestamp`, read-replica routing). */
const markWrite = (adapter: AnyObject) => {
  adapter.lastWriteTimestamp = Date.now()
}

/**
 * Methods whose first statement is `upsertRow`'s, after its `markWrite` (so is `updateOne` with an
 * `id`): every statement error is marked.
 */
const upsertRowFirst = new Set<string>([
  'create',
  'createGlobal',
  'createGlobalVersion',
  'createVersion',
  'updateGlobalVersion',
  'updateVersion',
])

/** Methods that read before `upsertRow`: its errors (unique violations, writes) are marked. */
const upsertRowLater = new Set<string>([
  'updateGlobal',
  'updateJobs',
  'updateMany',
  'updateOne',
  'upsert',
])

const writeStatement = /^\s*(?:insert|update|delete)\b/i

/**
 * Whether upstream had called `markWrite` when the call failed with `error`: unique violations and
 * failed writes come from `upsertRow` (marked at its start) or the atomic `updateOne` (marked before
 * its statement); deletes are marked after the statement. A failed select inside `upsertRow`
 * (read-back) of a method that also selects before it is not distinguishable: not marked.
 */
const isMarkedWriteError = ({
  args,
  error,
  method,
}: {
  args: AnyObject
  error: { name: string } & AnyObject
  method: string
}) => {
  const isStatementError = error.name === 'DrizzleQueryError' || error.name === 'LibsqlError'
  if (upsertRowFirst.has(method) || ((method === 'updateOne' || method === 'upsert') && args?.id)) {
    // a JS function (custom column `fromDriver`) runs while `upsertRow` reads back
    return isStatementError || error.name === 'ValidationError' || error.name === 'HostError'
  }
  if (!upsertRowLater.has(method)) {
    return false
  }
  if (error.name === 'ValidationError') {
    return true
  }
  if (error.name !== 'DrizzleQueryError') {
    return false
  }
  if (method === 'updateOne' && args?.options?.atomic === true) {
    return true
  }
  const query = typeof error.query === 'string' ? error.query : ''
  if (!writeStatement.test(query)) {
    return false
  }
  // `updateJobs`' initial claim (no id) marks only after its update returned claimed rows
  return !(
    method === 'updateJobs' &&
    !args?.id &&
    /^\s*update\b/i.test(query) &&
    isInitialJobClaim(args?.data)
  )
}

/** Upstream `updateJobs`' `isInitialJobClaim` (on the data after `delete data.log`). */
const isInitialJobClaim = (data: AnyObject | undefined) =>
  typeof data === 'object' &&
  data !== null &&
  typeof data.processingToken === 'string' &&
  typeof data.processingUntil === 'string' &&
  Object.keys(data).every(
    (field) => field === 'processingToken' || field === 'processingUntil' || field === 'updatedAt',
  )

/** Methods that always reach upstream's `markWrite` when they succeed. */
const alwaysMarkWrite = new Set<string>([
  'create',
  'createGlobal',
  'createGlobalVersion',
  'createVersion',
  'deleteMany',
  'updateGlobal',
  'updateGlobalVersion',
  'updateVersion',
  'upsert',
])

/**
 * Whether upstream called `markWrite` in a call that returned `result`. Upstream marks when a row
 * is written (`upsertRow`, the atomic `updateOne`, a non-empty `updateJobs` claim) or deleted
 * (`deleteOne` with a match, `deleteVersions` with matches, `deleteMany` always). `deleteOne` is
 * always called with a result (see `callEngine`); with `returning: false`, `updateMany`,
 * `updateJobs` and `updateOne` without an id give no evidence in the result: not marked.
 */
const isMarkedWrite = ({
  args,
  method,
  result,
}: {
  args: AnyObject
  method: string
  result: unknown
}) => {
  if (alwaysMarkWrite.has(method)) {
    return true
  }
  switch (method) {
    case 'deleteOne':
      return result !== null && result !== undefined
    case 'deleteVersions':
    case 'updateJobs':
    case 'updateMany':
      return Array.isArray(result) && result.length > 0
    case 'updateOne':
      return (
        Boolean(args?.id) ||
        args?.options?.upsert === true ||
        args?.options?.atomic === true ||
        (result !== null && result !== undefined)
      )
    default:
      return false
  }
}

/**
 * Mutations upstream makes to the caller's arguments, which the caller can observe; done here on
 * the caller's objects (at the same point relative to `getTransaction`), so the engine receives
 * the mutated arguments and must not repeat them:
 * - `createGlobal`: `data.createdAt = new Date().toISOString()` (before `getTransaction`)
 * - `createVersion`: `select.updatedAt = true` when the collection has drafts and `select` is an
 *   object (`null` throws upstream's TypeError) (before `getTransaction`)
 * - `updateJobs`: `delete data.log` unless it is a non-empty array or a `$push` (first statement)
 * - `create`: `upsertRow` sets `data.createdAt` when it is falsy (after `getTransaction`)
 * The engine reports the ones that depend on the database (`withMutations`, applied in
 * `callEngine`): `updateGlobal` without a global row sets `data.createdAt` when it is falsy.
 */
const mutateArgsBeforeTransaction = ({
  adapter,
  args,
  method,
}: {
  adapter: AnyObject
  args: AnyObject
  method: string
}) => {
  if (method === 'updateJobs') {
    const { data } = args
    if (
      !(data?.log as object[])?.length &&
      !(data.log && typeof data.log === 'object' && '$push' in data.log)
    ) {
      delete data.log
    }
  } else if (method === 'createGlobal') {
    const globalConfig = adapter.payload.globals.config.find(
      (config: { slug: string }) => config.slug === args.slug,
    )
    // upstream reads `globalConfig.slug` (TypeError for an unknown slug) before the stamp
    void globalConfig.slug
    args.data.createdAt = new Date().toISOString()
  } else if (method === 'createVersion') {
    // upstream: `this.payload.collections[collectionSlug].config` (TypeError for an unknown slug)
    const collection = adapter.payload.collections[args.collectionSlug].config
    if (collection.versions.drafts) {
      if (typeof args.select === 'object') {
        args.select.updatedAt = true
      }
    }
  }
}

const mutateDataAfterTransaction = ({
  adapter,
  args,
  method,
}: {
  adapter: AnyObject
  args: AnyObject
  method: string
}) => {
  if (method === 'create' && adapter.payload.collections[args.collection] && !args.data.createdAt) {
    args.data.createdAt = new Date().toISOString()
  }
}

/**
 * Per-call context (4th `call` argument): the JS clock for upstream's `new Date()` stamps (so faked
 * clocks apply) and the adapter properties the drizzle code reads at call time, which users and
 * tests change after init (`payload.db.allowIDOnCreate = true`).
 */
const callContextJson = (adapter: AnyObject) =>
  JSON.stringify({
    allowIDOnCreate: adapter.allowIDOnCreate,
    blocksAsJSON: adapter.blocksAsJSON,
    limitedBoundParameters: adapter.limitedBoundParameters,
    now: Date.now(),
    withMutations: true,
  })

/** Upstream `getTransaction` (sqlite has no read replicas, so `primaryDrizzle` is never set). */
const getTransactionDB = async ({
  adapter,
  req,
}: {
  adapter: AnyObject
  req: AnyObject | undefined
}) => {
  if (!req?.transactionID) {
    return adapter.drizzle
  }
  return adapter.sessions[await req.transactionID]?.db || adapter.drizzle
}

/**
 * The args the engine receives: `req` reduced to what the drizzle code reads. `transactionID` is
 * resolved to the call's `connId`, `t` stays in TS (errors are translated by `rebuildError`).
 */
const reduceArgs = (args: AnyObject | undefined): unknown => {
  if (typeof args !== 'object' || args === null || !('req' in args)) {
    return args
  }
  const { req } = args
  if (typeof req !== 'object' || req === null) {
    return args
  }
  return {
    ...args,
    req: { fallbackLocale: req.fallbackLocale, locale: req.locale, payloadAPI: req.payloadAPI },
  }
}
