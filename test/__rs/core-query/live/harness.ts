/**
 * Live differential of the Rust query validation port (crates/payload-core-query `live`) against
 * the upstream TS functions, on real Payload configs with their real access functions.
 *
 * Every case builds fresh inputs, runs the TS reference, then the Rust port (glue.ts) on another
 * fresh copy, and compares (see ./record.ts for what is recorded):
 * - the outcome: return value, or the rejection (class, name, message, status, `data` with
 *   identity, e.g. `QueryError.data === errors`, user-thrown errors by identity tag),
 * - the inputs afterwards (in-place mutations of `where`, `policies`, `errors`, `joins`),
 * - the ordered event log (host calls with full arguments, access function calls, settlements,
 *   and in traced runs every property operation on the inputs),
 * - `req.context` afterwards and the unhandled rejections the run produced.
 * Cases also run concurrently in batches (one shared log), so microtask interleaving between
 * validations and access functions is compared too.
 *
 * Each suite fails when it compared fewer cases than its minimum, so a broken corpus or a
 * skipped config cannot pass silently.
 */
import type { Payload } from 'payload'

import { createPayloadRequest } from 'payload'
import { expect } from 'vitest'

import type { Run } from './record.js'

import { combineQueries } from '../../../../packages/payload/src/database/combineQueries.js'
import { getLocalizedPaths } from '../../../../packages/payload/src/database/getLocalizedPaths.js'
import { prefixWherePaths } from '../../../../packages/payload/src/database/prefixWherePaths.js'
import { validateQueryPaths } from '../../../../packages/payload/src/database/queryValidation/validateQueryPaths.js'
import { validateSearchParam } from '../../../../packages/payload/src/database/queryValidation/validateSearchParams.js'
import { validateSortQuery } from '../../../../packages/payload/src/database/queryValidation/validateSortQuery.js'
import { sanitizeJoinQuery } from '../../../../packages/payload/src/database/sanitizeJoinQuery.js'
import { sanitizeWhereQuery } from '../../../../packages/payload/src/database/sanitizeWhereQuery.js'
import { getFieldByPath } from '../../../../packages/payload/src/utilities/getFieldByPath.js'
import { buildVersionCollectionFields } from '../../../../packages/payload/src/versions/buildCollectionFields.js'
import { buildVersionGlobalFields } from '../../../../packages/payload/src/versions/buildGlobalFields.js'
import {
  appendGlobalVersionToQueryKey,
  appendVersionToQueryKey,
} from '../../../../packages/payload/src/versions/drafts/appendVersionToQueryKey.js'
import { test } from '../../../__helpers/int/vitest.js'
import { trackDatabaseIO } from '../../dispatch/settle.js'
import * as rust from '../glue.js'
import {
  activeRun,
  describe,
  describeError,
  endRun,
  setConfigPath,
  snapshot,
  startRun,
  trace,
  unwrap,
  wrapAccessFunction,
} from './record.js'

export const implementations = {
  rs: rust,
  ts: {
    combineQueries,
    getFieldByPath,
    getLocalizedPaths,
    prefixWherePaths,
    sanitizeJoinQuery,
    sanitizeWhereQuery,
    validateQueryPaths,
    validateSearchParam,
    validateSortQuery,
  },
}

// Both sides running the Rust port (e.g. under vitest.upstream.config.ts, whose aliases redirect
// payload's modules to the glue) would make every comparison pass.
for (const fn of Object.keys(implementations.ts) as (keyof typeof implementations.ts)[]) {
  if (implementations.ts[fn] === (implementations.rs[fn] as unknown)) {
    throw new Error(`core-query live: the TS reference of ${fn} is the Rust port`)
  }
}

type Impl = typeof implementations.ts
export type FnName = keyof Impl

export type Ctx = {
  payload: Payload
  /** A fresh request (own `context`) per run. */
  req: any
}

