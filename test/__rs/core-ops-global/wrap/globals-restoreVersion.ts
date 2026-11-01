/**
 * Stand-in for packages/payload/src/globals/operations/restoreVersion.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `restoreVersionOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/globals/operations/restoreVersion.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/globals/operations/restoreVersion.js'

export const restoreVersionOperation = wrapOperation(
  'global.restoreVersion',
  () => real.restoreVersionOperation,
  () => real.restoreVersionOperationTS,
)
