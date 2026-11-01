import { buildJoinAggregation as original } from '../../../../packages/db-mongodb/src/utilities/buildJoinAggregation.js'
import { encode, recordAdapter, unit } from '../recorder.js'

export const buildJoinAggregation: typeof original = (args) =>
  unit(
    'buildJoinAggregation',
    args.adapter,
    () =>
      encode({
        collection: args.collection,
        draftsEnabled: args.draftsEnabled,
        joins: args.joins,
        locale: args.locale,
        projection: args.projection,
        versions: args.versions,
      }),
    () => original({ ...args, adapter: recordAdapter(args.adapter) as typeof args.adapter }),
  )
