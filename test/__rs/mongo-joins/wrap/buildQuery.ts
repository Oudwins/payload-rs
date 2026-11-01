import { buildQuery as original } from '../../../../packages/db-mongodb/src/queries/buildQuery.js'
import { encode, fieldNames, leaf } from '../recorder.js'

export const buildQuery: typeof original = (args) =>
  leaf(
    'buildQuery',
    () => ({
      collectionSlug: encode(args.collectionSlug),
      fields: fieldNames(args.fields),
      globalSlug: encode(args.globalSlug),
      locale: encode(args.locale),
      where: encode(args.where),
    }),
    () => original(args),
  )
