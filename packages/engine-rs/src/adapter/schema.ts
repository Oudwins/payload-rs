/**
 * Schema half of `withRustEngine`: the sqlite adapter's `init` with upstream `buildRawSchema`
 * replaced by the raw schema the Rust engine built (and retains) for this adapter.
 */
import type { RawSchemaAdapter, RawSchemaResult } from '../schema.js'
import type { FunctionRegistry } from '../serialize.js'

import { buildDrizzleRelations } from '../../../drizzle/src/schema/buildDrizzleRelations.js'
import { buildDrizzleTable } from '../../../drizzle/src/sqlite/schema/buildDrizzleTable.js'
import { executeSchemaHooks } from '../../../drizzle/src/utilities/executeSchemaHooks.js'
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

  // own properties upstream holds `undefined` in (dropped by JSON), appended last as upstream has them
  for (const path of (result.undefinedProperties ?? []) as string[][]) {
    resolvePath(result.rawTables, path.slice(0, -1))[path.at(-1)!] = undefined
  }

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

const resolvePath = (root: unknown, path: string[]): any =>
  path.reduce<unknown>((v, key) => (v as AnyObject | undefined)?.[key], root)

/**
 * `setLiveSchema`'s description (ENGINE_CONTRACT.md) of the schema the adapter's drizzle instance
 * was given, after `beforeSchemaInit` / `afterSchemaInit`: `drizzle` from `db._.schema` /
 * `db._.tableNamesMap`, `rawTables` as JSON. A custom column's `fromDriver` / `toDriver` are
 * registered as host functions that decode their tree-encoded argument and call
 * `column.mapFromDriverValue` / `column.mapToDriverValue`.
 */
export const describeLiveSchema = ({
  db,
  rawTables,
  registry,
}: {
  db: AnyObject
  rawTables: unknown
  registry: FunctionRegistry
}): string => {
  const drizzle = describeDrizzleSchema({
    registry,
    tableNamesMap: db._.tableNamesMap,
    tablesConfig: db._.schema ?? {},
  })
  try {
    return JSON.stringify({ drizzle, rawTables })
  } catch {
    // a value JSON cannot hold (a bigint column default): the engine keeps its own raw tables
    return JSON.stringify({ drizzle })
  }
}

const drizzleEntityKind = Symbol.for('drizzle:entityKind')
const drizzleTableSchema = Symbol.for('drizzle:Schema')
const drizzleTableName = Symbol.for('drizzle:Name')

/** drizzle's `is(value, Class)` by entity kind, without importing a drizzle-orm copy. */
const isDrizzleEntity = (value: unknown, kind: string) => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  for (let cls = Object.getPrototypeOf(value).constructor; cls; cls = Object.getPrototypeOf(cls)) {
    if (drizzleEntityKind in cls && cls[drizzleEntityKind] === kind) {
      return true
    }
  }
  return false
}

/** drizzle's `getTableUniqueName`. */
const getTableUniqueName = (table: AnyObject) =>
  `${table[drizzleTableSchema] ?? 'public'}.${table[drizzleTableName]}`

/** A host function taking the tree-encoded value the engine passes (`callFunction`). */
const registerColumnFunction = ({
  fn,
  registry,
}: {
  fn: (value: unknown) => unknown
  registry: FunctionRegistry
}) => registry.functions.push((tree: unknown) => fn(deserializeFromEngine(tree, registry))) - 1

const describeDrizzleSchema = ({
  registry,
  tableNamesMap,
  tablesConfig,
}: {
  registry: FunctionRegistry
  tableNamesMap: Record<string, string>
  tablesConfig: Record<string, AnyObject>
}) => {
  const out: Record<string, unknown> = {}
  for (const [tsName, tableConfig] of Object.entries(tablesConfig)) {
    const columns: Record<string, unknown> = {}
    for (const [key, column] of Object.entries<AnyObject>(tableConfig.columns)) {
      const isCustom = column.columnType === 'SQLiteCustomColumn'
      columns[key] = {
        name: column.name,
        columnType: column.columnType,
        primary: column.primary,
        sqlType: column.getSQLType(),
        ...(column.config?.mode !== undefined ? { mode: column.config.mode } : {}),
        ...(isCustom && typeof column.mapFrom === 'function'
          ? {
              fromDriver: registerColumnFunction({
                fn: (value) => column.mapFromDriverValue(value),
                registry,
              }),
            }
          : {}),
        ...(isCustom && typeof column.mapTo === 'function'
          ? {
              toDriver: registerColumnFunction({
                fn: (value) => column.mapToDriverValue(value),
                registry,
              }),
            }
          : {}),
      }
    }
    const relations: Record<string, unknown> = {}
    for (const [key, relation] of Object.entries<AnyObject>(tableConfig.relations)) {
      const sourceTable = tableNamesMap[getTableUniqueName(relation.sourceTable)]
      const referencedTable = tableNamesMap[getTableUniqueName(relation.referencedTable)]
      if (isDrizzleEntity(relation, 'One') && relation.config) {
        relations[key] = {
          type: 'one',
          fields: relation.config.fields.map((column: AnyObject) => column.name),
          referencedTable,
          references: relation.config.references.map((column: AnyObject) => column.name),
          relationName: relation.relationName,
          sourceTable,
        }
      } else {
        relations[key] = {
          type: isDrizzleEntity(relation, 'Many') ? 'many' : 'one-no-config',
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
