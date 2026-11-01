import { buildSortParam as original } from '../../../../packages/db-mongodb/src/queries/buildSortParam.js'
import { encode, fieldNames, leafSync } from '../recorder.js'

export type { SortArgs, SortDirection } from '../../../../packages/db-mongodb/src/queries/buildSortParam.js'

export const buildSortParam: typeof original = (args) => {
  const before = args.sortAggregation?.length ?? 0
  return leafSync(
    'buildSortParam',
    () => ({
      fields: fieldNames(args.fields),
      hasSortAggregation: args.sortAggregation !== undefined,
      locale: encode(args.locale),
      parentIsLocalized: encode(args.parentIsLocalized),
      sort: encode(args.sort),
      timestamps: encode(args.timestamps),
      versions: encode(args.versions),
    }),
    () => original(args),
    (result) => ({ sort: encode(result), sortAggregation: encode(args.sortAggregation?.slice(before) ?? []) }),
  )
}
