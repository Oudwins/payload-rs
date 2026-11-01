import { getTableColumns, is, SQL, sql } from 'drizzle-orm'
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core'
/**
 * Records every write-side `@payloadcms/drizzle` adapter operation executed by an int suite
 * (sqlite only) as JSONL, so the Rust port (crates/payload-sql-upsert) can replay the same
 * operations and be compared table-by-table.
 *
 * Per operation it stores: the op arguments and result, every `transformForWrite` call (input
 * data, frozen `Date.now()`, output RowToInsert or error, mutated data), every `upsertRow` call
 * (args, data, result id), `shouldUseOptimizedUpsertRow` decision, the read `transform` results
 * and the `buildQuery` / `selectDistinct` / `findMany` / `buildFindManyArgs` results (inputs owned
 * by other modules), the SQL statements drizzle sent to libsql, the error (if any) and database
 * dumps before/after the operation.
 *
 * Values use the engine encoding of test/__rs/write/capture.ts (`{"$undefined":true}`,
 * `{"$num":..}`, `{"$obj":..}` escapes, drizzle SQL as `{"$sql":[..]}`), so user data can never be
 * confused with an internal marker. Fields and config blocks use `encodeSchema`.
 *
 * Activated by `UPSERT_RECORD_OUT=<file.jsonl.gz>` through `record.setup.ts`. Events are buffered
 * and appended as gzip members (`gzip -dc` reads the concatenation). `UPSERT_MAX_OPS` caps the
 * number of recorded operations per file.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import zlib from 'node:zlib'

import toSnakeCase from '../../../packages/drizzle/node_modules/to-snake-case/index.js'
import { encodeSchema, encodeValue, withFrozenDate } from '../write/capture.js'

const dialect = new SQLiteAsyncDialect()
const outFile = process.env.UPSERT_RECORD_OUT
const maxOps = Number(process.env.UPSERT_MAX_OPS ?? Infinity)

type Ctx = {
  currentUpsert: number
  data: Record<string, any>
  inFindMany: number
}

const als = new AsyncLocalStorage<Ctx>()
const adapterIDs = new WeakMap<object, number>()
const fieldsIDs = new WeakMap<object, number>()
const fieldsByHash = new Map<string, number>()
let nextAdapterID = 1
let nextFieldsID = 1
let seq = 0
const active = new Set<Ctx>()
type Dumped = { columns: string[]; rows: string[][] }

/**
 * Incremental database mirror: dumping every table around every operation is too slow for large
 * schemas, so the recorder keeps the last dump and only re-dumps tables that may have changed:
 * tables referenced by an operation's statements (plus their foreign-key descendants for
 * cascades), tables written by statements outside recorded operations (seeding, snapshot
 * restores), and everything after a rollback or a concurrent operation.
 */
type Mirror = {
  cache: Record<string, Dumped>
  children: Map<string, string[]>
  dirty: 'all' | Set<string>
  /** `count(*)` / `max(rowid)` per table, to notice writes the drizzle logger did not see. */
  fingerprints: Record<string, string>
  tables: string[]
}

const mirrors = new WeakMap<object, Mirror>()
const sessionMirrors = new WeakMap<object, Mirror>()

const tablesIn = (mirror: Mirror, query: string) => {
  const found = new Set<string>()
  for (const m of query.matchAll(/"([^"]+)"|`([^`]+)`|([A-Z_][A-Z0-9_]*)/gi)) {
    const name = m[1] ?? m[2] ?? m[3]
    if (name && mirror.tables.includes(name)) {
      found.add(name)
    }
  }
  return found
}

const withDescendants = (mirror: Mirror, tables: Iterable<string>) => {
  const out = new Set<string>()
  const visit = (t: string) => {
    if (out.has(t)) {
      return
    }
    out.add(t)
    for (const c of mirror.children.get(t) ?? []) {
      visit(c)
    }
  }
  for (const t of tables) {
    visit(t)
  }
  return out
}

