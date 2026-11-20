/**
 * Loads the live write binding (crates/payload-mongo-live-write, `mongoLiveWriteBinding()` of the
 * addon at PAYLOAD_ENGINE_ADDON / PAYLOAD_CORE_RUNTIME_ADDON) after payload-mongo-live's host
 * (`getMongoLive()`: core runtime, core query, live helpers of the same addon instance).
 *
 * `installLiveWrites(adapter)` is the production-shaped install: `adapter[m] = binding[m]`, so the
 * method's `this` is the adapter it is called on (upsert's `this.updateOne` included).
 */
import { createRequire } from 'node:module'

import { getMongoLive } from '../../../packages/engine-rs/src/mongo-live/index.js'
import { getLiveTransformBinding } from '../mongo-live-transform/native.js'

export const liveWriteMethods = [
  'create',
  'createGlobal',
  'createGlobalVersion',
  'createVersion',
  'deleteMany',
  'deleteOne',
  'deleteVersions',
  'updateGlobal',
  'updateGlobalVersion',
  'updateJobs',
  'updateMany',
  'updateOne',
  'updateVersion',
  'upsert',
] as const

export type LiveWriteMethod = (typeof liveWriteMethods)[number]

export type MongoLiveWriteBinding = {
  apiVersion?: number
  init: () => void
  stats: () => Record<LiveWriteMethod, number>
} & Record<LiveWriteMethod, (this: unknown, args: unknown) => Promise<unknown>>

const MONGO_LIVE_WRITE_API_VERSION = 1

let binding: MongoLiveWriteBinding | undefined

export const getMongoLiveWrite = ({
  mongoose,
}: { mongoose?: unknown } = {}): MongoLiveWriteBinding => {
  if (binding) {
    return binding
  }
  getMongoLive({ mongoose })
  // `getMongoLive()` also initializes the live query binding (its ports are registered in
  // payload-mongo-live's deps). handleError is payload-mongo-live-transform's port (its binding holds
  // the error classes); its init also registers the Rust transform.
  // PAYLOAD_RS_MONGO_LIVE_UPSTREAM_DEPS=true keeps upstream's TS functions in deps (isolation).
  getLiveTransformBinding()
  const require = createRequire(import.meta.url)
  const addonPath = process.env.PAYLOAD_CORE_RUNTIME_ADDON ?? process.env.PAYLOAD_ENGINE_ADDON
  if (!addonPath) {
    throw new Error('set PAYLOAD_ENGINE_ADDON to the payload-node addon')
  }
  const addon = require(addonPath) as { mongoLiveWriteBinding?: () => MongoLiveWriteBinding }
  if (typeof addon.mongoLiveWriteBinding !== 'function') {
    throw new Error(`The engine addon at ${addonPath} has no mongoLiveWriteBinding export`)
  }
  const created = addon.mongoLiveWriteBinding()
  if (created.apiVersion !== MONGO_LIVE_WRITE_API_VERSION) {
    throw new Error(
      `The engine addon at ${addonPath} has mongo live write API version ${created.apiVersion}, expected ${MONGO_LIVE_WRITE_API_VERSION}; rebuild it`,
    )
  }
  const mutant = Number(process.env.PAYLOAD_RS_LIVE_WRITE_MUTANT ?? 0)
  ;(created.init as (options?: { mutant?: number }) => void)({ mutant })
  binding = created
  return created
}

/** Replaces the write methods of a db-mongodb adapter with the live Rust ones (returns the old ones). */
export const installLiveWrites = (adapter: Record<string, any>): Record<LiveWriteMethod, any> => {
  const live = getMongoLiveWrite()
  const replaced = {} as Record<LiveWriteMethod, any>
  for (const method of liveWriteMethods) {
    replaced[method] = adapter[method]
    adapter[method] = live[method]
  }
  return replaced
}
