import type { CollationOptions, TransactionOptions } from 'mongodb'
import type { MongoMemoryReplSet } from 'mongodb-memory-server'
import type {
  ClientSession,
  Connection,
  ConnectOptions,
  QueryOptions,
  SchemaOptions,
} from 'mongoose'
import type {
  BaseDatabaseAdapter,
  CollectionSlug,
  DatabaseAdapterObj,
  JsonObject,
  Payload,
  TypeWithVersion,
  UpdateGlobalArgs,
  UpdateGlobalVersionArgs,
  UpdateOneArgs,
  UpdateVersionArgs,
} from 'payload'

import mongoose from 'mongoose'
import { createDatabaseAdapter, defaultBeginTransaction, findMigrationDir } from 'payload'

import type {
  CollectionModel,
  GlobalModel,
  MigrateDownArgs,
  MigrateUpArgs,
  MongooseMigration,
} from './types.js'

import { connect } from './connect.js'
import { count } from './count.js'
import { countGlobalVersions } from './countGlobalVersions.js'
import { countVersions } from './countVersions.js'
import { create } from './create.js'
import { createGlobal } from './createGlobal.js'
import { createGlobalVersion } from './createGlobalVersion.js'
import { createMigration } from './createMigration.js'
import { createVersion } from './createVersion.js'
import { deleteMany } from './deleteMany.js'
import { deleteOne } from './deleteOne.js'
import { deleteVersions } from './deleteVersions.js'
import { destroy } from './destroy.js'
import { find } from './find.js'
import { findDistinct } from './findDistinct.js'
import { findGlobal } from './findGlobal.js'
import { findGlobalVersions } from './findGlobalVersions.js'
import { findOne } from './findOne.js'
import { findVersions } from './findVersions.js'
import { init } from './init.js'
import { migrateFresh } from './migrateFresh.js'
import { queryDrafts } from './queryDrafts.js'
import { beginTransaction } from './transactions/beginTransaction.js'
import { commitTransaction } from './transactions/commitTransaction.js'
import { rollbackTransaction } from './transactions/rollbackTransaction.js'
import { updateGlobal } from './updateGlobal.js'
import { updateGlobalVersion } from './updateGlobalVersion.js'
import { updateJobs } from './updateJobs.js'
import { updateMany } from './updateMany.js'
import { updateOne } from './updateOne.js'
import { updateVersion } from './updateVersion.js'
import { upsert } from './upsert.js'

export type { MigrateDownArgs, MigrateUpArgs } from './types.js'

export interface Args {
  afterCreateConnection?: (adapter: MongooseAdapter) => Promise<void> | void
  afterOpenConnection?: (adapter: MongooseAdapter) => Promise<void> | void
  /**
   * By default, Payload strips all additional keys from MongoDB data that don't exist
   * in the Payload schema. If you have some data that you want to include to the result
   * but it doesn't exist in Payload, you can enable this flag
   * @default false
   */
  allowAdditionalKeys?: boolean
  /**
   * Enable this flag if you want to thread your own ID to create operation data, for example:
   * ```ts
   * import { Types } from 'mongoose'
   *
   * const id = new Types.ObjectId().toHexString()
   * const doc = await payload.create({ collection: 'posts', data: {id, title: "my title"}})
   * assertEq(doc.id, id)
   * ```
   */
  allowIDOnCreate?: boolean
  /** Set to false to disable auto-pluralization of collection names, Defaults to true */
  autoPluralization?: boolean
  /**
   * When true, bulk operations will process documents one at a time
   * in separate transactions instead of all at once in a single transaction.
   * Useful for avoiding transaction limitations with large datasets in DocumentDB and Cosmos DB.
   *
   * @default false
   */
  bulkOperationsSingleTransaction?: boolean

