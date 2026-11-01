import { aggregatePaginate as original } from '../../../../packages/db-mongodb/src/utilities/aggregatePaginate.js'
import { encode, modelRefOf, recordModel, unit } from '../recorder.js'

export const aggregatePaginate: typeof original = (args) => {
  const model = modelRefOf(args.adapter, args.Model)
  return unit(
    'aggregatePaginate',
    args.adapter,
    () => ({
      ...(encode({
        collation: args.collation,
        joinAggregation: args.joinAggregation,
        limit: args.limit,
        page: args.page,
        pagination: args.pagination,
        projection: args.projection,
        query: args.query,
        session: args.session,
        sort: args.sort,
        sortAggregation: args.sortAggregation,
        useEstimatedCount: args.useEstimatedCount,
      }) as object),
      model,
    }),
    () => original({ ...args, Model: recordModel(args.Model, model) as typeof args.Model }),
  )
}