const markDirty = (mirror: Mirror, tables: 'all' | Iterable<string>) => {
  if (mirror.dirty === 'all') {
    return
  }
  if (tables === 'all') {
    mirror.dirty = 'all'
    return
  }
  for (const t of withDescendants(mirror, tables)) {
    mirror.dirty.add(t)
  }
}

const isWrite = (query: string) =>
  /^\s*(insert|update|delete|replace|drop|create|alter)/i.test(query)

let buffered: string[] = []
let bufferedBytes = 0

const flush = () => {
  if (outFile && buffered.length) {
    fs.appendFileSync(outFile, zlib.gzipSync(buffered.join(''), { level: 9 }))
  }
  buffered = []
  bufferedBytes = 0
}

if (outFile) {
  process.on('exit', flush)
}

const write = (event: unknown) => {
  if (outFile) {
    const line = JSON.stringify(event) + '\n'
    buffered.push(line)
    bufferedBytes += line.length
    if (bufferedBytes > 32 * 1024 * 1024) {
      flush()
    }
  }
}

export const flushRecording = flush

export const recording = () => Boolean(outFile)

const sqlToQuery = (value: SQL) => {
  const { params, sql: text } = dialect.sqlToQuery(value)
  return { params: params.map((p) => encodeValue(p)), sql: text }
}

/** Encoded field definitions (`encodeSchema`), written once per distinct content. */
const fieldsID = (fields: any) => {
  if (fields && typeof fields === 'object') {
    const cached = fieldsIDs.get(fields)
    if (cached) {
      return cached
    }
  }
  const encoded = encodeSchema(fields)
  const text = JSON.stringify(encoded)
  const hash = createHash('sha1').update(text).digest('hex')
  let id = fieldsByHash.get(hash)
  if (!id) {
    id = nextFieldsID++
    fieldsByHash.set(hash, id)
    write({ type: 'fields', fields: encoded, fieldsID: id })
  }
  if (fields && typeof fields === 'object') {
    fieldsIDs.set(fields, id)
  }
  return id
}

const hookLogger = (db: any, mirror: Mirror) => {
  const session = db?.session ?? db?._?.session
  if (!session) {
    return
  }
  sessionMirrors.set(session, mirror)
  if (session.__upsertRecorder) {
    return
  }
  const logger = {
    logQuery(query: string, params: unknown[]) {
      const ctx = als.getStore()
      if (ctx) {
        ctx.data.statements.push({ params: params.map((p) => encodeValue(p)), sql: query })
      } else if (isWrite(query)) {
        const current = sessionMirrors.get(session)
        if (current) {
          const tables = tablesIn(current, query)
          markDirty(current, tables.size ? tables : 'all')
        }
      }
    },
  }
  session.logger = logger
  if (session.options) {
    session.options.logger = logger
  }
  session.__upsertRecorder = true
}

export const markRollback = (adapter: any) => {
  const mirror = mirrors.get(adapter)
  if (mirror) {
    markDirty(mirror, 'all')
  }
}

const dumpTable = async (db: any, name: string): Promise<Dumped | undefined> => {
  const columns: { name: string }[] = await db.all(
    sql.raw(`select name from pragma_table_info('${name}')`),
  )
  if (!columns.length) {
    return undefined
  }
  const select = columns.map((c, i) => `quote("${c.name}") as c${i}`).join(', ')
  const objects: Record<string, unknown>[] = await db.all(
    sql.raw(`select ${select} from "${name}" order by rowid`),
  )
  if (!objects.length) {
    return undefined
  }
  return {
    columns: columns.map((c) => c.name),
    rows: objects.map((o) => columns.map((_, i) => String(o[`c${i}`]))),
  }
}

