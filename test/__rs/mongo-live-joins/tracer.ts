/**
 * Live differential tracing for the joins ports (crates/payload-mongo-live-joins).
 *
 * One `Trace` per side (TS reference / Rust candidate). Inputs are wrapped in recording proxies
 * (every get / set / has / delete / ownKeys / descriptor / defineProperty / call on plain objects,
 * arrays, functions and the payload instance, recursively), mongoose models in model proxies that
 * record property reads and method calls (arguments described deeply at call time) and hand back
 * thenables whose results are delivered through a per-side sequencer: in issue order, each in its
 * own macrotask followed by a burst of microtask ticks that are recorded too. Spied module functions
 * (`buildQuery`, `buildSortParam`, `transform`) record into the trace of the current async context.
 *
 * Values are described by kind: primitives exactly (`-0`, `NaN`, bigint, symbol), objects by label:
 * input objects by the path they were first reached through (`adapter.payload.config...`), objects
 * first seen as an argument the code passes out by `code#n`, results of models / spied functions by
 * `dep#n` (n = order of first appearance). Two sides behave the same iff their event lists, results,
 * errors and final input states are equal.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { types } from 'node:util'

/* eslint-disable @typescript-eslint/no-explicit-any -- the tracer handles arbitrary values */
type Any = any

export type Side = 'rs' | 'ts'

export type Trace = {
  codeCount: number
  delivered: number
  depCount: number
  events: string[]
  issued: number
  labels: WeakMap<object, string>
  /** raw target -> proxy (one proxy per object and side: identity is stable within a side) */
  proxies: WeakMap<object, Any>
  queue: {
    reject: (e: Any) => void
    resolve: (v: Any) => void
    settled?: { ok: boolean; value: Any }
  }[]
  side: Side
  /** proxy -> raw target */
  targets: WeakMap<object, object>
  ticks: number
}

export const traceStore = new AsyncLocalStorage<Trace>()

export const createTrace = (side: Side): Trace => ({
  codeCount: 0,
  delivered: 0,
  depCount: 0,
  events: [],
  issued: 0,
  labels: new WeakMap(),
  proxies: new WeakMap(),
  queue: [],
  side,
  targets: new WeakMap(),
  ticks: 0,
})

const isObjectLike = (v: unknown): v is object =>
  (typeof v === 'object' && v !== null) || typeof v === 'function'

export const isModel = (v: unknown): boolean =>
  typeof v === 'function' && typeof (v as Any).modelName === 'string' && Boolean((v as Any).schema)

const isProxiable = (v: object): boolean => {
  if (types.isProxy(v)) {
    return false
  }
  if (typeof v === 'function') {
    return !isModel(v)
  }
  if (Array.isArray(v)) {
    return true
  }
  const proto = Object.getPrototypeOf(v)
  if (proto === Object.prototype || proto === null) {
    return !('_bsontype' in v)
  }
  const name = proto?.constructor?.name
  return name === 'BasePayload' || name === 'Payload'
}

export const raw = (t: Trace, v: Any): Any => (isObjectLike(v) ? (t.targets.get(v) ?? v) : v)

const label = (t: Trace, v: object, origin: () => string): string => {
  const target = raw(t, v)
  let l = t.labels.get(target)
  if (!l) {
    l = origin()
    t.labels.set(target, l)
  }
  return l
}

export const describe = (
  t: Trace,
  v: unknown,
  origin: () => string = () => `code#${t.codeCount++}`,
): string => {
  switch (typeof v) {
    case 'bigint':
      return `${v}n`
    case 'boolean':
      return String(v)
    case 'number':
      return Object.is(v, -0) ? '-0' : String(v)
    case 'string':
      return JSON.stringify(v)
    case 'symbol':
      return `Symbol(${v.description})`
    case 'undefined':
      return 'undefined'
  }
  if (v === null) {
    return 'null'
  }
  return `<${label(t, v as object, origin)}>`
}