  /**
   * If enabled, collation allows for language-specific rules for string comparison.
   * This configuration can include the following options:
   *
   * - `strength` (number): Comparison level (1: Primary, 2: Secondary, 3: Tertiary (default), 4: Quaternary, 5: Identical)
   * - `caseLevel` (boolean): Include case comparison at strength level 1 or 2.
   * - `caseFirst` (string): Sort order of case differences during tertiary level comparisons ("upper", "lower", "off").
   * - `numericOrdering` (boolean): Compare numeric strings as numbers.
   * - `alternate` (string): Consider whitespace and punctuation as base characters ("non-ignorable", "shifted").
   * - `maxVariable` (string): Characters considered ignorable when `alternate` is "shifted" ("punct", "space").
   * - `backwards` (boolean): Sort strings with diacritics from back of the string.
   * - `normalization` (boolean): Check if text requires normalization and perform normalization.
   *
   * Available on MongoDB version 3.4 and up.
   * The locale that gets passed is your current project's locale but defaults to "en".
   *
   * Example:
   * {
   *   strength: 3
   * }
   *
   * Defaults to disabled.
   */
  collation?: Omit<CollationOptions, 'locale'>

  collectionsSchemaOptions?: Partial<Record<CollectionSlug, SchemaOptions>>
  /** Extra configuration options */
  connectOptions?: ConnectOptions
  /**
   * We add a secondary sort based on `createdAt` to ensure that results are always returned in the same order when sorting by a non-unique field.
   * This is because MongoDB does not guarantee the order of results, however in very large datasets this could affect performance.
   *
   * Set to `true` to disable this behaviour.
   */
  disableFallbackSort?: boolean
  /** Set to true to disable hinting to MongoDB to use 'id' as index. This is currently done when counting documents for pagination. Disabling this optimization might fix some problems with AWS DocumentDB. Defaults to false */
  disableIndexHints?: boolean
  /**
   * Set to `true` to ensure that indexes are ready before completing connection.
   * NOTE: not recommended for production. This can slow down the initialization of Payload.
   */
  ensureIndexes?: boolean
  migrationDir?: string
  /**
   * typed as any to avoid dependency
   */
  mongoMemoryServer?: MongoMemoryReplSet
  prodMigrations?: MongooseMigration[]

  transactionOptions?: false | TransactionOptions

  /** The URL to connect to MongoDB or false to start payload and prevent connecting */
  url: false | string

  /**
   * Set to `true` to use an alternative `dropDatabase` implementation that calls `collection.deleteMany({})` on every collection instead of sending a raw `dropDatabase` command.
   * Payload only uses `dropDatabase` for testing purposes.
   * @default false
   */
  useAlternativeDropDatabase?: boolean

  /**
   * Set to `true` to use `BigInt` for custom ID fields of type `'number'`.
   * Useful for databases that don't support `double` or `int32` IDs.
   * @default false
   */
  useBigIntForNumberIDs?: boolean
  /**
   * Set to `false` to disable join aggregations (which use correlated subqueries) and instead populate join fields via multiple `find` queries.
   * @default true
   */
  useJoinAggregations?: boolean
  /**
   * Set to `false` to disable the use of `pipeline` in the `$lookup` aggregation in sorting.
   * @default true
   */
  usePipelineInSortLookup?: boolean
}

export type MongooseAdapter = {
  afterCreateConnection?: (adapter: MongooseAdapter) => Promise<void> | void
  afterOpenConnection?: (adapter: MongooseAdapter) => Promise<void> | void
  bulkOperationsSingleTransaction: boolean
  collections: {
    [slug: string]: CollectionModel
  }
  connection: Connection
  ensureIndexes: boolean
  globals: GlobalModel
  mongoMemoryServer: MongoMemoryReplSet
  prodMigrations?: {
    down: (args: MigrateDownArgs) => Promise<void>
    name: string
    up: (args: MigrateUpArgs) => Promise<void>
  }[]
  sessions: Record<number | string, ClientSession>
  useAlternativeDropDatabase: boolean
  useBigIntForNumberIDs: boolean
  useJoinAggregations: boolean
  usePipelineInSortLookup: boolean
  versions: {
    [slug: string]: CollectionModel
  }
} & Args &
  BaseDatabaseAdapter

