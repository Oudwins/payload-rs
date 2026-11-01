/**
 * Stand-in for packages/payload/src/globals/operations/validate.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `validateOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/globals/operations/validate.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/globals/operations/validate.js'

export const validateOperation = wrapOperation(
  'global.validate',
  () => real.validateOperation,
  () => real.validateOperationTS,
)
