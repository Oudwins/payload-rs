/**
 * Alias target for `databaseAdapter.js` used by test/__rs/pg-harness/vitest.config.ts.
 *
 * Builds exactly what upstream codegen writes for PAYLOAD_DATABASE=postgres|postgres-uuid|
 * postgres-uuidv7|postgres-custom-schema (test/dbAdapters.ts, see args.ts). `postgresAdapter` is
 * imported from `@payloadcms/db-postgres` like upstream.
 *
 * POSTGRES_URL is required: suites drop their schema on connect (PAYLOAD_DROP_DATABASE) and
 * several runs share one server, so every run must name its own database (runSuites.mjs creates
 * one per file, plus the `custom` schema for postgres-custom-schema).
 */
import { postgresAdapter } from '@payloadcms/db-postgres'

import { postgresArgs, requiredSchemas, SUPPORTED_DATABASES } from './args.js'

if (
  !(SUPPORTED_DATABASES as readonly (string | undefined)[]).includes(process.env.PAYLOAD_DATABASE)
) {
  throw new Error(
    `test/__rs/pg-harness/vitest.config.ts supports PAYLOAD_DATABASE=${SUPPORTED_DATABASES.join('|')}, got ${process.env.PAYLOAD_DATABASE}`,
  )
}

if (!process.env.POSTGRES_URL) {
  throw new Error(
    'test/__rs/pg-harness: set POSTGRES_URL to a database of your own (suites drop its schema on connect)',
  )
}

const loader = new URL('childProcessLoader.mjs', import.meta.url).pathname

// Node child processes spawned by tests (the `cli` fixture) import test/databaseAdapter.js
// natively; upstream codegen would have written the postgres adapter there. They resolve it to
// this module instead (childProcessLoader.mjs) and build the same adapter as the test process.
if (process.env.PAYLOAD_RS_PG_CHILD !== 'true') {
  process.env.PAYLOAD_RS_PG_HARNESS = 'true'
  const nodeOptions = process.env.NODE_OPTIONS ?? ''
  if (!nodeOptions.includes(loader)) {
    process.env.NODE_OPTIONS = `${nodeOptions} --import ${loader}`.trim()
  }
}

export { postgresArgs, requiredSchemas }

export const databaseAdapter = postgresAdapter(postgresArgs())
