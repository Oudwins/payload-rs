/**
 * Live differential of the db-mongodb write methods: upstream TS (`payload.db.<method>`, the
 * functions of packages/db-mongodb/src) vs the live Rust port (crates/payload-mongo-live-write) on
 * the same live inputs, against the same database state.
 *
 * Every run records, in one ordered event log:
 * - every trap on the recorded objects (method args, `data`, `where`, `req`, ... and every plain
 *   object, null-prototype object, array and ordinary class instance nested in them: get (symbol
 *   keys included) / set / has / deleteProperty / ownKeys / getOwnPropertyDescriptor /
 *   defineProperty),
 * - every property read on the adapter (`this`) through the adapter view (symbol keys included),
 * - every mongoose model call (collections, versions, globals: method, `this`, args) and, observed
 *   without touching the returned value (V8 promise hooks), the settlement of the promise it
 *   returned or of the promise `exec()` created for the Query it returned; the settled state and
 *   value are read afterwards through the inspector (internal slots: no `then`, no getters),
 * - every `Date` constructed / called outside node_modules (the clock; args included),
 * - scenario events (`env.log`), the method calls' own promises settling, the outcome.
 * Each event carries the number of microtask ticks since the previous event of the same
 * microtask burst and whether the microtask queue went quiescent in between (see `Recorder.step`).
 *
 * Recording observes: model results, queries and their promises reach the adapter unchanged (no
 * wrapping, no `then` rewriting, no forced delivery order); snapshots read property descriptors and
 * internal slots only (no getters, no proxy traps, no `constructor` reads).
 *
 * After the outcome the run continues until explicit quiescence (every tracked promise settled, no
 * driver connection checked out, microtask queue empty), then the final state of every recorded
 * root, the outcome and the contents of every collection (raw driver) complete the record.
 * ObjectIds generated in this process or by the server (their 5 process-unique bytes) are
 * canonicalized by first appearance, BSON Timestamps (server cluster time) masked; every other
 * value is kept absolute. TS and Rust records must be identical.
 *
 * Guards: a TS run must not enter the addon at all (core runtime `entries`), the Rust run must be
 * served by the live write binding (its per-method stats grow), the reference methods must be the
 * upstream functions, every scenario's landmarks (model calls / events it exists for) must be in
 * the record, and its outcome kind / error class must be the declared one.
 */
import type { Payload } from 'payload'

import { writeFileSync } from 'node:fs'
import inspector from 'node:inspector'
import path from 'node:path'
import { types as utilTypes } from 'node:util'
import v8 from 'node:v8'

import { getCoreRuntime } from '../../../packages/engine-rs/src/runtime/index.js'
import { resolveDbMongodbMongoose } from '../../../packages/engine-rs/src/mongo-live/host.js'
import { getMongoLiveWrite, type LiveWriteMethod, liveWriteMethods } from './glue.js'

const mongoose = resolveDbMongodbMongoose() as any

export type RunKind = 'mutant' | 'rs' | 'ts'

export type Env = {
  /** The adapter as the method's `this` (records reads; `overrides` replace values). */
  adapter: any
  /** Calls `adapter[method](args)` through the view (the returned promise is tracked). */
  call: (method: LiveWriteMethod, args: unknown) => Promise<unknown>
  /** Value to compare in addition to the outcome (snapshotted at quiescence). */
  extra: Record<string, unknown>
  /** Cleanup run after the snapshot (restores model swaps, globals, ends sessions). */
  finally: (fn: () => Promise<void> | void) => void
  /** Remember an error object the scenario throws, to check the identity of what comes out. */
  inject: <T>(error: T) => T
  kind: RunKind
  log: (...event: unknown[]) => void
  /** Model behaviours for this run: `(label, method) => (original, args, self) => result`. */
  modelBehaviour: (
    label: string,
    method: string,
    behaviour: (original: (...a: any[]) => any, args: any[], self: any) => any,
  ) => void
  payload: Payload
  raw: any
  /** Wraps `value` (and what is nested in it) in recording proxies labelled `label`. */
  rec: <T>(label: string, value: T) => T
}

/**
 * What a scenario is for: its TS outcome kind, the error class (constructor name) when it
 * rejects, and landmarks that must appear in the record (`eventKey` of some event), e.g.
 * `model @posts.create` (`@<slug>` = the collection's model, `@v:<slug>` = its versions model,
 * `@globals` = the globals model), `settled @posts.create fulfilled`, `log <first arg>`,
 * `exec @posts.findOneAndUpdate`, `set data._id`, `delete data.log`.
 */
export type Expectation = {
  /** landmarks that must NOT appear (the branch the scenario exists for skips them) */
  absent?: string[]
  error?: string
  outcome: 'error' | 'ok'
  reach: string[]
}

export type Scenario = {
  expect: Expectation
  /**
   * A divergence owned by another crate (review item, owner): the spec reports whether TS and
   * Rust still differ instead of asserting parity (it is not counted as a parity case).
   */
  knownDivergence?: string
  name: string
  /** Adapter properties the view reports instead of the real ones (e.g. `allowIDOnCreate`). */
  overrides?: Record<string, unknown>
  /** Performs the call(s); the resolved value / rejection is the outcome. */
  run: (env: Env) => Promise<unknown>
}

const RealDate = Date
const realGetTime = RealDate.prototype.getTime
const realToISOString = RealDate.prototype.toISOString
const realQueueMicrotask = queueMicrotask
const realSetImmediate = setImmediate
const realSetTimeout = setTimeout
const realNow = RealDate.now
const CLOCK_BASE = RealDate.UTC(2030, 0, 1)
const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype)
const typedArrayGetter = (name: string) =>
  Object.getOwnPropertyDescriptor(typedArrayProto, name)!.get!
