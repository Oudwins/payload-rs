#!/usr/bin/env node
/**
 * MongoDB test database helper for the core harness scripts (RS_CORE_DB=mongodb):
 *
 *   node test/__rs/core-mongo/db.mjs url <name>    prints the MONGODB_URL of database <name>
 *   node test/__rs/core-mongo/db.mjs drop <name>   drops database <name>
 *
 * Server: replica set rs0 on localhost:27018, user payload/payload (packages/engine-rs/MONGO_ENGINE_CONTRACT.md).
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

export const mongoURL = (name) =>
  `mongodb://payload:payload@localhost:27018/${name}?authSource=admin&directConnection=true&replicaSet=rs0`

export const dropDatabase = async (name) => {
  const mongoose = createRequire(path.join(root, 'packages/db-mongodb/package.json'))('mongoose')
  const connection = await mongoose.createConnection(mongoURL(name)).asPromise()
  try {
    await connection.dropDatabase()
  } finally {
    await connection.close()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, name] = process.argv.slice(2)
  if (!name || !/^[\w-]+$/.test(name)) {
    throw new Error(`invalid database name ${name}`)
  }
  if (command === 'url') {
    process.stdout.write(mongoURL(name))
  } else if (command === 'drop') {
    await dropDatabase(name)
  } else {
    throw new Error(`unknown command ${command}`)
  }
}
