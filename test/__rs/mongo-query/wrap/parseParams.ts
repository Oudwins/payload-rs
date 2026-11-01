// Recording wrapper (test/__rs/mongo-query/capture.ts) of db-mongodb's queries/parseParams.ts.
import { parseParams as original } from '../../../../packages/db-mongodb/src/queries/parseParams.js'
import { captureParseParams } from '../capture.js'

export const parseParams: typeof original = (args) => captureParseParams(args, original)
