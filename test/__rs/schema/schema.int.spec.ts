/**
 * Differential check: the Rust raw schema (`buildRawSchemaRS`) must be identical to the upstream TS
 * `buildRawSchema` (with the SQLite `setColumnID`) for every loadable `test/<suite>/config.ts`.
 *
 * Run: SQLITE_URL=file:/tmp/rs-schema.db pnpm test:int:sqlite test/__rs/schema/schema.int.spec.ts
 * Optional: RS_SCHEMA_SUITES=fields,blocks to limit the suites.
 */
import type { SanitizedConfig } from 'payload'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { traverseFields } from 'payload'
import { fieldAffectsData } from 'payload/shared'
import { afterAll, describe, expect, it } from 'vitest'

import { buildRawSchema } from '../../../packages/drizzle/src/schema/buildRawSchema.js'
import { setColumnID } from '../../../packages/drizzle/src/sqlite/schema/setColumnID.js'
import { InternalBlockTableNameIndex } from '../../../packages/drizzle/src/utilities/validateExistingBlockIsIdentical.js'
import { applyRawSchemaRS, buildRawSchemaRS } from '../../../packages/engine-rs/src/schema.js'
import {
  createFunctionRegistry,
  serializeForEngine,
} from '../../../packages/engine-rs/src/serialize.js'
import { APIError } from '../../../packages/payload/src/errors/APIError.js'
import { InvalidConfiguration } from '../../../packages/payload/src/errors/InvalidConfiguration.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const testDir = path.resolve(dirname, '../..')

const onlySuites = process.env.RS_SCHEMA_SUITES?.split(',').filter(Boolean)
const suites = fs
  .readdirSync(testDir)
  .filter((dir) => fs.existsSync(path.join(testDir, dir, 'config.ts')))
  .filter((dir) => !onlySuites || onlySuites.includes(dir))
  .sort()

/**
 * `RS_SCHEMA_WRITE_FIXTURES=1` writes golden fixtures for `cargo test -p payload-engine`
 * (`golden_fixtures` in crates/payload-engine/src/sql/schema.rs): the serialized input graph and the TS output
 * per variant. Only the parts of the config the schema builder reads are kept, to keep them small.
 */
const fixturesDir = path.join(dirname, 'fixtures')
// suites without JS dbName/enumName functions (the cargo test has no JS host)
const fixtureSuites = ['fields', 'localization', 'relationships', 'versions']
const writeFixture = (
  name: string,
  payload: ReturnType<typeof buildPayloadLike>,
  outputs: Record<string, unknown>,
) => {
  if (process.env.RS_SCHEMA_WRITE_FIXTURES !== '1') {
    return
  }
  const { config } = payload
  const root = {
    blocks: payload.blocks,
    collections: payload.collections,
    config: {
      collections: config.collections,
      globals: config.globals,
      localization: config.localization,
    },
  }
  const registry = createFunctionRegistry()
  const graph = JSON.parse(serializeForEngine(root, registry))
  fs.mkdirSync(fixturesDir, { recursive: true })
  fs.writeFileSync(
    path.join(fixturesDir, `${name}.json`),
    JSON.stringify({ functionCount: registry.functions.length, graph, outputs }),
  )
}

const variants = [
  { name: 'number', autoIncrement: true, blocksAsJSON: false, idType: 'number' },
  { name: 'uuid', autoIncrement: false, blocksAsJSON: false, idType: 'uuid' },
  { name: 'uuidv7', autoIncrement: false, blocksAsJSON: false, idType: 'uuidv7' },
  { name: 'blocksAsJSON', autoIncrement: true, blocksAsJSON: true, idType: 'number' },
] as const

type Variant = (typeof variants)[number]

