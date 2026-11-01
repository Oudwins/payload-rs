/**
 * Stand-in for packages/payload/src/auth/operations/registerFirstUser.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `registerFirstUserOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/auth/operations/registerFirstUser.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/auth/operations/registerFirstUser.js'

export const registerFirstUserOperation = wrapOperation(
  'auth.registerFirstUser',
  () => real.registerFirstUserOperation,
  () => real.registerFirstUserOperationTS,
)
