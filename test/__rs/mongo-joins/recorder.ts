/**
 * Records the calls of the db-mongodb modules ported by crates/payload-mongo-joins during upstream
 * int runs (TS engine), for the Rust replay in crates/payload-mongo-joins/tests/replay.rs.
 *
 * A *unit* is one call of a ported function (buildJoinAggregation, aggregatePaginate, resolveJoins,
 * findDistinct, queryDrafts) with its arguments and result. Every call it makes into code that is
 * NOT ported by the crate (buildQuery, buildSortParam, buildProjectionFromSelect, transform,
 * getSession, `Model.buildQuery`, `join.getForeignPath`, mongoose model calls) is a *leaf* event of
 * every unit on the async stack, with its arguments and result. The replay serves leaves from the
 * recording and checks that Rust makes the same leaf calls with the same arguments.
 *
 * Values use the typed boundary encoding of MONGO_ENGINE_CONTRACT.md ("Values"); objects that are
 * not plain data (sessions, other BSON types) are `{ $hostObject: n }` with one id per object per
 * process.
 *
 * Output (PAYLOAD_RS_JOINS_RECORD_DIR): `<label>-<pid>/config-<n>.json` per adapter (serialized
 * config + adapter flags + model collection names) and `<label>-<pid>/units.ndjson` (identical units
 * are written once; at most MAX_UNITS_PER_KIND per kind and MAX_UNIT_BYTES per unit).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  createFunctionRegistry,
  serializeForEngine,
} from '../../../packages/engine-rs/src/serialize.js'

type AnyObject = Record<PropertyKey, any>

type LeafEvent = {
  args: unknown
  chain?: unknown[]
  error?: unknown
  kind: string
  /** model ops: `{ kind, slug }`, method, chain */
  method?: string
  model?: unknown
  result?: unknown
  /** order of the event: call time (leaves), `exec` time (model ops) */
  time: number
}

type Unit = {
  adapter?: unknown
  args: unknown
  /** index of the `config-<n>.json` of the unit's adapter */
  config?: number
  error?: unknown
  events: LeafEvent[]
  kind: string
  result?: unknown
}

type Store = { inLeaf: boolean; units: Unit[] }

const als = new AsyncLocalStorage<Store>()

const recordDir = process.env.PAYLOAD_RS_JOINS_RECORD_DIR
export const isRecording = Boolean(recordDir)

const MAX_UNIT_BYTES = Number(process.env.PAYLOAD_RS_JOINS_MAX_UNIT_BYTES || 120_000)
const MAX_UNITS_PER_KIND = Number(process.env.PAYLOAD_RS_JOINS_MAX_UNITS_PER_KIND || 250)

let time = 0
const nextTime = () => ++time

const hostObjectIDs = new WeakMap<object, number>()
let nextHostObjectID = 0

const reservedKeys = new Set([
  '$bigint',
  '$binary',
  '$buffer',
  '$date',
  '$decimal',
  '$fn',
  '$hostObject',
  '$num',
  '$obj',
  '$oid',
  '$ref',
  '$regex',
  '$undefined',
])

const hostObject = (value: object) => {
  let id = hostObjectIDs.get(value)
  if (id === undefined) {
    id = nextHostObjectID++
    hostObjectIDs.set(value, id)
  }
  return { $hostObject: id }
}

