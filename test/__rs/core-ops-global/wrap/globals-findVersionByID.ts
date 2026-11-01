/**
 * Stand-in for packages/payload/src/globals/operations/findVersionByID.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `findVersionByIDOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/globals/operations/findVersionByID.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/globals/operations/findVersionByID.js'

export const findVersionByIDOperation = wrapOperation(
  'global.findVersionByID',
  () => real.findVersionByIDOperation,
  () => real.findVersionByIDOperationTS,
)
