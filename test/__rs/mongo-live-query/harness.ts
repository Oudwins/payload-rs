/**
 * Live differential harness for the Mongo query port (crates/payload-mongo-live-query).
 *
 * Each case builds its live inputs once and runs them through upstream's TS functions and through
 * the Rust port, each side on its own deep clone (same graph shape, sharing and classes). Per side
 * it records, in order:
 * - every [[Get]] / [[Set]] / [[Has]] / [[Delete]] / [[OwnKeys]] / [[GetOwnProperty]] /
 *   [[DefineOwnProperty]] / [[GetPrototypeOf]] on the input graph (recording proxies around every
 *   plain object and array of the inputs, and around the lean documents / result arrays mongoose
 *   hands back),
 * - every mongoose model call (`find`, `distinct`, `buildQuery` statics of every collection,
 *   version and globals model, with their args), the query chain (`lean`, `select`), the `then`
 *   that starts the I/O and its result,
 * - a microtask clock: ticks since the call (restarted when an I/O settles; it keeps ticking while
 *   events keep coming, and pauses only after 400 idle microtasks, i.e. while waiting for I/O)
 *   stamped on every trap, model event and on the settlement of the call, so a missing / extra
 *   `await` shows up,
 * - the result (key order, own `undefined`s, property descriptors, extra / symbol array
 *   properties, identity of input objects passed through incl. class instances, identity of
 *   generated objects across events of the run, prototype identity, classes incl. `ObjectId` class
 *   identity, Dates, function metadata: name, length, kind, constructibility, own `prototype`) or
 *   the error (prototype identity, `APIError`, message, status, own properties, identity of a value
 *   an input getter or a model method threw, `typeof` of thrown primitives),
 * - the input graph after the call (in-place mutations).
 *
 * Guards (a differential must not pass vacuously): the TS run must not enter the Rust engine and
 * the Rust run must (core runtime entry counter), the two implementations must be distinct
 * functions, and the caller asserts a minimum number of compared cases.
 */
import type { Payload } from 'payload'

import { getCoreRuntime } from '../../../packages/engine-rs/src/runtime/index.js'
import { APIError } from '../../../packages/payload/src/errors/APIError.js'
import { buildVersionCollectionFields } from '../../../packages/payload/src/versions/buildCollectionFields.js'
import { buildVersionGlobalFields } from '../../../packages/payload/src/versions/buildGlobalFields.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- inputs are arbitrary JS values */
type Any = any

export type Side = 'rs' | 'ts'

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return false
  }
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

const describeKey = (k: PropertyKey) => (typeof k === 'symbol' ? `@@${k.description}` : String(k))

/**
 * Deep clone keeping the graph shape: plain objects (own string + symbol keys, descriptors incl.
 * getters, null prototypes, non-extensible / frozen state), arrays (holes, extra props, custom
 * prototypes), class instances (same prototype, own props cloned; `Types.ObjectId` / `Decimal128`
 * via their constructor), Dates, RegExps, Maps, Sets, typed arrays / ArrayBuffers, boxed primitives. Shared objects
 * map to one clone. Functions (and so closure state) are NOT cloned: cases whose functions keep
 * state build their inputs per side (`makeInputs`). Promises are shared as well.
 */
