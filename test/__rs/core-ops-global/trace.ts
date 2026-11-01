/**
 * Cross-process differential trace of the global and auth operations.
 *
 * Every top-level call of a global / auth operation (`wrap/*.ts`) is a *case*: it runs inside an
 * AsyncLocalStorage store that collects, in order,
 * - the call with a snapshot of its args,
 * - every global / auth-collection hook and access function, `payload.db.*` method (reads,
 *   writes, transactions), Local API method (`payload.find`, `findGlobal`, `update`, ...),
 *   nested global / auth operation, field traversal (`afterRead`, `beforeValidate`,
 *   `beforeChange`, `afterChange`: their args are the operation's plumbing), email
 *   `sendEmail` and `forgotPassword.generateEmail*` call, each with an args snapshot at call
 *   time, `this`, and its sync return or async settlement (logged from a reaction on the returned
 *   promise, so settlement order shows),
 * - the microtask distance (`gap`) since the case's previous event (a skipped or extra `await`
 *   anywhere shifts it),
 * - the outcome (value, or error class / name / message / status / data / isPublic), and the
 *   caller-visible state afterwards: the args object and `req.{context, user, locale,
 *   fallbackLocale, operation, responseHeaders, transactionID}`.
 * Snapshots keep key order, own `undefined`, class names, Dates and object identity (numbered per
 * case by first appearance); config objects, `req`, `payload`, `db` are compared by role. Values
 * that differ between runs by construction are canonicalized: dates / timestamps near "now", JWTs,
 * random hex tokens, ObjectIds, salts / hashes and UUIDs (numbered per case by first appearance, so equality
 * between them is still compared).
 *
 * `RS_OPS_GLOBAL_TRACE=<dir>`: each process appends one JSON line per case to
 * `<dir>/trace-<pid>.jsonl` (`{ file, test, seq, op, impl, log }`); `impl` is which implementation
 * payload's dispatch selected (`rs` / `ts`). compare.mjs diffs two runs of the same suite.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'

type Any = any
type Fn = (...args: Any[]) => Any

type Case = {
  canon: Map<string, string>
  counters: Record<string, number>
  ids: Map<object, number>
  log: string[]
  next: number
  roles: Map<object, string>
  ticker?: { count: number }
}

const traceDir = process.env.RS_OPS_GLOBAL_TRACE
const als = new AsyncLocalStorage<Case>()
const realDateNow = Date.now
const TICKER_BUDGET = 1024
const seqByTest = new Map<string, number>()

// ------------------------------------------------------------------------------------------
// entry points used by wrap/*.ts

/** The operation export payload's importers see: traced when `RS_OPS_GLOBAL_TRACE` is set. */
export const wrapOperation = (op: string, getReal: () => Fn, getTS: () => Fn): Fn => {
  if (!traceDir) {
    return (...args: Any[]) => getReal()(...args)
  }
  return function (this: Any, ...args: Any[]) {
    const real = getReal()
    const current = als.getStore()
    if (current) {
      return recordCall(current, `op:${op}`, this, args, real)
    }
    return topLevel(op, real, real === getTS() ? 'ts' : 'rs', this, args)
  }
}

/** A field traversal export: traced inside cases only. */
export const wrapTraversal = (name: string, getReal: () => Fn): Fn =>
  function (this: Any, ...args: Any[]) {
    const real = getReal()
    const current = traceDir ? als.getStore() : undefined
    if (current) {
      return recordCall(current, `traversal:${name}`, this, args, real)
    }
    return real.apply(this, args)
  }

