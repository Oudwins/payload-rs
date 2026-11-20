/**
 * `withRustMongoEngine(adapterObj)` (MONGO_ENGINE_CONTRACT.md): the `@payloadcms/db-mongodb`
 * adapter with every data method served by the Rust engine.
 *
 * Live engine (stage 1b, live.ts): right after upstream's `init` builds the adapter, its data
 * methods are replaced by the live Rust ports, which receive the caller's real arguments and the
 * adapter as `this` (no copy, no JSON) and call the adapter's real mongoose models, and its `init`
 * (model building) by the live port of db-mongodb's `init`. Nothing else is wrapped. Connection
 * use, transactions, migrations and `payload.db.collections` / `versions` / `globals` /
 * `connection` stay the upstream TS. An addon without the complete live engine is an error.
 *
 * Stage 1 (JSON `MongoEngine`, host.ts / codec.ts) runs only when explicitly selected:
 * `PAYLOAD_RS_MONGO_ENGINE=stage1`, or `PAYLOAD_RS_MONGO_LOOPBACK=true` (stage 1 on the TS
 * loopback engine, loopback.ts).
 */
import { AsyncResource } from 'node:async_hooks'
import { renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { FunctionRegistry } from '../serialize.js'
import type { MongoEngineError } from './errors.js'
import type { NativeMongoEngine } from './native.js'

import { createEngineError } from '../schema.js'
import { createFunctionRegistry, deserializeFromEngine, serializeForEngine } from '../serialize.js'
import {
  createArgsBoundary,
  createHostObjects,
  createResultBoundary,
  encodeMongoTree,
  getBsonClasses,
} from './codec.js'
import { rebuildMongoError } from './errors.js'
import { registerFlushOnFileEnd } from './flushOnFileEnd.js'
import { createHostExecutor, hostOpStats, hostTimings } from './host.js'
import { createLoopbackMongoEngine } from './loopback.js'
import { createLiveInit, getLiveDepsPorted, getLiveEngineCalls, installLiveEngine } from './live.js'
import { getNativeMongoEngineClass } from './native.js'

type AnyObject = Record<PropertyKey, any>

/** Adapter methods served by `MongoEngine.call` (method name = adapter property). */
export const mongoEngineMethods = [
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
  engine: NativeMongoEngine
  /**
   * Errors thrown by JS functions the engine called (`callFunction`) during `call`, per registry
   * function id in throw order; the engine fails the call with `HostError`
   * `JS function <id> threw` and the caller gets the function's own error. Cleared whenever no
   * engine call is in flight.
   */
  hostErrors: [id: number, error: unknown][]
  inFlight: number
  registry: FunctionRegistry
}

type AdapterObj = { init: (args: { payload: any }) => AnyObject }

const states = new WeakMap<object, EngineState>()
const rustAdapters = new WeakSet<object>()

const isLoopback = () => process.env.PAYLOAD_RS_MONGO_LOOPBACK === 'true'
const isStage1Only = () => isLoopback() || process.env.PAYLOAD_RS_MONGO_ENGINE === 'stage1'

/** Whether `adapter` was created through `withRustMongoEngine`. */
export const isRustMongoEngineAdapter = (adapter: unknown): boolean =>
  typeof adapter === 'object' && adapter !== null && rustAdapters.has(adapter)

const stats = {
  /** Stage-1 `MongoEngine.call`s per method. */
  calls: {} as Record<string, number>,
  /** Adapters served: live engine, stage-1 native `MongoEngine`, stage-1 TS loopback. */
  engines: { live: 0, loopback: 0, native: 0 },
  hostOps: hostOpStats,
  /** Adapters whose `init` (model building) is the live Rust port. */
  liveInit: 0,
  /** Live engine calls per method (reads counted by the JS installer, writes by the addon). */
  liveCalls: {} as Record<string, number>,
  /** Methods served by the live engine (union over adapters). */
  liveMethods: [] as string[],
  /** Live dependencies (buildQuery, transform, joins, ...) running their Rust port. */
  livePorted: {} as Record<string, boolean>,
  /** Cumulative milliseconds: args encoding, result decoding, `MongoEngine.call` wall time. */
  timings: hostTimings,
}

/**
 * Engines created, `MongoEngine.call`s per method and host ops per op in this process, so a run
 * can prove the engine really served the data methods. Written (JSON, throttled, and at exit) to
 * `PAYLOAD_RS_MONGO_ENGINE_STATS_FILE` and/or to `<PAYLOAD_RS_MONGO_ENGINE_STATS_DIR>/mongo-engine-<pid>.json`
 * (one file per process: child processes of a test write their own).
 */
export const getRustMongoEngineStats = () => stats

let lastStatsWrite = 0

const statsFiles = () => {
  const files: string[] = []
  if (process.env.PAYLOAD_RS_MONGO_ENGINE_STATS_FILE) {
    files.push(process.env.PAYLOAD_RS_MONGO_ENGINE_STATS_FILE)
  }
  if (process.env.PAYLOAD_RS_MONGO_ENGINE_STATS_DIR) {
    files.push(
      path.join(process.env.PAYLOAD_RS_MONGO_ENGINE_STATS_DIR, `mongo-engine-${process.pid}.json`),
    )
  }
  return files
}

let isStatsWriterInstalled = false

const recordStats = (update: () => void) => {
  update()
  const files = statsFiles()
  if (!files.length) {
    return
  }
  if (!isStatsWriterInstalled) {
    isStatsWriterInstalled = true
    process.once('exit', () => files.forEach(writeStatsFile))
    // live calls never pass through this module: refresh the file periodically, and at the end of
    // every test file (test runners terminate workers without an `exit` event)
    setInterval(() => files.forEach(writeStatsFile), 1000).unref()
    registerFlushOnFileEnd(() => files.forEach(writeStatsFile))
  }
  const now = performance.now()
  if (now - lastStatsWrite > 250) {
    lastStatsWrite = now
    files.forEach(writeStatsFile)
  }
}

/**
 * Harness only (a stats file is configured): writes the stats synchronously when `destroy` is
 * called (test runners terminate worker processes without an `exit` event), then calls the
 * adapter's own `destroy` and returns its very promise.
 */
const flushStatsBeforeDestroy = (adapter: AnyObject) => {
  const files = statsFiles()
  const destroy = adapter.destroy
  if (!files.length || typeof destroy !== 'function') {
    return
  }
  adapter.destroy = function (this: unknown, ...args: unknown[]) {
    files.forEach(writeStatsFile)
    return destroy.apply(this, args)
  }
}

const writeStatsFile = (file: string) => {
  if (stats.engines.live) {
    stats.liveCalls = getLiveEngineCalls()
    stats.livePorted = getLiveDepsPorted()
  }
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(stats))
  renameSync(temporary, file)
}