/** Mirrors the `payload.collections` / `payload.blocks` setup in `BasePayload.init`. */
const buildPayloadLike = (config: SanitizedConfig) => {
  const collections: Record<string, { config: unknown; customIDType: string | undefined }> = {}
  for (const collection of config.collections) {
    let customIDType: string | undefined = undefined
    traverseFields({
      callback: ({ field }) => {
        if (
          ['array', 'blocks', 'group'].includes(field.type) ||
          (field.type === 'tab' && 'name' in field)
        ) {
          return true
        }
        if (!fieldAffectsData(field)) {
          return
        }
        if (field.name === 'id') {
          customIDType = field.type
          return true
        }
      },
      config,
      fields: collection.fields,
      parentIsLocalized: false,
    })
    collections[collection.slug] = { config: collection, customIDType }
  }
  const blocks = Object.fromEntries((config.blocks ?? []).map((block) => [block.slug, block]))
  return { blocks, collections, config }
}

/** Every object reachable from `root` that carries `InternalBlockTableNameIndex`. */
const collectBlockIndexes = (root: unknown, clear: boolean) => {
  const found = new Map<object, number>()
  const seen = new Set<object>()
  const walk = (v: unknown) => {
    if (typeof v !== 'object' || v === null || seen.has(v)) {
      return
    }
    seen.add(v)
    if (Object.prototype.hasOwnProperty.call(v, InternalBlockTableNameIndex)) {
      found.set(v, (v as any)[InternalBlockTableNameIndex])
      if (clear) {
        delete (v as any)[InternalBlockTableNameIndex]
      }
    }
    // data properties only: config getters must not run outside the code under test
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(v))) {
      if ('value' in descriptor) {
        walk(descriptor.value)
      }
    }
  }
  walk(root)
  return found
}

type AdapterState = ReturnType<typeof createAdapterState>

/** The drizzle adapter state `buildRawSchema` reads and writes. */
const createAdapterState = (payload: ReturnType<typeof buildPayloadLike>, variant: Variant) => ({
  autoIncrement: variant.autoIncrement,
  blocksAsJSON: variant.blocksAsJSON,
  fieldConstraints: {} as Record<string, Record<string, string>>,
  foreignKeys: new Set<string>(),
  idType: variant.idType,
  indexes: new Set<string>(),
  localesSuffix: '_locales',
  payload,
  rawRelations: {} as Record<string, any>,
  rawTables: {} as Record<string, any>,
  relationshipsSuffix: '_rels',
  tableNameMap: new Map<string, string>(),
  versionsSuffix: '_v',
})

const snapshot = (adapter: AdapterState) => ({
  fieldConstraints: adapter.fieldConstraints,
  foreignKeys: [...adapter.foreignKeys],
  indexes: [...adapter.indexes],
  rawRelations: adapter.rawRelations,
  rawTables: adapter.rawTables,
  tableNameMap: [...adapter.tableNameMap],
})

type Run = {
  /** `{ result }` or `{ error: { name, message } }`, as stored in fixtures. */
  outcome: { error?: { message: string; name: string }; result?: ReturnType<typeof snapshot> }
  thrown?: unknown
}

const failed = (error: unknown): Run => ({
  outcome: { error: { name: (error as Error).name, message: (error as Error).message } },
  thrown: error,
})

/** sqlite `init`: resets `rawTables` / `rawRelations`, then `buildRawSchema` mutates the adapter. */
const runTS = (adapter: AdapterState): Run => {
  adapter.rawRelations = {}
  adapter.rawTables = {}
  try {
    buildRawSchema({ adapter: adapter as any, setColumnID })
  } catch (error) {
    return failed(error)
  }
  return { outcome: { result: snapshot(adapter) } }
}

/** Same as `runTS` through `buildRawSchemaRS` + `applyRawSchemaRS`. */
const runRS = (adapter: AdapterState): Run => {
  adapter.rawRelations = {}
  adapter.rawTables = {}
  try {
    const schema = buildRawSchemaRS({
      adapter: adapter as any,
      internalBlockTableNameIndex: InternalBlockTableNameIndex,
    })
    applyRawSchemaRS({ adapter, schema })
  } catch (error) {
    return failed(error)
  }
  return { outcome: { result: snapshot(adapter) } }
}

/** `JSON.parse(JSON.stringify(value))` that also accepts `bigint`s (column defaults). */
const toJSON = (value: unknown) =>
  JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? `${v}n` : v)))

const restoreBlockIndexes = (indexes: Map<object, number>) => {
  for (const [block, index] of indexes) {
    ;(block as any)[InternalBlockTableNameIndex] = index
  }
}