export type Case = {
  fn: FnName
  /** The argument list, built from fresh inputs (`ctx.req` is the run's request). */
  make: (ctx: Ctx) => { args: unknown[]; inputs: Record<string, unknown> }
  name: string
  /** Request variant (see `ReqVariant`). */
  req: ReqVariant
}

export type ReqVariant = {
  context?: () => Record<string, unknown>
  locale?: unknown
  name: string
  user?: () => unknown
}

// ---------------------------------------------------------------------------------------------
// config instrumentation

const instrumented = new WeakSet<object>()

/** Names every config object by its path and wraps every access function in place (once). */
export const instrumentConfig = (payload: Payload) => {
  const config = payload.config as any
  if (instrumented.has(config)) {
    return
  }
  instrumented.add(config)
  const visited = new WeakSet<object>()
  const visit = (v: any, path: string, depth: number) => {
    if ((typeof v !== 'object' && typeof v !== 'function') || v === null || depth > 40) {
      return
    }
    if (visited.has(v)) {
      return
    }
    visited.add(v)
    if (typeof v === 'object' && !Array.isArray(v) && v.access && typeof v.access === 'object') {
      for (const key of Object.keys(v.access)) {
        wrapAccessFunction(v.access, key, `${path}.access.${key}`)
      }
    }
    setConfigPath(v, path)
    if (typeof v === 'function') {
      return
    }
    for (const key of Object.keys(v)) {
      if (key === 'editor' || key === 'db' || key === 'i18n') {
        continue
      }
      let child: unknown
      try {
        child = v[key]
      } catch {
        continue
      }
      visit(child, `${path}.${key}`, depth + 1)
    }
  }
  visit(config.collections, 'collections', 0)
  visit(config.globals, 'globals', 0)
  visit(config.blocks, 'blocks', 0)
  visit(config.localization, 'localization', 0)
  setConfigPath(config, 'config')
  setConfigPath(payload, 'payload')
  setConfigPath(payload.collections, 'payload.collections')
  for (const [slug, collection] of Object.entries(payload.collections)) {
    setConfigPath(collection as object, `payload.collections.${slug}`)
  }
  if (payload.blocks) {
    setConfigPath(payload.blocks, 'payload.blocks')
  }
  setConfigPath(payload.db, 'payload.db')
}

// ---------------------------------------------------------------------------------------------
// running

/** Extra TS/Rust batch pairs taken when a batch differs (see `Stats.unstable`). */
const UNSTABLE_RERUNS = Number(process.env.RS_CORE_QUERY_RERUNS ?? 4)