/**
 * Wraps the object returned by `@payloadcms/db-mongodb`'s `mongooseAdapter(args)`. Its `init`
 * builds the upstream adapter and swaps the data methods and model building for the live Rust
 * engine (throws when the addon lacks any part of it). With `PAYLOAD_RS_MONGO_ENGINE=stage1` /
 * `PAYLOAD_RS_MONGO_LOOPBACK=true` only: the stage-1 engine, created after the adapter's own `init`
 * (models) ran upstream.
 */
export const withRustMongoEngine = <TAdapterObj extends AdapterObj>(
  adapterObj: TAdapterObj,
): TAdapterObj => ({
  ...adapterObj,
  init: (args: { payload: any }) => {
    const adapter = adapterObj.init(args)
    if (rustAdapters.has(adapter)) {
      return adapter
    }
    rustAdapters.add(adapter)

    const upstream: Record<string, UpstreamMethod> = {}
    for (const method of mongoEngineMethods) {
      upstream[method] = adapter[method]
    }
    if (!isStage1Only()) {
      const live = installLiveEngine({ adapter, methods: mongoEngineMethods })
      adapter.init = createLiveInit()
      recordStats(() => {
        stats.engines.live++
        stats.liveMethods = [...new Set([...stats.liveMethods, ...live])].sort()
        stats.liveInit++
      })
      flushStatsBeforeDestroy(adapter)
      return adapter
    }
    for (const method of mongoEngineMethods) {
      adapter[method] = function (this: AnyObject, methodArgs: AnyObject) {
        return callEngine({ adapter: this, args: methodArgs, method })
      }
    }

    const upstreamInit = adapter.init as (this: AnyObject) => Promise<void> | void
    adapter.init = async function (this: AnyObject) {
      await upstreamInit.call(this)
      states.set(this, createEngineState({ adapter: this, upstream }))
    }

    return adapter
  },
})

const createEngineState = ({
  adapter,
  upstream,
}: {
  adapter: AnyObject
  upstream: Record<string, UpstreamMethod>
}): EngineState => {
  const registry = createFunctionRegistry()
  const createErrors: unknown[] = []
  const hostErrors: EngineState['hostErrors'] = []
  let isCreated = false

  // a callback that throws answers `{"$hostError":true}`; the engine fails the operation and TS
  // rethrows the callback's own error (ENGINE_CONTRACT.md)
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

  let engine: NativeMongoEngine
  try {
    recordStats(() => stats.engines[isLoopback() ? 'loopback' : 'native']++)
    if (isLoopback()) {
      engine = createLoopbackMongoEngine({ adapter, methods: upstream, registry })
    } else {
      const MongoEngine = getNativeMongoEngineClass()
      if (!MongoEngine) {
        throw new Error(
          'The payload-engine addon has no MongoEngine (rebuild crates/payload-node, or set PAYLOAD_RS_MONGO_LOOPBACK=true to run the TS loopback engine)',
        )
      }
      const { graphJson, optionsJson } = buildMongoEngineInput({ adapter, registry })
      engine = MongoEngine.create(graphJson, optionsJson, callFunction)
    }
  } catch (error) {
    if (createErrors.length) {
      throw createErrors.shift()
    }
    const parsed = parseEngineError(error)
    throw parsed ? createEngineError(parsed as never) : error
  }
  isCreated = true

  return { engine, hostErrors, inFlight: 0, registry }
}