/** Deep description of a value the code passes out (objects it created are expanded). */
export const describeDeep = (t: Trace, v: unknown, seen = new Set<object>()): string => {
  if (!isObjectLike(v)) {
    return describe(t, v)
  }
  const target = raw(t, v)
  const isNew = !t.labels.has(target)
  const head = describe(t, v)
  const l = t.labels.get(target)!
  if (seen.has(target) || !(isNew || l.startsWith('code#') || l.startsWith('dep#'))) {
    return head
  }
  seen.add(target)
  if (typeof target === 'function' || types.isProxy(target)) {
    return head
  }
  const proto = Object.getPrototypeOf(target)
  if (proto !== Object.prototype && proto !== null && !Array.isArray(target)) {
    // class instances (ObjectId, Date, ...): their class and own string form
    let text = ''
    try {
      text = String(target)
    } catch {
      text = '?'
    }
    return `${head}${proto?.constructor?.name}(${text})`
  }
  const parts = Reflect.ownKeys(target).map((k) => {
    const d = Object.getOwnPropertyDescriptor(target, k)!
    const value = 'value' in d ? describeDeep(t, d.value, seen) : '<accessor>'
    return `${String(k)}${d.enumerable ? '' : '(ne)'}:${value}`
  })
  return `${head}${Array.isArray(target) ? '[' : '{'}${parts.join(',')}${Array.isArray(target) ? ']' : '}'}`
}

/**
 * Records an event of the code under test: operations performed while the side's own async
 * context is active. Spied functions and models run their real implementation outside it
 * (`traceStore.exit`), so what they do internally (nested queries, reads after their own awaits,
 * whose timing depends on I/O) is not part of the trace and never goes through the sequencer.
 */
const record = (t: Trace, event: string) => {
  if (traceStore.getStore() === t) {
    t.events.push(event)
  }
}

/** Records unconditionally (sequencer deliveries and tick bursts of the side). */
const recordAlways = (t: Trace, event: string) => {
  t.events.push(event)
}

/** Wraps an input value: plain objects, arrays, functions and the payload instance become
 * recording proxies, models become model proxies; everything else is returned as is. */