export const cloneLive = (value: unknown, seen = new Map<object, unknown>()): unknown => {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return value
  }
  if (typeof value === 'function') {
    return value
  }
  if (seen.has(value)) {
    return seen.get(value)
  }
  const v = value as Any
  if (v instanceof Date) {
    const d = new Date(v.getTime())
    seen.set(v, d)
    return d
  }
  if (v instanceof Promise) {
    return v
  }
  if (v._bsontype === 'ObjectId' && typeof v.toHexString === 'function' && !isPlain(v)) {
    const c = new v.constructor(v.toHexString())
    seen.set(v, c)
    return c
  }
  if (v._bsontype === 'Decimal128' && !isPlain(v)) {
    const c = new v.constructor(v.toString())
    seen.set(v, c)
    return c
  }
  let out: Any
  let boxed = false
  if (v instanceof String || v instanceof Number || v instanceof Boolean) {
    // boxed primitives keep their [[PrimitiveValue]] slot
    out = Object((v as Any).valueOf())
    boxed = true
  } else if (v instanceof RegExp) {
    out = new RegExp(v.source, v.flags)
  } else if (v instanceof Map) {
    out = new Map()
  } else if (v instanceof Set) {
    out = new Set()
  } else if (ArrayBuffer.isView(v)) {
    out = (v as Any).slice()
  } else if (v instanceof ArrayBuffer) {
    out = v.slice(0)
  } else if (Array.isArray(v)) {
    out = new Array(v.length)
  } else {
    out = Object.create(Object.getPrototypeOf(v))
  }
  if (Object.getPrototypeOf(out) !== Object.getPrototypeOf(v)) {
    Object.setPrototypeOf(out, Object.getPrototypeOf(v))
  }
  seen.set(v, out)
  if (v instanceof Map) {
    for (const [k, e] of v) {
      out.set(cloneLive(k, seen), cloneLive(e, seen))
    }
  } else if (v instanceof Set) {
    for (const e of v) {
      out.add(cloneLive(e, seen))
    }
  }
  const skipIndices = ArrayBuffer.isView(v)
  for (const key of Reflect.ownKeys(v)) {
    if (
      (Array.isArray(v) && key === 'length') ||
      (skipIndices && typeof key === 'string' && /^\d+$/.test(key)) ||
      (boxed && Object.prototype.hasOwnProperty.call(out, key))
    ) {
      continue
    }
    const desc = Object.getOwnPropertyDescriptor(v, key)!
    if ('value' in desc) {
      desc.value = cloneLive(desc.value, seen)
    }
    Object.defineProperty(out, key, desc)
  }
  if (Array.isArray(v) && !Object.getOwnPropertyDescriptor(v, 'length')!.writable) {
    Object.defineProperty(out, 'length', { writable: false })
  }
  if (Object.isFrozen(v)) {
    Object.freeze(out)
  } else if (Object.isSealed(v)) {
    Object.seal(out)
  } else if (!Object.isExtensible(v)) {
    Object.preventExtensions(out)
  }
  return out
}

/** A stable number per prototype / class object (shared by both sides of a case). */
const protoIDs = new WeakMap<object, number>()
let nextProtoID = 0
export const protoID = (proto: object): number => {
  let id = protoIDs.get(proto)
  if (id === undefined) {
    id = nextProtoID++
    protoIDs.set(proto, id)
  }
  return id
}

/** `new f()` would not throw for not being a constructor (does not call `f`). */
const isConstructor = (f: unknown): boolean => {
  try {
    Reflect.construct(String, [], f as Any)
    return true
  } catch {
    return false
  }
}

export type Recorder = {
  events: unknown[]
  /** identity of generated (non-input) objects and functions across the events of one run */
  generatedIDs: WeakMap<object, number>
  /** call-order delivery of I/O results (see trackQuery) */
  io: { delivered: number; ready: Map<number, () => void>; scheduled: boolean; started: number }
  /** proxy or target -> node id */
  ids: WeakMap<object, number>
  /** errors a spied model method threw synchronously -> id */
  modelThrown: WeakMap<object, number>
  /** the next id for [[generatedIDs]] */
  nextGeneratedID: () => number
  /** restarts the microtask clock (call start, I/O settled) */
  restartClock: () => void
  stop: () => void
  /** id -> target */
  targets: object[]
  tick: () => number
  /** class instances to trace like plain objects (payload) */
  traceInstances: Set<object>
  tracing: boolean
  wrap: (value: unknown) => unknown
}

/** Idle microtasks after which the clock pauses (only I/O can be pending then). */
const IDLE_TICKS = 400

