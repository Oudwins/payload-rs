/**
 * `@payloadcms/db-sqlite` as seen by test modules in a shadow-mode child
 * process (see childProcessHooks.mjs). Some children build their own adapter
 * instead of importing test/databaseAdapter.js (e.g. test/queues/crashWorker.ts
 * via config.crashWorker.ts); `sqliteAdapter(args)` returns the shadow adapter
 * for those args, so their writes reach the candidate database too.
 */
import { loadShadowSqliteAdapterFactory } from './shadowDatabaseAdapter.js'

// stands in for the whole module, so everything else is re-exported unchanged
export * from '@payloadcms/db-sqlite'

export const sqliteAdapter = await loadShadowSqliteAdapterFactory()
