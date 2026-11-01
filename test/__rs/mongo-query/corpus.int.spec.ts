/**
 * Differential corpus for the Rust port of `@payloadcms/db-mongodb`'s query builders
 * (crates/payload-mongo-query).
 *
 * Boots a test config on MongoDB (TS engine), then records through the real TS functions
 * (recorder.ts: args, result / error, mongoose sub-queries as host ops, argument mutations):
 * - `buildQuery`: every operator x field path (nested, localized + locale suffixes, hasMany,
 *   relationship hops, polymorphic `value` / `relationTo`, joins, blocks, `id` / `_id`, unknown
 *   paths, GraphQL `__` paths) x a value pool per field type (strings, numbers, dates, real and
 *   invalid ids, ObjectIds, comma lists, arrays, `null`, `'null'`, `{ relationTo, value }`, nested
 *   wheres, geo values, `undefined`) x locales, plus `and` / `or` nesting, several operators on a
 *   path, duplicate paths and malformed wheres;
 * - `modelBuildQuery`: `Model.buildQuery` of collection models (relationship sub-queries use it);
 * - `sort`: `buildSortParam` with and without `sortAggregation` (relationship sorts), timestamps,
 *   localized properties, arrays (fallback push), malformed sorts;
 * - `projection`: `buildProjectionFromSelect` with include / exclude / nested / block selects.
 *
 * The corpus is written to `fixtures/<suite>.json.gz` (git-ignored) and replayed by the Rust
 * example `replay` (`RS_MQ_REPLAY_BIN`): every case must match exactly (typed), and every
 * `buildQuery` filter of both sides is then run through mongoose against the seeded data
 * (ordered ids or the same error). `cargo test -p payload-mongo-query --test differential` replays
 * the stored fixtures again without MongoDB.
 *
 * Run: test/__rs/mongo-query/run.sh <suite> (see there).
 */
import type { CollectionSlug, FlattenedField, Payload, Where } from 'payload'

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { buildVersionCollectionFields, buildVersionGlobalFields } from 'payload'
import { expect } from 'vitest'

import { buildQuery } from '../../../packages/db-mongodb/src/queries/buildQuery.js'
import { buildSortParam } from '../../../packages/db-mongodb/src/queries/buildSortParam.js'
import { buildProjectionFromSelect } from '../../../packages/db-mongodb/src/utilities/buildProjectionFromSelect.js'
import { deserializeFromEngine } from '../../../packages/engine-rs/src/serialize.js'
import { test } from '../../__helpers/int/vitest.js'
import { createRecorder, modelInfo, type RecordedCase, serializeEnv } from './recorder.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const suite = process.env.RS_MQ_SUITE || 'fields'
/** fixture name (several seeds of one suite) */
const fixtureName = process.env.RS_MQ_SEED ? `${suite}-s${process.env.RS_MQ_SEED}` : suite
const configPath = suite.startsWith('rsmq') ? './config.ts' : `../../${suite}/config.ts`
const maxCasesPerCollection = Number(process.env.RS_MQ_MAX_CASES || 1500)

// Deterministic PRNG so the corpus is reproducible.
let seed = Number(process.env.RS_MQ_SEED || 987654321)
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

