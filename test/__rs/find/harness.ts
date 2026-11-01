/**
 * Differential harness for the Rust port of `@payloadcms/drizzle` find/* and of drizzle's
 * relational query builder (crate `payload-sql-find`).
 *
 * Every relational query (`db.query[table].findMany/findFirst`) the TS implementation executes is
 * replayed through the Rust port (test binding `crates/payload-sql-find/napi-test`): the Rust SQL
 * must equal drizzle's `toSQL()` and the rows Rust reads must deep-equal drizzle's result, compared
 * in the `serializeForEngine` tree encoding (so `undefined` vs `null`, `Date`s and `bigint`s count).
 *
 * The test addon (loaded as `PAYLOAD_ENGINE_ADDON`) also backs `@payloadcms/engine-rs/sqlite`'s
 * client, which the vitest config aliases in place of `@libsql/client`: Rust runs each statement on
 * the same `payload-sqlite` client / transaction connection (`ConnId`) as the TS query. With
 * `PAYLOAD_SQLITE_CLIENT=libsql` (reference client) Rust falls back to its own client on the file.
 *
 * Results are written to `test/__rs/find/results/<suite>.json`, and the suite FAILS (afterAll) when
 * Rust did not run or any comparison differed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect } from 'vitest'

import * as drizzle from '../../../packages/drizzle/node_modules/drizzle-orm/index.js'
import { SQLiteRelationalQuery } from '../../../packages/drizzle/node_modules/drizzle-orm/sqlite-core/query-builders/query.js'
import { getSqliteConnId } from '../../../packages/engine-rs/src/sqlite/client.js'
import { toJsError } from '../../../packages/engine-rs/src/sqlite/errors.js'
import { getNativeSqlite } from '../../../packages/engine-rs/src/sqlite/native.js'

const { Column, getTableUniqueName, is, Many, mapColumnsInSQLToAlias, One, SQL, sql } =
  drizzle as any

const dirname = path.dirname(fileURLToPath(import.meta.url))

type CallFunction = (json: string) => string

type Native = {
  buildFindManyArgsRs: (handle: number, args: string) => string
  diffSchemas: (a: number, b: number) => string
  findManyRs: (handle: number, args: string, target: string, callFunction: CallFunction) => string
  registerPayload: (
    graph: string,
    options: string,
    tableNameMap: string,
    rawTables: string,
    rawRelations: string,
    schemaHandle?: number,
  ) => number
  registerRawSchema: (rawTables: string, rawRelations: string) => number
  registerSchema: (schema: string) => number
  relationalQuery: (
    schema: number,
    target: string,
    table: string,
    config: string,
    mode: string,
    callFunction: CallFunction,
  ) => string
}

let native: Native | undefined

/** The find test binding: the same module instance as the sqlite client's addon. */
export const getNative = (): Native => {
  if (!native) {
    if (!process.env.PAYLOAD_ENGINE_ADDON) {
      throw new Error(
        'PAYLOAD_ENGINE_ADDON must point at the find test addon (see test/__rs/find/build-addon.sh)',
      )
    }
    const mod = getNativeSqlite() as unknown as Native
    if (typeof mod.relationalQuery !== 'function' || typeof mod.findManyRs !== 'function') {
      throw new Error(`${process.env.PAYLOAD_ENGINE_ADDON} is not the find test addon`)
    }
    native = mod
  }
  return native
}

export const getDBPath = (): string => {
  const url = process.env.SQLITE_URL || process.env.DATABASE_URL || 'file:./payload.db'
  return path.resolve(url.replace(/^file:/, ''))
}

/**
 * Where Rust runs a statement: the `payload-sqlite` id of the drizzle session's libsql client or
 * transaction (`session.tx ?? session.client`), or the database file for the real libsql client.
 */
export const getTarget = (session: any): string => {
  const target = session?.tx ?? session?.client
  try {
    const connId = getSqliteConnId(target)
    stats.connections.shared++
    if (session?.tx) {
      stats.connections.transaction++
    }
    return JSON.stringify({ connId })
  } catch {
    stats.connections.ownClient++
    return JSON.stringify({ dbPath: getDBPath() })
  }
}

const RESERVED_KEYS = new Set(['$bigint', '$date', '$fn', '$num', '$obj', '$ref', '$undefined'])