/** Re-dumps `tables` into the mirror; returns the per-table diff (`null` = now empty). */
const refresh = async (db: any, mirror: Mirror, tables: Iterable<string>) => {
  const diff: Record<string, Dumped | null> = {}
  for (const name of tables) {
    const next = await dumpTable(db, name)
    const prev = mirror.cache[name]
    if (JSON.stringify(prev ?? null) !== JSON.stringify(next ?? null)) {
      diff[name] = next ?? null
    }
    if (next) {
      mirror.cache[name] = next
    } else {
      delete mirror.cache[name]
    }
  }
  return diff
}

const fingerprint = async (db: any, mirror: Mirror) => {
  const parts = mirror.tables.map(
    (t) => `select '${t}' as t, count(*) || ':' || coalesce(max(rowid), '') as f from "${t}"`,
  )
  const out: Record<string, string> = {}
  for (let i = 0; i < parts.length; i += 200) {
    const rows: { f: string; t: string }[] = await db.all(
      sql.raw(parts.slice(i, i + 200).join(' union all ')),
    )
    for (const r of rows) {
      out[r.t] = String(r.f)
    }
  }
  return out
}

const ensureMirror = async (adapter: any, db: any) => {
  let mirror = mirrors.get(adapter)
  if (mirror) {
    return mirror
  }
  const rows: { name: string }[] = await db.all(
    sql.raw(
      `select name from sqlite_master where type = 'table' and (name not like 'sqlite_%' or name = 'sqlite_sequence') order by name`,
    ),
  )
  const tables = rows.map((r) => r.name)
  const children = new Map<string, string[]>()
  for (const t of tables) {
    const fks: { table: string }[] = await db.all(
      sql.raw(`select "table" from pragma_foreign_key_list('${t}')`),
    )
    for (const fk of fks) {
      children.set(fk.table, [...(children.get(fk.table) ?? []), t])
    }
  }
  mirror = { cache: {}, children, dirty: 'all', fingerprints: {}, tables }
  mirrors.set(adapter, mirror)
  return mirror
}

const lastDDL = new WeakMap<object, string>()

/**
 * Emits a `schema` event the first time an adapter is seen and whenever its database schema
 * changes (some suites re-initialise Payload with a different config on the same adapter).
 */
const ensureAdapter = async (adapter: any, db: any) => {
  let id = adapterIDs.get(adapter)
  if (!id) {
    id = nextAdapterID++
    adapterIDs.set(adapter, id)
  }
  const ddl: { sql: string }[] = await db.all(
    sql.raw(`select sql from sqlite_master where sql is not null order by rowid`),
  )
  const ddlText = ddl.map((d) => d.sql).join(';\n')
  if (lastDDL.get(adapter) === ddlText) {
    return id
  }
  lastDDL.set(adapter, ddlText)
  mirrors.delete(adapter)
  const fk: { foreign_keys: number }[] = await db.all(sql.raw(`pragma foreign_keys`))
  write({
    type: 'schema',
    adapterID: id,
    ddl: ddl.map((d) => d.sql),
    fieldConstraints: adapter.fieldConstraints,
    foreignKeys: fk[0]?.foreign_keys,
    options: {
      allowIDOnCreate: adapter.allowIDOnCreate,
      limitedBoundParameters: adapter.limitedBoundParameters,
      localesSuffix: adapter.localesSuffix,
      relationshipsSuffix: adapter.relationshipsSuffix,
      versionsSuffix: adapter.versionsSuffix,
    },
    rawTables: adapter.rawTables,
    tableColumns: drizzleColumns(adapter),
    writeAdapter: writeAdapterState(adapter),
  })
  return id
}

/** The adapter state `transformForWrite` reads (see test/__rs/write/capture.ts). */
const writeAdapterState = (adapter: any) => {
  const tables: Record<string, boolean> = {}
  for (const [name, table] of Object.entries<any>(adapter.tables ?? {})) {
    if (table) {
      tables[name] = Boolean(table._uuid)
    }
  }
  return {
    name: adapter.name,
    blocksAsJSON: Boolean(adapter.blocksAsJSON),
    configBlocks: encodeSchema(adapter.payload?.config?.blocks ?? []),
    tableNameMap: Object.fromEntries(adapter.tableNameMap),
    tables,
  }
}

