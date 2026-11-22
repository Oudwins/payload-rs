/**
 * Differential MongoDB adapter for the int suite (PAYLOAD_RS_MONGO_SHADOW=true, see
 * databaseAdapter.ts and packages/engine-rs/src/shadow-mongo).
 *
 * reference: upstream TS `mongooseAdapter` with the `mongodb` entry options of test/dbAdapters.ts
 *            on MONGODB_URL (always TS, even with PAYLOAD_ENGINE=rs)
 * candidate: PAYLOAD_RS_MONGO_CANDIDATE
 *   - unset | `ts`  a second TS `mongooseAdapter` (harness self-check: must give 0 divergences)
 *   - `rs`          `withRustMongoEngine(mongooseAdapter(args))` from packages/engine-rs
 *   - <path>        module exporting `mongooseAdapter` (or default) with the db-mongodb signature
 * candidate database: PAYLOAD_RS_MONGO_CANDIDATE_URL, default the reference URL with `_c`
 *                     appended to the database name.
 *
 * Report: PAYLOAD_RS_REPORT_DIR (default `.rs-baseline/divergences`), one `<test file>.jsonl` per
 * test file. PAYLOAD_RS_SHADOW_STRICT=true throws on the first divergence.
 */
import type { DatabaseAdapterObj } from 'payload'

import { mongooseAdapter } from '@payloadcms/db-mongodb'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { ShadowContext } from '../../../packages/engine-rs/src/shadow-mongo/index.js'

import { createMongoShadowAdapter } from '../../../packages/engine-rs/src/shadow-mongo/index.js'
import { mongodbArgs } from './args.js'

type MongooseAdapterFactory = typeof mongooseAdapter
type MongooseArgs = Parameters<MongooseAdapterFactory>[0]

const DEFAULT_URL =
  'mongodb://payload:payload@localhost:27018/payload?authSource=admin&directConnection=true&replicaSet=rs0'

export const referenceURL = () => process.env.MONGODB_URL || process.env.DATABASE_URL || DEFAULT_URL

/** Same URL with `_c` appended to the database name (or PAYLOAD_RS_MONGO_CANDIDATE_URL). */
export const candidateURL = (url: string) => {
  if (process.env.PAYLOAD_RS_MONGO_CANDIDATE_URL) {
    return process.env.PAYLOAD_RS_MONGO_CANDIDATE_URL
  }
  const parsed = new URL(url)
  const dbName = parsed.pathname.replace(/^\//, '') || 'test'
  parsed.pathname = `/${dbName}_c`
  return parsed.toString()
}

/** The upstream TS adapter even when PAYLOAD_ENGINE=rs (the reference must always be TS). */
export const tsMongooseAdapter: MongooseAdapterFactory = (args) => {
  const previous = process.env.PAYLOAD_ENGINE
  process.env.PAYLOAD_ENGINE = 'ts'
  try {
    return mongooseAdapter(args)
  } finally {
    if (previous === undefined) {
      delete process.env.PAYLOAD_ENGINE
    } else {
      process.env.PAYLOAD_ENGINE = previous
    }
  }
}

const loadCandidateFactory = async (): Promise<MongooseAdapterFactory> => {
  const selected = process.env.PAYLOAD_RS_MONGO_CANDIDATE || 'ts'
  if (selected === 'ts') {
    return tsMongooseAdapter
  }
  if (selected === 'rs') {
    // MONGO_ENGINE_CONTRACT.md: the candidate is `withRustMongoEngine(mongooseAdapter(args))`
    const engine: Record<string, unknown> = await import('../../../packages/engine-rs/src/index.js')
    const withRustMongoEngine = engine.withRustMongoEngine
    if (typeof withRustMongoEngine !== 'function') {
      throw new Error(
        'PAYLOAD_RS_MONGO_CANDIDATE=rs: packages/engine-rs does not export withRustMongoEngine',
      )
    }
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
      (withRustMongoEngine as (adapterObj: DatabaseAdapterObj) => DatabaseAdapterObj)(
        tsMongooseAdapter(args),
      ) as ReturnType<MongooseAdapterFactory>
  }
  const mod: Record<string, unknown> = await import(
    pathToFileURL(path.isAbsolute(selected) ? selected : path.resolve(selected)).href
  )
  const factory = mod.mongooseAdapter ?? mod.default
  if (typeof factory !== 'function') {
    throw new Error(
      `PAYLOAD_RS_MONGO_CANDIDATE=${selected}: module does not export a mongooseAdapter(args) factory`,
    )
  }
  return factory as MongooseAdapterFactory
}

/** Current vitest file/test (if running under vitest). */
export const loadContext = async (): Promise<() => ShadowContext> => {
  if (process.env.PAYLOAD_RS_MONGO_CHILD === 'true') {
    // child process of a test: own report file, the command as test name
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

type ShadowMongoOptions = {
  /** Wraps the candidate (used by the harness self-test to inject bugs). */
  wrapCandidate?: (candidate: DatabaseAdapterObj) => DatabaseAdapterObj
} & Partial<Parameters<typeof createMongoShadowAdapter>[0]>

/**
 * Returns a `mongooseAdapter(args)` replacement: reference is the TS adapter with `args`,
 * candidate the PAYLOAD_RS_MONGO_CANDIDATE adapter with the same args on `candidateURL(args.url)`.
 */
export async function loadShadowMongooseAdapterFactory(options: ShadowMongoOptions = {}) {
  const { wrapCandidate, ...rest } = options
  const candidateFactory = await loadCandidateFactory()
  const context = await loadContext()
  return (args: MongooseArgs): DatabaseAdapterObj => {
    const url = typeof args.url === 'string' ? args.url : referenceURL()
    const candidate = candidateFactory({ ...args, url: candidateURL(url) })
    return createMongoShadowAdapter({
      candidate: wrapCandidate ? wrapCandidate(candidate) : candidate,
      crossProcessFile: process.env.PAYLOAD_RS_MONGO_SHADOW_WINDOWS_FILE,
      onDivergence: process.env.PAYLOAD_RS_SHADOW_STRICT === 'true' ? 'throw' : 'record',
      reference: tsMongooseAdapter(args),
      report: {
        context,
        dir: process.env.PAYLOAD_RS_REPORT_DIR
          ? path.resolve(process.env.PAYLOAD_RS_REPORT_DIR)
          : path.resolve(process.cwd(), '.rs-baseline', 'divergences'),
      },
      ...rest,
    }) as DatabaseAdapterObj
  }
}

export async function createShadowMongoAdapter(
  options: { args?: MongooseArgs } & ShadowMongoOptions = {},
): Promise<DatabaseAdapterObj> {
  const { args, ...rest } = options
  return (await loadShadowMongooseAdapterFactory(rest))(args ?? mongodbArgs())
}