/**
 * What JSON can't see: own keys holding `undefined` in `rawTables`, column defaults by identity
 * (`withDefault` stores `field.defaultValue` itself) and the thrown error's class, status and data.
 */
const strictDifferences = (ts: Run, rs: Run): string[] => {
  const out: string[] = []
  if (ts.thrown || rs.thrown) {
    const tsError = ts.thrown as APIError | undefined
    const rsError = rs.thrown as APIError | undefined
    if (!tsError || !rsError || Object.getPrototypeOf(tsError) !== Object.getPrototypeOf(rsError)) {
      out.push(`error class: ${tsError?.constructor?.name} vs ${rsError?.constructor?.name}`)
    } else if (tsError instanceof APIError) {
      for (const key of ['status', 'isPublic', 'isOperational'] as const) {
        if (tsError[key] !== rsError[key]) {
          out.push(`error ${key}: ${tsError[key]} vs ${rsError[key]}`)
        }
      }
      if (JSON.stringify(tsError.data) !== JSON.stringify(rsError.data)) {
        out.push(`error data: ${JSON.stringify(tsError.data)} vs ${JSON.stringify(rsError.data)}`)
      }
    }
    return out
  }
  const tsTables = ts.outcome.result!.rawTables
  const rsTables = rs.outcome.result!.rawTables
  if (JSON.stringify(Object.keys(tsTables)) !== JSON.stringify(Object.keys(rsTables))) {
    out.push('rawTables keys (including undefined placeholders)')
  }
  for (const [tableName, table] of Object.entries<any>(tsTables)) {
    for (const [columnName, column] of Object.entries<any>(table?.columns ?? {})) {
      const rsColumn = rsTables[tableName]?.columns?.[columnName]
      if ('default' in column !== (rsColumn !== undefined && 'default' in rsColumn)) {
        out.push(`${tableName}.${columnName} has default`)
      } else if ('default' in column && !Object.is(column.default, rsColumn.default)) {
        out.push(
          `${tableName}.${columnName} default: ${String(column.default)} vs ${String(rsColumn.default)}`,
        )
      }
    }
  }
  return out
}

const keys = [
  'rawTables',
  'rawRelations',
  'tableNameMap',
  'indexes',
  'foreignKeys',
  'fieldConstraints',
] as const

/** Number of `$ref`s in a `serializeForEngine` graph that point back into an object being encoded. */
const countBackReferences = (root: unknown): number => {
  const graph = JSON.parse(
    serializeForEngine(
      {
        blocks: (root as any).blocks,
        collections: (root as any).collections,
        config: (root as any).config,
      },
      createFunctionRegistry(),
    ),
  )
  const refsOf = (json: unknown, out: number[]): number[] => {
    if (Array.isArray(json)) {
      json.forEach((item) => refsOf(item, out))
    } else if (typeof json === 'object' && json !== null) {
      const keys = Object.keys(json)
      if (keys.length === 1 && keys[0] === '$ref') {
        out.push((json as { $ref: number }).$ref)
      } else {
        Object.values(json).forEach((item) => refsOf(item, out))
      }
    }
    return out
  }
  const edges: number[][] = graph.objects.map((object: unknown) => refsOf(object, []))
  const state: number[] = edges.map(() => 0)
  let back = 0
  const visit = (i: number) => {
    state[i] = 1
    for (const j of edges[i]!) {
      if (state[j] === 1) {
        back++
      } else if (state[j] === 0) {
        visit(j)
      }
    }
    state[i] = 2
  }
  edges.forEach((_, i) => state[i] === 0 && visit(i))
  return back
}

const report = {
  compared: [] as string[],
  cyclicGraphs: [] as string[],
  failedToLoad: [] as { error: string; suite: string }[],
  matched: [] as string[],
  mismatched: [] as string[],
  blockIndexes: 0,
  defaultsCompared: 0,
  reinitCompared: 0,
  errorsMatched: [] as string[],
  tables: 0,
}

