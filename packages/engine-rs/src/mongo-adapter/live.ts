/**
 * The live-object MongoDB engine (MONGO_ENGINE_CONTRACT.md "Stage 1b decision"): the data methods
 * of a db-mongodb adapter are replaced by the Rust ports that run on the caller's live objects
 * (crates/payload-mongo-live: reads, crates/payload-mongo-live-write: writes). No copying, no JSON:
 * the engine receives the caller's very `args` object, `this` is the adapter the method is called
 * on, and the returned promise is the engine task's own.
 *
 * - reads: `installLiveReads(adapter)` (packages/engine-rs/src/mongo-live, owner livereads):
 *   `adapter[m] = function (args) { return binding[m](this, args) }`.
 * - writes: `adapter[m] = writeBinding[m]` (native functions taking the adapter as `this`, own
 *   `name` / `length` like upstream's, so upsert's `this.updateOne(...)` reaches whatever
 *   `updateOne` the adapter has, user overrides included).
 */
import { createRequire } from 'node:module'

import { APIError } from '../../../payload/src/errors/APIError.js'
import { ValidationError } from '../../../payload/src/errors/ValidationError.js'
import { flattenAllFields } from '../../../payload/src/utilities/flattenAllFields.js'
import { coreRuntimeAddonPath, loadCoreRuntimeAddon } from '../addon.js'
import { resolveDbMongodbMongoose } from '../mongo-live/host.js'
import { getMongoLive, getMongoLiveReadStats, installLiveReads } from '../mongo-live/index.js'
import { getMongoLiveQueryBinding } from '../mongo-live/query.js'
import { createRustMongoInit, getMongoLiveJoins } from './init.js'

type AnyObject = Record<PropertyKey, any>

export type MongoLiveWriteBinding = {
  apiVersion?: number
  init: () => void
  stats: () => Record<string, number>
} & Record<string, (this: unknown, args: unknown) => Promise<unknown>>

/** crates/payload-mongo-live-write/src/binding.rs `API_VERSION`. */
const MONGO_LIVE_WRITE_API_VERSION = 1

let writeBinding: MongoLiveWriteBinding | null | undefined

/** The engine addon, resolved like `getMongoLive()` / `getCoreRuntime()` (one addon instance). */
const requireEngineAddon = () => {
  const addonPath = coreRuntimeAddonPath()
  return {
    addon: loadCoreRuntimeAddon() as {
      mongoLiveBinding?: unknown
      mongoLiveJoinsBinding?: unknown
      mongoLiveQueryBinding?: unknown
      mongoLiveSchemaBinding?: unknown
      mongoLiveTransformBinding?: () => { init: (deps: Record<string, unknown>) => void }
      mongoLiveWriteBinding?: () => MongoLiveWriteBinding
    },
    addonPath,
  }
}

/**
 * The addon exports the live engine is made of (reads, query, transform, joins, model building,
 * writes). The Rust engine requires all of them: nothing falls back to upstream's TS silently
 * (`PAYLOAD_ENGINE=ts` selects upstream explicitly).
 */
export const requiredLiveBindings = [
  'mongoLiveBinding',
  'mongoLiveQueryBinding',
  'mongoLiveTransformBinding',
  'mongoLiveJoinsBinding',
  'mongoLiveSchemaBinding',
  'mongoLiveWriteBinding',
] as const

const missingLiveEngineError = ({ addonPath, missing }: { addonPath: string; missing: string[] }) =>
  new Error(
    `The Rust MongoDB engine: the engine addon at ${addonPath} lacks the live MongoDB engine (${missing.join(', ')}); rebuild crates/payload-node (cargo build -p payload-node) and reinstall the addon, or set PAYLOAD_ENGINE=ts to run upstream TypeScript`,
  )

/** Throws (before anything is initialized) unless the addon has every live binding. */
const assertLiveBindings = () => {
  const { addon, addonPath } = requireEngineAddon()
  const missing = requiredLiveBindings.filter(
    (name) => typeof (addon as Record<string, unknown>)[name] !== 'function',
  )
  if (missing.length) {
    throw missingLiveEngineError({ addonPath, missing })
  }
}

/**
 * The live write binding of the engine addon (after `getMongoLive()`: same addon instance, the
 * shared host installed), or `null` when the addon has none.
 */
export const getMongoLiveWrite = ({ mongoose }: { mongoose?: unknown } = {}) => {
  if (writeBinding !== undefined) {
    return writeBinding
  }
  getMongoLive({ mongoose })
  const { addon, addonPath } = requireEngineAddon()
  if (typeof addon.mongoLiveWriteBinding !== 'function') {
    writeBinding = null
    return writeBinding
  }
  const created = addon.mongoLiveWriteBinding()
  if (created.apiVersion !== MONGO_LIVE_WRITE_API_VERSION) {
    throw new Error(
      `The engine addon at ${addonPath} has mongo live write API version ${created.apiVersion}, expected ${MONGO_LIVE_WRITE_API_VERSION}; rebuild it`,
    )
  }
  created.init()
  writeBinding = created
  return writeBinding
}

