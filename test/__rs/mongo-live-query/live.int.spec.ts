/**
 * Live differential of the Mongo query port (crates/payload-mongo-live-query) over a where / sort /
 * select corpus generated as live inputs: the same deterministic generator (paths of every collection / global / version
 * field set, operator x value pools from the seeded documents, structural wheres, relationship
 * merges, `Model.buildQuery` of collection / version / globals models, sorts with and without
 * `sortAggregation`, selects) builds each case's live values, and harness.ts runs them through
 * upstream's TS functions and the Rust port on traced clones (reads/writes, model calls, microtask
 * ticks, results with identity/classes, errors, input mutations).
 *
 *   RS_LQ_SUITE=<test dir> (default fields)   RS_LQ_SEED   RS_LQ_MAX_CASES (per collection, 1500)
 *
 * Run through run.sh (own MongoDB database per file, dropped afterwards).
 */
import type { CollectionSlug, FlattenedField, Payload } from 'payload'

import { expect } from 'vitest'

import { buildQuery as buildQueryTS } from '../../../packages/db-mongodb/src/queries/buildQuery.js'
import { buildSortParam as buildSortParamTS } from '../../../packages/db-mongodb/src/queries/buildSortParam.js'
import { getBuildQueryPlugin as getBuildQueryPluginTS } from '../../../packages/db-mongodb/src/queries/getBuildQueryPlugin.js'
import { buildProjectionFromSelect as buildProjectionFromSelectTS } from '../../../packages/db-mongodb/src/utilities/buildProjectionFromSelect.js'
import { buildVersionCollectionFields } from '../../../packages/payload/src/versions/buildCollectionFields.js'
import { buildVersionGlobalFields } from '../../../packages/payload/src/versions/buildGlobalFields.js'
import { test } from '../../__helpers/int/vitest.js'
import { assertDistinctEngines } from '../dispatch/engineGuard.js'
import {
  buildProjectionFromSelect as buildProjectionFromSelectRS,
  buildQuery as buildQueryRS,
  buildSortParam as buildSortParamRS,
  getBuildQueryPlugin as getBuildQueryPluginRS,
  getMongoLiveQuery,
} from './glue.js'
import {
  canonical,
  cloneLive,
  compareCase,
  type Comparison,
  opaqueObjects,
  rustBuildQueryStatics,
  spyModels,
  summarize,
} from './harness.js'

type Any = any

assertDistinctEngines('buildQuery', buildQueryTS, buildQueryRS)
assertDistinctEngines('buildSortParam', buildSortParamTS, buildSortParamRS)
assertDistinctEngines(
  'buildProjectionFromSelect',
  buildProjectionFromSelectTS,
  buildProjectionFromSelectRS,
)
assertDistinctEngines('getBuildQueryPlugin', getBuildQueryPluginTS, getBuildQueryPluginRS)

/**
 * Negative controls (RS_LQ_MUTANT): deliberately wrong "Rust" sides the comparison must reject.
 * - `tick`: one extra microtask before the Rust call
 * - `read`: one extra property read on the args
 * - `copy-sort`: the caller's sort array is not mutated (the port runs on a copy)
 * - `identity`: results deep-copied (input objects passed through lose identity)
 * - `objectid-class`: ObjectIds in results replaced by forged plain `{ _bsontype }` objects
 * - `error-class`: rejections rethrown as plain `Error`s with the same message
 */
const mutant = process.env.RS_LQ_MUTANT

const forge = (v: any, seen = new Map()): any => {
  if (!v || typeof v !== 'object') {
    return v
  }
  if (seen.has(v)) {
    return seen.get(v)
  }
  if (v._bsontype === 'ObjectId' && typeof v.toHexString === 'function') {
    const hex = v.toHexString()
    return { _bsontype: 'ObjectId', toHexString: () => hex }
  }
  if (v instanceof Date) {
    return v
  }
  const out: any = Array.isArray(v) ? [] : {}
  seen.set(v, out)
  for (const k of Object.keys(v)) {
    out[k] = forge(v[k], seen)
  }
  return out
}

