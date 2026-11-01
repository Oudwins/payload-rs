/**
 * Records a differential corpus for the Rust SQL query builder (crates/payload-sql-query).
 *
 * Boots a test config with the sqlite adapter, adds generated documents and records, through the
 * real TS adapter:
 * - `find`: `payload.db.find` ordered ids / `payload.db.count` totals / errors for a large corpus of
 *   where / sort / locale / paging combinations (plus injection, `undefined`, prototype-key probes),
 *   and the SQL of `buildQuery` (where, joins, order by, select fields, with bound params).
 * - `versions`: the same through `findVersions` / `countVersions` on the `_<slug>_v` tables.
 * - `aliased`: `buildQuery` SQL with an `aliasTable` and `selectLocale: true` (join traversal).
 * - `raw`: `buildQuery` SQL with `rawConstraint(sql.raw(...))` values (join traversal).
 * - `distinct`: `payload.db.findDistinct` values / totals / errors and its `buildQuery` SQL.
 *
 * Wheres are stored in the engine serialization format, so `undefined` / `NaN` survive. The corpus
 * and a copy of the database are written gzipped to `fixtures/<suite>.json.gz` / `.db.gz`;
 * `cargo test -p payload-sql-query --test differential` replays every case through Rust.
 *
 * Run (one suite per process, each with its own database file; `TZ` is recorded and replayed):
 *   TZ=America/New_York RS_QUERY_SUITE=fields SQLITE_URL=file:/tmp/rs-query-fields.db \
 *     pnpm test:int:sqlite test/__rs/query/query.int.spec.ts
 * Suites named `rsq-*` use `./config.ts` (`RS_QUERY_ID_TYPE`, `RS_QUERY_BLOCKS_AS_JSON`).
 */
import type { CollectionSlug, FlattenedField, Payload, Where } from 'payload'

import { sql } from '@payloadcms/db-sqlite'
import { buildQuery } from '@payloadcms/drizzle'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { buildVersionCollectionFields } from 'payload'
import { expect } from 'vitest'

import { getTableAlias } from '../../../packages/drizzle/src/queries/getTableAlias.js'
import {
  DistinctSymbol,
  rawConstraint,
} from '../../../packages/drizzle/src/utilities/rawConstraint.js'
import {
  createFunctionRegistry,
  serializeForEngine,
} from '../../../packages/engine-rs/src/serialize.js'
import { test } from '../../__helpers/int/vitest.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
// The adapter's own `to-snake-case` (not a dependency of the test package).
const toSnakeCase: (s: string) => string = createRequire(
  path.resolve(dirname, '../../../packages/drizzle/package.json'),
)('to-snake-case')
const suite = process.env.RS_QUERY_SUITE || 'fields'
const configPath = suite.startsWith('rsq') ? './config.ts' : `../../${suite}/config.ts`
const maxCasesPerCollection = Number(process.env.RS_QUERY_MAX_CASES || 2500)

type Outcome = { error: { message: string; name: string } } | Record<string, unknown>

type Case = {
  collection: string
  count?: Outcome
  /** findDistinct field */
  field?: string
  kind: 'aliased' | 'distinct' | 'find' | 'raw' | 'versions'
  limit: number
  locale?: string
  page: number
  rawOn?: string
  /** raw cases: `{ [rawOn]: { [rawOperator]: rawConstraint(sql.raw(rawSql)) } }`, polymorphic when rawPoly */
  rawOperator?: string
  rawPoly?: string
  rawSql?: string
  result?: Outcome
  /** engine-serialized `sort` */
  s?: unknown
  sort?: unknown
  source: string
  /** recorded `buildQuery` result */
  sql?: unknown
  /** engine-serialized `where` */
  w?: unknown
  where?: unknown
}

// Deterministic PRNG so the corpus is reproducible.
let seed = 123456789
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!

const textPool = ['alpha', 'Beta gamma', 'delta 100', 'Epsilon', 'zeta%', 'eta_theta', 'a b c', '']
const numberPool = [0, 1, 2.5, -3, 10, 100, 42]
const datePool = [
  '2020-01-01T00:00:00.000Z',
  '2021-06-15T12:30:00.000Z',
  '2023-12-31T23:59:59.000Z',
  '1999-03-04T05:06:07.000Z',
]