const settleTurns = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Waits until every host call of the run settled (access functions may use timers). */
const waitIdle = async (run: Run) => {
  for (let i = 0; i < 500 && run.outstanding > 0; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  await settleTurns()
}

type Outcome = unknown

const callFn = (impl: Impl, fn: FnName, args: unknown[]): unknown =>
  (impl[fn] as (...a: unknown[]) => unknown)(...args)

/**
 * Runs cases with one implementation, concurrently when there are several (one event log),
 * capturing unhandled rejections. Returns one comparable outcome per case plus the shared log.
 */
const runBatch = async (
  ctx: { payload: Payload },
  implName: 'rs' | 'ts',
  cases: Case[],
  traced: boolean,
): Promise<{ events: unknown[]; outcomes: Outcome[]; unhandled: unknown[] }> => {
  const impl = implementations[implName] as Impl
  const variant = cases[0]!.req
  const req: any = await createPayloadRequest({
    context: variant.context?.(),
    locale: variant.locale as string,
    payload: ctx.payload,
    user: variant.user?.() as any,
  })
  if ('locale' in variant && variant.locale !== undefined && typeof variant.locale !== 'string') {
    req.locale = variant.locale
  }
  const built = cases.map((c) => c.make({ payload: ctx.payload, req }))

  const savedListeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(describeError(reason))
  process.on('unhandledRejection', onUnhandled)

  const run = startRun(req, traced)
  // number the inputs first, in case order
  for (const b of built) {
    for (const value of Object.values(b.inputs)) {
      describe(value)
    }
  }
  const settled: { error?: unknown; ok: boolean; value?: unknown }[] = []
  try {
    const promises = built.map((b, i) => {
      const args = traced ? b.args.map((a) => traceArg(a)) : b.args
      let result: unknown
      try {
        result = callFn(impl, cases[i]!.fn, args)
      } catch (error) {
        settled[i] = { error, ok: false }
        activeRun()?.events.push({ case: i, t: 'threw' })
        return undefined
      }
      if (result instanceof Promise) {
        return result.then(
          (value) => {
            settled[i] = { ok: true, value }
            activeRun()?.events.push({ case: i, t: 'resolved' })
          },
          (error) => {
            settled[i] = { error, ok: false }
            activeRun()?.events.push({ case: i, t: 'rejected' })
          },
        )
      }
      settled[i] = { ok: true, value: result }
      activeRun()?.events.push({ case: i, sync: true, t: 'returned' })
      return undefined
    })
    await Promise.race([
      Promise.all(promises),
      new Promise((resolve) => setTimeout(resolve, 10_000).unref()),
    ])
    await waitIdle(run)
  } finally {
    endRun()
    process.off('unhandledRejection', onUnhandled)
    for (const listener of savedListeners) {
      process.on('unhandledRejection', listener as (...args: any[]) => void)
    }
  }

  // snapshots are taken outside the run (no events, no traps), with the run's identities
  const outcomes = built.map((b, i) => {
    const s = settled[i]
    const seen = new Map<object, number>()
    const snap = snapshot(
      {
        context: req.context,
        inputs: b.inputs,
        locale: req.locale,
        result: s?.ok ? unwrap(s.value) : undefined,
      },
      seen,
    )
    return {
      ...snap,
      error: s && !s.ok ? describeError(s.error, seen) : undefined,
      settled: s ? (s.ok ? 'ok' : 'error') : '$timeout',
    }
  })
  return { events: run.events, outcomes, unhandled }
}

const traceArg = (arg: unknown): unknown => {
  if (typeof arg !== 'object' || arg === null || Array.isArray(arg)) {
    return arg
  }
  // the args object itself is the caller's literal: trace the data inputs it holds
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(arg)) {
    const value = (arg as any)[key]
    out[key] = ['errors', 'joins', 'policies', 'sort', 'where'].includes(key) ? trace(value) : value
  }
  return out
}

export const firstDiff = (a: unknown, b: unknown, at = '$'): null | string => {
  if (Object.is(a, b)) {
    return null
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return `${at}: ${JSON.stringify(a)?.slice(0, 400)} != ${JSON.stringify(b)?.slice(0, 400)}`
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.join('\u0000') !== kb.join('\u0000')) {
    return `${at} keys: ${JSON.stringify(ka).slice(0, 400)} != ${JSON.stringify(kb).slice(0, 400)}`
  }
  for (const k of ka) {
    const d = firstDiff((a as any)[k], (b as any)[k], `${at}.${k}`)
    if (d) {
      return d
    }
  }
  return null
}

export type Stats = {
  batches: number
  cases: number
  diffs: string[]
  /**
   * Batches whose first TS/Rust pair differed but where a re-run Rust batch equals a re-run (or
   * the first) TS batch: TS is not deterministic there (on MongoDB, access functions doing
   * database I/O settle in network order). Listed, not counted as diffs.
   */
  unstable?: string[]
  errorsCompared: number
  events: number
  hostCalls: number
  tracedBatches: number
  traceEvents: number
  unhandled: number
}

const countEvents = (events: unknown[], stats: Stats) => {
  for (const e of events as { t: string }[]) {
    stats.events++
    if (e.t === 'getEntityPermissions' || e.t === 'executeAccess') {
      stats.hostCalls++
    }
    if (['def', 'del', 'desc', 'get', 'has', 'keys', 'proto', 'set'].includes(e.t)) {
      stats.traceEvents++
    }
  }
}