const mutate =
  (kind: string, rs: (inputs: any[], rec: any) => unknown) =>
  (inputs: any[], rec: any): unknown => {
    switch (mutant) {
      case 'tick':
        return Promise.resolve().then(() => rs(inputs, rec))
      case 'read':
        void inputs[0]?.constructor
        return rs(inputs, rec)
      case 'copy-sort':
        return rs(
          kind === 'sort' && Array.isArray(inputs[0])
            ? [[...inputs[0]], ...inputs.slice(1)]
            : inputs,
          rec,
        )
      case 'identity': {
        const r: any = rs(inputs, rec)
        const copy = (v: any) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v)
        return r && typeof r.then === 'function' ? r.then(copy) : copy(r)
      }
      case 'objectid-class': {
        const r: any = rs(inputs, rec)
        return r && typeof r.then === 'function' ? r.then((v: any) => forge(v)) : forge(r)
      }
      case 'error-class': {
        const wrapError = (e: any) => {
          throw new Error(String(e?.message))
        }
        try {
          const r: any = rs(inputs, rec)
          return r && typeof r.then === 'function' ? r.then(undefined, wrapError) : r
        } catch (e) {
          return wrapError(e)
        }
      }
      default:
        throw new Error(`unknown RS_LQ_MUTANT ${mutant}`)
    }
  }

const suite = process.env.RS_LQ_SUITE || 'fields'
const configPath = suite.startsWith('.') ? suite : `../../${suite}/config.ts`
const maxCasesPerCollection = Number(process.env.RS_LQ_MAX_CASES || 1500)

let seed = Number(process.env.RS_LQ_SEED || 987654321)
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!
const sample = <T>(arr: T[], n: number): T[] => {
  if (arr.length <= n) {
    return arr
  }
  const copy = [...arr]
  const out: T[] = []
  while (out.length < n && copy.length) {
    out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]!)
  }
  return out
}

