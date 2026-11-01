/**
 * Stand-in for packages/payload/src/auth/operations/access.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `accessOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/auth/operations/access.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/auth/operations/access.js'

export const accessOperation = wrapOperation(
  'auth.access',
  () => real.accessOperation,
  () => real.accessOperationTS,
)
