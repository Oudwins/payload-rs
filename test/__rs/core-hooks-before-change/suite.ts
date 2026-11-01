/**
 * Registers differential beforeChange tests (TS reference vs Rust port) for every collection and
 * global of the suite's config. See differential.ts.
 */
import type { Field, Payload } from 'payload'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'

import type { BeforeChangeInput, RunOutcome, Variant } from './differential.js'

import { getCoreRuntime } from '../../../packages/engine-rs/src/runtime/index.js'
import { test } from '../../__helpers/int/vitest.js'
import { instrument, runBeforeChange } from './differential.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export type DiffStats = {
  diffs: string[]
  /** Callback events compared, per kind (hook, validate, condition, ...). */
  events: Record<string, number>
  inputsCompared: number
  rejections: Record<string, number>
  runs: number
  rustAwaits: number
  /** Rust tasks spawned / JS awaits performed by the Rust runs (proves the port ran). */
  rustTasks: number
  /** Unhandled rejections compared. */
  unhandled: number
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
            error: '$timeout',
            events: [],
            inputsAfter: null,
            resultIsCopy: [],
            results: null,
            unhandled: [],
          }),
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
 * Replaces values generated during a run (24-hex ObjectIds, UUIDs and ISO timestamps that are not
 * in the inputs, also inside strings such as hook logs) with `$generated#n` in order of first appearance, so independently generated
 * values compare equal when they are produced at the same points.
 */
const canonicalizeGenerated = (value: unknown, inputJSON: string): unknown => {
  const ids = new Map<string, string>()
  const generated =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z|(?<![0-9a-f])[0-9a-f]{24}(?![0-9a-f])/g
  const replace = (s: string) =>
    s.replace(generated, (match) => {
      if (inputJSON.includes(match)) {
        return match
      }
      let id = ids.get(match)
      if (!id) {
        id = `$generated#${ids.size}`
        ids.set(match, id)
      }
      return id
    })
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return replace(v)
    }
    if (Array.isArray(v)) {
      return v.map(walk)
    }
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [replace(k), walk(x)]))
    }
    return v
  }
  return walk(value)
}

/** Deterministic PRNG (mulberry32). */
const prng = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const hash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  }
  return h >>> 0
}

const DELETE = Symbol('delete')

/** Values the fuzzer substitutes for field values (wrong types, edge shapes, JSON strings). */
const fuzzPool = (): unknown[] => [
  null,
  DELETE,
  '',
  'fuzz',
  0,
  7,
  -1.5,
  true,
  false,
  [],
  ['a', 1],
  {},
  { a: 1 },
  '{"j":1}',
  '{bad json',
  [1, 2],
  ['3.5', null],
  ['12.5', '-3'],
  { relationTo: 'users', value: 1 },
  { relationTo: 'nope', value: 'x' },
  '2024-01-01T00:00:00.000Z',
  'not-a-date',
  'a@b.co',
  { en: 'en-value', es: 'es-value' },
  [{ id: 'row-1' }, null],
  [{ blockType: 'nope' }],
  3,
]

/** Replaces a random subset of the field values in `data` (recursing into containers). */
const fuzzData = (
  payload: Payload,
  fields: Field[],
  data: Record<string, unknown>,
  rand: () => number,
  depth = 0,
): void => {
  if (!data || typeof data !== 'object' || depth > 6) {
    return
  }
  for (const field of fields as any[]) {
    if (!('name' in field)) {
      if (field.type === 'tabs') {
        for (const tab of field.tabs) {
          if ('name' in tab) {
            fuzzData(payload, tab.fields, data[tab.name] as any, rand, depth + 1)
          } else {
            fuzzData(payload, tab.fields, data, rand, depth + 1)
          }
        }
      } else if (Array.isArray(field.fields)) {
        fuzzData(payload, field.fields, data, rand, depth + 1)
      }
      continue
    }
    if (field.name === 'id') {
      continue
    }
    if (rand() < 0.2) {
      const pool = fuzzPool()
      const pick = pool[Math.floor(rand() * pool.length)]
      if (pick === DELETE) {
        delete data[field.name]
      } else {
        data[field.name] = pick
      }
      continue
    }
    const value = data[field.name] as any
    if (field.type === 'group' && Array.isArray(field.fields)) {
      fuzzData(payload, field.fields, value, rand, depth + 1)
    } else if (field.type === 'array' && Array.isArray(value)) {
      for (const row of value) {
        fuzzData(payload, field.fields, row, rand, depth + 1)
      }
    } else if (field.type === 'blocks' && Array.isArray(value)) {
      for (const row of value) {
        const block =
          payload.blocks?.[row?.blockType] ??
          field.blocks.find((b: any) => typeof b === 'object' && b.slug === row?.blockType)
        if (block) {
          fuzzData(payload, block.fields, row, rand, depth + 1)
        }
      }
    }
  }
}