/**
 * `serializeForEngine` tree encoding (what `encode_value` in payload-engine produces), used to
 * compare TS and Rust values exactly. Buffers have no typed encoding in the engine format yet and
 * are compared in their `toJSON()` form.
 */
export const encodeTyped = (value: unknown): unknown => {
  if (value === undefined) {
    return { $undefined: true }
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : { $num: String(value) }
  }
  if (typeof value === 'bigint') {
    return { $bigint: String(value) }
  }
  if (typeof value === 'function') {
    return { $fn: -1 }
  }
  if (value instanceof Date) {
    return { $date: Number.isNaN(value.getTime()) ? null : value.toISOString() }
  }
  if (Buffer.isBuffer(value)) {
    return encodeTyped(value.toJSON())
  }
  if (Array.isArray(value)) {
    return value.map(encodeTyped)
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as object)) {
    out[key] = encodeTyped((value as any)[key])
  }
  const keys = Object.keys(out)
  return keys.length === 1 && RESERVED_KEYS.has(keys[0]!) ? { $obj: out } : out
}

/** Inverse of {@link encodeTyped} for host-callback arguments (Buffers come back as Buffers). */
export const decodeTyped = (value: any): unknown => {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(decodeTyped)
  }
  const keys = Object.keys(value)
  if (keys.length === 1) {
    const [key] = keys
    const v = value[key!]
    switch (key) {
      case '$bigint':
        return BigInt(v)
      case '$date':
        return new Date(v === null ? Number.NaN : v)
      case '$num':
        return Number(v)
      case '$obj':
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decodeTyped(x)]))
      case '$undefined':
        return undefined
    }
  }
  if (keys.length === 2 && value.type === 'Buffer' && Array.isArray(value.data)) {
    return Buffer.from(value.data)
  }
  return Object.fromEntries(keys.map((k) => [k, decodeTyped(value[k])]))
}

/** JS functions the Rust side may call (`fromDriver` of custom columns), by id. */
const hostFunctions: Array<(value: unknown) => unknown> = []

const registerHostFunction = (fn: unknown): null | number => {
  if (typeof fn !== 'function') {
    return null
  }
  const existing = hostFunctions.indexOf(fn as any)
  if (existing !== -1) {
    return existing
  }
  hostFunctions.push(fn as any)
  return hostFunctions.length - 1
}

/** `callFunction` handed to the binding: `{ id, arg }` in, encoded result (or `$error`) out. */
export const callHostFunction: CallFunction = (json) => {
  const { id, arg } = JSON.parse(json)
  stats.hostCalls++
  try {
    return JSON.stringify(encodeTyped(hostFunctions[id]!(decodeTyped(arg))))
  } catch (err) {
    return JSON.stringify({ $error: errorInfo(err) })
  }
}

/**
 * Describes the live drizzle relational schema (`db._.schema`) for `DrizzleSchema::from_json`.
 * `register` assigns the `callFunction` ids of custom columns' `mapFrom` / `mapTo` (default: this
 * harness's host function registry).
 */
export const describeDrizzleSchema = (
  tablesConfig: any,
  tableNamesMap: Record<string, string>,
  register: (fn: unknown) => null | number = registerHostFunction,
) => {
  const out: Record<string, unknown> = {}
  for (const [tsName, tableConfig] of Object.entries<any>(tablesConfig)) {
    const columns: Record<string, unknown> = {}
    for (const [key, column] of Object.entries<any>(tableConfig.columns)) {
      columns[key] = {
        name: column.name,
        columnType: column.columnType,
        sqlType: column.getSQLType(),
        primary: column.primary,
        ...(column.config?.mode !== undefined ? { mode: column.config.mode } : {}),
        ...(column.columnType === 'SQLiteCustomColumn'
          ? {
              fromDriver: register(column.mapFrom),
              toDriver: register(column.mapTo),
            }
          : {}),
      }
    }
    const relations: Record<string, unknown> = {}
    for (const [key, relation] of Object.entries<any>(tableConfig.relations)) {
      const sourceTable = tableNamesMap[getTableUniqueName(relation.sourceTable)]
      const referencedTable = tableNamesMap[getTableUniqueName(relation.referencedTable)]
      if (is(relation, One) && relation.config) {
        relations[key] = {
          type: 'one',
          fields: relation.config.fields.map((c: any) => c.name),
          references: relation.config.references.map((c: any) => c.name),
          referencedTable,
          relationName: relation.relationName,
          sourceTable,
        }
      } else {
        relations[key] = {
          type: is(relation, Many) ? 'many' : 'one-no-config',
          referencedTable,
          relationName: relation.relationName,
          sourceTable,
        }
      }
    }
    out[tsName] = { columns, dbName: tableConfig.dbName, relations }
  }
  return out
}