/** Runs the cases one by one and in concurrent batches, each traced and untraced. */
export const runDifferential = async (
  payload: Payload,
  cases: Case[],
  { batchSize = 6 }: { batchSize?: number } = {},
): Promise<Stats> => {
  // counts in-flight database calls (access functions query the database); with RS_ORDERED_IO=true
  // their results are delivered in call order (test/__rs/dispatch/settle.ts)
  trackDatabaseIO(payload)
  instrumentConfig(payload)
  const stats: Stats = {
    batches: 0,
    cases: 0,
    diffs: [],
    errorsCompared: 0,
    events: 0,
    hostCalls: 0,
    traceEvents: 0,
    tracedBatches: 0,
    unhandled: 0,
  }
  const groups: Case[][] = []
  // singles, then concurrent batches of cases sharing a request variant
  for (const c of cases) {
    groups.push([c])
  }
  const byVariant = new Map<string, Case[]>()
  for (const c of cases) {
    if (
      c.fn === 'validateQueryPaths' ||
      c.fn === 'validateSortQuery' ||
      c.fn === 'sanitizeJoinQuery'
    ) {
      const list = byVariant.get(c.req.name) ?? []
      list.push(c)
      byVariant.set(c.req.name, list)
    }
  }
  for (const list of byVariant.values()) {
    for (let i = 0; i < list.length; i += batchSize) {
      groups.push(list.slice(i, i + batchSize))
    }
  }

  let index = 0
  for (const group of groups) {
    const traced = index++ % 2 === 1
    const ts = await runBatch({ payload }, 'ts', group, traced)
    const rs = await runBatch({ payload }, 'rs', group, traced)
    stats.batches++
    if (traced) {
      stats.tracedBatches++
    }
    stats.cases += group.length
    countEvents(ts.events, stats)
    stats.unhandled += ts.unhandled.length
    stats.errorsCompared += ts.outcomes.filter((o: any) => o.error).length
    const label = `${group.map((c) => c.name).join(' | ')}${traced ? ' [traced]' : ''}`
    const diffOf = (a: typeof ts, b: typeof rs) =>
      firstDiff(a.outcomes, b.outcomes, '$outcomes') ??
      firstDiff(a.events, b.events, '$events') ??
      firstDiff(a.unhandled, b.unhandled, '$unhandled')
    const d = diffOf(ts, rs)
    if (d) {
      const tsRuns = [ts]
      const rsRuns = [rs]
      let isUnstable = false
      for (let i = 0; i < UNSTABLE_RERUNS && !isUnstable; i++) {
        tsRuns.push(await runBatch({ payload }, 'ts', group, traced))
        rsRuns.push(await runBatch({ payload }, 'rs', group, traced))
        isUnstable = rsRuns.some((r) => tsRuns.some((t) => !diffOf(t, r)))
      }
      if (isUnstable) {
        const isTsSelfDiffering = tsRuns.some((t) => diffOf(tsRuns[0]!, t))
        ;(stats.unstable ??= []).push(
          `${label}: ${d}${isTsSelfDiffering ? ' (TS differs from itself)' : ''}`,
        )
      } else {
        stats.diffs.push(`${label}: ${d}`)
      }
    }
  }
  return stats
}

// ---------------------------------------------------------------------------------------------
// corpus generation from a config

const VALID_OPERATORS = [
  'equals',
  'contains',
  'not_equals',
  'in',
  'all',
  'not_in',
  'exists',
  'greater_than',
  'greater_than_equal',
  'less_than',
  'less_than_equal',
  'like',
  'not_like',
  'within',
  'intersects',
  'near',
]

const valueFactories: (() => unknown)[] = [
  () => 'x',
  () => 1,
  () => null,
  () => true,
  () => [1, 'x'],
  () => ({ name: { equals: 'x' } }),
  () => [{ a: 1 }],
  () => ({ title: { exists: true } }),
  () => ({ id: { equals: 1 } }),
]

type Entity = { config: any; kind: 'collection' | 'global' }

const entitiesOf = (payload: Payload): Entity[] => [
  ...payload.config.collections.map((config) => ({ config, kind: 'collection' as const })),
  ...(payload.config.globals ?? []).map((config) => ({ config, kind: 'global' as const })),
]

