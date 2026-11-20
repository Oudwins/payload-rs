/**
 * Adapter-call traces for the parity goldens (parity.int.spec.ts, golden/trace/<section>.json):
 * what the step outputs and database dumps cannot show, per data-method call of a step, in call
 * order (packages/engine-rs/src/shadow-mongo/trace.ts):
 *
 * - `firstAwait`: the arguments right after the method returned its promise (mutations made
 *   before upstream's first await);
 * - `events`: every MongoDB driver operation (method, collection, arguments, sha1 of the call's
 *   arguments at that moment) and every clock reading, in order;
 * - `argsAfter`: the arguments when the call settled;
 * - `resultArgs` / `thrownArgs`: where the result (or thrown value) contains the caller's very
 *   argument objects (`[path in result, argument path]`), i.e. argument identity.
 *
 * Objects reachable from the arguments are labelled with their argument path before the call
 * (`{ $arg: <path>, value }` in the spelled trees); sessions are `{ $opaque: 'session' }`.
 *
 * Calls are listed in start order, except within a group of overlapping calls (each started
 * before an earlier member settled: the caller ran them concurrently), which is sorted by content:
 * which of them starts first depends on I/O completion upstream too (two TS recordings of the
 * same steps differed in `update > updateMany where`, `delete > *`, `live > update many over
 * several docs / drafts` on 2026-11-16). Readings by the MongoDB driver's own frames (connection
 * pool events) are not traced (`mongo > sort by near` differed by one such reading between two TS
 * recordings).
 */
import { createHash } from 'node:crypto'

import { toReportValue } from '../../../packages/engine-rs/src/shadow/compare.js'
import { toComparable } from '../../../packages/engine-rs/src/shadow-mongo/comparable.js'
import {
  installDriverTrace,
  runTraced,
  withClockTrace,
} from '../../../packages/engine-rs/src/shadow-mongo/trace.js'

/** db-mongodb data methods (upstream `payload.db` methods the engine serves). */
const DATA_METHODS = [
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

type AnyObject = Record<PropertyKey, any>

type TraceEntry = {
  /** Order counters (removed from the golden): start and settle positions in the step. */
  $settled?: number
  $started: number
  argsAfter?: unknown
  events: unknown[]
  firstAwait?: unknown
  method: string
  resultArgs?: [string, string][]
  thrownArgs?: [string, string][]
}

const isPlainObject = (value: unknown): value is AnyObject => {
  if (value === null || typeof value !== 'object') {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const sessionLabel = (value: object) =>
  value.constructor?.name === 'ClientSession' ? 'session' : undefined

/** Argument paths of the objects / functions reachable from `args` (outside `req`). */
const labelArgs = (args: unknown[]) => {
  const labels = new Map<unknown, string>()
  const visit = (value: unknown, path: string) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      return
    }
    if (labels.has(value) || (typeof value === 'object' && sessionLabel(value))) {
      return
    }
    labels.set(value, path)
    if (!Array.isArray(value) && !isPlainObject(value)) {
      return
    }
    for (const key of Object.keys(value)) {
      if (key !== 'req') {
        visit((value as AnyObject)[key], `${path}.${key}`)
      }
    }
  }
  args.forEach((arg, index) => visit(arg, String(index)))
  return labels
}

const withoutReq = (args: unknown[]) =>
  args.map((arg) =>
    isPlainObject(arg) && 'req' in arg
      ? Object.fromEntries(Object.entries(arg).filter(([key]) => key !== 'req'))
      : arg,
  )

/** `[path, label]` of every `{ $arg }` spelling inside a comparable tree. */
const argOccurrences = (tree: unknown) => {
  const out: [string, string][] = []
  const seen = new WeakSet<object>()
  const walk = (value: unknown, path: string) => {
    if (value === null || typeof value !== 'object' || seen.has(value)) {
      return
    }
    seen.add(value)
    if (isPlainObject(value) && typeof value.$arg === 'string' && 'value' in value) {
      out.push([path || '$', value.$arg])
    }
    for (const [key, item] of Object.entries(value)) {
      walk(item, path ? `${path}.${key}` : key)
    }
  }
  walk(tree, '')
  return out
}

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 16)

/**
 * 24-hex strings (ObjectIds: their bytes include the random per-process value) numbered by first
 * appearance within one call, so fingerprints are stable across runs.
 */
const createHexNumbering = () => {
  const ids = new Map<string, number>()
  return (text: string) =>
    text.replace(/\b[0-9a-f]{24}\b/g, (hex) => {
      if (!ids.has(hex)) {
        ids.set(hex, ids.size + 1)
      }
      return `<oid:${ids.get(hex)}>`
    })
}

type IDName = (hex: string) => string | undefined