const topLevel = (op: string, real: Fn, impl: 'rs' | 'ts', self: Any, args: Any[]): Any => {
  const state = expect.getState()
  const file = path.relative(process.cwd(), state.testPath ?? 'unknown')
  const test = state.currentTestName ?? '(outside test)'
  const key = `${file}|${test}`
  const seq = seqByTest.get(key) ?? 0
  seqByTest.set(key, seq + 1)

  const input = args[0]
  const req = input?.req
  const payload = req?.payload
  if (payload) {
    instrument(payload)
  }
  const c: Case = {
    canon: new Map(),
    counters: {},
    ids: new Map(),
    log: [],
    next: 0,
    roles: new Map(),
  }
  setRoles(c, input, req)

  const write = () => {
    fs.mkdirSync(traceDir!, { recursive: true })
    fs.appendFileSync(
      path.join(traceDir!, `trace-${process.pid}.jsonl`),
      `${JSON.stringify({ file, impl, log: c.log, op, seq, test })}\n`,
    )
  }
  const after = () => {
    push(c, { ev: 'req', value: snapReq(c, req) })
    push(c, { ev: 'args', value: snapShallow(c, input) })
    write()
  }

  return als.run(c, () => {
    push(c, { args: args.map((a) => snapShallow(c, a)), ev: 'start', op })
    let result: Any
    try {
      result = real.apply(self, args)
    } catch (error) {
      push(c, { error: snapError(c, error), ev: 'outcome', ok: false, sync: true })
      after()
      throw error
    }
    Promise.resolve(result).then(
      (value) => {
        push(c, { ev: 'outcome', ok: true, value: snap(c, value) })
        after()
      },
      (error) => {
        push(c, { error: snapError(c, error), ev: 'outcome', ok: false })
        after()
      },
    )
    return result
  })
}

// ------------------------------------------------------------------------------------------
// events

const push = (c: Case, event: Record<string, unknown>): void => {
  const ticker = c.ticker
  event.gap = !ticker ? 'start' : ticker.count < TICKER_BUDGET ? ticker.count : 'far'
  c.log.push(JSON.stringify(event))
  const next = { count: 0 }
  c.ticker = next
  const step = () => {
    if (c.ticker !== next || next.count >= TICKER_BUDGET) {
      return
    }
    next.count++
    void Promise.resolve().then(step)
  }
  void Promise.resolve().then(step)
}

const recordCall = (c: Case, what: string, self: Any, args: Any[], fn: Fn): Any => {
  const id = c.log.length
  push(c, {
    args: args.map((a) => snap(c, a)),
    ev: 'call',
    this: self === undefined ? undefined : snap(c, self),
    what,
  })
  let result: Any
  try {
    result = fn.apply(self, args)
  } catch (error) {
    push(c, { error: snapError(c, error), ev: 'throw', id })
    throw error
  }
  if (result && typeof result.then === 'function') {
    push(c, { ev: 'pending', id })
    result.then(
      (value: Any) => push(c, { ev: 'resolve', id, value: snap(c, value) }),
      (error: Any) => push(c, { error: snapError(c, error), ev: 'reject', id }),
    )
  } else {
    push(c, { ev: 'return', id, value: snap(c, result) })
  }
  return result
}

// ------------------------------------------------------------------------------------------
// snapshots

const staticRoles = new WeakMap<object, string>()

const setRoles = (c: Case, args: Any, req: Any): void => {
  if (args && typeof args === 'object') {
    c.roles.set(args, '$args')
  }
  if (req && typeof req === 'object') {
    c.roles.set(req, '$req')
    for (const key of [
      'context',
      'payloadDataLoader',
      'i18n',
      'headers',
      'query',
      'routeParams',
      't',
    ]) {
      let v: Any
      try {
        v = req[key]
      } catch {
        continue
      }
      if (v && (typeof v === 'object' || typeof v === 'function') && !c.roles.has(v)) {
        c.roles.set(v, `$req.${key}`)
      }
    }
  }
}