/** Query paths of an entity: fields, nested, relationship hops, blocks, locales, specials. */
export const pathsOf = (payload: Payload, entity: Entity, max = 80): string[] => {
  const out: string[] = []
  const codes: string[] = (payload.config.localization as any)?.localeCodes ?? []
  const walk = (fields: any[], prefix: string, depth: number) => {
    for (const field of fields ?? []) {
      if (out.length >= max) {
        return
      }
      if (!field?.name) {
        continue
      }
      const path = prefix ? `${prefix}.${field.name}` : field.name
      out.push(path)
      if (field.localized && codes[0]) {
        out.push(`${path}.${codes[codes.length - 1]}`)
      }
      if (depth >= 2) {
        continue
      }
      if (field.type === 'blocks') {
        out.push(`${path}.blockType`)
        for (const block of field.blocks ?? []) {
          const b = typeof block === 'string' ? (payload.blocks as any)?.[block] : block
          walk((b?.flattenedFields ?? []).slice(0, 4), path, depth + 1)
        }
      } else if (Array.isArray(field.flattenedFields)) {
        walk(field.flattenedFields.slice(0, 6), path, depth + 1)
      } else if (field.type === 'relationship' || field.type === 'upload') {
        if (typeof field.relationTo === 'string') {
          out.push(`${path}.id`)
          const related = payload.collections[field.relationTo]?.config
          walk((related?.flattenedFields ?? []).slice(0, 5), path, depth + 1)
        } else {
          out.push(`${path}.value`, `${path}.relationTo`, `${path}.nope`)
        }
      } else if (field.type === 'join' && typeof field.collection === 'string') {
        const related = payload.collections[field.collection]?.config
        walk((related?.flattenedFields ?? []).slice(0, 4), path, depth + 1)
      } else if (field.type === 'json' || field.type === 'richText') {
        out.push(`${path}.a.b`, `${path}.a-b`)
      }
    }
  }
  walk(entity.config.flattenedFields, '', 0)
  out.push('id', '_id', 'nope', 'nope.deep', 'relationTo', 'globalType', 'hash', 'salt')
  const first = entity.config.flattenedFields.find((f: any) => f.name)?.name
  if (first) {
    out.push(`${first}__x`, `${first}.${codes[0] ?? 'en'}`)
  }
  return out
}

export const wheresOf = (paths: string[]): (() => Record<string, unknown>)[] => {
  const wheres: (() => Record<string, unknown>)[] = []
  paths.forEach((path, i) => {
    const op = i % 9 === 8 ? 'foo' : VALID_OPERATORS[(i * 5) % VALID_OPERATORS.length]!
    const value = valueFactories[(i * 7) % valueFactories.length]!
    wheres.push(() => ({ [path]: { [op]: value() } }))
  })
  for (let i = 0; i + 2 < paths.length; i += 3) {
    const [a, b, c] = [paths[i]!, paths[i + 1]!, paths[i + 2]!]
    wheres.push(() => ({
      and: [{ [a]: { equals: 'x' } }, { [b]: { exists: true } }],
      or: [{ [c]: { in: [1] } }],
    }))
    wheres.push(() => ({ [a]: [1], OR: [{ [b]: { contains: { name: { equals: 'x' } } } }] }))
  }
  wheres.push(() => ({}))
  wheres.push(() => ({ nope: 'abc' }))
  return wheres
}

/** `localizedPath` arguments of getFieldByPath (fresh values per run). */
const localizedPathArgs: (() => unknown)[] = [
  () => undefined,
  () => '',
  () => null,
  () => 0,
  () => false,
  () => NaN,
  () => 'pre',
  () => 'a.<locale>',
  () => 1,
  () => true,
  () => ({ toString: () => 'obj' }),
  () => ['x', 'y'],
  () => Symbol('localizedPath'),
  () => ({
    toString() {
      throw new Error('localizedPath toString')
    },
  }),
]