let areDepsInitialized = false

/**
 * Once per process, before the first data method: the live ports the data methods call through
 * `payload_mongo_live::deps` are initialized (each registers itself): transform / handleError
 * (`mongoLiveTransformBinding().init` with the values db-mongodb imports: payload's `APIError`,
 * `ValidationError`, `flattenAllFields`, mongoose's `Types`) and joins (`getMongoLiveJoins()`,
 * init.ts). A binding the addon lacks leaves upstream's TS function in place for that dependency.
 */
const initializeLiveDeps = () => {
  if (areDepsInitialized) {
    return
  }
  areDepsInitialized = true
  getMongoLive()
  const { addon } = requireEngineAddon()
  if (typeof addon.mongoLiveTransformBinding === 'function') {
    addon.mongoLiveTransformBinding().init({
      APIError,
      flattenAllFields,
      Types: resolveDbMongodbMongoose().Types,
      ValidationError,
    })
  }
  if (typeof addon.mongoLiveJoinsBinding === 'function') {
    getMongoLiveJoins()
  }
}

/**
 * Installs the live data methods on `adapter` (right after upstream's `mongooseAdapter` `init`
 * built it, before anything calls it). Throws when the addon lacks a live binding, when a method of
 * `methods` has no live port, or when a live dependency runs upstream's TS (unless
 * `PAYLOAD_RS_MONGO_LIVE_UPSTREAM_DEPS=true` asks for that). Returns the methods installed.
 */
export const installLiveEngine = ({
  adapter,
  methods,
}: {
  adapter: AnyObject
  /** Adapter methods the Rust engine must serve. */
  methods: readonly string[]
}): Set<string> => {
  assertLiveBindings()
  const installed = new Set<string>()
  initializeLiveDeps()
  for (const method of Object.keys(installLiveReads(adapter))) {
    installed.add(method)
  }
  const writes = getMongoLiveWrite()
  if (writes) {
    for (const method of methods) {
      if (!installed.has(method) && typeof writes[method] === 'function') {
        adapter[method] = writes[method]
        installed.add(method)
      }
    }
  }
  const { addonPath } = requireEngineAddon()
  const missingMethods = methods.filter((method) => !installed.has(method))
  if (missingMethods.length) {
    throw missingLiveEngineError({ addonPath, missing: missingMethods.map((m) => `live ${m}`) })
  }
  if (process.env.PAYLOAD_RS_MONGO_LIVE_UPSTREAM_DEPS !== 'true') {
    const upstreamDeps = Object.entries(getLiveDepsPorted())
      .filter(([, isPorted]) => !isPorted)
      .map(([name]) => `live ${name}`)
    if (upstreamDeps.length) {
      throw missingLiveEngineError({ addonPath, missing: upstreamDeps })
    }
  }
  return installed
}

/**
 * db-mongodb's `init` (model building) on the live engine (`createRustMongoInit`, init.ts); throws
 * when the addon lacks the live schema or query binding. The deps are the values db-mongodb's
 * `init` imports: its `mongoose` module, `mongoose-paginate-v2` (the very module object, resolved
 * from db-mongodb's location) and `getBuildQueryPlugin` (the live query port's, so the
 * `Model.buildQuery` statics run Rust too; without that binding there is no live init).
 */
export const createLiveInit = () => {
  const { addon, addonPath } = requireEngineAddon()
  if (typeof addon.mongoLiveSchemaBinding !== 'function') {
    throw missingLiveEngineError({ addonPath, missing: ['mongoLiveSchemaBinding'] })
  }
  const mongoose = resolveDbMongodbMongoose()
  getMongoLive({ mongoose })
  const queryBinding = getMongoLiveQueryBinding()
  if (!queryBinding) {
    throw missingLiveEngineError({ addonPath, missing: ['mongoLiveQueryBinding'] })
  }
  const requireFromDbMongodb = createRequire(
    new URL('../../../db-mongodb/package.json', import.meta.url),
  )
  return createRustMongoInit({
    getBuildQueryPlugin: queryBinding.getBuildQueryPlugin,
    mongoose,
    paginate: requireFromDbMongodb('mongoose-paginate-v2'),
  })
}

/** Which `payload_mongo_live::deps` entries run their Rust port (vs upstream's TS function). */
export const getLiveDepsPorted = (): Record<string, boolean> => getMongoLive().ported()

/** Calls the live methods served in this process: reads (JS-side count), writes (native count). */
export const getLiveEngineCalls = (): Record<string, number> => {
  const calls: Record<string, number> = {}
  for (const [method, count] of Object.entries(getMongoLiveReadStats())) {
    calls[method] = count ?? 0
  }
  for (const [method, count] of Object.entries(writeBinding?.stats() ?? {})) {
    calls[method] = (calls[method] ?? 0) + count
  }
  return calls
}
