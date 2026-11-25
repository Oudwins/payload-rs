/**
 * `withRustMongoEngine(adapterObj)` (MONGO_ENGINE_CONTRACT.md): the `@payloadcms/db-mongodb`
 * adapter with every data method served by the Rust engine.
 *
 * Right after upstream's `init` builds the adapter, its data methods are replaced by the live Rust
 * ports (live.ts), which receive the caller's real arguments and the adapter as `this` (no copy, no
 * JSON) and call the adapter's real mongoose models, and its `init` (model building) by the live
 * port of db-mongodb's `init`. The collection write methods of `upstreamWriteMethods` stay
 * upstream's (owner decision 2026-11-24: faster than the live ports, which cross Node-API per
 * statement); `PAYLOAD_RS_MONGO_LIVE_WRITES=true` serves them with the live ports too. Nothing else is wrapped. Connection use, transactions, migrations
 * and `payload.db.collections` / `versions` / `globals` / `connection` stay the upstream TS. An
 * addon without the complete live engine is an error.
 */
import { renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { registerFlushOnFileEnd } from '../flushOnFileEnd.js'
import { getDriverLaneStats, installDriverLane } from '../mongo-driver/index.js'
import { createLiveInit, getLiveDepsPorted, getLiveEngineCalls, installLiveEngine } from './live.js'

type AnyObject = Record<PropertyKey, any>

/** Adapter methods served by the live engine (method name = adapter property). */
export const mongoEngineMethods = [
  'count',
  'countGlobalVersions',
  'countVersions',
  'create',
  'createGlobal',
  'createGlobalVersion',
  'createVersion',
  'deleteMany',
  'deleteOne',
  'deleteVersions',
  'find',
  'findDistinct',
  'findGlobal',
  'findGlobalVersions',
  'findOne',
  'findVersions',
  'queryDrafts',
  'updateGlobal',
  'updateGlobalVersion',
  'updateJobs',
  'updateMany',
  'updateOne',
  'updateVersion',
  'upsert',
] as const

/**
 * Write methods upstream's db-mongodb serves by default (measured faster than their live ports:
 * WP-G A/B, typical shape, about +2-4% on create / update / delete). The global, jobs and upsert
 * writes stay live.
 */
export const upstreamWriteMethods = [
  'create',
  'createVersion',
  'deleteMany',
  'deleteOne',
  'deleteVersions',
  'updateMany',
  'updateOne',
  'updateVersion',
] as const

const isLiveWrites = () => process.env.PAYLOAD_RS_MONGO_LIVE_WRITES === 'true'

type AdapterObj = { init: (args: { payload: any }) => AnyObject }

const rustAdapters = new WeakSet<object>()

/** Whether `adapter` was created through `withRustMongoEngine`. */
export const isRustMongoEngineAdapter = (adapter: unknown): boolean =>
  typeof adapter === 'object' && adapter !== null && rustAdapters.has(adapter)

const stats = {
  /** Adapters served by the live engine. */
  engines: { live: 0 },
  /** Adapters whose `init` (model building) is the live Rust port. */
  liveInit: 0,
  /** Live engine calls per method (reads counted by the JS installer, writes by the addon). */
  liveCalls: {} as Record<string, number>,
  /** Methods served by the live engine (union over adapters). */
  liveMethods: [] as string[],
  /** Data methods left to upstream's db-mongodb (union over adapters). */
  upstreamMethods: [] as string[],
  /** Live dependencies (buildQuery, transform, joins, ...) running their Rust port. */
  livePorted: {} as Record<string, boolean>,
  /** Reads served by the Rust driver lane / handed to the mongoose lane (mongo-driver). */
  driverLane: undefined as ReturnType<typeof getDriverLaneStats> | undefined,
  /** Methods served by the driver lane (union over adapters). */
  driverMethods: [] as string[],
}

/**
 * Live engines created and live calls per method in this process, so a run can prove the engine
 * really served the data methods. Written (JSON, throttled, and at exit) to
 * `PAYLOAD_RS_MONGO_ENGINE_STATS_FILE` and/or to `<PAYLOAD_RS_MONGO_ENGINE_STATS_DIR>/mongo-engine-<pid>.json`
 * (one file per process: child processes of a test write their own).
 */
export const getRustMongoEngineStats = () => stats

let lastStatsWrite = 0

const statsFiles = () => {
  const files: string[] = []
  if (process.env.PAYLOAD_RS_MONGO_ENGINE_STATS_FILE) {
    files.push(process.env.PAYLOAD_RS_MONGO_ENGINE_STATS_FILE)
  }
  if (process.env.PAYLOAD_RS_MONGO_ENGINE_STATS_DIR) {
    files.push(
      path.join(process.env.PAYLOAD_RS_MONGO_ENGINE_STATS_DIR, `mongo-engine-${process.pid}.json`),
    )
  }
  return files
}

let isStatsWriterInstalled = false

const recordStats = (update: () => void) => {
  update()
  const files = statsFiles()
  if (!files.length) {
    return
  }
  if (!isStatsWriterInstalled) {
    isStatsWriterInstalled = true
    process.once('exit', () => files.forEach(writeStatsFile))
    // live calls never pass through this module: refresh the file periodically, and at the end of
    // every test file (test runners terminate workers without an `exit` event)
    setInterval(() => files.forEach(writeStatsFile), 1000).unref()
    registerFlushOnFileEnd(() => files.forEach(writeStatsFile))
  }
  const now = performance.now()
  if (now - lastStatsWrite > 250) {
    lastStatsWrite = now
    files.forEach(writeStatsFile)
  }
}

/**
 * Harness only (a stats file is configured): writes the stats synchronously when `destroy` is
 * called (test runners terminate worker processes without an `exit` event), then calls the
 * adapter's own `destroy` and returns its very promise.
 */
const flushStatsBeforeDestroy = (adapter: AnyObject) => {
  const files = statsFiles()
  const destroy = adapter.destroy
  if (!files.length || typeof destroy !== 'function') {
    return
  }
  adapter.destroy = function (this: unknown, ...args: unknown[]) {
    files.forEach(writeStatsFile)
    return destroy.apply(this, args)
  }
}

const writeStatsFile = (file: string) => {
  if (stats.engines.live) {
    stats.liveCalls = getLiveEngineCalls()
    stats.livePorted = getLiveDepsPorted()
  }
  if (stats.driverMethods.length) {
    stats.driverLane = getDriverLaneStats()
  }
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(stats))
  renameSync(temporary, file)
}

