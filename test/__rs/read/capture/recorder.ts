/**
 * Records every (args, output) pair of the drizzle read `transform` into golden
 * fixtures replayed by `cargo test -p payload-sql-read` (crates/payload-sql-read/tests/fixtures.rs).
 *
 * Fixture file format (`fixtures/<name>.json`):
 * {
 *   version: 1,
 *   name,
 *   timeZone,  // IANA zone of the capturing process (outputs of local-time dates depend on it)
 *   contexts: [{ tableNameMap, blocksAsJSON, config, blocks, collections }],
 *   fields: [graph],
 *   calls: [{ context, fields, tableName, parentIsLocalized, joinQuery, data, output } | {..., error }]
 * }
 * - `data`, `joinQuery`, `parentIsLocalized`, `output` use the tree encoding of ./encode.ts
 *   (`data` is captured before `transform` mutates it).
 * - `config`, `blocks`, `fields` are `serializeForEngine` graphs (decoded by `decode_graph`) of a
 *   pruned copy that keeps exactly the properties the read transform looks at (key presence and
 *   values preserved, including `undefined`), plus `__rsBlockTableNameIndex` on blocks mirroring
 *   `block[InternalBlockTableNameIndex]`.
 *
 * Schema-linked mode (`RS_READ_SCHEMA_LINKED=1`, written to `fixtures/schema-linked/<name>.json`):
 * each context instead holds ONE unpruned `serializeForEngine` graph
 * `{ config: { collections, globals, localization }, collections, blocks, fields: [FlattenedField[]] }`
 * (the `build_raw_schema` input plus every distinct `fields` array passed to `transform`, sharing
 * object identity with the config), the adapter `schemaOptions` and the TS `tableNameMap`; calls
 * reference `graph.fields[call.fields]`. The cargo test builds the RawSchema from that graph and
 * resolves block table names through `schema_block_index` (the production path).
 */
import fs from 'fs'
import path from 'path'

import { InternalBlockTableNameIndex } from '../../../../packages/drizzle/src/utilities/validateExistingBlockIsIdentical.js'
import {
  createFunctionRegistry,
  serializeForEngine,
} from '../../../../packages/engine-rs/src/serialize.js'
import { encodeTree } from './encode.js'
import { walkObjects } from './graph.js'

const fieldKeys = [
  'name',
  'type',
  'virtual',
  'localized',
  'hasMany',
  'relationTo',
  'dbName',
  'defaultLimit',
] as const

type Pruned = Record<string, unknown>

const pick = (source: Record<string, unknown>, out: Pruned, key: string) => {
  if (key in source) {
    const value = source[key]
    out[key] = typeof value === 'function' ? '[function]' : value
  }
}

const createPruner = () => {
  const cache = new Map<object, Pruned>()

  const pruneBlock = (block: unknown): unknown => {
    if (typeof block !== 'object' || block === null) {
      return block
    }
    const cached = cache.get(block)
    if (cached) {
      return cached
    }
    const source = block as Record<string | symbol, unknown>
    const out: Pruned = {}
    cache.set(block, out)
    pick(source as Record<string, unknown>, out, 'slug')
    if ('flattenedFields' in source) {
      out.flattenedFields = pruneFields(source.flattenedFields)
    }
    if (source[InternalBlockTableNameIndex] !== undefined) {
      out.__rsBlockTableNameIndex = source[InternalBlockTableNameIndex]
    }
    return out
  }

  const pruneField = (field: unknown): unknown => {
    if (typeof field !== 'object' || field === null) {
      return field
    }
    const cached = cache.get(field)
    if (cached) {
      return cached
    }
    const source = field as Record<string, unknown>
    const out: Pruned = {}
    cache.set(field, out)
    for (const key of fieldKeys) {
      pick(source, out, key)
    }
    if ('flattenedFields' in source) {
      out.flattenedFields = pruneFields(source.flattenedFields)
    }
    if ('blocks' in source) {
      out.blocks = Array.isArray(source.blocks) ? source.blocks.map(pruneBlock) : source.blocks
    }
    return out
  }

  const pruneFields = (fields: unknown): unknown =>
    Array.isArray(fields) ? fields.map(pruneField) : fields

  return { pruneBlock, pruneFields }
}

