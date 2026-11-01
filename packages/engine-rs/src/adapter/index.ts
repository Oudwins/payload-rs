import { writeFileSync } from 'node:fs'

/**
 * `withRustEngine(adapterObj)` (ENGINE_CONTRACT.md): the sqlite adapter with its raw schema and
 * every data method served by the Rust `SqliteEngine`. Everything else (drizzle tables, push,
 * migrations, transactions, `execute`, `payload.db.drizzle`) stays the upstream TS code, running
 * over the Rust-backed libsql client so drizzle and the engine share connections and ordering.
 */
import type { NativeSqliteEngine } from '../native.js'
import type { FunctionRegistry } from '../serialize.js'
import type { LoopbackEngine } from './loopback.js'

import { getNativeEngine } from '../native.js'
import { createEngineError } from '../schema.js'
import { createFunctionRegistry, deserializeFromEngine, serializeForEngine } from '../serialize.js'
import { getSqliteConnId } from '../sqlite/client.js'
import { rebuildError } from './errors.js'
import { createLoopbackEngine } from './loopback.js'
import { buildEngineInput, decodeRawSchema, initWithEngineSchema } from './schema.js'

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

type EngineState = {
  attachedClientId?: number
  engine: LoopbackEngine | NativeSqliteEngine
  hostErrors: unknown[]
  registry: FunctionRegistry
}

type AdapterObj = { init: (args: { payload: any }) => AnyObject }

const states = new WeakMap<object, EngineState>()

/** Whether `adapter` was created through `withRustEngine` (db-sqlite `connect` picks the client). */
export const isRustEngineAdapter = (adapter: unknown): boolean =>
  typeof adapter === 'object' && adapter !== null && rustAdapters.has(adapter)

const rustAdapters = new WeakSet<object>()

const isLoopback = () => process.env.PAYLOAD_RS_ENGINE_LOOPBACK === 'true'

const stats: { calls: Record<string, number>; engines: Record<'loopback' | 'native', number> } = {
  calls: {},
  engines: { loopback: 0, native: 0 },
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
    process.once('exit', () => writeFileSync(file, JSON.stringify(stats)))
  }
  const now = performance.now()
  if (now - lastStatsWrite > 250) {
    lastStatsWrite = now
    writeFileSync(file, JSON.stringify(stats))
  }
}

/**
 * Wraps the object returned by `@payloadcms/db-sqlite`'s `sqliteAdapter(args)`. Its `init` builds
 * the upstream adapter and swaps `init` (raw schema) and the data methods for the Rust engine.
 */
export const withRustEngine = <TAdapterObj extends AdapterObj>(
  adapterObj: TAdapterObj,
): TAdapterObj => ({
  ...adapterObj,
  init: (args: { payload: any }) => {
    const adapter = adapterObj.init(args)
    if (rustAdapters.has(adapter)) {
      return adapter
    }
    rustAdapters.add(adapter)

    const upstream: Record<string, (this: unknown, args: unknown) => Promise<unknown>> = {}
    for (const method of engineMethods) {
      upstream[method] = adapter[method]
      adapter[method] = function (this: AnyObject, methodArgs: AnyObject) {
        return callEngine({ adapter: this, args: methodArgs, method })
      }
    }

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
  const hostErrors: unknown[] = []
  const { graphJson, optionsJson, root } = buildEngineInput({ adapter: adapter as never, registry })

  // ENGINE_CONTRACT.md: a callback that throws answers `{"$hostError":true}`; the engine then
  // fails the operation and TS rethrows the callback's own error.
  const callFunction = (id: number, argJSON: string): string => {
    try {
      const fn = registry.functions[id]!
      return serializeForEngine(fn(JSON.parse(argJSON)), registry)
    } catch (error) {
      hostErrors.push(error)
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
    throw toInitError({ error, hostErrors })
  }

  return { engine, hostErrors, registry, root }
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
  if (!state) {
    throw new Error(`payload.db.${method}: the Rust engine is not initialized (call init first)`)
  }
  const req = args?.req
  mutateDataBeforeTransaction({ adapter, args, method })
  const db = await getTransactionDB({ adapter, req })
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

  const argsJson = serializeForEngine(reduceArgs(args), state.registry)
  recordStats(() => (stats.calls[method] = (stats.calls[method] ?? 0) + 1))
  let resultJson: string
  try {
    resultJson = await state.engine.call(method, argsJson, connId, callContextJson(adapter))
  } catch (error) {
    if (state.hostErrors.length) {
      throw state.hostErrors.shift()
    }
    const parsed = parseEngineError(error)
    if (!parsed) {
      throw error
    }
    throw rebuildError({
      decode: (value) => deserializeFromEngine(value, state.registry),
      error: parsed as never,
      req,
    })
  }
  return deserializeFromEngine(JSON.parse(resultJson), state.registry)
}

/**
 * Mutations upstream makes to the caller's `data` object, which the caller can observe; done here
 * on the caller's object (at the same point relative to `getTransaction`), so the engine receives
 * the mutated data and must not repeat them:
 * - `createGlobal`: `data.createdAt = new Date().toISOString()` (before `getTransaction`)
 * - `updateJobs`: `delete data.log` unless it is a non-empty array or a `$push` (first statement)
 * - `create`: `upsertRow` sets `data.createdAt` when it is falsy (after `getTransaction`)
 */
const mutateDataBeforeTransaction = ({
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
    if (
      adapter.payload.globals.config.find((config: { slug: string }) => config.slug === args.slug)
    ) {
      args.data.createdAt = new Date().toISOString()
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