/** Exact comparison of a TS and a Rust run; records soft expectation failures and returns `ok`. */
const compareRuns = ({
  label,
  rs,
  rsBlockIndexes,
  ts,
  tsBlockIndexes,
}: {
  label: string
  rs: Run
  rsBlockIndexes: Map<object, number>
  ts: Run
  tsBlockIndexes: Map<object, number>
}): boolean => {
  let ok = true
  const tsJSON = toJSON(ts.outcome)
  const rsJSON = toJSON(rs.outcome)
  if (tsJSON.error || rsJSON.error) {
    if (JSON.stringify(tsJSON.error) !== JSON.stringify(rsJSON.error)) {
      ok = false
    }
    expect.soft(rsJSON.error, label).toStrictEqual(tsJSON.error)
  } else {
    for (const key of keys) {
      // exact equality including key order
      const same = JSON.stringify(rsJSON.result[key]) === JSON.stringify(tsJSON.result[key])
      if (!same) {
        ok = false
      }
      expect.soft(rsJSON.result[key], `${label} ${key}`).toStrictEqual(tsJSON.result[key])
      expect.soft(same, `${label} ${key} key order`).toBe(true)
    }
    for (const table of Object.values<any>(tsJSON.result.rawTables)) {
      for (const column of Object.values<any>(table.columns)) {
        if ('default' in column) {
          report.defaultsCompared++
        }
      }
    }
  }
  const strict = strictDifferences(ts, rs)
  if (strict.length) {
    ok = false
  }
  expect.soft(strict, `${label} strict`).toStrictEqual([])
  const sameBlocks =
    tsBlockIndexes.size === rsBlockIndexes.size &&
    [...tsBlockIndexes].every(([block, index]) => rsBlockIndexes.get(block) === index)
  if (!sameBlocks) {
    ok = false
  }
  expect.soft(sameBlocks, `${label} InternalBlockTableNameIndex`).toBe(true)
  return ok
}

describe('Rust buildRawSchema matches TS', () => {
  it('finds test suites to compare', () => {
    expect(
      suites.length,
      `no test/<suite>/config.ts matches RS_SCHEMA_SUITES=${onlySuites}`,
    ).toBeGreaterThan(0)
  })

  afterAll(() => {
    // eslint-disable-next-line no-console
    console.log(
      `[rs-schema] suites: ${suites.length}, loaded+compared: ${report.compared.length}, matched: ${report.matched.length}, tables compared: ${report.tables}, mismatched: ${report.mismatched.length} ${JSON.stringify(report.mismatched)}, failed to load: ${report.failedToLoad.length} ${JSON.stringify(report.failedToLoad)}, block index entries: ${report.blockIndexes}, column defaults compared by identity: ${report.defaultsCompared}, re-init runs compared: ${report.reinitCompared}, errors matched: ${JSON.stringify(report.errorsMatched)}, graphs with cycles: ${report.cyclicGraphs.length} ${JSON.stringify(report.cyclicGraphs)}`,
    )
  })

  for (const suite of suites) {
    it(suite, { timeout: 300000 }, async () => {
      let config: SanitizedConfig
      try {
        const mod = await import(pathToFileURL(path.join(testDir, suite, 'config.ts')).href)
        config = await mod.default
        if (!config?.collections) {
          throw new Error('default export is not a sanitized config')
        }
      } catch (error) {
        report.failedToLoad.push({ error: String((error as Error)?.message ?? error), suite })
        // a suite that cannot be compared must fail, not pass silently
        throw new Error(`test/${suite}/config.ts failed to load`, { cause: error })
      }

      const payload = buildPayloadLike(config)
      report.compared.push(suite)
      if (countBackReferences(payload) > 0) {
        report.cyclicGraphs.push(suite)
      }
      let ok = true
      const fixtureOutputs: Record<string, unknown> = {}

      for (const variant of variants) {
        // block[InternalBlockTableNameIndex] persists on config objects: start every run clean
        collectBlockIndexes(payload, true)
        const tsAdapter = createAdapterState(payload, variant)
        const tsRun = runTS(tsAdapter)
        const tsBlockIndexes = collectBlockIndexes(payload, true)

        const rsAdapter = createAdapterState(payload, variant)
        const rsRun = runRS(rsAdapter)
        const rsBlockIndexes = collectBlockIndexes(payload, true)

        const label = `${suite} [${variant.name}]`
        const ts = toJSON(tsRun.outcome)
        fixtureOutputs[variant.name] = ts
        if (!compareRuns({ label, rs: rsRun, rsBlockIndexes, ts: tsRun, tsBlockIndexes })) {
          ok = false
        }
        if (ts.error) {
          report.errorsMatched.push(`${label}: ${ts.error?.name} ${ts.error?.message}`)
          continue
        }
        report.tables += Object.keys(ts.result.rawTables).length
        report.blockIndexes += tsBlockIndexes.size
        expect(Object.keys(ts.result.rawTables).length, `${label} has tables`).toBeGreaterThan(0)

        if (variant.name === 'number') {
          // re-init on the same adapter: blocks keep their InternalBlockTableNameIndex (seeding
          // path), tableNameMap / fieldConstraints persist
          restoreBlockIndexes(tsBlockIndexes)
          const tsRun2 = runTS(tsAdapter)
          const tsBlockIndexes2 = collectBlockIndexes(payload, true)
          restoreBlockIndexes(rsBlockIndexes)
          const rsRun2 = runRS(rsAdapter)
          const rsBlockIndexes2 = collectBlockIndexes(payload, true)
          report.reinitCompared++
          if (
            !compareRuns({
              label: `${label} re-init`,
              rs: rsRun2,
              rsBlockIndexes: rsBlockIndexes2,
              ts: tsRun2,
              tsBlockIndexes: tsBlockIndexes2,
            })
          ) {
            ok = false
          }
        }
      }

      if (fixtureSuites.includes(suite)) {
        writeFixture(suite, payload, fixtureOutputs)
      }
      ;(ok ? report.matched : report.mismatched).push(suite)
    })
  }
})

