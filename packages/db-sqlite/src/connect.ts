import type { DrizzleAdapter } from '@payloadcms/drizzle'
import type { Connect, Migration } from 'payload'

import { createClient } from '@libsql/client'
import { pushDevSchema } from '@payloadcms/drizzle'
import { init } from '@payloadcms/drizzle/sqlite'
import { drizzle } from 'drizzle-orm/libsql'

import type { SQLiteAdapter } from './types.js'

export const connect: Connect = async function connect(
  this: SQLiteAdapter,
  options = {
    hotReload: false,
  },
) {
  const { hotReload } = options

  try {
    if (!this.client) {
      this.client =
        rustEngineClient?.(this) ??
        (isRustEngineLoaded() && this.init !== init
          ? await importRustEngineClient(this)
          : undefined) ??
        createClient(this.clientConfig)

      if (this.busyTimeout > 0) {
        await this.client.execute(`PRAGMA busy_timeout = ${this.busyTimeout};`)
      }

      if (this.wal) {
        const result = await this.client.execute('PRAGMA journal_mode;')

        if (result.rows[0]?.journal_mode !== 'wal') {
          this.payload.logger.info(
            `[db-sqlite] Enabling WAL mode with journal size limit ${this.wal.journalSizeLimit}.`,
          )
          await this.client.execute(`PRAGMA journal_mode = WAL;`)
          await this.client.execute(`PRAGMA journal_size_limit = ${this.wal.journalSizeLimit};`)
        }

        await this.client.execute(`PRAGMA synchronous = ${this.wal.synchronous};`)
      }
    }

    const logger = this.logger || false
    this.drizzle = drizzle(this.client, { logger, schema: this.schema })

    if (!hotReload) {
      if (process.env.PAYLOAD_DROP_DATABASE === 'true') {
        this.payload.logger.info(`---- DROPPING TABLES ----`)
        await this.dropDatabase({ adapter: this })
        this.payload.logger.info('---- DROPPED TABLES ----')
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    this.payload.logger.error({ err, msg: `Error: cannot connect to SQLite: ${message}` })
    if (typeof this.rejectInitializing === 'function') {
      this.rejectInitializing()
    }
    throw new Error(`Error: cannot connect to SQLite: ${message}`)
  }

  // Only push schema if not in production
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.PAYLOAD_MIGRATING !== 'true' &&
    this.push !== false
  ) {
    await pushDevSchema(this as unknown as DrizzleAdapter)
  }

  if (typeof this.resolveInitializing === 'function') {
    this.resolveInitializing()
  }

  if (process.env.NODE_ENV === 'production' && this.prodMigrations) {
    await this.migrate({ migrations: this.prodMigrations as Migration[] })
  }
}

type RustEngineClient = (adapter: SQLiteAdapter) => SQLiteAdapter['client'] | undefined

/**
 * `PAYLOAD_ENGINE=rs` (index.ts `withRustEngineOnInit`, once engine-rs has loaded): the Rust-backed
 * libsql client of `@payloadcms/engine-rs` for an adapter its `withRustEngine` wrapped, so drizzle
 * and the engine share connections; undefined for any other adapter. Unset with the flag unset, so
 * `connect` runs upstream's `createClient` with nothing read or awaited before it.
 */
let rustEngineClient: RustEngineClient | undefined

export const setRustEngineClient = (client: RustEngineClient): void => {
  rustEngineClient = client
}

/**
 * Whether `@payloadcms/engine-rs` is loaded in this process (its `adapter/index.ts` sets the global): a
 * harness may wrap an adapter with `withRustEngine` itself, without the flag. Never true unless
 * engine-rs was imported by someone.
 */
const isRustEngineLoaded = (): boolean =>
  (globalThis as Record<symbol, unknown>)[Symbol.for('@payloadcms/engine-rs')] !== undefined

/** `rustEngineClient` for an adapter a harness wrapped (engine-rs already loaded, see above). */
async function importRustEngineClient(
  adapter: SQLiteAdapter,
): Promise<SQLiteAdapter['client'] | undefined> {
  const [engineAdapter, engineSqlite] = (await Promise.all([
    importRustEngine('@payloadcms/engine-rs/adapter'),
    importRustEngine('@payloadcms/engine-rs/sqlite'),
  ])) as [RustEngineAdapterModule, RustEngineSqliteModule]
  return createRustEngineClient({ engineAdapter, engineSqlite })(adapter)
}

export type RustEngineAdapterModule = {
  isRustEngineAdapter: (adapter: SQLiteAdapter) => boolean
}
export type RustEngineSqliteModule = {
  createClient: (config: SQLiteAdapter['clientConfig']) => SQLiteAdapter['client']
}

export const createRustEngineClient =
  ({
    engineAdapter,
    engineSqlite,
  }: {
    engineAdapter: RustEngineAdapterModule
    engineSqlite: RustEngineSqliteModule
  }): RustEngineClient =>
  (adapter) =>
    engineAdapter.isRustEngineAdapter(adapter)
      ? engineSqlite.createClient(adapter.clientConfig)
      : undefined

/**
 * Imports `specifier` (an `@payloadcms/engine-rs` subpath, an optional peer dependency) the way
 * this package resolves it where it is installed. When db-sqlite is bundled (e.g. Next.js), the
 * runtime `import()` would resolve from the emitted chunk instead, where engine-rs is usually not
 * installed, and `import.meta.url` may be the chunk's or a build-time path: it is used only when
 * the nearest package.json above it is this package's; otherwise db-sqlite is looked up in the
 * `node_modules` directories from the working directory up. Called only on the Rust engine paths;
 * the specifier is computed, so bundlers neither trace nor bundle engine-rs.
 */
export function importRustEngine(specifier: string): Promise<unknown> {
  const resolved = resolveFromPackage({
    moduleURL: import.meta.url,
    packageName: '@payloadcms/db-sqlite',
    specifier,
  })
  return import(/* @vite-ignore */ /* webpackIgnore: true */ resolved)
}

/**
 * `specifier` resolved from the installed `packageName` (a file URL), or `specifier` itself when
 * that package cannot be located.
 */
function resolveFromPackage({
  moduleURL,
  packageName,
  specifier,
}: {
  moduleURL: string
  packageName: string
  specifier: string
}): string {
  const fs = process.getBuiltinModule('node:fs')
  const path = process.getBuiltinModule('node:path')
  const { createRequire } = process.getBuiltinModule('node:module')
  const { fileURLToPath, pathToFileURL } = process.getBuiltinModule('node:url')
  const readName = (manifest: string): string | undefined => {
    try {
      return (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: string }).name
    } catch {
      return undefined
    }
  }
  let manifest: string | undefined
  if (moduleURL.startsWith('file:')) {
    for (let dir = path.dirname(fileURLToPath(moduleURL)); ; dir = path.dirname(dir)) {
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
  if (!manifest) {
    return specifier
  }
  try {
    return pathToFileURL(createRequire(manifest).resolve(specifier)).href
  } catch {
    return specifier
  }
}