/**
 * Wraps the object returned by `@payloadcms/db-mongodb`'s `mongooseAdapter(args)`. Its `init`
 * builds the upstream adapter and swaps the data methods and model building for the live Rust
 * engine (throws when the addon lacks any part of it).
 */
export const withRustMongoEngine = <TAdapterObj extends AdapterObj>(
  adapterObj: TAdapterObj,
): TAdapterObj => ({
  ...adapterObj,
  init: (args: { payload: any }) => {
    const adapter = adapterObj.init(args)
    if (rustAdapters.has(adapter)) {
      return adapter
    }
    rustAdapters.add(adapter)
    const upstream = isLiveWrites()
      ? []
      : upstreamWriteMethods.map((method) => [method, adapter[method]] as const)
    const live = installLiveEngine({ adapter, methods: mongoEngineMethods })
    for (const [method, upstreamMethod] of upstream) {
      adapter[method] = upstreamMethod
      live.delete(method)
    }
    const driver = installDriverLane(adapter)
    adapter.init = createLiveInit()
    recordStats(() => {
      stats.engines.live++
      stats.liveMethods = [...new Set([...live, ...stats.liveMethods])].sort()
      stats.upstreamMethods = [
        ...new Set([...stats.upstreamMethods, ...upstream.map(([method]) => method)]),
      ].sort()
      stats.driverMethods = [...new Set([...driver, ...stats.driverMethods])].sort()
      stats.liveInit++
    })
    flushStatsBeforeDestroy(adapter)
    return adapter
  },
})
