import { buildQuery as original } from '../../../../packages/db-mongodb/src/queries/buildQuery.js'
import { spyCall } from '../tracer.js'

export const buildQuery: typeof original = (...args) => spyCall('buildQuery', original, args)
