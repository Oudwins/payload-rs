/**
 * Live-object engine entries owned by the model-building port (MONGO_ENGINE_CONTRACT.md "Stage 1b
 * decision"):
 *
 * - `createRustMongoInit(deps)`: db-mongodb's `init` adapter method (connection,
 *   `afterCreateConnection`, every schema / plugin / `dbName` callback / `connection.model` call in
 *   upstream's interleaving) on the live engine (crates/payload-mongo-schema `live`,
 *   `mongoLiveSchemaBinding()` of the main addon). The glue assigns it as the adapter's `init`.
 * - `getMongoLiveJoins()`: the live ports of db-mongodb's `buildJoinAggregation` / `resolveJoins`
 *   (crates/payload-mongo-live-joins, `mongoLiveJoinsBinding()` of the main addon). Initializing it
 *   installs the payload helpers those modules import and registers the ports with the live read
 *   methods (`payload_mongo_live::deps`), so from then on the reads call Rust instead of upstream's TS.
 *
 * Payload internals are imported by relative path (engine-rs has no `payload` dependency; the
 * workspace resolves `payload` to these same source files, so the functions are the very ones
 * db-mongodb imports).
 */

import { combineQueries } from '../../../payload/src/database/combineQueries.js'
import { createSchemaBuildContext } from '../../../payload/src/database/createSchemaBuildContext.js'
import { APIError } from '../../../payload/src/errors/APIError.js'
import {
  fieldAffectsData,
  fieldIsPresentationalOnly,
  fieldIsVirtual,
  fieldShouldBeLocalized,
  tabHasName,
} from '../../../payload/src/fields/config/types.js'
import { hasDraftsEnabled } from '../../../payload/src/utilities/getVersionsConfig.js'
import { buildVersionCollectionFields } from '../../../payload/src/versions/buildCollectionFields.js'
import { buildVersionGlobalFields } from '../../../payload/src/versions/buildGlobalFields.js'
import { buildVersionCompoundIndexes } from '../../../payload/src/versions/buildVersionCompoundIndexes.js'
import { appendVersionToQueryKey } from '../../../payload/src/versions/drafts/appendVersionToQueryKey.js'
import { getQueryDraftsSort } from '../../../payload/src/versions/drafts/getQueryDraftsSort.js'
import { coreRuntimeAddonPath, loadCoreRuntimeAddon } from '../addon.js'
import { getMongoLive } from '../mongo-live/index.js'
import { getCoreRuntime } from '../runtime/index.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- the ports keep the upstream signatures */
type Any = any

export type MongoLiveJoinsBinding = {
  /** Contract version (crates/payload-mongo-live-joins/src/binding.rs `API_VERSION`). */
  apiVersion?: number
  /** upstream `buildJoinAggregation(args)` */
  buildJoinAggregation: (args: Any) => Promise<Any[]>
  init: (deps: Record<string, unknown>) => void
  /** upstream `resolveJoins(args)` */
  resolveJoins: (args: Any) => Promise<void>
}

const MONGO_LIVE_JOINS_API_VERSION = 1

let joinsBinding: MongoLiveJoinsBinding | undefined

/**
 * Loads `mongoLiveJoinsBinding()` once (after the shared live helpers of the same addon instance)
 * and registers the ports with the live reads.
 */
export const getMongoLiveJoins = ({ mongoose }: { mongoose?: Any } = {}): MongoLiveJoinsBinding => {
  if (joinsBinding) {
    return joinsBinding
  }
  getMongoLive({ mongoose })
  const path = coreRuntimeAddonPath()
  const addon = loadCoreRuntimeAddon() as {
    mongoLiveJoinsBinding?: () => MongoLiveJoinsBinding
  }
  if (typeof addon.mongoLiveJoinsBinding !== 'function') {
    throw new Error(`The engine addon at ${path} has no mongoLiveJoinsBinding export`)
  }
  const created = addon.mongoLiveJoinsBinding()
  if (created.apiVersion !== MONGO_LIVE_JOINS_API_VERSION) {
    throw new Error(
      `The engine addon at ${path} has mongo live joins API version ${created.apiVersion}, expected ${MONGO_LIVE_JOINS_API_VERSION}; rebuild it`,
    )
  }
  created.init({
    appendVersionToQueryKey,
    combineQueries,
    fieldShouldBeLocalized,
    getQueryDraftsSort,
    hasDraftsEnabled,
  })
  joinsBinding = created
  return created
}