const operators = [
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

type PathInfo = { field: any; path: string }

const blocksOf = (payload: Payload, field: any): any[] =>
  ((field.blocks ?? []) as any[])
    .map((b) => (typeof b === 'string' ? payload.blocks[b] : b))
    .filter(Boolean)

const collectPaths = (
  payload: Payload,
  fields: FlattenedField[],
  prefix: string,
  depth: number,
  localeCodes: string[],
  out: PathInfo[],
) => {
  for (const field of fields as any[]) {
    if (!field.name || field.type === 'ui') {
      continue
    }
    const path = `${prefix}${field.name}`
    out.push({ field, path })
    if (field.localized && localeCodes.length) {
      out.push({ field, path: `${path}.${pick(localeCodes)}` })
    }
    if (depth > 2) {
      continue
    }
    switch (field.type) {
      case 'array':
      case 'group':
      case 'tab':
        collectPaths(payload, field.flattenedFields, `${path}.`, depth + 1, localeCodes, out)
        if (rand() < 0.3) {
          out.push({
            field,
            path: `${path.replace(/\./g, '__')}__${field.flattenedFields?.[0]?.name}`,
          })
        }
        break
      case 'blocks':
        out.push({ field, path: `${path}.blockType` })
        for (const block of blocksOf(payload, field)) {
          collectPaths(payload, block.flattenedFields, `${path}.`, depth + 1, localeCodes, out)
        }
        break
      case 'join': {
        const target =
          typeof field.collection === 'string'
            ? payload.collections[field.collection as CollectionSlug]?.config
            : undefined
        if (target && depth < 2) {
          for (const sub of sample(
            target.flattenedFields.filter((f: any) => f.name && f.type !== 'ui'),
            3,
          ) as any[]) {
            out.push({ field: sub, path: `${path}.${sub.name}` })
          }
        }
        break
      }
      case 'relationship':
      case 'upload':
        if (typeof field.relationTo === 'string') {
          out.push({ field, path: `${path}.id` })
          const target = payload.collections[field.relationTo as CollectionSlug]?.config
          if (target && depth < 2) {
            for (const sub of sample(
              target.flattenedFields.filter((f: any) => f.name && f.type !== 'ui'),
              3,
            ) as any[]) {
              out.push({ field: sub, path: `${path}.${sub.name}` })
              if (
                (sub.type === 'relationship' || sub.type === 'upload') &&
                typeof sub.relationTo === 'string'
              ) {
                const second = payload.collections[sub.relationTo as CollectionSlug]?.config
                const leaf = second?.flattenedFields.find((f: any) => f.name && f.type !== 'ui')
                if (leaf) {
                  out.push({ field: leaf, path: `${path}.${sub.name}.${(leaf as any).name}` })
                }
              }
            }
          }
        } else {
          out.push({ field, path: `${path}.value` })
          out.push({ field, path: `${path}.relationTo` })
        }
        break
    }
  }
}

const textPool = ['alpha', 'Beta gamma', '', 'a.b(c)*', 'x,y', '  spaced  ', 'Ünïcode é']
const datePool = [
  '2020-01-01',
  '2021-06-15T12:30:00.000Z',
  'not a date',
  '12/31/2023',
  '2020-13-45',
]

test.suite(
  `rs mongo live query differential: ${suite}`,
  { config: configPath, resetBetweenTests: false },
  () => {
    test('TS and Rust query builders agree on live inputs', async ({ payload }) => {
      const binding = getMongoLiveQuery()
      expect(typeof binding.buildQuery).toBe('function')
      const adapter = payload.db as Any
      const mongoose = adapter.connection.base
      const classes = {
        Date,
        Decimal128: mongoose.mongo.Decimal128,
        ObjectId: mongoose.Types.ObjectId,
      }
      opaqueObjects.set(payload, 'payload')
      opaqueObjects.set(adapter, 'adapter')
      opaqueObjects.set(payload.config, 'config')

      const localization = payload.config.localization
      const localeCodes = localization ? localization.localeCodes : []
      const locales: (string | undefined)[] = [
        undefined,
        ...(localeCodes.length ? [localeCodes[0], pick(localeCodes), 'all'] : []),
      ]

      const samples: Record<string, any[]> = {}
      for (const slug of Object.keys(adapter.collections)) {
        samples[slug] = await adapter.collections[slug].find({}).limit(25).lean()
      }
      const idsOf = (slug: string): unknown[] => (samples[slug] ?? []).map((d) => d._id)
      const valueAt = (slug: string, path: string): unknown[] => {
        const out: unknown[] = []
        for (const doc of samples[slug] ?? []) {
          let refs: unknown[] = [doc]
          for (const segment of path.split('.')) {
            refs = refs
              .flatMap((r: any) => (Array.isArray(r) ? r : [r]))
              .map((r: any) => (r && typeof r === 'object' ? r[segment] : undefined))
          }
          for (const r of refs) {
            if (
              r !== undefined &&
              (typeof r !== 'object' ||
                r === null ||
                r instanceof Date ||
                (r as any)._bsontype === 'ObjectId')
            ) {
              out.push(r)
            }
          }
        }
        return out.slice(0, 4)
      }

      const valuesFor = (slug: string, info: PathInfo): unknown[] => {
        const { field, path } = info
        const real = valueAt(slug, path.replace(/__/g, '.'))
        const base: unknown[] = [null, undefined, 'null', 'true', 7]
        switch (field.type) {
          case 'checkbox':
            return [true, false, 'true', 'FALSE', 'yes', ...base]
          case 'date':
            return [
              ...datePool,
              new Date('2022-02-02T00:00:00.000Z'),
              1577836800000,
              ...real,
              ...base,
            ]
          case 'join':
            return [{ id: { exists: true } }, 'alpha', ...base]
          case 'json':
          case 'richText':
            return ['alpha', { a: 1 }, ...base]
          case 'number':
            return [5, '5', '5,6', [1, '2', 'x'], 'abc', '', 0, -2.5, ...real, ...base]
          case 'point':
            return [
              [10, 20],
              [10, 20, 1000],
              '10,20,1000,5',
              '10,20',
              { type: 'Point', coordinates: [10, 20] },
              [10, 20, 0, 50],
              ...base,
            ]
          case 'relationship':
          case 'upload': {
            const targets: string[] = Array.isArray(field.relationTo)
              ? field.relationTo
              : [field.relationTo]
            const ids = targets.flatMap((t) => idsOf(t).slice(0, 2))
            const hex = ids.map((id) => String(id))
            return [
              ...hex,
              ...ids,
              hex.slice(0, 2),
              hex.slice(0, 2).join(','),
              'abc',
              '5',
              [hex[0], 'bad', null, 3],
              { relationTo: targets[0], value: hex[0] ?? '5' },
              ...(Array.isArray(field.relationTo)
                ? [[{ relationTo: targets[0], value: hex[0] }, hex[1] ?? 'x', null]]
                : []),
              { title: { equals: 'alpha' } },
              { id: { exists: true } },
              {},
              ...base,
            ]
          }
          default:
            return [...textPool, ['alpha', 'beta'], ...real, ...base]
        }
      }

      const comparison: Comparison = { compared: 0, diffs: [] }
      const kinds: Record<string, number> = {}
      const rustStatics = rustBuildQueryStatics(payload, getBuildQueryPluginRS)
      const tsSpies = (rec: any) => spyModels(payload, rec, classes)
      const rsSpies = (rec: any) => spyModels(payload, rec, classes, rustStatics)
      let caseID = 0

      const coverage = { errors: 0, modelCalls: 0, mutatedInputs: 0, passedThrough: 0 }
      const run = async (
        kind: string,
        inputs: unknown[],
        ts: (inputs: any[], rec: any) => unknown,
        rs: (inputs: any[], rec: any) => unknown,
      ) => {
        kinds[kind] = (kinds[kind] ?? 0) + 1
        const before = JSON.stringify(canonical(cloneLive(inputs), undefined, classes))
        const id = `${kind}#${caseID++}`
        const runs = await compareCase({
          classes,
          comparison,
          // `Model.buildQuery` is upstream's JS `schemaBuildQuery` over the Rust `parseParams`: its
          // config errors are thrown before Rust is entered (then the outcome must be an error)
          engineOptional: kind === 'modelBuildQuery',
          id,
          inputs,
          rs: mutant ? mutate(kind, rs) : rs,
          rsSpies,
          ts,
          tsSpies,
        })
        const ts0 = runs.ts
        if (!runs.rsEntered && !ts0.error) {
          throw new Error(`${id}: the Rust run never entered the Rust engine and did not fail`)
        }
        coverage.errors += ts0.error ? 1 : 0
        coverage.modelCalls += ts0.events.some((e: any) => e?.ev === 'call') ? 1 : 0
        coverage.passedThrough += JSON.stringify(ts0.result ?? null).includes('"$input"') ? 1 : 0
        coverage.mutatedInputs += JSON.stringify(ts0.inputsRaw) !== before ? 1 : 0
      }

      const recordQuery = async (
        slug: string | undefined,
        fields: unknown,
        where: unknown,
        locale: string | undefined,
        globalSlug?: string,
      ) => {
        const invoke =
          (fn: (args: Any) => unknown) =>
          ([w, l]: any[], rec: any) =>
            fn(
              rec.wrap({
                adapter,
                collectionSlug: slug,
                fields,
                globalSlug,
                locale: l,
                where: w,
              }),
            )
        await run('buildQuery', [where, locale], invoke(buildQueryTS), invoke(buildQueryRS))
      }

      const modelCase = async (
        Model: any,
        where: unknown,
        locale: unknown,
        globalSlug?: unknown,
      ) => {
        const invoke = ([w, l, g]: any[], rec: any) =>
          Model.buildQuery(rec.wrap({ globalSlug: g, locale: l, payload, where: w }))
        await run('modelBuildQuery', [where, locale, globalSlug], invoke, invoke)
      }

      const collections = payload.config.collections.filter(
        (c) => !c.slug.startsWith('payload-') || c.slug === 'payload-locked-documents',
      )

      for (const collection of collections) {
        const slug = collection.slug
        const fields = collection.flattenedFields
        const paths: PathInfo[] = [
          { field: { name: 'id', type: 'text' }, path: 'id' },
          { field: { name: 'id', type: 'text' }, path: '_id' },
          { field: { name: 'createdAt', type: 'date' }, path: 'createdAt' },
          { field: { name: 'nope', type: 'text' }, path: 'doesNotExist' },
        ]
        collectPaths(payload, fields, '', 0, localeCodes, paths)
        const unique = [...new Map(paths.map((p) => [p.path, p])).values()]
        const chosen = sample(unique, 70)
        let n = 0

        for (const info of chosen) {
          const idValues =
            info.path === 'id' || info.path === '_id'
              ? [
                  ...idsOf(slug).slice(0, 2).map(String),
                  ...idsOf(slug).slice(0, 1),
                  'bad',
                  `${idsOf(slug)[0]},bad`,
                  [String(idsOf(slug)[0] ?? 'x'), 'bad'],
                  5,
                  '5',
                ]
              : []
          const pool = [...idValues, ...valuesFor(slug, info)]
          for (const operator of operators) {
            for (const value of sample(pool, 3)) {
              if (n++ > maxCasesPerCollection) {
                break
              }
              await recordQuery(slug, fields, { [info.path]: { [operator]: value } }, pick(locales))
            }
          }
        }

        // structural cases
        const p1 = pick(chosen).path
        const p2 = pick(chosen).path
        const someID = String(idsOf(slug)[0] ?? '507f1f77bcf86cd799439011')
        const structural: unknown[] = [
          {},
          { and: [] },
          { AND: [{ [p1]: { exists: true } }, { [p2]: { equals: 'alpha' } }] },
          { Or: [{ [p1]: { exists: false } }, { or: [{ [p2]: { like: 'al pha' } }] }] },
          { [p1]: { exists: true, equals: 'alpha', bogus: 1 } },
          { [p1]: { in: ['a', 'b'] }, and: [{ [p1]: { not_in: ['c'] } }] },
          { id: { equals: someID }, _id: { not_equals: someID } },
          { id: { in: [someID, 'bad'] }, and: [{ id: { exists: true } }] },
          { [p1]: [{ equals: 'x' }] },
          { [p1]: null },
          { [p1]: 'alpha' },
          { and: [null] },
          { or: [{}, { [p1]: { equals: undefined } }] },
          {
            and: [{ [p1]: { like: 'a' } }, { [p1]: { not_like: 'b' } }],
            or: [{ [p2]: { contains: 'c' } }],
          },
          { [p1]: { like: 'a b' }, [p2]: { not_like: 'c d' } },
          { [`${p1}`]: { equals: 'x' }, [`${p1.replace(/\./g, '__')}`]: { equals: 'y' } },
        ]
        for (const where of structural) {
          await recordQuery(slug, fields, where, pick(locales))
        }

        const relPaths = chosen.filter(
          (p) => p.field.type === 'relationship' || p.field.type === 'upload',
        )
        if (relPaths.length >= 1) {
          const a = pick(relPaths)
          const b = pick(relPaths)
          const targetA = Array.isArray(a.field.relationTo)
            ? a.field.relationTo[0]
            : a.field.relationTo
          const idA = String(idsOf(targetA)[0] ?? '507f1f77bcf86cd799439011')
          await recordQuery(
            slug,
            fields,
            { [a.path]: { equals: idA }, [b.path]: { not_equals: idA } },
            undefined,
          )
          await recordQuery(slug, fields, { [a.path]: { equals: idA, not_equals: idA } }, undefined)
          await recordQuery(
            slug,
            fields,
            { and: [{ [a.path]: { in: [idA] } }, { [b.path]: { exists: true } }] },
            undefined,
          )
        }

        for (let i = 0; i < 20; i++) {
          const info = pick(chosen)
          const where = { [info.path]: { [pick(operators)]: pick(valuesFor(slug, info)) } }
          await modelCase(adapter.collections[slug], where, pick(locales))
        }

        if (collection.versions && adapter.versions[slug]) {
          const versionFields = buildVersionCollectionFields(payload.config, collection, true)
          const versionPaths: PathInfo[] = []
          collectPaths(payload, versionFields as FlattenedField[], '', 0, localeCodes, versionPaths)
          for (const info of sample(versionPaths, 25)) {
            const where = { [info.path]: { [pick(operators)]: pick(valuesFor(slug, info)) } }
            await modelCase(adapter.versions[slug], where, pick(locales))
          }
        }

        // sorts (the caller's array receives the fallback sort; sortAggregation the $lookups)
        const sortPaths = [...chosen.map((p) => p.path), 'id', 'createdAt', '-createdAt']
        const sorts: unknown[] = [
          undefined,
          '',
          'id',
          '-id',
          ...sample(sortPaths, 25).flatMap((p) => [p, `-${p}`]),
          [pick(sortPaths), `-${pick(sortPaths)}`],
          ['-createdAt'],
          [pick(sortPaths), 5],
          [null],
          {},
          7,
        ]
        for (const sort of sorts) {
          for (const withAggregation of [false, true]) {
            const timestamps = rand() < 0.7
            const locale = pick(locales)
            const invoke =
              (fn: (args: Any) => unknown) =>
              ([s, agg, l]: any[], rec: any) =>
                fn(
                  rec.wrap({
                    adapter,
                    config: payload.config,
                    fields,
                    locale: l,
                    sort: s,
                    sortAggregation: withAggregation ? agg : undefined,
                    timestamps,
                  }),
                )
            await run(
              'sort',
              [sort, [], locale],
              invoke(buildSortParamTS),
              invoke(buildSortParamRS),
            )
          }
        }

        // projections
        const dataPaths = chosen.filter((p) => !p.path.includes('__')).map((p) => p.path)
        const selectFrom = (mode: 'mixed' | boolean) => {
          const select: Record<string, any> = {}
          for (const p of sample(dataPaths, 4)) {
            let target = select
            const segments = p.split('.')
            for (const segment of segments.slice(0, -1)) {
              target = target[segment] =
                typeof target[segment] === 'object' && target[segment] ? target[segment] : {}
            }
            target[segments.at(-1)!] = mode === 'mixed' ? pick([true, false, 1, {}, null]) : mode
          }
          return select
        }
        const blocksFields = (fields as any[]).filter((f) => f.type === 'blocks')
        const selects: unknown[] = [
          undefined,
          {},
          selectFrom(true),
          selectFrom(false),
          selectFrom(true),
          selectFrom(false),
          selectFrom('mixed'),
          selectFrom('mixed'),
        ]
        for (const bf of blocksFields) {
          const slugs = blocksOf(payload, bf).map((b) => b.slug)
          selects.push({ [bf.name]: { [pick(slugs)]: true } })
          selects.push({ [bf.name]: { [pick(slugs)]: false } })
          selects.push({
            [bf.name]: {
              [pick(slugs)]: {
                [pick(blocksOf(payload, bf)).flattenedFields[0]?.name ?? 'x']: true,
              },
            },
          })
          selects.push({ [bf.name]: true })
        }
        for (const select of selects) {
          const invoke =
            (fn: (args: Any) => unknown) =>
            ([s]: any[], rec: any) =>
              fn(rec.wrap({ adapter, fields, select: s }))
          await run(
            'projection',
            [select],
            invoke(buildProjectionFromSelectTS),
            invoke(buildProjectionFromSelectRS),
          )
        }
      }

      if (adapter.globals) {
        await modelCase(adapter.globals, { title: { equals: 'x' } }, pick(locales), undefined)
        await modelCase(adapter.globals, { title: { equals: 'x' } }, pick(locales), 'doesNotExist')
      }
      for (const global of payload.config.globals) {
        const globalPaths: PathInfo[] = [
          { field: { name: 'globalType', type: 'text' }, path: 'globalType' },
        ]
        collectPaths(payload, global.flattenedFields, '', 0, localeCodes, globalPaths)
        for (const info of sample(globalPaths, 15)) {
          const where = { [info.path]: { [pick(operators)]: pick(valuesFor(global.slug, info)) } }
          if (adapter.globals) {
            await modelCase(adapter.globals, where, pick(locales), global.slug)
          }
          await recordQuery(undefined, global.flattenedFields, where, pick(locales), global.slug)
        }
        if (global.versions && adapter.versions[global.slug]) {
          const versionFields = buildVersionGlobalFields(payload.config, global, true)
          const versionPaths: PathInfo[] = []
          collectPaths(payload, versionFields as FlattenedField[], '', 0, localeCodes, versionPaths)
          for (const info of sample(versionPaths, 15)) {
            const where = { [info.path]: { [pick(operators)]: pick(valuesFor(global.slug, info)) } }
            await modelCase(
              adapter.versions[global.slug],
              where,
              pick(locales),
              pick([undefined, global.slug]),
            )
          }
        }
      }

      for (const d of comparison.diffs.slice(0, 15)) {
        console.log(`[rs live query] DIFF ${d.id}: ${d.kind}`)
        console.log(`  ts: ${summarize(d.ts as any, d.kind)}`)
        console.log(`  rs: ${summarize(d.rs as any, d.kind)}`)
      }
      console.log(
        `[rs live query] ${suite}: ${comparison.compared} cases compared (${JSON.stringify(kinds)}), ${comparison.diffs.length} differ`,
      )
      console.log(`[rs live query] coverage (TS side): ${JSON.stringify(coverage)}`)
      expect(comparison.compared).toBeGreaterThan(100)
      if (mutant) {
        // negative control: the harness must see the injected difference
        console.log(`[rs live query] mutant ${mutant}: ${comparison.diffs.length} cases differ`)
        expect(comparison.diffs.length).toBeGreaterThan(0)
      } else {
        expect(comparison.diffs.length).toBe(0)
      }
    })
  },
)