/** Typed tree encoding of a JS value (MONGO_ENGINE_CONTRACT.md "Values"). */
export const encode = (value: unknown, seen: object[] = []): unknown => {
  switch (typeof value) {
    case 'bigint':
      return { $bigint: value.toString() }
    case 'function':
    case 'symbol':
      return hostObject(value as object)
    case 'number':
      if (!Number.isFinite(value)) {
        return { $num: String(value) }
      }
      return Object.is(value, -0) ? { $num: '-0' } : value
    case 'object': {
      if (value === null) {
        return null
      }
      if (value instanceof Date) {
        return { $date: Number.isNaN(value.getTime()) ? null : value.toISOString() }
      }
      if (value instanceof RegExp) {
        return { $regex: { flags: value.flags, source: value.source } }
      }
      const bsonType = (value as AnyObject)._bsontype
      if (typeof bsonType === 'string') {
        switch (bsonType) {
          case 'ObjectId':
            return { $oid: (value as AnyObject).toHexString() }
          case 'Decimal128':
            return { $decimal: String(value) }
          case 'Binary': {
            const binary = value as AnyObject
            const bytes: Uint8Array = binary.buffer.subarray(0, binary.position)
            return {
              $binary: {
                base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
                  'base64',
                ),
                subType: binary.sub_type,
              },
            }
          }
          default:
            return hostObject(value)
        }
      }
      if (value instanceof Uint8Array) {
        return {
          $buffer: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64'),
        }
      }
      if (seen.includes(value)) {
        throw new Error('recorder: circular value')
      }
      if (Array.isArray(value)) {
        return value.map((item) => encode(item, [...seen, value]))
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        return hostObject(value)
      }
      const out: AnyObject = {}
      const keys = Object.keys(value)
      for (const key of keys) {
        out[key] = encode((value as AnyObject)[key], [...seen, value])
      }
      return keys.length === 1 && reservedKeys.has(keys[0]!) ? { $obj: out } : out
    }
    case 'undefined':
      return { $undefined: true }
    default:
      return value
  }
}

const encodeError = (error: unknown) => {
  const e = error as AnyObject
  return { message: String(e?.message), name: String(e?.constructor?.name ?? e?.name) }
}

/** `fields.map((f) => f.name)`: identifies a fields array in leaf arguments. */
export const fieldNames = (fields: unknown) =>
  Array.isArray(fields) ? fields.map((field) => (field as AnyObject)?.name ?? null) : encode(fields)

// ---------------------------------------------------------------------------------------------
// output

const unitCounts = new Map<string, number>()
const writtenUnits = new Set<string>()
let outDir: string | undefined
const configIndexes = new WeakMap<object, number>()
let nextConfigIndex = 0

const output = () => {
  if (!outDir) {
    const label = (process.env.PAYLOAD_RS_JOINS_LABEL || 'run').replace(/[^\w.-]+/g, '_')
    outDir = path.join(recordDir!, `${label}-${process.pid}`)
    fs.mkdirSync(outDir, { recursive: true })
  }
  return outDir
}

const modelNames = (models: AnyObject | undefined) => {
  const out: AnyObject = {}
  for (const [slug, model] of Object.entries(models ?? {})) {
    out[slug] = (model as AnyObject)?.collection?.name ?? null
  }
  return out
}

/** Wraps `join.getForeignPath` of every collection so its calls are recorded as leaves. */
const wrapForeignPaths = (config: AnyObject) => {
  for (const collection of config.collections ?? []) {
    for (const joins of Object.values(collection.joins ?? {}) as AnyObject[][]) {
      for (const join of joins) {
        const original = join.getForeignPath
        if (typeof original === 'function' && !original.__rsRecorded) {
          const wrapped = function (this: unknown, arg: unknown) {
            return leafSync(
              'getForeignPath',
              () => encode(arg),
              () => original.call(this, arg),
            )
          }
          wrapped.__rsRecorded = true
          join.getForeignPath = wrapped
        }
      }
    }
  }
}

const writeConfig = (recorded: AnyObject): number => {
  const adapter = adapterTargets.get(recorded) ?? recorded
  const existing = configIndexes.get(adapter)
  if (existing !== undefined) {
    return existing
  }
  const index = nextConfigIndex++
  configIndexes.set(adapter, index)
  wrapForeignPaths(adapter.payload.config)
  const graph = serializeForEngine(adapter.payload.config, createFunctionRegistry(), undefined, {})
  const info = {
    adapter: encode({
      collation: adapter.collation,
      disableIndexHints: adapter.disableIndexHints,
      useJoinAggregations: adapter.useJoinAggregations,
    }),
    collectionNames: {
      collections: modelNames(adapter.collections),
      versions: modelNames(adapter.versions),
    },
    tz: process.env.TZ ?? null,
  }
  fs.writeFileSync(
    path.join(output(), `config-${index}.json`),
    `{"info":${JSON.stringify(info)},"graph":${graph}}`,
  )
  return index
}

