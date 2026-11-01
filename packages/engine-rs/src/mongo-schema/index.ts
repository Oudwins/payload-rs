/**
 * `@payloadcms/db-mongodb`'s `init` (model building) on the Rust engine.
 *
 * `crates/payload-mongo-schema` ports `models/*` and the model building of `init.ts`: from the
 * sanitized config it describes every mongoose call upstream makes (`new Schema`, `schema.add`,
 * `schema.index`, block discriminators, plugins, `connection.model`, global discriminators), in
 * upstream's order. This module replays that description on the adapter's real mongoose, so
 * `payload.db.collections` / `versions` / `globals` are the mongoose models upstream builds.
 *
 * engine-rs does not depend on mongoose: the caller passes the `mongoose` module, the
 * `mongoose-paginate-v2` plugin and db-mongodb's `getBuildQueryPlugin` (`MongoSchemaDeps`), the
 * same values upstream `init` imports.
 */
import type { EntryReader, FunctionRegistry } from '../serialize.js'

// oxlint-disable-next-line payload/no-relative-monorepo-imports -- no 'payload' dependency is installed here
import { buildVersionCollectionFields } from '../../../payload/src/versions/buildCollectionFields.js'
// oxlint-disable-next-line payload/no-relative-monorepo-imports -- no 'payload' dependency is installed here
import { buildVersionGlobalFields } from '../../../payload/src/versions/buildGlobalFields.js'
import { getNativeEngine } from '../native.js'
import { createEngineError } from '../schema.js'
import {
  createEntryReader,
  createFunctionRegistry,
  deserializeFromEngine,
  serializeForEngine,
} from '../serialize.js'

type AnyObject = Record<PropertyKey, any>

/** What upstream `init` imports, passed in by the caller (engine-rs has no mongoose). */
export type MongoSchemaDeps = {
  /** db-mongodb's `getBuildQueryPlugin` */
  getBuildQueryPlugin: (args?: AnyObject) => (schema: any) => void
  /** The `mongoose` module db-mongodb imports (`Schema`, `Schema.Types`, `Mongoose`, `createConnection`). */
  mongoose: AnyObject
  /** `mongoose-paginate-v2` */
  paginate: (schema: any, options?: any) => void
}

/** The subset of the `MongooseAdapter` `init` reads and writes. */
export type MongoSchemaAdapter = {
  afterCreateConnection?: (adapter: any) => Promise<void> | void
  autoPluralization?: boolean
  collections: AnyObject
  collectionsSchemaOptions?: AnyObject
  connection: AnyObject
  globals: unknown
  payload: AnyObject
  versions: AnyObject
}

/** `buildMongoSchemaDescription` of the addon (crates/payload-node/src/mongo_schema.rs). */
type NativeMongoSchema = {
  buildMongoSchemaDescription: (
    graphJSON: string,
    optionsJSON: string,
    callFunction: (id: number, argJSON: string) => string,
  ) => string
}

type Node =
  | { entries: [string, Node][]; id?: number; k: 'obj' }
  | { id: number; k: 'schema' }
  | { id: number; k: 'seen' }
  | { id?: number; items: Node[]; k: 'arr' }
  | { k: 'global'; name: 'Boolean' | 'Date' | 'Number' | 'String' }
  | { k: 'input'; path: string[] }
  | { k: 'type'; name: string }
  | { k: 'value'; value: unknown }

type BuildQueryArgsNode = {
  collectionSlug?: Node
  versionsFields?: { collection: number } | { global: number }
}

export type MongoSchemaOp =
  | { args: BuildQueryArgsNode | null; op: 'plugin'; plugin: 'buildQuery'; schema: number }
  | {
      assign?: { collections: Node } | { versions: Node }
      collection: Node
      id: number
      name: Node
      op: 'model'
      schema: number
    }
  | { definition: Node; id: number; op: 'schema'; options: Node }
  | { definition: Node; op: 'add'; schema: number }
  | { discriminator: number; name: Node; op: 'discriminator'; path: string; schema: number }
  | { error: { data?: unknown; message: string; name: string }; op: 'throw' }
  | { fields: Node; op: 'index'; options: Node; schema: number }
  | { model: null | number; op: 'globals' }
  | { model: number; name: Node; op: 'modelDiscriminator'; schema: number }
  | { op: 'plugin'; options: Node; plugin: 'paginate'; schema: number }