const generateValue = (
  payload: Payload,
  field: FlattenedField,
  ids: Record<string, (number | string)[]>,
  depth: number,
  n: number,
): unknown => {
  const anyField = field as any
  switch (field.type) {
    case 'array':
      return depth > 2
        ? []
        : Array.from({ length: Math.floor(rand() * 3) }, () =>
            generateData(payload, anyField.flattenedFields, ids, depth + 1, n),
          )
    case 'blocks': {
      if (depth > 2) {
        return []
      }
      const blocks = (anyField.blocks as any[])
        .map((b) => (typeof b === 'string' ? payload.blocks[b] : b))
        .filter(Boolean)
      if (!blocks.length) {
        return []
      }
      return Array.from({ length: Math.floor(rand() * 3) }, () => {
        const block = pick(blocks)
        return {
          blockType: block.slug,
          ...generateData(payload, block.flattenedFields, ids, depth + 1, n),
        }
      })
    }
    case 'checkbox':
      return rand() > 0.5
    case 'code':
    case 'text':
    case 'textarea':
      if (anyField.hasMany) {
        return [pick(textPool), pick(textPool)].filter(Boolean)
      }
      return pick(textPool) || 'x'
    case 'date':
      return pick(datePool)
    case 'email':
      return `gen${n}_${Math.floor(rand() * 1000)}@example.com`
    case 'group':
    case 'tab':
      return generateData(payload, anyField.flattenedFields, ids, depth + 1, n)
    case 'json':
      return {
        a: pick(numberPool),
        b: { c: pick(textPool) || 'x' },
        arr: [1, 2],
        flag: rand() > 0.5,
      }
    case 'number':
      if (anyField.hasMany) {
        return [pick(numberPool), pick(numberPool)]
      }
      return pick(numberPool)
    case 'point':
      return [pick([-10, 0, 10.5]), pick([-20, 0, 20])]
    case 'radio':
    case 'select': {
      const options = (anyField.options ?? []).map((o: any) =>
        typeof o === 'string' ? o : o.value,
      )
      if (!options.length) {
        return undefined
      }
      return anyField.hasMany ? [pick(options), pick(options)] : pick(options)
    }
    case 'relationship':
    case 'upload': {
      const relationTo = anyField.relationTo
      const one = () => {
        if (Array.isArray(relationTo)) {
          const candidates = relationTo.filter((r: string) => ids[r]?.length)
          if (!candidates.length) {
            return undefined
          }
          const r = pick(candidates)
          return { relationTo: r, value: pick(ids[r]!) }
        }
        return ids[relationTo]?.length ? pick(ids[relationTo]!) : undefined
      }
      if (anyField.hasMany) {
        return [one(), one()].filter((v) => v !== undefined)
      }
      return one()
    }
    default:
      return undefined
  }
}

const generateData = (
  payload: Payload,
  fields: FlattenedField[],
  ids: Record<string, (number | string)[]>,
  depth: number,
  n: number,
) => {
  const data: Record<string, unknown> = {}
  for (const field of fields) {
    if (!('name' in field) || ['blockName', 'blockType', 'id'].includes(field.name)) {
      continue
    }
    if (rand() < 0.15) {
      continue
    }
    const value = generateValue(payload, field, ids, depth, n)
    if (value !== undefined) {
      data[field.name] = value
    }
  }
  return data
}

type PathInfo = { field: FlattenedField; path: string }

