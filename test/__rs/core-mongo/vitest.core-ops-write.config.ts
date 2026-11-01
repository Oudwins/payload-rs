/** test/__rs/core-ops-write/vitest.config.ts on MongoDB (RS_CORE_DB=mongodb in core-ops-write/run.sh). */
import config from '../core-ops-write/vitest.config.js'
import { withMongo } from './withMongo.js'

export default withMongo(config)