const DAY = 864e5
const isoDate = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g
const httpDate = /[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT/g
const jwt = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const hex = /\b[0-9a-f]{24,}\b/g
const epochMs = /(?<!\d)1\d{12}(?!\d)/g

const canonical = (c: Case, kind: string, raw: string): string => {
  const key = `${kind}:${raw}`
  let out = c.canon.get(key)
  if (!out) {
    c.counters[kind] = (c.counters[kind] ?? 0) + 1
    out = `<${kind}#${c.counters[kind]}>`
    c.canon.set(key, out)
  }
  return out
}

const normalizeString = (c: Case, s: string): string => {
  if (s.length < 13) {
    return s
  }
  const now = realDateNow()
  return s
    .replace(jwt, (m) => canonical(c, 'jwt', m))
    .replace(uuid, (m) => canonical(c, 'uuid', m))
    .replace(hex, (m) => canonical(c, 'hex', m))
    .replace(isoDate, (m) => (Math.abs(Date.parse(m) - now) < 60 * DAY ? '<recent-date>' : m))
    .replace(httpDate, (m) => (Math.abs(Date.parse(m) - now) < 60 * DAY ? '<recent-http-date>' : m))
    .replace(epochMs, (m) => (Math.abs(Number(m) - now) < 60 * DAY ? '<recent-ms>' : m))
}

const normalizeNumber = (n: number): number | string => {
  const now = realDateNow()
  if (Math.abs(n - now) < 60 * DAY) {
    return '<recent-ms>'
  }
  if (Number.isInteger(n) && Math.abs(n - now / 1000) < (60 * DAY) / 1000) {
    return '<recent-s>'
  }
  return n
}

const snapError = (c: Case, error: Any): unknown => {
  if (!(error instanceof Error)) {
    return { thrown: snap(c, error) }
  }
  const e: Any = error
  return {
    class: e.constructor?.name,
    data: snap(c, e.data),
    isPublic: e.isPublic,
    message: normalizeString(c, e.message),
    name: e.name,
    status: e.status,
  }
}

const REQ_KEYS = [
  'context',
  'user',
  'locale',
  'fallbackLocale',
  'operation',
  'responseHeaders',
  'transactionID',
]

const snapReq = (c: Case, req: Any): unknown => {
  if (!req || typeof req !== 'object') {
    return snap(c, req)
  }
  const out: Record<string, unknown> = {}
  for (const key of REQ_KEYS) {
    let v: Any
    try {
      v = req[key]
    } catch (error) {
      v = { $getterThrew: String(error) }
    }
    out[key] = key === 'context' ? snapFresh(c, v) : snap(c, v)
  }
  return out
}

/** Snapshot of an object that has a role (args, req.context): its contents, not the role. */
const snapFresh = (c: Case, v: Any): unknown => snap(c, v, 0, new Set(), true)

const snapShallow = (c: Case, args: Any): unknown => {
  if (!args || typeof args !== 'object') {
    return snap(c, args)
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(args)) {
    out[key] = key === 'req' ? snap(c, args[key]) : snap(c, args[key], 0, new Set(), false)
  }
  return out
}

const snap = (c: Case, v: Any, depth = 0, stack = new Set<object>(), fresh = false): unknown => {
  if (v === undefined) {
    return { $u: 1 }
  }
  if (v === null || typeof v === 'boolean') {
    return v
  }
  if (typeof v === 'string') {
    return normalizeString(c, v)
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) && !Object.is(v, -0)
      ? normalizeNumber(v)
      : { $num: Object.is(v, -0) ? '-0' : String(v) }
  }
  if (typeof v === 'bigint') {
    return { $big: String(v) }
  }
  if (typeof v === 'symbol') {
    return { $sym: String(v) }
  }
  const role = fresh ? undefined : (c.roles.get(v) ?? staticRoles.get(v))
  if (role) {
    return { $role: role }
  }
  if (typeof v === 'function') {
    return { $fn: v.name }
  }
  if (v instanceof Date) {
    const t = v.getTime()
    if (Number.isNaN(t)) {
      return { $date: 'invalid' }
    }
    return Math.abs(t - realDateNow()) < 60 * DAY ? { $date: 'recent' } : { $date: v.toISOString() }
  }
  if (v instanceof Promise) {
    return { $promise: 1 }
  }
  if (typeof Headers !== 'undefined' && v instanceof Headers) {
    return { $headers: [...v.entries()].map(([k, x]) => [k, normalizeString(c, x)]) }
  }
  let id = c.ids.get(v)
  if (id === undefined) {
    id = c.next++
    c.ids.set(v, id)
  }
  if (stack.has(v) || depth > 24) {
    return { $ref: id }
  }
  stack.add(v)
  try {
    if (Array.isArray(v)) {
      const items: unknown[] = []
      for (let i = 0; i < v.length; i++) {
        items.push(i in v ? snap(c, v[i], depth + 1, stack) : { $hole: 1 })
      }
      return { $a: items, $id: id }
    }
    const out: Record<string, unknown> = { $id: id }
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) {
      out.$class = proto?.constructor?.name ?? '?'
    }
    if (v instanceof Error) {
      out.$error = v.name
      out.$message = normalizeString(c, v.message)
    }
    for (const key of Object.keys(v)) {
      let x: Any
      try {
        x = v[key]
      } catch (error) {
        x = { $getterThrew: String(error) }
      }
      out[normalizeString(c, key)] = snap(c, x, depth + 1, stack)
    }
    return out
  } finally {
    stack.delete(v)
  }
}

