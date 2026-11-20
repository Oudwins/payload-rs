import type { DrizzleAdapter, Operators } from '@payloadcms/drizzle'
import type { DatabaseAdapterObj, Payload } from 'payload'

import {
  beginTransaction,
  buildCreateMigration,
  commitTransaction,
  count,
  countGlobalVersions,
  countVersions,
  create,
  createBlocksToJsonMigrator,
  createGlobal,
  createGlobalVersion,
  createSchemaGenerator,
  createVersion,
  deleteMany,
  deleteOne,
  deleteVersions,
  destroy,
  find,
  findDistinct,
  findGlobal,
  findGlobalVersions,
  findOne,
  findVersions,
  migrate,
  migrateDown,
  migrateFresh,
  migrateRefresh,
  migrateReset,
  migrateStatus,
  operatorMap,
  queryDrafts,
  rollbackTransaction,
  updateGlobal,
  updateGlobalVersion,
  updateJobs,
  updateMany,
  updateOne,
  updateVersion,
  upsert,
} from '@payloadcms/drizzle'
import {
  columnToCodeConverter,
  convertPathToJSONTraversal,
  countDistinct,
  createJSONQuery,
  createRequireDrizzleKit,
  defaultDrizzleSnapshot,
  deleteWhere,
  dropDatabase,
  execute,
  init,
  insert,
} from '@payloadcms/drizzle/sqlite'
import { DrizzleQueryError, like, notLike } from 'drizzle-orm'
import { createDatabaseAdapter, defaultBeginTransaction, findMigrationDir } from 'payload'
import { fileURLToPath } from 'url'

import type { RustEngineAdapterModule, RustEngineSqliteModule } from './connect.js'
import type { Args, SQLiteAdapter, WalConfig } from './types.js'

import {
  connect,
  createRustEngineClient,
  importRustEngine,
  setRustEngineClient,
} from './connect.js'

const filename = fileURLToPath(import.meta.url)

const requireDrizzleKit = createRequireDrizzleKit({
  from: import.meta.url,
})

export function sqliteAdapter(args: Args): DatabaseAdapterObj<SQLiteAdapter> {
  const sqliteIDType = args.idType || 'number'
  const payloadIDType = sqliteIDType === 'uuid' || sqliteIDType === 'uuidv7' ? 'text' : 'number'
  const allowIDOnCreate = args.allowIDOnCreate ?? false

  function adapter({ payload }: { payload: Payload }) {
    const migrationDir = findMigrationDir(args.migrationDir)
    let resolveInitializing: () => void = () => {}
    let rejectInitializing: () => void = () => {}

    const initializing = new Promise<void>((res, rej) => {
      resolveInitializing = res
      rejectInitializing = rej
    })

    // sqlite's like operator is case-insensitive, so we overwrite the DrizzleAdapter operators to not use ilike
    const operators = {
      ...operatorMap,
      contains: like,
      like,
      not_like: notLike,
    } as unknown as Operators

    let wal: false | WalConfig = false

    const defaultJournalSizeLimit = 67108864 // 64MB

    if (args.wal && !args.client.url.startsWith('file:')) {
      payload.logger.warn(
        '[db-sqlite] WAL mode is not supported for in-memory or TCP database connections. Disabling WAL.',
      )
      args.wal = false
    }

    if (!args.wal) {
      wal = false
    } else if (args.wal === true) {
      wal = { journalSizeLimit: defaultJournalSizeLimit, synchronous: 'FULL' }
    } else {
      wal = {
        journalSizeLimit: args.wal.journalSizeLimit ?? defaultJournalSizeLimit,
        synchronous: args.wal.synchronous ?? 'FULL',
      }
    }

    const executeMethod = 'run'
    const sanitizeStatements = ({
      sqlExecute,
      statements,
    }: {
      sqlExecute: string
      statements: string[]
    }) => {
      return statements
        .map((statement) => `${sqlExecute}${statement?.replaceAll('`', '\\`')}\`)`)
        .join('\n')
    }

    const adapter = createDatabaseAdapter<SQLiteAdapter>({
      name: 'sqlite',
      afterSchemaInit: args.afterSchemaInit ?? [],
      allowIDOnCreate,
      autoIncrement: args.autoIncrement ?? false,
      beforeSchemaInit: args.beforeSchemaInit ?? [],
      blocksAsJSON: args.blocksAsJSON ?? false,
      busyTimeout: args.busyTimeout ?? 0,
      // @ts-expect-error - vestiges of when tsconfig was not strict. Feel free to improve
      client: undefined,
      clientConfig: args.client,
      defaultDrizzleSnapshot,
      // @ts-expect-error - vestiges of when tsconfig was not strict. Feel free to improve
      drizzle: undefined,
      features: {
        json: true,
      },
      fieldConstraints: {},
      findDistinct,
      generateSchema: createSchemaGenerator({
        columnToCodeConverter,
        corePackageSuffix: 'sqlite-core',
        defaultOutputFile: args.generateSchemaOutputFile,
        tableImport: 'sqliteTable',
      }),
      idType: sqliteIDType,
      initializing,
      localesSuffix: args.localesSuffix || '_locales',
      logger: args.logger,
      operatorHandlers: [],
      operators,
      prodMigrations: args.prodMigrations,
      wal,
      // @ts-expect-error - vestiges of when tsconfig was not strict. Feel free to improve
      push: args.push,
      rawRelations: {},
      rawTables: {},
      relations: {},
      relationshipsSuffix: args.relationshipsSuffix || '_rels',
      schema: {},
      schemaName: args.schemaName,
      sessions: {},
      tableNameMap: new Map<string, string>(),
      tables: {},
      // @ts-expect-error - vestiges of when tsconfig was not strict. Feel free to improve
      transactionOptions: args.transactionOptions || undefined,
      updateJobs,
      updateMany,
      versionsSuffix: args.versionsSuffix || '_v',
      // DatabaseAdapter
      beginTransaction: args.transactionOptions ? beginTransaction : defaultBeginTransaction(),
      commitTransaction,
      connect,
      convertPathToJSONTraversal,
      count,
      countDistinct,
      countGlobalVersions,
      countVersions,
      create,
      createGlobal,
      createGlobalVersion,
      createJSONQuery,
      createMigration: buildCreateMigration({
        executeMethod,
        filename,
        sanitizeStatements,
      }),
      createVersion,
      defaultIDType: payloadIDType,
      deleteMany,
      deleteOne,
      deleteVersions,
      deleteWhere,
      destroy,
      dropDatabase,
      execute,
      find,
      findGlobal,
      findGlobalVersions,
      findOne,
      findVersions,
      foreignKeys: new Set(),
      indexes: new Set<string>(),
      init,
      insert,
      migrate,
      migrateDown,
      migrateFresh,
      migrateRefresh,
      migrateReset,
      migrateStatus,
      migrationDir,
      packageName: '@payloadcms/db-sqlite',
      payload,
      queryDrafts,
      rejectInitializing,
      requireDrizzleKit,
      resolveInitializing,
      rollbackTransaction,
      updateGlobal,
      updateGlobalVersion,
      updateOne,
      updateVersion,
      upsert,
    })

    adapter.blocksToJsonMigrator = createBlocksToJsonMigrator({
      adapter: adapter as unknown as DrizzleAdapter,
      executeMethod,
      sanitizeStatements,
    })

    return adapter
  }

  const adapterObj: DatabaseAdapterObj<SQLiteAdapter> = {
    name: 'sqlite',
    allowIDOnCreate,
    defaultIDType: payloadIDType,
    init: adapter,
  }

  return process.env.PAYLOAD_ENGINE === 'rs' ? withRustEngineOnInit(adapterObj) : adapterObj
}

