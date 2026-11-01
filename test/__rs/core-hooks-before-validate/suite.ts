/**
 * Registers differential beforeValidate tests (TS reference vs Rust port) for every collection and
 * global of the suite's config. Inputs are derived from the seeded raw DB docs in several shapes
 * that exercise the sanitize step (form-like strings, nulls, flattened keys, invalid rows, ...).
 * See differential.ts.
 */
import type { Payload } from 'payload'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'

import type { RunInput, RunOutcome, Variant } from './differential.js'

import { test } from '../../__helpers/int/vitest.js'
import { instrument, runBeforeValidate } from './differential.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export type DiffStats = {
  callbacksCompared: number
  diffs: string[]
  inputsCompared: number
  rejectionsCompared: number
  runs: number
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
            data: null,
            doc: null,
            docForHooks: null,
            error: '$timeout',
            events: [],
            identity: [],
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

const generatedPatterns: [RegExp, string][] = [
  [/^[0-9a-f]{24}$/, 'generatedID'],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'generatedUUID'],
  [/^(\$date:)?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'generatedDate'],
]

/**
 * Replaces values generated during the run (ObjectIds, UUIDs, timestamps absent from the inputs,
 * e.g. from row-id or date `defaultValue` functions) with `$<kind>#n` in order of first
 * appearance (timestamps with one `$generatedDate` token), so independently generated values
 * compare equal when produced at the same points.
 */
const canonicalizeGenerated = (value: unknown, inputJSON: string): unknown => {
  const maps = new Map<string, Map<string, string>>()
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      for (const [pattern, kind] of generatedPatterns) {
        if (pattern.test(v) && !inputJSON.includes(v.replace(/^\$date:/, ''))) {
          // timestamps can repeat within one millisecond: compare them as one token
          if (kind === 'generatedDate') {
            return '$generatedDate'
          }
          let map = maps.get(kind)
          if (!map) {
            map = new Map()
            maps.set(kind, map)
          }
          let id = map.get(v)
          if (!id) {
            id = `$${kind}#${map.size}`
            map.set(v, id)
          }
          return id
        }
      }
      return v
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

const isPlainObject = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)

/** Form-like data: numbers/checkboxes/points as strings, relationships as objects, JSON strings. */
const formify = (payload: Payload, fields: any[], data: unknown): unknown => {
  if (!isPlainObject(data)) {
    return data
  }
  const out: Record<string, any> = { ...data }
  for (const field of fields) {
    if (field.type === 'tabs') {
      for (const tab of field.tabs) {
        if ('name' in tab) {
          out[tab.name] = formify(payload, tab.fields, out[tab.name])
        } else {
          Object.assign(out, formify(payload, tab.fields, out))
        }
      }
      continue
    }
    if (!('name' in field)) {
      if (Array.isArray(field.fields)) {
        Object.assign(out, formify(payload, field.fields, out))
      }
      continue
    }
    const name = field.name
    const v = out[name]
    switch (field.type) {
      case 'array':
        out[name] =
          Array.isArray(v) && v.length ? v.map((row) => formify(payload, field.fields, row)) : '0'
        break
      case 'blocks':
        out[name] =
          Array.isArray(v) && v.length
            ? v.map((row) => {
                const block =
                  payload.blocks[row?.blockType] ??
                  field.blocks.find((b: any) => typeof b === 'object' && b.slug === row?.blockType)
                return block ? formify(payload, block.fields, row) : row
              })
            : 0
        break
      case 'checkbox':
        out[name] = v === true ? 'true' : v === false ? 'false' : ''
        break
      case 'group':
        out[name] = formify(payload, field.fields, v)
        break
      case 'number':
        out[name] = typeof v === 'number' ? ` ${v} ` : Array.isArray(v) ? v.map(String) : '  '
        break
      case 'point':
        out[name] = Array.isArray(v) ? v.map((n: unknown) => ` ${n} `) : [' ', '3.5', 7]
        break
      case 'relationship':
      case 'upload': {
        const toObject = (x: unknown) => {
          if (Array.isArray(field.relationTo)) {
            return isPlainObject(x) ? { relationTo: x.relationTo, value: { id: x.value } } : x
          }
          return x === null || x === undefined ? x : { id: x }
        }
        out[name] = Array.isArray(v) ? v.map(toObject) : v === null ? 'null' : toObject(v)
        break
      }
      case 'richText':
        out[name] = v === null || v === undefined ? '{"broken json' : JSON.stringify(v)
        break
      default:
        break
    }
  }
  return out
}