const getBuffer = typedArrayGetter('buffer')
const getByteOffset = typedArrayGetter('byteOffset')
const getByteLength = typedArrayGetter('byteLength')
const ObjectIdClass = mongoose.Types.ObjectId
const objectIdToHex = ObjectIdClass.prototype.toHexString
const DocumentProto = mongoose.Document.prototype
const QueryProto = mongoose.Query.prototype
const realExec = QueryProto.exec
const ClientSessionProto = mongoose.mongo.ClientSession.prototype
const TimestampProto = mongoose.mongo.BSON.Timestamp.prototype

const MODEL_METHODS = [
  'create',
  'deleteMany',
  'deleteOne',
  'find',
  'findOneAndDelete',
  'findOneAndUpdate',
  'updateMany',
  'updateOne',
] as const

/** Whether `proto` is on the prototype chain of `o` (no traps: `o` is not a proxy). */
const inherits = (o: object, proto: object) => {
  let p = Object.getPrototypeOf(o)
  while (p !== null) {
    if (p === proto) {
      return true
    }
    if (utilTypes.isProxy(p)) {
      return false
    }
    p = Object.getPrototypeOf(p)
  }
  return false
}

/** Own data property value, or undefined (no getters). */
const ownData = (o: object, key: PropertyKey) => {
  if (utilTypes.isProxy(o)) {
    return undefined
  }
  const d = Reflect.getOwnPropertyDescriptor(o, key)
  return d && 'value' in d ? d.value : undefined
}

const functionName = (f: unknown) => {
  const name = typeof f === 'function' ? ownData(f, 'name') : undefined
  return typeof name === 'string' ? name : '?'
}

/** Built-ins whose methods need their internal slots: never proxied by `rec`. */
const isSlotted = (v: object) =>
  utilTypes.isDate(v) ||
  utilTypes.isRegExp(v) ||
  utilTypes.isMap(v) ||
  utilTypes.isSet(v) ||
  utilTypes.isWeakMap(v) ||
  utilTypes.isWeakSet(v) ||
  utilTypes.isPromise(v) ||
  utilTypes.isArrayBufferView(v) ||
  utilTypes.isAnyArrayBuffer(v) ||
  utilTypes.isBoxedPrimitive(v) ||
  utilTypes.isNativeError(v) ||
  utilTypes.isProxy(v)

const isLibraryValue = (v: object) =>
  inherits(v, ObjectIdClass.prototype) ||
  inherits(v, DocumentProto) ||
  inherits(v, QueryProto) ||
  inherits(v, ClientSessionProto) ||
  typeof ownData(v, '_bsontype') === 'string' ||
  typeof ownData(Object.getPrototypeOf(v) ?? {}, '_bsontype') === 'string'

/** The 5 process-unique bytes of ObjectIds generated by this process's bson builds (hex). */
const processMarkers = (() => {
  const markers = new Set<string>()
  const add = (ctor: any) => {
    try {
      markers.add(objectIdToHex.call(new ctor()).slice(8, 18))
    } catch {
      // not an ObjectId class
    }
  }
  add(ObjectIdClass)
  add(mongoose.mongo.BSON.ObjectId)
  return markers
})()

/**
 * Adds the 5 process-unique bytes of the ObjectIds the MongoDB server generates (upserted `_id`s)
 * to the canonicalized markers (once per process: an upsert into a scratch collection).
 */
let isServerMarkerKnown = false
const learnServerMarker = async (raw: any) => {
  if (isServerMarkerKnown) {
    return
  }
  const scratch = raw.connection.db.collection('lw_server_marker')
  const result = await scratch.updateOne(
    { probe: true },
    { $set: { probe: true } },
    { upsert: true },
  )
  processMarkers.add(objectIdToHex.call(result.upsertedId).slice(8, 18))
  await scratch.drop()
  isServerMarkerKnown = true
}

const inspectorSession = (() => {
  const s = new inspector.Session()
  s.connect()
  return s
})()

/** [[PromiseState]] / [[PromiseResult]] of a native promise (inspector: no JS-visible operation). */
const promiseDetails = (p: Promise<unknown>): { state: string; value: unknown } => {
  ;(globalThis as any).__lwProbe = p
  let objectId: string | undefined
  let internal: any[] = []
  inspectorSession.post(
    'Runtime.evaluate',
    { expression: 'globalThis.__lwProbe' },
    (_e, r: any) => {
      objectId = r?.result?.objectId
    },
  )
  inspectorSession.post(
    'Runtime.getProperties',
    { objectId, ownProperties: true },
    (_e, r: any) => {
      internal = r?.internalProperties ?? []
    },
  )
  delete (globalThis as any).__lwProbe
  const state = internal.find((x) => x.name === '[[PromiseState]]')?.value?.value ?? '?'
  const result = internal.find((x) => x.name === '[[PromiseResult]]')?.value
  let value: unknown
  if (result?.objectId) {
    inspectorSession.post(
      'Runtime.callFunctionOn',
      {
        functionDeclaration: "function () { 'use strict'; globalThis.__lwOut = this }",
        objectId: result.objectId,
      },
      () => {
        value = (globalThis as any).__lwOut
        delete (globalThis as any).__lwOut
      },
    )
  } else if (result?.type === 'undefined') {
    value = undefined
  } else if (result?.unserializableValue !== undefined) {
    const u = result.unserializableValue as string
    value = u.endsWith('n') ? BigInt(u.slice(0, -1)) : Number(u)
  } else {
    value = result?.value
  }
  return { state, value }
}

