/**
 * Registers differential tests (TS reference vs Rust core runtime) of `afterChange` (every
 * collection and global) and `beforeDuplicate` (every collection) for a config. See
 * differential.ts.
 */
import type { Payload } from 'payload'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'

import type { AfterChangeCase, RunOutcome } from './differential.js'

import { getCoreRuntime } from '../../../packages/engine-rs/src/runtime/index.js'
import { test } from '../../__helpers/int/vitest.js'
import { instrument, runAfterChange, runBeforeDuplicate } from './differential.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

type DiffStats = {
  callbackEvents: number
  diffs: string[]
  docs: number
  rejections: number
  runs: number
  unhandledRejections: number
}

/** A run that never settles is reported as an outcome instead of stalling the suite. */
const withTimeout = (promise: Promise<RunOutcome>, ms = 10_000): Promise<RunOutcome> =>
  Promise.race([
    promise,
    new Promise<RunOutcome>((resolve) =>
      setTimeout(
        () =>
          resolve({
            contextAfter: null,
            docs: null,
            error: '$timeout',
            events: [],
            identity: [],
            unhandled: [],
          }),
        ms,
      ).unref(),
    ),
  ])

/** First difference between two snapshots, as `path: ts != rs`. */
const firstDiff = (a: unknown, b: unknown, at = '$'): null | string => {
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
 * Replaces ObjectIds generated during the run (24-hex strings absent from the inputs, e.g. new
 * row ids from `baseIDField`'s beforeDuplicate hook) with `$generatedID#n` in order of first
 * appearance, so the engines' independently generated ids compare equal when produced at the same
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

type Target = {
  collection?: Payload['config']['collections'][number]
  global?: Payload['config']['globals'][number]
}

/** DB docs as the operations see them (`locale: 'all'` gives raw locale maps). */
const rawDocsFor = async (
  payload: Payload,
  target: Target,
  locale: string | undefined,
  limit: number,
): Promise<Record<string, unknown>[]> => {
  if (target.collection) {
    const result = await payload.db.find({
      collection: target.collection.slug,
      limit,
      locale,
      pagination: false,
      sort: 'id',
    } as any)
    return result.docs as Record<string, unknown>[]
  }
  const doc = await payload.db.findGlobal({ slug: target.global!.slug, locale } as any)
  return doc ? [doc as Record<string, unknown>] : []
}

/**
 * A doc generated from the field schema (every data field filled, two rows per array, one row per
 * block), so collections the config does not seed are covered too. With `localeCodes`, localized
 * fields hold locale maps (the `locale: 'all'` shape).
 */
export const sampleDoc = (
  payload: Payload,
  fields: any[],
  seed: number,
  localeCodes?: string[],
): Record<string, unknown> => {
  let rowCounter = 0
  const fill = (
    fields: any[],
    out: Record<string, unknown>,
    parentLocalized: boolean,
    depth: number,
  ) => {
    for (const field of fields) {
      if (!field || field.type === 'ui' || field.type === 'join') {
        continue
      }
      if (!('name' in field)) {
        if (field.type === 'tabs') {
          for (const tab of field.tabs) {
            if ('name' in tab) {
              const localized = Boolean(tab.localized) && !parentLocalized
              const make = () => fill(tab.fields, {}, parentLocalized || localized, depth + 1)
              out[tab.name] =
                localized && localeCodes
                  ? Object.fromEntries(localeCodes.map((code) => [code, make()]))
                  : make()
            } else {
              fill(tab.fields, out, parentLocalized, depth)
            }
          }
        } else if (Array.isArray(field.fields)) {
          fill(field.fields, out, parentLocalized, depth)
        }
        continue
      }
      const localized = Boolean(field.localized) && !parentLocalized
      const make = (variant: number) =>
        value(field, parentLocalized || localized, depth, seed * 10 + variant)
      out[field.name] =
        localized && localeCodes
          ? Object.fromEntries(localeCodes.map((code, i) => [code, make(i)]))
          : make(0)
    }
    return out
  }
  const value = (field: any, parentLocalized: boolean, depth: number, n: number): unknown => {
    const many = (v: () => unknown) => (field.hasMany ? [v(), v()] : v())
    switch (field.type) {
      case 'array':
        return depth > 3
          ? []
          : [0, 1].map(() => ({
              id: `row-${seed}-${rowCounter++}`,
              ...fill(field.fields, {}, parentLocalized, depth + 1),
            }))
      case 'blocks': {
        if (depth > 3) {
          return []
        }
        const blocks = [...(field.blockReferences ?? field.blocks)].map((b: any) =>
          typeof b === 'string' ? payload.blocks[b] : b,
        )
        return blocks.filter(Boolean).map((block: any) => ({
          blockType: block.slug,
          id: `block-${seed}-${rowCounter++}`,
          ...fill(block.fields, {}, parentLocalized, depth + 1),
        }))
      }
      case 'checkbox':
        return n % 2 === 0
      case 'date':
        return new Date(Date.UTC(2020, 0, 1 + n)).toISOString()
      case 'group':
        return fill(field.fields, {}, parentLocalized, depth + 1)
      case 'json':
        return { n, nested: { list: [n, n + 1] } }
      case 'number':
        return many(() => n + 1)
      case 'point':
        return [n, n + 1]
      case 'radio':
      case 'select': {
        const option = field.options?.[n % (field.options?.length || 1)]
        return many(() => (typeof option === 'object' ? option?.value : option))
      }
      case 'relationship':
      case 'upload':
        return Array.isArray(field.relationTo)
          ? many(() => ({ relationTo: field.relationTo[0], value: n + 1 }))
          : many(() => n + 1)
      case 'richText':
        return {
          root: {
            type: 'root',
            children: [
              {
                type: 'paragraph',
                children: [
                  {
                    type: 'text',
                    detail: 0,
                    format: 0,
                    mode: 'normal',
                    style: '',
                    text: `rt-${n}`,
                    version: 1,
                  },
                ],
                direction: 'ltr',
                format: '',
                indent: 0,
                version: 1,
              },
            ],
            direction: 'ltr',
            format: '',
            indent: 0,
            version: 1,
          },
        }
      default:
        return many(() => `${field.name}-${n}`)
    }
  }
  return fill(fields, {}, false, 0)
}

const clone = <T>(v: T): T => structuredClone(v)

/** afterChange inputs built from DB docs, the way create/update operations pair them. */
const afterChangeCaseSets = (
  docs: Record<string, unknown>[],
): { cases: () => AfterChangeCase[]; label: string; operation: 'create' | 'update' }[] => {
  const n = docs.length
  const firstHalf = (doc: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(doc).slice(0, Math.ceil(Object.keys(doc).length / 2)))
  return [
    {
      label: 'update',
      operation: 'update',
      cases: () => [
        ...docs.map((previous, i) => {
          const next = { ...clone(docs[(i + 1) % n]!), id: previous.id }
          return { data: clone(next), doc: next, previousDoc: clone(previous) }
        }),
        { data: {}, doc: { id: 'rs-synthetic-empty' }, previousDoc: {} },
      ],
    },
    {
      label: 'update-same-partial-data',
      operation: 'update',
      cases: () =>
        docs.map((doc) => ({
          data: firstHalf(clone(doc)),
          doc: clone(doc),
          previousDoc: clone(doc),
        })),
    },
    {
      label: 'update-empty-data',
      operation: 'update',
      cases: () => docs.map((doc) => ({ data: {}, doc: clone(doc), previousDoc: clone(doc) })),
    },
    {
      label: 'create',
      operation: 'create',
      cases: () =>
        docs.map((doc) => {
          const { id: _id, ...data } = clone(doc)
          return { data, doc: clone(doc), previousDoc: {} }
        }),
    },
  ]
}

const writeStats = (name: string, kind: string, stats: DiffStats) => {
  const resultsDir = path.resolve(dirname, 'results')
  fs.mkdirSync(resultsDir, { recursive: true })
  fs.writeFileSync(
    path.resolve(resultsDir, `${`${name}-${kind}`.replace(/[^\w-]+/g, '_')}.json`),
    JSON.stringify(stats, null, 2),
  )
  console.log(
    `[core-hooks-after] ${name} ${kind}: runs=${stats.runs} docs=${stats.docs} callbackEvents=${stats.callbackEvents} rejections=${stats.rejections} unhandled=${stats.unhandledRejections} diffs=${stats.diffs.length}`,
  )
}

const compare = async (
  stats: DiffStats,
  label: string,
  docCount: number,
  inputJSON: string,
  run: (engine: 'rs' | 'ts') => Promise<RunOutcome>,
) => {
  const ts = await withTimeout(run('ts'))
  const tasksBefore = getCoreRuntime().stats().tasks
  const rs = await withTimeout(run('rs'))
  // guards against a vacuous pass: the Rust engine must actually have run
  if (getCoreRuntime().stats().tasks === tasksBefore) {
    stats.diffs.push(`${label}: the Rust engine spawned no task`)
  }
  stats.runs++
  stats.docs += docCount
  stats.callbackEvents += ts.events.length
  stats.unhandledRejections += ts.unhandled.length
  if (ts.error) {
    stats.rejections++
  }
  if (ts.error === '$timeout' || rs.error === '$timeout') {
    stats.diffs.push(
      `${label}: timed out (ts=${ts.error === '$timeout'}, rs=${rs.error === '$timeout'})`,
    )
  }
  const diff = firstDiff(
    canonicalizeGeneratedIDs(ts, inputJSON),
    canonicalizeGeneratedIDs(rs, inputJSON),
  )
  if (diff) {
    stats.diffs.push(`${label} ${diff}`)
  }
}

export const registerAfterHooksSuite = ({
  afterChangeEdgeCases = {},
  configPath,
  docsPerCollection = 4,
  duplicateEdgeDocs = {},
  name,
  prepare,
}: {
  /** Per collection/global slug: factories of edge-shape afterChange inputs (one run each). */
  afterChangeEdgeCases?: Record<
    string,
    { cases: () => AfterChangeCase[]; operation: 'create' | 'update' }[]
  >
  configPath: string
  docsPerCollection?: number
  /** Per collection slug: factories of edge-shape beforeDuplicate docs (one run each). */
  duplicateEdgeDocs?: Record<string, (() => Record<string, unknown>[])[]>
  name: string
  /** Runs once before `instrument` (e.g. to add adversarial editor hooks or break editors). */
  prepare?: (payload: Payload) => void
}) => {
  let prepared = false
  const setup = (payload: Payload) => {
    if (!prepared) {
      prepare?.(payload)
      instrument(payload)
      prepared = true
    }
  }

  test.suite(name, { config: configPath, resetBetweenTests: false }, () => {
    test(
      'afterChange: Rust matches TS (docs, callback order/args, errors)',
      { timeout: 1_800_000 },
      async ({ payload }) => {
        setup(payload)
        const stats: DiffStats = {
          callbackEvents: 0,
          diffs: [],
          docs: 0,
          rejections: 0,
          runs: 0,
          unhandledRejections: 0,
        }
        const localization = payload.config.localization
        const locales: (string | undefined)[] = localization
          ? [localization.defaultLocale, localization.localeCodes[1], 'all'].filter(
              (l, i, all) => l && all.indexOf(l) === i,
            )
          : [undefined]

        const targets: Target[] = [
          ...payload.config.collections.map((collection) => ({ collection })),
          ...payload.config.globals.map((global) => ({ global })),
        ]
        for (const target of targets) {
          const slug = (target.collection ?? target.global)!.slug
          for (const locale of locales) {
            const config = (target.collection ?? target.global)!
            const docs = [
              ...(await rawDocsFor(payload, target, locale, docsPerCollection)),
              ...[1, 2].map((seed) => ({
                ...(target.collection ? { id: `sample-${seed}` } : {}),
                ...sampleDoc(
                  payload,
                  config.fields,
                  seed,
                  locale === 'all' ? localization && localization.localeCodes : undefined,
                ),
              })),
            ]
            const variant = {
              fallbackLocale: localization ? localization.defaultLocale : undefined,
              locale: locale === 'all' ? localization && localization.defaultLocale : locale,
            }
            const sets = afterChangeCaseSets(docs)
            const edge = locale === locales[0] ? (afterChangeEdgeCases[slug] ?? []) : []
            const runs = [
              ...sets.map((set) => ({ ...set, concurrency: [false, true] })),
              ...edge.flatMap((set, i) =>
                set.cases().map((_, j) => ({
                  cases: () => [set.cases()[j]!],
                  concurrency: [false],
                  label: `edge#${i}.${j}`,
                  operation: set.operation,
                })),
              ),
            ]
            for (const set of runs) {
              const inputJSON = JSON.stringify(docs) + JSON.stringify(set.cases())
              // afterChange itself, then the exported traverseFields (sequential, and concurrent
              // with `siblingFields`) on the same cases
              const modes = [
                ...set.concurrency.map((concurrent) => ({ concurrent, traverse: undefined })),
                { concurrent: false, traverse: 'fields' as const },
                { concurrent: true, traverse: 'siblingFields' as const },
              ]
              for (const { concurrent, traverse } of modes) {
                await compare(
                  stats,
                  `${slug} [${locale ?? '-'}, ${set.label}${concurrent ? ', concurrent' : ''}${traverse ? `, traverseFields(${traverse})` : ''}]`,
                  set.cases().length,
                  inputJSON,
                  (engine) =>
                    runAfterChange({
                      cases: set.cases,
                      collection: target.collection,
                      concurrent,
                      engine,
                      global: target.global,
                      operation: set.operation,
                      payload,
                      traverse,
                      variant,
                    }),
                )
              }
            }
          }
        }
        writeStats(name, 'afterChange', stats)
        // a run that compared nothing must not pass
        expect(stats.runs).toBeGreaterThan(0)
        expect(stats.diffs).toEqual([])
      },
    )

    test(
      'beforeDuplicate: Rust matches TS (docs, callback order/args, errors)',
      { timeout: 1_800_000 },
      async ({ payload }) => {
        setup(payload)
        const stats: DiffStats = {
          callbackEvents: 0,
          diffs: [],
          docs: 0,
          rejections: 0,
          runs: 0,
          unhandledRejections: 0,
        }
        const localization = payload.config.localization
        for (const collection of payload.config.collections) {
          const docs = [
            ...(await rawDocsFor(
              payload,
              { collection },
              localization ? 'all' : undefined,
              docsPerCollection,
            )),
            ...[1, 2].map((seed) => ({
              id: `sample-${seed}`,
              createdAt: '2020-01-01T00:00:00.000Z',
              ...sampleDoc(
                payload,
                collection.fields,
                seed,
                localization ? localization.localeCodes : undefined,
              ),
            })),
          ]
          const stripped = () =>
            docs.map((doc) => {
              // what duplicateDocument does before calling beforeDuplicate
              const copy = clone(doc)
              delete copy.createdAt
              delete copy.id
              return copy
            })
          const sets = [
            { docs: () => [...docs.map(clone), { id: 'rs-synthetic-empty' }], label: 'as-read' },
            { docs: stripped, label: 'stripped' },
            ...(duplicateEdgeDocs[collection.slug] ?? []).flatMap((factory, i) =>
              factory().map((_, j) => ({ docs: () => [factory()[j]!], label: `edge#${i}.${j}` })),
            ),
          ]
          for (const set of sets) {
            const inputJSON = JSON.stringify(docs) + JSON.stringify(set.docs())
            for (const [concurrent, overrideAccess] of [
              [false, true],
              [true, false],
            ]) {
              await compare(
                stats,
                `${collection.slug} [${set.label}${concurrent ? ', concurrent' : ''}]`,
                set.docs().length,
                inputJSON,
                (engine) =>
                  runBeforeDuplicate({
                    collection,
                    concurrent: concurrent!,
                    docs: set.docs,
                    engine,
                    overrideAccess: overrideAccess!,
                    payload,
                    variant: { locale: localization ? localization.defaultLocale : undefined },
                  }),
              )
            }
          }
        }
        // `collection!.fields` on a null collection: same TypeError rejection
        await compare(stats, 'null collection', 1, '', (engine) =>
          runBeforeDuplicate({
            collection: null,
            concurrent: false,
            docs: () => [{}],
            engine,
            overrideAccess: true,
            payload,
            variant: {},
          }),
        )
        writeStats(name, 'beforeDuplicate', stats)
        // a run that compared nothing must not pass
        expect(stats.runs).toBeGreaterThan(0)
        expect(stats.diffs).toEqual([])
      },
    )
  })
}