const graph = (value: unknown) =>
  JSON.parse(serializeForEngine(value, createFunctionRegistry())) as unknown

type Call = Record<string, unknown>

type Recorder = {
  calls: Call[]
  contextIDs: WeakMap<object, Map<string, number>>
  contexts: unknown[]
  fields: unknown[]
  fieldsByIdentity: WeakMap<object, number>
  fieldsByString: Map<string, number>
  seen: Set<string>
}

const createRecorder = (): Recorder => ({
  calls: [],
  contextIDs: new WeakMap(),
  contexts: [],
  fields: [],
  fieldsByIdentity: new WeakMap(),
  fieldsByString: new Map(),
  seen: new Set(),
})

let recorder = createRecorder()

export const isSchemaLinked = process.env.RS_READ_SCHEMA_LINKED === '1'

type LinkedContext = {
  adapter: any
  fieldsIDs: Map<object, number>
  fieldsList: unknown[]
}

let linkedContexts: LinkedContext[] = []

export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

export const maxCallsPerFixture = Number(process.env.RS_READ_MAX_CALLS ?? 4000)

const contextID = (adapter: any, config: any): number => {
  // Some suites reconfigure the adapter at runtime (e.g. `payload.db.blocksAsJSON = true`),
  // so the cache key includes the mutable adapter state the transform reads.
  const signature = `${Boolean(adapter.blocksAsJSON)}|${adapter.tableNameMap.size}|${config === adapter.payload.config}`
  let byAdapter = recorder.contextIDs.get(adapter)
  if (!byAdapter) {
    byAdapter = new Map()
    recorder.contextIDs.set(adapter, byAdapter)
  }
  const existing = byAdapter.get(signature)
  if (existing !== undefined) {
    return existing
  }
  if (isSchemaLinked) {
    const id = linkedContexts.push({ adapter, fieldsIDs: new Map(), fieldsList: [] }) - 1
    recorder.contexts.push(null)
    byAdapter.set(signature, id)
    return id
  }
  const localization = config.localization
  const prunedLocalization =
    localization && typeof localization === 'object'
      ? {
          defaultLocale: localization.defaultLocale,
          localeCodes: localization.localeCodes,
          locales: Array.isArray(localization.locales)
            ? localization.locales.map((l: any) => (typeof l === 'string' ? l : l.code))
            : localization.locales,
        }
      : localization
  const { pruneBlock } = createPruner()
  const blocks: Record<string, unknown> = {}
  for (const [slug, block] of Object.entries(adapter.payload.blocks ?? {})) {
    blocks[slug] = pruneBlock(block)
  }
  const collections: Record<string, unknown> = {}
  for (const [slug, collection] of Object.entries<any>(adapter.payload.collections ?? {})) {
    collections[slug] = { customIDType: collection.customIDType }
  }
  const id =
    recorder.contexts.push({
      blocks: graph(blocks),
      blocksAsJSON: Boolean(adapter.blocksAsJSON),
      config: graph({ localization: prunedLocalization }),
      configIsPayloadConfig: config === adapter.payload.config,
      collections,
      tableNameMap: Object.fromEntries(adapter.tableNameMap),
    }) - 1
  byAdapter.set(signature, id)
  return id
}

const linkedFieldsID = (context: number, fields: unknown): number => {
  const linked = linkedContexts[context]!
  const key = fields as object
  let id = linked.fieldsIDs.get(key)
  if (id === undefined) {
    id = linked.fieldsList.push(fields) - 1
    linked.fieldsIDs.set(key, id)
  }
  return id
}

