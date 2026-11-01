/**
 * Registers differential afterRead tests (TS reference vs Rust core runtime) for every collection
 * and global of the suite's config. See differential.ts.
 */
import type { Payload } from 'payload'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'

import type { RunOutcome, Variant } from './differential.js'

import { test } from '../../__helpers/int/vitest.js'
import { instrument, runAfterRead } from './differential.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export type DiffStats = {
  callbacksCompared: number
  diffs: string[]
  docsCompared: number
  rejectionsCompared?: number
  runs: number
  tracedRuns?: number
  traceEventsCompared?: number
  /**
   * Cases whose first TS/Rust pair differed but where a re-run Rust outcome equals a re-run (or
   * the first) TS outcome: the TS reference itself is not deterministic there (on MongoDB a hook
   * awaiting `setImmediate` races the network I/O of population). Listed, not counted as diffs.
   */
  unstable?: string[]
}

/** Extra TS/Rust run pairs taken when a case differs (see `DiffStats.unstable`). */
const UNSTABLE_RERUNS = Number(process.env.RS_CORE_RUNTIME_RERUNS ?? 4)

/** A run that never settles is reported as an outcome instead of stalling the suite. */
const withTimeout = (promise: Promise<RunOutcome>, ms = 10_000): Promise<RunOutcome> =>
  Promise.race([
    promise,
    new Promise<RunOutcome>((resolve) =>
      setTimeout(
        () =>
          resolve({ contextAfter: null, docs: null, error: '$timeout', events: [], identity: [] }),
        ms,
      ).unref(),
    ),
  ])

/** First difference between two snapshots, as `path: ts != rs`. */
export const firstDiff = (a: unknown, b: unknown, at = '$'): null | string => {
  if (Object.is(a, b)) {
    return null
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return `${at}: ${JSON.stringify(a)?.slice(0, 300)} != ${JSON.stringify(b)?.slice(0, 300)}`
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.join('\u0000') !== kb.join('\u0000')) {
    return `${at} keys: ${JSON.stringify(ka).slice(0, 300)} != ${JSON.stringify(kb).slice(0, 300)}`
  }
  for (const k of ka) {
    const d = firstDiff((a as any)[k], (b as any)[k], `${at}.${k}`)
    if (d) {
      return d
    }
  }
  return null
}

/**
 * Replaces ObjectIds generated during the run (24-hex strings absent from the input docs, e.g.
 * from row-id `defaultValue` functions) with `$generatedID#n` in order of first appearance, so
 * the two engines' independently generated ids compare equal when they are produced at the same
 * points.
 */
const canonicalizeGeneratedIDs = (value: unknown, inputJSON: string): unknown => {
  const ids = new Map<string, string>()
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string' && /^[0-9a-f]{24}$/.test(v) && !inputJSON.includes(v)) {
      let id = ids.get(v)
      if (!id) {
        id = `$generatedID#${ids.size}`
        ids.set(v, id)
      }
      return id
    }
    if (Array.isArray(v)) {
      return v.map(walk)
    }
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    }
    return v
  }
  return walk(value)
}

const variantsFor = (payload: Payload, firstFieldName?: string): Variant[] => {
  const variants: Variant[] = [
    { name: 'base', depth: 0, overrideAccess: true, showHiddenFields: false },
    { name: 'access', depth: 0, overrideAccess: false, showHiddenFields: false },
    { name: 'hidden', depth: 0, overrideAccess: false, showHiddenFields: true },
    { name: 'depth2', depth: 2, overrideAccess: false, showHiddenFields: false, draft: true },
  ]
  if (firstFieldName) {
    variants.push(
      {
        name: 'select-include',
        depth: 0,
        overrideAccess: true,
        select: { [firstFieldName]: true },
        showHiddenFields: false,
      },
      {
        name: 'select-exclude',
        depth: 0,
        overrideAccess: true,
        select: { [firstFieldName]: false },
        showHiddenFields: false,
      },
    )
  }
  const localization = payload.config.localization
  if (localization) {
    const codes = localization.localeCodes
    variants.push(
      { name: 'all', depth: 0, locale: 'all', overrideAccess: true, showHiddenFields: false },
      {
        name: 'flatten-fallback',
        depth: 0,
        fallbackLocale: localization.defaultLocale,
        locale: codes[1] ?? codes[0],
        overrideAccess: true,
        showHiddenFields: false,
      },
      {
        name: 'flatten-fallback-list',
        depth: 1,
        fallbackLocale: [...codes].reverse(),
        locale: codes[codes.length - 1],
        overrideAccess: false,
        showHiddenFields: false,
      },
      {
        name: 'flatten-no-fallback',
        depth: 0,
        fallbackLocale: false,
        locale: codes[0],
        overrideAccess: true,
        showHiddenFields: true,
      },
      {
        name: 'no-flatten',
        depth: 0,
        flattenLocales: false,
        locale: codes[0],
        overrideAccess: true,
        showHiddenFields: false,
      },
    )
  }
  return variants
}

