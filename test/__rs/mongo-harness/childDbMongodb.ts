/**
 * `@payloadcms/db-mongodb` as seen by test modules in a shadow-mode child process (see
 * childProcessHooks.mjs). A child that builds its own `mongooseAdapter(args)` instead of importing
 * test/databaseAdapter.js gets the shadow adapter for those args, so its writes reach the
 * candidate database too.
 */
import { loadShadowMongooseAdapterFactory } from './shadowDatabaseAdapter.js'

// stands in for the whole module, so everything else is re-exported unchanged
export * from '@payloadcms/db-mongodb'

export const mongooseAdapter = await loadShadowMongooseAdapterFactory()
