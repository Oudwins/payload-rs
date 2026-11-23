/**
 * The MongoDB driver lane (MONGO_DRIVER_CONTRACT.md): Payload's MongoDB reads run on a Rust
 * `mongodb` client (crates/payload-mongo-driver), installed on the adapter right after the live
 * engine's methods (`installDriverLane`); every read the lane cannot serve exactly runs on the
 * mongoose lane (the live engine's method).
 *
 * `PAYLOAD_MONGO_DRIVER=node` forces the Node driver (mongoose) for everything.
 */
import { createRequire } from 'node:module'

import { resolveDbMongodbMongoose } from '../mongo-live/host.js'
import { getDriverBinding } from './binding.js'
import { createLaneMethod, type DriverLane, laneMethods, laneStats } from './lane.js'
import { verifyMode, verifyStats } from './verify.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- adapter objects are untyped here */
type Any = any

const lanes = new WeakMap<object, DriverLane>()

/** Why adapters of this process have no driver client (reason -> adapters). */
const clientless: Record<string, number> = {}

/** Driver lane counters of this process (the engine stats file's `driverLane`). */
export const getDriverLaneStats = () => {
  const binding = getDriverBinding()
  const [calls, served, bailed] = binding?.stats() ?? [0, 0, 0]
  return {
    clientless: { ...clientless },
    clients: { bailed, calls, served },
    fallback: laneStats.fallback,
    served: laneStats.served,
    ...(verifyMode() !== 'off' ? { verify: verifyStats } : {}),
  }
}

/** The adapter's lane, if its driver client is up. */
export const getDriverLane = (adapter: object): DriverLane | undefined => lanes.get(adapter)

/** `connectOptions` keys the lane maps onto the Rust client, or that only affect mongoose. */
const mappedConnectOptions = new Set([
  'appName',
  'connectTimeoutMS',
  'dbName',
  'maxPoolSize',
  'minPoolSize',
  'replicaSet',
  'serverSelectionTimeoutMS',
])
const mongooseOnlyConnectOptions = new Set(['autoCreate', 'autoIndex', 'bufferCommands'])

/** Connection string options the Rust driver parses with the Node driver's meaning. */
const supportedUrlOptions = new Set(
  [
    'appName',
    'authMechanism',
    'authSource',
    'connectTimeoutMS',
    'directConnection',
    'heartbeatFrequencyMS',
    'journal',
    'localThresholdMS',
    'maxIdleTimeMS',
    'maxPoolSize',
    'minPoolSize',
    'readConcernLevel',
    'readPreference',
    'replicaSet',
    'retryReads',
    'retryWrites',
    'serverSelectionTimeoutMS',
    'socketTimeoutMS',
    'ssl',
    'tls',
    'w',
    'wtimeoutMS',
  ].map((key) => key.toLowerCase()),
)

/** The Rust client's options for `adapter`, or the reason it cannot have one. */
const clientSpec = (adapter: Any): { reason: string } | { spec: Record<string, unknown> } => {
  if (typeof adapter.url !== 'string') {
    return { reason: 'no url' }
  }
  if (!/^mongodb(?:\+srv)?:\/\//.test(adapter.url)) {
    return { reason: 'url scheme' }
  }
  const query = adapter.url.split('?')[1]?.split('#')[0]
  for (const pair of query ? query.split('&') : []) {
    const key = decodeURIComponent(pair.split('=')[0] ?? '').toLowerCase()
    if (key && !supportedUrlOptions.has(key)) {
      return { reason: `url option ${key}` }
    }
    if (key === 'authmechanism' && !/^SCRAM-SHA-(?:1|256)$/i.test(pair.split('=')[1] ?? '')) {
      return { reason: 'auth mechanism' }
    }
  }
  const spec: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(adapter.connectOptions ?? {})) {
    if (mongooseOnlyConnectOptions.has(key)) {
      continue
    }
    if (!mappedConnectOptions.has(key)) {
      return { reason: `connect option ${key}` }
    }
    spec[key] = value
  }
  // the database mongoose's connection uses (URL path, `dbName`, else mongoose's `test`)
  if (typeof adapter.connection?.name === 'string' && adapter.connection.name) {
    spec.dbName = adapter.connection.name
  }
  return { spec }
}

const createLane = async (adapter: Any) => {
  const binding = getDriverBinding()
  if (!binding || lanes.has(adapter)) {
    return
  }
  const result = clientSpec(adapter)
  if ('reason' in result) {
    clientless[result.reason] = (clientless[result.reason] ?? 0) + 1
    return
  }
  let info: { id: number }
  try {
    info = JSON.parse(await binding.connect(adapter.url, JSON.stringify(result.spec)))
  } catch {
    // the mongoose connection is up: its lane serves everything
    clientless['connect failed'] = (clientless['connect failed'] ?? 0) + 1
    return
  }
  const mongoose = resolveDbMongodbMongoose()
  const requireFromDbMongodb = createRequire(
    new URL('../../../db-mongodb/package.json', import.meta.url),
  )
  lanes.set(adapter, {
    binding,
    BSON: mongoose.mongo.BSON,
    clientID: info.id,
    mongoose,
    paginate: requireFromDbMongodb('mongoose-paginate-v2').paginate,
    plans: new Map(),
  })
}

/**
 * Installs the driver lane on `adapter` (after the live engine's methods): its read methods try
 * the driver first and fall back to the methods installed before; `connect` also starts the Rust
 * client, `destroy` also closes it. No-op with `PAYLOAD_MONGO_DRIVER=node` or an addon without the
 * driver.
 */
export const installDriverLane = (adapter: Any): readonly string[] => {
  if (process.env.PAYLOAD_MONGO_DRIVER === 'node' || !getDriverBinding()) {
    return []
  }
  for (const method of laneMethods) {
    const fallback = adapter[method]
    if (typeof fallback === 'function') {
      adapter[method] = createLaneMethod({ fallback, lane: getDriverLane, method })
    }
  }
  const upstreamConnect = adapter.connect
  adapter.connect = async function connect(this: Any, ...args: unknown[]) {
    await upstreamConnect.apply(this, args)
    await createLane(this)
  }
  const upstreamDestroy = adapter.destroy
  adapter.destroy = async function destroy(this: Any, ...args: unknown[]) {
    const lane = lanes.get(this)
    if (lane) {
      lanes.delete(this)
      await lane.binding.close(lane.clientID)
    }
    return upstreamDestroy.apply(this, args)
  }
  return laneMethods
}