/**
 * `graphJson` / `optionsJson` for `MongoEngine.create`: the sanitized config graph (the same root
 * as the SQLite engine) and the adapter options fixed at construction.
 */
export const buildMongoEngineInput = ({
  adapter,
  registry,
}: {
  adapter: AnyObject
  registry: FunctionRegistry
}) => {
  const { payload } = adapter
  const collections: Record<string, { config: unknown; customIDType?: string }> = {}
  for (const slug of Object.keys(payload.collections)) {
    const { config, customIDType } = payload.collections[slug]
    collections[slug] = { config, customIDType }
  }
  const root = { blocks: payload.blocks, collections, config: payload.config }
  const options = {
    name: adapter.name,
    autoPluralization: adapter.autoPluralization,
    collectionsSchemaOptions: adapter.collectionsSchemaOptions,
    ensureIndexes: adapter.ensureIndexes,
    transactionOptions: adapter.transactionOptions,
    useAlternativeDropDatabase: adapter.useAlternativeDropDatabase,
  }
  return { graphJson: serializeForEngine(root, registry), optionsJson: JSON.stringify(options) }
}

/**
 * Per-call context (`contextJson`), read live per call: the adapter properties the upstream
 * methods read at call time (users and tests change them after init, e.g.
 * `payload.db.useJoinAggregations = false`), `Model.collection.name` per collection / version model
 * (read synchronously by upstream for `$lookup.from`), the JS clock for upstream's `new Date()`
 * stamps (faked clocks apply), whether the call has a `req` (`getSession` / `handleError`), and
 * `withMutations` (the result is `{ result, mutations }`).
 */
export const callContextJson = ({
  adapter,
  args,
  clockFunction,
}: {
  adapter: AnyObject
  args: unknown
  clockFunction: number
}) => {
  const collections: Record<string, unknown> = {}
  for (const [slug, Model] of Object.entries(adapter.collections ?? {})) {
    collections[slug] = (Model as AnyObject)?.collection?.name
  }
  const versions: Record<string, unknown> = {}
  for (const [slug, Model] of Object.entries(adapter.versions ?? {})) {
    versions[slug] = (Model as AnyObject)?.collection?.name
  }
  return JSON.stringify({
    adapter: {
      allowAdditionalKeys: adapter.allowAdditionalKeys,
      allowIDOnCreate: adapter.allowIDOnCreate,
      collation: adapter.collation,
      disableFallbackSort: adapter.disableFallbackSort,
      disableIndexHints: adapter.disableIndexHints,
      useBigIntForNumberIDs: adapter.useBigIntForNumberIDs,
      useJoinAggregations: adapter.useJoinAggregations,
      usePipelineInSortLookup: adapter.usePipelineInSortLookup,
    },
    // `callFunction(clockFunction, '[]')` = `Date.now()`, read synchronously where upstream
    // evaluates `new Date()`: same number and order of readings (fake timers, shadow clock replay),
    // in the caller's async context
    clockFunction,
    hasReq: Boolean((args as AnyObject | undefined)?.req),
    models: { collections, versions },
    // the loopback engine reads the clock itself (upstream code): no extra reading, so clock
    // replays (shadow harness) see the same sequence of readings as upstream
    now: isLoopback() ? undefined : Date.now(),
    withMutations: true,
  })
}