/**
 * Cases for every entity of the config: validateQueryPaths (plain, versions, polymorphicJoin,
 * showHiddenFields, caller policies/errors), validateSortQuery, sanitizeJoinQuery,
 * getLocalizedPaths, getFieldByPath, sanitizeWhereQuery, combineQueries, prefixWherePaths.
 */
export const generateCorpus = (
  payload: Payload,
  variants: ReqVariant[],
  { maxPaths = 60 }: { maxPaths?: number } = {},
): Case[] => {
  const cases: Case[] = []
  for (const entity of entitiesOf(payload)) {
    const slug = entity.config.slug
    const isCollection = entity.kind === 'collection'
    const configArg = isCollection
      ? { collectionConfig: entity.config }
      : { globalConfig: entity.config }
    const paths = pathsOf(payload, entity, maxPaths)
    const wheres = wheresOf(paths)
    const drafts = Boolean(entity.config.versions?.drafts)
    const versionFields = drafts
      ? isCollection
        ? buildVersionCollectionFields(payload.config, entity.config, true)
        : buildVersionGlobalFields(payload.config, entity.config, true)
      : undefined

    variants.forEach((req, v) => {
      wheres.forEach((where, w) => {
        const name = `${slug}#${w} ${req.name}`
        cases.push({
          fn: 'validateQueryPaths',
          make: ({ req: r }) => {
            const inputs = { where: where() }
            return {
              args: [{ ...configArg, overrideAccess: false, req: r, where: inputs.where }],
              inputs,
            }
          },
          name: `vqp ${name}`,
          req,
        })
        if ((w + v) % 4 === 0) {
          cases.push({
            fn: 'validateQueryPaths',
            make: ({ req: r }) => {
              const inputs = {
                errors: w % 8 === 0 ? [{ path: 'earlier' }] : [],
                policies: { collections: {}, globals: {} },
                where: where(),
              }
              return {
                args: [
                  {
                    ...configArg,
                    errors: inputs.errors,
                    overrideAccess: w % 3 === 0,
                    policies: inputs.policies,
                    polymorphicJoin: w % 2 === 0,
                    req: r,
                    showHiddenFields: w % 5 === 0,
                    where: inputs.where,
                  },
                ],
                inputs,
              }
            },
            name: `vqp+ ${name}`,
            req,
          })
        }
        if (versionFields && (w + v) % 3 === 0) {
          cases.push({
            fn: 'validateQueryPaths',
            make: ({ req: r }) => {
              const inputs = {
                where: isCollection
                  ? appendVersionToQueryKey(where())
                  : appendGlobalVersionToQueryKey(where()),
              }
              return {
                args: [
                  {
                    ...configArg,
                    overrideAccess: false,
                    req: r,
                    versionFields,
                    where: inputs.where,
                  },
                ],
                inputs,
              }
            },
            name: `vqp-versions ${name}`,
            req,
          })
        }
      })
      paths.forEach((path, p) => {
        if (p % 2 === 1) {
          return
        }
        const sorts = [path, `-${path}`, [path, `-${paths[(p + 3) % paths.length]}`]]
        const sort = sorts[p % 3]
        cases.push({
          fn: 'validateSortQuery',
          make: ({ req: r }) => {
            const inputs = { sort: structuredClone(sort) }
            return {
              args: [
                {
                  ...configArg,
                  overrideAccess: false,
                  req: r,
                  sort: inputs.sort,
                  versionFields: p % 4 === 0 ? versionFields : undefined,
                },
              ],
              inputs,
            }
          },
          name: `sort ${slug} ${JSON.stringify(sort)} ${req.name}`,
          req,
        })
      })
      if (
        isCollection &&
        ((entity.config.joins && Object.keys(entity.config.joins).length > 0) ||
          entity.config.polymorphicJoins?.length)
      ) {
        const joinPaths: string[] = [
          ...Object.values(entity.config.joins ?? {}).flatMap((list: any) =>
            list.map((j: any) => j.joinPath),
          ),
          ...(entity.config.polymorphicJoins ?? []).map((j: any) => j.joinPath),
        ]
        const joinInputs: (() => unknown)[] = [
          () => undefined,
          () => false,
          () => ({}),
          ...joinPaths.flatMap((joinPath, j) => [
            () => ({ [joinPath]: false }),
            () => ({
              [joinPath]: { sort: j % 2 ? 'nope' : '-id', where: wheres[j % wheres.length]!() },
            }),
            () => ({ [joinPath]: { where: { id: { exists: true } } } }),
            () => ({ [joinPath]: true }),
          ]),
        ]
        joinInputs.forEach((joins, j) => {
          cases.push({
            fn: 'sanitizeJoinQuery',
            make: ({ req: r }) => {
              const inputs = { joins: joins() }
              return {
                args: [
                  {
                    collectionConfig: entity.config,
                    joins: inputs.joins,
                    overrideAccess: j % 5 === 4,
                    req: r,
                  },
                ],
                inputs,
              }
            },
            name: `joins ${slug}#${j} ${req.name}`,
            req,
          })
        })
      }
    })

    // synchronous utilities (request independent except for the locale)
    const req = variants[0]!
    paths.forEach((path, p) => {
      cases.push({
        fn: 'getLocalizedPaths',
        make: ({ payload: pl, req: r }) => ({
          args: [
            {
              collectionSlug: isCollection ? slug : undefined,
              fields: entity.config.flattenedFields,
              globalSlug: isCollection ? (p % 3 === 0 ? 'some-global' : undefined) : slug,
              incomingPath: path,
              locale: r.locale,
              overrideAccess: p % 2 === 0,
              parentIsLocalized: p % 4 === 1 ? true : undefined,
              payload: pl,
              showHiddenFields: p % 3 === 1,
            },
          ],
          inputs: {},
        }),
        name: `glp ${slug} ${path}`,
        req,
      })
      cases.push({
        fn: 'getFieldByPath',
        make: ({ payload: pl }) => ({
          args: [
            {
              config: p % 2 === 0 ? pl.config : undefined,
              fields: entity.config.flattenedFields,
              includeRelationships: p % 3 !== 2,
              path,
            },
          ],
          inputs: {},
        }),
        name: `gfbp ${slug} ${path}`,
        req,
      })
      // `localizedPath` of any type: truthiness, then ToString, in the first iteration
      const localizedPath = localizedPathArgs[p % localizedPathArgs.length]!
      cases.push({
        fn: 'getFieldByPath',
        make: ({ payload: pl }) => ({
          args: [
            {
              config: p % 2 === 1 ? pl.config : undefined,
              fields: entity.config.flattenedFields,
              includeRelationships: p % 3 === 2,
              localizedPath: localizedPath(),
              path,
            },
          ],
          inputs: {},
        }),
        name: `gfbp ${slug} ${path} localizedPath#${p % localizedPathArgs.length}`,
        req,
      })
    })
    // malformed arguments: non-string paths
    for (const [i, path] of (
      [undefined, null, 7, ['a', 'b'], { split: undefined }] as unknown[]
    ).entries()) {
      cases.push({
        fn: 'getFieldByPath',
        make: () => ({
          args: [{ fields: entity.config.flattenedFields, localizedPath: 'x', path }],
          inputs: {},
        }),
        name: `gfbp ${slug} non-string path#${i}`,
        req,
      })
    }
    if (isCollection) {
      // nullish / primitive / getter join entries (`const { joinPath } = join` and the reads after it)
      const joinEntries: (() => unknown)[] = [
        () => null,
        () => undefined,
        () => 5,
        () => ({
          get joinPath() {
            throw new Error('joinPath getter')
          },
        }),
      ]
      joinEntries.forEach((join, j) => {
        for (const polymorphic of [false, true]) {
          cases.push({
            fn: 'sanitizeJoinQuery',
            make: ({ req: r }) => {
              const inputs = { joins: {} }
              const collectionConfig = {
                ...entity.config,
                joins: polymorphic ? {} : { [slug]: [join()] },
                polymorphicJoins: polymorphic ? [join()] : [],
              }
              return {
                args: [
                  { collectionConfig, joins: inputs.joins, overrideAccess: j % 2 === 0, req: r },
                ],
                inputs,
              }
            },
            name: `joins ${slug} malformed join#${j}${polymorphic ? ' polymorphic' : ''}`,
            req,
          })
        }
      })
    }
    wheres.forEach((where, w) => {
      if (!isCollection) {
        return
      }
      cases.push({
        fn: 'sanitizeWhereQuery',
        make: ({ payload: pl }) => {
          const inputs = { where: where() }
          return {
            args: [{ fields: entity.config.flattenedFields, payload: pl, where: inputs.where }],
            inputs,
          }
        },
        name: `swq ${slug}#${w}`,
        req,
      })
      if (w % 4 === 0) {
        cases.push({
          fn: 'prefixWherePaths',
          make: () => {
            const inputs = { where: where() }
            return { args: [{ prefix: 'rel', where: inputs.where }], inputs }
          },
          name: `pwp ${slug}#${w}`,
          req,
        })
        cases.push({
          fn: 'combineQueries',
          make: () => {
            const inputs = { access: w % 8 === 0 ? true : { x: { equals: 1 } }, where: where() }
            return { args: [inputs.where, inputs.access], inputs }
          },
          name: `cq ${slug}#${w}`,
          req,
        })
      }
    })
  }
  return cases
}

