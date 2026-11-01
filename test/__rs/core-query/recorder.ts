/**
 * Records real calls of the payload query/select utilities during upstream int runs, for the
 * differential replay in crates/payload-core-query/tests/differential.rs.
 *
 * Per call: the arguments (data arguments as identity-preserving graphs, config arguments as
 * `$cfg` paths into the serialized config), the result or error, the data arguments after the
 * call (in-place mutations), and for the async validators every host call (getEntityPermissions /
 * executeAccess) with its arguments, its result and when it settled:
 * - `depth`: the number of microtask levels between the call and its settlement, measured with a
 *   counter chain started right after the call (0 = settled synchronously),
 * - `external`: settled after the microtask queue drained (I/O); `settleSeq` orders those.
 *
 * Output: `RS_CORE_QUERY_OUT` (JSONL). Config lines come first for each config:
 * `{ type: 'config', id, defaultIDType, graph }`, then `{ type: 'call', ... }` lines.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'

import type { ConfigIndex } from './encode.js'

import {
  createFunctionRegistry,
  serializeForEngine,
} from '../../../packages/engine-rs/src/serialize.js'
import { encodeCfg, encodeData, encodeError, indexConfig } from './encode.js'

const outFile = process.env.RS_CORE_QUERY_OUT
const maxPerFn = Number(process.env.RS_CORE_QUERY_MAX_PER_FN || 500)
const maxRecordBytes = Number(process.env.RS_CORE_QUERY_MAX_RECORD_BYTES || 60_000)
const maxTotalBytes = Number(process.env.RS_CORE_QUERY_MAX_BYTES || 3_000_000)
const DEPTH_CAP = 5000

type HostCall = Record<string, unknown>
type Store = {
  accessID: (fn: unknown) => unknown
  host: HostCall[]
  nextObjectID: number
  objectIDs: WeakMap<object, number>
  req: unknown
}

const als = new AsyncLocalStorage<Store>()
const lines: string[] = []
let totalBytes = 0
const perFn = new Map<string, number>()
const seen = new Set<string>()
let externalSeq = 0

type ConfigEntry = { id: number; index: ConfigIndex }
const configs = new Map<object, ConfigEntry>()
let nextConfigID = 1

const registerConfig = (payload: any): ConfigEntry | undefined => {
  const config = payload?.config
  if (!config || typeof config !== 'object') {
    return undefined
  }
  const existing = configs.get(config)
  if (existing) {
    return existing
  }
  const root = {
    blocks: config.blocks,
    collections: config.collections,
    globals: config.globals,
    localization: config.localization,
  }
  const registry = createFunctionRegistry()
  const graph = serializeForEngine(root, registry)
  const entry = { id: nextConfigID++, index: indexConfig(root, registry) }
  configs.set(config, entry)
  const line = JSON.stringify({
    type: 'config',
    defaultIDType: payload.db?.defaultIDType,
    graph: JSON.parse(graph),
    id: entry.id,
    realm: { array: forInKeys([]), object: forInKeys({}), string: forInKeys('') },
  })
  lines.push(line)
  return entry
}

/** Enumerable keys inherited from the realm's built-in prototypes (normally none). */
const forInKeys = (value: object | string) => {
  const keys: string[] = []
  // eslint-disable-next-line guard-for-in
  for (const key in value as object) {
    keys.push(key)
  }
  return keys
}

/** Finds the config owning `probe` (a fields array / field / collection config). */
const configFor = (payload: any, probe?: unknown): ConfigEntry | undefined => {
  if (payload) {
    return registerConfig(payload)
  }
  if (probe && typeof probe === 'object') {
    for (const entry of configs.values()) {
      if (entry.index.paths.has(probe)) {
        return entry
      }
    }
    const cached: Map<string, any> | undefined = (globalThis as any)._payload
    for (const value of cached?.values() ?? []) {
      const p = value?.payload ?? value
      const entry = registerConfig(p)
      if (entry?.index.paths.has(probe)) {
        return entry
      }
    }
  }
  return undefined
}

const emit = (fn: string, record: Record<string, unknown>, dedupe: boolean) => {
  if (!outFile || totalBytes > maxTotalBytes) {
    return
  }
  const n = perFn.get(fn) ?? 0
  if (n >= maxPerFn) {
    return
  }
  const line = JSON.stringify({ type: 'call', fn, ...record })
  if (line.length > maxRecordBytes) {
    return
  }
  if (dedupe) {
    if (seen.has(line)) {
      return
    }
    seen.add(line)
  }
  perFn.set(fn, n + 1)
  totalBytes += line.length
  lines.push(line)
}

export const flush = () => {
  if (outFile && lines.length) {
    fs.appendFileSync(outFile, lines.join('\n') + '\n')
    lines.length = 0
  }
}

/**
 * Wraps a synchronous function. `describe` splits the argument into config parts (`cfg`), data
 * parts (`data`, compared before/after) and scalars, and names the payload for config lookup.
 */
