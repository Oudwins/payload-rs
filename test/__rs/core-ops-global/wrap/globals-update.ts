/**
 * Stand-in for packages/payload/src/globals/operations/update.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `updateOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/globals/operations/update.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/globals/operations/update.js'

export const updateOperation = wrapOperation(
  'global.update',
  () => real.updateOperation,
  () => real.updateOperationTS,
)