/** The first user of the first auth collection, read once (fresh copies per run). */
export const findUser = async (payload: Payload) => {
  const auth = payload.config.collections.find((c) => c.auth)
  if (!auth) {
    return undefined
  }
  const { docs } = await payload.find({
    collection: auth.slug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
  })
  const user = docs[0]
  return user ? () => ({ ...structuredClone(user), collection: auth.slug }) : undefined
}

export type SuiteOptions = {
  /** Extra hand-written cases (adversarial inputs). */
  extraCases?: (payload: Payload, variants: ReqVariant[]) => Case[]
  /** Fails the suite when fewer cases were compared. */
  minCases: number
  /** Fails the suite when fewer host calls (getEntityPermissions / executeAccess) were compared. */
  minHostCalls: number
  name: string
  /** Request variants (default: anonymous, first user, `locale: 'all'`). */
  variants?: (payload: Payload, base: ReqVariant[]) => ReqVariant[]
}

export const reqVariants = async (payload: Payload): Promise<ReqVariant[]> => {
  const user = await findUser(payload)
  const localization = payload.config.localization as any
  const variants: ReqVariant[] = [
    { locale: localization ? localization.defaultLocale : undefined, name: 'anonymous' },
  ]
  if (user) {
    variants.push({
      locale: localization ? localization.localeCodes.at(-1) : undefined,
      name: 'user',
      user,
    })
  }
  if (localization) {
    variants.push({ locale: 'all', name: 'all', user })
  }
  return variants
}

export const registerLiveDifferential = ({
  extraCases,
  minCases,
  minHostCalls,
  name,
}: SuiteOptions) => {
  test(`${name}: TS and Rust query validation agree`, async ({ payload }: { payload: Payload }) => {
    const variants = await reqVariants(payload)
    const cases = [...generateCorpus(payload, variants), ...(extraCases?.(payload, variants) ?? [])]
    const stats = await runDifferential(payload, cases)
    const summary = { ...stats, diffs: stats.diffs.length, unstable: stats.unstable?.length ?? 0 }
    console.log(`[core-query live] ${name}: ${JSON.stringify(summary)}`)
    if (stats.diffs.length) {
      console.log(stats.diffs.slice(0, 15).join('\n\n'))
    }
    expect(stats.cases).toBeGreaterThanOrEqual(minCases)
    expect(stats.hostCalls).toBeGreaterThanOrEqual(minHostCalls)
    expect(stats.tracedBatches).toBeGreaterThan(0)
    expect(stats.diffs).toEqual([])
  }, 1_800_000)
}