const collectPaths = (
  payload: Payload,
  fields: FlattenedField[],
  prefix: string,
  depth: number,
  localeCodes: string[],
): PathInfo[] => {
  const out: PathInfo[] = []
  for (const field of fields) {
    if (!('name' in field)) {
      continue
    }
    const anyField = field as any
    const p = `${prefix}${field.name}`
    switch (field.type) {
      case 'array':
      case 'group':
      case 'tab':
        out.push({ field, path: p })
        if (depth < 3) {
          out.push(
            ...collectPaths(payload, anyField.flattenedFields, `${p}.`, depth + 1, localeCodes),
          )
        }
        break
      case 'blocks': {
        out.push({ field, path: p }, { field, path: `${p}.blockType` })
        if (depth < 3) {
          const seen = new Set<string>()
          for (const b of anyField.blocks) {
            const block = typeof b === 'string' ? payload.blocks[b] : b
            if (!block) {
              continue
            }
            for (const info of collectPaths(
              payload,
              block.flattenedFields,
              `${p}.`,
              depth + 1,
              localeCodes,
            )) {
              if (!seen.has(info.path)) {
                seen.add(info.path)
                out.push(info)
              }
            }
          }
        }
        break
      }
      case 'join':
        out.push({ field, path: p }, { field, path: `${p}.id` })
        if (depth < 1) {
          const target = payload.collections[anyField.collection]?.config
          if (target && !Array.isArray(anyField.collection)) {
            for (const sub of target.flattenedFields.slice(0, 6)) {
              if (
                'name' in sub &&
                !['array', 'blocks', 'group', 'join', 'tab'].includes(sub.type)
              ) {
                out.push({ field: sub, path: `${p}.${sub.name}` })
              }
            }
          }
        }
        break
      case 'json':
        out.push(
          { field, path: p },
          { field, path: `${p}.a` },
          { field, path: `${p}.b.c` },
          { field, path: `${p}.flag` },
        )
        break
      case 'relationship':
      case 'upload':
        out.push({ field, path: p })
        if (Array.isArray(anyField.relationTo)) {
          out.push({ field, path: `${p}.value` }, { field, path: `${p}.relationTo` })
        } else {
          out.push({ field, path: `${p}.id` })
          if (depth < 1) {
            const target = payload.collections[anyField.relationTo]?.config
            for (const sub of target?.flattenedFields ?? []) {
              if (
                'name' in sub &&
                [
                  'checkbox',
                  'date',
                  'number',
                  'relationship',
                  'select',
                  'text',
                  'textarea',
                ].includes(sub.type)
              ) {
                out.push({ field: sub, path: `${p}.${sub.name}` })
              }
            }
          }
        }
        break
      case 'richText':
        out.push(
          { field, path: p },
          { field, path: `${p}.root.children.text` },
          { field, path: `${p}.children.text` },
        )
        break
      case 'ui':
        break
      default:
        out.push({ field, path: p })
    }
    if (anyField.localized && localeCodes.length && depth === 0) {
      out.push({ field, path: `${p}.${localeCodes[0]}` })
      if (localeCodes[1]) {
        out.push({ field, path: `${p}.${localeCodes[1]}` })
      }
    }
  }
  return out
}

const valuesAt = (doc: unknown, segments: string[]): unknown[] => {
  if (!segments.length) {
    return Array.isArray(doc) ? doc : [doc]
  }
  if (Array.isArray(doc)) {
    return doc.flatMap((d) => valuesAt(d, segments))
  }
  if (doc && typeof doc === 'object') {
    return valuesAt((doc as Record<string, unknown>)[segments[0]!], segments.slice(1))
  }
  return []
}

const edgeValues: unknown[] = [
  null,
  '',
  'null',
  'true',
  true,
  false,
  0,
  -1,
  1.5,
  '10',
  'abc',
  'Beta',
  '%',
  'a b',
  ['alpha', 'Epsilon'],
  [],
  [null, 'alpha'],
  [1, 2, 100],
  '1,2,3',
  {},
  { relationTo: 'posts', value: 1 },
  '2020-01-01',
  '2021-06-15T12:30:00.000Z',
  'not a date',
  'x"y',
  1,
  2,
  'constructor',
  '2020-06-01T10:00:00',
]

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
  'bogus_operator',
]

const toError = (e: unknown) => {
  const err = e as Error
  return { name: err?.name ?? 'Error', message: String(err?.message ?? err) }
}

/** Probe values: forged internal markers (must bind as data or fail), `undefined`, NaN, ... */
const probeValues = (): unknown[] => [
  { '\u0000payload:sql': "'x' OR 1=1" },
  { type: '\u0000payload:RawConstraint', value: { '\u0000payload:sql': '1=1' } },
  '\u0000payload:DistinctSymbol',
  { relationTo: 'posts', value: { type: '\u0000payload:RawConstraint', value: '1=1' } },
  "x' OR '1'='1",
  undefined,
  [undefined, '2020-01-01'],
  [undefined],
  NaN,
  Infinity,
  JSON.parse('{"__proto__": {"equals": 1}}'),
  'toString',
  '__proto__',
]

const reservedKeys = new Set(['$fn', '$num', '$obj', '$ref', '$undefined'])

/**
 * A where / sort value in the engine serialization format (`decode_graph`). Unlike
 * `serializeForEngine` this keeps own `__proto__` keys (JSON.parse creates them).
 */