/** One run's recorder. */
class Recorder {
  active = false
  /** whether a quiescence point happened since the last event */
  boundary = false
  /** `ticks` at the last quiescence point */
  burstStart = 0
  chainRunning = false
  events: unknown[][] = []
  ids = new WeakMap<object, number>()
  injected: unknown[] = []
  /** promise jobs run since the last chain step */
  jobs = 0
  /** proxy -> label */
  labels = new WeakMap<object, string>()
  lastTicks = 0
  loggedSinceStep = false
  nextId = 0
  /** infrastructure objects described by name only (payload, adapter, models, connection) */
  opaque = new WeakMap<object, string>()
  /** settle events whose state / value are read at quiescence */
  pendingSettles: { event: unknown[]; promise: Promise<unknown> }[] = []
  /** target -> proxy (stable identity per target) */
  proxies = new WeakMap<object, object>()
  /** top-level recorded values (final snapshot) */
  roots: [string, object][] = []
  session: unknown = undefined
  /** settled tracked promises */
  settledCount = 0
  symbolIds = new Map<symbol, number>()
  /** proxy -> target */
  targets = new WeakMap<object, object>()
  ticks = 0
  /** promises whose settlement is logged (model results, query exec promises, method calls) */
  tracked = new WeakMap<object, string>()
  trackedCount = 0
  tracing = false

  /**
   * A JSON-able, lossless-enough snapshot of `v`: property descriptors (with their flags),
   * prototype identity, function / symbol identity, internal slots. Never runs a getter, a proxy
   * trap or user code (user proxies are described by identity only).
   */
  describe(v: unknown, stack: object[] = []): unknown {
    switch (typeof v) {
      case 'bigint':
        return { bigint: String(v) }
      case 'boolean':
      case 'string':
        return v
      case 'number':
        return Number.isFinite(v) && !Object.is(v, -0)
          ? v
          : { num: Object.is(v, -0) ? '-0' : String(v) }
      case 'symbol':
        return { symbol: String(v.description), sid: this.symbolId(v) }
      case 'undefined':
        return { undefined: true }
    }
    if (v === null) {
      return null
    }
    let o = v as object
    if (v === this.session) {
      return { session: 'SESSION' }
    }
    const label = this.labels.get(o)
    const target = this.targets.get(o)
    if (target) {
      o = target
    }
    if (stack.includes(o)) {
      return { cycle: label ?? this.idOf(o) }
    }
    const id = this.idOf(o)
    const injected = this.injected.indexOf(v)
    if (injected !== -1) {
      return { id, injected }
    }
    const opaque = this.opaque.get(o)
    if (opaque) {
      return { id, opaque }
    }
    if (typeof o === 'function') {
      return { fn: functionName(o), id }
    }
    if (utilTypes.isProxy(o)) {
      return { id, proxy: true }
    }
    if (utilTypes.isDate(o)) {
      const t = realGetTime.call(o)
      return { date: Number.isNaN(t) ? 'Invalid' : realToISOString.call(o), id }
    }
    if (utilTypes.isPromise(o)) {
      return { id, promise: true }
    }
    if (inherits(o, ObjectIdClass.prototype)) {
      return { id, oid: objectIdToHex.call(o) }
    }
    if (inherits(o, TimestampProto)) {
      // BSON Timestamps only come from the server's clock here ($clusterTime / operationTime of
      // driver errors and results): masked, they differ between any two runs
      return { id, timestamp: 'server' }
    }
    if (inherits(o, ClientSessionProto)) {
      return { clientSession: true, id }
    }
    if (inherits(o, DocumentProto)) {
      // hydrated mongoose document: model and identity (its state is mongoose's)
      const ctor = ownData(Object.getPrototypeOf(o), 'constructor')
      return { id, mdoc: ctor ? ownData(ctor, 'modelName') : '?' }
    }
    if (inherits(o, QueryProto)) {
      return { id, query: ownData(o, 'op') }
    }
    if (utilTypes.isArrayBufferView(o)) {
      return {
        bytes: Buffer.from(
          getBuffer.call(o),
          getByteOffset.call(o),
          getByteLength.call(o),
        ).toString('base64'),
        id,
        proto: this.protoOf(o),
      }
    }
    if (stack.length > 24) {
      return { deep: true, id }
    }
    const next = [...stack, o]
    // bookkeeping objects are written with define semantics: setters a scenario installs on
    // Object.prototype (e.g. `session`) must not run inside the recorder
    const props: Record<string, unknown> = Object.create(null)
    for (const key of Reflect.ownKeys(o)) {
      const d = Reflect.getOwnPropertyDescriptor(o, key)!
      const flags = `${d.enumerable ? 'e' : '-'}${d.configurable ? 'c' : '-'}${'value' in d ? (d.writable ? 'w' : '-') : 'a'}`
      const k = typeof key === 'symbol' ? `@@${String(key.description)}#${this.symbolId(key)}` : key
      if (key === 'stack' && utilTypes.isNativeError(o)) {
        // stack text (frames, file names) is not compared: residual of drive.rs / helpers.rs
        props[k] = { f: flags, stack: true }
        continue
      }
      props[k] =
        'value' in d
          ? flags === 'ecw'
            ? this.describe(d.value, next)
            : { f: flags, v: this.describe(d.value, next) }
          : { f: flags, get: this.describe(d.get, next), set: this.describe(d.set, next) }
    }
    return {
      id,
      props,
      proto: this.protoOf(o),
      ...(label ? { label } : {}),
      ...(utilTypes.isNativeError(o) ? { error: true } : {}),
      ...(Array.isArray(o) ? { array: true } : {}),
    }
  }