const variantsFor = (payload: Payload, firstFieldNames: string[]): Variant[] => {
  const variants: Variant[] = [
    { name: 'update', onDataProcessed: true, operation: 'update', overrideAccess: true },
    { name: 'update-access', operation: 'update', overrideAccess: false, user: true },
    { name: 'skip-validation', operation: 'update', overrideAccess: true, skipValidation: true },
    { name: 'skip-hooks', operation: 'update', overrideAccess: true, skipHooks: true },
    {
      name: 'validation-operation',
      isValidationOperation: true,
      onDataProcessed: true,
      operation: 'validate',
      overrideAccess: false,
    },
    {
      name: 'fields-to-validate',
      fieldsToValidate: firstFieldNames,
      operation: 'update',
      overrideAccess: true,
    },
    { name: 'create', onDataProcessed: true, operation: 'create', overrideAccess: true },
  ]
  const localization = payload.config.localization
  if (localization) {
    const codes = localization.localeCodes
    variants.push(
      { name: 'locale-secondary', locale: codes[1] ?? codes[0], operation: 'update' },
      {
        name: 'locale-secondary-create',
        locale: codes[codes.length - 1],
        operation: 'create',
        overrideAccess: true,
      },
      { name: 'locale-all', locale: 'all', operation: 'update', overrideAccess: true },
      {
        name: 'locale-all-validation',
        isValidationOperation: true,
        locale: 'all',
        operation: 'update',
        overrideAccess: true,
      },
    )
  }
  return variants
}

type Target = {
  fields: Field[]
  slug: string
} & (
  | { collection: Payload['collections'][string]['config']; global?: undefined }
  | { collection?: undefined; global: Payload['config']['globals'][number] }
)

/**
 * The stored docs as an update operation sees them: `docWithLocales` (raw, all locales) and `doc`
 * (afterRead in the operation locale; the raw doc when reading fails).
 */
const storedDocsFor = async (
  payload: Payload,
  target: Target,
  locale: string | undefined,
  limit: number,
): Promise<{ doc: Record<string, unknown>; docWithLocales: Record<string, unknown> }[]> => {
  const dbLocale = payload.config.localization ? 'all' : undefined
  let raw: Record<string, unknown>[] = []
  if (target.collection) {
    try {
      const result = await payload.db.find({
        collection: target.slug,
        limit,
        locale: dbLocale,
        pagination: false,
        sort: 'id',
      } as any)
      raw = result.docs as Record<string, unknown>[]
    } catch {
      raw = []
    }
  } else {
    try {
      const doc = await payload.db.findGlobal({ slug: target.slug, locale: dbLocale } as any)
      raw = doc ? [doc as Record<string, unknown>] : []
    } catch {
      raw = []
    }
  }
  const out: { doc: Record<string, unknown>; docWithLocales: Record<string, unknown> }[] = []
  for (const docWithLocales of raw) {
    let doc: Record<string, unknown> = structuredClone(docWithLocales)
    try {
      doc = target.collection
        ? ((await payload.findByID({
            id: docWithLocales.id as number | string,
            collection: target.slug,
            depth: 0,
            locale: locale as any,
            overrideAccess: true,
            showHiddenFields: true,
          })) as Record<string, unknown>)
        : ((await payload.findGlobal({
            slug: target.slug,
            depth: 0,
            locale: locale as any,
            overrideAccess: true,
            showHiddenFields: true,
          })) as Record<string, unknown>)
    } catch {
      // keep the raw doc
    }
    out.push({ doc, docWithLocales })
  }
  return out
}

type InputSet = { factory: () => BeforeChangeInput[]; label: string }

const inputSetsFor = (
  payload: Payload,
  target: Target,
  variant: Variant,
  stored: { doc: Record<string, unknown>; docWithLocales: Record<string, unknown> }[],
  fuzzRounds: number,
): InputSet[] => {
  const isCreate = variant.operation === 'create'
  const base = (doc: Record<string, unknown>, docWithLocales: Record<string, unknown>) =>
    isCreate
      ? { doc: {}, docWithLocales: {}, id: undefined }
      : {
          doc: structuredClone(doc),
          docWithLocales: structuredClone(docWithLocales),
          id: doc.id as any,
        }
  const withoutID = (doc: Record<string, unknown>) => {
    const copy = structuredClone(doc)
    if (isCreate) {
      delete copy.id
    }
    return copy
  }
  const sets: InputSet[] = [
    {
      factory: () =>
        stored.map(({ doc, docWithLocales }) => ({
          ...base(doc, docWithLocales),
          data: withoutID(doc),
        })),
      label: 'same',
    },
    {
      factory: () =>
        stored.map(({ doc, docWithLocales }) => {
          const keys = Object.keys(doc)
          const data = Object.fromEntries(
            keys.slice(0, Math.ceil(keys.length / 2)).map((k) => [k, structuredClone(doc[k])]),
          )
          return { ...base(doc, docWithLocales), data }
        }),
      label: 'partial',
    },
    {
      factory: () => [
        { ...base({}, {}), data: {} },
        ...stored.map(({ doc, docWithLocales }) => ({ ...base(doc, docWithLocales), data: {} })),
      ],
      label: 'empty',
    },
  ]
  for (let round = 0; round < fuzzRounds; round++) {
    sets.push({
      factory: () =>
        stored.map(({ doc, docWithLocales }, i) => {
          const data = withoutID(doc)
          fuzzData(
            payload,
            target.fields,
            data,
            prng(hash(`${target.slug}:${variant.name}:${round}:${i}`)),
          )
          return { ...base(doc, docWithLocales), data }
        }),
      label: `fuzz#${round}`,
    })
  }
  return sets
}

