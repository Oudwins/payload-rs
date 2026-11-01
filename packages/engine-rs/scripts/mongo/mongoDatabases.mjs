#!/usr/bin/env node
/**
 * Lists or drops databases on the Rust-port MongoDB test server (replica set rs0 on
 * localhost:27018, see packages/engine-rs/MONGO_ENGINE_CONTRACT.md).
 *
 *   node packages/engine-rs/scripts/mongo/mongoDatabases.mjs list
 *   node packages/engine-rs/scripts/mongo/mongoDatabases.mjs drop <name|/regex/> ...
 *
 * Also importable: `mongoUrlFor(dbName)`, `dropDatabases(names)`, `withMongoClient(fn)`.
 * Uses the `mongodb` driver of @payloadcms/db-mongodb (no extra dependency).
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const requireFromDbMongodb = createRequire(path.join(root, 'packages/db-mongodb/package.json'))
const { MongoClient } = requireFromDbMongodb('mongodb')

export const MONGO_SERVER =
  process.env.PAYLOAD_RS_MONGO_SERVER || 'mongodb://payload:payload@localhost:27018'
export const MONGO_QUERY = 'authSource=admin&directConnection=true&replicaSet=rs0'

/** Connection string in the shape of upstream's default `MONGODB_URL`, for one database. */
export const mongoUrlFor = (dbName) => `${MONGO_SERVER}/${dbName}?${MONGO_QUERY}`

const PROTECTED = new Set(['admin', 'config', 'local'])

export const withMongoClient = async (fn) => {
  const client = new MongoClient(`${MONGO_SERVER}/?${MONGO_QUERY}`, {
    serverSelectionTimeoutMS: 10_000,
  })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.close()
  }
}

export const listDatabases = () =>
  withMongoClient(async (client) => {
    const { databases } = await client.db('admin').admin().listDatabases()
    return databases.map(({ name, sizeOnDisk }) => ({ name, sizeOnDisk }))
  })

/** Drops the given databases (never admin/config/local). Returns the dropped names. */
export const dropDatabases = (names) =>
  withMongoClient(async (client) => {
    const dropped = []
    for (const name of names) {
      if (!PROTECTED.has(name)) {
        await client.db(name).dropDatabase()
        dropped.push(name)
      }
    }
    return dropped
  })

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const [command, ...patterns] = process.argv.slice(2)
  if (command === 'list') {
    for (const { name, sizeOnDisk } of await listDatabases()) {
      process.stdout.write(`${name}\t${sizeOnDisk}\n`)
    }
  } else if (command === 'drop' && patterns.length) {
    const all = (await listDatabases()).map(({ name }) => name)
    const matchers = patterns.map((pattern) =>
      pattern.startsWith('/') && pattern.endsWith('/')
        ? (name) => new RegExp(pattern.slice(1, -1)).test(name)
        : (name) => name === pattern,
    )
    const dropped = await dropDatabases(all.filter((name) => matchers.some((m) => m(name))))
    process.stdout.write(`dropped ${dropped.length}: ${dropped.join(', ')}\n`)
  } else {
    process.stderr.write('usage: mongoDatabases.mjs list | drop <name|/regex/> ...\n')
    process.exitCode = 2
  }
}