/** Query paths of a collection (nested, localized, relationship hops, blocks), deduplicated. */
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
  `rs mongo query corpus: ${suite}`,
  { config: configPath, resetBetweenTests: false },
  () => {
    test('records the corpus, replays it in Rust and compares filter results', async ({
      payload,
    }) => {
      const recorder = createRecorder(payload)
      const adapter = payload.db as any
      const localization = payload.config.localization
      const localeCodes = localization ? localization.localeCodes : []
      const locales: (string | undefined)[] = [
        undefined,
        ...(localeCodes.length ? [localeCodes[0], pick(localeCodes), 'all'] : []),
      ]

      const fieldSets: unknown[] = []
      const fieldSetIndex = new Map<unknown, number>()
      const fieldSetOf = (fields: unknown) => {
        let i = fieldSetIndex.get(fields)
        if (i === undefined) {
          i = fieldSets.push(fields) - 1
          fieldSetIndex.set(fields, i)
        }
        return i
      }

      const cases: RecordedCase[] = []
      /** live TS filters of buildQuery cases, by case id: run through mongoose after the replay */
      const tsFilters = new Map<number, { filter: unknown; slug: string }>()

      // Sample documents: real ids and values for the value pools.
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

      const record = async (
        slug: string,
        fields: unknown,
        where: unknown,
        locale: string | undefined,
        globalSlug?: string,
      ) => {
        const args = { collectionSlug: slug, fieldSet: fieldSetOf(fields), globalSlug, locale, where }
        const { case: c, value } = await recorder.record('buildQuery', args, () =>
          buildQuery({
            adapter,
            collectionSlug: slug,
            fields: fields as FlattenedField[],
            globalSlug,
            locale,
            where: where as Where,
          }),
        )
        cases.push(c)
        if (!c.error && slug) {
          tsFilters.set(c.id, { filter: value, slug })
        }
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
              await record(slug, fields, { [info.path]: { [operator]: value } }, pick(locales))
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
          await record(slug, fields, where, pick(locales))
        }

        // relationship equality merging (`$or` index merge of deepmerge)
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
          await record(
            slug,
            fields,
            { [a.path]: { equals: idA }, [b.path]: { not_equals: idA } },
            undefined,
          )
          await record(slug, fields, { [a.path]: { equals: idA, not_equals: idA } }, undefined)
          await record(
            slug,
            fields,
            { and: [{ [a.path]: { in: [idA] } }, { [b.path]: { exists: true } }] },
            undefined,
          )
        }

        // Model.buildQuery of the collection model
        for (let i = 0; i < 20; i++) {
          const info = pick(chosen)
          const where = { [info.path]: { [pick(operators)]: pick(valuesFor(slug, info)) } }
          const locale = pick(locales)
          const args = {
            globalSlug: undefined,
            locale,
            model: { kind: 'collections', slug },
            where,
          }
          const { case: c } = await recorder.record('modelBuildQuery', args, () =>
            adapter.collections[slug].buildQuery({ locale, payload, where }),
          )
          cases.push(c)
        }

        // version fields
        if (collection.versions) {
          const versionFields = buildVersionCollectionFields(payload.config, collection, true)
          const versionPaths: PathInfo[] = []
          collectPaths(payload, versionFields as FlattenedField[], '', 0, localeCodes, versionPaths)
          for (const info of sample(versionPaths, 25)) {
            const where = { [info.path]: { [pick(operators)]: pick(valuesFor(slug, info)) } }
            const locale = pick(locales)
            const args = {
              globalSlug: undefined,
              locale,
              model: {
                collectionSlug: slug,
                kind: 'versions',
                slug,
                versionsFieldSet: fieldSetOf(versionFields),
              },
              where,
            }
            const { case: c } = await recorder.record('modelBuildQuery', args, () =>
              adapter.versions[slug].buildQuery({ locale, payload, where }),
            )
            cases.push(c)
          }
        }

        // sorts
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
            const sortArg = Array.isArray(sort) ? [...sort] : sort
            const args = {
              fieldSet: fieldSetOf(fields),
              locale,
              parentIsLocalized: false,
              sort: sortArg,
              timestamps,
              withAggregation,
            }
            const { case: c } = await recorder.record('sort', args, () => {
              const sortAggregation: unknown[] = []
              const result = buildSortParam({
                adapter,
                config: payload.config,
                fields,
                locale,
                sort: sortArg as any,
                sortAggregation: withAggregation ? (sortAggregation as any) : undefined,
                timestamps,
              })
              return withAggregation ? { sort: result, sortAggregation } : { sort: result }
            })
            cases.push(c)
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
          const args = { fieldSet: fieldSetOf(fields), select }
          const { case: c } = await recorder.record('projection', args, () =>
            buildProjectionFromSelect({ adapter, fields, select: select as any }),
          )
          cases.push(c)
        }
      }

      // Model.buildQuery of the globals model and of global version models (fields resolution,
      // errors for unknown / missing global slugs)
      const globalModelCase = async (model: Record<string, unknown>, Model: any, globalSlug: unknown, where: unknown) => {
        const locale = pick(locales)
        const args = { globalSlug, locale, model, where }
        const { case: c } = await recorder.record('modelBuildQuery', args, () =>
          Model.buildQuery({ globalSlug, locale, payload, where }),
        )
        cases.push(c)
      }
      if (adapter.globals) {
        await globalModelCase({ kind: 'globals' }, adapter.globals, undefined, { title: { equals: 'x' } })
        await globalModelCase({ kind: 'globals' }, adapter.globals, 'doesNotExist', { title: { equals: 'x' } })
      }
      for (const global of payload.config.globals) {
        const globalPaths: PathInfo[] = [{ field: { name: 'globalType', type: 'text' }, path: 'globalType' }]
        collectPaths(payload, global.flattenedFields, '', 0, localeCodes, globalPaths)
        for (const info of sample(globalPaths, 15)) {
          const where = { [info.path]: { [pick(operators)]: pick(valuesFor(global.slug, info)) } }
          if (adapter.globals) {
            await globalModelCase({ kind: 'globals' }, adapter.globals, global.slug, where)
          }
          await record(undefined as any, global.flattenedFields, where, pick(locales), global.slug)
        }
        if (global.versions && adapter.versions[global.slug]) {
          const versionFields = buildVersionGlobalFields(payload.config, global, true)
          const versionPaths: PathInfo[] = []
          collectPaths(payload, versionFields as FlattenedField[], '', 0, localeCodes, versionPaths)
          for (const info of sample(versionPaths, 15)) {
            const where = { [info.path]: { [pick(operators)]: pick(valuesFor(global.slug, info)) } }
            await globalModelCase(
              { kind: 'versions', slug: global.slug, versionsFieldSet: fieldSetOf(versionFields) },
              adapter.versions[global.slug],
              pick([undefined, global.slug]),
              where,
            )
          }
        }
      }

      // Write the fixture.
      const graph = serializeEnv(recorder, payload, fieldSets)
      const fixture = {
        cases,
        disableFallbackSort: Boolean(adapter.disableFallbackSort),
        graph,
        modelInfo: modelInfo(payload),
        suite,
      }
      const fixturesDir = path.join(dirname, 'fixtures')
      fs.mkdirSync(fixturesDir, { recursive: true })
      const fixturePath = path.join(fixturesDir, `${fixtureName}.json.gz`)
      fs.writeFileSync(fixturePath, zlib.gzipSync(JSON.stringify(fixture)))

      const errors = cases.filter((c) => c.error).length
      const withHostOps = cases.filter((c) => c.hostOps.length).length
      const mutated = cases.filter((c) => c.argsAfter).length
      console.log(
        `[rs mongo query] ${suite}: ${cases.length} cases (${errors} errors, ${withHostOps} with host ops, ${mutated} mutating args), fixture ${(fs.statSync(fixturePath).size / 1e6).toFixed(2)} MB`,
      )
      expect(cases.length).toBeGreaterThan(0)

      // Replay in Rust.
      const replayBin = process.env.RS_MQ_REPLAY_BIN
      if (!replayBin) {
        console.log('[rs mongo query] RS_MQ_REPLAY_BIN not set: recorded only')
        return
      }
      const outPath = path.join(fixturesDir, `${fixtureName}.rust.json`)
      const run = spawnSync(replayBin, [fixturePath, outPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      expect(run.status, run.stderr).toBe(0)
      const report = JSON.parse(fs.readFileSync(outPath, 'utf8'))
      fs.rmSync(outPath)
      const failures = report.cases.filter((c: any) => c.failure)
      for (const f of failures.slice(0, 30)) {
        console.log(`[rs mongo query] FAIL case ${f.id} (${f.kind}): ${f.failure}`)
      }

      // Result level: both filters through mongoose against the seeded data.
      const mongoose = adapter.connection.base
      const classes = {
        Binary: mongoose.mongo.Binary,
        Decimal128: mongoose.mongo.Decimal128,
        ObjectId: mongoose.Types.ObjectId,
      }
      const runFilter = async (slug: string, filter: unknown) => {
        try {
          const docs = await adapter.collections[slug]
            .find(filter)
            .sort({ _id: 1 })
            .select({ _id: 1 })
            .lean()
          return { ids: docs.map((d: any) => String(d._id)) }
        } catch (e) {
          return { error: String((e as Error).message) }
        }
      }
      let resultChecks = 0
      let resultMismatches = 0
      let nonEmpty = 0
      for (const rust of report.cases as any[]) {
        const ts = tsFilters.get(rust.id)
        if (!ts || rust.failure || !('result' in rust)) {
          continue
        }
        const rustFilter = deserializeFromEngine(rust.result, recorder.registry, { classes })
        const [a, b] = [await runFilter(ts.slug, ts.filter), await runFilter(ts.slug, rustFilter)]
        resultChecks++
        if ('ids' in a && a.ids.length) {
          nonEmpty++
        }
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          resultMismatches++
          if (resultMismatches <= 10) {
            console.log(
              `[rs mongo query] RESULT MISMATCH case ${rust.id}: ts ${JSON.stringify(a).slice(0, 300)} rust ${JSON.stringify(b).slice(0, 300)}`,
            )
          }
        }
      }
      console.log(
        `[rs mongo query] ${suite}: rust replay ${report.total} cases, ${report.failed} failed; result-level ${resultChecks} filters (${nonEmpty} non-empty), ${resultMismatches} mismatches`,
      )
      expect(report.total).toBe(cases.length)
      expect(report.failed).toBe(0)
      expect(resultChecks).toBeGreaterThan(0)
      expect(resultMismatches).toBe(0)
    }, 3_600_000)
  },
)