describe('Rust buildRawSchema matches TS (synthetic edge cases)', () => {
  const expectations: Record<
    string,
    (ts: any, blockIndexes: Map<object, number>, runs: { rs: Run; ts: Run }) => void
  > = {
    'column defaults keep their JS values (Date, bigint, objects, NaN)': (ts, _, runs) => {
      const tsColumns = runs.ts.outcome.result!.rawTables.posts.columns
      const rsColumns = runs.rs.outcome.result!.rawTables.posts.columns
      expect(tsColumns.publishedAt.default).toBeInstanceOf(Date)
      expect(rsColumns.publishedAt.default).toBe(tsColumns.publishedAt.default)
      expect(rsColumns.invalidDate.default).toBeInstanceOf(Date)
      expect(typeof rsColumns.big.default).toBe('bigint')
      expect(rsColumns.big.default).toBe(12345678901234567890n)
      expect(rsColumns.meta.default).toBe(tsColumns.meta.default)
      expect(rsColumns.notANumber.default).toBeNaN()
      expect(rsColumns.title.default).toBe('x')
      const rsLocales = runs.rs.outcome.result!.rawTables.posts_locales.columns
      expect(rsLocales.localizedDate.default).toBeInstanceOf(Date)
      expect(rsLocales.localizedDate.default).toBe(
        runs.ts.outcome.result!.rawTables.posts_locales.columns.localizedDate.default,
      )
    },
    'localized compound index uses the locales table built for this table only': (ts, _, runs) => {
      expect(ts.error).toStrictEqual({
        name: 'TypeError',
        message: "Cannot read properties of undefined (reading 'columns')",
      })
      expect(runs.rs.thrown).toBeInstanceOf(TypeError)
    },
    'compound index across localized and non localized': (ts, _, runs) => {
      expect(ts.error?.name).toBe('InvalidConfiguration')
      expect(runs.rs.thrown).toBeInstanceOf(InvalidConfiguration)
      expect((runs.rs.thrown as InvalidConfiguration).status).toBe(500)
    },
    'dbName function returning undefined falls back to default': (ts) =>
      expect(ts.result.rawTables.posts_items).toBeDefined(),
    'dbName function throwing is rethrown': (ts, _, runs) => {
      expect(ts.error).toStrictEqual({ name: 'TypeError', message: 'boom from dbName' })
      expect(runs.rs.thrown).toBeInstanceOf(TypeError)
    },
    'hasMany number unique (InvalidConfiguration)': (ts, _, runs) => {
      expect(ts.error?.name).toBe('InvalidConfiguration')
      expect(runs.rs.thrown).toBeInstanceOf(InvalidConfiguration)
    },
    'hasMany text unique (InvalidConfiguration)': (ts, _, runs) => {
      expect(ts.error?.name).toBe('InvalidConfiguration')
      expect(runs.rs.thrown).toBeInstanceOf(InvalidConfiguration)
    },
    'identifier too long (APIError)': (ts, _, runs) => {
      expect(ts.error?.name).toBe('APIError')
      expect(runs.rs.thrown).toBeInstanceOf(APIError)
      expect(runs.rs.thrown).not.toBeInstanceOf(InvalidConfiguration)
      expect((runs.rs.thrown as APIError).status).toBe(500)
      expect((runs.rs.thrown as APIError).data).toBeNull()
    },
    'same block slug with differing fields gets suffixed tables': (ts, blockIndexes) => {
      if (!ts.result.rawTables.posts_blocks_hero) {
        return // blocksAsJSON
      }
      expect(blockIndexes.size).toBeGreaterThan(0)
    },
  }
  const cases: Record<string, any[]> = {
    'column defaults keep their JS values (Date, bigint, objects, NaN)': [
      {
        slug: 'posts',
        fields: [
          { name: 'title', type: 'text', defaultValue: 'x' },
          { name: 'publishedAt', type: 'date', defaultValue: new Date(0) },
          { name: 'invalidDate', type: 'date', defaultValue: new Date(NaN) },
          { name: 'localizedDate', type: 'date', localized: true, defaultValue: new Date(1e12) },
          { name: 'big', type: 'number', defaultValue: 12345678901234567890n },
          { name: 'notANumber', type: 'number', defaultValue: NaN },
          { name: 'meta', type: 'json', defaultValue: { $date: 'not a date', nested: [1] } },
          { name: 'fn', type: 'text', defaultValue: () => 'computed' },
        ],
      },
    ],
    'localized compound index uses the locales table built for this table only': [
      {
        slug: 'posts',
        fields: [
          {
            name: 'locales',
            type: 'array',
            localized: true,
            fields: [{ name: 'title', type: 'text' }],
          },
        ],
        indexes: [{ fields: ['locales.title'] }],
      },
    ],
    'identifier too long (APIError)': [
      { slug: 'a'.repeat(70), fields: [{ name: 'title', type: 'text' }] },
    ],
    'hasMany text unique (InvalidConfiguration)': [
      { slug: 'posts', fields: [{ name: 'tags', type: 'text', hasMany: true, unique: true }] },
    ],
    'hasMany number unique (InvalidConfiguration)': [
      { slug: 'posts', fields: [{ name: 'nums', type: 'number', hasMany: true, unique: true }] },
    ],
    'dbName function returning undefined falls back to default': [
      {
        slug: 'posts',
        fields: [
          {
            name: 'items',
            type: 'array',
            dbName: () => undefined,
            fields: [{ name: 'title', type: 'text' }],
          },
          { name: 'sel', type: 'select', dbName: () => '', hasMany: true, options: ['a', 'b'] },
        ],
      },
    ],
    'dbName function throwing is rethrown': [
      {
        slug: 'posts',
        fields: [
          {
            name: 'items',
            type: 'array',
            dbName: () => {
              throw new TypeError('boom from dbName')
            },
            fields: [{ name: 'title', type: 'text' }],
          },
        ],
      },
    ],
    'compound index across localized and non localized': [
      {
        slug: 'posts',
        fields: [
          { name: 'a', type: 'text', localized: true },
          { name: 'b', type: 'text' },
        ],
        indexes: [{ fields: ['a', 'b'] }],
      },
    ],
    'same block slug with differing fields gets suffixed tables': [
      {
        slug: 'posts',
        fields: [
          {
            name: 'one',
            type: 'blocks',
            blocks: [{ slug: 'hero', fields: [{ name: 'title', type: 'text' }] }],
          },
          {
            name: 'two',
            type: 'blocks',
            blocks: [{ slug: 'hero', fields: [{ name: 'other', type: 'number' }] }],
          },
          {
            name: 'three',
            type: 'blocks',
            localized: true,
            blocks: [{ slug: 'hero', fields: [{ name: 'title', type: 'text' }] }],
          },
        ],
        versions: { drafts: true },
      },
      {
        slug: 'pages',
        fields: [
          {
            name: 'two',
            type: 'blocks',
            blocks: [{ slug: 'hero', fields: [{ name: 'other', type: 'number' }] }],
          },
        ],
      },
    ],
  }

  for (const [name, collections] of Object.entries(cases)) {
    it(name, async () => {
      const { buildConfig } = await import('payload')
      const { databaseAdapter } = await import('../../databaseAdapter.js')
      const config = await buildConfig({
        collections,
        db: databaseAdapter,
        localization: { defaultLocale: 'en', locales: ['en', 'es'] },
        secret: 'secret',
      })
      const payload = buildPayloadLike(config)
      for (const variant of variants) {
        collectBlockIndexes(payload, true)
        const tsRun = runTS(createAdapterState(payload, variant))
        const tsBlockIndexes = collectBlockIndexes(payload, true)
        const rsRun = runRS(createAdapterState(payload, variant))
        const rsBlockIndexes = collectBlockIndexes(payload, true)
        const label = `${name} [${variant.name}]`
        const ts = toJSON(tsRun.outcome)
        const rs = toJSON(rsRun.outcome)
        expect(rs, label).toStrictEqual(ts)
        expect(JSON.stringify(rs)).toBe(JSON.stringify(ts))
        expect(strictDifferences(tsRun, rsRun), label).toStrictEqual([])
        expect([...rsBlockIndexes.values()]).toStrictEqual([...tsBlockIndexes.values()])
        expect([...rsBlockIndexes.keys()].every((k) => tsBlockIndexes.has(k))).toBe(true)
        expectations[name]!(ts, tsBlockIndexes, { rs: rsRun, ts: tsRun })
      }
    })
  }

  const buildTestConfig = async (collections: any[]) => {
    const { buildConfig } = await import('payload')
    const { databaseAdapter } = await import('../../databaseAdapter.js')
    return buildConfig({
      collections,
      db: databaseAdapter,
      localization: { defaultLocale: 'en', locales: ['en', 'es'] },
      secret: 'secret',
    })
  }

  it('seeds block table indexes already present on block objects', async () => {
    const config = await buildTestConfig([
      {
        slug: 'posts',
        fields: [
          {
            name: 'one',
            type: 'blocks',
            blocks: [{ slug: 'hero', fields: [{ name: 'title', type: 'text' }] }],
          },
          {
            name: 'two',
            type: 'blocks',
            blocks: [{ slug: 'hero', fields: [{ name: 'other', type: 'number' }] }],
          },
        ],
      },
    ])
    const payload = buildPayloadLike(config)
    const variant = variants[0]
    const heroBlocks: any[] = []
    for (const collection of config.collections) {
      for (const field of collection.flattenedFields as any[]) {
        if (field.type === 'blocks') {
          heroBlocks.push(...field.blocks)
        }
      }
    }
    const seed = new Map<object, number>([[heroBlocks[0], 5]])

    collectBlockIndexes(payload, true)
    restoreBlockIndexes(seed)
    const tsRun = runTS(createAdapterState(payload, variant))
    const tsBlockIndexes = collectBlockIndexes(payload, true)
    restoreBlockIndexes(seed)
    const rsRun = runRS(createAdapterState(payload, variant))
    const rsBlockIndexes = collectBlockIndexes(payload, true)

    // a seeded index names the block relation (`_blocks_<slug>_<index>`)
    expect(JSON.stringify(toJSON(tsRun.outcome))).toContain('"_blocks_hero_5"')
    expect(JSON.stringify(toJSON(rsRun.outcome))).toBe(JSON.stringify(toJSON(tsRun.outcome)))
    expect([...rsBlockIndexes]).toStrictEqual([...tsBlockIndexes])
  })

  it('reads config objects like JS property access (getters, cycles, __proto__, dbName args)', async () => {
    class Option {
      readonly #value: string
      constructor(value: string) {
        this.#value = value
      }
      get label() {
        return this.#value.toUpperCase()
      }
      get value() {
        return this.#value
      }
    }
    const config = await buildTestConfig([
      {
        slug: 'posts',
        // upstream passes `{ tableName: undefined }` (an own key) for root tables
        dbName: (args: object) => `posts_${Object.keys(args).join('_')}`,
        fields: [
          { name: 'sel', type: 'select', options: ['a', 'b'] },
          { name: 'meta', type: 'json' },
          {
            name: 'layout',
            type: 'blocks',
            blocks: [{ slug: 'hero', fields: [{ name: 'title', type: 'text' }] }],
          },
        ],
      },
    ])
    const posts = config.collections.find((collection) => collection.slug === 'posts')!
    const field = (name: string) => posts.flattenedFields.find((f) => f.name === name) as any
    // class instances whose `value` is a prototype getter
    field('sel').options = [new Option('a'), new Option('b')]
    // an enumerable getter TS never reads: must neither throw nor be needed
    Object.defineProperty(field('sel'), 'unreadGetter', {
      enumerable: true,
      get() {
        throw new Error('never read')
      },
    })
    // an own `__proto__` key in a column default (kept by identity)
    field('meta').defaultValue = JSON.parse('{"__proto__":{"x":1},"y":2}')
    // a cycle reached from the block first: block.custom.owner is the collection
    for (const block of field('layout').blocks) {
      block.custom = { owner: posts }
    }
    const payload = buildPayloadLike(config)
    for (const variant of variants) {
      collectBlockIndexes(payload, true)
      const tsRun = runTS(createAdapterState(payload, variant))
      const tsBlockIndexes = collectBlockIndexes(payload, true)
      const rsRun = runRS(createAdapterState(payload, variant))
      const rsBlockIndexes = collectBlockIndexes(payload, true)
      const label = `property access [${variant.name}]`
      expect(tsRun.outcome.error, label).toBeUndefined()
      const ts = toJSON(tsRun.outcome)
      expect(JSON.stringify(toJSON(rsRun.outcome)), label).toBe(JSON.stringify(ts))
      expect(strictDifferences(tsRun, rsRun), label).toStrictEqual([])
      expect([...rsBlockIndexes]).toStrictEqual([...tsBlockIndexes])
      expect(ts.result.rawTables.posts_tableName.columns.sel.options).toStrictEqual(['a', 'b'])
      const rsMeta = rsRun.outcome.result!.rawTables.posts_tableName.columns.meta.default
      expect(Object.hasOwn(rsMeta, '__proto__')).toBe(true)
      expect(rsMeta).toBe(field('meta').defaultValue)
    }
  })

  it('re-init keeps tableNameMap and fieldConstraints entries like upstream', async () => {
    const first = buildPayloadLike(
      await buildTestConfig([
        { slug: 'posts', fields: [{ name: 'title', type: 'text', unique: true }] },
        { slug: 'pages', fields: [{ name: 'slug', type: 'text', unique: true }] },
      ]),
    )
    const second = buildPayloadLike(
      await buildTestConfig([
        { slug: 'pages', fields: [{ name: 'path', type: 'text', unique: true }] },
        { slug: 'authors', fields: [{ name: 'email2', type: 'text', unique: true }] },
      ]),
    )
    const variant = variants[0]
    const tsAdapter = createAdapterState(first, variant)
    const rsAdapter = createAdapterState(first, variant)
    runTS(tsAdapter)
    runRS(rsAdapter)
    tsAdapter.payload = second
    rsAdapter.payload = second
    const tsRun = runTS(tsAdapter)
    const rsRun = runRS(rsAdapter)

    expect(tsAdapter.tableNameMap.has('posts')).toBe(true)
    expect(Object.keys(tsAdapter.fieldConstraints.pages!)).toStrictEqual(['slug_idx', 'path_idx'])
    expect(JSON.stringify(toJSON(rsRun.outcome))).toBe(JSON.stringify(toJSON(tsRun.outcome)))
    expect(strictDifferences(tsRun, rsRun)).toStrictEqual([])
  })
})