/** Raw (pre-afterRead) docs as the find operation would see them. */
const rawDocsFor = async (
  payload: Payload,
  target: { collection?: string; global?: string },
  locale: string | undefined,
  limit: number,
): Promise<Record<string, unknown>[]> => {
  const dbLocale = locale === 'all' || payload.config.localization ? 'all' : locale
  if (target.collection) {
    const result = await payload.db.find({
      collection: target.collection,
      limit,
      locale: dbLocale,
      pagination: false,
      sort: 'id',
    } as any)
    return [...(result.docs as Record<string, unknown>[]), { id: 'rs-synthetic-empty' }]
  }
  const doc = await payload.db.findGlobal({ slug: target.global!, locale: dbLocale } as any)
  return [doc ?? {}, {}]
}

/**
 * Registers the differential suite. `docsPerCollection` caps the number of seeded docs per
 * collection (a synthetic empty doc is always added).
 */
export const registerDifferentialSuite = ({
  configPath,
  docsPerCollection = 4,
  extraDocs = {},
  extraVariants = {},
  name,
}: {
  configPath: string
  docsPerCollection?: number
  /** Per collection slug: factory for extra raw docs (edge shapes), called once per run. */
  extraDocs?: Record<string, () => Record<string, unknown>[]>
  /** Per collection slug: additional variants. */
  extraVariants?: Record<string, Variant[]>
  name: string
}) => {
  test.suite(name, { config: configPath, resetBetweenTests: false }, () => {
    test(
      'afterRead: Rust core runtime matches TS (docs, callback order/args, errors)',
      { timeout: 1_800_000 },
      async ({ payload }) => {
        instrument(payload)
        const stats: DiffStats = { callbacksCompared: 0, diffs: [], docsCompared: 0, runs: 0 }

        const targets = [
          ...payload.config.collections.map((c) => ({ collection: c, global: undefined })),
          ...payload.config.globals.map((g) => ({ collection: undefined, global: g })),
        ]

        for (const target of targets) {
          const config = (target.collection ?? target.global)!
          const firstFieldName = (config.fields as any[]).find(
            (f) => 'name' in f && f.name !== 'id',
          )?.name
          for (const variant of [
            ...variantsFor(payload, firstFieldName),
            ...(extraVariants[config.slug] ?? []),
          ]) {
            const rawDocs = await rawDocsFor(
              payload,
              target.collection
                ? { collection: target.collection.slug }
                : { global: target.global!.slug },
              variant.locale,
              docsPerCollection,
            )
            const factory = extraDocs[config.slug]
            // Seeded docs together (sequential and concurrent), then each edge doc on its own so
            // an expected rejection does not hide the docs after it.
            const docSets: { factory?: typeof factory; label: string; rawDocs: typeof rawDocs }[] =
              [
                { label: 'seeded', rawDocs },
                ...(factory?.() ?? []).map((_, i) => ({
                  factory: () => [factory!()[i]!],
                  label: `edge#${i}`,
                  rawDocs: [],
                })),
              ]
            for (const docSet of docSets) {
              // afterRead (sequential/concurrent, plain/traced), then the exported traverseFields
              // (sequential plain, concurrent traced) with root and with nested-call arguments
              const modes: [boolean, boolean, 'nested' | boolean][] = [
                ...(target.collection ? [false, true] : [false]).flatMap(
                  (c): [boolean, boolean, boolean][] => [
                    [c, false, false],
                    [c, true, false],
                  ],
                ),
                [false, false, true],
                [false, false, 'nested'],
                ...(target.collection
                  ? ([
                      [true, true, true],
                      [true, true, 'nested'],
                    ] as [boolean, boolean, 'nested' | boolean][])
                  : []),
              ]
              for (const [concurrent, trace, traverse] of modes) {
                const run = (engine: 'rs' | 'ts'): Promise<RunOutcome> =>
                  runAfterRead({
                    collection: target.collection,
                    concurrent,
                    engine,
                    global: target.global,
                    payload,
                    rawDocs: docSet.rawDocs,
                    rawDocsFactory: docSet.factory,
                    trace,
                    traverse,
                    variant: { ...variant, findMany: concurrent || undefined },
                  })
                const ts = await withTimeout(run('ts'))
                const rs = await withTimeout(run('rs'))
                stats.runs++
                if (trace) {
                  stats.tracedRuns = (stats.tracedRuns ?? 0) + 1
                  stats.traceEventsCompared =
                    (stats.traceEventsCompared ?? 0) +
                    ts.events.filter((e) => (e as { op?: string }).op).length
                }
                stats.docsCompared += (ts.docs as unknown[]).length
                stats.callbacksCompared += ts.events.filter(
                  (e) => !(e as { op?: string }).op,
                ).length
                if (ts.error) {
                  stats.rejectionsCompared = (stats.rejectionsCompared ?? 0) + 1
                }
                const inputJSON = JSON.stringify(docSet.rawDocs)
                const diff = firstDiff(
                  canonicalizeGeneratedIDs(ts, inputJSON),
                  canonicalizeGeneratedIDs(rs, inputJSON),
                )
                if (diff) {
                  const label = `${config.slug} [${variant.name}, ${docSet.label}${concurrent ? ', concurrent' : ''}${trace ? ', traced' : ''}${traverse ? `, traverseFields${traverse === 'nested' ? ' nested' : ''}` : ''}]`
                  const tsOutcomes = [canonicalizeGeneratedIDs(ts, inputJSON)]
                  const rsOutcomes = [canonicalizeGeneratedIDs(rs, inputJSON)]
                  let isUnstable = false
                  for (let i = 0; i < UNSTABLE_RERUNS && !isUnstable; i++) {
                    tsOutcomes.push(canonicalizeGeneratedIDs(await withTimeout(run('ts')), inputJSON))
                    rsOutcomes.push(canonicalizeGeneratedIDs(await withTimeout(run('rs')), inputJSON))
                    isUnstable = rsOutcomes.some((r) => tsOutcomes.some((t) => !firstDiff(t, r)))
                  }
                  if (isUnstable) {
                    const isTsSelfDiffering = tsOutcomes.some((t) => firstDiff(tsOutcomes[0], t))
                    ;(stats.unstable ??= []).push(
                      `${label} ${diff}${isTsSelfDiffering ? ' (TS differs from itself)' : ''}`,
                    )
                  } else {
                    stats.diffs.push(`${label} ${diff}`)
                  }
                }
              }
            }
          }
        }

        const resultsDir = path.resolve(dirname, 'results')
        fs.mkdirSync(resultsDir, { recursive: true })
        fs.writeFileSync(
          path.resolve(resultsDir, `${name.replace(/[^\w-]+/g, '_')}.json`),
          JSON.stringify(stats, null, 2),
        )
        console.log(
          `[core-runtime] ${name}: runs=${stats.runs} (traced=${stats.tracedRuns ?? 0}) docs=${stats.docsCompared} callbackEvents=${stats.callbacksCompared} docTraceEvents=${stats.traceEventsCompared ?? 0} rejections=${stats.rejectionsCompared ?? 0} diffs=${stats.diffs.length} unstable=${stats.unstable?.length ?? 0}`,
        )
        // a run that compared nothing must not pass
        expect(stats.runs).toBeGreaterThan(0)
        expect(stats.docsCompared).toBeGreaterThan(0)
        expect(stats.diffs).toEqual([])
      },
    )
  })
}