const singleTable = (query: any) =>
  new SQL(query.queryChunks.map((c: any) => (is(c, Column) ? sql.identifier(c.name) : c)))

/**
 * Serializes a drizzle relational query config (functions and SQL objects rendered) to the JSON
 * form read by `QueryConfig::from_json`.
 */
export const serializeQueryConfig = ({
  alias,
  config,
  dialect,
  nested,
  schema,
  tableConfig,
  tableNamesMap,
}: {
  alias: string
  config: any
  dialect: any
  nested: boolean
  schema: any
  tableConfig: any
  tableNamesMap: Record<string, string>
}): any => {
  if (config === true || config === false) {
    return config
  }
  const render = (s: any) => {
    const rendered = dialect.sqlToQuery(s)
    // Key order matters for the comparison (Rust emits `sql` before `params`).
    const out: Record<string, unknown> = {}
    out.sql = rendered.sql
    out.params = rendered.params
    return out
  }
  const out: Record<string, unknown> = {}
  if ('columns' in config && config.columns !== undefined) {
    const columns: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(config.columns)) {
      columns[k] = v === undefined ? null : v
    }
    out.columns = columns
  }
  if (config.where) {
    const where =
      typeof config.where === 'function'
        ? config.where(tableConfig.columns, drizzle as any)
        : config.where
    if (where) {
      out.where = render(mapColumnsInSQLToAlias(where, alias))
    }
  }
  if (config.extras) {
    const extras =
      typeof config.extras === 'function'
        ? config.extras(tableConfig.columns, { sql })
        : config.extras
    const rendered: Record<string, unknown> = {}
    for (const [k, v] of Object.entries<any>(extras)) {
      const mapped = mapColumnsInSQLToAlias(v.sql, alias)
      rendered[k] = { ...render(nested ? mapped : singleTable(mapped)), alias: v.fieldAlias }
    }
    out.extras = rendered
  }
  if (config.orderBy) {
    const markerColumns: Record<string, unknown> = {}
    for (const key of Object.keys(tableConfig.columns)) {
      markerColumns[key] = { __column: key }
    }
    const ops = {
      asc: (c: any) => (c?.__column ? { column: c.__column, order: 'asc' } : sql`${c} asc`),
      desc: (c: any) => (c?.__column ? { column: c.__column, order: 'desc' } : sql`${c} desc`),
    }
    let orderBy =
      typeof config.orderBy === 'function' ? config.orderBy(markerColumns, ops) : config.orderBy
    if (!Array.isArray(orderBy)) {
      orderBy = [orderBy]
    }
    out.orderBy = orderBy.map((o: any) =>
      o?.column && o?.order
        ? o
        : render(is(o, Column) ? sql`${o}` : mapColumnsInSQLToAlias(o, alias)),
    )
  }
  if ('limit' in config && config.limit !== undefined) {
    out.limit = Number.isNaN(config.limit) ? null : config.limit
  }
  if ('offset' in config && config.offset !== undefined) {
    out.offset = Number.isNaN(config.offset) ? null : config.offset
  }
  if (config.with) {
    const withOut: Record<string, unknown> = {}
    for (const [k, v] of Object.entries<any>(config.with)) {
      const relation = tableConfig.relations[k]
      if (!relation || !v || v === true) {
        withOut[k] = !!v
        continue
      }
      const relTsName = tableNamesMap[getTableUniqueName(relation.referencedTable)]
      withOut[k] = serializeQueryConfig({
        alias: `${alias}_${k}`,
        config: v,
        dialect,
        nested: true,
        schema,
        tableConfig: schema[relTsName],
        tableNamesMap,
      })
    }
    out.with = withOut
  }
  const ordered: Record<string, unknown> = {}
  for (const key of ['columns', 'with', 'extras', 'orderBy', 'where', 'limit', 'offset']) {
    if (key in out) {
      ordered[key] = out[key]
    }
  }
  return ordered
}

