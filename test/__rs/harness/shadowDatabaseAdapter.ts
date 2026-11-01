/**
 * `PAYLOAD_DATABASE=sqlite-shadow` database adapter for the int test suite.
 *
 * reference: upstream `sqliteAdapter` on SQLITE_URL (same options as the
 *            `sqlite` entry in test/dbAdapters.ts)
 * candidate: selected by PAYLOAD_RS_CANDIDATE
 *   - unset | `ts`  second plain TS `sqliteAdapter` (harness self-check, must
 *                   produce zero divergences)
 *   - `rs`          `sqliteAdapter` exported by packages/engine-rs/src/index.ts
 *                   (Rust engine; same options as @payloadcms/db-sqlite)
 *   - <path>        module exporting `sqliteAdapter` (or default) with the
 *                   @payloadcms/db-sqlite signature
 * candidate db file: PAYLOAD_RS_CANDIDATE_URL, default SQLITE_URL with
 *                    `.candidate` inserted before the extension.
 *
 * Report: PAYLOAD_RS_REPORT_DIR (default `.rs-baseline/divergences`), one
 * `<test file>.jsonl` per test file. PAYLOAD_RS_SHADOW_STRICT=true throws on
 * the first divergence. PAYLOAD_RS_SHADOW_SERIALIZE=true runs each
 * reference+candidate pair exclusively (see createShadowAdapter `serialize`).
 */
import type { DatabaseAdapterObj } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { dequal } from 'dequal'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { ShadowContext } from '../../../packages/engine-rs/src/shadow/index.js'

import { createShadowAdapter } from '../../../packages/engine-rs/src/shadow/index.js'

type SqliteAdapterFactory = typeof sqliteAdapter

export const referenceURL = () =>
  process.env.SQLITE_URL || process.env.DATABASE_URL || 'file:./payload.db'

export const candidateURL = (url = referenceURL()) => {
  if (process.env.PAYLOAD_RS_CANDIDATE_URL) {
    return process.env.PAYLOAD_RS_CANDIDATE_URL
  }
  const ext = path.extname(url)
  return ext ? `${url.slice(0, -ext.length)}.candidate${ext}` : `${url}.candidate`
}

/** Same options as the `sqlite` entry of test/dbAdapters.ts. */
export const sqliteArgs = (url: string) =>
  ({ autoIncrement: true, client: { url } }) satisfies Parameters<SqliteAdapterFactory>[0]

/**
 * The upstream TS `sqliteAdapter`, even when PAYLOAD_ENGINE=rs is set (which
 * makes @payloadcms/db-sqlite return the Rust engine). The reference must
 * always be the TS engine.
 */
const tsSqliteAdapter: SqliteAdapterFactory = (args) => {
  const previous = process.env.PAYLOAD_ENGINE
  delete process.env.PAYLOAD_ENGINE
  try {
    return sqliteAdapter(args)
  } finally {
    if (previous !== undefined) {
      process.env.PAYLOAD_ENGINE = previous
    }
  }
}