const parseEngineError = (error: unknown): MongoEngineError | undefined => {
  if (!(error instanceof Error)) {
    return undefined
  }
  try {
    const parsed = JSON.parse(error.message)
    return typeof parsed === 'object' &&
      parsed !== null &&
      (typeof parsed.name === 'string' || typeof parsed.rethrow === 'number')
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

function releasedFunction(): never {
  throw new Error('MongoEngine: the clock function of a finished call was called')
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
  if (!state) {
    throw new Error(`payload.db.${method}: the Rust engine is not initialized (call init first)`)
  }
  const classes = getBsonClasses(adapter)
  const hostObjects = createHostObjects()
  const argsBoundary = createArgsBoundary({ classes, hostObjects })
  const resultBoundary = createResultBoundary({ classes, hostObjects })
  const decode = (tree: unknown) => deserializeFromEngine(tree, state.registry, resultBoundary)
  // host ops and the clock run in the caller's async context (AsyncLocalStorage of user
  // middleware, the shadow harness's clock / ObjectId replay), whatever context the addon calls
  // them from
  const callResource = new AsyncResource('PayloadMongoEngineCall')
  const host = callResource.bind(
    createHostExecutor({ adapter, args, classes, hostObjects, registry: state.registry }),
  )
  const clockFunction = state.registry.functions.push(callResource.bind(() => Date.now())) - 1
  const encodeStart = performance.now()
  const argsJson = JSON.stringify(
    encodeMongoTree({
      hostObjectID: argsBoundary.hostObjectID,
      registry: state.registry,
      value: withoutReq(args),
    }),
  )
  hostTimings.argsEncode += performance.now() - encodeStart

  recordStats(() => (stats.calls[method] = (stats.calls[method] ?? 0) + 1))
  let resultJson: string
  state.inFlight++
  const callStart = performance.now()
  try {
    resultJson = await state.engine.call(
      method,
      argsJson,
      callContextJson({ adapter, args, clockFunction }),
      host,
    )
  } catch (error) {
    const parsed = parseEngineError(error)
    if (!parsed) {
      throw error
    }
    applyMutations({ args, decode, mutations: parsed.mutations })
    if (typeof parsed.rethrow === 'number') {
      throw hostObjects.objects[parsed.rethrow]
    }
    const hostError = takeHostError({ error: parsed, state })
    if (hostError.isFound) {
      throw hostError.error
    }
    throw rebuildMongoError({ classes, decode, error: parsed, req: args?.req })
  } finally {
    hostTimings.callWall += performance.now() - callStart
    // the slot stays (ids are positions); the bound function is released
    state.registry.functions[clockFunction] = releasedFunction
    if (--state.inFlight === 0) {
      state.hostErrors.length = 0
    }
  }
  const { mutations, result } = JSON.parse(resultJson) as {
    mutations?: [string[], unknown][]
    result: unknown
  }
  const decodeStart = performance.now()
  applyMutations({ args, decode, mutations })
  const decoded = decode(result)
  hostTimings.resultDecode += performance.now() - decodeStart
  return decoded
}

/** The error a JS function threw when the engine reports `JS function <id> threw`. */
const takeHostError = ({
  error,
  state,
}: {
  error: MongoEngineError
  state: EngineState
}): { error?: unknown; isFound: boolean } => {
  const id =
    error.name === 'HostError'
      ? /^JS function (\d+) threw$/.exec(error.message ?? '')?.[1]
      : undefined
  const index = id === undefined ? -1 : state.hostErrors.findIndex(([fnId]) => fnId === Number(id))
  if (index === -1) {
    return { isFound: false }
  }
  const [found] = state.hostErrors.splice(index, 1)
  return { error: found?.[1], isFound: true }
}

/**
 * Applies the argument mutations upstream made (the engine reports them, the caller observes them
 * on its own objects): every `[path, tree]` makes the value at `path` of the arguments equal to
 * `tree`, in place: plain objects and arrays present on both sides keep their identity (keys
 * removed / added / replaced inside), anything else is assigned.
 */
export const applyMutations = ({
  args,
  decode,
  mutations,
}: {
  args: AnyObject
  decode: (tree: unknown) => unknown
  mutations: [string[], unknown][] | undefined
}) => {
  for (const [path, tree] of mutations ?? []) {
    let target = args
    for (const key of path.slice(0, -1)) {
      target = target[key]
    }
    syncInto(target, path.at(-1)!, decode(tree))
  }
}

const isPlainObject = (value: unknown): value is AnyObject => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const syncInto = (target: AnyObject, key: number | string, value: unknown) => {
  const current = target[key]
  if (isPlainObject(current) && isPlainObject(value)) {
    for (const existing of Object.keys(current)) {
      if (!Object.prototype.hasOwnProperty.call(value, existing)) {
        delete current[existing]
      }
    }
    for (const next of Object.keys(value)) {
      syncInto(current, next, value[next])
    }
  } else if (Array.isArray(current) && Array.isArray(value)) {
    current.length = value.length
    for (let i = 0; i < value.length; i++) {
      syncInto(current, i, value[i])
    }
  } else if (!Object.is(current, value) || !(key in target)) {
    target[key] = value
  }
}

/**
 * The args the engine receives: everything but `req`. The upstream methods read `req` only through
 * `getSession` (a host op on the original `req`), `handleError` (`req.t` stays in TS,
 * `rebuildMongoError`; `req.payload.config.localization` is the engine's config) and `upsert`'s
 * `this.updateOne({ ..., req })` (an `adapterCall` host op adds the original `req`).
 */
const withoutReq = (args: AnyObject | undefined): unknown => {
  if (typeof args !== 'object' || args === null || !('req' in args)) {
    return args
  }
  const { req: _req, ...rest } = args
  return rest
}