/** Every top-level field null; array/blocks values with invalid rows (stripNullRows). */
const nullify = (fields: any[], data: Record<string, any>): Record<string, any> => {
  const out: Record<string, any> = {}
  const visit = (fs: any[]) => {
    for (const field of fs) {
      if (field.type === 'tabs') {
        for (const tab of field.tabs) {
          if ('name' in tab) {
            out[tab.name] = null
          } else {
            visit(tab.fields)
          }
        }
      } else if (!('name' in field)) {
        if (Array.isArray(field.fields)) {
          visit(field.fields)
        }
      } else if (field.type === 'array') {
        out[field.name] = [
          null,
          5,
          { id: 'row-x' },
          [],
          ...(Array.isArray(data[field.name]) ? data[field.name].slice(0, 1) : []),
        ]
      } else if (field.type === 'blocks') {
        out[field.name] = [{ blockType: 'rs-unknown-block' }, null, {}, 'str']
      } else {
        out[field.name] = null
      }
    }
  }
  visit(fields)
  return out
}

/** Nested plain objects one level deep become dotted keys (`unflattenData`). */
const flatten = (data: Record<string, any>): Record<string, any> => {
  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(data)) {
    if (isPlainObject(value) && Object.keys(value).length) {
      for (const [k, v] of Object.entries(value)) {
        out[`${key}.${k}`] = v
      }
    } else {
      out[key] = value
    }
  }
  return out
}

/** Blocks rows without `blockType` (resolved from the existing row with the same id). */
const withoutBlockTypes = (fields: any[], data: Record<string, any>): Record<string, any> => {
  const out = { ...data }
  for (const field of fields) {
    if (field.type === 'blocks' && Array.isArray(out[field.name])) {
      out[field.name] = out[field.name].map((row: any) => {
        if (!isPlainObject(row)) {
          return row
        }
        const { blockType: _blockType, ...rest } = row
        return rest
      })
    }
  }
  return out
}

type DataKind = { label: string; make: (doc: Record<string, any>) => Record<string, any> }

const dataKinds = (payload: Payload, fields: any[]): DataKind[] => [
  { label: 'as-is', make: (doc) => structuredClone(doc) },
  { label: 'form', make: (doc) => formify(payload, fields, structuredClone(doc)) as any },
  { label: 'empty', make: () => ({}) },
  { label: 'nulls', make: (doc) => nullify(fields, structuredClone(doc)) },
  { label: 'flattened', make: (doc) => flatten(structuredClone(doc)) },
  { label: 'no-block-type', make: (doc) => withoutBlockTypes(fields, structuredClone(doc)) },
]

const variantsFor = (payload: Payload): Variant[] => {
  const variants: Variant[] = [
    {
      name: 'create-override',
      docMode: 'empty',
      onFieldAccess: true,
      operation: 'create',
      overrideAccess: true,
    },
    { name: 'create-access', docMode: 'empty', operation: 'create', overrideAccess: false },
    {
      name: 'update-access',
      docMode: 'doc',
      onFieldAccess: true,
      operation: 'update',
      overrideAccess: false,
      withID: true,
    },
    {
      name: 'update-override',
      docMode: 'doc',
      operation: 'update',
      overrideAccess: true,
      withID: true,
    },
    { name: 'validate', docMode: 'doc', operation: 'validate', overrideAccess: false },
    { name: 'no-doc', docMode: 'undefined', operation: 'create', overrideAccess: true },
    {
      name: 'policy-doc',
      context: { validatePublicationStatus: true },
      docForHooks: { _status: 'published' },
      docMode: 'doc',
      onFieldAccess: true,
      operation: 'update',
      overrideAccess: false,
      withID: true,
    },
    {
      name: 'traverse-fields-entry',
      docForHooks: { _status: 'draft' },
      docMode: 'doc',
      onFieldAccess: true,
      operation: 'update',
      overrideAccess: false,
      viaTraverseFields: true,
      withID: true,
    },
    {
      name: 'restoring',
      context: { isRestoringVersion: true },
      docMode: 'doc',
      operation: 'update',
      overrideAccess: true,
    },
  ]
  const localization = payload.config.localization
  if (localization) {
    variants.push({
      name: 'locale',
      docMode: 'doc',
      locale: localization.localeCodes[1] ?? localization.localeCodes[0],
      operation: 'create',
      overrideAccess: false,
    })
  }
  return variants
}