export const createRecorder = (traceInstances: object[] = []): Recorder => {
  const ids = new WeakMap<object, number>()
  const proxies = new Map<object, object>()
  const targets: object[] = []
  const events: unknown[] = []
  let ticks = 0
  let idle = 0
  let generation = 0
  let running = false
  let stopped = false
  let nextGenerated = 0
  const generatedIDs = new WeakMap<object, number>()
  const ensureTicker = () => {
    if (running || stopped) {
      return
    }
    running = true
    const mine = ++generation
    void (async () => {
      while (generation === mine && idle < IDLE_TICKS) {
        await null
        if (generation === mine) {
          ticks++
          idle++
        }
      }
      if (generation === mine) {
        running = false
      }
    })()
  }
  const rec: Recorder = {
    events,
    generatedIDs,
    ids,
    io: { delivered: 0, ready: new Map(), scheduled: false, started: 0 },
    modelThrown: new WeakMap(),
    nextGeneratedID: () => nextGenerated++,
    targets,
    tick: () => {
      idle = 0
      ensureTicker()
      return ticks
    },
    restartClock: () => {
      running = false
      generation++
      ticks = 0
      idle = 0
      ensureTicker()
    },
    stop: () => {
      stopped = true
      generation++
    },
    traceInstances: new Set(traceInstances),
    tracing: true,
    wrap: (value) => wrap(value),
  }
  const log = (trap: string, target: object, key?: PropertyKey, extra?: unknown) => {
    if (rec.tracing) {
      const tick = rec.tick()
      events.push(
        extra === undefined
          ? [trap, ids.get(target), key === undefined ? null : describeKey(key), tick]
          : [trap, ids.get(target), key === undefined ? null : describeKey(key), tick, extra],
      )
    }
  }
  const wrap = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') {
      return value
    }
    if (ids.has(value)) {
      return proxies.get(value) ?? value
    }
    if (!isPlain(value) && !Array.isArray(value) && !rec.traceInstances.has(value)) {
      // class instances (ObjectId, Date, ...): identity tracked, not proxied
      ids.set(value, targets.push(value) - 1)
      return value
    }
    const id = targets.push(value) - 1
    ids.set(value, id)
    const proxy = new Proxy(value as Any, {
      defineProperty(t, k, d) {
        log('define', t, k)
        return Reflect.defineProperty(t, k, d)
      },
      deleteProperty(t, k) {
        log('delete', t, k)
        return Reflect.deleteProperty(t, k)
      },
      get(t, k, r) {
        log('get', t, k)
        const desc = Object.getOwnPropertyDescriptor(t, k)
        const v = Reflect.get(t, k, r)
        // proxy invariant: non-configurable, non-writable data properties must answer themselves
        if (desc && !desc.configurable && 'value' in desc && !desc.writable) {
          return v
        }
        return wrap(v)
      },
      getOwnPropertyDescriptor(t, k) {
        log('getOwnPropertyDescriptor', t, k)
        return Reflect.getOwnPropertyDescriptor(t, k)
      },
      getPrototypeOf(t) {
        log('getPrototypeOf', t)
        return Reflect.getPrototypeOf(t)
      },
      has(t, k) {
        log('has', t, k)
        return Reflect.has(t, k)
      },
      ownKeys(t) {
        log('ownKeys', t)
        return Reflect.ownKeys(t)
      },
      set(t, k, v, r) {
        log('set', t, k)
        return Reflect.set(t, k, v, r)
      },
    })
    proxies.set(value, proxy)
    ids.set(proxy, id)
    return proxy
  }
  return rec
}

/** Objects the canonical form names instead of walking (payload, adapter, config, models). */
export const opaqueObjects = new WeakMap<object, string>()

/** The identity of a generated (non-input) object or function within the run. */
const generatedID = (
  rec: Recorder | undefined,
  value: object,
  local: Map<object, number>,
): number => {
  if (!rec) {
    let id = local.get(value)
    if (id === undefined) {
      id = local.size
      local.set(value, id)
    }
    return id
  }
  let id = rec.generatedIDs.get(value)
  if (id === undefined) {
    id = rec.nextGeneratedID()
    rec.generatedIDs.set(value, id)
  }
  return id
}

