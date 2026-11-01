/**
 * Differential checks for `buildFindManyArgs` and `findMany`.
 *
 * The suite specs wrap both TS exports (vi.mock). Every call runs the TS implementation, then the
 * Rust port with the same inputs. The Rust port uses the Rust query builder (`payload-sql-query`
 * behind the `QueryBuilder` trait, see crates/payload-sql-find/src/query.rs); nothing is bridged
 * back to TS. Errors are compared by name and message.
 */
import { getTransaction } from '../../../packages/drizzle/src/utilities/getTransaction.js'
import { InternalBlockTableNameIndex } from '../../../packages/drizzle/src/utilities/validateExistingBlockIsIdentical.js'
import {
  createFunctionRegistry,
  serializeForEngine,
} from '../../../packages/engine-rs/src/serialize.js'
import {
  callHostFunction,
  compareErrors,
  deepEqual,
  describeDrizzleSchema,
  encodeTyped,
  errorInfo,
  getNative,
  getTarget,
  harnessOptions,
  MAX_RETRIES,
  rawResultsByConfig,
  recordMismatch,
  serializeQueryConfig,
  sleep,
  stats,
} from './harness.js'

const BLOCK_MARKER = '__rsBlockTableNameIndex'

const counters = {
  buildArgs: {
    bothError: 0,
    bothErrorMessageMismatch: 0,
    error: 0,
    match: 0,
    mismatch: 0,
    rustRan: 0,
    total: 0,
  },
  findMany: {
    bothError: 0,
    bothErrorMessageMismatch: 0,
    error: 0,
    match: 0,
    matchOnRetry: 0,
    mismatch: 0,
    nonEmpty: 0,
    rustRan: 0,
    total: 0,
  },
}
stats.buildFindManyArgs = counters.buildArgs
stats.findMany = counters.findMany
const mismatches: unknown[] = []
stats.bridgeMismatches = mismatches

const record = (entry: unknown) => {
  recordMismatch(entry, mismatches)
}

/** serializeForEngine with `block[InternalBlockTableNameIndex]` copied to a plain marker property. */
const serializeWithBlockMarkers = (value: unknown): string => {
  const marked: any[] = []
  const seen = new Set<unknown>()
  const walk = (v: any) => {
    if (!v || typeof v !== 'object' || seen.has(v)) {
      return
    }
    seen.add(v)
    if (v[InternalBlockTableNameIndex] !== undefined) {
      v[BLOCK_MARKER] = v[InternalBlockTableNameIndex]
      marked.push(v)
    }
    for (const child of Array.isArray(v) ? v : Object.values(v)) {
      walk(child)
    }
  }
  walk(value)
  try {
    return serializeForEngine(value, createFunctionRegistry())
  } finally {
    for (const v of marked) {
      delete v[BLOCK_MARKER]
    }
  }
}

/** Keyed by `adapter.drizzle`: a re-`init()`ed adapter (new schema) gets a new handle. */
const payloadHandles = new WeakMap<object, number>()

const getPayloadHandle = (adapter: any): number => {
  let handle = payloadHandles.get(adapter.drizzle)
  if (handle === undefined) {
    const payload = adapter.payload
    const collections: Record<string, unknown> = {}
    for (const [slug, collection] of Object.entries<any>(payload.collections)) {
      collections[slug] = { config: collection.config, customIDType: collection.customIDType }
    }
    const graph = serializeWithBlockMarkers({
      blocks: payload.blocks,
      collections,
      config: payload.config,
    })
    const schemaHandle = getNative().registerSchema(
      JSON.stringify(
        describeDrizzleSchema(adapter.drizzle._.schema, adapter.drizzle._.tableNamesMap),
      ),
    )
    stats.adapter = {
      blocksAsJSON: !!adapter.blocksAsJSON,
      idType: adapter.idType,
    }
    handle = getNative().registerPayload(
      graph,
      JSON.stringify({
        blocksAsJSON: !!adapter.blocksAsJSON,
        idType: adapter.idType,
        limitedBoundParameters: !!adapter.limitedBoundParameters,
        localesSuffix: adapter.localesSuffix,
        name: adapter.name,
        relationshipsSuffix: adapter.relationshipsSuffix,
        versionsSuffix: adapter.versionsSuffix,
      }),
      JSON.stringify(Object.fromEntries(adapter.tableNameMap)),
      JSON.stringify(adapter.rawTables),
      JSON.stringify(adapter.rawRelations),
      // Schema extensions (afterSchemaInit) only exist in the live drizzle schema.
      harnessOptions.hasSchemaExtensions ? schemaHandle : undefined,
    )
    payloadHandles.set(adapter.drizzle, handle)
    // `DrizzleSchema::from_raw` (integration path from RawSchema) must equal the live schema.
    const rawHandle = getNative().registerRawSchema(
      JSON.stringify(adapter.rawTables),
      JSON.stringify(adapter.rawRelations),
    )
    const diff = getNative().diffSchemas(schemaHandle, rawHandle)
    stats.schemaFromRaw = diff ? { diff, equal: false } : { equal: true }
  }
  return handle
}