declare module 'payload' {
  export interface DatabaseAdapter
    extends Omit<BaseDatabaseAdapter, 'sessions'>, Omit<Args, 'migrationDir'> {
    collections: {
      [slug: string]: CollectionModel
    }
    connection: Connection
    ensureIndexes: boolean
    globals: GlobalModel
    mongoMemoryServer: MongoMemoryReplSet
    prodMigrations?: {
      down: (args: MigrateDownArgs) => Promise<void>
      name: string
      up: (args: MigrateUpArgs) => Promise<void>
    }[]
    sessions: Record<number | string, ClientSession>
    transactionOptions: TransactionOptions
    updateGlobal: <T extends Record<string, unknown>>(
      args: { options?: QueryOptions } & UpdateGlobalArgs<T>,
    ) => Promise<T>
    updateGlobalVersion: <T extends JsonObject = JsonObject>(
      args: { options?: QueryOptions } & UpdateGlobalVersionArgs<T>,
    ) => Promise<TypeWithVersion<T>>

    updateOne: (args: { options?: QueryOptions } & UpdateOneArgs) => Promise<Document>
    updateVersion: <T extends JsonObject = JsonObject>(
      args: { options?: QueryOptions } & UpdateVersionArgs<T>,
    ) => Promise<TypeWithVersion<T>>
    useAlternativeDropDatabase: boolean
    useBigIntForNumberIDs: boolean
    useJoinAggregations: boolean
    usePipelineInSortLookup: boolean
    versions: {
      [slug: string]: CollectionModel
    }
  }
}

export function mongooseAdapter({
  afterCreateConnection,
  afterOpenConnection,
  allowAdditionalKeys = false,
  allowIDOnCreate = false,
  autoPluralization = true,
  bulkOperationsSingleTransaction = false,
  collation,
  collectionsSchemaOptions = {},
  connectOptions,
  disableFallbackSort = false,
  disableIndexHints = false,
  ensureIndexes = false,
  migrationDir: migrationDirArg,
  mongoMemoryServer,
  prodMigrations,
  transactionOptions = {},
  url,
  useAlternativeDropDatabase = false,
  useBigIntForNumberIDs = false,
  useJoinAggregations = true,
  usePipelineInSortLookup = true,
}: Args): DatabaseAdapterObj {
  function adapter({ payload }: { payload: Payload }) {
    const migrationDir = findMigrationDir(migrationDirArg)
    mongoose.set('strictQuery', false)

    return createDatabaseAdapter<MongooseAdapter>({
      name: 'mongoose',

      // Mongoose-specific
      afterCreateConnection,
      afterOpenConnection,
      autoPluralization,
      bulkOperationsSingleTransaction,
      collation,
      collections: {},
      // @ts-expect-error initialize without a connection
      connection: undefined,
      connectOptions: connectOptions || {},
      disableIndexHints,
      ensureIndexes,
      // @ts-expect-error don't have globals model yet
      globals: undefined,
      // @ts-expect-error Should not be required
      mongoMemoryServer,
      sessions: {},
      transactionOptions: transactionOptions === false ? undefined : transactionOptions,
      updateJobs,
      updateMany,
      url,
      versions: {},
      // DatabaseAdapter
      allowAdditionalKeys,
      allowIDOnCreate,
      beginTransaction: transactionOptions === false ? defaultBeginTransaction() : beginTransaction,
      collectionsSchemaOptions,
      commitTransaction,
      connect,
      count,
      countGlobalVersions,
      countVersions,
      create,
      createGlobal,
      createGlobalVersion,
      createMigration,
      createVersion,
      defaultIDType: 'text',
      deleteMany,
      deleteOne,
      deleteVersions,
      destroy,
      disableFallbackSort,
      find,
      findDistinct,
      findGlobal,
      findGlobalVersions,
      findOne,
      findVersions,
      init,
      migrateFresh,
      migrationDir,
      packageName: '@payloadcms/db-mongodb',
      payload,
      prodMigrations,
      queryDrafts,
      rollbackTransaction,
      updateGlobal,
      updateGlobalVersion,
      updateOne,
      updateVersion,
      upsert,
      useAlternativeDropDatabase,
      useBigIntForNumberIDs,
      useJoinAggregations,
      usePipelineInSortLookup,
    })
  }

  const adapterObj: DatabaseAdapterObj = {
    name: 'mongoose',
    allowIDOnCreate,
    defaultIDType: 'text',
    init: adapter,
  }

  return process.env.PAYLOAD_ENGINE === 'rs' ? withRustMongoEngineOnInit(adapterObj) : adapterObj
}

export { compatibilityOptions } from './utilities/compatibilityOptions.js'

type RustMongoEngine = {
  withRustMongoEngine: (adapterObj: DatabaseAdapterObj) => DatabaseAdapterObj
}