/** Flags of a property descriptor that differ from a plain data property (`wec`). */
const flagsOf = (desc: PropertyDescriptor): string => {
  const f = `${'value' in desc && !desc.writable ? '-w' : ''}${desc.enumerable ? '' : '-e'}${desc.configurable ? '' : '-c'}`
  return f
}

/**
 * Canonical form of a value: input nodes become `{ $input: id }` (identity of what the code passed
 * through), generated objects carry `$id` (identity across the events of the run; cycles inside
 * one value become `{ $ref: id }`), class instances carry their class (ObjectId class identity
 * against `Types.ObjectId`), prototypes their identity, plain objects keep key order, own
 * `undefined`s and descriptor flags, arrays their extra / symbol / non-enumerable properties and
 * `length` writability, functions their metadata.
 */
export const canonical = (
  value: unknown,
  rec: Recorder | undefined,
  classes: Record<string, unknown>,
  seen = new Map<object, number>(),
  descendInputs = false,
): unknown => {
  if (value === undefined) {
    return { $undefined: true }
  }
  if (typeof value === 'number') {
    return Number.isNaN(value) ? { $num: 'NaN' } : Object.is(value, -0) ? { $num: '-0' } : value
  }
  if (typeof value === 'bigint') {
    return { $bigint: String(value) }
  }
  if (typeof value === 'symbol') {
    return { $symbol: value.description }
  }
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return value
  }
  if (rec && !descendInputs && rec.ids.has(value)) {
    return { $input: rec.ids.get(value) }
  }
  if (opaqueObjects.has(value)) {
    return { $opaque: opaqueObjects.get(value) }
  }
  if (seen.has(value)) {
    return { $ref: seen.get(value) }
  }
  const $id = generatedID(descendInputs ? undefined : rec, value, seen)
  seen.set(value, $id)
  const v = value as Any
  if (typeof v === 'function') {
    const own = Reflect.ownKeys(v).filter(
      (k) => k !== 'length' && k !== 'name' && k !== 'prototype',
    )
    return {
      $fn: v.name,
      $id,
      ctor: isConstructor(v),
      kind: Object.getPrototypeOf(v)?.constructor?.name ?? null,
      length: v.length,
      own: own.map(describeKey),
      prototype: Object.prototype.hasOwnProperty.call(v, 'prototype'),
    }
  }
  for (const [name, cls] of Object.entries(classes)) {
    if (v instanceof (cls as Any)) {
      if (name === 'ObjectId') {
        return { $class: name, $id, hex: v.toHexString() }
      }
      if (name === 'Date') {
        const t = v.getTime()
        return { $class: name, $id, t: Number.isNaN(t) ? 'Invalid' : t }
      }
      return { $class: name, $id, own: Object.keys(v), s: String(v) }
    }
  }
  const proto = Object.getPrototypeOf(v)
  const protoInfo =
    proto === null ? null : { id: protoID(proto), name: proto.constructor?.name ?? '?' }
  const props = (skip: (k: PropertyKey) => boolean) => {
    const entries: unknown[] = []
    for (const key of Reflect.ownKeys(v)) {
      if (skip(key)) {
        continue
      }
      const desc = Object.getOwnPropertyDescriptor(v, key)!
      const value =
        'value' in desc
          ? canonical(desc.value, rec, classes, seen, false)
          : {
              $accessor: {
                get: canonical(desc.get, rec, classes, seen, false),
                set: canonical(desc.set, rec, classes, seen, false),
              },
            }
      const flags = flagsOf(desc)
      entries.push(flags ? [describeKey(key), value, flags] : [describeKey(key), value])
    }
    return entries
  }
  if (Array.isArray(v)) {
    const items: unknown[] = []
    for (let i = 0; i < v.length; i++) {
      const desc = Object.getOwnPropertyDescriptor(v, i)
      items.push(
        !desc
          ? { $hole: true }
          : 'value' in desc && !flagsOf(desc)
            ? canonical(desc.value, rec, classes, seen, false)
            : { $index: props((k) => k !== String(i))[0] },
      )
    }
    const extra = props(
      (k) => k === 'length' || (typeof k === 'string' && /^\d+$/.test(k) && Number(k) < v.length),
    )
    const lengthWritable = Object.getOwnPropertyDescriptor(v, 'length')!.writable
    const arrayProto = proto === Array.prototype ? undefined : protoInfo
    return {
      $array: items,
      $id,
      ...(extra.length ? { extra } : {}),
      ...(lengthWritable ? {} : { lengthWritable }),
      ...(arrayProto === undefined ? {} : { proto: arrayProto }),
      ...(Object.isExtensible(v)
        ? {}
        : { $frozen: Object.isFrozen(v), $sealed: Object.isSealed(v) }),
    }
  }
  return {
    $id,
    $object: props(() => false),
    ...(proto === Object.prototype ? {} : { proto: protoInfo }),
    ...(Object.isExtensible(v) ? {} : { $frozen: Object.isFrozen(v), $sealed: Object.isSealed(v) }),
  }
}