/** `{ name, message }` of a thrown value, as compared against the Rust `EngineError`. */
export const errorInfo = (err: unknown): { message: string; name: string } => {
  const e = err as { message?: unknown; name?: unknown }
  return {
    name: typeof e?.name === 'string' ? e.name : 'Error',
    message: typeof e?.message === 'string' ? e.message : String(err),
  }
}

/** Every observable property of a libsql error object (the `cause` of a DrizzleQueryError). */
const causeInfo = (err: any): unknown =>
  err === undefined
    ? undefined
    : {
        ...errorInfo(err),
        className: err?.constructor?.name,
        code: err?.code,
        libsqlError: err?.libsqlError,
        rawCode: err?.rawCode,
        cause: err?.cause === undefined ? undefined : causeInfo(err.cause),
      }

/**
 * Compares a TS error with the Rust `EngineError` JSON (`{ name, message, data }`). Rust names the
 * class to construct, so a `DrizzleQueryError` (whose own `name` is the inherited `"Error"`) is
 * matched by class, and its `query`, `params` and `cause` (rebuilt with engine-rs' `toJsError`, as
 * the integration does) must match too. Returns a description of the difference, or undefined.
 */
export const compareErrors = (tsError: any, rustError: any): string | undefined => {
  const ts = errorInfo(tsError)
  const isDrizzleQueryError = tsError?.constructor?.name === 'DrizzleQueryError'
  const tsName = isDrizzleQueryError ? 'DrizzleQueryError' : ts.name
  if (tsName !== rustError?.name || ts.message !== rustError?.message) {
    return `name/message: ${JSON.stringify({ name: tsName, message: ts.message })}`
  }
  if (isDrizzleQueryError) {
    stats.drizzleQueryErrors++
    const data = rustError.data ?? {}
    if (tsError.query !== data.query) {
      return 'query'
    }
    if (!deepEqual(normalize(tsError.params), data.params)) {
      return 'params'
    }
    const rebuilt = data.cause ? toJsError(data.cause) : undefined
    if (!deepEqual(normalize(causeInfo(tsError.cause)), normalize(causeInfo(rebuilt)))) {
      return `cause: ${JSON.stringify(causeInfo(tsError.cause))} vs ${JSON.stringify(causeInfo(rebuilt))}`
    }
  }
  return undefined
}

/** JSON round trip (only for values that are JSON by construction, e.g. SQL params). */
export const normalize = (value: unknown) =>
  value === undefined ? null : JSON.parse(JSON.stringify(value))

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) {
    return true
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return Object.is(a, b) || a === b
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) {
    return false
  }
  return ka.every((k) => deepEqual((a as any)[k], (b as any)[k]))
}

export { deepEqual }

export type Stats = {
  [key: string]: unknown
  connections: { ownClient: number; shared: number; transaction: number }
  drizzleQueryErrors: number
  hostCalls: number
  mismatches: unknown[]
  rqb: {
    errorsBoth: number
    errorsBothMessageMismatch: number
    nonEmptyResults: number
    resultMatch: number
    resultMatchOnRetry: number
    resultMismatch: number
    rustRan: number
    sqlMatch: number
    sqlMismatch: number
    total: number
  }
}

export const stats: Stats = {
  connections: { ownClient: 0, shared: 0, transaction: 0 },
  drizzleQueryErrors: 0,
  hostCalls: 0,
  mismatches: [],
  rqb: {
    errorsBoth: 0,
    errorsBothMessageMismatch: 0,
    nonEmptyResults: 0,
    resultMatch: 0,
    resultMatchOnRetry: 0,
    resultMismatch: 0,
    rustRan: 0,
    sqlMatch: 0,
    sqlMismatch: 0,
    total: 0,
  },
}

const MAX_MISMATCHES = 40

let mismatchCount = 0

/** Number of recorded differences so far (relational queries, buildFindManyArgs and findMany). */
export const getMismatchCount = () => mismatchCount

export const recordMismatch = (entry: unknown, list: unknown[] = stats.mismatches) => {
  mismatchCount++
  if (list.length < MAX_MISMATCHES) {
    list.push(entry)
  }
}

const schemaHandles = new WeakMap<object, number>()

const getSchemaHandleFor = (schema: any, tableNamesMap: Record<string, string>): number => {
  let handle = schemaHandles.get(schema)
  if (handle === undefined) {
    handle = getNative().registerSchema(
      JSON.stringify(describeDrizzleSchema(schema, tableNamesMap)),
    )
    schemaHandles.set(schema, handle)
  }
  return handle
}