/**
 * Columns of the final drizzle tables (in drizzle order). They can differ from `rawTables` when
 * `beforeSchemaInit` / `afterSchemaInit` hooks extend tables directly.
 */
const drizzleColumns = (adapter: any) => {
  const out: Record<
    string,
    { columnType: string; default?: unknown; key: string; name: string }[]
  > = {}
  for (const [tableName, table] of Object.entries<any>(adapter.tables ?? {})) {
    out[tableName] = Object.entries<any>(getTableColumns(table)).map(([key, col]) => ({
      columnType: col.columnType,
      default:
        col.default !== undefined && !is(col.default, SQL) ? encodeValue(col.default) : undefined,
      key,
      name: col.name,
    }))
  }
  return out
}

const tableNameFor = (adapter: any, method: string, args: any) => {
  const versions = [
    'createVersion',
    'createGlobalVersion',
    'updateVersion',
    'updateGlobalVersion',
    'deleteVersions',
  ]
  const slug =
    method === 'updateJobs'
      ? 'payload-jobs'
      : (args.collection ?? args.collectionSlug ?? args.global ?? args.globalSlug ?? args.slug)
  if (!slug) {
    return undefined
  }
  const base = toSnakeCase(slug)
  return adapter.tableNameMap.get(
    versions.includes(method) ? `_${base}${adapter.versionsSuffix}` : base,
  )
}

const summarizeArgs = (adapter: any, method: string, args: any) => {
  const out: Record<string, unknown> = {}
  for (const key of [
    'id',
    'collection',
    'collectionSlug',
    'global',
    'globalSlug',
    'slug',
    'customID',
    'returning',
    'options',
    'limit',
    'autosave',
    'createdAt',
    'parent',
    'publishedLocale',
    'snapshot',
    'updatedAt',
  ]) {
    if (args && key in args) {
      out[key] = encodeValue(args[key])
    }
  }
  out.hasWhere = Boolean(args?.where)
  out.data = encodeValue(args?.data)
  out.versionData = encodeValue(args?.versionData)
  out.tableName = tableNameFor(adapter, method, args || {})
  return out
}