/** The input graph as it is now (raw targets, no traps). */
export const canonicalInputs = (rec: Recorder, classes: Record<string, unknown>): unknown =>
  rec.targets.map((t) => canonical(t, rec, classes, new Map(), true))

/**
 * Server-clock fields of driver errors (`MongoServerError`): the cluster time of the reply differs
 * between any two server calls, so they are compared by presence only.
 */
const SERVER_CLOCK_KEYS = new Set<PropertyKey>(['$clusterTime', 'clusterTime', 'operationTime'])

/** A copy of plain objects with the server-clock fields replaced by a marker (other values kept). */
const withoutServerClock = (v: unknown, depth = 0): unknown => {
  if (!isPlain(v) || depth > 8) {
    return v
  }
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v)) {
    out[k] = SERVER_CLOCK_KEYS.has(k) ? '$serverClock' : withoutServerClock(v[k], depth + 1)
  }
  return out
}

export const errorInfo = (
  e: unknown,
  rec: Recorder,
  thrownMarkers: unknown[],
  classes: Record<string, unknown> = {},
): unknown => {
  if (e && (typeof e === 'object' || typeof e === 'function')) {
    const marker = thrownMarkers.indexOf(e)
    if (marker !== -1) {
      return { thrownMarker: marker }
    }
    if (rec.ids.has(e)) {
      return { thrownInput: rec.ids.get(e) }
    }
    if (rec.modelThrown.has(e)) {
      return { thrownByModel: rec.modelThrown.get(e) }
    }
    const err = e as Any
    const proto = Object.getPrototypeOf(err)
    const own = Reflect.ownKeys(err).filter((k) => k !== 'stack' && k !== 'message')
    const ownValues: unknown[] = []
    for (const k of own) {
      const desc = Object.getOwnPropertyDescriptor(err, k)!
      ownValues.push([
        describeKey(k),
        SERVER_CLOCK_KEYS.has(k)
          ? { $serverClock: true }
          : 'value' in desc
            ? canonical(withoutServerClock(desc.value), undefined, classes)
            : { $accessor: true },
      ])
    }
    return {
      apiError: e instanceof APIError,
      ctor: err.constructor?.name,
      message: String(err.message),
      name: err.name,
      own: ownValues,
      proto: proto === null ? null : protoID(proto),
      status: err.status,
    }
  }
  return { thrownPrimitive: typeof e, value: canonical(e, undefined, classes) }
}

// ---------------------------------------------------------------------------------------------
// model spies

type ModelEntry = { label: string; model: Any }

export const modelsOf = (payload: Payload): ModelEntry[] => {
  const db = payload.db as Any
  const out: ModelEntry[] = []
  for (const [slug, model] of Object.entries(db.collections ?? {})) {
    out.push({ label: `collections.${slug}`, model })
  }
  for (const [slug, model] of Object.entries(db.versions ?? {})) {
    out.push({ label: `versions.${slug}`, model })
  }
  if (db.globals) {
    out.push({ label: 'globals', model: db.globals })
  }
  return out
}