/** What db-mongodb's `init` imports from its own package (engine-rs does not depend on it). */
export type MongoSchemaDeps = {
  /** db-mongodb's `getBuildQueryPlugin` */
  getBuildQueryPlugin: (args?: Any) => (schema: Any) => void
  /** the `mongoose` module db-mongodb imports */
  mongoose: Any
  /** `mongoose-paginate-v2` */
  paginate: (schema: Any, options?: Any) => void
}

export type MongoLiveSchemaBinding = {
  /** Contract version (crates/payload-mongo-schema/src/live/binding.rs `API_VERSION`). */
  apiVersion?: number
  /** upstream `init.call(adapter)` with the deps the live port reads */
  init: (adapter: Any, deps: Record<string, unknown>) => Promise<void>
}

const MONGO_LIVE_SCHEMA_API_VERSION = 1

let schemaBinding: MongoLiveSchemaBinding | undefined

export const getMongoLiveSchema = (): MongoLiveSchemaBinding => {
  if (schemaBinding) {
    return schemaBinding
  }
  getCoreRuntime()
  const path = coreRuntimeAddonPath()
  const addon = loadCoreRuntimeAddon() as {
    mongoLiveSchemaBinding?: () => MongoLiveSchemaBinding
  }
  if (typeof addon.mongoLiveSchemaBinding !== 'function') {
    throw new Error(`The engine addon at ${path} has no mongoLiveSchemaBinding export`)
  }
  const created = addon.mongoLiveSchemaBinding()
  if (created.apiVersion !== MONGO_LIVE_SCHEMA_API_VERSION) {
    throw new Error(
      `The engine addon at ${path} has mongo live schema API version ${created.apiVersion}, expected ${MONGO_LIVE_SCHEMA_API_VERSION}; rebuild it`,
    )
  }
  schemaBinding = created
  return created
}

/** payload functions db-mongodb's model building imports */
const payloadDeps = {
  APIError,
  buildVersionCollectionFields,
  buildVersionCompoundIndexes,
  buildVersionGlobalFields,
  createSchemaBuildContext,
  fieldAffectsData,
  fieldIsPresentationalOnly,
  fieldIsVirtual,
  fieldShouldBeLocalized,
  tabHasName,
}

/**
 * `defaultMongoosePluginFunctions` of db-mongodb's models/schemaBuildContext.ts (computed once per
 * mongoose module there, at module load; here at the first `init`).
 */
const defaultPluginsByMongoose = new WeakMap<object, Set<unknown>>()
const defaultPlugins = (mongoose: Any): Set<unknown> => {
  let set = defaultPluginsByMongoose.get(mongoose)
  if (!set) {
    const fresh = new mongoose.Mongoose({ createInitialConnection: false })
    set = new Set((fresh.plugins as [unknown, unknown][]).map(([plugin]) => plugin))
    defaultPluginsByMongoose.set(mongoose, set)
  }
  return set
}

/**
 * db-mongodb's `init` on the live engine: assign as the adapter's `init`
 * (`adapter.init = createRustMongoInit(deps)`). Returns the engine task's promise (a failure to load
 * the engine rejects it, like a throw inside the async method).
 */
export const createRustMongoInit = (deps: MongoSchemaDeps) =>
  function init(this: Any): Promise<void> {
    try {
      return getMongoLiveSchema().init(this, {
        defaultPlugins: defaultPlugins(deps.mongoose),
        getBuildQueryPlugin: deps.getBuildQueryPlugin,
        mongoose: deps.mongoose,
        paginate: deps.paginate,
        payload: payloadDeps,
      })
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejects with the thrown value as is, like upstream's async function
      return Promise.reject(error)
    }
  }
