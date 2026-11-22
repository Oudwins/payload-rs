/**
 * Live-object MongoDB engine (crates/payload-mongo-live, exported by the main addon as
 * `mongoLiveBinding()`; MONGO_ENGINE_CONTRACT.md "Live helpers"): the shared live helpers and the
 * read data methods of `@payloadcms/db-mongodb`, run on the core runtime against the caller's live
 * objects and the adapter's real mongoose models.
 *
 * - `getMongoLive({ mongoose? })` loads and initializes the binding once (after the core runtime and
 *   the core query port of the same addon instance). Other live bindings that use the shared helpers
 *   must call it first.
 * - `installLiveReads(adapter)` replaces the adapter's read methods with the Rust ones:
 *   `adapter[m] = function (args) { return binding[m](this, args) }` (`this` is the adapter the
 *   method is called on, like the upstream `async function`; the returned promise is the engine
 *   task's own, so callers take the same microtask ticks).
 * - the live query port (`mongoLiveQueryBinding()`, crates/payload-mongo-live-query) is initialized
 *   here too (query.ts) when the addon has it; transform and joins are initialized by their loaders
 *   (packages/engine-rs/src/mongo-adapter/live.ts `initializeLiveDeps`).
 * - `PAYLOAD_RS_MONGO_LIVE_UPSTREAM_DEPS=true`: the reads call upstream's TS `buildQuery` /
 *   `buildSortParam` / `buildProjectionFromSelect` / `transform` / `buildJoinAggregation` /
 *   `resolveJoins` even where a live port is registered (differential isolation).
 */

import { coreRuntimeAddonPath, loadCoreRuntimeAddon } from '../addon.js'
import { getCoreQueryBinding } from '../query/index.js'
import { getCoreRuntime } from '../runtime/index.js'
import { createMongoLiveHost } from './host.js'
import { initMongoLiveQuery } from './query.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- drop-ins keep the upstream generics */
type Any = any

export const mongoLiveReadMethods = [
  'count',
  'countGlobalVersions',
  'countVersions',
  'find',
  'findDistinct',
  'findGlobal',
  'findGlobalVersions',
  'findOne',
  'findVersions',
  'queryDrafts',
] as const

export type MongoLiveReadMethod = (typeof mongoLiveReadMethods)[number]

export type MongoLiveBinding = {
  aggregatePaginate: (args: unknown) => Promise<unknown>
  apiVersion?: number
  bsonClassOf: (value: unknown) => null | string
  getCollection: (
    adapter: unknown,
    slug: unknown,
    versions?: boolean,
  ) => [unknown, unknown, unknown]
  getGlobal: (adapter: unknown, slug: unknown, versions?: boolean) => [unknown, unknown]
  getSession: (db: unknown, req: unknown) => Promise<unknown>
  init: (host: Record<string, unknown>, options?: { upstreamDeps?: boolean }) => void
  isObjectID: (value: unknown) => boolean
  newObjectId: (value?: unknown) => unknown
  nowISO: () => string
  objectIdIsValid: (value: unknown) => boolean
  ported: () => Record<string, boolean>
} & Record<MongoLiveReadMethod, (adapter: unknown, args: unknown) => Promise<unknown>>

/** The binding contract this host implements (crates/payload-mongo-live/src/binding.rs `API_VERSION`). */
const MONGO_LIVE_API_VERSION = 1

let binding: MongoLiveBinding | undefined

export const getMongoLive = ({ mongoose }: { mongoose?: Any } = {}): MongoLiveBinding => {
  if (binding) {
    return binding
  }
  getCoreRuntime()
  // combineQueries of the reads is the live query port (crates/payload-core-query)
  getCoreQueryBinding()
  // same resolution as `getCoreRuntime()`: all bindings must come from one addon instance
  const addonPath = coreRuntimeAddonPath()
  const addon = loadCoreRuntimeAddon() as {
    mongoLiveBinding?: () => MongoLiveBinding
    mongoLiveQueryBinding?: () => any
  }
  if (typeof addon.mongoLiveBinding !== 'function') {
    throw new Error(`The engine addon at ${addonPath} has no mongoLiveBinding export`)
  }
  const created = addon.mongoLiveBinding()
  if (created.apiVersion !== MONGO_LIVE_API_VERSION) {
    throw new Error(
      `The engine addon at ${addonPath} has mongo live API version ${created.apiVersion}, expected ${MONGO_LIVE_API_VERSION}; rebuild it`,
    )
  }
  created.init(createMongoLiveHost({ mongoose }), {
    upstreamDeps: process.env.PAYLOAD_RS_MONGO_LIVE_UPSTREAM_DEPS === 'true',
  })
  // the query ports payload-node registers in `payload_mongo_live::deps` need their host
  initMongoLiveQuery({ addon, addonPath })
  binding = created
  return created
}

const stats: Partial<Record<MongoLiveReadMethod, number>> = {}

/** Calls served by the live read methods in this process (harness guards). */
export const getMongoLiveReadStats = () => stats

/**
 * Replaces the read data methods of a db-mongodb adapter (after its `init`) with the live Rust
 * ones. Returns the replaced upstream methods.
 */
export const installLiveReads = (
  adapter: Record<string, Any>,
  { mongoose }: { mongoose?: Any } = {},
): Record<MongoLiveReadMethod, Any> => {
  const live = getMongoLive({ mongoose })
  const replaced = {} as Record<MongoLiveReadMethod, Any>
  for (const method of mongoLiveReadMethods) {
    replaced[method] = adapter[method]
    const run = live[method]
    adapter[method] = function (this: unknown, args: unknown) {
      stats[method] = (stats[method] ?? 0) + 1
      return run(this, args)
    }
  }
  return replaced
}