const fieldsSpec = (adapter: any, fields: unknown) => {
  for (const [slug, collection] of Object.entries<any>(adapter.payload.collections)) {
    if (collection.config.flattenedFields === fields) {
      return { collection: slug }
    }
  }
  return { graph: JSON.parse(serializeWithBlockMarkers(fields)) }
}

/** Keeps `undefined` values (e.g. `{ in: undefined }`) when passing args to Rust. */
const graphArg = (value: unknown) =>
  value === undefined
    ? undefined
    : { $graph: JSON.parse(serializeForEngine(value, createFunctionRegistry())) }

const UUID_ALIAS = /[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}/g

const normalizeAliases = (value: unknown) =>
  JSON.parse(JSON.stringify(value ?? null).replace(UUID_ALIAS, '<alias>'))

// findMany calls buildFindManyArgs synchronously before its first await.
let pendingFindMany: { config?: unknown } | undefined

export const wrapBuildFindManyArgs =
  (original: (args: any) => any) =>
  (args: any): any => {
    let result: any
    let tsError: unknown
    try {
      result = original(args)
    } catch (err) {
      tsError = err
    }
    if (pendingFindMany && result) {
      pendingFindMany.config = result
      pendingFindMany = undefined
    }
    try {
      compareBuildArgs(args, result, tsError)
    } catch (err) {
      record({
        kind: 'harness-error',
        message: String((err as Error)?.stack ?? err),
        where: 'buildArgs',
      })
    }
    if (tsError) {
      throw tsError
    }
    return result
  }

const compareBuildArgs = (args: any, result: any, tsError: unknown) => {
  const c = counters.buildArgs
  c.total++
  const { adapter } = args
  const rust = JSON.parse(
    getNative().buildFindManyArgsRs(
      getPayloadHandle(adapter),
      JSON.stringify({
        collectionSlug: args.collectionSlug,
        depth: args.depth,
        draftsEnabled: args.draftsEnabled,
        fields: fieldsSpec(adapter, args.fields),
        joinQuery: graphArg(args.joinQuery),
        locale: args.locale,
        select: graphArg(args.select),
        tableName: args.tableName,
        versions: args.versions,
      }),
    ),
  )
  c.rustRan++
  if (tsError || rust.error) {
    const tsErr = tsError ? errorInfo(tsError) : undefined
    const difference = tsError && rust.error ? compareErrors(tsError, rust.error) : 'one side'
    if (tsErr && rust.error) {
      c.bothError++
    }
    if (difference) {
      if (tsErr && rust.error) {
        c.bothErrorMessageMismatch++
      } else {
        c.error++
      }
      record({
        difference,
        kind: 'buildArgs-error',
        rustError: rust.error,
        table: args.tableName,
        tsError: tsErr ?? null,
      })
    }
    return
  }
  const db = adapter.drizzle
  const ts = serializeQueryConfig({
    alias: args.tableName,
    config: result,
    dialect: db.dialect,
    nested: false,
    schema: db._.schema,
    tableConfig: db._.schema[args.tableName],
    tableNamesMap: db._.tableNamesMap,
  })
  if (deepEqual(normalizeAliases(ts), normalizeAliases(rust.result))) {
    c.match++
  } else {
    c.mismatch++
    record({ kind: 'buildArgs', rust: rust.result, select: args.select, table: args.tableName, ts })
  }
}

const PAGINATION_KEYS = [
  'hasNextPage',
  'hasPrevPage',
  'limit',
  'nextPage',
  'page',
  'pagingCounter',
  'prevPage',
  'totalDocs',
  'totalPages',
]

/** Runs the TS findMany, capturing the relational query config its buildFindManyArgs built. */
const runTSFindMany = async (self: any, original: (args: any) => Promise<any>, args: any) => {
  const token: { config?: unknown } = {}
  pendingFindMany = token
  let promise: Promise<any>
  try {
    promise = original.call(self, args)
  } finally {
    if (pendingFindMany === token) {
      pendingFindMany = undefined
    }
  }
  try {
    return { config: token.config, result: await promise, error: undefined as unknown }
  } catch (err) {
    return { config: token.config, error: err, result: undefined as any }
  }
}