/**
 * `PAYLOAD_ENGINE=rs`: `withRustMongoEngine` of `@payloadcms/engine-rs/mongodb`
 * (MONGO_ENGINE_CONTRACT.md), loading from when this module is evaluated. That package is an
 * optional peer dependency, imported only here, at runtime, from where db-mongodb is installed
 * (`importRustEngine`); with the flag unset it is never part of the module graph.
 */
let rustEngine: RustMongoEngine | undefined
let rustEngineLoad: Promise<RustMongoEngine> | undefined
const loadRustEngine = (): Promise<RustMongoEngine> =>
  (rustEngineLoad ??= importRustEngine('@payloadcms/engine-rs/mongodb').then(
    (loaded) => (rustEngine = loaded as RustMongoEngine),
  ))
if (process.env.PAYLOAD_ENGINE === 'rs') {
  void loadRustEngine().catch(() => {})
}

/**
 * The adapter object with the Rust engine. `config.db.init` is synchronous and the engine module
 * asynchronous: once it has loaded, `init` is exactly `withRustMongoEngine(adapterObj).init`.
 * Before that, the built adapter's `init` installs the engine when payload awaits it (before
 * `connect` and any data method) and then forwards to the engine's `init`, for this and every later
 * call. A consumer that wrapped the adapter's `init` in the meantime keeps its wrapper (it reaches
 * the engine through the function it wrapped); otherwise the engine's `init` is installed as is.
 */
function withRustMongoEngineOnInit(adapterObj: DatabaseAdapterObj): DatabaseAdapterObj {
  return {
    ...adapterObj,
    init: (args) => {
      if (rustEngine) {
        return rustEngine.withRustMongoEngine(adapterObj).init(args)
      }
      const adapter = adapterObj.init(args)
      const upstreamInit = adapter.init
      let rustInit: typeof upstreamInit
      const installingInit: typeof upstreamInit = function (this: BaseDatabaseAdapter) {
        if (rustInit) {
          return rustInit.call(this)
        }
        return loadRustEngine().then((loaded) => {
          if (!rustInit) {
            const currentInit = adapter.init
            adapter.init = upstreamInit
            loaded.withRustMongoEngine({ ...adapterObj, init: () => adapter }).init(args)
            rustInit = adapter.init
            adapter.init = currentInit === installingInit ? rustInit : currentInit
          }
          return rustInit?.call(this)
        })
      }
      adapter.init = installingInit
      return adapter
    },
  }
}

/**
 * Imports `specifier` (an `@payloadcms/engine-rs` subpath, an optional peer dependency) the way
 * this package resolves it where it is installed. When db-mongodb is bundled (e.g. Next.js), the
 * runtime `import()` would resolve from the emitted chunk instead, where engine-rs is usually not
 * installed, and `import.meta.url` may be the chunk's or a build-time path: it is used only when
 * the nearest package.json above it is this package's; otherwise db-mongodb is looked up in the
 * `node_modules` directories from the working directory up. The specifier is computed, so bundlers
 * neither trace nor bundle engine-rs.
 */
function importRustEngine(specifier: string): Promise<unknown> {
  const fs = process.getBuiltinModule('node:fs')
  const path = process.getBuiltinModule('node:path')
  const { createRequire } = process.getBuiltinModule('node:module')
  const { fileURLToPath, pathToFileURL } = process.getBuiltinModule('node:url')
  const packageName = '@payloadcms/db-mongodb'
  const readName = (manifest: string): string | undefined => {
    try {
      return (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: string }).name
    } catch {
      return undefined
    }
  }
  let manifest: string | undefined
  if (import.meta.url.startsWith('file:')) {
    for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, 'package.json')
      if (fs.existsSync(candidate)) {
        manifest = readName(candidate) === packageName ? candidate : undefined
        break
      }
      if (dir === path.dirname(dir)) {
        break
      }
    }
  }
  for (let dir = process.cwd(); !manifest; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', packageName, 'package.json')
    if (fs.existsSync(candidate)) {
      manifest = fs.realpathSync(candidate)
    } else if (dir === path.dirname(dir)) {
      break
    }
  }
  let resolved = specifier
  if (manifest) {
    try {
      resolved = pathToFileURL(createRequire(manifest).resolve(specifier)).href
    } catch {
      // not installed next to db-mongodb: Node's own resolution reports it
    }
  }
  return import(/* @vite-ignore */ /* webpackIgnore: true */ resolved)
}
