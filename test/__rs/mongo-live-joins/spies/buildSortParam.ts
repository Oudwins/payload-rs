import { buildSortParam as original } from '../../../../packages/db-mongodb/src/queries/buildSortParam.js'
import { spyCall } from '../tracer.js'

export const buildSortParam: typeof original = (...args) => spyCall('buildSortParam', original, args)