const getSchemaHandle = (query: any): number =>
  getSchemaHandleFor(query.schema, query.tableNamesMap)

/** Raw drizzle results of relational queries, keyed by their config object. */
export const rawResultsByConfig = new WeakMap<
  object,
  { array: unknown[]; copies: Map<unknown, unknown> }
>()

const runRust = (query: any, serialized: any, countRun = true) => {
  const out = JSON.parse(
    getNative().relationalQuery(
      getSchemaHandle(query),
      getTarget(query.session),
      query.tableConfig.tsName,
      JSON.stringify(serialized),
      query.mode,
      callHostFunction,
    ),
  )
  if (countRun) {
    stats.rqb.rustRan++
  }
  return out
}

let installed = false

export const installRelationalQueryHarness = () => {
  if (installed) {
    return
  }
  installed = true
  const proto = SQLiteRelationalQuery.prototype as any
  const execute = proto.execute

  proto.execute = async function patchedExecute(this: any) {
    // Rust runs right after the TS statement was queued on the payload-sqlite worker (drizzle
    // submits it synchronously) and before the JS thread can queue anything else, so both read
    // at adjacent queue positions even while other operations write concurrently.
    const tsPromise = Promise.resolve(execute.call(this))
    let serialized: unknown
    let rust: any
    let harnessError: unknown
    try {
      serialized = serializeForRust(this)
      rust = runRust(this, serialized)
    } catch (err) {
      harnessError = err
    }

    let tsResult: unknown
    let tsError: unknown
    try {
      tsResult = await tsPromise
      if (this.config && typeof this.config === 'object' && Array.isArray(tsResult)) {
        // Snapshot now: callers (the read transform) mutate the rows afterwards, while findMany
        // sorts the array in place; keep both the array and per-row copies.
        rawResultsByConfig.set(this.config, {
          array: tsResult,
          copies: new Map(tsResult.map((row) => [row, encodeTyped(row)])),
        })
      }
    } catch (err) {
      tsError = err
    }

    try {
      if (harnessError) {
        throw harnessError
      }
      await compare(this, tsResult, tsError, rust, serialized, async () => {
        const retry = Promise.resolve(execute.call(this))
        const rustRetry = runRust(this, serialized, false)
        return {
          rust: rustRetry,
          ts: await retry.catch((err: unknown) => ({ $tsError: errorInfo(err) })),
        }
      })
    } catch (err) {
      recordMismatch({ kind: 'harness-error', message: String((err as Error)?.stack ?? err) })
    }

    if (tsError) {
      throw tsError
    }
    return tsResult
  }
}

const serializeForRust = (query: any) =>
  serializeQueryConfig({
    alias: query.tableConfig.tsName,
    config: query.config,
    dialect: query.dialect,
    nested: false,
    schema: query.schema,
    tableConfig: query.tableConfig,
    tableNamesMap: query.tableNamesMap,
  })

/** Re-reads after a result difference (concurrent writers), up to this many times. */
export const MAX_RETRIES = 20
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const compare = async (
  query: any,
  tsResult: unknown,
  tsError: unknown,
  rust: any,
  serialized: unknown,
  rerunBoth: () => Promise<{ rust: any; ts: unknown }>,
) => {
  const s = stats.rqb
  s.total++
  let tsSQL: any
  try {
    tsSQL = query.toSQL()
  } catch (err) {
    tsSQL = { error: String(err) }
  }

  const sqlEqual =
    !tsSQL.error && rust.sql === tsSQL.sql && deepEqual(normalize(tsSQL.params), rust.params)
  if (sqlEqual) {
    s.sqlMatch++
  } else {
    s.sqlMismatch++
  }

  if (tsError || rust.error) {
    if (tsError && rust.error) {
      s.errorsBoth++
      const difference = compareErrors(tsError, rust.error)
      if (difference) {
        s.errorsBothMessageMismatch++
        recordMismatch({
          difference,
          kind: 'error-message',
          rustError: rust.error,
          table: query.tableConfig.tsName,
          tsError: errorInfo(tsError),
        })
      }
      return
    }
    s.resultMismatch++
    recordMismatch({
      kind: 'error',
      rustError: rust.error,
      serialized,
      table: query.tableConfig.tsName,
      tsError: String(tsError),
      tsSQL,
    })
    return
  }

  if (deepEqual(encodeTyped(tsResult), rust.result)) {
    s.resultMatch++
    if (Array.isArray(rust.result) ? rust.result.length > 0 : rust.result?.$undefined !== true) {
      s.nonEmptyResults++
    }
    if (!sqlEqual) {
      recordMismatch({ kind: 'sql', rustSQL: rust.sql, serialized, tsSQL })
    }
    return
  }

  // A concurrent writer can still commit between the two reads (e.g. when the TS statement was not
  // queued synchronously): re-read both until they agree or the retries are exhausted.
  let retry: { rust: any; ts: unknown } | undefined
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await sleep(25)
    retry = await rerunBoth()
    if (deepEqual(encodeTyped(retry.ts), retry.rust.result)) {
      s.resultMatchOnRetry++
      return
    }
  }
  s.resultMismatch++
  recordMismatch({
    kind: 'result',
    rust: retry?.rust.result,
    rustFirst: rust.result,
    rustSQL: rust.sql,
    serialized,
    table: query.tableConfig.tsName,
    ts: encodeTyped(retry?.ts),
    tsFirst: encodeTyped(tsResult),
    tsSQL,
  })
}

