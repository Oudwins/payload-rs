/**
 * Stand-in for packages/payload/src/auth/operations/refresh.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `refreshOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/auth/operations/refresh.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/auth/operations/refresh.js'

export const refreshOperation = wrapOperation(
  'auth.refresh',
  () => real.refreshOperation,
  () => real.refreshOperationTS,
)
