import type { postgresAdapter } from '@payloadcms/db-postgres'

type PostgresArgs = Parameters<typeof postgresAdapter>[0]

/**
 * PAYLOAD_DATABASE values served by this harness (POSTGRES entries of test/dbAdapters.ts that only
 * need the primary server). `postgres-read-replica(s)` need a streaming replica on :5434 and are
 * not supported.
 */
export const SUPPORTED_DATABASES = [
  'postgres',
  'postgres-custom-schema',
  'postgres-uuid',
  'postgres-uuidv7',
] as const

/** Schemas the database must contain before the run (upstream CI: `CREATE SCHEMA custom;`). */
export const requiredSchemas = (database = process.env.PAYLOAD_DATABASE): string[] =>
  database === 'postgres-custom-schema' ? ['custom'] : []

/**
 * Exactly the `postgresAdapter` arguments upstream codegen writes for PAYLOAD_DATABASE (the
 * `postgres`, `postgres-custom-schema`, `postgres-uuid` and `postgres-uuidv7` entries of
 * test/dbAdapters.ts), including key order and the URL precedence.
 */
export const postgresArgs = (database = process.env.PAYLOAD_DATABASE): PostgresArgs => {
  const connectionString =
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    'postgres://payload:payload@localhost:5433/payload'
  switch (database) {
    case 'postgres-custom-schema':
      return { pool: { connectionString }, schemaName: 'custom' }
    case 'postgres-uuid':
      return { idType: 'uuid', pool: { connectionString } }
    case 'postgres-uuidv7':
      return { idType: 'uuidv7', pool: { connectionString } }
    default:
      return { pool: { connectionString } }
  }
}
