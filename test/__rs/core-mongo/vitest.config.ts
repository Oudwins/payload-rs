/**
 * Int-test config for upstream suites on MongoDB without touching the shared, generated
 * test/databaseAdapter.js: test/__rs/harness/vitest.config.ts with `databaseAdapter.js`
 * resolved to ./databaseAdapter.ts (the upstream `mongodb` adapter entry).
 *
 *   PAYLOAD_DATABASE=mongodb PAYLOAD_CORE_ENGINE=rs \
 *   MONGODB_URL='mongodb://payload:payload@localhost:27018/<unique>?authSource=admin&directConnection=true&replicaSet=rs0' \
 *     pnpm vitest run --config test/__rs/core-mongo/vitest.config.ts --project int test/hooks/int.spec.ts
 */
import harness from '../harness/vitest.config.js'
import { withMongo } from './withMongo.js'

export default withMongo(harness)