/**
 * The `Model.buildQuery` static of each model as the Rust `getBuildQueryPlugin` builds it (the
 * same closure arguments db-mongodb's init.ts / buildCollectionSchema.ts / buildGlobalModel.ts pass).
 */
export const rustBuildQueryStatics = (
  payload: Payload,
  getBuildQueryPlugin: (args?: Any) => (schema: Any) => void,
): Map<Any, unknown> => {
  const db = payload.db as Any
  const statics = new Map<Any, unknown>()
  const make = (args?: Any) => {
    const schema = { statics: {} as Any }
    getBuildQueryPlugin(args)(schema)
    return schema.statics.buildQuery
  }
  for (const collection of payload.config.collections) {
    if (db.collections[collection.slug]) {
      statics.set(db.collections[collection.slug], make({ collectionSlug: collection.slug }))
    }
    if (collection.versions && db.versions[collection.slug]) {
      statics.set(
        db.versions[collection.slug],
        make({
          collectionSlug: collection.slug,
          versionsFields: buildVersionCollectionFields(payload.config, collection, true),
        }),
      )
    }
  }
  for (const global of payload.config.globals) {
    if (global.versions && db.versions[global.slug]) {
      statics.set(
        db.versions[global.slug],
        make({ versionsFields: buildVersionGlobalFields(payload.config, global, true) }),
      )
    }
  }
  if (db.globals) {
    statics.set(db.globals, make())
  }
  return statics
}

/**
 * Installs recording spies on every model (own statics shadowing the schema statics), optionally
 * replacing `buildQuery` by the given implementations. Returns the uninstaller.
 */
export const spyModels = (
  payload: Payload,
  rec: Recorder,
  classes: Record<string, unknown>,
  buildQueryStatics?: Map<Any, unknown>,
): (() => void) => {
  const restore: (() => void)[] = []
  for (const { label, model } of modelsOf(payload)) {
    for (const method of ['find', 'distinct', 'buildQuery']) {
      const had = Object.prototype.hasOwnProperty.call(model, method)
      const previous = model[method]
      const original =
        // a user override (anything but the schema's static, which mongoose copies onto the
        // model) stays what both sides call
        method === 'buildQuery' &&
        previous === model.schema?.statics?.buildQuery &&
        buildQueryStatics?.has(model)
          ? buildQueryStatics.get(model)
          : previous
      // a Proxy keeps the original's name / length / prototype / constructibility
      model[method] = new Proxy(original as Any, {
        apply(target, thisArg, args) {
          rec.events.push({
            args: args.map((a: unknown) => canonical(a, rec, classes)),
            ev: 'call',
            method,
            model: label,
            this: thisArg === model,
            tick: rec.tick(),
          })
          let result: unknown
          try {
            result = Reflect.apply(target, thisArg, args)
          } catch (e) {
            if (e && typeof e === 'object' && !rec.modelThrown.has(e)) {
              rec.modelThrown.set(e, rec.events.length)
            }
            rec.events.push({ ev: 'callThrew', tick: rec.tick() })
            throw e
          }
          if (method === 'buildQuery') {
            return result
          }
          return trackQuery(result, rec, classes)
        },
      })
      restore.push(() => {
        if (had) {
          model[method] = previous
        } else {
          delete model[method]
        }
      })
    }
  }
  return () => restore.reverse().forEach((r) => r())
}