const writeUnit = (unit: Unit) => {
  const count = unitCounts.get(unit.kind) ?? 0
  if (count >= MAX_UNITS_PER_KIND) {
    return
  }
  let line: string
  try {
    line = JSON.stringify(unit)
  } catch {
    return
  }
  // identical units (up to event times and host object ids) are written once
  const key = createHash('sha1')
    .update(line.replace(/"time":(\d+|null)/g, '').replace(/"\$hostObject":\d+/g, ''))
    .digest('hex')
  if (writtenUnits.has(key)) {
    return
  }
  writtenUnits.add(key)
  if (line.length > MAX_UNIT_BYTES) {
    fs.appendFileSync(
      path.join(output(), 'skipped.ndjson'),
      `${JSON.stringify({ bytes: line.length, kind: unit.kind })}\n`,
    )
    return
  }
  unitCounts.set(unit.kind, count + 1)
  fs.appendFileSync(path.join(output(), 'units.ndjson'), `${line}\n`)
}

// ---------------------------------------------------------------------------------------------
// units and leaves

/** Runs a ported function as a recorded unit. */
export const unit = async <T>(
  kind: string,
  adapter: AnyObject,
  encodeArgs: () => unknown,
  run: () => Promise<T>,
  encodeResult: (result: T) => unknown = (result) => encode(result),
): Promise<T> => {
  const store = als.getStore()
  if (!isRecording || store?.inLeaf) {
    return run()
  }
  const config = writeConfig(adapter)
  const target = adapterTargets.get(adapter) ?? adapter
  const record: Unit = {
    // the adapter flags the ported code reads, at call time (tests change them on the instance)
    adapter: encode({
      collation: target.collation,
      disableIndexHints: target.disableIndexHints,
      useJoinAggregations: target.useJoinAggregations,
    }),
    args: encodeArgs(),
    config,
    events: [],
    kind,
  }
  const units = [...(store?.units ?? []), record]
  try {
    const result = await als.run({ inLeaf: false, units }, run)
    record.result = encodeResult(result)
    writeUnit(record)
    return result
  } catch (error) {
    record.error = encodeError(error)
    writeUnit(record)
    throw error
  }
}

const activeUnits = () => {
  const store = als.getStore()
  return store && !store.inLeaf ? store.units : undefined
}

const push = (units: Unit[], event: LeafEvent) => {
  for (const u of units) {
    u.events.push(event)
  }
}

/** Runs an async leaf (not ported code) and records it in the active units. */
export const leaf = async <T>(
  kind: string,
  encodeArgs: () => unknown,
  run: () => Promise<T>,
  encodeResult = encode,
): Promise<T> => {
  const units = activeUnits()
  if (!units) {
    return run()
  }
  const event: LeafEvent = { args: encodeArgs(), kind, time: nextTime() }
  push(units, event)
  try {
    const result = await als.run({ inLeaf: true, units }, run)
    event.result = encodeResult(result)
    return result
  } catch (error) {
    event.error = encodeError(error)
    throw error
  }
}

/** A synchronous leaf. `after` encodes extra data after the call (in-place mutations). */
export const leafSync = <T>(
  kind: string,
  encodeArgs: () => unknown,
  run: () => T,
  encodeResult: (result: T) => unknown = (result) => encode(result),
): T => {
  const units = activeUnits()
  if (!units) {
    return run()
  }
  const event: LeafEvent = { args: encodeArgs(), kind, time: nextTime() }
  push(units, event)
  try {
    const result = als.run({ inLeaf: true, units }, run)
    event.result = encodeResult(result)
    return result
  } catch (error) {
    event.error = encodeError(error)
    throw error
  }
}

// ---------------------------------------------------------------------------------------------
// mongoose models

const proxies = new WeakMap<object, object>()
const proxyRefs = new WeakMap<object, { kind: string; slug?: string }>()

const recordedMethods = new Set([
  'aggregate',
  'buildQuery',
  'countDocuments',
  'estimatedDocumentCount',
  'find',
  'findOne',
  'paginate',
])