const loadCandidateFactory = async (): Promise<SqliteAdapterFactory> => {
  const selected = process.env.PAYLOAD_RS_CANDIDATE || 'ts'
  if (selected === 'ts') {
    return tsSqliteAdapter
  }
  if (selected === 'rs') {
    // ENGINE_CONTRACT.md: the candidate is `withRustEngine(sqliteAdapter(args))`
    const engine: Record<string, unknown> = await import('../../../packages/engine-rs/src/index.js')
    const withRustEngine = engine.withRustEngine
    if (typeof withRustEngine !== 'function') {
      throw new Error('PAYLOAD_RS_CANDIDATE=rs: packages/engine-rs does not export withRustEngine')
    }
    // per-process proof that the Rust engine served the data methods, next to the report
    // (child processes inherit the test process's file name and get their own)
    const statsFile = process.env.PAYLOAD_RS_ENGINE_STATS_FILE
    const isHarnessStatsFile =
      !statsFile || /^rs-engine-stats-\d+\.json$/.test(path.basename(statsFile))
    if (isHarnessStatsFile && process.env.PAYLOAD_RS_REPORT_DIR) {
      fs.mkdirSync(process.env.PAYLOAD_RS_REPORT_DIR, { recursive: true })
      process.env.PAYLOAD_RS_ENGINE_STATS_FILE = path.resolve(
        process.env.PAYLOAD_RS_REPORT_DIR,
        `rs-engine-stats-${process.pid}.json`,
      )
    }
    return (args) =>
      (withRustEngine as (adapterObj: DatabaseAdapterObj) => DatabaseAdapterObj)(
        tsSqliteAdapter(args),
      ) as ReturnType<SqliteAdapterFactory>
  }
  const mod: Record<string, unknown> = await import(
    pathToFileURL(path.isAbsolute(selected) ? selected : path.resolve(selected)).href
  )
  const factory = mod.sqliteAdapter ?? mod.default
  if (typeof factory !== 'function') {
    throw new Error(
      `PAYLOAD_RS_CANDIDATE=${selected}: module does not export a sqliteAdapter(args) factory`,
    )
  }
  return factory as SqliteAdapterFactory
}

/**
 * Always pushes the schema on connect (PAYLOAD_FORCE_DRIZZLE_PUSH only while
 * this adapter connects). For the self-test, where every payload instance gets
 * fresh database files and drizzle's process-wide push cache would otherwise
 * skip creating their tables.
 */
export const forceSchemaPushOnConnect = (adapterObj: DatabaseAdapterObj): DatabaseAdapterObj => ({
  ...adapterObj,
  init: (args) => {
    const adapter = adapterObj.init(args)
    const connect = adapter.connect
    if (typeof connect === 'function') {
      adapter.connect = async function (this: unknown, ...connectArgs) {
        const previous = process.env.PAYLOAD_FORCE_DRIZZLE_PUSH
        process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = 'true'
        try {
          return await connect.apply(adapter, connectArgs)
        } finally {
          if (previous === undefined) {
            delete process.env.PAYLOAD_FORCE_DRIZZLE_PUSH
          } else {
            process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = previous
          }
        }
      }
    }
    return adapter
  },
})

/**
 * The candidate's own copy of drizzle pushDevSchema's process-wide
 * "previously pushed schema" cache. drizzle keeps one module global per
 * process; the reference keeps using it unchanged, and the TS candidate makes
 * the same push/skip decision against this separate copy (pushing through
 * PAYLOAD_FORCE_DRIZZLE_PUSH so it never touches the reference's cache).
 */
const candidatePreviousSchema: { localeCodes: unknown; rawTables: unknown } = {
  localeCodes: null,
  rawTables: null,
}

/**
 * Wraps a TS drizzle candidate so its schema push decisions on connect match
 * what upstream would decide for it alone (see `candidatePreviousSchema`).
 */