/** A description with what its value nodes resolve against. */
export type MongoSchemaDescription = {
  entriesOf: EntryReader
  /** Set when a JS function the engine called (a `dbName` function) threw. */
  hostError?: { error: unknown }
  ops: MongoSchemaOp[]
  registry: FunctionRegistry
  root: AnyObject
}

const globalConstructors = { Boolean, Date, Number, String }

const defaultPluginFunctions = new WeakMap<object, Set<unknown>>()

/** `createMongoSchemaBuildContext`'s `isCacheEnabled` (db-mongodb `models/schemaBuildContext.ts`). */
export const isMongoSchemaCacheEnabled = ({
  connection,
  mongoose,
}: {
  connection: AnyObject
  mongoose: AnyObject
}): boolean => {
  let defaults = defaultPluginFunctions.get(mongoose)
  if (!defaults) {
    const fresh = new mongoose.Mongoose({ createInitialConnection: false })
    defaults = new Set((fresh.plugins as [unknown, unknown][]).map(([plugin]) => plugin))
    defaultPluginFunctions.set(mongoose, defaults)
  }
  const hasCustomGlobalPlugins = (connection.base.plugins as [unknown, unknown][]).some(
    ([plugin]) => !defaults.has(plugin),
  )
  return connection.plugins.length === 0 && !hasCustomGlobalPlugins
}

/**
 * Runs the Rust port of the model building of upstream `init` (everything after
 * `afterCreateConnection`) and returns its description, without touching mongoose.
 */
export const describeMongoModelsRS = ({
  adapter,
  isCacheEnabled,
}: {
  adapter: MongoSchemaAdapter
  isCacheEnabled: boolean
}): MongoSchemaDescription => {
  const { payload } = adapter
  const collections: AnyObject = {}
  for (const slug of Object.keys(payload.collections)) {
    collections[slug] = { customIDType: payload.collections[slug].customIDType }
  }
  const root = {
    blocks: payload.blocks,
    collections,
    collectionsSchemaOptions: adapter.collectionsSchemaOptions,
    config: payload.config,
  }
  const registry = createFunctionRegistry()
  const entriesOf = createEntryReader()
  const graph = serializeForEngine(root, registry, entriesOf)
  const options = {
    autoPluralization: adapter.autoPluralization === true,
    isCacheEnabled,
    useBigIntForNumberIDs: Boolean(payload.db?.useBigIntForNumberIDs),
  }

  const description: MongoSchemaDescription = { entriesOf, ops: [], registry, root }
  const callFunction = (id: number, argJSON: string): string => {
    try {
      const fn = registry.functions[id]!
      return serializeForEngine(fn(deserializeFromEngine(JSON.parse(argJSON), registry)), registry)
    } catch (error) {
      description.hostError = { error }
      return '{"$hostError":true}'
    }
  }

  const native = getNativeEngine() as unknown as NativeMongoSchema
  let resultJSON: string
  try {
    resultJSON = native.buildMongoSchemaDescription(graph, JSON.stringify(options), callFunction)
  } catch (error) {
    let parsed: { data?: unknown; message: string; name: string } | undefined
    try {
      parsed = JSON.parse((error as Error).message)
    } catch {
      throw error
    }
    throw createEngineError(parsed!)
  }
  description.ops = (JSON.parse(resultJSON) as { ops: MongoSchemaOp[] }).ops
  return description
}

/** Resolves an `input` path through the properties `serializeForEngine` serialized. */
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
 * Replays a description on the adapter: the same mongoose calls upstream `init` makes, in order,
 * storing the models on `adapter.collections` / `adapter.versions` / `adapter.globals`. A mongoose
 * error (or the error upstream throws at a `throw` op) propagates after the preceding calls ran,
 * as upstream.
 */
