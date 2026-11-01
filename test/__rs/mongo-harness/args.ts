import type { mongooseAdapter } from '@payloadcms/db-mongodb'

import { compatibilityOptions } from '@payloadcms/db-mongodb'

type MongooseArgs = Parameters<typeof mongooseAdapter>[0]

/** PAYLOAD_DATABASE values served by this harness (the MONGO entries of test/dbAdapters.ts). */
export const SUPPORTED_DATABASES = ['mongodb', 'cosmosdb', 'documentdb', 'firestore'] as const

/**
 * Exactly the `mongooseAdapter` arguments upstream codegen writes for PAYLOAD_DATABASE (the
 * `mongodb`, `cosmosdb`, `documentdb` and `firestore` entries of test/dbAdapters.ts), including
 * the URL precedence. `mongodb-atlas` needs another server and is not supported.
 */
export const mongodbArgs = (database = process.env.PAYLOAD_DATABASE): MongooseArgs => {
  const url =
    process.env.MONGODB_URL ||
    process.env.DATABASE_URL ||
    'mongodb://payload:payload@localhost:27018/payload?authSource=admin&directConnection=true&replicaSet=rs0'
  switch (database) {
    case 'cosmosdb':
      return { ...compatibilityOptions.cosmosdb, ensureIndexes: true, url }
    case 'documentdb':
      return { ...compatibilityOptions.documentdb, ensureIndexes: true, url }
    case 'firestore':
      // upstream: `ensureIndexes: true` appears twice in the literal; the value is the same
      return {
        ...compatibilityOptions.firestore,
        ensureIndexes: true,
        url,
        disableIndexHints: false,
        useAlternativeDropDatabase: false,
      }
    default:
      return { ensureIndexes: true, url }
  }
}
