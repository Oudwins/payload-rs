/**
 * Stand-in for packages/payload/src/auth/operations/login.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `loginOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/auth/operations/login.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/auth/operations/login.js'

export const loginOperation = wrapOperation(
  'auth.login',
  () => real.loginOperation,
  () => real.loginOperationTS,
)