const trackQuery = (query: Any, rec: Recorder, classes: Record<string, unknown>) => {
  if (!query || typeof query.then !== 'function') {
    return query
  }
  for (const name of ['lean', 'select']) {
    const original = query[name]
    query[name] = new Proxy(original, {
      apply(target, thisArg, args) {
        rec.events.push({
          args: args.map((a: unknown) => canonical(a, rec, classes)),
          ev: 'chain',
          name,
          tick: rec.tick(),
        })
        return Reflect.apply(target, thisArg, args)
      },
    })
  }
  const then = query.then
  query.then = new Proxy(then, {
    apply(
      target,
      thisArg,
      [resolve, reject]: [((v: unknown) => unknown)?, ((e: unknown) => unknown)?],
    ) {
      return thenTracked(target, thisArg, resolve, reject)
    },
  })
  const thenTracked = (
    then: Any,
    self: Any,
    resolve?: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => {
    rec.events.push({ ev: 'then', tick: rec.tick() })
    // I/O results are delivered in the order the queries were started, all at one macrotask once
    // every started query has its result (concurrent queries may complete in any order and at any
    // time; the comparison must not depend on the server)
    const index = rec.io.started++
    const gate = (run: () => unknown) =>
      new Promise((res, rej) => {
        rec.io.ready.set(index, () => {
          try {
            res(run())
          } catch (e) {
            rej(e)
          }
        })
        flushIO(rec)
      })
    return then.call(
      self,
      (value: unknown) =>
        gate(() => {
          rec.restartClock()
          const wrapped = rec.wrap(value)
          rec.events.push({ ev: 'io', result: canonical(value, undefined, classes) })
          return resolve ? resolve(wrapped) : wrapped
        }),
      (e: unknown) =>
        gate(() => {
          rec.restartClock()
          rec.events.push({ ev: 'ioError', message: String((e as Any)?.message) })
          if (reject) {
            return reject(e)
          }
          throw e
        }),
    )
  }
  return query
}

/** Delivers the arrived I/O results in start order once every started query has one. */
const flushIO = (rec: Recorder) => {
  const io = rec.io
  if (io.scheduled || io.ready.size !== io.started - io.delivered) {
    return
  }
  io.scheduled = true
  setImmediate(() => {
    io.scheduled = false
    while (io.ready.has(io.delivered)) {
      const run = io.ready.get(io.delivered)!
      io.ready.delete(io.delivered)
      io.delivered++
      run()
    }
  })
}

// ---------------------------------------------------------------------------------------------
// one side of one case

export type CaseRun = {
  error?: unknown
  events: unknown[]
  inputsAfter: unknown
  /** the inputs after the call, fully expanded (no input identities) */
  inputsRaw: unknown
  result?: unknown
}

/**
 * Runs `invoke(inputs)` on a fresh traced clone of `inputs`. `invoke` may return a promise; its
 * settlement is stamped with the microtask clock.
 */
export const runSide = async ({
  classes,
  inputs,
  invoke,
  modelSpies,
  thrownMarkers = [],
  traceInstances,
}: {
  classes: Record<string, unknown>
  /** the inputs (cloned for this side) or a factory building them for this side */
  inputs: (() => unknown[]) | unknown[]
  invoke: (inputs: unknown[], rec: Recorder) => unknown
  modelSpies: (rec: Recorder) => () => void
  thrownMarkers?: unknown[]
  traceInstances?: object[]
}): Promise<CaseRun> => {
  const rec = createRecorder(traceInstances)
  const cloned = (typeof inputs === 'function' ? inputs() : cloneLive(inputs)) as unknown[]
  const traced = cloned.map((v) => rec.wrap(v))
  const unspy = modelSpies(rec)
  let result: unknown
  let error: unknown
  let failed = false
  try {
    rec.restartClock()
    let returned: unknown
    try {
      returned = invoke(traced, rec)
    } catch (e) {
      rec.events.push({ ev: 'syncThrow', tick: rec.tick() })
      throw e
    }
    if (returned && typeof (returned as Any).then === 'function') {
      rec.events.push({ ev: 'returnedPromise', tick: rec.tick() })
      result = await (returned as Promise<unknown>).then(
        (v) => {
          rec.events.push({ ev: 'settled', tick: rec.tick() })
          return v
        },
        (e) => {
          rec.events.push({ ev: 'rejected', tick: rec.tick() })
          throw e
        },
      )
    } else {
      result = returned
    }
  } catch (e) {
    failed = true
    error = e
  } finally {
    rec.stop()
    unspy()
  }
  rec.tracing = false
  return {
    events: rec.events,
    inputsAfter: canonicalInputs(rec, classes),
    inputsRaw: canonical(cloned, undefined, classes),
    ...(failed
      ? { error: errorInfo(error, rec, thrownMarkers, classes) }
      : { result: canonical(result, rec, classes) }),
  }
}

/** Core runtime entries + tasks (the Rust engine ran iff it moved). */
export const engineCounter = (): number => {
  const { entries, tasks } = getCoreRuntime().stats()
  return entries + tasks
}

export type Comparison = {
  compared: number
  diffs: { id: string; kind: string; rs: unknown; ts: unknown }[]
}

/** A short printable form of a run (events tail, result / error), without the input graphs. */
export const summarize = (run: CaseRun, diff: string): string => {
  const m = /^\.events\.(\d+)/.exec(diff)
  const at = m ? Number(m[1]) : run.events.length
  return JSON.stringify({
    error: run.error,
    events: run.events.slice(Math.max(0, at - 4), at + 4),
    result: run.result,
  }).slice(0, 2500)
}

export const firstDiff = (a: unknown, b: unknown, path = ''): string | undefined => {
  if (JSON.stringify(a) === JSON.stringify(b)) {
    return undefined
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])]
    for (const k of keys) {
      const d = firstDiff((a as Any)[k], (b as Any)[k], `${path}.${k}`)
      if (d) {
        return d
      }
    }
    return `${path}: key order ${JSON.stringify(Object.keys(a as object))} vs ${JSON.stringify(Object.keys(b as object))}`
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 300)} vs ${JSON.stringify(b)?.slice(0, 300)}`
}

/**
 * Runs one case on both sides and compares everything. Throws if the TS side entered the Rust
 * engine or the Rust side did not.
 */
export const compareCase = async ({
  classes,
  comparison,
  engineOptional = false,
  id,
  inputs,
  rs,
  rsSpies,
  thrownMarkers,
  traceInstances,
  ts,
  tsEntersEngine = false,
  tsSpies,
}: {
  classes: Record<string, unknown>
  comparison: Comparison
  /**
   * The Rust side may legitimately stay in JS (e.g. `Model.buildQuery` statics, upstream's JS
   * functions, throwing before they reach the Rust `parseParams`); the caller asserts the
   * outcome kind instead.
   */
  engineOptional?: boolean
  id: string
  inputs: (() => unknown[]) | unknown[]
  rs: (inputs: unknown[], rec: Recorder) => unknown
  rsSpies: (rec: Recorder) => () => void
  thrownMarkers?: unknown[]
  traceInstances?: object[]
  ts: (inputs: unknown[], rec: Recorder) => unknown
  /** the "TS" side deliberately mixes in Rust calls (mixed-adapter cases) */
  tsEntersEngine?: boolean
  tsSpies: (rec: Recorder) => () => void
}): Promise<{ rs: CaseRun; rsEntered: boolean; ts: CaseRun }> => {
  const before = engineCounter()
  const tsRun = await runSide({
    classes,
    inputs,
    invoke: ts,
    modelSpies: tsSpies,
    thrownMarkers,
    traceInstances,
  })
  const afterTS = engineCounter()
  if (afterTS !== before && !tsEntersEngine) {
    throw new Error(`${id}: the TS reference entered the Rust engine (${afterTS - before} entries)`)
  }
  const rsRun = await runSide({
    classes,
    inputs,
    invoke: rs,
    modelSpies: rsSpies,
    thrownMarkers,
    traceInstances,
  })
  const rsEntered = engineCounter() !== afterTS
  if (!rsEntered && !engineOptional) {
    throw new Error(`${id}: the Rust run never entered the Rust engine`)
  }
  comparison.compared++
  const d = firstDiff(tsRun, rsRun)
  if (d) {
    comparison.diffs.push({ id, kind: d, rs: rsRun, ts: tsRun })
  }
  return { rs: rsRun, rsEntered, ts: tsRun }
}
