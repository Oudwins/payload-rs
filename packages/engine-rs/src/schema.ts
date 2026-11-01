import type { EntryReader } from './serialize.js'

// engine-rs has no node_modules: import payload's error classes by path (the same module 'payload'
// resolves to in this monorepo, so `instanceof` holds)
// oxlint-disable-next-line payload/no-relative-monorepo-imports -- no 'payload' dependency is installed here
import { APIError } from '../../payload/src/errors/APIError.js'
// oxlint-disable-next-line payload/no-relative-monorepo-imports -- no 'payload' dependency is installed here
import { InvalidConfiguration } from '../../payload/src/errors/InvalidConfiguration.js'
import { getNativeEngine } from './native.js'
import {
  createEntryReader,
  createFunctionRegistry,
  deserializeFromEngine,
  serializeForEngine,
} from './serialize.js'

type AnyObject = Record<PropertyKey, any>

/** The subset of the drizzle adapter `buildRawSchema` reads. */
export type RawSchemaAdapter = {
  autoIncrement?: boolean
  blocksAsJSON?: boolean
  idType: string
  localesSuffix?: string
  payload: {
    blocks: Record<string, unknown>
    collections: Record<string, { config: unknown; customIDType?: string }>
    config: AnyObject
  }
  relationshipsSuffix?: string
  versionsSuffix?: string
}

export type RawSchemaResult = {
  /** Block objects that carry `InternalBlockTableNameIndex` after the build. */
  blockTableNameIndexes: Map<object, number>
  fieldConstraints: Record<string, Record<string, string>>
  foreignKeys: Set<string>
  indexes: Set<string>
  rawRelations: Record<string, Record<string, unknown>>
  /** Placeholder tables TS assigns and never fills are own keys holding `undefined`, like upstream. */
  rawTables: Record<string, any>
  tableNameMap: Map<string, string>
}

/** The adapter state `buildRawSchema` writes. */
export type RawSchemaAdapterState = {
  fieldConstraints: Record<string, Record<string, string>>
  foreignKeys: Set<string>
  indexes: Set<string>
  rawRelations: Record<string, Record<string, unknown>>
  rawTables: Record<string, unknown>
  tableNameMap: Map<string, string>
}

export type EngineErrorShape = { data?: unknown; message: string; name: string }

const builtinErrors: Record<string, new (message: string) => Error> = {
  Error,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
}

/**
 * Builds the error upstream throws for an engine error: payload's `APIError` /
 * `InvalidConfiguration` (default status 500, `data` passed through) or the JS built-in error
 * class of the same name. Unknown names become an `Error` with that `name`.
 */
export const createEngineError = ({ name, data, message }: EngineErrorShape): Error => {
  switch (name) {
    case 'APIError':
      return new APIError(message, undefined, (data ?? undefined) as null | Record<string, unknown>)
    case 'InvalidConfiguration':
      return new InvalidConfiguration(message)
  }
  const BuiltinError = builtinErrors[name]
  if (BuiltinError) {
    return new BuiltinError(message)
  }
  const error = new Error(message) as { data?: unknown } & Error
  error.name = name
  if (data !== undefined && data !== null) {
    error.data = data
  }
  return error
}

/**
 * Collects `[path, value]` for every object reachable from `root` that has own property `symbol`,
 * through the properties `serializeForEngine` serializes (read with the same `entriesOf`).
 */
const findSymbolPaths = (
  root: unknown,
  symbol: symbol,
  entriesOf: EntryReader,
): [string[], number][] => {
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
    const entries: [string, unknown][] = Array.isArray(v)
      ? Array.from(v, (item, i) => [String(i), item])
      : entriesOf(v)
    for (const [key, item] of entries) {
      path.push(key)
      walk(item)
      path.pop()
    }
  }
  walk(root)
  return out
}

/** Resolves a path the engine reports, through the properties `serializeForEngine` serialized. */
const resolvePath = (root: unknown, path: string[], entriesOf: EntryReader): unknown =>
  path.reduce<unknown>((v, key) => {
    if (Array.isArray(v)) {
      return v[Number(key)]
    }
    return typeof v === 'object' && v !== null
      ? entriesOf(v).find(([entryKey]) => entryKey === key)?.[1]
      : undefined
  }, root)