export const wrapOperation = (
  method: string,
  orig: (...a: any[]) => any,
  hasDraftsEnabled: (e: any) => boolean,
) =>
  async function (this: any, args: any) {
    if (!outFile || als.getStore() || this?.name !== 'sqlite' || seq >= maxOps) {
      return orig.call(this, args)
    }
    const adapter = this
    const { getTransaction } =
      await import('../../../packages/drizzle/src/utilities/getTransaction.js')
    const db = await getTransaction(adapter, args?.req)
    const adapterID = await ensureAdapter(adapter, db)
    const mirror = await ensureMirror(adapter, db)
    hookLogger(adapter.drizzle, mirror)
    hookLogger(db, mirror)

    const ctx: Ctx = {
      currentUpsert: -1,
      data: {
        concurrent: active.size > 0,
        distinct: [],
        findArgs: [],
        findMany: [],
        queries: [],
        reads: [],
        shouldUse: [],
        statements: [],
        transforms: [],
        upserts: [],
      },
      inFindMany: 0,
    }
    for (const other of active) {
      other.data.concurrent = true
    }
    active.add(ctx)

    let draftsEnabled: boolean | undefined
    try {
      if (method === 'createVersion') {
        draftsEnabled = hasDraftsEnabled(adapter.payload.collections[args.collectionSlug].config)
      } else if (method === 'createGlobalVersion') {
        draftsEnabled = hasDraftsEnabled(
          adapter.payload.globals.config.find((g: any) => g.slug === args.globalSlug),
        )
      }
    } catch {
      // ignore
    }

    let summary: Record<string, unknown>
    try {
      summary = summarizeArgs(adapter, method, args)
    } catch (e) {
      summary = { $encodeError: String(e) }
    }
    const prints = await fingerprint(db, mirror)
    for (const [t, f] of Object.entries(prints)) {
      if (mirror.fingerprints[t] !== f || t === 'sqlite_sequence') {
        markDirty(mirror, [t])
      }
    }
    const dirty = mirror.dirty
    mirror.dirty = new Set()
    const beforeDiff = await refresh(db, mirror, dirty === 'all' ? mirror.tables : dirty)
    let result: unknown
    let error: any
    try {
      result = await als.run(ctx, () => orig.call(this, args))
    } catch (e) {
      error = e
    }
    let afterDiff: { $dumpError: string } | Record<string, Dumped | null>
    try {
      const touched = new Set<string>(['sqlite_sequence'].filter((t) => mirror.tables.includes(t)))
      for (const st of ctx.data.statements) {
        for (const t of tablesIn(mirror, st.sql)) {
          touched.add(t)
        }
      }
      afterDiff = await refresh(db, mirror, withDescendants(mirror, touched))
      mirror.fingerprints = await fingerprint(db, mirror)
      if (error || ctx.data.concurrent) {
        // the transaction may be rolled back / other operations interleave
        markDirty(mirror, ctx.data.concurrent ? 'all' : touched)
      }
    } catch (e) {
      afterDiff = { $dumpError: String(e) }
      markDirty(mirror, 'all')
    }
    active.delete(ctx)

    write({
      type: 'op',
      adapterID,
      adapterOptions: {
        allowIDOnCreate: adapter.allowIDOnCreate,
        limitedBoundParameters: adapter.limitedBoundParameters,
      },
      afterDiff,
      args: summary,
      beforeDiff,
      draftsEnabled,
      error: error ? serializeError(error) : undefined,
      method,
      result: safeEncode(result),
      seq: ++seq,
      ...ctx.data,
    })
    if (error) {
      throw error
    }
    return result
  }

const safeEncode = (value: unknown) => {
  try {
    return encodeValue(value)
  } catch (e) {
    return { $encodeError: String(e) }
  }
}

const serializeError = (error: any) => {
  const cause = error?.cause
  return {
    name: error?.constructor?.name ?? error?.name,
    cause: cause ? { code: cause.code, message: cause.message, rawCode: cause.rawCode } : undefined,
    data: safeEncode(error?.data?.errors ? { errors: error.data.errors } : undefined),
    message: String(error?.message ?? error),
  }
}

export const wrapTransformForWrite = (orig: (...a: any[]) => any) => (args: any) => {
  const ctx = als.getStore()
  if (!ctx) {
    return orig(args)
  }
  const call: Record<string, unknown> = {
    adapterName: args.adapter?.name,
    blocksAsJSON: Boolean(args.adapter?.blocksAsJSON),
    data: safeEncode(args.data),
    enableAtomicWrites: Boolean(args.enableAtomicWrites),
    fieldsID: fieldsID(args.fields),
    parentIsLocalized: Boolean(args.parentIsLocalized),
    path: args.path ?? '',
    tableName: args.tableName,
    upsert: ctx.currentUpsert,
  }
  ctx.data.transforms.push(call)
  const now = Date.now()
  call.now = now
  try {
    const result = withFrozenDate(now, () => orig(args))
    call.output = safeEncode(result)
    return result
  } catch (e: any) {
    call.error = { name: e?.name, message: e?.message }
    throw e
  } finally {
    call.dataAfter = safeEncode(args.data)
  }
}