export const applyMongoModelsDescription = ({
  adapter,
  deps,
  description,
}: {
  adapter: MongoSchemaAdapter
  deps: MongoSchemaDeps
  description: MongoSchemaDescription
}): void => {
  const { entriesOf, registry, root } = description
  const { mongoose } = deps
  const config = adapter.payload.config
  const schemas: AnyObject[] = []
  const models: AnyObject[] = []
  const literals = new Map<number, unknown>()

  const value = (node: Node): any => {
    switch (node.k) {
      case 'arr': {
        const out: unknown[] = []
        if (node.id !== undefined) {
          literals.set(node.id, out)
        }
        for (const item of node.items) {
          out.push(value(item))
        }
        return out
      }
      case 'global':
        return globalConstructors[node.name]
      case 'input':
        return resolvePath(root, node.path, entriesOf)
      case 'obj': {
        const out: AnyObject = {}
        if (node.id !== undefined) {
          literals.set(node.id, out)
        }
        for (const [key, item] of node.entries) {
          // object literal semantics: an own `__proto__` key
          Object.defineProperty(out, key, {
            configurable: true,
            enumerable: true,
            value: value(item),
            writable: true,
          })
        }
        return out
      }
      case 'schema':
        return schemas[node.id]
      case 'seen':
        return literals.get(node.id)
      case 'type':
        return mongoose.Schema.Types[node.name]
      case 'value':
        return deserializeFromEngine(node.value, registry)
    }
  }

  for (const op of description.ops) {
    switch (op.op) {
      case 'add':
        schemas[op.schema]!.add(value(op.definition))
        break
      case 'discriminator':
        schemas[op.schema]!.path(op.path).discriminator(value(op.name), schemas[op.discriminator])
        break
      case 'globals':
        adapter.globals = op.model === null ? null : models[op.model]
        break
      case 'index':
        schemas[op.schema]!.index(value(op.fields), value(op.options))
        break
      case 'model': {
        const model = adapter.connection.model(
          value(op.name),
          schemas[op.schema],
          value(op.collection),
        )
        models[op.id] = model
        if (op.assign && 'collections' in op.assign) {
          adapter.collections[value(op.assign.collections)] = model
        } else if (op.assign) {
          adapter.versions[value(op.assign.versions)] = model
        }
        break
      }
      case 'modelDiscriminator':
        models[op.model]!.discriminator(value(op.name), schemas[op.schema])
        break
      case 'plugin':
        if (op.plugin === 'paginate') {
          schemas[op.schema]!.plugin(deps.paginate, value(op.options))
        } else if (op.args === null) {
          schemas[op.schema]!.plugin(deps.getBuildQueryPlugin())
        } else {
          const args: AnyObject = {}
          if (op.args.collectionSlug) {
            args.collectionSlug = value(op.args.collectionSlug)
          }
          const versionsFields = op.args.versionsFields
          if (versionsFields && 'collection' in versionsFields) {
            args.versionsFields = buildVersionCollectionFields(
              config,
              config.collections[versionsFields.collection],
              true,
            )
          } else if (versionsFields) {
            args.versionsFields = buildVersionGlobalFields(
              config,
              config.globals[versionsFields.global],
              true,
            )
          }
          schemas[op.schema]!.plugin(deps.getBuildQueryPlugin(args))
        }
        break
      case 'schema':
        schemas[op.id] = new mongoose.Schema(value(op.definition), value(op.options))
        break
      case 'throw':
        if (description.hostError) {
          throw description.hostError.error
        }
        throw createEngineError(op.error)
    }
  }
}

/** The model building of upstream `init` after `afterCreateConnection`, on the Rust engine. */
export const buildMongoModelsRS = ({
  adapter,
  deps,
}: {
  adapter: MongoSchemaAdapter
  deps: MongoSchemaDeps
}): void => {
  const description = describeMongoModelsRS({
    adapter,
    isCacheEnabled: isMongoSchemaCacheEnabled({
      connection: adapter.connection,
      mongoose: deps.mongoose,
    }),
  })
  applyMongoModelsDescription({ adapter, deps, description })
}

/**
 * Upstream `init` (`packages/db-mongodb/src/init.ts`) with the model building on the Rust engine:
 * assign it as the adapter's `init`.
 */
export const createMongoInitRS = (deps: MongoSchemaDeps) =>
  async function init(this: MongoSchemaAdapter): Promise<void> {
    // Always create a scoped, **unopened** connection object, like upstream
    this.connection ??= deps.mongoose.createConnection()

    if (this.afterCreateConnection) {
      await this.afterCreateConnection(this)
    }

    buildMongoModelsRS({ adapter: this, deps })
  }
