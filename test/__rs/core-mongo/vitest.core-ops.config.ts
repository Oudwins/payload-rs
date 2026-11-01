/** test/__rs/core-ops/vitest.config.ts on MongoDB (RS_CORE_DB=mongodb in core-ops/run.sh). */
import config from '../core-ops/vitest.config.js'
import { withMongo } from './withMongo.js'

export default withMongo(config)