export const wrap = (t: Trace, v: Any, path: string): Any => {
  if (!isObjectLike(v)) {
    return v
  }
  if (types.isProxy(v) && t.targets.has(v)) {
    return v
  }
  const existing = t.proxies.get(v)
  if (existing) {
    return existing
  }
  label(t, v, () => path)
  if (isModel(v)) {
    return wrapModel(t, v)
  }
  if (!isProxiable(v)) {
    return v
  }
  const l = () => t.labels.get(v)!
  const child = (k: PropertyKey) => `${l()}.${String(k)}`
  const proxy: Any = new Proxy(v, {
    apply(target, thisArg, args) {
      record(
        t,
        `call ${l()}(${args.map((a) => describeDeep(t, a)).join(', ')}) this=${describe(t, thisArg)}`,
      )
      try {
        const result = Reflect.apply(target as Any, raw(t, thisArg), args)
        record(t, `return ${l()} -> ${describe(t, result, () => `dep#${t.depCount++}`)}`)
        return result
      } catch (error) {
        record(t, `throw ${l()} -> ${describe(t, error, () => `dep#${t.depCount++}`)}`)
        throw error
      }
    },
    defineProperty(target, k, d) {
      record(t, `define ${child(k)} = ${'value' in d ? describeDeep(t, d.value) : 'accessor'}`)
      return Reflect.defineProperty(target, k, d)
    },
    deleteProperty(target, k) {
      record(t, `delete ${child(k)}`)
      return Reflect.deleteProperty(target, k)
    },
    get(target, k, receiver) {
      const value = Reflect.get(target, k, receiver === proxy ? target : receiver)
      const own = Reflect.getOwnPropertyDescriptor(target, k)
      if (typeof k === 'symbol' || (own && !own.configurable && !own.writable && 'value' in own)) {
        // proxy invariant: non-configurable, non-writable data properties are returned as they are
        record(t, `get ${child(k)}`)
        return value
      }
      const out = wrap(t, value, child(k))
      record(t, `get ${child(k)} -> ${describe(t, value, () => child(k))}`)
      return out
    },
    getOwnPropertyDescriptor(target, k) {
      record(t, `gopd ${child(k)}`)
      return Reflect.getOwnPropertyDescriptor(target, k)
    },
    has(target, k) {
      const result = Reflect.has(target, k)
      record(t, `has ${child(k)} -> ${result}`)
      return result
    },
    ownKeys(target) {
      record(t, `ownKeys ${l()}`)
      return Reflect.ownKeys(target)
    },
    set(target, k, value, receiver) {
      record(t, `set ${child(k)} = ${describeDeep(t, value)}`)
      return Reflect.set(target, k, value, receiver === proxy ? target : receiver)
    },
  })
  t.proxies.set(v, proxy)
  t.targets.set(proxy, v)
  return proxy
}

/** Recording model: property reads, method calls with deep argument descriptions, queries whose
 * results are delivered through the sequencer (and wrapped as `dep#n` inputs). */
const wrapModel = (t: Trace, model: Any): Any => {
  const l = () => t.labels.get(model)!
  const proxy: Any = new Proxy(model, {
    get(target, k) {
      const value = Reflect.get(target, k, target)
      record(t, `get ${l()}.${String(k)}`)
      if (typeof k === 'string' && typeof value === 'function' && !isModel(value)) {
        return function (this: Any, ...args: Any[]) {
          const rawArgs = args.map((a) => raw(t, a))
          if (traceStore.getStore() !== t) {
            // called by a spied function's implementation: not the code under test
            return Reflect.apply(value, target, rawArgs)
          }
          record(t, `call ${l()}.${k}(${args.map((a) => describeDeep(t, a)).join(', ')})`)
          const result = traceStore.exit(() => Reflect.apply(value, target, rawArgs))
          return wrapResult(t, result, `${l()}.${k}`)
        }
      }
      if (k === 'collection' && isObjectLike(value)) {
        return { name: (record(t, `get ${l()}.collection.name`), (value as Any).name) }
      }
      return value
    },
  })
  t.proxies.set(model, proxy)
  t.targets.set(proxy, model)
  return proxy
}

/** A mongoose query / promise returned by a model method: chained calls are recorded, awaiting it
 * runs the real query and delivers its result through the sequencer. */
const wrapResult = (t: Trace, result: Any, what: string): Any => {
  if (!isObjectLike(result) || typeof (result as Any).then !== 'function') {
    return result
  }
  const query = result as Any
  const wrapped: Any = new Proxy(query, {
    get(target, k) {
      if (k === 'then' && traceStore.getStore() === t) {
        record(t, `then ${what}`)
        return (onFulfilled: Any, onRejected: Any) =>
          deliver(
            t,
            traceStore.exit(() => (typeof target.exec === 'function' ? target.exec() : target)),
            what,
          ).then(
            onFulfilled,
            onRejected,
          )
      }
      const value = Reflect.get(target, k, target)
      if (typeof k === 'string' && typeof value === 'function') {
        return (...args: Any[]) => {
          record(t, `call ${what}.${k}(${args.map((a) => describeDeep(t, a)).join(', ')})`)
          return wrapResult(
            t,
            traceStore.exit(() => Reflect.apply(value, target, args)),
            `${what}.${k}`,
          )
        }
      }
      return value
    },
  })
  return wrapped
}

/** Starts a burst of `n` recorded microtask ticks. */
export const ticker = (t: Trace, n: number, tag: string) => {
  let i = 0
  const step = () => {
    recordAlways(t, `tick ${tag}.${i}`)
    if (++i < n) {
      void Promise.resolve().then(step)
    }
  }
  void Promise.resolve().then(step)
}

/**
 * The sequencer: `promise` settles whenever it settles; the returned native promise settles in
 * issue order, each delivery in its own macrotask, followed by a tick burst.
 */
export const deliver = (t: Trace, promise: Any, what: string): Promise<Any> => {
  const index = t.issued++
  return new Promise((resolve, reject) => {
    const slot: Trace['queue'][number] = { reject, resolve }
    t.queue[index] = slot
    Promise.resolve(promise).then(
      (value) => {
        slot.settled = { ok: true, value }
        flush(t)
      },
      (error) => {
        slot.settled = { ok: false, value: error }
        flush(t)
      },
    )
  }).then((value) => wrap(t, value, `dep#${t.depCount++}`)) as Promise<Any>
  void what
}

const flush = (t: Trace) => {
  const slot = t.queue[t.delivered]
  if (!slot?.settled) {
    return
  }
  const index = t.delivered++
  setImmediate(() => {
    const { ok, value } = slot.settled!
    recordAlways(
      t,
      `deliver ${index} ${ok ? 'ok' : `error ${describe(t, value, () => `dep#${t.depCount++}`)}`}`,
    )
    ticker(t, 40, `d${index}`)
    if (ok) {
      slot.resolve(value)
    } else {
      slot.reject(value)
    }
    flush(t)
  })
}

/**
 * Replacements of spied module functions for synthetic cases (`spyOverrides.buildQuery = ...`):
 * called instead of the real function, results returned as they are (no sequencer), so the
 * microtask schedule is the code's alone.
 */
export const spyOverrides: Record<string, ((...args: Any[]) => Any) | undefined> = {}

/** Records a spied module function call in the current trace (no trace: plain call). */
export const spyCall = (name: string, fn: (...args: Any[]) => Any, args: Any[]): Any => {
  const t = traceStore.getStore()
  if (!t) {
    return fn(...args)
  }
  const override = spyOverrides[name]
  // the callee destructures its args literal: an own `undefined` key and an absent one are the
  // same input (the shared live deps pass every key of the upstream signature)
  const shown = args.map((a, i) =>
    i === 0 && isObjectLike(a) && !t.labels.has(raw(t, a)) && Object.getPrototypeOf(a) === Object.prototype
      ? Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined))
      : a,
  )
  record(t, `call ${name}(${shown.map((a) => describeDeep(t, a)).join(', ')})`)
  let result: Any
  try {
    result = override ? override(...args) : traceStore.exit(() => fn(...args))
  } catch (error) {
    record(t, `throw ${name} -> ${describe(t, error, () => `dep#${t.depCount++}`)}`)
    throw error
  }
  if (override) {
    record(t, `return ${name} -> ${describe(t, result, () => `dep#${t.depCount++}`)}`)
    return result
  }
  if (isObjectLike(result) && typeof (result as Any).then === 'function') {
    record(t, `return ${name} -> promise`)
    return deliver(t, result, name).then((v) => raw(t, v))
  }
  record(t, `return ${name} -> ${describeDeep(t, result)}`)
  return result
}

/** Deep copy of plain objects / arrays (class instances shared), for the candidate's inputs. */
export const clonePlain = <T>(v: T, seen = new Map<object, unknown>()): T => {
  if (!isObjectLike(v) || typeof v === 'function') {
    return v
  }
  if (seen.has(v)) {
    return seen.get(v) as T
  }
  const proto = Object.getPrototypeOf(v)
  if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) {
    return v
  }
  const out: Any = Array.isArray(v) ? [] : Object.create(proto)
  seen.set(v, out)
  for (const k of Reflect.ownKeys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, k)!
    if ('value' in d) {
      d.value = clonePlain(d.value, seen)
    }
    Object.defineProperty(out, k, d)
  }
  return out
}