  idOf(o: object): number {
    let id = this.ids.get(o)
    if (id === undefined) {
      id = this.nextId++
      this.ids.set(o, id)
    }
    return id
  }

  /** Counts microtask ticks while the run is active (see `step`). */
  kick() {
    if (this.chainRunning || !this.active) {
      return
    }
    this.chainRunning = true
    this.loggedSinceStep = true
    realQueueMicrotask(this.step)
  }

  log(...event: unknown[]) {
    if (!this.tracing) {
      return
    }
    this.tracing = false
    let entry: unknown[]
    try {
      entry = [
        this.ticks - Math.max(this.lastTicks, this.burstStart),
        this.boundary ? 'q' : '',
        ...event.map((e) => this.describe(e)),
      ]
      this.events.push(entry)
    } finally {
      this.tracing = true
    }
    this.lastTicks = this.ticks
    this.boundary = false
    this.loggedSinceStep = true
    this.kick()
    return entry
  }

  protoOf(o: object): unknown {
    const p = Object.getPrototypeOf(o)
    if (p === null) {
      return null
    }
    if (p === Object.prototype) {
      return 'Object'
    }
    if (p === Array.prototype) {
      return 'Array'
    }
    if (p === Error.prototype) {
      return 'Error'
    }
    const ctor = utilTypes.isProxy(p) ? undefined : ownData(p, 'constructor')
    return { ctor: functionName(ctor), id: this.idOf(p) }
  }

  rec<T>(label: string, value: T): T {
    // setting up recorded inputs is not part of the run
    const was = this.tracing
    this.tracing = false
    try {
      const out = this.recInner(label, value)
      if (typeof out === 'object' && out !== null) {
        this.roots.push([label, out as object])
      }
      return out
    } finally {
      this.tracing = was
    }
  }

