import mongoose from 'mongoose'
/**
 * Runtime side of ./plugin.ts. `PAYLOAD_RS_LIVE_TRANSFORM`:
 * - unset: upstream;
 * - `rs`: the Rust port (crates/payload-mongo-live-transform) on the caller's objects;
 * - `shadow`: upstream and the Rust port each run on their own deep copy of the mutable inputs
 *   (data, `$inc` / `$push` / `$addToSet` / `$pull`, copied together so aliasing between them is
 *   kept), with recording proxies on those copies and a lazy recording membrane on everything else
 *   (args, adapter, payload, config, fields, error, req): the ordered trap logs, final states (with
 *   object identity), return values and thrown values are compared. Then the Rust port runs on the
 *   caller's objects, untraced; its outcome is what the suite sees. Upstream and the traced Rust run
 *   share the live config (read through the membrane); a config getter with side effects would make
 *   the second run see the first run's effects (none in the upstream suites' configs).
 *
 * Counts and mismatches go to `${PAYLOAD_RS_LIVE_TRANSFORM_REPORT}.<pid>.json` (rewritten as the run
 * goes, so a crashed worker still leaves its counts).
 */
import fs from 'node:fs'

import { getLiveTransformBinding } from './native.js'
import { createWorld } from './world.js'

const mode = process.env.PAYLOAD_RS_LIVE_TRANSFORM
const reportPath = process.env.PAYLOAD_RS_LIVE_TRANSFORM_REPORT

type Stats = {
  calls: Record<string, number>
  mismatchCount: number
  mismatches: { name: string; rs: string; ts: string }[]
  mode?: string
  pid: number
}

const stats: Stats = { calls: {}, mismatchCount: 0, mismatches: [], mode, pid: process.pid }
let unsaved = 0

const save = () => {
  unsaved = 0
  if (reportPath) {
    fs.writeFileSync(`${reportPath}.${process.pid}.json`, JSON.stringify(stats, null, 1))
  }
}

process.on('exit', save)

let inUpstream = 0

const upstreamRun = <T>(fn: () => T): T => {
  inUpstream++
  try {
    return fn()
  } finally {
    inUpstream--
  }
}

type Fn = (args: any) => unknown

export const swap = (name: string, upstream: Fn): Fn => {
  if (mode !== 'rs' && mode !== 'shadow') {
    return upstream
  }
  return function swapped(args: any) {
    if (inUpstream > 0) {
      return upstream(args)
    }
    const native = getLiveTransformBinding()[name as 'transform'] as Fn
    stats.calls[name] = (stats.calls[name] ?? 0) + 1
    if (++unsaved >= 500) {
      save()
    }
    if (mode === 'rs') {
      return native(args)
    }
    return shadow(name, upstream, native, args)
  }
}

const BSONTypes = (mongoose as any).mongo.BSON

const isObjectId = (v: object) =>
  v instanceof mongoose.Types.ObjectId || v instanceof BSONTypes.ObjectId

/** Deep clone keeping prototypes, property attributes, sharing and frozen state. */
const deepClone = (root: unknown) => {
  const seen = new Map<object, object>()
  const clone = (v: unknown): unknown => {
    if (!v || typeof v !== 'object') {
      return v
    }
    const existing = seen.get(v)
    if (existing) {
      return existing
    }
    let out: any
    if (isObjectId(v)) {
      out = new (v.constructor as any)((v as any).id)
    } else if (v instanceof Date) {
      out = new Date(v.getTime())
    } else if (Buffer.isBuffer(v)) {
      out = Buffer.from(v)
    } else if (v instanceof Uint8Array) {
      out = new Uint8Array(v)
    } else {
      out = Array.isArray(v) ? [] : Object.create(Object.getPrototypeOf(v))
      seen.set(v, out)
      for (const key of Reflect.ownKeys(v)) {
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!
        if ('value' in descriptor) {
          descriptor.value = clone(descriptor.value)
        }
        Object.defineProperty(out, key, descriptor)
      }
      if (Object.isFrozen(v)) {
        Object.freeze(out)
      } else if (!Object.isExtensible(v)) {
        Object.preventExtensions(out)
      }
      return out
    }
    seen.set(v, out)
    return out
  }
  return clone(root)
}

const MUTABLE_KEYS = ['data', '$inc', '$push', '$addToSet', '$pull']

const outcome = (fn: () => unknown) => {
  try {
    return { result: fn(), threw: false as const }
  } catch (error) {
    return { error, threw: true as const }
  }
}

const describeOutcome = (
  w: ReturnType<typeof createWorld>,
  o: ReturnType<typeof outcome>,
  roots: Record<string, unknown>,
) =>
  JSON.stringify({
    error: o.threw
      ? {
          ...w.describeError(o.error),
          data:
            o.error && typeof o.error === 'object' && 'data' in o.error
              ? w.describe({ data: (o.error as any).data }).data
              : undefined,
        }
      : undefined,
    events: w.events,
    result: o.threw ? undefined : w.describe({ result: o.result }).result,
    state: w.describe(roots),
    threw: o.threw,
  })

/** Runs `fn` with `new Date()` / `Date.now()` fixed (write transforms stamp `updatedAt`). */
const withFixedClock = <T>(now: number, fn: () => T): T => {
  const Current = globalThis.Date
  class FixedDate extends Current {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(now)
      } else {
        super(...(args as [number]))
      }
    }
    static override now() {
      return now
    }
  }
  globalThis.Date = FixedDate as DateConstructor
  try {
    return fn()
  } finally {
    globalThis.Date = Current
  }
}

/** One traced run: own copies of the mutable roots, membrane on the rest of the arguments. */
const tracedRun = (name: string, fn: Fn, args: any, isUpstream: boolean) => {
  const w = createWorld()
  const roots: Record<string, unknown> = {}
  let runArgs = args
  if (args && typeof args === 'object') {
    const present = MUTABLE_KEYS.filter((key) => name === 'transform' && key in args)
    const copies = deepClone(Object.fromEntries(present.map((key) => [key, args[key]]))) as Record<
      string,
      unknown
    >
    runArgs = {}
    for (const key of Reflect.ownKeys(args)) {
      const value = args[key]
      if (typeof key === 'string' && present.includes(key)) {
        runArgs[key] = w.wrap(copies[key], key)
        roots[key] = runArgs[key]
      } else {
        runArgs[key] = w.membrane(value, String(key))
      }
    }
    runArgs = w.membrane(runArgs, 'args')
  }
  w.start()
  const o = outcome(() => (isUpstream ? upstreamRun(() => fn(runArgs)) : fn(runArgs)))
  w.stop()
  return describeOutcome(w, o, roots)
}

const shadow = (name: string, upstream: Fn, native: Fn, args: any) => {
  const isTransform = name === 'transform' && args && typeof args === 'object'
  const fixClock = isTransform && args.operation !== 'read'
  const now = Date.now()
  const run = <T>(fn: () => T) => (fixClock ? withFixedClock(now, fn) : fn())

  const a = run(() => tracedRun(name, upstream, args, true))
  const b = run(() => tracedRun(name, native, args, false))
  if (a !== b) {
    stats.mismatchCount++
    if (stats.mismatches.length < 50) {
      stats.mismatches.push({ name, rs: b.slice(0, 4000), ts: a.slice(0, 4000) })
    }
    save()
  }
  const rs = run(() => outcome(() => native(args)))
  if (rs.threw) {
    throw rs.error
  }
  return rs.result
}