/**
 * Rust port of `@payloadcms/drizzle` `buildRawSchema` with the SQLite `setColumnID`.
 *
 * Unlike the TS version it does not mutate the adapter: it returns the state `buildRawSchema`
 * produces. Pass `internalBlockTableNameIndex` (the `InternalBlockTableNameIndex` symbol) to read
 * existing values from, and write the resulting values onto, the block objects like upstream does.
 * Column defaults are the `field.defaultValue` values themselves (same `Date` / object references),
 * like upstream `withDefault`.
 * Errors are thrown through `createError({ name, message, data })`, by default `createEngineError`
 * (payload's `APIError` / `InvalidConfiguration`, or the JS built-in error class). Errors thrown by
 * `dbName` / `enumName` functions are rethrown as-is.
 */
export const buildRawSchemaRS = ({
  adapter,
  createError = createEngineError,
  internalBlockTableNameIndex,
}: {
  adapter: RawSchemaAdapter
  createError?: (error: EngineErrorShape) => Error
  internalBlockTableNameIndex?: symbol
}): RawSchemaResult => {
  const { payload } = adapter
  const collections: Record<string, { config: unknown; customIDType?: string }> = {}
  for (const slug of Object.keys(payload.collections)) {
    const { config, customIDType } = payload.collections[slug]!
    collections[slug] = { config, customIDType }
  }
  const root = { blocks: payload.blocks, collections, config: payload.config }

  const registry = createFunctionRegistry()
  const entriesOf = createEntryReader()
  const graph = serializeForEngine(root, registry, entriesOf)

  const options = {
    autoIncrement: adapter.autoIncrement,
    blocksAsJSON: adapter.blocksAsJSON,
    blockTableNameIndexes: internalBlockTableNameIndex
      ? findSymbolPaths(root, internalBlockTableNameIndex, entriesOf)
      : [],
    idType: adapter.idType,
    localesSuffix: adapter.localesSuffix,
    relationshipsSuffix: adapter.relationshipsSuffix,
    versionsSuffix: adapter.versionsSuffix,
  }

  let hostError: { error: unknown } | undefined
  const callFunction = (id: number, argJSON: string): string => {
    try {
      const fn = registry.functions[id]!
      // `{ tableName: undefined }` for root tables: an own key, like upstream `createTableName`
      return serializeForEngine(fn(deserializeFromEngine(JSON.parse(argJSON), registry)), registry)
    } catch (error) {
      hostError = { error }
      return '{"$hostError":true}'
    }
  }

  let resultJSON: string
  try {
    resultJSON = getNativeEngine().buildRawSchema(graph, JSON.stringify(options), callFunction)
  } catch (error) {
    if (hostError) {
      throw hostError.error
    }
    let parsed: EngineErrorShape | undefined
    try {
      parsed = JSON.parse((error as Error).message)
    } catch {
      throw error
    }
    throw createError(parsed!)
  }

  const result = JSON.parse(resultJSON)

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
        ? resolvePath(root, source.path, entriesOf)
        : deserializeFromEngine(source.value, registry)
  }

  const blockTableNameIndexes = new Map<object, number>()
  for (const [path, index] of result.blockTableNameIndexes as [string[], number][]) {
    const block = resolvePath(root, path, entriesOf) as AnyObject
    blockTableNameIndexes.set(block, index)
    if (internalBlockTableNameIndex) {
      block[internalBlockTableNameIndex] = index
    }
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
 * Writes a `buildRawSchemaRS` result onto the adapter the way upstream `buildRawSchema` mutates it:
 * `indexes` / `foreignKeys` are replaced, while `rawTables`, `rawRelations`, `tableNameMap` and
 * `fieldConstraints` are assigned into the existing objects. That keeps entries from an earlier
 * `init()` that this build does not overwrite (and the existing `Map` key order), as upstream does;
 * sqlite `init` resets only `rawTables` / `rawRelations` itself before building.
 */
export const applyRawSchemaRS = <TAdapter extends RawSchemaAdapterState>({
  adapter,
  schema,
}: {
  adapter: TAdapter
  schema: RawSchemaResult
}): TAdapter => {
  adapter.indexes = schema.indexes
  adapter.foreignKeys = schema.foreignKeys
  for (const key of Object.keys(schema.rawTables)) {
    adapter.rawTables[key] = schema.rawTables[key]
  }
  for (const key of Object.keys(schema.rawRelations)) {
    adapter.rawRelations[key] = schema.rawRelations[key]!
  }
  for (const [key, value] of schema.tableNameMap) {
    adapter.tableNameMap.set(key, value)
  }
  for (const [table, constraints] of Object.entries(schema.fieldConstraints)) {
    if (!adapter.fieldConstraints?.[table]) {
      adapter.fieldConstraints[table] = {}
    }
    Object.assign(adapter.fieldConstraints[table], constraints)
  }
  return adapter
}
