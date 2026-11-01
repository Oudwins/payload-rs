/**
 * Stand-in for packages/payload/src/auth/operations/logout.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `logoutOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/auth/operations/logout.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/auth/operations/logout.js'

export const logoutOperation = wrapOperation(
  'auth.logout',
  () => real.logoutOperation,
  () => real.logoutOperationTS,
)