export const wrapFindMany = (original: (args: any) => Promise<any>) =>
  async function findManyWrapper(this: any, args: any) {
    const ts = await runTSFindMany(this, original, args)
    try {
      // The db findMany used: the request's transaction (still open here) or the adapter's client.
      const db: any = await getTransaction(args.adapter, args.req)
      const target = getTarget(db.session)
      const c = counters.findMany
      c.total++
      let outcome = evaluateFindMany(args, ts, runRustFindMany(args, target))
      c.rustRan++
      // Concurrent writers can commit between (and inside) the TS and Rust runs: re-run both until
      // they agree or the retries are exhausted.
      for (let attempt = 0; outcome.mismatch && attempt < MAX_RETRIES; attempt++) {
        await sleep(25)
        const retry = await runTSFindMany(this, original, args)
        const next = evaluateFindMany(args, retry, runRustFindMany(args, target))
        if (!next.mismatch) {
          c.matchOnRetry++
        }
        outcome = next.mismatch ? next : { ...next, retried: true }
      }
      if (outcome.mismatch) {
        c.mismatch++
        record(outcome.mismatch)
      } else if (!outcome.retried && !outcome.error) {
        c.match++
        if (outcome.nonEmpty) {
          c.nonEmpty++
        }
      }
    } catch (err) {
      record({
        kind: 'harness-error',
        message: String((err as Error)?.stack ?? err),
        where: 'findMany',
      })
    }
    if (ts.error) {
      throw ts.error
    }
    return ts.result
  }

const runRustFindMany = (args: any, target: string) =>
  JSON.parse(
    getNative().findManyRs(
      getPayloadHandle(args.adapter),
      JSON.stringify({
        collectionSlug: args.collectionSlug,
        draftsEnabled: args.draftsEnabled,
        fields: fieldsSpec(args.adapter, args.fields),
        joins: graphArg(args.joins),
        limit: args.limit,
        locale: args.locale,
        page: args.page,
        pagination: args.pagination,
        select: graphArg(args.select),
        sort: graphArg(args.sort),
        tableName: args.tableName,
        versions: args.versions,
        where: graphArg(args.where),
      }),
      target,
      callHostFunction,
    ),
  )

type FindManyOutcome = { error?: boolean; mismatch?: unknown; nonEmpty?: boolean; retried?: boolean }

const evaluateFindMany = (
  args: any,
  ts: { config: unknown; error: unknown; result: any },
  rust: any,
): FindManyOutcome => {
  const c = counters.findMany
  if (ts.error || rust.error) {
    const tsErr = ts.error ? errorInfo(ts.error) : undefined
    const difference = ts.error && rust.error ? compareErrors(ts.error, rust.error) : 'one side'
    if (tsErr && rust.error) {
      c.bothError++
    }
    if (difference) {
      if (tsErr && rust.error) {
        c.bothErrorMessageMismatch++
      } else {
        c.error++
      }
      record({
        args: JSON.stringify(
          { limit: args.limit, page: args.page, sort: args.sort, where: args.where },
          (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? `<number ${v}>` : v),
        ),
        difference,
        kind: 'findMany-error',
        rustError: rust.error,
        table: args.tableName,
        tsError: tsErr ?? null,
      })
    }
    return { error: true }
  }
  // An early return (no distinct ids) never reaches the relational query.
  const captured = ts.config ? rawResultsByConfig.get(ts.config) : undefined
  const tsRaw = captured ? captured.array.map((row) => captured.copies.get(row)) : []
  const tsPagination = encodeTyped(
    Object.fromEntries(PAGINATION_KEYS.map((k) => [k, ts.result[k]])),
  )
  const rustPagination = Object.fromEntries(PAGINATION_KEYS.map((k) => [k, rust.result[k]]))
  const docsEqual = deepEqual(tsRaw, rust.result.docs)
  const paginationEqual = deepEqual(tsPagination, rustPagination)
  if (docsEqual && paginationEqual) {
    return { nonEmpty: rust.result.docs.length > 0 }
  }
  return {
    mismatch: {
      args: {
        limit: args.limit,
        page: args.page,
        sort: args.sort,
        table: args.tableName,
        where: args.where,
      },
      docsEqual,
      kind: 'findMany',
      paginationEqual,
      rustPagination,
      rustDocs: docsEqual ? undefined : rust.result.docs,
      trace: rust.trace,
      tsDocs: docsEqual ? undefined : tsRaw,
      tsPagination,
    },
  }
}