export const wrapUpsertRow = (orig: (...a: any[]) => any) => async (args: any) => {
  const ctx = als.getStore()
  if (!ctx) {
    return orig(args)
  }
  const index = ctx.data.upserts.length
  const capture: Record<string, unknown> = {
    collectionSlug: args.collectionSlug,
    customID: safeEncode(args.customID),
    data: safeEncode(args.data),
    fieldsID: fieldsID(args.fields),
    globalSlug: args.globalSlug,
    id: safeEncode(args.id),
    ignoreResult: args.ignoreResult,
    operation: args.operation,
    path: args.path,
    tableName: args.tableName,
    upsertTarget: args.upsertTarget ? true : undefined,
    where: args.where ? sqlToQuery(args.where) : undefined,
  }
  ctx.data.upserts.push(capture)
  const previous = ctx.currentUpsert
  ctx.currentUpsert = index
  try {
    const result = await orig(args)
    capture.result = safeEncode(result)
    return result
  } catch (e) {
    capture.error = serializeError(e)
    throw e
  } finally {
    ctx.currentUpsert = previous
  }
}

export const wrapShouldUse = (orig: (...a: any[]) => any) => (args: any) => {
  const ctx = als.getStore()
  if (!ctx) {
    return orig(args)
  }
  const entry: Record<string, unknown> = {
    data: safeEncode(args.data),
    fieldsID: fieldsID(args.fields),
  }
  ctx.data.shouldUse.push(entry)
  try {
    const result = orig(args)
    entry.result = result
    return result
  } catch (e: any) {
    entry.error = { name: e?.name, message: e?.message }
    throw e
  }
}

/** Read `transform` calls made by the write operations themselves (not inside findMany). */
export const wrapReadTransform = (orig: (...a: any[]) => any) => (args: any) => {
  const ctx = als.getStore()
  if (!ctx || ctx.inFindMany) {
    return orig(args)
  }
  // encoded before the call: the read transform mutates the raw row
  const input = safeEncode(args.data)
  const inputID = safeEncode(args.data?.id)
  const result = orig(args)
  {
    const text = JSON.stringify(input)
    ctx.data.reads.push({
      // raw rows from `.returning()` are compared in full, large findFirst docs by id only
      input: text && text.length <= 20_000 ? input : undefined,
      inputID,
      output: safeEncode(result),
      upsert: ctx.currentUpsert,
    })
  }
  return result
}

export const wrapBuildFindManyArgs = (orig: (...a: any[]) => any) => (args: any) => {
  const result = orig(args)
  const ctx = als.getStore()
  if (ctx && !ctx.inFindMany) {
    ctx.data.findArgs.push({
      columns: result.columns ? safeEncode(result.columns) : undefined,
      keys: Object.keys(result),
      upsert: ctx.currentUpsert,
    })
  }
  return result
}

export const wrapBuildQuery = (orig: (...a: any[]) => any) => (args: any) => {
  const result = orig(args)
  const ctx = als.getStore()
  if (ctx && !ctx.inFindMany) {
    const orderBy =
      Array.isArray(result.orderBy) && result.orderBy.length
        ? sqlToQuery(
            sql.join(
              result.orderBy.map(({ column, order }: any) => order(column)),
              sql`, `,
            ),
          )
        : undefined
    ctx.data.queries.push({
      joins: result.joins?.length ?? 0,
      orderBy,
      where: result.where ? sqlToQuery(result.where) : undefined,
    })
  }
  return result
}

export const wrapSelectDistinct = (orig: (...a: any[]) => any) => (args: any) => {
  const result = orig(args)
  const ctx = als.getStore()
  if (!ctx || ctx.inFindMany || !result || typeof result.then !== 'function') {
    return result
  }
  const entry: { ids?: unknown[] } = {}
  ctx.data.distinct.push(entry)
  return Promise.resolve(result).then((rows: any[]) => {
    entry.ids = (rows || []).map((r) => safeEncode(r.id))
    return rows
  })
}

export const wrapFindMany = (orig: (...a: any[]) => any) => async (args: any) => {
  const ctx = als.getStore()
  if (!ctx) {
    return orig(args)
  }
  ctx.inFindMany++
  try {
    const result = await orig(args)
    ctx.data.findMany.push(safeEncode(result?.docs ?? []))
    return result
  } finally {
    ctx.inFindMany--
  }
}
