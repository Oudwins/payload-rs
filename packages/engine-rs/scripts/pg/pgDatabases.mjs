#!/usr/bin/env node
/**
 * Lists, creates or drops databases on the Rust-port PostgreSQL test server (localhost:5433, user
 * payload/payload, see test/__rs/pg-harness/README.md).
 *
 *   node packages/engine-rs/scripts/pg/pgDatabases.mjs list
 *   node packages/engine-rs/scripts/pg/pgDatabases.mjs create <name> [--schema <schema>]
 *   node packages/engine-rs/scripts/pg/pgDatabases.mjs drop <name|/regex/> ...
 *
 * Also importable: `pgUrlFor(dbName)`, `createDatabase(name, { schemas })`, `dropDatabases(names)`,
 * `listDatabases()`, `withPgClient(fn, dbName?)`. Uses the `pg` driver of @payloadcms/db-postgres
 * (no extra dependency).
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const requireFromDbPostgres = createRequire(path.join(root, 'packages/db-postgres/package.json'))
const pg = requireFromDbPostgres('pg')

/** Server part of upstream's default `POSTGRES_URL` (test/dbAdapters.ts POSTGRES). */
export const PG_SERVER =
  process.env.PAYLOAD_RS_PG_SERVER || 'postgres://payload:payload@localhost:5433'

/** Connection string in the shape of upstream's default `POSTGRES_URL`, for one database. */
export const pgUrlFor = (dbName) => `${PG_SERVER}/${dbName}`

/** Databases the harness never drops (`payload` is upstream's default database). */
const PROTECTED = new Set(['payload', 'postgres', 'template0', 'template1'])

const quoteIdentifier = (name) => `"${String(name).replaceAll('"', '""')}"`

export const withPgClient = async (fn, dbName = 'postgres') => {
  const client = new pg.Client({
    connectionString: pgUrlFor(dbName),
    connectionTimeoutMillis: 10_000,
  })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

export const listDatabases = () =>
  withPgClient(async (client) => {
    const { rows } = await client.query(
      'SELECT datname AS name, pg_database_size(datname) AS size FROM pg_database WHERE NOT datistemplate ORDER BY datname',
    )
    return rows.map(({ name, size }) => ({ name, size: Number(size) }))
  })

/**
 * Creates an empty database (dropping a leftover one of the same name) and the given schemas in
 * it (upstream CI runs `CREATE SCHEMA custom;` before postgres-custom-schema suites).
 */
export const createDatabase = async (name, { schemas = [] } = {}) => {
  if (PROTECTED.has(name)) {
    throw new Error(`refusing to recreate protected database ${name}`)
  }
  await withPgClient(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`)
    await client.query(`CREATE DATABASE ${quoteIdentifier(name)}`)
  })
  if (schemas.length) {
    await withPgClient(async (client) => {
      for (const schema of schemas) {
        await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`)
      }
    }, name)
  }
}

/** Drops the given databases, terminating open connections (never the protected ones). */
export const dropDatabases = (names) =>
  withPgClient(async (client) => {
    const dropped = []
    for (const name of names) {
      if (!PROTECTED.has(name)) {
        await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`)
        dropped.push(name)
      }
    }
    return dropped
  })

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'list') {
    for (const { name, size } of await listDatabases()) {
      process.stdout.write(`${name}\t${size}\n`)
    }
  } else if (command === 'create' && rest[0]) {
    const schemaIndex = rest.indexOf('--schema')
    await createDatabase(rest[0], { schemas: schemaIndex === -1 ? [] : [rest[schemaIndex + 1]] })
    process.stdout.write(`created ${rest[0]}\n`)
  } else if (command === 'drop' && rest.length) {
    const all = (await listDatabases()).map(({ name }) => name)
    const matchers = rest.map((pattern) =>
      pattern.startsWith('/') && pattern.endsWith('/')
        ? (name) => new RegExp(pattern.slice(1, -1)).test(name)
        : (name) => name === pattern,
    )
    const dropped = await dropDatabases(all.filter((name) => matchers.some((m) => m(name))))
    process.stdout.write(`dropped ${dropped.length}: ${dropped.join(', ')}\n`)
  } else {
    process.stderr.write(
      'usage: pgDatabases.mjs list | create <name> [--schema <schema>] | drop <name|/regex/> ...\n',
    )
    process.exitCode = 2
  }
}