/**
 * Content key of an entry: ObjectIds by their golden name when already named before the step
 * (stable across runs), otherwise all alike.
 */
const contentKey = (
  { $settled: _settled, $started: _started, ...entry }: TraceEntry,
  idName: IDName,
) => JSON.stringify(toReportValue(entry)).replace(/[0-9a-f]{24}/g, (hex) => idName(hex) ?? '<id>')

/** Entries in start order, each group of overlapping calls sorted by content (module comment). */
const orderEntries = (entries: TraceEntry[], idName: IDName) => {
  const out: Omit<TraceEntry, '$settled' | '$started'>[] = []
  let group: TraceEntry[] = []
  let groupEnd = -1
  const flush = () => {
    const keyed = group.map((entry) => ({ entry, key: contentKey(entry, idName) }))
    keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    for (const { entry } of keyed) {
      const { $settled: _settled, $started: _started, ...rest } = entry
      out.push(rest)
    }
    group = []
  }
  for (const entry of [...entries].sort((a, b) => a.$started - b.$started)) {
    if (group.length && entry.$started > groupEnd) {
      flush()
    }
    group.push(entry)
    groupEnd = Math.max(groupEnd, entry.$settled ?? Infinity)
  }
  flush()
  return out
}

/**
 * Negative controls (`RS_PARITY_TRACE_MUTANT`): adapter changes whose results and database
 * state stay upstream's, which only the traces can see.
 * - `defer-create`: `create` makes its mutations after an extra await;
 * - `extra-op`: `count` makes an extra driver operation first;
 * - `copy-where`: `find` replaces `where` with an equal copy before running.
 */
const mutate = (method: string, original: unknown) => {
  const mutant = process.env.RS_PARITY_TRACE_MUTANT
  if (typeof original !== 'function' || !mutant) {
    return original
  }
  const fn = original as (this: AnyObject, ...args: unknown[]) => Promise<unknown>
  if (mutant === 'defer-create' && method === 'create') {
    return async function (this: AnyObject, ...args: unknown[]) {
      await null
      return fn.apply(this, args)
    }
  }
  if (mutant === 'extra-op' && method === 'count') {
    return async function (this: AnyObject, ...args: unknown[]) {
      await this.collections[(args[0] as AnyObject).collection].collection.estimatedDocumentCount()
      return fn.apply(this, args)
    }
  }
  if (mutant === 'copy-where' && method === 'find') {
    return function (this: AnyObject, ...args: unknown[]) {
      const first = args[0] as AnyObject
      if (first.where) {
        first.where = { ...first.where }
      }
      return fn.apply(this, args)
    }
  }
  return original
}

export const createAdapterTracer = () => {
  const installed = new WeakSet<object>()
  let entries: TraceEntry[] | undefined
  let clock = 0

  const install = (db: AnyObject) => {
    if (installed.has(db)) {
      return
    }
    installed.add(db)
    installDriverTrace((db.mongoose ?? db.connection?.base)?.mongo?.Collection)
    for (const method of DATA_METHODS) {
      const original = mutate(method, db[method])
      if (typeof original !== 'function') {
        continue
      }
      db[method] = function (this: unknown, ...args: unknown[]) {
        const current = entries
        if (!current) {
          return original.apply(this, args)
        }
        const entry: TraceEntry = { $started: ++clock, events: [], method }
        current.push(entry)
        const identities = labelArgs(args)
        const spell = (value: unknown) => toComparable(value, { identities, opaque: sessionLabel })
        const argsNow = () => spell(withoutReq(args))
        const numberHex = createHexNumbering()
        let promise: unknown
        try {
          promise = runTraced(
            {
              describe: spell,
              events: entry.events as never[],
              fingerprint: () => sha1(numberHex(JSON.stringify(toReportValue(argsNow())))),
            },
            () => original.apply(this, args),
          )
        } finally {
          entry.firstAwait = argsNow()
        }
        return Promise.resolve(promise).then(
          (value) => {
            entry.$settled = ++clock
            entry.argsAfter = argsNow()
            entry.resultArgs = argOccurrences(spell(value))
            return value
          },
          (error: unknown) => {
            entry.$settled = ++clock
            entry.argsAfter = argsNow()
            entry.thrownArgs = argOccurrences(spell({ error }))
            throw error
          },
        )
      }
    }
  }

  /** Runs one step with its adapter calls traced; returns the step's result and trace. */
  const trace = async <T>(
    db: AnyObject,
    fn: () => Promise<T>,
    { idName = () => undefined }: { idName?: IDName } = {},
  ) => {
    install(db)
    const stepEntries: TraceEntry[] = []
    entries = stepEntries
    try {
      const result = await withClockTrace(fn)
      return { entries: orderEntries(stepEntries, idName), result }
    } finally {
      entries = undefined
    }
  }

  return { trace }
}
