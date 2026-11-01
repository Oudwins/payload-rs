/**
 * Records calls of the real TS query builders of `@payloadcms/db-mongodb` for the Rust differential
 * (crates/payload-mongo-query/tests/replay/mod.rs): arguments before / after, result or error, and
 * the mongoose model calls made while the call ran (`Model.find(...).lean().select(...)`,
 * `Model.find(filter, { lean: true })`, `Model.distinct(path, filter)`) as contract host op requests
 * (MONGO_ENGINE_CONTRACT.md "Host ops") with their results.
 *
 * Model statics of `payload.db.collections` are wrapped once; calls are attributed to the case whose
 * async context issued them (AsyncLocalStorage), so concurrent unrelated queries are not recorded.
 */
import type { Payload } from 'payload'

import { AsyncLocalStorage } from 'node:async_hooks'

import {
  createFunctionRegistry,
  type FunctionRegistry,
  serializeForEngine,
} from '../../../packages/engine-rs/src/serialize.js'

export type Graph = { objects: unknown[]; root: unknown }

export type HostOp = {
  error?: { message: string; name: string }
  request: Graph
  result?: Graph
}

export type RecordedCase = {
  args: Graph
  argsAfter?: Graph
  error?: { message: string; name: string; status?: number }
  hostOps: HostOp[]
  id: number
  kind: 'buildQuery' | 'modelBuildQuery' | 'parseParams' | 'projection' | 'sort'
  result?: Graph
}

type PendingOp = {
  args: unknown[]
  chain: [string, unknown[]][]
  error?: { message: string; name: string }
  method: string
  /** hydrated documents came back: recorded as `doc.toObject()` with `post: 'toObject'` */
  post?: 'toObject'
  result?: Graph
  settled: boolean
  slug: string
}

const patched = Symbol.for('rs-mongo-query:patched')

/** Copies plain objects / arrays (not class instances: ObjectIds, Dates stay shared). */
export const snapshot = (v: unknown): unknown => {
  if (Array.isArray(v)) {
    return v.map(snapshot)
  }
  if (v && typeof v === 'object') {
    const proto = Object.getPrototypeOf(v)
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(v)) {
        Object.defineProperty(out, key, {
          configurable: true,
          enumerable: true,
          value: snapshot((v as Record<string, unknown>)[key]),
          writable: true,
        })
      }
      return out
    }
  }
  return v
}

export const errorJson = (e: unknown): { message: string; name: string; status?: number } => {
  const err = e as { message?: unknown; name?: unknown; status?: unknown }
  const out: { message: string; name: string; status?: number } = {
    name: String(err?.name ?? 'Error'),
    message: String(err?.message ?? e),
  }
  if (typeof err?.status === 'number') {
    out.status = err.status
  }
  return out
}

export type Recorder = {
  /** whether the current async context is inside a `record` of this recorder */
  isActive: () => boolean
  record: (
    kind: RecordedCase['kind'],
    args: Record<string, unknown>,
    run: () => unknown,
  ) => Promise<{ case: RecordedCase; error?: unknown; value?: unknown }>
  registry: FunctionRegistry
  serialize: (v: unknown) => Graph
}

export const createRecorder = (payload: Payload): Recorder => {
  const registry = createFunctionRegistry()
  const serialize = (v: unknown): Graph =>
    JSON.parse(serializeForEngine(v, registry, undefined, {})) as Graph
  const storage = new AsyncLocalStorage<PendingOp[]>()

  const track = (query: any, slug: string, method: string, args: unknown[]) => {
    const ops = storage.getStore()
    if (!ops || !query || typeof query.then !== 'function') {
      return query
    }
    const op: PendingOp = {
      args: snapshot(args) as unknown[],
      chain: [],
      method,
      settled: false,
      slug,
    }
    ops.push(op)
    for (const name of ['lean', 'select']) {
      const original = query[name]
      query[name] = function (...chainArgs: unknown[]) {
        op.chain.push([name, snapshot(chainArgs) as unknown[]])
        return original.apply(this, chainArgs)
      }
    }
    const then = query.then
    query.then = function (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      // a non-lean `find` returns hydrated documents (opaque to the engine): recorded as the host
      // returns them with `post: 'toObject'`
      const isHydrated = op.method === 'find' && !query._mongooseOptions?.lean
      if (isHydrated) {
        op.post = 'toObject'
      }
      return then.call(
        this,
        (value: unknown) => {
          op.result = serialize(
            isHydrated ? (value as any[]).map((d) => (typeof d?.toObject === 'function' ? d.toObject() : d)) : value,
          )
          op.settled = true
          return resolve ? resolve(value) : value
        },
        (e: unknown) => {
          op.error = errorJson(e)
          op.settled = true
          if (reject) {
            return reject(e)
          }
          throw e
        },
      )
    }
    return query
  }

  for (const [slug, Model] of Object.entries(payload.db.collections as Record<string, any>)) {
    if (Model[patched]) {
      continue
    }
    Model[patched] = true
    for (const method of ['find', 'distinct']) {
      const original = Model[method]
      Model[method] = function (...args: unknown[]) {
        return track(original.apply(this, args), slug, method, args)
      }
    }
  }

  let nextID = 0

  const record: Recorder['record'] = async (kind, args, run) => {
    const before = serialize(args)
    const ops: PendingOp[] = []
    let value: unknown
    let error: unknown
    let failed = false
    try {
      value = await storage.run(ops, async () => run())
    } catch (e) {
      failed = true
      error = e
    }
    const after = serialize(args)
    const recorded: RecordedCase = {
      id: nextID++,
      args: before,
      hostOps: ops.map((op) => ({
        request: serialize({
          op: 'model',
          model: { kind: 'collections', slug: op.slug },
          method: op.method,
          args: op.args,
          chain: op.chain,
          ...(op.post ? { post: op.post } : {}),
        }),
        ...(op.error ? { error: op.error } : { result: op.result }),
      })),
      kind,
    }
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      recorded.argsAfter = after
    }
    if (failed) {
      recorded.error = errorJson(error)
    } else {
      recorded.result = serialize(value)
    }
    return { case: recorded, error, value }
  }

  return { isActive: () => storage.getStore() !== undefined, record, registry, serialize }
}

/** The config graph the Rust side reads (`QueryEnv::from_root`) plus the recorded field sets. */
export const serializeEnv = (recorder: Recorder, payload: Payload, fieldSets: unknown[]): Graph =>
  recorder.serialize({
    blocks: payload.blocks,
    collections: Object.fromEntries(
      Object.entries(payload.collections).map(([slug, c]) => [
        slug,
        { config: c.config, customIDType: c.customIDType },
      ]),
    ),
    config: payload.config,
    defaultIDType: payload.db.defaultIDType,
    fieldSets,
  })

export const modelInfo = (payload: Payload): Record<string, string> =>
  Object.fromEntries(
    Object.entries(payload.db.collections as Record<string, any>).map(([slug, Model]) => [
      slug,
      Model.collection.name,
    ]),
  )
