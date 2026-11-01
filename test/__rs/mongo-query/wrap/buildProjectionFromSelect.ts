// Recording wrapper (test/__rs/mongo-query/capture.ts) of db-mongodb's
// utilities/buildProjectionFromSelect.ts.
import { buildProjectionFromSelect as original } from '../../../../packages/db-mongodb/src/utilities/buildProjectionFromSelect.js'
import { captureSync } from '../capture.js'

export const buildProjectionFromSelect: typeof original = (args) =>
  captureSync('projection', args, original)