  recInner<T>(label: string, value: T): T {
    if (typeof value !== 'object' || value === null) {
      return value
    }
    if (this.labels.has(value)) {
      // already recorded (keeps its own label)
      return value
    }
    const existing = this.proxies.get(value)
    if (existing) {
      return existing as T
    }
    if (isSlotted(value) || isLibraryValue(value) || this.opaque.has(value)) {
      return value
    }
    for (const key of Reflect.ownKeys(value)) {
      const desc = Reflect.getOwnPropertyDescriptor(value, key)!
      if ('value' in desc && typeof desc.value === 'object' && desc.value !== null) {
        const wrapped = this.recInner(`${label}.${String(key)}`, desc.value)
        if (wrapped !== desc.value) {
          if (desc.writable || desc.configurable) {
            Object.defineProperty(value, key, { ...desc, value: wrapped })
          }
        }
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const recorder = this
    const keyOf = (key: PropertyKey) => (typeof key === 'symbol' ? key : String(key))
    const proxy = new Proxy(value, {
      defineProperty(target, key, desc) {
        recorder.log(
          'defineProperty',
          label,
          keyOf(key),
          'value' in desc ? desc.value : '<accessor>',
          `${desc.enumerable ? 'e' : '-'}${desc.configurable ? 'c' : '-'}${desc.writable ? 'w' : '-'}`,
        )
        return Reflect.defineProperty(target, key, desc)
      },
      deleteProperty(target, key) {
        recorder.log('delete', label, keyOf(key))
        return Reflect.deleteProperty(target, key)
      },
      get(target, key, receiver) {
        const result = Reflect.get(target, key, receiver)
        recorder.log('get', label, keyOf(key), result)
        return result
      },
      getOwnPropertyDescriptor(target, key) {
        recorder.log('getOwnPropertyDescriptor', label, keyOf(key))
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
      getPrototypeOf(target) {
        recorder.log('getPrototypeOf', label)
        return Reflect.getPrototypeOf(target)
      },
      has(target, key) {
        recorder.log('has', label, keyOf(key))
        return Reflect.has(target, key)
      },
      isExtensible(target) {
        recorder.log('isExtensible', label)
        return Reflect.isExtensible(target)
      },
      ownKeys(target) {
        recorder.log('ownKeys', label)
        return Reflect.ownKeys(target)
      },
      preventExtensions(target) {
        recorder.log('preventExtensions', label)
        return Reflect.preventExtensions(target)
      },
      set(target, key, v, receiver) {
        recorder.log('set', label, keyOf(key), v)
        return Reflect.set(target, key, v, receiver)
      },
      setPrototypeOf(target, proto) {
        recorder.log('setPrototypeOf', label, proto)
        return Reflect.setPrototypeOf(target, proto)
      },
    })
    this.proxies.set(value, proxy)
    this.labels.set(proxy, label)
    this.targets.set(proxy, value)
    return proxy as T
  }

  /**
   * One tick of the counting chain. The chain runs while the run is active and there is other
   * microtask work: if no promise job (promise hooks) ran and nothing was logged since the previous
   * step, the queue held only this chain, so the microtask queue is quiescent: the chain stops
   * (I/O can proceed) and the next event reports `q`. Any promise job while it is stopped restarts
   * it. So an event's tick count is exact within its burst, without a cap.
   */
  step = () => {
    this.ticks++
    if (!this.active) {
      this.chainRunning = false
      return
    }
    if (this.jobs === 0 && !this.loggedSinceStep) {
      this.chainRunning = false
      this.burstStart = this.ticks
      this.boundary = true
      return
    }
    this.jobs = 0
    this.loggedSinceStep = false
    realQueueMicrotask(this.step)
  }

  /** Counts promise jobs for `step` (and restarts the chain on the first job of a burst). */
  hookJobs() {
    return v8.promiseHooks.onBefore(() => {
      this.jobs++
      if (!this.chainRunning && this.active) {
        this.kick()
      }
    })
  }

  symbolId(s: symbol): number {
    let id = this.symbolIds.get(s)
    if (id === undefined) {
      id = this.symbolIds.size
      this.symbolIds.set(s, id)
    }
    return id
  }

  track(promise: unknown, label: string) {
    if (!utilTypes.isPromise(promise) || this.tracked.has(promise)) {
      return
    }
    this.tracked.set(promise, label)
    this.trackedCount++
    if (promiseDetails(promise).state !== 'pending') {
      // settled before it was returned (e.g. `Promise.reject(error)`): the hook already ran
      this.settledCount++
      const event = this.log('settled', label)
      if (event) {
        this.pendingSettles.push({ event, promise })
      }
    }
  }
}

/** Whether the code constructing / calling `Date` was written in a node_modules package. */
const calledFromNodeModules = () => {
  const stack = new Error().stack?.split('\n') ?? []
  // [0] "Error", [1] this function, [2] FakeDate, [3] the caller
  const caller = stack
    .slice(3)
    .find((line) => !line.includes('harness.ts') && !/\((<anonymous>|native)\)$/.test(line.trim()))
  return caller?.includes('/node_modules/') ?? false
}

const installClock = (recorder: Recorder) => {
  let reads = 0
  const FakeDate = function (this: unknown, ...args: any[]) {
    const fromNodeModules = calledFromNodeModules()
    if (!new.target) {
      // `Date(...)` called as a function: the current time as a string
      if (fromNodeModules) {
        return RealDate()
      }
      reads++
      recorder.log('clock', 'call', reads, args)
      return new RealDate(CLOCK_BASE + reads * 1000).toString()
    }
    if (fromNodeModules) {
      // driver / mongoose internals (pool monitoring, session bookkeeping, casting): timing
      // dependent or library behaviour, not part of the compared behaviour
      return Reflect.construct(RealDate, args, new.target)
    }
    if (args.length === 0) {
      reads++
      recorder.log('clock', 'new', reads)
      return Reflect.construct(RealDate, [CLOCK_BASE + reads * 1000], new.target)
    }
    recorder.log('clock', 'new', args)
    return Reflect.construct(RealDate, args, new.target)
  } as unknown as DateConstructor
  Object.setPrototypeOf(FakeDate, RealDate)
  Object.defineProperty(FakeDate, 'prototype', { value: RealDate.prototype })
  Object.defineProperty(FakeDate, 'now', {
    configurable: true,
    value: function now() {
      if (calledFromNodeModules()) {
        return realNow()
      }
      reads++
      recorder.log('clock', 'now', reads)
      return CLOCK_BASE + reads * 1000
    },
    writable: true,
  })
  globalThis.Date = FakeDate
  return () => {
    globalThis.Date = RealDate
  }
}

/** Every mongoose model of the adapter, labelled by collection name. */
const modelsOf = (raw: any): [string, any][] => {
  const out: [string, any][] = []
  for (const Model of Object.values(raw.collections)) {
    out.push([(Model as any).collection.name, Model])
  }
  for (const Model of Object.values(raw.versions)) {
    out.push([(Model as any).collection.name, Model])
  }
  out.push([raw.globals.collection.name, raw.globals])
  return out
}

const installModelSpies = (
  raw: any,
  recorder: Recorder,
  behaviours: Map<string, (original: (...a: any[]) => any, args: any[], self: any) => any>,
) => {
  const restore: (() => void)[] = []
  const seen = new Set<any>()
  const queries = new WeakMap<object, string>()
  for (const [label, Model] of modelsOf(raw)) {
    if (seen.has(Model)) {
      continue
    }
    seen.add(Model)
    recorder.opaque.set(Model, `Model ${label}`)
    for (const method of MODEL_METHODS) {
      const hadOwn = Object.prototype.hasOwnProperty.call(Model, method)
      const ownDescriptor = Object.getOwnPropertyDescriptor(Model, method)
      const original = Model[method]
      const what = `${label}.${method}`
      Model[method] = function (this: any, ...args: any[]) {
        recorder.log('model', label, method, this === Model ? 'this=Model' : 'this=?', args)
        const behaviour = behaviours.get(what)
        const result = behaviour ? behaviour(original, args, this) : original.apply(this, args)
        // observe only: the very value goes back to the caller
        if (utilTypes.isPromise(result)) {
          recorder.track(result, what)
        } else if (typeof result === 'object' && result !== null && inherits(result, QueryProto)) {
          queries.set(result, what)
        }
        return result
      }
      restore.push(() => {
        if (hadOwn) {
          Object.defineProperty(Model, method, ownDescriptor!)
        } else {
          delete Model[method]
        }
      })
    }
  }
  // the promise a recorded Query's `exec()` creates (awaiting a Query calls `then` -> `exec`)
  QueryProto.exec = function (this: any, ...args: any[]) {
    const what = queries.get(this)
    if (what) {
      recorder.log('exec', what)
    }
    const p = realExec.apply(this, args)
    if (what) {
      recorder.track(p, `${what}.exec`)
    }
    return p
  }
  restore.push(() => {
    QueryProto.exec = realExec
  })
  return () => restore.forEach((r) => r())
}

/** Fixed database contents every run starts from (raw driver: no model, no spy). */
export const seed = {
  categories: ['64b000000000000000000001', '64b000000000000000000002'],
  posts: ['64b000000000000000000011', '64b000000000000000000012', '64b000000000000000000013'],
  postVersions: [
    '64b000000000000000000021',
    '64b000000000000000000022',
    '64b000000000000000000023',
  ],
  jobs: ['64b000000000000000000031', '64b000000000000000000032', '64b000000000000000000033'],
  globalVersions: ['64b000000000000000000041', '64b000000000000000000042'],
}

const resetDatabase = async (raw: any) => {
  const { ObjectId } = mongoose.Types
  const at = (n: number) => new RealDate(RealDate.UTC(2029, 0, n))
  const db = raw.connection.db
  for (const [name] of modelsOf(raw)) {
    await db.collection(name).deleteMany({})
  }
  const coll = (slug: string) => raw.collections[slug].collection.name
  const versions = (slug: string) => raw.versions[slug].collection.name
  const [c1, c2] = seed.categories.map((h) => new ObjectId(h))
  await db.collection(coll('categories')).insertMany([
    { _id: c1, name: 'one', createdAt: at(1), updatedAt: at(1) },
    { _id: c2, name: 'two', createdAt: at(2), updatedAt: at(2) },
  ])
  await db.collection(coll('posts')).insertMany(
    seed.posts.map((h, i) => ({
      _id: new ObjectId(h),
      title: `post ${i}`,
      slug: { en: `post-${i}`, es: `entrada-${i}` },
      count: i,
      rows: [{ id: `row${i}`, label: `r${i}` }],
      categories: [c1],
      category: i % 2 ? c2 : c1,
      _status: 'published',
      createdAt: at(10 + i),
      updatedAt: at(10 + i),
    })),
  )
  await db.collection(versions('posts')).insertMany(
    seed.postVersions.map((h, i) => ({
      _id: new ObjectId(h),
      parent: new ObjectId(seed.posts[0]),
      version: { title: `post 0 v${i}`, _status: 'draft' },
      latest: i === 2 ? true : undefined,
      createdAt: at(20 + i),
      updatedAt: at(20 + i),
    })),
  )
  await db
    .collection(coll('custom-text'))
    .insertMany([{ _id: 'existing-text', title: 'text one', createdAt: at(3), updatedAt: at(3) }])
  await db
    .collection(coll('custom-number'))
    .insertMany([{ _id: 7, title: 'number seven', createdAt: at(4), updatedAt: at(4) }])
  await db
    .collection(raw.globals.collection.name)
    .insertMany([
      { globalType: 'settings', siteName: 'site', count: 1, createdAt: at(5), updatedAt: at(5) },
    ])
  await db.collection(versions('settings')).insertMany(
    seed.globalVersions.map((h, i) => ({
      _id: new ObjectId(h),
      version: { siteName: `site v${i}` },
      latest: i === 1 ? true : undefined,
      createdAt: at(30 + i),
      updatedAt: at(30 + i),
    })),
  )
  await db.collection(coll('payload-jobs')).insertMany(
    seed.jobs.map((h, i) => ({
      _id: new ObjectId(h),
      taskSlug: 'noop',
      queue: 'default',
      processing: false,
      hasError: false,
      totalTried: 0,
      log: [],
      createdAt: at(40 + i),
      updatedAt: at(40 + i),
    })),
  )
}

const snapshotDatabase = async (raw: any, recorder: Recorder) => {
  const db = raw.connection.db
  const out: Record<string, unknown> = {}
  for (const [name] of modelsOf(raw)) {
    const docs = await db.collection(name).find({}).sort({ _id: 1 }).toArray()
    out[name] = recorder.describe(docs)
  }
  return out
}

/**
 * Replaces the hex of ObjectIds generated in this process (bytes 4-8 = a process-unique marker of
 * the loaded bson builds) by `<oid N>` in first-appearance order, wherever it appears (ObjectId
 * snapshots, id strings, messages). Any other 24-hex string is kept as is.
 */
export const canonicalize = (json: string) => {
  const generated = new Map<string, string>()
  return json.replace(/[0-9a-f]{24}/g, (hex: string) => {
    if (!processMarkers.has(hex.slice(8, 18))) {
      return hex
    }
    let token = generated.get(hex)
    if (!token) {
      token = `<oid ${generated.size}>`
      generated.set(hex, token)
    }
    return token
  })
}

export type RunRecord = {
  entries: number
  json: string
  /** whether the run's scenario fulfilled or rejected */
  outcome: 'error' | 'ok'
  /** constructor name of the rejection (own `constructor` data property of its prototype) */
  errorClass?: string
  stats: Record<string, number>
  /** stack of the run's error (diagnostics only, not compared: see the residuals in drive.rs) */
  stack?: string
}

const writeStats = () => {
  const s = getMongoLiveWrite().stats()
  return Object.fromEntries(liveWriteMethods.map((m) => [m, s[m]]))
}

/**
 * Explicit quiescence: every tracked promise (model results, query exec promises, method calls)
 * settled and no driver connection checked out, checked synchronously inside a `setImmediate`
 * callback (a check-phase macrotask: the microtask and nextTick queues are empty at that point, so
 * no promise job of the run is pending). Throws if that does not hold within 30 s.
 */
const awaitQuiescence = (recorder: Recorder, checkedOut: () => number) =>
  new Promise<void>((resolve, reject) => {
    const started = realNow()
    const check = () => {
      if (recorder.settledCount === recorder.trackedCount && checkedOut() === 0) {
        resolve()
        return
      }
      if (realNow() - started > 30_000) {
        reject(
          new Error(
            `not quiescent after 30 s: ${recorder.trackedCount - recorder.settledCount} tracked promises pending, ${checkedOut()} connections checked out`,
          ),
        )
        return
      }
      realSetTimeout(() => realSetImmediate(check), 1)
    }
    realSetImmediate(check)
  })

/** One run of `scenario` with candidate `kind`, from the seeded database state. */
export const runOnce = async (
  payload: Payload,
  scenario: Scenario,
  kind: RunKind,
): Promise<RunRecord> => {
  const raw = payload.db as any
  await learnServerMarker(raw)
  await resetDatabase(raw)
  const binding = getMongoLiveWrite()
  const recorder = new Recorder()
  const behaviours = new Map<string, any>()
  const cleanups: (() => Promise<void> | void)[] = []
  const extra: Record<string, unknown> = {}
  for (const [o, name] of [
    [payload, 'payload'],
    [payload.config, 'payload.config'],
    [payload.logger, 'payload.logger'],
    [raw, 'adapter'],
    [raw.connection, 'connection'],
    [mongoose, 'mongoose'],
  ] as const) {
    recorder.opaque.set(o as object, name)
  }

  const methodFor = (name: PropertyKey) => {
    if (typeof name !== 'string' || !(liveWriteMethods as readonly string[]).includes(name)) {
      return undefined
    }
    const method = name as LiveWriteMethod
    if (kind === 'rs') {
      return binding[method]
    }
    if (kind === 'mutant') {
      const upstream = raw[method]
      return function (this: unknown, args: unknown) {
        // one extra clock reading: the negative control must be told apart
        void new Date()
        return upstream.call(this, args)
      }
    }
    return raw[method]
  }

  const overrides = scenario.overrides ?? {}
  const adapter = new Proxy(raw, {
    get(target, key, receiver) {
      const value =
        key in overrides
          ? overrides[key as string]
          : (methodFor(key) ?? Reflect.get(target, key, receiver))
      recorder.log('adapter', typeof key === 'symbol' ? key : String(key))
      return value
    },
  })
  recorder.opaque.set(adapter, 'adapter view')

  const env: Env = {
    adapter,
    call: (method, args) => {
      const p = adapter[method](args)
      recorder.track(p, `call ${method}`)
      return p
    },
    extra,
    finally: (fn) => cleanups.push(fn),
    inject: (error) => {
      recorder.injected.push(error)
      return error
    },
    kind,
    log: (...event) => recorder.log('scenario', ...event),
    modelBehaviour: (label, method, behaviour) => behaviours.set(`${label}.${method}`, behaviour),
    payload,
    raw,
    rec: (label, value) => recorder.rec(label, value),
  }

  // driver operations in flight (connection pool check-outs)
  const client = raw.connection.getClient()
  let checkedOut = 0
  const onOut = () => checkedOut++
  const onIn = () => checkedOut--
  client.on('connectionCheckedOut', onOut)
  client.on('connectionCheckedIn', onIn)

  const stopHooks = [
    recorder.hookJobs(),
    v8.promiseHooks.onSettled((promise) => {
      const what = recorder.tracked.get(promise)
      if (what !== undefined) {
        recorder.settledCount++
        const event = recorder.log('settled', what)
        if (event) {
          recorder.pendingSettles.push({ event, promise })
        }
      }
    }),
  ]
  const restoreSpies = installModelSpies(raw, recorder, behaviours)
  const restoreClock = installClock(recorder)
  const entriesBefore = getCoreRuntime().stats().entries
  const statsBefore = writeStats()
  let outcome: unknown
  let outcomeKind: 'error' | 'ok' = 'ok'
  let errorClass: string | undefined
  let stack: string | undefined
  recorder.active = true
  recorder.tracing = true
  recorder.kick()
  try {
    try {
      const value = await scenario.run(env)
      recorder.log('fulfilled', value)
      outcome = { ok: recorder.describe(value) }
    } catch (error) {
      outcomeKind = 'error'
      const own = (key: string) =>
        typeof error === 'object' && error !== null ? ownData(error, key) : undefined
      stack = typeof own('stack') === 'string' ? (own('stack') as string) : undefined
      const proto =
        typeof error === 'object' && error !== null ? Object.getPrototypeOf(error) : null
      errorClass =
        proto && !utilTypes.isProxy(proto)
          ? functionName(ownData(proto, 'constructor'))
          : typeof error
      recorder.log('rejected', error)
      outcome = {
        err: recorder.describe(error),
        errClass: errorClass,
        injected: recorder.injected.indexOf(error),
      }
    }
    // in-flight work (e.g. the other calls of a fail-fast Promise.all) is part of the run
    await awaitQuiescence(recorder, () => checkedOut)
    recorder.log('quiescent')
  } finally {
    recorder.tracing = false
    recorder.active = false
    restoreClock()
    restoreSpies()
    for (const stop of stopHooks) {
      stop()
    }
    client.off('connectionCheckedOut', onOut)
    client.off('connectionCheckedIn', onIn)
  }
  for (const { event, promise } of recorder.pendingSettles) {
    const { state, value } = promiseDetails(promise)
    event.push(state, recorder.describe(value))
  }
  const entries = getCoreRuntime().stats().entries - entriesBefore
  const statsAfter = writeStats()
  const stats = Object.fromEntries(
    liveWriteMethods.map((m) => [m, (statsAfter[m] ?? 0) - (statsBefore[m] ?? 0)]),
  )
  const record = {
    database: await snapshotDatabase(raw, recorder),
    events: recorder.events,
    extra: recorder.describe(extra),
    final: recorder.roots.map(([label, value]) => [label, recorder.describe(value)]),
    outcome,
  }
  for (const cleanup of cleanups.reverse()) {
    await cleanup()
  }
  const json = canonicalize(JSON.stringify(record))
  if (process.env.LW_DUMP_DIR) {
    const file = `${scenario.name.replace(/[^\w]+/g, '_').slice(0, 80)}.${kind}.json`
    writeFileSync(path.join(process.env.LW_DUMP_DIR, file), json)
  }
  return { entries, errorClass, json, outcome: outcomeKind, stack, stats }
}

/** The landmark key of a recorded event (see `Expectation.reach`). */
export const eventKey = (event: unknown[]): string => {
  const [, , kind, ...rest] = event as [number, string, string, ...any[]]
  const s = (v: any) => (typeof v === 'string' ? v : JSON.stringify(v))
  switch (kind) {
    case 'model':
      return `model ${s(rest[0])}.${s(rest[1])}`
    case 'settled':
      return `settled ${s(rest[0])} ${s(rest[1])}`
    case 'exec':
      return `exec ${s(rest[0])}`
    case 'scenario':
      // the scenario's primitive args (`env.log('log read', 2)` -> `log log read 2`)
      return `log ${rest
        .filter((v) => v === null || typeof v !== 'object')
        .map(s)
        .join(' ')}`
    case 'clock':
      return `clock ${s(rest[0])}`
    case 'adapter':
      return `adapter ${s(rest[0])}`
    case 'get':
    case 'set':
    case 'has':
    case 'delete':
    case 'defineProperty':
    case 'getOwnPropertyDescriptor':
      return `${kind} ${s(rest[0])}.${s(rest[1])}`
    default:
      return String(kind)
  }
}

/** Resolves `@slug` / `@v:slug` / `@globals` in a landmark to the model labels of `raw`. */
export const resolveLandmark = (raw: any, landmark: string) =>
  landmark
    .replace(/@v:([\w-]+)/g, (_m, slug) => raw.versions[slug].collection.name)
    .replace(/@globals\b/g, raw.globals.collection.name)
    .replace(/@([\w-]+)/g, (_m, slug) => raw.collections[slug].collection.name)

/**
 * Landmark violations of `scenario` in a record: `reach` entries missing and `absent` entries
 * present (empty: the scenario took the branch it exists for).
 */
export const landmarkViolations = (raw: any, scenario: Scenario, json: string) => {
  const events = JSON.parse(json).events as unknown[][]
  const keys = events.map(eventKey)
  // a landmark is a key or a prefix of one ending at an argument boundary
  const has = (l: string) => keys.some((k) => k === l || k.startsWith(`${l} `))
  return [
    ...scenario.expect.reach
      .map((l) => resolveLandmark(raw, l))
      .filter((l) => !has(l))
      .map((l) => `missing: ${l}`),
    ...(scenario.expect.absent ?? [])
      .map((l) => resolveLandmark(raw, l))
      .filter((l) => has(l))
      .map((l) => `present: ${l}`),
  ]
}

/** Every distinct landmark key of a record (diagnostics for a landmark violation). */
export const recordKeys = (json: string) =>
  [...new Set((JSON.parse(json).events as unknown[][]).map(eventKey))].sort()

export type Comparison = {
  diff?: string
  rs: RunRecord
  ts: RunRecord
}

/** First difference of two JSON records, with context. */
export const firstDifference = (a: string, b: string): string | undefined => {
  if (a === b) {
    return undefined
  }
  const ea = JSON.parse(a)
  const eb = JSON.parse(b)
  for (const part of ['events', 'outcome', 'extra', 'final', 'database'] as const) {
    const sa = JSON.stringify(ea[part])
    const sb = JSON.stringify(eb[part])
    if (sa === sb) {
      continue
    }
    if (part === 'events') {
      const n = Math.max(ea.events.length, eb.events.length)
      for (let i = 0; i < n; i++) {
        const x = JSON.stringify(ea.events[i])
        const y = JSON.stringify(eb.events[i])
        if (x !== y) {
          return `events[${i}] (of ${ea.events.length} / ${eb.events.length}):\n  ts: ${x?.slice(0, 1500)}\n  rs: ${y?.slice(0, 1500)}\n  before: ${JSON.stringify(ea.events[i - 1])?.slice(0, 600)}`
        }
      }
    }
    let i = 0
    while (i < sa.length && sa[i] === sb[i]) {
      i++
    }
    return `${part} at ${i}:\n  ts: ${sa.slice(Math.max(0, i - 200), i + 300)}\n  rs: ${sb.slice(Math.max(0, i - 200), i + 300)}`
  }
  return 'records differ outside the compared parts'
}

/** Runs the scenario with TS and Rust and compares (plus the run guards). */
export const compare = async (payload: Payload, scenario: Scenario): Promise<Comparison> => {
  const ts = await runOnce(payload, scenario, 'ts')
  const rs = await runOnce(payload, scenario, 'rs')
  const guard: string[] = []
  if (ts.entries !== 0) {
    guard.push(`the TS reference run entered the addon ${ts.entries} times`)
  }
  if (Object.values(ts.stats).some((n) => n !== 0)) {
    guard.push(`the TS reference run called the live write binding: ${JSON.stringify(ts.stats)}`)
  }
  if (Object.values(rs.stats).every((n) => n === 0)) {
    guard.push('the Rust run did not call the live write binding')
  }
  const diff = firstDifference(ts.json, rs.json)
  return { diff: guard.length ? `${guard.join('; ')}${diff ? `\n${diff}` : ''}` : diff, rs, ts }
}

/** Test-only access for the harness self-tests. */
export const internals = { Recorder, canonicalize, processMarkers, promiseDetails }
