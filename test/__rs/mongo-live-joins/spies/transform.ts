import { transform as original } from '../../../../packages/db-mongodb/src/utilities/transform.js'
import { spyCall } from '../tracer.js'

export const transform: typeof original = (...args) => spyCall('transform', original, args)