const linkedGraph = ({ adapter, fieldsList }: LinkedContext) => {
  const { payload } = adapter
  const root = {
    blocks: payload.blocks,
    collections: payload.collections,
    config: {
      collections: payload.config.collections,
      globals: payload.config.globals,
      localization: payload.config.localization,
    },
    fields: fieldsList,
  }
  // `[path, block[InternalBlockTableNameIndex]]` for every block object reachable from the root
  // (what the TS schema build set), so the cargo test can compare them with the Rust RawSchema.
  const blockIndexes: [string[], unknown][] = []
  walkObjects(root, (value, path) => {
    if (value[InternalBlockTableNameIndex] !== undefined) {
      blockIndexes.push([path, value[InternalBlockTableNameIndex]])
    }
  })
  return {
    blockIndexes,
    blocksAsJSON: Boolean(adapter.blocksAsJSON),
    graph: graph(root),
    schemaOptions: {
      autoIncrement: Boolean(adapter.autoIncrement),
      blocksAsJSON: Boolean(adapter.blocksAsJSON),
      idType: adapter.idType,
      localesSuffix: adapter.localesSuffix,
      relationshipsSuffix: adapter.relationshipsSuffix,
      versionsSuffix: adapter.versionsSuffix,
    },
    tableNameMap: Object.fromEntries(adapter.tableNameMap),
  }
}

const fieldsID = (fields: unknown): number => {
  if (typeof fields === 'object' && fields !== null) {
    const existing = recorder.fieldsByIdentity.get(fields)
    if (existing !== undefined) {
      return existing
    }
  }
  const serialized = serializeForEngine(
    createPruner().pruneFields(fields),
    createFunctionRegistry(),
  )
  let id = recorder.fieldsByString.get(serialized)
  if (id === undefined) {
    id = recorder.fields.push(JSON.parse(serialized)) - 1
    recorder.fieldsByString.set(serialized, id)
  }
  if (typeof fields === 'object' && fields !== null) {
    recorder.fieldsByIdentity.set(fields, id)
  }
  return id
}

export const wrapTransform = <T extends (args: any) => any>(transform: T): T => {
  return ((args: any) => {
    if (recorder.calls.length >= maxCallsPerFixture) {
      return transform(args)
    }
    const context = contextID(args.adapter, args.config)
    const call: Call = {
      context,
      fields: isSchemaLinked ? linkedFieldsID(context, args.fields) : fieldsID(args.fields),
      tableName: args.tableName,
      parentIsLocalized: encodeTree(args.parentIsLocalized),
      joinQuery: encodeTree(args.joinQuery),
      data: encodeTree(args.data),
    }
    const key = JSON.stringify(call)
    const isNew = !recorder.seen.has(key)
    recorder.seen.add(key)
    try {
      const result = transform(args)
      if (isNew) {
        call.output = encodeTree(result)
        recorder.calls.push(call)
      }
      return result
    } catch (error) {
      if (isNew) {
        call.error = {
          message: (error as Error)?.message,
          name: (error as Error)?.constructor?.name ?? 'Error',
        }
        recorder.calls.push(call)
      }
      throw error
    }
  }) as T
}

export const fixturesDir = path.resolve(
  import.meta.dirname,
  isSchemaLinked ? '../fixtures/schema-linked' : '../fixtures',
)

/** Writes the recorded calls to `fixtures/<name>.json` and starts a new recording. */
export const flushFixture = (name: string): number => {
  const count = recorder.calls.length
  if (count > 0) {
    fs.mkdirSync(fixturesDir, { recursive: true })
    fs.writeFileSync(
      path.join(fixturesDir, `${name}.json`),
      JSON.stringify({
        version: 1,
        name,
        timeZone: timeZone(),
        contexts: isSchemaLinked ? linkedContexts.map(linkedGraph) : recorder.contexts,
        fields: recorder.fields,
        calls: recorder.calls,
      }),
    )
  }
  recorder = createRecorder()
  linkedContexts = []
  return count
}

export const recordedCount = () => recorder.calls.length
