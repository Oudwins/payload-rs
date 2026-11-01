// Recording wrapper (test/__rs/mongo-query/capture.ts) of db-mongodb's queries/buildSortParam.ts.
import { buildSortParam as original } from '../../../../packages/db-mongodb/src/queries/buildSortParam.js'
import { captureSync } from '../capture.js'

export type { SortArgs, SortDirection } from '../../../../packages/db-mongodb/src/queries/buildSortParam.js'

export const buildSortParam: typeof original = (args) => captureSync('sort', args, original)
