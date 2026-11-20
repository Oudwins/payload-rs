/**
 * Which db-mongodb dependencies of the live reads run as Rust ports in this process
 * (`LIVEREADS_PORTS`):
 * - unset / `registered`: whatever the addon registers by itself (payload-node: the query ports),
 * - `all`: also initializes the transform and joins ports, like the production glue does
 *   (packages/engine-rs/src/mongo-adapter/live.ts `initializeLiveDeps`),
 * - `upstream`: none (`PAYLOAD_RS_MONGO_LIVE_UPSTREAM_DEPS=true`: upstream's TS functions; isolates
 *   the read methods themselves).
 */
import { createRequire } from 'node:module'

import { getMongoLiveJoins } from '../../../packages/engine-rs/src/mongo-adapter/init.js'
import { resolveDbMongodbMongoose } from '../../../packages/engine-rs/src/mongo-live/host.js'
import { getMongoLive } from '../../../packages/engine-rs/src/mongo-live/index.js'
import { APIError } from '../../../packages/payload/src/errors/APIError.js'
import { ValidationError } from '../../../packages/payload/src/errors/ValidationError.js'
import { flattenAllFields } from '../../../packages/payload/src/utilities/flattenAllFields.js'

export const portsMode = process.env.LIVEREADS_PORTS ?? 'registered'

if (portsMode === 'upstream') {
  process.env.PAYLOAD_RS_MONGO_LIVE_UPSTREAM_DEPS = 'true'
}

let isInitialized = false

/** `getMongoLive()` plus the ports `LIVEREADS_PORTS` asks for; returns `ported()`. */
export const initLivePorts = () => {
  const live = getMongoLive()
  if (!isInitialized && portsMode === 'all') {
    const addon = createRequire(import.meta.url)(process.env.PAYLOAD_ENGINE_ADDON!) as any
    addon.mongoLiveTransformBinding().init({
      APIError,
      flattenAllFields,
      Types: resolveDbMongodbMongoose().Types,
      ValidationError,
    })
    getMongoLiveJoins()
  }
  isInitialized = true
  return live.ported()
}