export const wrapSync = <F extends (...args: any[]) => any>(
  fn: string,
  original: F,
  describe: (...args: Parameters<F>) => {
    cfg?: Record<string, unknown>
    data?: Record<string, unknown>
    payload?: unknown
    probe?: unknown
    scalars?: Record<string, unknown>
  },
  options: {
    cfgResult?: boolean
    wrapArgs?: (args: Parameters<F>, host: unknown[]) => Parameters<F>
  } = {},
): F =>
  function (this: unknown, ...args: Parameters<F>) {
    if (!outFile) {
      return original.apply(this, args)
    }
    let d: ReturnType<typeof describe>
    try {
      d = describe(...args)
    } catch {
      return original.apply(this, args)
    }
    const entry = configFor(d.payload, d.probe)
    const before = JSON.stringify(encodeData(d.data ?? {}))
    const cfg = Object.fromEntries(
      Object.entries(d.cfg ?? {}).map(([k, v]) => [k, encodeCfg(v, entry?.index)]),
    )
    const host: unknown[] = []
    const callArgs = options.wrapArgs ? options.wrapArgs(args, host) : args
    let result: unknown
    let error: unknown
    let threw = false
    try {
      result = original.apply(this, callArgs)
    } catch (e) {
      threw = true
      error = e
    }
    try {
      emit(
        fn,
        {
          after: encodeData({ ...(d.data ?? {}), result: options.cfgResult ? undefined : result }),
          before: JSON.parse(before),
          cfg,
          cfgResult: options.cfgResult && !threw ? encodeCfg(result, entry?.index) : undefined,
          config: entry?.id ?? null,
          error: threw ? encodeError(error) : undefined,
          host: host.length ? host : undefined,
          scalars: d.scalars,
        },
        true,
      )
    } catch {
      // unserializable input: not recorded
    }
    if (threw) {
      throw error
    }
    return result
  } as F

/**
 * Wraps a top-level async validator. Nested calls (made while another recorded call runs) are not
 * recorded, they are part of the outer call.
 */
export const wrapAsync = <F extends (args: any) => Promise<any>>(
  fn: string,
  original: F,
  describe: (args: Parameters<F>[0]) => {
    cfg?: Record<string, unknown>
    data?: Record<string, unknown>
    payload: unknown
    req: unknown
    scalars?: Record<string, unknown>
  },
): F =>
  function (this: unknown, args: Parameters<F>[0]) {
    if (!outFile || als.getStore()) {
      return original.call(this, args)
    }
    let d: ReturnType<typeof describe>
    let before: unknown
    let cfg: Record<string, unknown>
    let entry: ConfigEntry | undefined
    try {
      d = describe(args)
      entry = configFor(d.payload)
      before = encodeData(d.data ?? {})
      cfg = Object.fromEntries(
        Object.entries(d.cfg ?? {}).map(([k, v]) => [k, encodeCfg(v, entry?.index)]),
      )
    } catch {
      return original.call(this, args)
    }
    const store: Store = {
      accessID: (access) => encodeCfg(access, entry?.index),
      host: [],
      nextObjectID: 0,
      objectIDs: new WeakMap(),
      req: d.req,
    }
    const promise: Promise<unknown> = als.run(store, () => original.call(this, args))
    const record = (outcome: { error?: unknown; result?: unknown }) => {
      try {
        emit(
          fn,
          {
            after: encodeData({
              ...(d.data ?? {}),
              errorData: outcome.error && (outcome.error as any).data,
              result: outcome.result,
            }),
            before,
            cfg,
            config: entry?.id ?? null,
            error: 'error' in outcome ? encodeError(outcome.error) : undefined,
            host: store.host,
            scalars: d.scalars,
          },
          false,
        )
      } catch {
        // not recorded
      }
    }
    promise.then(
      (result) => record({ result }),
      (error) => record({ error }),
    )
    return promise
  } as F

const objectID = (store: Store, o: unknown) => {
  if (!o || typeof o !== 'object') {
    return 0
  }
  let id = store.objectIDs.get(o)
  if (id === undefined) {
    id = ++store.nextObjectID
    store.objectIDs.set(o, id)
  }
  return id
}

/** Wraps a host function (called by the validators) to record its call and settlement. */
export const wrapHost = <F extends (...args: any[]) => Promise<any>>(
  kind: string,
  original: F,
  describe: (store: Store, ...args: Parameters<F>) => Record<string, unknown>,
): F =>
  function (this: unknown, ...args: Parameters<F>) {
    const store = als.getStore()
    if (!store) {
      return original.apply(this, args)
    }
    const call: HostCall = { kind, ...describe(store, ...args) }
    store.host.push(call)
    // host internals (access functions running their own queries) are not part of the record
    const p: Promise<unknown> = als.exit(() => original.apply(this, args))
    let n = 0
    let done = false
    const settled = (outcome: Record<string, unknown>) => {
      done = true
      if (call.external) {
        call.settleSeq = ++externalSeq
      } else {
        call.depth = n
      }
      Object.assign(call, outcome)
    }
    p.then(
      (value) => settled({ ok: encodeData(value) }),
      (error) => settled({ err: encodeError(error) }),
    )
    const step = () => {
      if (done) {
        return
      }
      n++
      if (n < DEPTH_CAP) {
        void Promise.resolve().then(step)
      } else {
        call.external = true
      }
    }
    void Promise.resolve().then(step)
    return p
  } as F

export const hostObjectID = objectID
