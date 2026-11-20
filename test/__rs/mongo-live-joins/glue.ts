/**
 * Loads the Rust joins ports for the differentials: `getMongoLiveJoins()` of
 * packages/engine-rs/src/mongo-adapter/init.ts (core runtime, shared live helpers, the joins
 * binding of the addon at PAYLOAD_ENGINE_ADDON). The shared helpers' module functions
 * (`buildQuery`, `buildSortParam`, `transform`) are forced to upstream's TS
 * (PAYLOAD_RS_MONGO_LIVE_UPSTREAM_DEPS=true) so the differential isolates the joins ports.
 */
import { getMongoLiveJoins } from '../../../packages/engine-rs/src/mongo-adapter/init.js'
import { getCoreRuntime } from '../../../packages/engine-rs/src/runtime/index.js'

process.env.PAYLOAD_RS_MONGO_LIVE_UPSTREAM_DEPS ??= 'true'

export const rsJoins = () => getMongoLiveJoins()

/** Node-API entries into the core engine crates so far (proves a call reached Rust). */
export const engineEntries = () => getCoreRuntime().stats().entries