/** Report name: the suite plus the adapter flavour of test/__rs/find/databaseAdapter.ts. */
const reportName = (suite: string) => {
  const flavour = process.env.RS_FIND_ADAPTER
  const parts = [suite]
  if (flavour && flavour !== 'sqlite') {
    parts.push(flavour.replace(/^sqlite-/, ''))
  }
  if (process.env.RS_FIND_BLOCKS_AS_JSON === 'true') {
    parts.push('blocksAsJSON')
  }
  if (process.env.RS_FIND_TRANSACTIONS === 'true') {
    parts.push('tx')
  }
  if (process.env.PAYLOAD_SQLITE_CLIENT === 'libsql') {
    parts.push('libsql')
  }
  return parts.join('.')
}

export const writeReport = (suite: string) => {
  const dir = process.env.RS_FIND_RESULTS_DIR || path.join(dirname, 'results')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${reportName(suite)}.json`), JSON.stringify(stats, null, 2))
}

type HarnessOptions = {
  /**
   * The suite extends the drizzle schema in `beforeSchemaInit` / `afterSchemaInit`, so the schema
   * built from `rawTables` is expected to differ from the live one (Rust then uses the live one).
   */
  hasSchemaExtensions?: boolean
}

export const harnessOptions: HarnessOptions = {}

/** Counters that must be zero for the run to pass, by name. */
const failures = () => {
  const out: Record<string, number> = {
    harnessErrors: [...stats.mismatches, ...((stats.bridgeMismatches as unknown[]) ?? [])].filter(
      (m: any) => m?.kind === 'harness-error',
    ).length,
    mismatches: mismatchCount,
    rqbErrorMismatch: stats.rqb.errorsBothMessageMismatch,
    rqbResultMismatch: stats.rqb.resultMismatch,
    rqbSqlMismatch: stats.rqb.sqlMismatch,
    rustNotRun: stats.rqb.total - stats.rqb.rustRan,
  }
  for (const key of ['buildFindManyArgs', 'findMany'] as const) {
    const c = stats[key] as Record<string, number> | undefined
    if (c) {
      out[`${key}Mismatch`] = c.mismatch!
      out[`${key}Error`] = c.error!
      out[`${key}ErrorMismatch`] = c.bothErrorMessageMismatch!
      out[`${key}RustNotRun`] = c.total! - c.rustRan!
    }
  }
  const schemaFromRaw = stats.schemaFromRaw as { equal: boolean } | undefined
  if (schemaFromRaw && !harnessOptions.hasSchemaExtensions) {
    out.schemaFromRawDiffers = schemaFromRaw.equal ? 0 : 1
  }
  return out
}

export const installFindHarness = (suite: string, options: HarnessOptions = {}) => {
  Object.assign(harnessOptions, options)
  installRelationalQueryHarness()
  afterAll(() => {
    stats.failures = failures()
    writeReport(suite)
    expect(stats.rqb.total, 'no relational query was compared').toBeGreaterThan(0)
    expect(stats.rqb.rustRan, 'Rust did not run').toBe(stats.rqb.total)
    expect(stats.failures).toEqual(
      Object.fromEntries(Object.keys(stats.failures as object).map((k) => [k, 0])),
    )
  })
}