export type Outcome = { error?: string; events: string[]; result: string; state: string }

/**
 * Runs `fn(args)` for one side: inputs wrapped, a tick burst at the start, settled outcome
 * described. `inputs` = the root input values by name (wrapped and labelled with that name).
 */
export const runSide = async (
  side: Side,
  inputs: Record<string, Any>,
  fn: (wrapped: Record<string, Any>) => Promise<Any>,
): Promise<{ trace: Trace; value: Any; thrown?: Any; threw: boolean } & Outcome> => {
  const t = createTrace(side)
  const wrapped: Record<string, Any> = {}
  for (const [k, v] of Object.entries(inputs)) {
    wrapped[k] = wrap(t, v, k)
  }
  let value: Any
  let thrown: Any
  let threw = false
  await traceStore.run(t, async () => {
    ticker(t, 40, 'start')
    try {
      value = await fn(wrapped)
    } catch (error) {
      threw = true
      thrown = error
    }
    // let the work the call left running (siblings of a failed Promise.all, tick bursts) finish:
    // wait until every issued model / spied call was delivered (bounded), then one more macrotask
    const deadline = Date.now() + 5000
    while (t.delivered < t.issued && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await new Promise((resolve) => setImmediate(resolve))
  })
  // later events (never-settling work) are not part of the outcome
  const events = t.events.slice()
  const result = threw ? '' : describeDeep(t, value)
  const state = Object.keys(inputs)
    .map((k) => `${k}=${describeDeep(t, inputs[k])}`)
    .join('\n')
  const error = threw
    ? `${(thrown as Any)?.constructor?.name}:${(thrown as Any)?.name}:${(thrown as Any)?.message}:${describe(t, thrown)}`
    : undefined
  return { error, events, result, state, threw, thrown, trace: t, value }
}

/** First difference between two outcomes, or undefined. */
export const diffOutcomes = (a: Outcome, b: Outcome): string | undefined => {
  const n = Math.max(a.events.length, b.events.length)
  for (let i = 0; i < n; i++) {
    if (a.events[i] !== b.events[i]) {
      return `event ${i}:\n  ts: ${a.events[i]}\n  rs: ${b.events[i]}\n  (before: ${a.events.slice(Math.max(0, i - 3), i).join(' | ')})`
    }
  }
  if (a.error !== b.error) {
    return `error: ts ${a.error} / rs ${b.error}`
  }
  if (a.result !== b.result) {
    return `result:\n  ts: ${a.result.slice(0, 2000)}\n  rs: ${b.result.slice(0, 2000)}`
  }
  if (a.state !== b.state) {
    return `final input state:\n  ts: ${a.state.slice(0, 2000)}\n  rs: ${b.state.slice(0, 2000)}`
  }
  return undefined
}
