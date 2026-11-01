/**
 * Schema half of `withRustEngine`: the sqlite adapter's `init` with upstream `buildRawSchema`
 * replaced by the raw schema the Rust engine built (and retains) for this adapter.
 */
import type { RawSchemaAdapter, RawSchemaResult } from '../schema.js'
import type { FunctionRegistry } from '../serialize.js'

// oxlint-disable-next-line payload/no-relative-monorepo-imports -- same module @payloadcms/drizzle uses (engine-rs has no drizzle dependency)
import { buildDrizzleRelations } from '../../../drizzle/src/schema/buildDrizzleRelations.js'
// oxlint-disable-next-line payload/no-relative-monorepo-imports -- same module @payloadcms/drizzle uses (engine-rs has no drizzle dependency)
import { buildDrizzleTable } from '../../../drizzle/src/sqlite/schema/buildDrizzleTable.js'
// oxlint-disable-next-line payload/no-relative-monorepo-imports -- same module @payloadcms/drizzle uses (engine-rs has no drizzle dependency)
import { executeSchemaHooks } from '../../../drizzle/src/utilities/executeSchemaHooks.js'
// oxlint-disable-next-line payload/no-relative-monorepo-imports -- same module @payloadcms/drizzle uses (engine-rs has no drizzle dependency)
import { InternalBlockTableNameIndex } from '../../../drizzle/src/utilities/validateExistingBlockIsIdentical.js'
import { applyRawSchemaRS } from '../schema.js'
import { deserializeFromEngine, serializeForEngine } from '../serialize.js'

type AnyObject = Record<PropertyKey, any>

/** The adapter options the engine reads (`optionsJson`, ENGINE_CONTRACT.md). */
export type EngineAdapterOptions = {
  allowIDOnCreate?: boolean
  autoIncrement?: boolean
  blocksAsJSON?: boolean
  idType: string
  limitedBoundParameters?: boolean
  localesSuffix?: string
  name: string
  relationshipsSuffix?: string
  versionsSuffix?: string
} & RawSchemaAdapter

export type EngineInput = {
  graphJson: string
  optionsJson: string
  /** The serialized graph root: `{ blocks, collections, config }`. */
  root: AnyObject
}

/** `graphJson` / `optionsJson` for `SqliteEngine.create` (same graph as `buildRawSchemaRS`). */
export const buildEngineInput = ({
  adapter,
  registry,
}: {
  adapter: EngineAdapterOptions
  registry: FunctionRegistry
}): EngineInput => {
  const { payload } = adapter
  const collections: Record<string, { config: unknown; customIDType?: string }> = {}
  for (const slug of Object.keys(payload.collections)) {
    const { config, customIDType } = payload.collections[slug]!
    collections[slug] = { config, customIDType }
  }
  const root = { blocks: payload.blocks, collections, config: payload.config }

  const options = {
    name: adapter.name,
    allowIDOnCreate: adapter.allowIDOnCreate,
    autoIncrement: adapter.autoIncrement,
    blocksAsJSON: adapter.blocksAsJSON,
    blockTableNameIndexes: findSymbolPaths(root, InternalBlockTableNameIndex),
    idType: adapter.idType,
    limitedBoundParameters: adapter.limitedBoundParameters,
    localesSuffix: adapter.localesSuffix,
    relationshipsSuffix: adapter.relationshipsSuffix,
    versionsSuffix: adapter.versionsSuffix,
  }

  return {
    graphJson: serializeForEngine(root, registry),
    optionsJson: JSON.stringify(options),
    root,
  }
}

/**
 * Decodes `SqliteEngine.rawSchema()` (the napi `buildRawSchema` JSON) like `buildRawSchemaRS`:
 * placeholder tables, original JS column defaults, and `InternalBlockTableNameIndex` written back
 * onto the block objects.
 */
export const decodeRawSchema = ({
  json,
  registry,
  root,
}: {
  json: string
  registry: FunctionRegistry
  root: AnyObject
}): RawSchemaResult => {
  const result = JSON.parse(json)

  const rawTables: Record<string, any> = {}
  for (const key of result.rawTableKeys as string[]) {
    rawTables[key] = result.rawTables[key]
  }

  for (const [table, column, source] of result.columnDefaults as [
    string,
    string,
    { path: string[] } | { value: unknown },
  ][]) {
    rawTables[table].columns[column].default =
      'path' in source
        ? resolvePath(root, source.path)
        : deserializeFromEngine(source.value, registry)
  }

  const blockTableNameIndexes = new Map<object, number>()
  for (const [path, index] of result.blockTableNameIndexes as [string[], number][]) {
    const block = resolvePath(root, path) as AnyObject
    blockTableNameIndexes.set(block, index)
    block[InternalBlockTableNameIndex] = index
  }

  return {
    blockTableNameIndexes,
    fieldConstraints: result.fieldConstraints,
    foreignKeys: new Set(result.foreignKeys),
    indexes: new Set(result.indexes),
    rawRelations: result.rawRelations,
    rawTables,
    tableNameMap: new Map(result.tableNameMap),
  }
}

/**
 * `@payloadcms/drizzle/sqlite` `init` after the raw schema is built: schema hooks, drizzle tables
 * and relations, exactly as upstream (`createEngine` stands in for `buildRawSchema`).
 */
export const initWithEngineSchema = async ({
  adapter,
  buildSchema,
}: {
  adapter: AnyObject
  buildSchema: () => RawSchemaResult
}) => {
  let locales: string[] | undefined

  adapter.rawRelations = {}
  adapter.rawTables = {}

  if (adapter.payload.config.localization) {
    locales = adapter.payload.config.localization.locales.map(({ code }: { code: string }) => code)
  }

  applyRawSchemaRS({ adapter: adapter as never, schema: buildSchema() })

  await executeSchemaHooks({ type: 'beforeSchemaInit', adapter: adapter as never })

  for (const tableName in adapter.rawTables) {
    buildDrizzleTable({
      adapter: adapter as never,
      locales: locales!,
      rawTable: adapter.rawTables[tableName],
    })
  }

  buildDrizzleRelations({
    adapter: adapter as never,
  })

  await executeSchemaHooks({ type: 'afterSchemaInit', adapter: adapter as never })

  adapter.schema = {
    ...adapter.tables,
    ...adapter.relations,
  }
}

/** Collects `[path, value]` for every object reachable from `root` that has own property `symbol`. */
const findSymbolPaths = (root: unknown, symbol: symbol): [string[], number][] => {
  const out: [string[], number][] = []
  const seen = new Set<object>()
  const path: string[] = []
  const walk = (v: unknown) => {
    if (typeof v !== 'object' || v === null || v instanceof Date || seen.has(v)) {
      return
    }
    seen.add(v)
    if (Object.prototype.hasOwnProperty.call(v, symbol)) {
      out.push([[...path], (v as AnyObject)[symbol]])
    }
    const keys = Array.isArray(v) ? v.map((_, i) => String(i)) : Object.keys(v)
    for (const key of keys) {
      path.push(key)
      walk((v as AnyObject)[key])
      path.pop()
    }
  }
  walk(root)
  return out
}

const resolvePath = (root: unknown, path: string[]): unknown =>
  path.reduce<unknown>((v, key) => (v as AnyObject | undefined)?.[key], root)