export const withOwnSchemaPushCache = (adapterObj: DatabaseAdapterObj): DatabaseAdapterObj => ({
  ...adapterObj,
  init: (args) => {
    const adapter = adapterObj.init(args) as Record<string, any> &
      ReturnType<DatabaseAdapterObj['init']>
    const connect = adapter.connect
    if (typeof connect === 'function') {
      adapter.connect = async function (this: unknown, ...connectArgs) {
        // same condition as db-sqlite connect
        const willPush =
          process.env.NODE_ENV !== 'production' &&
          process.env.PAYLOAD_MIGRATING !== 'true' &&
          adapter.push !== false
        if (!willPush) {
          return connect.apply(adapter, connectArgs)
        }
        const isForced = process.env.PAYLOAD_FORCE_DRIZZLE_PUSH === 'true'
        // same key as drizzle pushDevSchema
        const current = {
          localeCodes:
            adapter.payload.config.localization && adapter.payload.config.localization.localeCodes,
          rawTables: adapter.rawTables,
        }
        const isUnchanged = !isForced && dequal(candidatePreviousSchema, current)
        if (!isForced && !isUnchanged) {
          candidatePreviousSchema.localeCodes = current.localeCodes
          candidatePreviousSchema.rawTables = current.rawTables
        }
        const previousEnv = process.env.PAYLOAD_FORCE_DRIZZLE_PUSH
        const previousPush = adapter.push
        if (isUnchanged) {
          adapter.push = false
        } else {
          process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = 'true'
        }
        try {
          return await connect.apply(adapter, connectArgs)
        } finally {
          adapter.push = previousPush
          if (previousEnv === undefined) {
            delete process.env.PAYLOAD_FORCE_DRIZZLE_PUSH
          } else {
            process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = previousEnv
          }
        }
      }
    }
    return adapter
  },
})

/** Current vitest file/test (if running under vitest). */
export const loadContext = async (): Promise<() => ShadowContext> => {
  if (process.env.PAYLOAD_RS_SHADOW_CHILD === 'true') {
    // child process of a test (see childProcessLoader.mjs): own report file, the command as test name
    const context = {
      testFile: `child-process-${process.pid}`,
      testName: `child process: ${process.argv.slice(2).join(' ')}`,
    }
    return () => context
  }
  if (!process.env.VITEST) {
    return () => ({})
  }
  const { expect } = await import('vitest')
  return () => {
    try {
      const { currentTestName, testPath } = expect.getState()
      return { testFile: testPath, testName: currentTestName }
    } catch {
      return {}
    }
  }
}

type ShadowSqliteOptions = {
  /** Wraps the candidate (used by the harness self-test to inject bugs). */
  wrapCandidate?: (candidate: DatabaseAdapterObj) => DatabaseAdapterObj
} & Partial<Parameters<typeof createShadowAdapter>[0]>

/**
 * Returns a `sqliteAdapter(args)` replacement: reference is the TS adapter
 * with `args`, candidate the PAYLOAD_RS_CANDIDATE adapter with the same args on
 * `candidateURL(args.client.url)`.
 */
export async function loadShadowSqliteAdapterFactory(options: ShadowSqliteOptions = {}) {
  const { wrapCandidate, ...rest } = options
  const candidateFactory = await loadCandidateFactory()
  const context = await loadContext()
  return (args: Parameters<SqliteAdapterFactory>[0]): DatabaseAdapterObj => {
    // ts and rs candidates both push through drizzle's pushDevSchema (process-wide cache)
    const candidate = withOwnSchemaPushCache(
      candidateFactory({ ...args, client: { ...args.client, url: candidateURL(args.client.url) } }),
    )
    return createShadowAdapter({
      candidate: wrapCandidate ? wrapCandidate(candidate) : candidate,
      // shared with test child processes, see databaseAdapter.ts
      crossProcessFile: process.env.PAYLOAD_RS_SHADOW_CROSS_PROCESS_FILE,
      onDivergence: process.env.PAYLOAD_RS_SHADOW_STRICT === 'true' ? 'throw' : 'record',
      reference: tsSqliteAdapter(args),
      serialize: process.env.PAYLOAD_RS_SHADOW_SERIALIZE === 'true',
      report: {
        context,
        dir: process.env.PAYLOAD_RS_REPORT_DIR
          ? path.resolve(process.env.PAYLOAD_RS_REPORT_DIR)
          : path.resolve(process.cwd(), '.rs-baseline', 'divergences'),
      },
      ...rest,
    })
  }
}

export async function createShadowSqliteAdapter(
  options: ShadowSqliteOptions = {},
): Promise<DatabaseAdapterObj> {
  return (await loadShadowSqliteAdapterFactory(options))(sqliteArgs(referenceURL()))
}