export type {
  Args as SQLiteAdapterArgs,
  CountDistinct,
  DeleteWhere,
  DropDatabase,
  Execute,
  GeneratedDatabaseSchema,
  GenericColumns,
  GenericRelation,
  GenericTable,
  IDType,
  Insert,
  MigrateDownArgs,
  MigrateUpArgs,
  SQLiteAdapter,
  SQLiteSchemaHook,
} from './types.js'

export { sql } from 'drizzle-orm'

type RustEngine = {
  withRustEngine: (
    adapterObj: DatabaseAdapterObj<SQLiteAdapter>,
    options: { DrizzleQueryError: typeof DrizzleQueryError },
  ) => DatabaseAdapterObj<SQLiteAdapter>
}

/**
 * `PAYLOAD_ENGINE=rs`: `withRustEngine` of `@payloadcms/engine-rs` (ENGINE_CONTRACT.md), loading
 * from when this module is evaluated, and the Rust libsql client registered for `connect`. That package
 * is an optional peer dependency, imported only here (and by `connect` for a harness-wrapped
 * adapter), at runtime, from where db-sqlite is installed (`importRustEngine`); with the flag unset
 * it is never part of the module graph. Its `/adapter` and `/sqlite` entries do not load the
 * MongoDB engine, so an install without db-mongodb works.
 */
let rustEngine: RustEngine | undefined
let rustEngineLoad: Promise<RustEngine> | undefined
const loadRustEngine = (): Promise<RustEngine> =>
  (rustEngineLoad ??= Promise.all([
    importRustEngine('@payloadcms/engine-rs/adapter'),
    importRustEngine('@payloadcms/engine-rs/sqlite'),
  ]).then(([engineAdapter, engineSqlite]) => {
    setRustEngineClient(
      createRustEngineClient({
        engineAdapter: engineAdapter as RustEngineAdapterModule,
        engineSqlite: engineSqlite as RustEngineSqliteModule,
      }),
    )
    return (rustEngine = engineAdapter as RustEngine)
  }))
if (process.env.PAYLOAD_ENGINE === 'rs') {
  void loadRustEngine().catch(() => {})
}

/**
 * The adapter object with the Rust engine. `config.db.init` is synchronous and the engine module
 * asynchronous: once it has loaded, `init` is exactly `withRustEngine(adapterObj).init`. Before
 * that, the built adapter's `init` installs the engine when payload awaits it (before `connect` and
 * any data method) and then forwards to the engine's `init`, for this and every later call. A
 * consumer that wrapped the adapter's `init` in the meantime keeps its wrapper (it reaches the
 * engine through the function it wrapped); otherwise the engine's `init` is installed as is.
 */
function withRustEngineOnInit(
  adapterObj: DatabaseAdapterObj<SQLiteAdapter>,
): DatabaseAdapterObj<SQLiteAdapter> {
  // DrizzleQueryError: the class of the drizzle-orm copy `connect`'s drizzle session throws
  return {
    ...adapterObj,
    init: (args) => {
      if (rustEngine) {
        return rustEngine.withRustEngine(adapterObj, { DrizzleQueryError }).init(args)
      }
      const adapter = adapterObj.init(args)
      const upstreamInit = adapter.init
      let rustInit: typeof upstreamInit
      const installingInit: typeof upstreamInit = function (this: SQLiteAdapter) {
        if (rustInit) {
          return rustInit.call(this)
        }
        return loadRustEngine().then((loaded) => {
          if (!rustInit) {
            const currentInit = adapter.init
            adapter.init = upstreamInit
            loaded
              .withRustEngine({ ...adapterObj, init: () => adapter }, { DrizzleQueryError })
              .init(args)
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