/**
 * Registers the differential suite. `docsPerCollection` caps the number of stored docs per
 * collection. `extraInputs` adds edge-case input factories per collection/global slug (called
 * once per run, so frozen objects and shared references stay intact).
 */
export const registerBeforeChangeSuite = ({
  configPath,
  docsPerCollection = 3,
  extraInputs = {},
  extraVariants = {},
  fuzzRounds = 3,
  name,
  only,
}: {
  configPath: string
  docsPerCollection?: number
  extraInputs?: Record<string, (variant: Variant) => BeforeChangeInput[][]>
  extraVariants?: Record<string, Variant[]>
  fuzzRounds?: number
  name: string
  /** Restrict to these collection/global slugs. */
  only?: string[]
}) => {
  test.suite(name, { config: configPath, resetBetweenTests: false }, () => {
    test('beforeChange: Rust port matches TS (data, callback order/args, errors)', async ({
      payload,
    }) => {
      instrument(payload)
      const stats: DiffStats = {
        diffs: [],
        events: {},
        inputsCompared: 0,
        rejections: {},
        runs: 0,
        unhandled: 0,
        rustAwaits: 0,
        rustTasks: 0,
      }

      const targets: Target[] = [
        ...payload.config.collections.map((c) => ({
          collection: c,
          fields: c.fields,
          slug: c.slug,
        })),
        ...payload.config.globals.map((g) => ({ fields: g.fields, global: g, slug: g.slug })),
      ].filter((t) => !only || only.includes(t.slug))

      for (const target of targets) {
        const firstFieldNames = (target.fields as any[])
          .filter((f) => 'name' in f && f.name !== 'id')
          .slice(0, 2)
          .map((f) => f.name as string)
        for (const variant of [
          ...variantsFor(payload, firstFieldNames),
          ...(extraVariants[target.slug] ?? []),
        ]) {
          const stored = await storedDocsFor(payload, target, variant.locale, docsPerCollection)
          const sets = inputSetsFor(payload, target, variant, stored, fuzzRounds)
          const extra = extraInputs[target.slug]
          if (extra) {
            const count = extra(variant).length
            for (let i = 0; i < count; i++) {
              sets.push({ factory: () => extra(variant)[i]!, label: `edge#${i}` })
            }
          }
          for (const set of sets) {
            const inputJSON = JSON.stringify(set.factory())
            for (const concurrent of [false, true]) {
              const run = (engine: 'rs' | 'ts'): Promise<RunOutcome> =>
                runBeforeChange({
                  collection: target.collection,
                  concurrent,
                  engine,
                  global: target.global,
                  inputs: set.factory(),
                  payload,
                  variant,
                })
              const ts = await withTimeout(run('ts'))
              const before = getCoreRuntime().stats()
              const rs = await withTimeout(run('rs'))
              const after = getCoreRuntime().stats()
              stats.rustTasks += after.tasks - before.tasks
              stats.rustAwaits += after.awaits - before.awaits
              stats.runs++
              stats.unhandled += ts.unhandled.length
              stats.inputsCompared += Array.isArray(ts.inputsAfter) ? ts.inputsAfter.length : 0
              for (const event of ts.events as { args?: unknown; kind: string }[]) {
                if (event.args) {
                  stats.events[event.kind] = (stats.events[event.kind] ?? 0) + 1
                }
              }
              if (ts.error) {
                const key =
                  typeof ts.error === 'object' && ts.error && 'class' in ts.error
                    ? String((ts.error as { class: unknown }).class)
                    : String(ts.error)
                stats.rejections[key] = (stats.rejections[key] ?? 0) + 1
              }
              const diff = firstDiff(
                canonicalizeGenerated(ts, inputJSON),
                canonicalizeGenerated(rs, inputJSON),
              )
              if (diff) {
                stats.diffs.push(
                  `${target.slug} [${variant.name}, ${set.label}${concurrent ? ', concurrent' : ''}] ${diff}`,
                )
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
      const eventTotal = Object.values(stats.events).reduce((a, b) => a + b, 0)
      const rejectionTotal = Object.values(stats.rejections).reduce((a, b) => a + b, 0)
      console.log(
        `[core-hooks-before-change] ${name}: runs=${stats.runs} inputs=${stats.inputsCompared} callbackCalls=${eventTotal} ${JSON.stringify(stats.events)} rejections=${rejectionTotal} ${JSON.stringify(stats.rejections)} unhandled=${stats.unhandled} rustTasks=${stats.rustTasks} rustAwaits=${stats.rustAwaits} diffs=${stats.diffs.length}`,
      )
      // The Rust engine must have actually run: a missing addon would reject every RS run.
      expect(stats.runs).toBeGreaterThan(0)
      expect(stats.rustTasks).toBeGreaterThan(0)
      expect(stats.diffs).toEqual([])
    })
  })
}