const encodeValue = (v: unknown): unknown => {
  if (v === undefined || typeof v === 'symbol' || typeof v === 'function') {
    return { $undefined: true }
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : { $num: String(v) }
  }
  if (v === null || typeof v !== 'object') {
    return v
  }
  if (Array.isArray(v)) {
    return v.map(encodeValue)
  }
  const out = {}
  const keys = Object.keys(v)
  for (const key of keys) {
    Object.defineProperty(out, key, {
      configurable: true,
      enumerable: true,
      value: encodeValue((v as Record<string, unknown>)[key]),
      writable: true,
    })
  }
  return keys.length === 1 && reservedKeys.has(keys[0]!) ? { $obj: out } : out
}

const encode = (value: unknown) =>
  value === undefined ? undefined : { objects: [], root: encodeValue(value) }

/** Bound param as libsql would bind it; non-bindable values are tagged. */
const encodeParam = (v: unknown): unknown => {
  if (v === null || typeof v === 'string') {
    return v
  }
  if (typeof v === 'boolean') {
    return v ? 1 : 0
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : { $num: String(v) }
  }
  if (v === undefined) {
    return { $undefined: true }
  }
  return { $unbindable: true }
}

const tableNameSymbol = Symbol.for('drizzle:Name')
const originalNameSymbol = Symbol.for('drizzle:OriginalName')

