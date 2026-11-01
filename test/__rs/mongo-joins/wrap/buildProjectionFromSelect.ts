import { buildProjectionFromSelect as original } from '../../../../packages/db-mongodb/src/utilities/buildProjectionFromSelect.js'
import { encode, fieldNames, leafSync } from '../recorder.js'

export const buildProjectionFromSelect: typeof original = (args) =>
  leafSync(
    'buildProjectionFromSelect',
    () => ({ fields: fieldNames(args.fields), select: encode(args.select) }),
    () => original(args),
  )
