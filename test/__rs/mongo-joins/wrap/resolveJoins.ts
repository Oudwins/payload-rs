import { resolveJoins as original } from '../../../../packages/db-mongodb/src/utilities/resolveJoins.js'
import { encode, recordAdapter, unit } from '../recorder.js'

export type { ResolveJoinsArgs } from '../../../../packages/db-mongodb/src/utilities/resolveJoins.js'

export const resolveJoins: typeof original = (args) =>
  unit(
    'resolveJoins',
    args.adapter,
    () =>
      encode({
        collectionSlug: args.collectionSlug,
        docs: args.docs,
        joins: args.joins,
        locale: args.locale,
        projection: args.projection,
        versions: args.versions,
      }),
    () => original({ ...args, adapter: recordAdapter(args.adapter) as typeof args.adapter }),
    () => encode(args.docs),
  )