test.suite(`rs query corpus: ${suite}`, { config: configPath, resetBetweenTests: false }, () => {
  test('records corpus', async ({ payload }) => {
    const db = payload.db as any
    const dialect = db.drizzle.dialect
    const toQuery = (s: unknown) => {
      if (s === undefined) {
        return null
      }
      const q = dialect.sqlToQuery(s)
      return { params: q.params.map(encodeParam), sql: q.sql }
    }

    /** `buildQuery` output: SQL of where, joins, order by and select fields. */
    const captureBuildQuery = (args: Record<string, unknown>) => {
      try {
        const r = buildQuery({ adapter: db, ...args } as any)
        return {
          joins: r.joins.map((j: any) => ({
            alias: j.table[tableNameSymbol],
            condition: toQuery(j.condition),
            many: Boolean(j.isOneToMany),
            path: j.queryPath ?? null,
            table: j.table[originalNameSymbol],
            type: j.type ?? null,
          })),
          orderBy: r.orderBy.map((o: any) => toQuery(o.order(o.column))),
          select: Object.entries(r.selectFields).map(([k, v]) => [
            k,
            v === undefined ? null : toQuery(sql`${v}`),
          ]),
          where: toQuery(r.where),
        }
      } catch (e) {
        return { error: toError(e) }
      }
    }

    const localization = payload.config.localization
    const localeCodes = localization ? localization.localeCodes : []
    const collections = payload.config.collections.map((c) => c.slug)
    const versionFields: Record<string, FlattenedField[]> = {}
    for (const slug of collections) {
      if (payload.collections[slug]!.config.versions) {
        versionFields[slug] = buildVersionCollectionFields(
          payload.config,
          payload.collections[slug]!.config,
          true,
        )
      }
    }

    // Generated documents on top of the suite's own seed data.
    const ids: Record<string, (number | string)[]> = {}
    for (const slug of collections) {
      const existing = await payload.db
        .find({
          collection: slug,
          limit: 0,
          locale: localeCodes[0],
          pagination: false,
          select: { id: true } as any,
        })
        .catch(() => ({ docs: [] }))
      ids[slug] = existing.docs.map((d: any) => d.id)
    }
    if (process.env.RS_QUERY_GENERATE !== 'false') {
      for (const slug of collections) {
        const config = payload.collections[slug]!.config
        if (config.upload || slug.startsWith('payload-')) {
          continue
        }
        for (let n = 0; n < 6; n++) {
          const data = generateData(payload, config.flattenedFields, ids, 0, n)
          if (config.auth && !config.auth.disableLocalStrategy) {
            data.email = `gen-${slug}-${n}@example.com`
            data.password = 'test'
          }
          try {
            const doc = await payload.create({
              collection: slug as CollectionSlug,
              data: data as any,
              depth: 0,
              disableVerificationEmail: true,
              draft: n % 3 === 1,
              locale: localeCodes[0],
              overrideAccess: true,
            } as any)
            ids[slug]!.push(doc.id)
            if (localeCodes[1]) {
              const localized = generateData(
                payload,
                config.flattenedFields.filter((f: any) => f.localized),
                ids,
                0,
                n,
              )
              await payload
                .update({
                  id: doc.id,
                  collection: slug as CollectionSlug,
                  data: localized as any,
                  depth: 0,
                  draft: n % 2 === 1,
                  locale: localeCodes[1],
                  overrideAccess: true,
                } as any)
                .catch(() => undefined)
            }
          } catch {
            // invalid generated data for this collection
          }
        }
      }
    }

    const mined = JSON.parse(fs.readFileSync(path.join(dirname, 'fixtures', 'mined.json'), 'utf8')) as {
      sorts: { value: unknown }[]
      wheres: { value: Where }[]
    }

    const cases: Case[] = []
    const localeChoices: (string | undefined)[] = localeCodes.length
      ? [localeCodes[0], localeCodes[1] ?? localeCodes[0], 'all', undefined, localeCodes[0]]
      : [undefined]
    const nextLocale = () => (localeCodes.length ? pick(localeChoices) : undefined)

    const firstSegments = (where: unknown, out = new Set<string>()): Set<string> => {
      if (where && typeof where === 'object' && !Array.isArray(where)) {
        for (const [k, v] of Object.entries(where)) {
          if (['and', 'or'].includes(k.toLowerCase()) && Array.isArray(v)) {
            v.forEach((w) => firstSegments(w, out))
          } else {
            out.add(k.replace(/__/g, '.').split('.')[0]!)
          }
        }
      }
      return out
    }

    const collectionCases = async (
      slug: string,
      fields: FlattenedField[],
      kind: 'find' | 'versions',
      docs: any[],
    ): Promise<Case[]> => {
      const out: Case[] = []
      const fieldNames = new Set(fields.map((f: any) => f.name))
      fieldNames.add('id')
      const add = (c: { limit?: number; page?: number } & Omit<Case, 'collection' | 'kind' | 'limit' | 'page'>) =>
        out.push({ collection: slug, kind, limit: 0, page: 1, ...c })

      const paths = collectPaths(payload, fields, '', 0, localeCodes)
      paths.push({ field: { name: 'id', type: 'number' } as any, path: 'id' })

      for (const { path: p, field } of paths) {
        const samples = [
          ...new Set(
            valuesAt(docs, p.split('.'))
              .filter((v) => v !== undefined)
              .map((v) => JSON.stringify(v)),
          ),
        ]
          .slice(0, 3)
          .map((s) => JSON.parse(s))
        for (const operator of operators) {
          const values = [...samples]
          for (let i = 0; i < 3; i++) {
            values.push(pick(edgeValues))
          }
          if (field.type === 'date') {
            values.push(pick(datePool))
          }
          for (const value of values) {
            add({ locale: nextLocale(), source: 'generated', where: { [p]: { [operator]: value } } })
          }
        }
        // probes: one random probe value per path for a few operators
        for (const operator of ['equals', 'contains', 'in', 'like', 'not_equals']) {
          add({ locale: nextLocale(), source: 'probe', where: { [p]: { [operator]: pick(probeValues()) } } })
        }
        if (
          ['relationship', 'upload'].includes(field.type) &&
          (field as any).hasMany &&
          typeof (field as any).relationTo === 'string'
        ) {
          const target = payload.collections[(field as any).relationTo]?.config
          const sub = target?.flattenedFields.find((f: any) =>
            ['checkbox', 'number', 'text'].includes(f.type),
          ) as any
          for (const operator of ['contains', 'equals', 'not_equals']) {
            add({ locale: nextLocale(), source: 'nested-relationship', where: { [p]: { [operator]: {} } } })
            if (sub) {
              add({
                locale: nextLocale(),
                source: 'nested-relationship',
                where: { [p]: { [operator]: { [sub.name]: { exists: true } } } },
              })
              add({
                locale: nextLocale(),
                source: 'nested-relationship',
                where: { [p]: { [operator]: { [sub.name]: { equals: pick(edgeValues) } } } },
              })
            }
          }
        }
        add({ locale: nextLocale(), sort: p, source: 'sort' })
        add({ locale: nextLocale(), sort: `-${p}`, source: 'sort' })
        add({ locale: nextLocale(), sort: [p, '-id'], source: 'sort' })
        add({
          limit: 3,
          locale: nextLocale(),
          page: 2,
          sort: `-${p}`,
          source: 'sort-paged',
          where: { id: { exists: true } },
        })
      }

      // The phase-A review probes, on every matching path.
      for (const { path: p, field } of paths) {
        if (field.type === 'date') {
          add({ source: 'review-probe', where: { [p]: { contains: undefined } } })
          add({ source: 'review-probe', where: { [p]: { in: [undefined, '2020-01-01'] } } })
          add({ source: 'review-probe', where: { [p]: { greater_than: '2021-06-15T08:30:00' } } })
        }
        if (field.type === 'text' || p === 'id') {
          for (const value of probeValues().slice(0, 4)) {
            add({ source: 'review-probe', where: { [p]: { equals: value } } })
          }
        }
      }
      add({ limit: -1, page: 2, source: 'review-probe' })

      const leafPaths = paths.map((p) => p.path)
      for (let i = 0; i < Math.min(80, leafPaths.length * 2); i++) {
        const leaf = () => ({
          [pick(leafPaths)]: { [pick(operators.slice(0, 13))]: pick(edgeValues) },
        })
        const combinator = pick(['and', 'or', 'AND', 'Or'])
        add({
          locale: nextLocale(),
          sort: rand() > 0.5 ? pick(leafPaths) : undefined,
          source: 'combination',
          where:
            rand() > 0.7
              ? { [combinator]: [leaf(), { or: [leaf(), leaf()] }], ...leaf() }
              : { [combinator]: [leaf(), leaf()] },
        })
      }

      if (kind === 'find') {
        for (const { value } of mined.wheres) {
          if ([...firstSegments(value)].some((s) => fieldNames.has(s))) {
            add({ locale: nextLocale(), source: 'mined', where: value })
          }
        }
        for (const { value } of mined.sorts) {
          const s = typeof value === 'string' ? value : Array.isArray(value) ? String(value[0]) : ''
          if (fieldNames.has(s.replace(/^-/, '').split('.')[0]!)) {
            add({ locale: nextLocale(), sort: value, source: 'mined-sort' })
          }
        }
      }
      const [a, b] = leafPaths
      add({ source: 'odd', sort: 5 })
      add({ source: 'odd', sort: ['', '-'] })
      add({ source: 'odd', sort: [null] })
      add({ source: 'odd', sort: [a, undefined] })
      add({ source: 'odd', where: { or: [] } })
      add({ source: 'odd', where: { and: [null] } })
      add({ source: 'odd', where: { and: [undefined, { id: { exists: true } }] } })
      add({ source: 'odd', where: { foo: [] } })
      add({ source: 'odd', where: { id: null } })
      add({ source: 'odd', where: JSON.parse(`{"${b}": {"exists": true}, "1": {"equals": 1}}`) })
      add({ source: 'odd', where: JSON.parse('{"__proto__": {"equals": 1}}') })
      add({ limit: -1, page: 2, source: 'odd', where: { id: { exists: true } } })
      add({ limit: 2, page: 3, source: 'odd' })
      return out
    }

    for (const slug of collections) {
      const config = payload.collections[slug]!.config
      let docs: any[] = []
      try {
        docs = (
          await payload.find({
            collection: slug as CollectionSlug,
            depth: 0,
            limit: 50,
            locale: localeCodes[0] as any,
            overrideAccess: true,
          })
        ).docs
      } catch {
        docs = []
      }
      const own = await collectionCases(slug, config.flattenedFields, 'find', docs)
      const capped = (list: Case[], max: number) => [
        ...list.filter((c) => c.source === 'review-probe'),
        ...list.filter((c) => c.source !== 'review-probe').slice(0, max),
      ]
      cases.push(...capped(own, maxCasesPerCollection))

      // `buildQuery` with an alias table and `selectLocale`, as the join traversal calls it.
      for (const c of own.filter((_, i) => i % 9 === 0)) {
        cases.push({ ...c, kind: 'aliased', source: `aliased:${c.source}` })
      }

      if (versionFields[slug]) {
        let versionDocs: any[] = []
        try {
          versionDocs = (
            await payload.db.findVersions({
              collection: slug as CollectionSlug,
              limit: 50,
              locale: localeCodes[0],
            } as any)
          ).docs
        } catch {
          versionDocs = []
        }
        const versions = await collectionCases(slug, versionFields[slug], 'versions', versionDocs)
        cases.push(...capped(versions, Math.floor(maxCasesPerCollection / 2)))
      }

      // Join traversal raw constraints.
      for (const field of config.flattenedFields as any[]) {
        if (field.type !== 'join' || Array.isArray(field.collection)) {
          continue
        }
        const target = payload.collections[field.collection]?.config
        const targetField = target?.flattenedFields.find((f: any) => f.name === field.on.split('.')[0])
        const rawSql = `"${toSnakeCase(slug)}"."id"`
        const isPoly = Array.isArray((field as any).targetField?.relationTo)
        const extra = [undefined, ...[0, 1, 2].map(() => ({ [pick(collectPaths(payload, target!.flattenedFields, '', 0, localeCodes)).path]: { equals: pick(edgeValues) } }))]
        for (const userWhere of extra) {
          for (const operator of ['equals', 'in', 'not_equals', 'contains']) {
            cases.push({
              collection: field.collection,
              kind: 'raw',
              limit: 0,
              locale: nextLocale(),
              page: 1,
              rawOn: field.on,
              rawPoly: isPoly ? slug : undefined,
              rawSql,
              sort: targetField ? field.on : undefined,
              source: `raw:${operator}`,
              where: userWhere,
              rawOperator: operator,
            })
          }
        }
      }

      // findDistinct
      const distinctPaths = collectPaths(payload, config.flattenedFields, '', 0, localeCodes)
        .filter((p) => !['array', 'blocks', 'group', 'join', 'json', 'richText', 'tab'].includes(p.field.type) || p.path.includes('.'))
        .map((p) => p.path)
      for (const field of distinctPaths) {
        for (let i = 0; i < 3; i++) {
          cases.push({
            collection: slug,
            field,
            kind: 'distinct',
            limit: pick([0, 0, 2, 5]),
            locale: nextLocale(),
            page: pick([1, 1, 2]),
            sort: pick([undefined, undefined, field, `-${field}`, 'id', pick(distinctPaths)]),
            source: 'distinct',
            where: pick([undefined, undefined, { id: { exists: true } }, { [pick(distinctPaths)]: { exists: true } }]),
          })
        }
      }
    }

    let errors = 0
    for (const [i, c] of cases.entries()) {
      const config = payload.collections[c.collection]!.config
      const isVersions = c.kind === 'versions'
      const tableName = db.tableNameMap.get(
        isVersions ? `_${toSnakeCase(config.slug)}${db.versionsSuffix}` : toSnakeCase(config.slug),
      )
      const fields = isVersions ? versionFields[c.collection] : config.flattenedFields
      const sortArg = c.sort !== undefined && c.sort !== null ? c.sort : config.defaultSort
      const clone = (v: unknown) => (v === undefined ? undefined : structuredClone(v))
      c.w = encode(c.where)

      if (c.kind === 'find' || c.kind === 'versions') {
        c.sql = captureBuildQuery({ fields, locale: c.locale, sort: clone(sortArg), tableName, where: c.where })
        try {
          const res = isVersions
            ? await payload.db.findVersions({
                collection: c.collection as CollectionSlug,
                limit: c.limit,
                locale: c.locale,
                page: c.page,
                pagination: false,
                sort: clone(c.sort) as any,
                where: c.where as Where,
              } as any)
            : await payload.db.find({
                collection: c.collection as CollectionSlug,
                joins: false,
                limit: c.limit,
                locale: c.locale,
                page: c.page,
                pagination: false,
                select: { id: true } as any,
                sort: clone(c.sort) as any,
                where: c.where as Where,
              })
          c.result = { ids: res.docs.map((d: any) => d.id) }
        } catch (e) {
          errors++
          c.result = { error: toError(e) }
        }
        if (i % 3 === 0) {
          try {
            const res = isVersions
              ? await payload.db.countVersions({ collection: c.collection as CollectionSlug, locale: c.locale, where: c.where as Where } as any)
              : await payload.db.count({ collection: c.collection as CollectionSlug, locale: c.locale, where: c.where as Where })
            c.count = { totalDocs: res.totalDocs }
          } catch (e) {
            c.count = { error: toError(e) }
          }
        }
      } else if (c.kind === 'aliased') {
        try {
          const { newAliasTable } = getTableAlias({ adapter: db, tableName })
          c.sql = captureBuildQuery({
            aliasTable: newAliasTable,
            fields,
            locale: c.locale,
            selectLocale: true,
            sort: clone(sortArg),
            tableName,
            where: c.where,
          })
        } catch (e) {
          c.sql = { error: toError(e) }
        }
      } else if (c.kind === 'raw') {
        const raw = rawConstraint(sql.raw(c.rawSql!))
        let where: Where = { [c.rawOn!]: { [c.rawOperator!]: c.rawPoly ? { relationTo: c.rawPoly, value: raw } : raw } } as any
        if (c.where && Object.keys(c.where).length) {
          where = { and: [where, c.where as Where] }
        }
        const { newAliasTable } = getTableAlias({ adapter: db, tableName })
        c.sql = captureBuildQuery({
          aliasTable: newAliasTable,
          fields,
          locale: c.locale,
          selectLocale: true,
          sort: clone(c.sort),
          tableName,
          where,
        })
      } else if (c.kind === 'distinct') {
        c.sql = captureBuildQuery({
          fields,
          locale: c.locale,
          sort: clone(c.sort ?? c.field),
          tableName,
          where: { and: [c.where ?? {}, { [c.field!]: { equals: DistinctSymbol } }] },
        })
        try {
          const res = await payload.db.findDistinct({
            collection: c.collection as CollectionSlug,
            field: c.field!,
            limit: c.limit,
            locale: c.locale,
            page: c.page,
            sort: clone(c.sort) as any,
            where: c.where as Where,
          } as any)
          c.result = { totalDocs: res.totalDocs, values: res.values.map((v: any) => v[c.field!] ?? null) }
        } catch (e) {
          errors++
          c.result = { error: toError(e) }
        }
      }
      c.s = encode(c.sort)
      delete c.where
      delete c.sort
    }

    const registry = createFunctionRegistry()
    const graph = serializeForEngine(
      {
        blocks: payload.blocks,
        collections: Object.fromEntries(
          Object.entries(payload.collections).map(([slug, c]) => [
            slug,
            { config: c.config, customIDType: c.customIDType },
          ]),
        ),
        config: payload.config,
        versionFields,
      },
      registry,
    )

    // Results of `dbName` / `enumName` functions for the Rust schema builder's host calls.
    const nameFunctions = new Set<Function>()
    const seen = new Set<object>()
    const findNameFunctions = (v: unknown) => {
      if (!v || typeof v !== 'object' || seen.has(v)) {
        return
      }
      seen.add(v)
      for (const [key, child] of Object.entries(v)) {
        if ((key === 'dbName' || key === 'enumName') && typeof child === 'function') {
          nameFunctions.add(child)
        } else {
          findNameFunctions(child)
        }
      }
    }
    findNameFunctions(payload.config)
    findNameFunctions(payload.blocks)
    const hostCalls: Record<string, Record<string, string>> = {}
    for (const fn of nameFunctions) {
      const id = registry.functions.indexOf(fn)
      if (id < 0) {
        continue
      }
      const results: Record<string, string> = {}
      for (const arg of [{}, ...Object.keys(db.tables).map((tableName) => ({ tableName }))]) {
        try {
          results[JSON.stringify(arg)] = String(fn(arg))
        } catch {
          // not callable with this argument
        }
      }
      try {
        // Template for pure `({ tableName }) => string` functions, used for parent names that
        // are not tables themselves.
        results.template = String(fn({ tableName: '\u0000tableName\u0000' }))
      } catch {
        // not a template function
      }
      hostCalls[id] = results
    }

    const dbPath = (process.env.SQLITE_URL || 'file:./payload.db').replace(/^file:/, '')
    await db.drizzle.run(sql.raw('PRAGMA wal_checkpoint(TRUNCATE)')).catch(() => undefined)
    const fixture = {
      hostCalls,
      adapter: {
        autoIncrement: db.autoIncrement,
        blocksAsJSON: db.blocksAsJSON ?? false,
        idType: db.idType,
        limitedBoundParameters: db.limitedBoundParameters ?? false,
        localesSuffix: db.localesSuffix,
        name: db.name,
        relationshipsSuffix: db.relationshipsSuffix,
        versionsSuffix: db.versionsSuffix,
      },
      cases,
      graph: JSON.parse(graph),
      suite,
      tableNameMap: Object.fromEntries(db.tableNameMap),
      tableNames: Object.keys(db.tables),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
    const out = path.join(dirname, 'fixtures')
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, `${suite}.json.gz`), zlib.gzipSync(JSON.stringify(fixture), { level: 9 }))
    fs.writeFileSync(path.join(out, `${suite}.db.gz`), zlib.gzipSync(fs.readFileSync(dbPath), { level: 9 }))
    // eslint-disable-next-line no-console
    console.log(`[rs-query] ${suite}: ${cases.length} cases, ${errors} TS errors`)
    expect(cases.length).toBeGreaterThan(0)
  }, 3_600_000)
})
