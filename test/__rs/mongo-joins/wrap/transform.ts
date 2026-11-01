import { transform as original } from '../../../../packages/db-mongodb/src/utilities/transform.js'
import { encode, fieldNames, leafSync } from '../recorder.js'

export const transform: typeof original = (args) =>
  leafSync(
    'transform',
    () => ({
      data: encode(args.data),
      fields: fieldNames(args.fields),
      globalSlug: encode(args.globalSlug),
      operation: args.operation,
      parentIsLocalized: encode(args.parentIsLocalized),
    }),
    () => original(args),
    (result) => ({ data: encode(args.data), returned: encode(result) }),
  )