/** `Model` with its query methods recorded as leaves (`model` events). */
export const recordModel = (model: AnyObject | undefined, ref: { kind: string; slug?: string }) => {
  if (!model || !isRecording || proxyRefs.has(model)) {
    return model
  }
  const cached = proxies.get(model)
  if (cached) {
    return cached
  }
  const proxy = new Proxy(model, {
    get(target, prop) {
      const value = Reflect.get(target, prop)
      if (typeof prop !== 'string' || !recordedMethods.has(prop) || typeof value !== 'function') {
        return value
      }
      return (...args: unknown[]) => {
        const units = activeUnits()
        if (!units) {
          return value.apply(target, args)
        }
        if (prop === 'buildQuery') {
          return leaf(
            'modelBuildQuery',
            () => {
              const { locale, where } = (args[0] ?? {}) as AnyObject
              return { locale: encode(locale), model: ref, where: encode(where) }
            },
            () => value.apply(target, args),
          )
        }
        const encodedArgs =
          prop === 'paginate'
            ? encode([
                args[0],
                Object.fromEntries(
                  Object.entries((args[1] ?? {}) as AnyObject).filter(
                    ([k]) => k !== 'useCustomCountFn',
                  ),
                ),
              ])
            : encode(args)
        const event: LeafEvent = {
          args: encodedArgs,
          chain: [],
          kind: 'model',
          method: prop,
          model: ref,
          time: Infinity,
        }
        if (prop === 'paginate') {
          event.time = nextTime()
          ;(event.args as unknown[]).push({
            hasCustomCountFn: typeof (args[1] as AnyObject)?.useCustomCountFn === 'function',
          })
        }
        push(units, event)
        const store: Store = { inLeaf: true, units }
        const returned = als.run(store, () => value.apply(target, args))
        const settle = (promise: Promise<unknown>) =>
          promise.then(
            (result) => {
              event.result = encode(result)
              return result
            },
            (error) => {
              event.error = encodeError(error)
              throw error
            },
          )
        if (prop === 'paginate') {
          return settle(returned)
        }
        const query = returned as AnyObject
        const originalExec = query.exec
        const originalLean = query.lean
        if (typeof originalLean === 'function') {
          query.lean = (...leanArgs: unknown[]) => {
            event.chain!.push(['lean', encode(leanArgs)])
            return originalLean.apply(query, leanArgs)
          }
        }
        query.exec = (...execArgs: unknown[]) => {
          if (event.time === Infinity) {
            event.time = nextTime()
          }
          return settle(als.run(store, () => originalExec.apply(query, execArgs)))
        }
        return query
      }
    },
  })
  proxies.set(model, proxy)
  proxyRefs.set(proxy, ref)
  return proxy
}

const recordModels = (models: AnyObject | undefined, kind: string) =>
  models &&
  new Proxy(models, {
    get(target, prop) {
      const model = Reflect.get(target, prop)
      return typeof prop === 'string' ? recordModel(model, { kind, slug: prop }) : model
    },
  })

const adapterTargets = new WeakMap<object, AnyObject>()

/** The adapter with `collections` / `versions` models recorded. */
export const recordAdapter = (adapter: AnyObject) => {
  if (!isRecording || adapterTargets.has(adapter)) {
    return adapter
  }
  const proxy = new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'collections') {
        return recordModels(target.collections, 'collections')
      }
      if (prop === 'versions') {
        return recordModels(target.versions, 'versions')
      }
      return Reflect.get(target, prop, target)
    },
  })
  adapterTargets.set(proxy, adapter)
  return proxy
}

/** The `{ kind, slug }` of a model of the adapter. */
export const modelRefOf = (recorded: AnyObject, model: unknown) => {
  const adapter = adapterTargets.get(recorded) ?? recorded
  const proxied = proxyRefs.get(model as object)
  if (proxied) {
    return proxied
  }
  for (const kind of ['collections', 'versions'] as const) {
    for (const [slug, each] of Object.entries(adapter[kind] ?? {})) {
      if (each === model) {
        return { kind, slug }
      }
    }
  }
  if (adapter.globals === model) {
    return { kind: 'globals' }
  }
  return { kind: 'unknown' }
}