// ------------------------------------------------------------------------------------------
// instrumentation

const instrumented = new WeakSet<object>()
const wrappedFns = new WeakSet<Fn>()

const wrap = (what: string, fn: Fn): Fn => {
  if (typeof fn !== 'function' || wrappedFns.has(fn)) {
    return fn
  }
  const wrapped = function (this: Any, ...args: Any[]) {
    const current = als.getStore()
    if (!current) {
      return fn.apply(this, args)
    }
    return recordCall(current, what, this, args, fn)
  }
  // Keep `isInheritedReadVersionsAccess` markers and other own properties.
  for (const key of Reflect.ownKeys(fn)) {
    if (key !== 'length' && key !== 'name' && key !== 'prototype') {
      try {
        Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(fn, key)!)
      } catch {
        // non-configurable
      }
    }
  }
  Object.defineProperty(wrapped, 'name', { value: fn.name })
  wrappedFns.add(wrapped)
  return wrapped
}

const wrapHooks = (what: string, hooks: Any): void => {
  if (!hooks || typeof hooks !== 'object') {
    return
  }
  for (const [name, list] of Object.entries<Any>(hooks)) {
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) {
        list[i] = wrap(`${what}.hooks.${name}[${i}]`, list[i])
      }
    }
  }
}

const wrapMethods = (what: string, o: Any, names?: string[]): void => {
  if (!o || typeof o !== 'object') {
    return
  }
  for (const key of names ?? Object.keys(o)) {
    if (typeof o[key] === 'function') {
      o[key] = wrap(`${what}.${key}`, o[key])
    }
  }
}

const DB_METHODS = [
  'beginTransaction',
  'commitTransaction',
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
  'rollbackTransaction',
  'updateGlobal',
  'updateGlobalVersion',
  'updateJobs',
  'updateMany',
  'updateOne',
  'updateVersion',
  'upsert',
]

const LOCAL_API = [
  'count',
  'create',
  'delete',
  'find',
  'findByID',
  'findGlobal',
  'findGlobalVersions',
  'forgotPassword',
  'login',
  'resetPassword',
  'unlock',
  'update',
  'updateGlobal',
  'verifyEmail',
]

const instrument = (payload: Any): void => {
  if (instrumented.has(payload)) {
    return
  }
  instrumented.add(payload)
  staticRoles.set(payload, '$payload')
  staticRoles.set(payload.config, '$config')
  staticRoles.set(payload.db, '$db')
  if (payload.logger) {
    staticRoles.set(payload.logger, '$logger')
  }
  if (payload.email) {
    staticRoles.set(payload.email, '$email')
    wrapMethods('email', payload.email, ['sendEmail'])
  }
  for (const [slug, collection] of Object.entries<Any>(payload.collections ?? {})) {
    staticRoles.set(collection, `collection:${slug}`)
    const config = collection.config
    staticRoles.set(config, `config:${slug}`)
    if (Array.isArray(config.fields)) {
      staticRoles.set(config.fields, `fields:${slug}`)
    }
    if (Array.isArray(config.flattenedFields)) {
      staticRoles.set(config.flattenedFields, `flattenedFields:${slug}`)
    }
    if (config.auth) {
      wrapHooks(slug, config.hooks)
      wrapMethods(`${slug}.access`, config.access)
      wrapMethods(`${slug}.auth.forgotPassword`, config.auth.forgotPassword, [
        'generateEmailHTML',
        'generateEmailSubject',
      ])
    }
  }
  for (const global of payload.config.globals ?? []) {
    staticRoles.set(global, `global:${global.slug}`)
    if (Array.isArray(global.fields)) {
      staticRoles.set(global.fields, `fields:global:${global.slug}`)
    }
    if (Array.isArray(global.flattenedFields)) {
      staticRoles.set(global.flattenedFields, `flattenedFields:global:${global.slug}`)
    }
    wrapHooks(`global:${global.slug}`, global.hooks)
    wrapMethods(`global:${global.slug}.access`, global.access)
  }
  if (payload.config.localization) {
    staticRoles.set(payload.config.localization, '$localization')
    wrapMethods('localization', payload.config.localization, ['filterAvailableLocales'])
  }
  wrapMethods('db', payload.db, DB_METHODS)
  wrapMethods('payload', payload, LOCAL_API)
}
