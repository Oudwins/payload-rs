/**
 * Shadow candidate (test/__rs/mongo-harness/shadowDatabaseAdapter.ts, PAYLOAD_RS_MONGO_CANDIDATE=<this
 * file>): `withRustMongoEngine(mongooseAdapter(args))`, imported by path until engine-rs exports it.
 * With PAYLOAD_RS_MONGO_LOOPBACK=true the candidate runs the TS loopback engine (glue only).
 *
 *   PAYLOAD_RS_MONGO_LOOPBACK=true node test/__rs/mongo-harness/runSuites.mjs --shadow \
 *     --candidate test/__rs/mongo-adapter/candidate.ts test/hooks/int.spec.ts
 */
import { mongooseAdapter as upstreamMongooseAdapter } from '@payloadcms/db-mongodb'

import { withRustMongoEngine } from '../../../packages/engine-rs/src/mongo-adapter/index.js'

export const mongooseAdapter = (args: Parameters<typeof upstreamMongooseAdapter>[0]) =>
  withRustMongoEngine(upstreamMongooseAdapter(args))
