/**
 * Stand-in for packages/payload/src/globals/operations/findOne.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `findOneOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/globals/operations/findOne.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/globals/operations/findOne.js'

export const findOneOperation = wrapOperation(
  'global.findOne',
  () => real.findOneOperation,
  () => real.findOneOperationTS,
)