/** Raw (pre-afterRead) docs: the shape operations pass as `doc`. */
const rawDocsFor = async (
  payload: Payload,
  target: { collection?: string; global?: string },
  limit: number,
): Promise<Record<string, unknown>[]> => {
  const localization = payload.config.localization
  const locales = localization ? [localization.defaultLocale, 'all'] : [undefined]
  const docs: Record<string, unknown>[] = []
  for (const locale of locales) {
    if (target.collection) {
      const result = await payload.db.find({
        collection: target.collection,
        limit,
        locale,
        pagination: false,
        sort: 'id',
      } as any)
      docs.push(...(result.docs as Record<string, unknown>[]))
    } else {
      const doc = await payload.db.findGlobal({ slug: target.global!, locale } as any)
      if (doc) {
        docs.push(doc)
      }
    }
  }
  docs.push({ id: 'rs-synthetic-empty' })
  return docs
}

/**
 * Registers the differential suite. `docsPerCollection` caps the number of seeded docs per
 * collection and locale.
 */
export const registerBeforeValidateSuite = ({
  configPath,
  docsPerCollection = 3,
  extraInputs = {},
  extraVariants = {},
  name,
}: {
  configPath: string
  docsPerCollection?: number
  /** Per collection slug: factory for extra inputs (edge shapes), called once per run. */
  extraInputs?: Record<string, () => RunInput[]>
  /** Per collection slug: additional variants. */
  extraVariants?: Record<string, Variant[]>
  name: string
}) => {
  test.suite(name, { config: configPath, resetBetweenTests: false }, () => {
    test('beforeValidate: Rust port matches TS (data, callback order/args, errors)', async ({
      payload,
    }) => {
      instrument(payload)
      const stats: DiffStats = {
        callbacksCompared: 0,
        diffs: [],
        inputsCompared: 0,
        rejectionsCompared: 0,
        runs: 0,
      }

      const targets = [
        ...payload.config.collections.map((c) => ({ collection: c, global: undefined })),
        ...payload.config.globals.map((g) => ({ collection: undefined, global: g })),
      ]

      for (const target of targets) {
        const config = (target.collection ?? target.global)!
        const fields = config.fields as any[]
        const rawDocs = await rawDocsFor(
          payload,
          target.collection ? { collection: config.slug } : { global: config.slug },
          docsPerCollection,
        )
        const inputJSONBase = JSON.stringify(rawDocs)
        const factory = extraInputs[config.slug]
        const inputSets: { inputs: () => RunInput[]; label: string }[] = [
          ...dataKinds(payload, fields).map((kind) => ({
            inputs: () =>
              rawDocs.map((doc) => ({ data: kind.make(doc), doc: structuredClone(doc) as any })),
            label: kind.label,
          })),
          // each edge input on its own so an expected rejection does not hide the others
          ...(factory?.() ?? []).map((_, i) => ({
            inputs: () => [factory!()[i]!],
            label: `edge#${i}`,
          })),
        ]
        for (const variant of [...variantsFor(payload), ...(extraVariants[config.slug] ?? [])]) {
          for (const inputSet of inputSets) {
            for (const concurrent of [false, true]) {
              const run = (engine: 'rs' | 'ts'): Promise<RunOutcome> =>
                runBeforeValidate({
                  collection: target.collection,
                  concurrent,
                  engine,
                  global: target.global,
                  inputs: inputSet.inputs,
                  payload,
                  variant,
                })
              const ts = await withTimeout(run('ts'))
              const rs = await withTimeout(run('rs'))
              stats.runs++
              stats.inputsCompared +=
                (ts.data as { $array?: unknown[] } | null)?.$array?.length ?? 0
              stats.callbacksCompared += ts.events.length
              if (ts.error) {
                stats.rejectionsCompared++
              }
              let inputJSON = inputJSONBase
              try {
                inputJSON += JSON.stringify(inputSet.inputs())
              } catch {
                // cyclic edge inputs: generated values are still recognized by pattern
              }
              const diff = firstDiff(
                canonicalizeGenerated(ts, inputJSON),
                canonicalizeGenerated(rs, inputJSON),
              )
              if (diff) {
                stats.diffs.push(
                  `${config.slug} [${variant.name}, ${inputSet.label}${concurrent ? ', concurrent' : ''}] ${diff}`,
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
      console.log(
        `[core-hooks-before-validate] ${name}: runs=${stats.runs} inputs=${stats.inputsCompared} callbackEvents=${stats.callbacksCompared} rejections=${stats.rejectionsCompared} diffs=${stats.diffs.length}`,
      )
      // the comparison must actually have exercised the Rust engine
      expect(stats.runs).toBeGreaterThan(0)
      expect(stats.diffs.slice(0, 50)).toEqual([])
    })
  })
}
