/** test/__rs/core-ops-global/vitest.config.ts on MongoDB (RS_CORE_DB=mongodb in core-ops-global/run.sh). */
import config from '../core-ops-global/vitest.config.js'
import { withMongo } from './withMongo.js'

export default withMongo(config)
